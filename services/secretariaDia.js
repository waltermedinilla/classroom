// "Docentes del día" — el panel de la Secretaria. Ver specs/secretaria-docentes-del-dia.spec.md.
//
// Este archivo tiene SOLO funciones puras: sin Mongo, sin `req`, sin `Date.now()` escondido (el
// "ahora" entra por parámetro). Las consultas a la base viven en routes/secretaria.js, que junta
// los documentos y se los pasa a estas funciones. Así las reglas que deciden qué ve la secretaria
// se prueban en tests/unit/secretariaDia.test.js sin levantar nada.
//
// LA ZONA HORARIA NO SE DECIDE ACÁ. "Qué día es" sale de services/liveRoom.js (diaEscolar), que es
// el único dueño de la zona de la escuela — misma regla que services/actividadesDelDia.js. El
// patrón es el de siempre: una ventana UTC HOLGADA (±1 día) para el $match, y el recorte fino con
// diaEscolar() sobre cada documento. Producción corre en UTC: calcular el desfasaje a mano es
// exactamente cómo vuelve el bug de las tres horas.
//
// ⭐ Regla de fondo (D2): la ausencia de registro NO es ausencia del docente. Nada de lo que sale
// de acá dice "faltó": los tres estados son 'actividad', 'ingreso' y 'sinRegistro'.

const live = require('./liveRoom');

const DIA_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MS_DIA = 24 * 60 * 60 * 1000;

// Las acciones del registro de auditoría que cuentan como señal (RN-06). Constantes y no strings
// sueltos: la ruta arma su $match con estas mismas listas, y si un día se suma una acción va acá.
const ACCIONES_PUBLICO  = ['activity.create', 'announcement.create'];
const ACCIONES_CORRIGIO = ['submission.grade', 'submission.return'];
const ACCIONES_SENAL    = [...ACCIONES_PUBLICO, ...ACCIONES_CORRIGIO];

const TEXTO_MAX = 60;   // RN-10: lo que se muestra de una actividad o novedad
const NOTA_MAX  = 500;  // RN-12

const ESTADOS = {
  actividad:   'Con actividad',
  ingreso:     'Solo ingresó',
  sinRegistro: 'Sin registro en la plataforma',
};

const str = (x) => (x == null ? '' : String(x));

// ── Fechas ───────────────────────────────────────────────────────────────────────────────────

// ¿Es un 'YYYY-MM-DD' que existe de verdad? El regex solo no alcanza: '2026-02-31' lo pasa.
function esFecha(f) {
  if (typeof f !== 'string' || !DIA_RE.test(f)) return false;
  const [y, m, d] = f.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// La fecha del día de `d` en la zona de la escuela.
const fechaDe = (d) => live.diaEscolar(new Date(d));

// RN-09: fecha futura o mal formada → hoy. Sin tope hacia atrás.
function fechaValida(f, ahora) {
  const hoy = fechaDe(ahora);
  if (!esFecha(f)) return hoy;
  return f > hoy ? hoy : f;   // 'YYYY-MM-DD' ordena como string
}

// ¿`f` es posterior a hoy? Lo usa la nota (RN-12): anotar un día que no pasó es un 400, no un
// redirect silencioso como en la pantalla.
const esFutura = (f, ahora) => esFecha(f) && f > fechaDe(ahora);

function desplazar(f, dias) {
  const [y, m, d] = f.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + dias * MS_DIA).toISOString().slice(0, 10);
}
const diaAnterior  = (f) => desplazar(f, -1);
const diaSiguiente = (f) => desplazar(f, +1);

// Ventana UTC holgada para el $match (RN-05). Un día de más en cada punta: lo que sobra lo
// descarta `esDelDia`.
function ventanaDelDia(f) {
  const [y, m, d] = f.split('-').map(Number);
  return {
    $gte: new Date(Date.UTC(y, m - 1, d - 1)),
    $lt:  new Date(Date.UTC(y, m - 1, d + 2)),
  };
}

// El recorte fino: ¿este instante cae en el día `f` de la escuela?
const esDelDia = (ts, f) => !!ts && fechaDe(ts) === f;

// ── Alcance ──────────────────────────────────────────────────────────────────────────────────

// RN-04: los docentes que ve la secretaria = titular ∪ co-docentes de las materias cuyas
// divisiones están en su alcance. Devuelve un Map docenteId → [{ id, name, division }].
// `courses` llega con owner/coTeachers como ObjectId o populados: se compara por String().
function docentesDelAlcance(courses, scopeDivisionIds) {
  const alcance = new Set((scopeDivisionIds || []).map(String));
  const docentes = new Map();
  for (const c of courses || []) {
    if (!c || !alcance.has(str(c.division && (c.division._id || c.division)))) continue;
    const materia = {
      id: str(c._id), name: c.name || '', division: str(c.division && (c.division._id || c.division)),
      // Para la puntualidad (services/secretariaPuntualidad.js). Vacío = sin horario cargado.
      horarioClases: c.horarioClases || [],
    };
    const ids = [c.owner, ...(c.coTeachers || [])]
      .filter(Boolean)
      .map(u => str(u._id || u));
    for (const id of new Set(ids)) {
      if (!docentes.has(id)) docentes.set(id, []);
      const lista = docentes.get(id);
      if (!lista.some(m => m.id === materia.id)) lista.push(materia);
    }
  }
  return docentes;
}

// ── Señales ──────────────────────────────────────────────────────────────────────────────────

const cursoDe = (audit) => {
  const t = (audit && audit.targets || []).find(x => x && x.type === 'course');
  return t ? str(t.id) : '';
};

