// El historial de una entrega — specs/correccion-de-entregas.spec.md, RN-33 y RN-34.
//
// Hasta esta feature, reenviar BORRABA del disco los archivos que quedaban afuera
// (routes/activities.js, el unlink del submit). Si el alumno reemplazaba el archivo después
// de que el docente lo corrigió, lo corregido no existía en ninguna parte. Ahora el archivo
// se MUEVE a `_versiones/` dentro de la misma carpeta del alumno —que ya está en CARPETAS
// (id `entregas`), así que no hay superficie nueva de backup— y queda referenciado en
// `submission.versions[]`.
//
// ⚠️ Por qué hay tope: hoy existe un tope NATURAL de una versión por alumno (la actual) y
// esta feature lo saca. `archivos/entregas` es el 99,8% del peso del backup, y el backup
// viaja por FTP a la PC del dueño. Cinco versiones acotan el crecimiento sin que nadie
// pierda lo que estaba mirando.
const path = require('path');

const TOPE_VERSIONES = 5;

// El subdirectorio donde viven los archivos de las versiones viejas, dentro de la carpeta
// del propio alumno. El nombre arranca con guión bajo para que se distinga de un filename
// (que siempre es timestamp-random.ext) al mirar el árbol a ojo.
const DIR_VERSIONES = '_versiones';

/**
 * Empuja una versión y recorta al tope. PURA: no toca el disco.
 *
 * @param {Array}  versionesExistentes  lo que ya había en `submission.versions`
 * @param {object} nuevaVersion         la que ACABA de quedar afuera (lo que era "la actual")
 * @param {number} tope                 cuántas se conservan
 * @returns {{versiones: Array, descartada: object|null}}
 *          `descartada` es la más vieja que se cayó por superar el tope, o null. Quien llama
 *          es el que borra del disco sus archivos: acá no hay filesystem.
 */
function recortarVersiones(versionesExistentes, nuevaVersion, tope = TOPE_VERSIONES) {
  const previas = Array.isArray(versionesExistentes) ? versionesExistentes.slice() : [];
  // La más reciente primero: es el orden en el que se lee la línea de tiempo del panel.
  const todas = [nuevaVersion, ...previas];
  const limite = Math.max(0, Number(tope) || 0);
  if (todas.length <= limite) return { versiones: todas, descartada: null };
  return {
    versiones:  todas.slice(0, limite),
    descartada: todas[todas.length - 1] || null,
  };
}

/**
 * El storagePath que le toca a un archivo cuando pasa a ser historia.
 * `{school}/{act}/{student}/archivo.pdf` → `{school}/{act}/{student}/_versiones/archivo.pdf`
 *
 * Se arma con posix a propósito: `storagePath` se guarda con barras normales en la base (así
 * lo escriben las dos rutas de subida) y path.join lo convertiría a `\` en Windows, dejando
 * en la base una ruta que el Linux de producción no podría resolver después de un restore.
 */
function rutaEnVersiones(storagePath) {
  const partes = String(storagePath || '').split('/');
  const archivo = partes.pop();
  return [...partes, DIR_VERSIONES, archivo].join('/');
}

/** El directorio absoluto de `_versiones/` para una carpeta de entrega ya resuelta. */
function dirDeVersiones(dirDelAlumno) {
  return path.join(dirDelAlumno, DIR_VERSIONES);
}

module.exports = { recortarVersiones, rutaEnVersiones, dirDeVersiones, TOPE_VERSIONES, DIR_VERSIONES };
