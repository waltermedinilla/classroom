// Subida de imágenes de usuario: multer en memoria + optimización antes de tocar el disco.
//
// ── Por qué memoryStorage y no diskStorage ────────────────────────────────────
// 1. El original NUNCA toca el disco. Si guardáramos primero y optimizáramos después,
//    cada avatar escribiría 3 MB para después borrarlos — I/O y desgaste al pedo.
// 2. Elimina el callback `filename()` que borraba el archivo anterior. Ese callback fue
//    la causa del bug de seguridad documentado en agente.md: multer corre ANTES del
//    handler, así que borraba la portada de un curso ajeno antes de que el handler
//    pudiera responder 403. Con memoryStorage el borrado pasa al handler, DESPUÉS de
//    validar permisos, y la mitigación deja de depender del orden de los middlewares.
// 3. El costo es RAM: hasta MAX_INPUT_BYTES por request en vuelo. Con el uploadLimiter
//    que ya existe y el volumen de la escuela, es despreciable. Nótese que esto NO sirve
//    para adjuntos/entregas (PDFs de hasta 50 MB) — esos siguen en diskStorage.
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const fsp    = require('fs/promises');
const crypto = require('crypto');
const logger = require('../config/logger');
const { logRechazo } = require('./route-log');
const {
  optimizar, heifSoportado, MENSAJE_HEIC_SIN_CODEC, ImagenInvalidaError,
} = require('../services/imageOptimizer');
const { EXT_IMAGENES, EXT_DEPENDEN_DE_CODEC, MAX_INPUT_BYTES } = require('../config/imagePresets');

// Extensión que no aceptamos. Es una clase y no un string suelto para que el mensaje —el
// que ve el usuario— se arme en un solo lugar y siempre nombre la lista completa.
class ExtensionNoPermitidaError extends Error {
  constructor(ext) {
    super(`Esa imagen no se puede subir${ext ? ` (${ext})` : ''}. Aceptamos: ${EXT_IMAGENES.join(', ')}`);
    this.name = 'ExtensionNoPermitidaError';
    this.ext  = ext;
  }
}

// Multer compartido por todas las subidas de imagen. El fileFilter es un primer filtro
// barato por extensión; la validación real (¿esto es una imagen?) la hace sharp al
// decodificar en services/imageOptimizer.js.
//
// ⚠️ QUÉ PASA CUANDO LA EXTENSIÓN NO SIRVE. El rechazo se ANOTA en el request y lo contesta
// subirImagen() cuando multer terminó. Las otras dos formas de escribir esto están las dos
// mal, y cada una se pagó una vez:
//
//   1. `cb(null, false)` a secas —lo que había hasta el 2026-08-24— descarta el archivo y
//      sigue como si nada. El handler recibe `req.file` undefined, indistinguible de "no
//      adjuntó nada", y las rutas donde la imagen es OPCIONAL (la novedad, la portada) hacen
//      `if (req.file)` y siguen de largo: publicaban SIN la foto y contestaban 201/200.
//      Medido: subir una novedad con `prueba.jfif` devolvía 201 con `image: null`. Sin
//      cartel, sin línea en el log y sin código SUB-XXXXXX (el diagnóstico solo se dispara
//      cuando falla la red, no cuando el servidor contesta que sí). Un fallo que no se podía
//      encontrar — que es exactamente como lo reportaban los docentes.
//
//   2. `cb(err)` aborta el parseo, y el servidor contesta el 400 mientras el navegador
//      TODAVÍA está subiendo. La conexión queda a medio camino y el pedido siguiente de ese
//      mismo socket muere con "fetch failed": se vio en el smoke del 2026-08-24, fallando
//      dos specs sin relación entre sí, los dos justo después de uno que rechazaba una
//      imagen.
//
// La marca + `cb(null, false)` se queda con lo bueno de las dos: multer termina de leer el
// cuerpo (la conexión queda sana, igual que antes) y la respuesta es un 400 con su cartel.
const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_INPUT_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (EXT_IMAGENES.includes(ext)) {
      // Rechazo RÁPIDO del HEIC cuando este libvips no trae el códec HEVC (medido el
      // 2026-08-24: no lo trae, ni acá ni en producción). Sin esto, la foto de 5 MB viaja
      // ENTERA por la red del aula para morir recién al decodificar — y en una conexión que
      // se corta sola cada tanto, esa espera es lo peor que se le puede pedir a alguien para
      // después decirle que no. El cartel es el mismo, llega en el primer segundo.
      //
      // La extensión sigue en EXT_IMAGENES y en los `accept` a propósito: si algún día el
      // servidor tiene el códec, esto se apaga solo. Y mientras tanto es mejor que la foto se
      // pueda elegir y reciba una explicación, a que no aparezca en el selector y la persona
      // crea que su archivo está roto.
      if (EXT_DEPENDEN_DE_CODEC.includes(ext) && !heifSoportado()) {
        req.imagenRechazada = new Error(MENSAJE_HEIC_SIN_CODEC);
        return cb(null, false);
      }
      return cb(null, true);
    }
    req.imagenRechazada = new ExtensionNoPermitidaError(ext);
    cb(null, false);
  },
});

