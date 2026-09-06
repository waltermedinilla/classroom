// Lógica pura de la tabla de notas y devoluciones del docente (modal de detalle de actividad).
//
// Está separada de course.js por dos razones:
//   1) Acá vive el bug que reclamaron los docentes el 2026-08-13: la devolución escrita SIN nota
//      se descartaba en silencio (la recolección iteraba los inputs de nota y salteaba la fila
//      entera cuando estaban vacíos), y encima la pantalla mostraba "✓ Notas guardadas".
//   2) Al ser una función sin DOM se puede testear con node:test → tests/unit/devoluciones.test.js.
//
// Se carga como <script> en views/course.ejs (queda como global), como require() en los tests
// y —desde el 2026-09-06— también en el SERVIDOR (routes/activities.js), que es lo que hace que
// la regla de la nota mínima no pueda decir una cosa en la pantalla y otra en la base.

// ── La nota más baja que puede poner una persona ─────────────────────────────
//
// Regla de la escuela, confirmada por el dueño el 2026-08-31: **la nota mínima es 1**. Un 0
// cargado a mano es siempre inválido.
//
// ⭐ La razón por la que esto existe es más interesante que la regla: hasta la v1.0.41 un
// casillero de nota VACÍO se guardaba como 0 (`Number('')` es 0), y eso fabricó 128 notas en 0
// que ningún docente puso. Ese bug se arregló en el código el 2026-08-14 y los datos se
// repararon el 2026-09-06 — pero al medirlos aparecieron 47 ceros MÁS, todos posteriores al fix,
// o sea tipeados a mano. La conclusión es que el 0 no era un accidente de programación
// solamente: es lo que la gente escribe cuando quiere decir "corregí, pero no le pongo nota".
// Por eso el mensaje de rechazo no puede ser solo un "no": tiene que nombrar la alternativa
// (dejar el casillero vacío = devolución sin nota), que es lo que la persona quería hacer.
//
// ⚠️ NO aplica al autocalificador. Ahí un 0 es real —el alumno contestó todo mal— y su camino de
// escritura es otro (routes/activities.js, el bloque de `autoGraded`, que escribe `manual: false`
// sin pasar por POST /:id/grade). Por el mismo motivo `models/Activity.js` conserva `min: 0` en
// el sub-schema: ese es el piso absoluto del dato, no el de la carga manual.
const NOTA_MINIMA = 1;

/**
 * ¿Es válida esta nota puesta a mano? Única fuente de verdad, para el servidor y el navegador.
 *
 * @param {*}      valor  Lo que cargó la persona (string del DOM o número)
 * @param {number} max    Nota máxima de la actividad (null/undefined = sin tope)
 * @returns {{ ok: boolean, points?: number, error?: string }}
 */
function notaValidaManual(valor, max) {
  const points = Number(valor);

  if (!Number.isFinite(points)) {
    return { ok: false, error: 'La nota tiene que ser un número.' };
  }
  if (points < NOTA_MINIMA) {
    // El texto nombra la salida, no solo el rechazo. Ver el comentario largo de arriba.
    return {
      ok:    false,
      error: `La nota más baja es ${NOTA_MINIMA}. Si corregiste pero no querés ponerle nota, `
           + 'dejá el casillero vacío y escribí solo la devolución.',
    };
  }
  if (max != null && points > max) {
    return { ok: false, error: `La nota no puede superar el máximo de la actividad (${max}).` };
  }

  return { ok: true, points };
}

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
      // La regla es una sola y vive arriba: acá NO se repite el rango a mano. Es lo que evita
      // que la pantalla acepte un 0 que el servidor después va a rechazar (o al revés).
      const veredicto = notaValidaManual(nota, max);
      if (!veredicto.ok) {
        // El motivo viaja con cada fila: con 30 alumnos en pantalla, "quedaron fuera de rango"
        // no alcanza para saber si el problema fue un 0, un 11 o una letra.
        invalidas.push({ studentId: fila.studentId, nombre: fila.nombre, nota, error: veredicto.error });
        return;
      }
      guardar.push({ studentId: fila.studentId, points: veredicto.points, feedback });
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
  module.exports = { recolectarDevoluciones, resumenGuardado, notaValidaManual, NOTA_MINIMA };
}
