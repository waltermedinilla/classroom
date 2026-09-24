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

// ── RN-22: el aviso fijo, cuando el cartel quedó fuera de la vista (2026-09-24) ─────────────
//
// El reclamo fue "a algunos alumnos se les demora en aparecer el botón". No se demoraba: el
// primer alumno de cada toma lo da a los 36 s (mediana, medido en el espejo). Lo que pasaba es
// que en la sala en vivo el cartel va ARRIBA de todo, y en el celular el alumno que escribe en el
// chat lo tiene 1.000 px más arriba (1.450 con transmisión). Encima, el scroll anchoring del
// navegador hace que la inserción no mueva nada: no hay ninguna señal de que apareció.

/**
 * ¿Hay que mostrar el aviso fijo?
 *
 * @param {object} e
 * @param {number}  e.pendientes    bandas sin dar el presente
 * @param {boolean} e.enPantalla    el cartel se dibuja (no está en una solapa oculta)
 * @param {boolean} e.visible       el cartel se ve en la ventana
 * @param {string}  e.firma         firmaDe() de las tomas pintadas
 * @param {string|null} e.firmaCerrada  la firma con la que el alumno cerró el aviso (×)
 *
 * `enPantalla` deja afuera la solapa oculta de la materia a propósito: mostrarlo ahí era el
 * arreglo B, que el usuario no aprobó. Cerrado con una firma, no vuelve hasta que cambie el
 * CONJUNTO de tomas (la misma regla de repintado de RN-21): no molesta a cada rato, pero sí
 * avisa si se abre otra toma.
 */
function mostrarAviso(e) {
  const x = e || {};
  if (!(x.pendientes > 0)) return false;
  if (!x.enPantalla || x.visible) return false;
  return x.firmaCerrada == null || x.firmaCerrada !== x.firma;
}

/**
 * El marcado del aviso, en sus cuatro estados: 'dar' | 'enviando' | 'dada' | 'error'.
 *
 * El texto vive acá y no en el partial, por la misma regla que ETIQUETAS (ver su comentario):
 * el smoke comprueba que sin asistencia abierta el Inicio no trae el cartel, y un literal suelto
 * en el partial lo haría fallar, o volvería vacuo al test que afirma lo contrario.
 */
function avisoHTML(estado, mensaje) {
  // El parámetro se llama `icono` a propósito: así tools/iconos.js reconoce las llamadas a
  // simbolo('…') y mete esos nombres en la lista de head-iconos (causa 3 de fuente_iconos).
  function simbolo(icono) {
    return '<span class="material-symbols-outlined" aria-hidden="true">' + icono + '</span>';
  }
  const boton = (b, deshabilitado) =>
    '<button type="button" class="as-aviso-btn"' + (deshabilitado ? ' disabled' : '') + '>' +
      simbolo(b.icono) + '<span>' + b.texto + '</span></button>';
  const cerrar = '<button type="button" class="as-aviso-x" aria-label="Cerrar el aviso">' +
                   simbolo('close') + '</button>';

  if (estado === 'dada') {
    return simbolo('task_alt') +
           '<span class="as-aviso-txt" role="status">Listo, quedó tu presente de hoy.</span>' + cerrar;
  }
  const txt = estado === 'error'
    ? 'No se pudo dar el presente.<small>' + esc(mensaje) + '</small>'
    : 'Preceptoría está tomando asistencia.';
  return simbolo('front_hand') +
         '<span class="as-aviso-txt" role="status">' + txt + '</span>' +
         (estado === 'enviando' ? boton(ETIQUETAS.enviando, true) : boton(ETIQUETAS.dar, false)) +
         cerrar;
}

// ── RN-23: el sondeo se corta a los 15 s (2026-09-24) ───────────────────────────────────────
//
// fetch() no trae timeout. En una red de celular que cuelga el pedido, `enVuelo` quedaba en true
// y TODOS los ciclos siguientes —incluido el de volver a la pestaña— salían sin preguntar hasta
// que ese fetch terminara de fallar, que pueden ser minutos.
const TOPE_MS = 15000;

/**
 * Pide las tomas abiertas con un tope de tiempo. Devuelve la lista, o `null` ante cualquier
 * falla (sin red, corte, no-OK, JSON raro): con null el que llama NO toca lo que ya está pintado.
 *
 * Recibe `fetch` por parámetro para poder testearlo sin navegador (tests/unit/asistenciaBanda).
 */
async function pedirTomas(fetchImpl, ms) {
  const ctl   = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tope  = typeof ms === 'number' ? ms : TOPE_MS;
  let   timer = null;
  const corte = new Promise((resolve) => {
    timer = setTimeout(() => { if (ctl) ctl.abort(); resolve(null); }, tope);
  });
  const pedido = (async () => {
    try {
      const r = await fetchImpl('/asistencia/abierta', {
        headers: { Accept: 'application/json' },
        signal: ctl ? ctl.signal : undefined,
      });
      if (!r || !r.ok) return null;
      const d = await r.json();
      return d && Array.isArray(d.tomas) ? d.tomas : null;
    } catch { return null; }
  })();
  // La carrera con el corte es lo que garantiza el tope aunque el fetch ignore la señal.
  try { return await Promise.race([pedido, corte]); } finally { clearTimeout(timer); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, firmaDe, bandaHTML, bandasHTML, pintado, ETIQUETAS,
                     mostrarAviso, avisoHTML, pedirTomas, TOPE_MS };
} else if (typeof window !== 'undefined') {
  window.AsistenciaBanda = { esc, firmaDe, bandaHTML, bandasHTML, pintado, ETIQUETAS,
                             mostrarAviso, avisoHTML, pedirTomas, TOPE_MS };
}
