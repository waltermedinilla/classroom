// Optimizador de imágenes subidas por los usuarios (avatares, portadas, novedades).
//
// Toma el buffer que llega del navegador, lo redimensiona al techo que la vista realmente
// necesita y lo reencodea a WebP. Reducción medida: ~90-95% (una foto de celular de 3 MB
// queda en 30-40 KB como avatar).
//
// ── Por qué sharp y no otra cosa ──────────────────────────────────────────────
// sharp (libvips) procesa fuera del event loop, en su propio threadpool: comprimir una
// foto de 5 MB tarda ~100-300 ms y NO bloquea al resto de los usuarios. Ya estaba en el
// proyecto para generar el favicon.
//
// ── Degradación si falta el binario nativo ────────────────────────────────────
// El webhook de deploy (POST /deploy en server.js) hace `git pull` + `pm2 reload`, NO
// `npm install`. Si sharp se movió a dependencies pero nadie instaló en el server, un
// `require` en el tope del módulo tiraría la app ENTERA al arrancar. Por eso el require
// va acá adentro, protegido: sin sharp, `optimizar()` avisa y el llamador decide (las
// rutas guardan el original sin tocar). Se pierde la optimización, no el servicio.
const path   = require('path');
const logger = require('../config/logger');
const { PRESETS, EXT_DEPENDEN_DE_CODEC } = require('../config/imagePresets');

let sharp = null;
let sharpError = null;
try {
  sharp = require('sharp');
} catch (err) {
  sharpError = err;
  logger.error('sharp no está disponible: las imágenes se guardarán SIN optimizar', {
    detalle: err.message,
    accion:  'correr `npm install` en el servidor',
  });
}

function sharpDisponible() {
  return sharp !== null;
}

// ¿Este libvips sabe LEER el HEIC de un iPhone?
//
// ⚠️ LA PREGUNTA NO ES SI EXISTE EL LOADER HEIF, y confundirlas costó una investigación
// entera. `sharp.format.heif.input.buffer` da `true` en los binarios precompilados igual, y
// no porque sepan leer HEIC: el loader heif está compilado para **AVIF** (libheif con AV1).
// El HEIC del iPhone es **HEVC**, que tiene patentes y no viene en el prebuilt.
//
// Lo que sí lo dice es la lista de sufijos que libvips ANUNCIA para el loader: la arma según
// los decodificadores que encontró. Medido el 2026-08-24 en las dos máquinas —el Windows de
// desarrollo y el Ubuntu de producción, las dos con libvips 8.17.3:
//
//     input: { file: true, buffer: true, stream: true, fileSuffix: [ '.avif' ] }
//                                                                    ↑ solo AVIF
//
// Si el HEVC estuviera, ahí figurarían también '.heic' y '.heif'.
//
// La versión vieja de esta función miraba `input.buffer` y por lo tanto contestaba que SÍ en
// un servidor que no puede leer un solo HEIC. Eso no es un detalle: es lo que decide la
// severidad del log de abajo, así que cada foto de iPhone rechazada dejaba un WARN diciendo
// "el loader está disponible, el problema es el archivo" — culpando a la foto de la docente y
// mandando a quien investigara a la capa equivocada. Un instrumento que miente es peor que no
// tener instrumento.
function heifSoportado() {
  const sufijos = sharp?.format?.heif?.input?.fileSuffix;
  if (!Array.isArray(sufijos)) return false;
  return sufijos.includes('.heic') || sufijos.includes('.heif');
}

// El cartel que ve quien sube un HEIC que no podemos leer. Vive acá, en una constante, para
// que el rechazo rápido del middleware y el fallo al decodificar digan LO MISMO: son el mismo
// problema visto en dos momentos distintos, y dos redacciones distintas harían pensar que son
// dos fallas.
// Dos consejos y en este orden, porque resuelven cosas distintas: el primero arregla LA FOTO
// QUE YA SACARON (al elegirla desde Fotos, iOS la convierte a JPG en el camino; desde Archivos
// la manda tal cual), y el segundo evita que vuelva a pasar. Decirle solo lo segundo a alguien
// que tiene la foto sacada y la tarea por entregar no le sirve de nada hoy.
const MENSAJE_HEIC_SIN_CODEC =
  'No pudimos leer esta foto de iPhone. Elegila desde Fotos (no desde Archivos) y el ' +
  'teléfono la manda como JPG. Para que salgan siempre así: Ajustes → Cámara → Formatos → ' +
  '"Más compatible".';

