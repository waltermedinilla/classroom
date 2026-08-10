// Asistencia de preceptoría: la toma del día de un curso, sus marcas y su cierre.
// Ver specs/asistencia-preceptoria.spec.md.
//
// Mismo reparto que services/liveRoom.js: todas las constantes de la feature viven ACÁ con su
// fundamento al lado, después van las funciones PURAS (reciben `now` o `hoy`, no leen el reloj
// ni la base — son las que se testean en tests/unit/attendance.test.js) y al final las que
// tocan Mongo.
//
// Lo que esta feature NO hace: escribirle a la sala en vivo. La lee para sugerir y nada más
// (decisión del usuario). Ninguna función de este archivo modifica RoomSession, RoomMessage
// ni RoomPresence.

const mongoose = require('mongoose');

const AttendanceSession = require('../models/AttendanceSession');
const AttendanceMark    = require('../models/AttendanceMark');
const Course            = require('../models/Course');
const User              = require('../models/User');
// Solo LECTURA: de acá salen las sugerencias de "estos chicos están ahora en clase".
// Nada en este archivo le escribe a la sala en vivo.
const RoomSession       = require('../models/RoomSession');
const RoomPresence      = require('../models/RoomPresence');

const live = require('./liveRoom');

// ── Constantes ───────────────────────────────────────────────────────────────

// Los cuatro estados, en el orden en que se pintan los botones de la grilla. El orden importa
// para la UI: 'presente' primero porque es el que se toca 25 veces por curso.
const ESTADOS = ['presente', 'tarde', 'ausente', 'justificado'];

const ESTADO_LABELS = {
  presente:    'Presente',
  tarde:       'Tarde',
  ausente:     'Ausente',
  justificado: 'Justificado',
};

// Cada cuánto se repinta la grilla del preceptor. Se REUSA la constante del panel de
// dirección en vez de inventar otra: es el mismo tipo de pantalla (supervisión, no
// conversación) y la corre una sola persona por curso, no 25 como el poll de la sala.
const POLL_MS = live.DIRECTIVO_POLL_MS;

// Motivo del justificado u observación. Se recorta, no se rechaza: que una nota larga tire
// un error rojo en medio del pase de lista sería peor que guardarla cortada.
const NOTE_MAX = 200;

// Quién puso la marca, para la columna del CSV. El CSV lo lee gente, no un programa.
const ORIGEN_LABELS = {
  preceptor: 'Preceptoría',
  alumno:    'El propio alumno',
  sala:      'Sala en vivo',
};

// Letra de cada estado en la planilla mensual. Una columna por día con la palabra entera
// daría una hoja de tres metros de ancho; la referencia va al pie del archivo.
const ESTADO_LETRA = { presente: 'P', tarde: 'T', ausente: 'A', justificado: 'J' };

// ── Funciones puras ──────────────────────────────────────────────────────────

// Día escolar 'YYYY-MM-DD' en la zona de la escuela. Se re-exporta desde liveRoom, que es
// donde vive la única definición de la zona horaria del proyecto (ver el comentario largo
// allá). No armar otro formatter acá.
const diaEscolar = live.diaEscolar;

// El estado que llega del body, o null. Lista blanca cerrada: nunca se confía en el cliente,
// y un `status` inesperado no puede terminar guardado en la base por más que el enum del
// schema lo atajaría después.
function normalizarEstado(raw) {
  return typeof raw === 'string' && ESTADOS.includes(raw) ? raw : null;
}

// Los números del encabezado de la grilla. `sinMarcar` solo puede ser > 0 con la toma
// abierta: al cerrar, todos los null pasan a 'ausente'.
function resumen(marks = []) {
  const r = { presentes: 0, tarde: 0, ausentes: 0, justificados: 0, sinMarcar: 0, total: 0 };
  for (const m of marks) {
    r.total += 1;
    switch (m?.status) {
      case 'presente':    r.presentes    += 1; break;
      case 'tarde':       r.tarde        += 1; break;
      case 'ausente':     r.ausentes     += 1; break;
      case 'justificado': r.justificados += 1; break;
      default:            r.sinMarcar    += 1; break;
    }
  }
  return r;
}

