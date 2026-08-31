// La línea de tiempo del legajo: todas las actuaciones del gabinete en un solo hilo.
//
// Hasta el 2026-08-27 la ficha tenía dos listas que no se cruzaban —"Seguimiento" con las
// entradas y "Derivaciones" con los servicios externos—, cada una ordenada por su cuenta.
// Leído así no se veía el RECORRIDO: que el 12 de marzo fue la entrevista, el 20 la
// derivación al hospital, el 15 de septiembre la devolución y el 20 de mayo la observación
// de aula. Esta función los mezcla en una sola serie cronológica.
//
// TODO acá es PURO: no toca mongoose, no lee la fecha del sistema, no arma HTML. Se testea
// con node --test sin base (tests/unit/soeLinea.test.js), que es la regla de la casa para
// toda lógica que decide qué se ve.
//
// ⚠️ RECIBE EL LEGAJO YA SANITIZADO por acceso.sanitizarLegajo(), nunca el documento crudo.
// No es un detalle de estilo: es lo que garantiza que la línea de tiempo no pueda inventar
// una puerta nueva a los datos clínicos. En nivel 'resumen' el objeto sanitizado no trae
// `entries` ni `referrals`, así que esta función devuelve [] sola, SIN ninguna regla de
// confidencialidad propia que haya que mantener sincronizada con soeAcceso.js.
//
// Ver la decisión D6 de specs/soe-derivacion-y-linea-de-tiempo.spec.md.

const {
  TIPO_ENTRADA_LABELS, TIPO_ENTRADA_ICONS,
  TIPO_DERIVACION_LABELS, ESTADO_DERIVACION_LABELS,
} = require('./soeAcceso');
const {
  CITADO_LABELS, ESTADO_CITACION_LABELS, citacionEnLinea,
} = require('./soeAgenda');
const { claveAncla, agruparPorAncla } = require('./soeAdjuntos');

// Una fecha utilizable, o null. Un hito sin fecha no se puede ubicar en el hilo y se
// descarta: es preferible que falte a que aparezca en 1970 arriba de todo.
const cuando = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

// ── Los hitos ────────────────────────────────────────────────────────────────
//
// Todos comparten la misma forma plana, para que la vista dibuje una sola tarjeta y no un
// `if` por tipo:
//
//   tipo    → la clase de hito: apertura | entrada | derivacion | devolucion | cierre.
//             Es lo que elige el color de acento de la tarjeta.
//   subtipo → el detalle dentro de la clase (el tipo de entrada, el de derivación).
//   fecha   → la que ORDENA. Siempre la del hecho, nunca la de carga.
//   meta    → el dato corto de la esquina (el estado de la derivación, por ejemplo).
//   refId   → la derivación a la que pertenece, para linkear al panel de gestión.
//   animo   → solo en las entradas; tiñe el círculo. null = esta entrada no dice nada
//             sobre cómo estaba el chico, que es un caso legítimo del modelo.
//   ancla   → la clave con la que se le cuelgan los adjuntos (ver services/soeAdjuntos.js).
//             Se resuelve al final, de una sola pasada, y termina en `adjuntos`.
//   adjuntos→ los papeles de ESE hito: el certificado que trajeron a la entrevista, la nota
//             con la que se derivó, la receta que volvió del hospital, el acta que firmaron
//             en la citación. Siempre un array, aunque esté vacío: la vista no tiene que
//             preguntar si existe.

function hitoApertura(legajo) {
  const fecha = cuando(legajo.openedAt);
  if (!fecha) return null;
  const motivo = texto(legajo.motivo);
  return {
    tipo: 'apertura',
    subtipo: null,
    fecha,
    titulo: 'Se abrió el legajo',
    texto: motivo || 'Sin motivo registrado al abrir.',
    icono: 'folder_open',
    animo: null,
    autor: legajo.openedBy || null,
    meta: null,
    refId: null,
    // El material general del legajo NO cuelga de acá, y es deliberado: un informe cargado
    // hoy aparecería dentro de la tarjeta de apertura, que está al fondo del hilo por ser lo
    // más viejo, y quedaría escondido justo el día que se subió. Ese material vive en el
    // panel "Material y documentación" de la ficha, que es un índice y no una cronología.
    ancla: null,
  };
}

