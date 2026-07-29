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
const { optimizar, ImagenInvalidaError } = require('../services/imageOptimizer');
const { EXT_IMAGENES, MAX_INPUT_BYTES } = require('../config/imagePresets');

// Multer compartido por todas las subidas de imagen. El fileFilter es un primer filtro
// barato por extensión; la validación real (¿esto es una imagen?) la hace sharp al
// decodificar en services/imageOptimizer.js.
const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_INPUT_BYTES },
  fileFilter: (req, file, cb) => {
    cb(null, EXT_IMAGENES.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Envuelve `uploadImagen.single(campo)` para devolver JSON en español en vez del mensaje
// en inglés de multer. Mismo patrón que routes/activities.js.
function subirImagen(campo) {
  return (req, res, next) => {
    uploadImagen.single(campo)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(MAX_INPUT_BYTES / (1024 * 1024));
        return res.status(413).json({ error: `La imagen es demasiado grande (máximo ${mb} MB)` });
      }
      return res.status(400).json({ error: err.message || 'Error al procesar la imagen' });
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
  guardarImagenOptimizada,
  borrarVersionesPrevias,
  borrarPorUrlPublica,
  ImagenInvalidaError,
};