// ¿Esta toma quedó abierta de un día anterior?
//
// Una toma de asistencia no puede cruzar la medianoche: no hay caso de uso legítimo, y una
// ventana olvidada el viernes dejaría a todo el curso marcándose presente el lunes. Se evalúa
// de forma PEREZOSA desde las rutas (no con un setInterval) por el mismo motivo que el
// autocierre de la sala: PM2 corre dos workers y un timer se ejecutaría dos veces.
function shouldAutoClose(session, hoy = diaEscolar()) {
  if (!session || session.closedAt) return false;
  return session.date !== hoy;
}

// ¿El alumno puede marcarse a sí mismo en esta toma, ahora?
// Las tres condiciones de RN-07 juntas. La hora de cierre gana sobre el estado de la toma:
// vencida la ventana, el alumno ya no se marca aunque el preceptor todavía no haya apretado
// "Cerrar" — si no, una ventana con hora de cierre no significaría nada.
function puedeAutoMarcarse(session, now = new Date()) {
  if (!session || session.closedAt) return false;
  if (session.settings?.selfCheckin !== true) return false;
  if (!session.closesAt) return true;
  return new Date(session.closesAt).getTime() > now.getTime();
}

// ¿Marcar esto pisa una decisión que ya estaba tomada?
// Decide qué se audita: poner la primera marca de un alumno es el trabajo normal (30 por
// curso y por día); pisar una que ya tenía estado es lo que después se revisa.
function esCorreccion(mark) {
  return !!(mark && mark.status);
}

// ¿Es un día escolar bien escrito?
const esDia = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Valida el rango del historial y del export. Devuelve null si no sirve — quien llama
// responde 400 en vez de disparar una consulta sin límites contra la colección más grande
// del sistema.
function rangoValido(desde, hasta) {
  if (!esDia(desde) || !esDia(hasta)) return null;
  if (desde > hasta) return null;   // strings ISO: el orden alfabético ES el cronológico
  return { desde, hasta };
}

// Rango por defecto: del 1° del mes al día de hoy. Es lo que se mira a fin de mes.
function rangoDelMes(hoy = diaEscolar()) {
  return { desde: hoy.slice(0, 8) + '01', hasta: hoy };
}

// Porcentaje de días que el alumno asistió. La llegada tarde CUENTA como asistió: el chico
// estuvo en la escuela. Esto NO calcula inasistencias reglamentarias (los cuartos y las
// medias faltas) — eso es un acto administrativo que esta feature no hace.
function porcentajeAsistencia(t) {
  const dias = t.presentes + t.tarde + t.ausentes + t.justificados;
  if (!dias) return 0;
  return Math.round(((t.presentes + t.tarde) / dias) * 1000) / 10;
}

// ── Funciones con base de datos ──────────────────────────────────────────────

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// La nómina de un curso: los alumnos de TODAS sus materias, sin repetir.
//
// Un alumno cursa varias materias del mismo año, así que sumar los `students` de cada materia
// lo contaría una vez por materia — el mismo motivo del $setUnion en routes/preceptor.js:73.
//
// Se excluyen las cuentas deshabilitadas (`active: false`): no pueden ni entrar a la
// plataforma, y arrastrarlas dejaría un ausente perpetuo en la planilla de todos los días.
async function rosterDeDivision(divisionId) {
  const cursos = await Course.find({ division: divisionId }).select('students').lean();
  const ids = [...new Set(cursos.flatMap(c => (c.students || []).map(String)))];
  if (!ids.length) return [];

  const alumnos = await User.find({
    _id: { $in: ids }, role: 'student', active: { $ne: false },
  }).select('name dni').lean();

  // Mismo orden que la solapa Personas y la sala: los nombres se cargan como
  // "APELLIDO, Nombre", así que ordenar por el string completo alcanza.
  return alumnos.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }));
}

