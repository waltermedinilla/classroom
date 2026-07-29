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
};

// Extensiones que aceptamos como entrada. La validación REAL de que el archivo es una
// imagen la hace sharp al decodificarlo (ver services/imageOptimizer.js); esta lista solo
// descarta lo obvio antes de leer el cuerpo de la request.
const EXT_IMAGENES = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

// Tamaño máximo de ENTRADA. Es alto a propósito: la salida se comprime a ~40 KB, así que
// no hay motivo para castigar a alguien que sube la foto tal cual sale del celular.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

module.exports = { PRESETS, EXT_IMAGENES, MAX_INPUT_BYTES };
