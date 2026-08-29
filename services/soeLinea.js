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
  };
}

// ── El armado ────────────────────────────────────────────────────────────────
//
// `orden`: 'reciente' (default, lo último arriba — el trabajo diario) o 'cronologico' (del
// comienzo al presente — leer la historia). Cualquier otro valor cae en el default: la
// preferencia llega de localStorage y de un query param, y ninguno de los dos es confiable.
function construirLinea(legajo, { orden = 'reciente' } = {}) {
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

  const cierre = hitoCierre(legajo);
  if (cierre) hitos.push(cierre);

  const asc = orden === 'cronologico';
  hitos.sort((a, b) => (asc ? a.fecha - b.fecha : b.fecha - a.fecha));
  return hitos;
}

module.exports = { construirLinea };