// Abre la toma del día de un curso. IDEMPOTENTE: si ya existe la del día con esa etiqueta
// devuelve esa misma con `creada: false`, y quien llama decide qué hacer según esté abierta
// (seguir trabajando) o cerrada (409, ya se tomó).
//
// Al abrir se CONGELA la nómina: una marca por alumno, con su nombre y su DNI copiados.
async function abrirToma(division, user, opciones = {}) {
  const hoy   = diaEscolar();
  const label = String(opciones.label || '').trim().slice(0, 30);

  const existente = await AttendanceSession.findOne({ division: division._id, date: hoy, label });
  if (existente) return { session: existente, creada: false };

  const mode = opciones.mode === 'ventana' ? 'ventana' : 'pase';
  // En 'ventana' la autoasistencia viene prendida (es el punto del modo) y en 'pase' apagada,
  // pero el preceptor puede decidir lo contrario en los dos casos.
  const selfCheckin = opciones.selfCheckin === undefined
    ? mode === 'ventana'
    : opciones.selfCheckin === true || opciones.selfCheckin === 'true';

  // El cierre programado se pide en MINUTOS ("cerrala en 45"), no como una hora absoluta.
  // Es a propósito y no es un detalle de UI: un "08:15" escrito en el navegador se
  // interpreta con la zona horaria de esa máquina, y las computadoras del aula tienen
  // cualquier zona configurada — la ventana se cerraría tres horas antes o después según
  // desde dónde se abrió. Los minutos son un intervalo, no un instante: no dependen de
  // ninguna zona. La HORA de cierre que ve la pantalla se calcula después en el servidor,
  // con la zona de la escuela (live.hora).
  //
  // Tope de 12 horas: más que eso ya es una ventana que cruza el día y la cierra el
  // autocierre igual (shouldAutoClose).
  let closesAt = null;
  const minutos = Number.parseInt(opciones.closesInMin, 10);
  if (Number.isFinite(minutos) && minutos > 0 && minutos <= 12 * 60) {
    closesAt = new Date(Date.now() + minutos * 60000);
  }

  const roster = await rosterDeDivision(division._id);

  let session;
  try {
    session = await AttendanceSession.create({
      division: division._id,
      school:   division.school?._id || division.school,
      date:     hoy,
      label,
      openedBy: user._id,
      mode,
      closesAt,
      settings: { selfCheckin },
      rosterSize: roster.length,
    });
  } catch (err) {
    // Dos preceptores del mismo curso tocando "Abrir" a la vez: el índice único deja pasar a
    // uno solo y el otro se queda con la toma que ganó, sin ver un error.
    if (err.code === 11000) {
      const otra = await AttendanceSession.findOne({ division: division._id, date: hoy, label });
      if (otra) return { session: otra, creada: false };
    }
    throw err;
  }

  if (roster.length) {
    await AttendanceMark.insertMany(roster.map(a => ({
      session:  session._id,
      student:  a._id,
      division: session.division,
      school:   session.school,
      date:     session.date,
      studentName: a.name || '',
      studentDni:  a.dni  || '',
    })), { ordered: false });
  }

  return { session, creada: true };
}

// Cierra la toma. Todo lo que quedó sin marcar pasa a 'ausente': una toma cerrada no tiene
// ningún null. `auto` distingue el cierre por cambio de día del que hace una persona.
async function cerrarToma(session, user = null, { auto = false } = {}) {
  if (session.closedAt) return session;

  const ahora = new Date();
  await AttendanceMark.updateMany(
    { session: session._id, status: null },
    { $set: { status: 'ausente', source: 'preceptor', markedAt: ahora, markedBy: user?._id || null } }
  );

  session.closedAt   = ahora;
  session.closedBy   = user?._id || null;
  session.autoClosed = !!auto;
  await session.save();
  return session;
}

// Cierra las tomas de días anteriores que quedaron abiertas en este alcance. Se llama al
// entrar al panel: cada visita ya es todo el disparador que hace falta (ver shouldAutoClose).
async function autocerrarVencidas(divisionIds, hoy = diaEscolar()) {
  if (!divisionIds?.length) return 0;
  const vencidas = await AttendanceSession.find({
    division: { $in: divisionIds.map(oid) }, closedAt: null, date: { $ne: hoy },
  });
  for (const s of vencidas) await cerrarToma(s, null, { auto: true });
  return vencidas.length;
}

// Marca a UN alumno. Devuelve null si ese alumno no está en la toma (nómina congelada: un
// id que no se creó al abrir no se agrega después).
async function marcar(session, studentId, status, user, note) {
  if (!mongoose.isValidObjectId(studentId)) return null;

  const mark = await AttendanceMark.findOne({ session: session._id, student: studentId });
  if (!mark) return null;

  const corregida = esCorreccion(mark);
  const anterior  = mark.status;

  mark.status   = status;
  mark.source   = 'preceptor';
  mark.markedAt = new Date();
  mark.markedBy = user._id;
  // La nota solo se toca si vino en el body: marcar presente a alguien no puede borrarle
  // en silencio la observación que tenía.
  if (note !== undefined) mark.note = String(note || '').trim().slice(0, NOTE_MAX);
  await mark.save();

  return { mark, anterior, corregida };
}

