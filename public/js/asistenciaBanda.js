// El cartel "Dar presente" del alumno: el marcado de la banda y la regla de cuándo repintarla.
// Lo usa views/partials/asistencia-banner.ejs. Ver specs/asistencia-preceptoria.spec.md.
//
// Separado del partial por el mismo motivo que sala-chart.js y edicionEntrega.js: sin DOM se
// puede testear con node:test (tests/unit/asistenciaBanda.test.js). El partial se queda solo
// con el cableado del DOM y el sondeo.
//
// ⭐ HAY UN SOLO RENDERIZADOR Y ES ÉSTE, Y LO LLAMAN LOS DOS LADOS. El cartel se pintaba en EJS,
// y el refresco que se agregó el 2026-09-11 lo iba a pintar en JS: dos marcados para la misma
// cosa divergen a la primera corrección que alguien haga en uno y no en el otro.
//
// Por eso este archivo es JS pelado, sin nada del navegador adentro: `routes/courses.js` lo
// requiere para la primera pintada del Inicio (que así sigue siendo HTML del servidor, como
// siempre) y el partial lo carga como <script> para los refrescos.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Los textos e íconos del botón, acá y no sueltos en el partial.
 *
 * ⚠️ NO ES COSMÉTICA, y costó un smoke rojo. El partial tenía `'Dar presente'` escrito a mano en
 * la recuperación de error del click, así que el Inicio de CUALQUIER alumno contenía ese texto
 * aunque no hubiera ninguna asistencia abierta. El smoke `attendance-autoasistencia-toggle`
 * comprueba justamente lo contrario —apagada la autoasistencia, "ni el cartel en su inicio"— y
 * lo cazó. Peor todavía: el test positivo habría pasado SIEMPRE, dejando de probar nada.
 *
 * Con las etiquetas acá, el texto viaja en /js/asistenciaBanda.js y aparece en el HTML de la
 * página solo cuando de verdad hay una banda pintada.
 */
const ETIQUETAS = {
  dar:      { icono: 'front_hand',    texto: 'Dar presente' },
  dada:     { icono: 'task_alt',      texto: 'Presente dado' },
  enviando: { icono: 'hourglass_top', texto: 'Enviando…' },
};

/**
 * La firma del CONJUNTO de tomas abiertas. Es lo único que dispara un repintado.
 *
 * ⚠️ `yaDi` NO entra, a propósito. Cuando el alumno aprieta el botón, el handler deja la banda
 * en su estado final, y a veces con un texto que el servidor no manda —"Preceptoría ya te había
 * tomado la asistencia", cuando su decisión pisa el presente del alumno—. Si `yaDi` estuviera en
 * la firma, el sondeo siguiente repintaría la banda y borraría ese mensaje justo después de
 * mostrarlo.
 *
 * Lo que el sondeo tiene que detectar es que **apareció o se cerró** una toma, que es el bug que
 * vino a arreglar. El estado de una banda que ya está en pantalla lo maneja el click.
 */
function firmaDe(tomas) {
  return (Array.isArray(tomas) ? tomas : [])
    .map((t) => String((t && t.id) || ''))
    .sort()
    .join(',');
}

// El marcado de una banda. `dada` = el alumno ya dio el presente (`yaDi`).
function bandaHTML(t) {
  const dada = !!(t && t.yaDi);
  const btn  = dada ? ETIQUETAS.dada : ETIQUETAS.dar;
  const texto = dada
    ? 'Ya diste el presente de hoy en <strong>' + esc(t.curso) + '</strong>.' +
      '<small>Si te la tomaron distinto, hablalo con preceptoría.</small>'
    : 'Preceptoría abrió la asistencia de <strong>' + esc(t.curso) + '</strong>.' +
      '<small>Abierta desde las ' + esc(t.abiertaDesde) +
      (t.cierraA ? ' · cierra ' + esc(t.cierraA) : '') + '</small>';

  return '<div class="as-band' + (dada ? ' dada' : '') + '" data-toma="' + esc(t && t.id) + '">' +
           '<span class="material-symbols-outlined">' + (dada ? 'task_alt' : 'fact_check') + '</span>' +
           '<div class="as-band-txt">' + texto + '</div>' +
           '<button class="as-band-btn"' + (dada ? ' disabled' : '') + '>' +
             '<span class="material-symbols-outlined" aria-hidden="true">' + btn.icono + '</span>' +
             '<span class="as-band-btn-txt">' + btn.texto + '</span>' +
           '</button>' +
         '</div>';
}

// Las bandas de una lista, en una sola cadena. Es lo que llaman LOS DOS lados: el servidor para
// la primera pintada del Inicio y el navegador para cada refresco.
function bandasHTML(tomas) {
  return (Array.isArray(tomas) ? tomas : []).map(bandaHTML).join('');
}

/**
 * Qué hacer con lo que acaba de contestar el servidor.
 *
 * @param {string|null} firmaPintada  la firma de lo que ya está en pantalla (null = nada todavía)
 * @param {Array}       tomas         las tomas abiertas que devolvió el servidor
 * @returns {{repintar:boolean, firma:string, html:string|null}}
 *
 * Con `firmaPintada` en null la primera pintada SIEMPRE se aplica, incluso con cero tomas: es lo
 * que deja el cartel vacío en su estado correcto en vez de dejarlo sin inicializar.
 */
function pintado(firmaPintada, tomas) {
  const lista = Array.isArray(tomas) ? tomas : [];
  const firma = firmaDe(lista);

  if (firma === firmaPintada) return { repintar: false, firma, html: null };
  return { repintar: true, firma, html: bandasHTML(lista) };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, firmaDe, bandaHTML, bandasHTML, pintado, ETIQUETAS };
} else if (typeof window !== 'undefined') {
  window.AsistenciaBanda = { esc, firmaDe, bandaHTML, bandasHTML, pintado, ETIQUETAS };
}