function hitoEntrada(e) {
  const fecha = cuando(e.fecha);
  if (!fecha) return null;
  return {
    tipo: 'entrada',
    subtipo: e.tipo || 'nota',
    fecha,
    titulo: TIPO_ENTRADA_LABELS[e.tipo] || 'Nota',
    texto: texto(e.texto),
    icono: TIPO_ENTRADA_ICONS[e.tipo] || 'sticky_note_2',
    // El ánimo se normaliza a null: el modelo lo deja ausente, en null o en '' según por
    // dónde haya entrado, y la vista necesita un solo valor falsy para no pintar el círculo.
    animo: e.animo || null,
    autor: e.autor || null,
    meta: e.editedAt ? 'editado' : null,
    refId: null,
    entryId: e._id || null,
    ancla: claveAncla('entrada', e._id),
  };
}

function hitoDerivacion(r) {
  const fecha = cuando(r.fecha);
  if (!fecha) return null;
  const destino = texto(r.destino) || 'Servicio externo';
  const clase = TIPO_DERIVACION_LABELS[r.tipo];
  return {
    tipo: 'derivacion',
    subtipo: r.tipo || 'otro',
    fecha,
    titulo: `Derivación · ${destino}`,
    texto: texto(r.motivo),
    icono: 'share',
    animo: null,
    autor: r.creadaPor || null,
    // El estado ACTUAL de la derivación, no el que tenía el día que se derivó: es lo que
    // hace falta para saber si hay que hacer algo, que es para lo que se mira el hilo.
    meta: ESTADO_DERIVACION_LABELS[r.estado] || null,
    submeta: clase || null,
    refId: r._id || null,
    ancla: claveAncla('derivacion', r._id),
  };
}

// La devolución es un hito PROPIO y no un renglón dentro de la tarjeta de su derivación.
// Motivo: llega meses después. Dibujada adentro de la derivación, la fecha en que el
// hospital finalmente contestó desaparece del hilo — y ese es justamente el dato que la
// spec madre dice que hoy se pierde en un pasillo.
function hitoDevolucion(d, r) {
  const fecha = cuando(d.fecha);
  if (!fecha) return null;
  const destino = texto(r.destino) || 'el servicio';
  return {
    tipo: 'devolucion',
    subtipo: r.tipo || 'otro',
    fecha,
    titulo: `Devolución de ${destino}`,
    texto: texto(d.texto),
    icono: 'forum',
    animo: null,
    autor: d.registradoPor || null,
    meta: null,
    refId: r._id || null,
    // ⭐ Acá cuelgan el certificado y la receta que vuelven del servicio: el hito de la
    // devolución es exactamente "lo que dijeron allá", y el papel que lo respalda es parte de
    // eso. Es el caso que motivó toda esta feature.
    ancla: claveAncla('devolucion', d._id),
  };
}