// Marca a varios de una. Es lo que usan "Marcar presentes a los N" y "El resto, presentes".
// Los ids que no pertenecen a esta toma simplemente no matchean: se ignoran, no rompen.
async function marcarLote(session, studentIds, status, user) {
  const ids = (Array.isArray(studentIds) ? studentIds : [])
    .filter(id => mongoose.isValidObjectId(id));
  if (!ids.length) return 0;

  const res = await AttendanceMark.updateMany(
    { session: session._id, student: { $in: ids.map(oid) } },
    { $set: { status, source: 'preceptor', markedAt: new Date(), markedBy: user._id } }
  );
  return res.modifiedCount || 0;
}

// Las marcas de una toma, ordenadas como la nómina.
async function marcasDeToma(sessionId) {
  const marcas = await AttendanceMark.find({ session: sessionId }).lean();
  return marcas.sort((a, b) =>
    (a.studentName || '').localeCompare(b.studentName || '', 'es', { sensitivity: 'base' }));
}

// Estado de HOY de cada curso del alcance, para las tarjetas del panel.
// Un solo aggregate para toda la pantalla, no una query por tarjeta.
async function estadoDeHoy(divisionIds, hoy = diaEscolar()) {
  if (!divisionIds?.length) return new Map();

  const sesiones = await AttendanceSession.find({
    division: { $in: divisionIds.map(oid) }, date: hoy,
  }).lean();
  if (!sesiones.length) return new Map();

  const conteos = await AttendanceMark.aggregate([
    { $match: { session: { $in: sesiones.map(s => s._id) } } },
    { $group: { _id: { session: '$session', status: '$status' }, n: { $sum: 1 } } },
  ]);

  // Se rearma el mismo objeto que devuelve resumen() para que la tarjeta y la grilla hablen
  // el mismo idioma, en vez de tener dos formas distintas de decir lo mismo.
  const porSesion = new Map();
  for (const s of sesiones) {
    porSesion.set(String(s._id),
      { presentes: 0, tarde: 0, ausentes: 0, justificados: 0, sinMarcar: 0, total: 0 });
  }
  const CLAVE = { presente: 'presentes', tarde: 'tarde', ausente: 'ausentes',
                  justificado: 'justificados' };
  for (const c of conteos) {
    const r = porSesion.get(String(c._id.session));
    if (!r) continue;
    r[CLAVE[c._id.status] || 'sinMarcar'] += c.n;
    r.total += c.n;
  }

  // Clave: la división. Es lo que tiene a mano quien pinta las tarjetas.
  const porDivision = new Map();
  for (const s of sesiones) {
    porDivision.set(String(s.division), { session: s, resumen: porSesion.get(String(s._id)) });
  }
  return porDivision;
}

// ── Autoasistencia del alumno ────────────────────────────────────────────────

// El alumno se marca a SÍ MISMO. No recibe ni el id de otra persona ni un estado: siempre es
// él y siempre es 'presente'. Si llegó tarde, eso lo decide el preceptor.
//
// Dos comportamientos que no son obvios y que sostienen el resto:
//
//   1. IDEMPOTENTE. Doble click, F5 o dos pestañas producen UNA marca, y `selfMarkedAt` no se
//      pisa con la segunda hora: la que vale es la primera vez que dijo estar.
//   2. NO PISA AL PRECEPTOR. Si él ya decidió algo para este alumno, el toque del chico deja
//      constancia de que dice estar presente (queda `selfMarkedAt`, y la grilla lo muestra)
//      pero no cambia el estado. La alternativa —que el alumno revierta la decisión de quien
//      controla la asistencia— convierte el botón en una forma de discutirle al preceptor
//      desde el celular.
async function autoMarcarse(session, user) {
  const mark = await AttendanceMark.findOne({ session: session._id, student: user._id });
  if (!mark) return null;   // no está en la nómina congelada de esta toma

  const ahora           = new Date();
  const yaLaHabiaDado   = !!mark.selfMarkedAt;
  const decidioPreceptor = !!(mark.status && mark.source === 'preceptor');

  if (!yaLaHabiaDado) mark.selfMarkedAt = ahora;
  if (!decidioPreceptor) {
    mark.status   = 'presente';
    mark.source   = 'alumno';
    mark.markedAt = ahora;
    mark.markedBy = null;   // no la puso una persona del equipo: la puso el alumno
  }
  await mark.save();

  return { yaDi: yaLaHabiaDado, estado: mark.status, respetada: !decidioPreceptor };
}