// Aviso ÚNICO al arrancar el worker, y a propósito no uno por request: que falte el códec es
// un hecho de la INSTALACIÓN, no de cada foto. Loguearlo en cada intento llenaría el log de
// alarmas repetidas por algo que no cambia hasta que alguien toque el servidor — y un log que
// grita siempre deja de leerse.
if (sharpDisponible() && !heifSoportado()) {
  logger.warn('libvips vino sin el códec HEVC: no se pueden leer los HEIC del iPhone', {
    detalle: 'el loader heif está compilado solo para AVIF',
    sufijos: sharp?.format?.heif?.input?.fileSuffix,
    efecto:  'las fotos .heic se rechazan al instante con el cartel que explica cómo pasarlas a JPG',
  });
}

// `failOn` decide con qué nivel de problema sharp aborta la decodificación. El default es
// 'warning' — DEMASIADO estricto para fotos del mundo real: un avatar bajado de Google que
// cualquier navegador muestra perfecto hacía saltar "premature end of JPEG image" y
// terminaba rechazado como si estuviera dañado (y de forma intermitente, según la carga,
// que fue lo peor de diagnosticar).
//
// Con 'error' toleramos los warnings de libjpeg, igual que un navegador, pero seguimos
// fallando ante una decodificación realmente rota. Y lo importante para la seguridad no
// cambia: un archivo que NO es una imagen revienta antes, en metadata(), con cualquier
// valor de failOn.
//
// El modo `tolerante` ('none') decodifica lo que se pueda y no falla nunca. NO va en las
// subidas: si a alguien se le corta la conexión a mitad de una foto, es mejor decírselo
// que guardarle media imagen en silencio. Existe para el backfill
// (optimize-existing-images.js), donde el archivo dañado YA está publicado y mostrándose
// parcial: ahí rechazarlo no arregla nada y convertirlo salva el espacio igual. En el
// mirror local esto es exactamente 1 archivo de 78, un JPEG de 1,7 MB sin marcador de fin.
const OPCIONES_ESTRICTO  = { failOn: 'error' };
const OPCIONES_TOLERANTE = { failOn: 'none' };

// Error con `status` para que las rutas puedan devolver el código correcto sin inventar
// el mapeo cada vez. `status: 400` = culpa del archivo que mandaron; 500 = culpa nuestra.
class ImagenInvalidaError extends Error {
  constructor(mensaje, causa) {
    super(mensaje);
    this.name   = 'ImagenInvalidaError';
    this.status = 400;
    this.causa  = causa;
  }
}

