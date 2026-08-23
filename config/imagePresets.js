// Presets de optimización de imágenes subidas por los usuarios.
//
// El problema que resuelven: multer guardaba en disco el byte-por-byte que mandaba el
// navegador. Una foto de celular de 4000×3000 (3 MB) se guardaba entera para mostrarse
// en un círculo de 40 px. Medido antes de esto: 78 imágenes = 74,7 MB, con avatares de
// hasta 3,07 MB (ver el bloque "Optimización de imágenes" en agente.md).
//
// Cada preset define el techo real de lo que la vista necesita, no más. Los valores están
// pensados para pantallas retina (2× el tamaño CSS) — subir de acá no mejora nada visible
// y solo cuesta disco y ancho de banda.
//
// `fit`:
//   - 'cover'  recorta al centro para llenar exactamente width×height. Solo el avatar, que
//              siempre se pinta circular: recortar cuadrado desde el server evita que un
//              rectángulo apaisado se deforme en el CSS.
//   - 'inside' escala hasta entrar en la caja SIN recortar ni deformar. El resto: una
//              portada o una foto de novedad tiene que verse completa, no recortada.
//
// `quality` es la calidad WebP (0-100). 78-80 es indistinguible del original a simple
// vista en fotos; por debajo de 70 aparecen artefactos en degradados (cielos, fondos).
const PRESETS = {
  // Avatar de perfil (User.avatar). Se muestra a 40 px en el header y ~120 px en el perfil;
  // 512 cubre retina con margen y sirve si algún día se agranda.
  avatar: {
    width:   512,
    height:  512,
    fit:     'cover',
    quality: 78,
    label:   'avatar',
  },

  // Portada de materia (Course.header.image). Es un banner ancho y bajo; 1600 de ancho
  // cubre un monitor full HD en retina.
  header: {
    width:   1600,
    height:  600,
    fit:     'inside',
    quality: 80,
    label:   'portada',
  },

  // Imagen adjunta a una novedad (Announcement.image). Se ve dentro del stream del curso,
  // nunca a pantalla completa, pero puede ser una foto que el docente quiere que se lea.
  novedad: {
    width:   1600,
    height:  1600,
    fit:     'inside',
    quality: 80,
    label:   'imagen de novedad',
  },

  // Imagen compartida en el chat de la sala en vivo (models/RoomMessage.js, kind 'image').
  // En la card se ve a ~340 px de ancho, pero al tocarla se abre en grande: 1600 cubre eso
  // en una pantalla del aula sin obligar a guardar el original de 4000 px.
  //
  // La compresión acá importa MÁS que en los otros presets: una clase de 30 chicos mirando
  // la misma foto la descarga 30 veces, muchos desde datos móviles. Calidad 76 —dos puntos
  // por debajo del avatar— es indistinguible en una foto de pizarrón y ahorra ancho de banda
  // en el momento en que 30 dispositivos piden lo mismo a la vez.
  sala: {
    width:   1600,
    height:  1600,
    fit:     'inside',
    quality: 76,
    label:   'imagen de la sala',
  },

  // Imagen que el docente adjunta a una actividad (models/Activity.js, attachments[]).
  //
  // Es el único preset que se va por arriba de 1600, y el motivo es que acá la imagen no se
  // MIRA, se LEE: la foto de la consigna escrita en el pizarrón, el ejercicio del libro
  // fotografiado, el mapa con referencias chicas. El alumno le va a hacer zoom en el celular,
  // y con 1600 el texto manuscrito se empasta justo cuando lo necesita legible.
  //
  // Calidad 82 por lo mismo: dos puntos por encima de novedad. Los artefactos del WebP se
  // notan en los bordes de alto contraste —que es exactamente lo que es una letra— mucho
  // antes que en una foto. Aún así una foto de celular de 4 MB termina en unos cientos de KB.
  adjunto: {
    width:   2000,
    height:  2000,
    fit:     'inside',
    quality: 82,
    label:   'imagen adjunta',
  },
};

// Extensiones que aceptamos como entrada. La validación REAL de que el archivo es una
// imagen la hace sharp al decodificarlo (ver services/imageOptimizer.js); esta lista solo
// descarta lo obvio antes de leer el cuerpo de la request.
//
// `.heic`/`.heif` van desde el 2026-08-11: es el formato por defecto de la cámara del
// iPhone desde iOS 11, así que una docente que saca la foto y la sube desde el teléfono
// manda un .heic sin enterarse. Antes lo rechazábamos por extensión y el cartel que veía
// era "No se recibió ninguna imagen", que no explica nada — el caso real que motivó esto.
//
// Salen convertidos a WebP como cualquier otra imagen, así que al alumno le llega un
// formato que su navegador entiende: el HEIC nunca queda publicado tal cual.
const EXT_IMAGENES = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];

// Extensiones cuya decodificación depende de que libvips traiga el códec HEVC. Se listan
// aparte porque el modo de falla es distinto al de un archivo corrupto y el mensaje al
// usuario tiene que decirle qué hacer (ver imageOptimizer.js).
const EXT_DEPENDEN_DE_CODEC = ['.heic', '.heif'];

// Tamaño máximo de ENTRADA. Es alto a propósito: la salida se comprime a ~40 KB, así que
// no hay motivo para castigar a alguien que sube la foto tal cual sale del celular.
//
// Subido de 8 a 20 MB el 2026-08-11. Con 8 MB rebotaban fotos de celulares actuales (12 MP
// en HDR pasa los 8 MB sin esfuerzo) y quedaba la asimetría absurda de que un .zip de 20 MB
// entraba y una foto de 9 MB no — siendo que la foto se recomprime a ~100 KB y el .zip se
// guarda entero. Ahora los dos límites coinciden.
//
// El costo es RAM: multer usa memoryStorage, así que son hasta 20 MB por request en vuelo
// (ver middleware/image-upload.js). Con el uploadLimiter y el volumen de la escuela, entra
// de sobra en los 2 workers.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

module.exports = { PRESETS, EXT_IMAGENES, EXT_DEPENDEN_DE_CODEC, MAX_INPUT_BYTES };