// Las tomas abiertas de HOY en las que este alumno puede marcarse, para el cartel del inicio.
// `divisionIds` llega ya resuelto por quien llama (routes/courses.js lo saca de las materias
// que YA cargó para el dashboard): calcularlo acá sería una query de más en cada visita.
async function tomasAbiertasDelAlumno(user, divisionIds, now = new Date()) {
  if (!divisionIds?.length) return [];

  const sesiones = await AttendanceSession.find({
    division: { $in: divisionIds.map(oid) }, closedAt: null, date: diaEscolar(now),
  }).populate('division', 'name').lean();

  const abiertas = sesiones.filter(s => puedeAutoMarcarse(s, now));
  if (!abiertas.length) return [];

  // Solo se ofrece la toma si el alumno está en su nómina: si se matriculó después de que se
  // abriera, no tiene marca y no puede aparecer de la nada en una lista ya congelada.
  const marcas = await AttendanceMark.find({
    session: { $in: abiertas.map(s => s._id) }, student: user._id,
  }).select('session status selfMarkedAt').lean();
  const porSesion = new Map(marcas.map(m => [String(m.session), m]));

  return abiertas
    .filter(s => porSesion.has(String(s._id)))
    .map(s => {
      const m = porSesion.get(String(s._id));
      return {
        id:           String(s._id),
        curso:        s.division?.name || '—',
        abiertaDesde: live.hora(s.openedAt),
        cierraA:      s.closesAt ? live.hora(s.closesAt) : null,
        yaDi:         !!m.selfMarkedAt,
        estado:       m.status,
      };
    });
}

// ── Sugerencia desde la sala en vivo ─────────────────────────────────────────

// Quiénes están AHORA conectados a una sala en vivo de alguna materia de este curso.
// Devuelve Map<studentId, nombreDeMateria>.
//
// Es SOLO una sugerencia: no escribe ninguna marca (decisión del usuario). Cuando el
// preceptor la acepta, la marca queda con origen 'preceptor', porque la puso él.
//
// El $match arranca por { school, closedAt } porque ESE es el índice que tiene RoomSession.
// Filtrar por `division` sola recorrería la colección entera —una sesión por materia y por
// día, o sea decenas de miles al año— cada 15 segundos y por cada preceptor mirando su grilla.
async function presentesEnSalasDeDivision(division, now = new Date()) {
  const school = division.school?._id || division.school;
  if (!school) return new Map();

  const sesiones = await RoomSession.find({
    school, closedAt: null, division: division._id,
  }).select('_id course').populate('course', 'name').lean();
  if (!sesiones.length) return new Map();

  const cutoff = new Date(now.getTime() - live.ONLINE_WINDOW_MS);
  const presencias = await RoomPresence.find({
    session: { $in: sesiones.map(s => s._id) }, lastPingAt: { $gte: cutoff },
  }).select('user userRole session').lean();

  const materiaDe = new Map(sesiones.map(s => [String(s._id), s.course?.name || '—']));
  const enClase = new Map();
  for (const p of presencias) {
    // La docente y el preceptor también dejan presencia en la sala: no son asistencia.
    if (live.STAFF_ROLES.includes(p.userRole)) continue;
    const id = String(p.user);
    if (!enClase.has(id)) enClase.set(id, materiaDe.get(String(p.session)) || '—');
  }
  return enClase;
}

// ── Historial y reportes ─────────────────────────────────────────────────────