// Resultado de optimizar: { buffer, ext, bytes, width, height, optimizada }
//
// `optimizada: false` significa "te devuelvo el original a propósito" — pasa con GIFs
// animados y con imágenes que ya pesaban menos que el WebP resultante. En ese caso `ext`
// es la extensión original y hay que respetarla al escribir el archivo.
async function optimizar(buffer, presetName, originalname = '', { tolerante = false } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Preset de imagen desconocido: ${presetName}`);

  const opciones    = tolerante ? OPCIONES_TOLERANTE : OPCIONES_ESTRICTO;
  const extOriginal = path.extname(originalname).toLowerCase() || '.bin';

  // Sin sharp no hay nada que hacer: se devuelve el original tal cual. No es un error del
  // usuario, así que no tiramos ImagenInvalidaError — el log ya salió al cargar el módulo.
  if (!sharpDisponible()) {
    return { buffer, ext: extOriginal, bytes: buffer.length, width: null, height: null, optimizada: false };
  }

  let metadata;
  try {
    metadata = await sharp(buffer, opciones).metadata();
  } catch (err) {
    // HEIC/HEIF dependen de que libvips traiga el códec HEVC, y eso varía según el binario
    // precompilado de sharp de cada plataforma. El usuario no tiene forma de adivinar por
    // qué le rechazamos una foto que su teléfono muestra perfecto, así que el mensaje le
    // dice qué hacer — sirve igual si el códec falta o si la foto vino cortada.
    //
    // La SEVERIDAD del log sí distingue los dos casos, y la distinción importa: si loguearas
    // "falta el códec" ante cualquier .heic roto, error.log se llenaría de alarmas falsas y
    // dejaría de servir para lo único que tiene que servir (ver [[logging]] en agente.md).
    //   - loader ausente  → ERROR: problema de INSTALACIÓN, hay que ir al servidor.
    //   - loader presente → WARN:  el archivo es el problema, el servidor está bien.
    if (EXT_DEPENDEN_DE_CODEC.includes(extOriginal)) {
      const datos = { detalle: err.message, archivo: extOriginal, preset: presetName };
      if (!heifSoportado()) {
        logger.error('El servidor no puede decodificar HEIC/HEIF: libvips vino sin el loader', {
          ...datos,
          accion: 'en el servidor: node -e "console.log(require(\'sharp\').format.heif)"',
        });
      } else {
        logger.warn('No se pudo decodificar un HEIC/HEIF (el loader está disponible)', datos);
      }
      throw new ImagenInvalidaError(MENSAJE_HEIC_SIN_CODEC, err.message);
    }
    // sharp no pudo ni leer la cabecera: esto NO es una imagen, por más que la extensión
    // y el Content-Type digan lo contrario. Antes de esto, el fileFilter de multer miraba
    // solo la extensión, así que un archivo arbitrario renombrado a .jpg terminaba guardado
    // dentro de /public. Decodificarlo es la validación real.
    throw new ImagenInvalidaError('El archivo no es una imagen válida', err.message);
  }

  // GIF animado: `pages` > 1. Convertirlo a WebP animado es caro y con frecuencia da un
  // archivo MÁS grande que el original. Pasa intacto — son pocos y chicos.
  if (metadata.pages && metadata.pages > 1) {
    return {
      buffer,
      ext:        extOriginal,
      bytes:      buffer.length,
      width:      metadata.width  || null,
      height:     metadata.height || null,
      optimizada: false,
      motivo:     'gif-animado',
    };
  }

  // Dimensiones REALES de origen, ya considerando la rotación del EXIF: los valores 5-8
  // de `orientation` implican que al enderezar la foto se intercambian ancho y alto.
  const orientacion = metadata.orientation || 1;
  const seRota = orientacion >= 5;
  const anchoOrigen = seRota ? metadata.height : metadata.width;
  const altoOrigen  = seRota ? metadata.width  : metadata.height;

  // `fit: 'cover'` (avatar) y `withoutEnlargement: true` NO se llevan bien: con una entrada
  // de 1600×400, sharp respeta el "no agrandar" recortando a 512×400 y el avatar sale
  // RECTANGULAR — después el CSS circular lo aplasta. Para 'cover' se calcula a mano el
  // lado más grande que la imagen puede dar sin estirarse, y así queda cuadrado siempre.
  const resize = preset.fit === 'cover'
    ? {
        width:  Math.min(preset.width, anchoOrigen, altoOrigen),
        height: Math.min(preset.width, anchoOrigen, altoOrigen),
        fit:    'cover',
      }
    : {
        width:  preset.width,
        height: preset.height,
        fit:    preset.fit,
        // Nunca agrandar: un avatar de 100×100 estirado a 512 se vería borroso y pesaría más.
        withoutEnlargement: true,
      };

  let optimizado;
  try {
    optimizado = await sharp(buffer, opciones)
      // .rotate() SIN argumentos aplica la orientación del EXIF y la descarta. Va PRIMERO,
      // antes del resize, porque el resize razona sobre el alto/ancho ya rotados.
      //
      // Es obligatorio: al reencodear, sharp tira el EXIF (bien: ahí viaja el GPS de las
      // fotos de celular de los alumnos). Pero si no rotamos antes, también se pierde el
      // flag de orientación que hoy usa el navegador para enderezar la foto — y una foto
      // vertical de celular quedaría acostada para siempre.
      .rotate()
      .resize(resize)
      .webp({ quality: preset.quality })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    // Leyó la cabecera pero falló al decodificar el cuerpo: imagen truncada o corrupta.
    throw new ImagenInvalidaError('No se pudo procesar la imagen (puede estar dañada)', err.message);
  }

  // Si el "optimizado" pesa más que el original, el original gana. Pasa con imágenes ya
  // comprimidas al máximo (un logo WebP de 3 KB, un PNG de pocos colores): reencodear
  // solo agrega peso.
  if (optimizado.data.length >= buffer.length) {
    return {
      buffer,
      ext:        extOriginal,
      bytes:      buffer.length,
      width:      metadata.width  || null,
      height:     metadata.height || null,
      optimizada: false,
      motivo:     'ya-optimizada',
    };
  }

  return {
    buffer:     optimizado.data,
    ext:        '.webp',
    bytes:      optimizado.data.length,
    width:      optimizado.info.width,
    height:     optimizado.info.height,
    optimizada: true,
  };
}

module.exports = {
  optimizar, sharpDisponible, sharpError, heifSoportado,
  MENSAJE_HEIC_SIN_CODEC, ImagenInvalidaError,
};