// ── La citación ──────────────────────────────────────────────────────────────
//
// Un encuentro que el gabinete convocó: la familia, el chico, los docentes. Entra al hilo
// solo cuando ya pasó o se resolvió — la regla vive en services/soeAgenda.js y la decide
// `construirLinea`, no esta función. Una citación para dentro de tres semanas es AGENDA, y
// puesta en un hilo ordenado con lo último arriba se sentaría por encima de todo lo que de
// verdad ocurrió.
function hitoCitacion(c) {
  // El día es TEXTO ('YYYY-MM-DD') y se convierte al mediodía UTC solo para poder ordenar el
  // hilo. El mediodía y no la medianoche: es el mismo truco que usa el resto del proyecto
  // para que el día del calendario sea el mismo en cualquier zona entre UTC−11 y UTC+11.
  // La HORA no se convierte nunca — viaja aparte, como el texto literal que es.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c && c.dia))) return null;
  const fecha = cuando(`${c.dia}T12:00:00Z`);
  if (!fecha) return null;

  const aQuien = CITADO_LABELS[c.a] || 'Citación';
  return {
    tipo: 'citacion',
    subtipo: c.a || 'familia',
    fecha,
    titulo: `Citación · ${aQuien}`,
    texto: texto(c.motivo),
    icono: 'event',
    animo: null,
    autor: c.creadaPor || null,
    meta: ESTADO_CITACION_LABELS[c.estado] || null,
    submeta: c.hora || null,
    // Lo que pasó en el encuentro, si se registró. Va aparte del motivo porque son dos cosas
    // distintas —para qué se la citó y qué se habló— y mezclarlas en un solo párrafo es
    // justamente lo que hace que un legajo no se pueda releer.
    resultado: texto(c.notas),
    lugar: texto(c.lugar),
    refId: null,
    citacionId: c._id || null,
    ancla: claveAncla('citacion', c._id),
  };
}

function hitoCierre(legajo) {
  const fecha = cuando(legajo.closedAt);
  if (!fecha) return null;
  const motivo = texto(legajo.cierreMotivo);
  return {
    tipo: 'cierre',
    subtipo: null,
    fecha,
    titulo: 'Se cerró el legajo',
    texto: motivo || 'Sin motivo registrado al cerrar.',
    icono: 'task_alt',
    animo: null,
    autor: legajo.closedBy || null,
    meta: null,
    refId: null,
    ancla: null,
  };
}

// ── El armado ────────────────────────────────────────────────────────────────
//
// `orden`: 'reciente' (default, lo último arriba — el trabajo diario) o 'cronologico' (del
// comienzo al presente — leer la historia). Cualquier otro valor cae en el default: la
// preferencia llega de localStorage y de un query param, y ninguno de los dos es confiable.
//
// `hoy`: el día escolar ('YYYY-MM-DD') con el que se decide si una citación ya entra al hilo.
// Es un PARÁMETRO y no `new Date()` adentro, para que esta función siga sin mirar el reloj y
// los tests puedan pararse en cualquier fecha. Sin él, ninguna citación pendiente entra —
// que es el comportamiento seguro: nunca inventa que un encuentro ya ocurrió.
function construirLinea(legajo, { orden = 'reciente', hoy = null } = {}) {
  if (!legajo || typeof legajo !== 'object') return [];

  const hitos = [];

  const apertura = hitoApertura(legajo);
  if (apertura) hitos.push(apertura);

  for (const e of (legajo.entries || [])) {
    const h = hitoEntrada(e);
    if (h) hitos.push(h);
  }

  for (const r of (legajo.referrals || [])) {
    const h = hitoDerivacion(r);
    if (h) hitos.push(h);
    for (const d of (r.devoluciones || [])) {
      const v = hitoDevolucion(d, r);
      if (v) hitos.push(v);
    }
  }

  for (const c of (legajo.citaciones || [])) {
    if (!citacionEnLinea(c, hoy)) continue;
    const h = hitoCitacion(c);
    if (h) hitos.push(h);
  }

  const cierre = hitoCierre(legajo);
  if (cierre) hitos.push(cierre);

  // Los papeles de cada hito, de una sola pasada sobre el array plano de adjuntos. Es acá y
  // no en la vista por la misma razón de siempre: el .ejs dibuja, no decide.
  //
  // Un hito sin ancla (la apertura y el cierre) recibe [] igual. Que TODOS tengan el campo es
  // lo que deja escribir `h.adjuntos.length` en la vista sin un `if` por tipo de hito.
  const porAncla = agruparPorAncla(legajo.adjuntos || []);
  for (const h of hitos) {
    h.adjuntos = (h.ancla && porAncla.get(h.ancla)) || [];
  }

  const asc = orden === 'cronologico';
  hitos.sort((a, b) => (asc ? a.fecha - b.fecha : b.fecha - a.fecha));
  return hitos;
}

module.exports = { construirLinea };