// Todo lo que necesitan la pantalla de historial y los dos CSV, en dos queries.
// Se arma una sola vez y lo consumen las tres salidas: así la planilla que se ve y la que se
// baja no pueden decir números distintos.
async function historialDeDivision(divisionId, desde, hasta) {
  const [sesiones, marcas] = await Promise.all([
    AttendanceSession.find({ division: oid(divisionId), date: { $gte: desde, $lte: hasta } })
      .sort({ date: -1, openedAt: -1 }).lean(),
    AttendanceMark.find({ division: oid(divisionId), date: { $gte: desde, $lte: hasta } }).lean(),
  ]);

  const porSesion = new Map();
  for (const m of marcas) {
    const k = String(m.session);
    if (!porSesion.has(k)) porSesion.set(k, []);
    porSesion.get(k).push(m);
  }

  const dias = sesiones.map(s => ({
    id:       String(s._id),
    fecha:    s.date,
    etiqueta: s.label,
    modo:     s.mode,
    abierta:  !s.closedAt,
    autoCerrada: !!s.autoClosed,
    desdeHora: live.hora(s.openedAt),
    hastaHora: s.closedAt ? live.hora(s.closedAt) : '',
    resumen:  resumen(porSesion.get(String(s._id)) || []),
  }));

  // Una fila por alumno con su estado en cada día. Se agrupa por id y no por nombre: dos
  // chicos pueden llamarse igual, y un mismo chico puede haber cambiado de nombre.
  const alumnos = new Map();
  for (const m of marcas) {
    const id = String(m.student);
    if (!alumnos.has(id)) {
      alumnos.set(id, {
        id, nombre: m.studentName || '—', dni: m.studentDni || '',
        porDia: {}, presentes: 0, tarde: 0, ausentes: 0, justificados: 0,
      });
    }
    const a = alumnos.get(id);
    // El nombre más reciente gana: las marcas vienen de todo el rango.
    if (m.studentName) a.nombre = m.studentName;
    a.porDia[m.date] = m.status;
    if (m.status === 'presente')    a.presentes    += 1;
    if (m.status === 'tarde')       a.tarde        += 1;
    if (m.status === 'ausente')     a.ausentes     += 1;
    if (m.status === 'justificado') a.justificados += 1;
  }

  const filas = [...alumnos.values()]
    .map(a => ({ ...a, porcentaje: porcentajeAsistencia(a) }))
    .sort((x, y) => x.nombre.localeCompare(y.nombre, 'es', { sensitivity: 'base' }));

  return {
    desde, hasta, dias, alumnos: filas,
    // Fechas del rango que TIENEN toma, de la más vieja a la más nueva: son las columnas
    // de la planilla mensual.
    fechas: [...new Set(sesiones.map(s => s.date))].sort(),
  };
}

// ── Export a CSV ─────────────────────────────────────────────────────────────
//
// Se usa el mismo dialecto que los CSV de la sala (punto y coma + BOM): el destino real es
// Excel en español, que con la coma arma una sola columna.

// Planilla de UN día: una fila por alumno de la toma.
function csvAsistenciaDia(marcas) {
  const rows = [['Alumno', 'DNI', 'Estado', 'Hora', 'Quién la puso', 'Observación']];
  for (const m of marcas) {
    rows.push([
      m.studentName || '',
      m.studentDni  || '',
      m.status ? ESTADO_LABELS[m.status] : 'Sin marcar',
      m.markedAt ? live.hora(m.markedAt) : '',
      ORIGEN_LABELS[m.source] || '',
      m.note || '',
    ]);
  }
  return live.csvRows(rows);
}

// Planilla del MES: una fila por alumno, una columna por día con toma, y los totales.
function csvAsistenciaMes(historial) {
  const { fechas, alumnos } = historial;
  const rows = [[
    'Alumno', 'DNI', ...fechas,
    'Presentes', 'Tarde', 'Ausentes', 'Justificados', '% de días que asistió',
  ]];

  for (const a of alumnos) {
    rows.push([
      a.nombre, a.dni,
      ...fechas.map(f => ESTADO_LETRA[a.porDia[f]] || ''),
      a.presentes, a.tarde, a.ausentes, a.justificados,
      // Coma decimal: es lo que espera el Excel en español, igual que el separador.
      String(a.porcentaje).replace('.', ','),
    ]);
  }

  // Referencia al pie, para que la hoja se entienda sin tener que preguntar qué es una "J".
  rows.push([]);
  rows.push(['Referencia: P = presente · T = tarde · A = ausente · J = justificado · vacío = no hubo toma ese día']);
  rows.push(['El porcentaje cuenta la llegada tarde como asistencia. No calcula inasistencias reglamentarias.']);

  return live.csvRows(rows);
}

module.exports = {
  // constantes
  ESTADOS, ESTADO_LABELS, ORIGEN_LABELS, POLL_MS, NOTE_MAX,
  // puras
  diaEscolar, normalizarEstado, resumen, shouldAutoClose, puedeAutoMarcarse, esCorreccion,
  rangoValido, rangoDelMes, porcentajeAsistencia,
  // con base
  rosterDeDivision, abrirToma, cerrarToma, autocerrarVencidas,
  marcar, marcarLote, marcasDeToma, estadoDeHoy,
  autoMarcarse, tomasAbiertasDelAlumno, presentesEnSalasDeDivision, historialDeDivision,
  // export
  csvAsistenciaDia, csvAsistenciaMes,
};