// RN-06. Recibe lo que la ruta trajo de la base para UN docente y UN día (con la ventana
// holgada) y devuelve las cuatro señales ya recortadas al día y a las materias del alcance.
//
//   ingreso       IngresoDiario de ese docente y fecha, o null
//   presencias    RoomPresence del docente (con `course`, `firstSeenAt`, `lastPingAt`, `msPresente`)
//   auditorias    AuditLog del docente con acción en ACCIONES_SENAL
//   cursosAlcance Set/Array de courseId del alcance
//   nombres       { courseId: nombre } para armar los textos
function senalesDelDocente({ fecha, ingreso = null, presencias = [], auditorias = [], cursosAlcance = [], nombres = {} }) {
  const alcance = new Set([...cursosAlcance].map(String));
  const nombre = (id) => nombres[id] || '';

  // S1 — no se limita a materias: es de la plataforma (RN-06).
  const s1 = ingreso && ingreso.fecha === fecha
    ? { primeraVez: ingreso.primeraVez || null, ultimaVez: ingreso.ultimaVez || ingreso.primeraVez || null }
    : null;

  // S2 — la sesión cuenta en el día en que EMPEZÓ (CA-08).
  const sala = [];
  for (const p of presencias || []) {
    const curso = str(p.course && (p.course._id || p.course));
    if (!alcance.has(curso) || !esDelDia(p.firstSeenAt, fecha)) continue;
    sala.push({
      desde: p.firstSeenAt,
      hasta: p.lastPingAt || p.firstSeenAt,
      curso, materia: nombre(curso),
      minutos: live.minutosPresente(p),
    });
  }
  sala.sort((a, b) => new Date(a.desde) - new Date(b.desde));

  // S3 y S4.
  const publico = [];
  const corrigio = [];
  const entregas = new Set();
  for (const a of auditorias || []) {
    const curso = cursoDe(a);
    if (!alcance.has(curso) || !esDelDia(a.timestamp, fecha)) continue;

    if (ACCIONES_PUBLICO.includes(a.action)) {
      const t = (a.targets || []).find(x => x.type === 'activity' || x.type === 'announcement');
      publico.push({
        ts: a.timestamp, curso, materia: nombre(curso),
        tipo: a.action === 'activity.create' ? 'actividad' : 'novedad',
        texto: str(t && t.name).slice(0, TEXTO_MAX),
      });
    } else if (ACCIONES_CORRIGIO.includes(a.action)) {
      // CA-07: grade y return de la MISMA entrega cuentan una. La entrega es (actividad, alumno).
      // El alumno se usa solo para la clave: nunca sale de esta función (RN-10).
      const act = (a.targets || []).find(x => x.type === 'activity');
      const alu = (a.targets || []).find(x => x.type === 'user');
      const clave = `${str(act && act.id)}|${str(alu && alu.id)}`;
      if (entregas.has(clave)) continue;
      entregas.add(clave);
      corrigio.push({ ts: a.timestamp, curso, materia: nombre(curso) });
    }
  }
  publico.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  corrigio.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  return {
    ingreso: s1,
    sala: { sesiones: sala.length, minutos: sala.reduce((t, s) => t + s.minutos, 0), items: sala },
    publico: { cantidad: publico.length, items: publico },
    corrigio: { cantidad: corrigio.length, items: corrigio },
  };
}

// D2 y RN-07. `hayDatoIngreso` = la escuela ya registraba ingresos ese día. Si no, S1 no cuenta
// para nada y la vista muestra "sin dato".
function estadoDelDia(s, { hayDatoIngreso = true } = {}) {
  if (!s) return 'sinRegistro';
  if (s.sala.sesiones > 0 || s.publico.cantidad > 0 || s.corrigio.cantidad > 0) return 'actividad';
  if (hayDatoIngreso && s.ingreso) return 'ingreso';
  return 'sinRegistro';
}

// La línea del día (D6): todos los eventos en orden. La sala lleva `hasta` (bloque con
// duración); el resto son puntos (`hasta: null`).
function eventosDeLaLinea(s) {
  if (!s) return [];
  const ev = [];
  for (const x of s.sala.items) {
    ev.push({ tipo: 'sala', desde: x.desde, hasta: x.hasta, materia: x.materia,
      texto: `Sala en vivo · ${x.minutos} min` });
  }
  for (const x of s.publico.items) {
    ev.push({ tipo: 'publico', desde: x.ts, hasta: null, materia: x.materia,
      texto: `Publicó ${x.tipo === 'actividad' ? 'una actividad' : 'una novedad'}${x.texto ? `: ${x.texto}` : ''}` });
  }
  for (const x of s.corrigio.items) {
    ev.push({ tipo: 'corrigio', desde: x.ts, hasta: null, materia: x.materia, texto: 'Corrigió una entrega' });
  }
  ev.sort((a, b) => new Date(a.desde) - new Date(b.desde));
  return ev;
}

function resumen(estados) {
  const r = { actividad: 0, ingreso: 0, sinRegistro: 0 };
  for (const e of estados || []) if (r[e] != null) r[e] += 1;
  return r;
}

// RN-12: valida el texto de la nota. Vacío (o solo espacios) = borrar.
function textoDeNota(t) {
  const texto = str(t).trim();
  if (!texto) return { borrar: true, texto: '' };
  if (texto.length > NOTA_MAX) return { error: `La anotación no puede pasar de ${NOTA_MAX} caracteres.` };
  return { borrar: false, texto };
}

module.exports = {
  ACCIONES_PUBLICO, ACCIONES_CORRIGIO, ACCIONES_SENAL, ESTADOS, TEXTO_MAX, NOTA_MAX,
  esFecha, fechaDe, fechaValida, esFutura, diaAnterior, diaSiguiente, ventanaDelDia, esDelDia,
  docentesDelAlcance, senalesDelDocente, estadoDelDia, eventosDeLaLinea, resumen, textoDeNota,
};
