// Lógica pura de la tabla de notas y devoluciones del docente (modal de detalle de actividad).
//
// Está separada de course.js por dos razones:
//   1) Acá vive el bug que reclamaron los docentes el 2026-08-13: la devolución escrita SIN nota
//      se descartaba en silencio (la recolección iteraba los inputs de nota y salteaba la fila
//      entera cuando estaban vacíos), y encima la pantalla mostraba "✓ Notas guardadas".
//   2) Al ser una función sin DOM se puede testear con node:test → tests/unit/devoluciones.test.js.
//
// Se carga como <script> en views/course.ejs (queda como global) y como require() en los tests.

/**
 * Decide qué filas de la tabla hay que mandar al servidor y cuáles tienen la nota mal cargada.
 *
 * Cada fila: { studentId, nombre, nota, feedback, notaPrevia, feedbackPrevia }
 *   - `nota` / `feedback`     → lo que hay ahora en los campos (strings, tal cual el DOM)
 *   - `notaPrevia` / `feedbackPrevia` → lo que había al abrir el modal (para mandar solo lo tocado)
 *
 * @param {Array}  filas
 * @param {number} max  Nota máxima de la actividad (null/undefined = sin tope)
 * @returns {{ guardar: Array, invalidas: Array }}
 *   guardar:   [{ studentId, points?, feedback }] — `points` va SOLO si el docente cargó nota;
 *              si no va, el servidor deja intacta la nota que ya estuviera guardada.
 *   invalidas: [{ studentId, nombre, nota }] — notas fuera de rango o no numéricas, para avisar
 *              en vez de descartarlas sin decir nada (que es lo que se hacía antes).
 */
function recolectarDevoluciones(filas, max) {
  const guardar   = [];
  const invalidas = [];

  (filas || []).forEach(fila => {
    const texto           = v => (v === null || v === undefined ? '' : String(v).trim());
    const nota            = texto(fila.nota);
    const feedback        = texto(fila.feedback);
    const notaPrevia      = texto(fila.notaPrevia);
    const feedbackPrevia  = texto(fila.feedbackPrevia);

    const cambioNota     = nota !== notaPrevia;
    const cambioFeedback = feedback !== feedbackPrevia;
    if (!cambioNota && !cambioFeedback) return; // nada tocado en esta fila

    if (nota !== '' && cambioNota) {
      const points = Number(nota);
      if (!Number.isFinite(points) || points < 0 || (max != null && points > max)) {
        invalidas.push({ studentId: fila.studentId, nombre: fila.nombre, nota });
        return;
      }
      guardar.push({ studentId: fila.studentId, points, feedback });
      return;
    }

    // Queda: la nota no cambió (o no hay), y lo que cambió es la devolución. Es el caso que
    // se perdía. Se manda también cuando el docente vació el textarea, para poder borrar una
    // devolución. Va SIN `points`: el servidor deja intacta la nota que ya estuviera cargada.
    if (cambioFeedback) guardar.push({ studentId: fila.studentId, feedback });
  });

  return { guardar, invalidas };
}

/**
 * Texto del cartelito de confirmación, según lo que se haya guardado.
 * Evita el "✓ Notas guardadas" cuando en realidad no se guardó nada.
 */
function resumenGuardado(entries) {
  const conNota = entries.filter(e => e.points !== undefined).length;
  const soloDev = entries.length - conNota;
  if (conNota && soloDev) return `✓ ${conNota} nota(s) y ${soloDev} devolución(es) guardadas`;
  if (conNota)            return `✓ ${conNota} nota(s) guardada(s)`;
  if (soloDev)            return `✓ ${soloDev} devolución(es) guardada(s)`;
  return 'No había cambios para guardar';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { recolectarDevoluciones, resumenGuardado };
}
