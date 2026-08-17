// Traduce los errores de multer a una respuesta para el que sube.
//
// multer corta la subida ANTES del handler —archivo pasado de tamaño, tipo no permitido— y
// avisa lanzando un error. Si nadie lo intercepta, ese error llega al manejador global de
// server.js, que contesta 500 "Error del servidor (ref: ...)". Dos cosas malas de una:
//
//   1. El que subió se queda sin saber qué hizo mal. El archivo pesaba de más, no hay nada
//      roto, y sin embargo lee un error de sistema con una referencia de soporte.
//   2. El error.log se llena de fallas que no son fallas. Ese log es donde se mira cuando
//      algo se rompe de verdad (ver el árbol de decisión de logs/combined.log): un dedazo
//      con un .csv no puede figurar al lado de un stack.
//
// El patrón ya existía escrito a mano en cuatro lugares: `subirImagen`
// (middleware/image-upload.js), `conArchivo` (routes/rooms.js) y dos envoltorios inline en
// routes/activities.js. Esta función es el mismo patrón, una sola vez, para las rutas que
// habían quedado sin él. Los cuatro de antes siguen como están a propósito: son caminos ya
// cubiertos por el smoke y no vale la pena arriesgar una regresión ahí para unificar; el
// día que se toque alguno, migrarlo acá.
//
//   mw        el middleware de multer ya construido (upload.single('x'), .array('y', 10)…)
//   maxMb     tope declarado en `limits.fileSize`, en MB. Se nombra en el mensaje: un tope
//             que no dice cuál es el tope no sirve de nada.
//   queEs     cómo llamar al archivo en el mensaje ('El archivo', 'La imagen', 'El Excel').
function conErroresDeSubida(mw, { maxMb, queEs = 'El archivo' } = {}) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `${queEs} es demasiado grande (máximo ${maxMb} MB)` });
      }
      // El resto son errores de forma del pedido: tipo rechazado por el fileFilter, más
      // archivos de los permitidos, campo con otro nombre. Todos son 400, y el mensaje de
      // multer ya viene en español cuando lo escribe un fileFilter nuestro.
      return res.status(400).json({ error: err.message || 'Error al procesar el archivo' });
    });
  };
}

module.exports = { conErroresDeSubida };