// Envuelve `uploadImagen.single(campo)` para devolver JSON en español en vez del mensaje
// en inglés de multer. Mismo patrón que routes/activities.js.
//
// Todo rechazo queda además en el log con `logRechazo`, por lo mismo que lo hace la sala en
// vivo: sin eso, del lado del servidor no hay una sola línea que diga que a alguien le
// rebotó una foto, y "no me deja subir" se vuelve imposible de investigar.
function subirImagen(campo) {
  return (req, res, next) => {
    uploadImagen.single(campo)(req, res, (err) => {
      // El rechazo por extensión se contesta ACÁ y no en cada ruta, a propósito: si hubiera
      // que agregar un middleware a mano en cada una, la próxima ruta de imagen que alguien
      // escriba se lo va a olvidar — y el olvido es justamente el bug que esto arregla. Por
      // pasar por subirImagen(), ya está cubierta.
      if (!err && req.imagenRechazada) {
        const motivo = req.imagenRechazada.message;
        logRechazo(res, 400, motivo);
        return res.status(400).json({ error: motivo });
      }
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(MAX_INPUT_BYTES / (1024 * 1024));
        const msg = `La imagen es demasiado grande (máximo ${mb} MB)`;
        logRechazo(res, 413, msg);
        return res.status(413).json({ error: msg });
      }
      const msg = err.message || 'Error al procesar la imagen';
      logRechazo(res, 400, msg);
      return res.status(400).json({ error: msg });
    });
  };
}

// Sufijo único para el nombre del archivo. Es lo que rompe el cache del navegador.
//
// Antes el avatar se llamaba siempre `avatar.jpg`: al subir uno nuevo se pisaba el archivo
// pero la URL guardada en User.avatar no cambiaba, así que el navegador seguía mostrando
// el viejo. Con todo convertido a .webp el nombre sería SIEMPRE `avatar.webp` y el
// problema pasaría de intermitente a permanente. Un sufijo nuevo por subida = URL nueva
// = el navegador la pide de verdad.
function sufijoUnico() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// Borra las versiones anteriores de una imagen "de reemplazo" (avatar, portada).
//
// Alcance: solo archivos del directorio que empiezan con `${base}.` o `${base}-`. Los
// directorios son por usuario (avatars/{userId}) o por curso (headers/{courseId}), así
// que el prefijo no puede alcanzar la imagen de otra persona. `exceptuar` protege el
// archivo recién escrito.
//
// Los errores se tragan a propósito: si no se pudo borrar el viejo, queda un archivo
// huérfano (lo levanta cleanup-files.js), pero la subida nueva ya está OK y fallar acá
// sería peor.
async function borrarVersionesPrevias(dir, base, exceptuar) {
  try {
    const entradas = await fsp.readdir(dir);
    await Promise.all(entradas
      .filter(f => f !== exceptuar && (f.startsWith(base + '.') || f.startsWith(base + '-')))
      .map(f => fsp.unlink(path.join(dir, f)).catch(() => {})));
  } catch {
    // el directorio puede no existir todavía: no hay nada previo que borrar
  }
}

// Optimiza `file` (el req.file de multer, en memoria) y lo escribe en disco.
//
// Opciones:
//   preset    clave de config/imagePresets.js ('avatar' | 'header' | 'novedad')
//   dir       directorio absoluto de destino (se crea si no existe)
//   base      nombre base SIN extensión. Si viene, es una imagen de REEMPLAZO: se borran
//             las versiones anteriores. Si no viene, se genera un nombre único (novedades,
//             donde cada imagen es un archivo distinto que convive con los demás).
//
// Devuelve { filename, bytes, bytesOriginales, optimizada, width, height }.
// Lanza ImagenInvalidaError (status 400) si el archivo no es una imagen de verdad.
async function guardarImagenOptimizada(file, { preset, dir, base }) {
  const resultado = await optimizar(file.buffer, preset, file.originalname);

  await fsp.mkdir(dir, { recursive: true });

  const filename = base
    ? `${base}-${sufijoUnico()}${resultado.ext}`
    : `${sufijoUnico()}${resultado.ext}`;

  // Se escribe la nueva ANTES de borrar la vieja: si el write falla, el usuario conserva
  // la imagen que ya tenía en vez de quedarse sin nada.
  await fsp.writeFile(path.join(dir, filename), resultado.buffer);

  if (base) await borrarVersionesPrevias(dir, base, filename);

  if (resultado.optimizada) {
    logger.info('Imagen optimizada', {
      preset,
      original:  file.buffer.length,
      final:     resultado.bytes,
      ahorro:    `${Math.round((1 - resultado.bytes / file.buffer.length) * 100)}%`,
      dimension: `${resultado.width}x${resultado.height}`,
    });
  }

  return {
    filename,
    bytes:           resultado.bytes,
    bytesOriginales: file.buffer.length,
    optimizada:      resultado.optimizada,
    width:           resultado.width,
    height:          resultado.height,
  };
}

// Borra el archivo apuntado por una URL pública (`/archivos/...`), usada al quitar un
// avatar o una portada. Tolera que el archivo ya no exista.
function borrarPorUrlPublica(urlPublica) {
  if (!urlPublica) return;
  try {
    fs.unlinkSync(path.join(__dirname, '../public', urlPublica));
  } catch {}
}

module.exports = {
  subirImagen,
  ExtensionNoPermitidaError,
  guardarImagenOptimizada,
  borrarVersionesPrevias,
  borrarPorUrlPublica,
  ImagenInvalidaError,
};
