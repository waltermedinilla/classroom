// Lógica de la sala en vivo de una materia: presencia, mensajes y el resumen que consumen
// los paneles de dirección y preceptoría.
//
// Todas las constantes de la feature viven ACÁ, con su fundamento al lado. Si alguna vez hay
// que aflojar el polling o cambiar la retención, se toca este archivo y nada más.
//
// La primera mitad son funciones PURAS (reciben `now`, no leen el reloj ni la base): son las
// que se testean en tests/unit/liveRoom.test.js. La segunda mitad toca Mongo.

const mongoose = require('mongoose');

const RoomSession  = require('../models/RoomSession');
const RoomMessage  = require('../models/RoomMessage');
const RoomPresence = require('../models/RoomPresence');

// ── Constantes ───────────────────────────────────────────────────────────────

// Cada cuánto pollea quien está DENTRO de la sala. 4 s es el equilibrio entre que la
// conversación se sienta viva y no fabricar tráfico: con 30 personas son ~7 req/s, dos
// queries indexadas cada una.
const POLL_MS = 4000;

// Cada cuánto se repintan las tarjetas de los paneles de supervisión. Mucho más lento a
// propósito: mirar qué clases hay en curso es supervisión, no conversación.
const DIRECTIVO_POLL_MS = 15000;

// "Conectado ahora". Son ~3 ciclos de poll: tolera una pestaña trabada o un WiFi que hipa
// sin sacar al chico de la lista de presentes.
const ONLINE_WINDOW_MS = 45 * 1000;

// Autocierre por inactividad. Cubre el caso real de la docente que se olvida la sala abierta
// al terminar la clase, sin cortar una clase larga por la mitad.
const AUTO_CLOSE_MS = 3 * 60 * 60 * 1000;

// Antigüedad a partir de la cual cleanup-rooms.js puede purgar los MENSAJES de una sesión
// cerrada. La presencia (la asistencia) no se purga nunca. Decisión del usuario: 3 meses
// cubre un trimestre completo y mantiene la colección chica.
const PURGE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

const MSG_MAX     = 500;   // caracteres por mensaje
const MSG_PER_MIN = 10;    // mensajes por usuario por minuto

// Paleta cerrada de emojis del selector. Cerrada a propósito: valida la entrada del POST de
// reacciones sin tener que razonar sobre unicode arbitrario, y mantiene el selector de un
// tamaño usable en un celular.
const EMOJIS = ['👋', '👍', '✋', '❓', '😀', '🎉', '✅', '😕', '❤️', '😮', '🙏', '👏'];

// Roles que, estando en la sala, no son "alumnos presentes" sino personal.
const STAFF_ROLES = ['teacher', 'admin', 'superadmin', 'directivo', 'preceptor', 'jefe', 'soe'];

// ── Hora de la sala ──────────────────────────────────────────────────────────

// Zona horaria de la escuela. TODAS las horas de la sala se arman acá, en el servidor y con
// esta zona fija: ni el reloj del navegador ni el del servidor deciden qué hora se muestra.
//
// El bug que esto arregla: la hora de cada mensaje la formateaba el navegador con
// toLocaleTimeString(), es decir con la zona horaria del equipo. Las máquinas del aula tienen
// cualquier zona configurada, así que el MISMO mensaje se veía a una hora distinta en cada
// pantalla. Y el servidor de producción corre en UTC, con lo cual las vistas que ya se
// renderizaban del lado del servidor (clases anteriores, transcripción, CSV) mostraban tres
// horas de más. Una sola fuente de hora resuelve las dos mitades del problema.
const TZ = process.env.SCHOOL_TZ || 'America/Argentina/Buenos_Aires';

// Los formatters se construyen UNA sola vez. Intl.DateTimeFormat es caro de instanciar y esto
// corre por cada mensaje de cada poll: 100 mensajes × 30 personas cada 4 segundos.
const opts = (o) => new Intl.DateTimeFormat('es-AR', { timeZone: TZ, ...o });
// hourCycle h23 y no hour12:false — con hour12 algunos locales imprimen "24:15" a medianoche.
const F_HORA   = opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const F_DIA    = opts({ weekday: 'long', day: 'numeric', month: 'long' });
const F_LARGA  = opts({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const F_CORTA  = opts({ day: '2-digit', month: '2-digit', year: 'numeric' });
const F_FECHAH = opts({ day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

// Día escolar 'YYYY-MM-DD' en la zona de la escuela. A diferencia de los de arriba, este no
// es un texto de pantalla: es la CLAVE con la que se archiva la asistencia
// (models/AttendanceSession.js) y parte de su índice único. Vive acá, y no en
// services/attendance.js, porque la zona horaria de la escuela tiene que tener un solo dueño
// —un segundo Intl.DateTimeFormat en otro archivo es exactamente cómo vuelve el bug de las
// tres horas de más—. Con toISOString(), que es UTC, una toma abierta a las 21:30 de Buenos
// Aires quedaría fechada al día siguiente.
//
// Se arma con formatToParts y no con un locale que casualmente imprime ISO (en-CA): el
// formato de un locale puede cambiar con la versión de ICU, y esto es una clave de base de
// datos, no un texto.
const F_ISO = opts({ year: 'numeric', month: '2-digit', day: '2-digit' });
function diaEscolar(d = new Date()) {
  const partes = Object.fromEntries(F_ISO.formatToParts(d).map(p => [p.type, p.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}

// Una fecha nula o basura devuelve '' en vez de "Invalid Date": estos textos van directo a la
// pantalla y a los CSV.
function formatear(f, d) {
  if (!d) return '';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : f.format(t);
}

const hora       = (d) => formatear(F_HORA, d);    // 14:05
const fechaDia   = (d) => formatear(F_DIA, d);     // jueves, 6 de agosto
const fechaLarga = (d) => formatear(F_LARGA, d);   // jueves, 6 de agosto de 2026
const fechaCorta = (d) => formatear(F_CORTA, d);   // 06/08/2026
const fechaHora  = (d) => formatear(F_FECHAH, d);  // 06/08/2026, 14:05:00

// Se pasa entero a las vistas como `fmt` (ver routes/rooms.js): así ninguna plantilla vuelve a
// llamar a toLocaleTimeString por su cuenta.
const fmt = { TZ, hora, fechaDia, fechaLarga, fechaCorta, fechaHora };

// Etiqueta que acompaña al círculo de quien no es alumno.
const ROLE_LABELS = {
  teacher:    'Docente',
  admin:      'Administración',
  superadmin: 'Administración',
  directivo:  'Dirección',
  preceptor:  'Preceptoría',
  jefe:       'Jefatura',
  soe:        'Orientación',
};

// ── Funciones puras ──────────────────────────────────────────────────────────

// ¿El último ping entra en la ventana de "conectado ahora"?
// El borde es INCLUSIVO: exactamente 45 s todavía cuenta como presente. Con la comparación
// estricta, un ping que llega justo en el límite sacaría al alumno de la lista por un
// milisegundo de diferencia de reloj.
function isOnline(lastPingAt, now = new Date()) {
  if (!lastPingAt) return false;
  const t = new Date(lastPingAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= ONLINE_WINDOW_MS;
}

const initial = (name) => (String(name || '—').trim().charAt(0) || '—').toUpperCase();

// Arma el resumen de presencia que consume la vista.
//   presences: documentos de RoomPresence de la sesión (lean u objetos con las mismas claves)
//   roster:    alumnos matriculados en la materia [{ _id, name, avatar }] — el universo del
//              "N de M". Puede venir vacío (materia sin alumnos): eso NO es un error.
//
// `presentes` cuenta SOLO alumnos: si el docente sumara, "18 de 25" pasaría a decir 19 sin
// que haya un chico más en la clase. El personal aparece igual en `conectados`, primero y
// con su etiqueta, porque ver quién está a cargo es justamente el punto de la pantalla.
function presenceSummary(presences = [], roster = [], now = new Date()) {
  const onlineById = new Map();
  for (const p of presences) {
    if (isOnline(p.lastPingAt, now)) onlineById.set(String(p.user), p);
  }

  const conectados = [];
  const ausentes   = [];

  // Personal primero, en el orden en que llegó.
  const staff = [...onlineById.values()]
    .filter(p => STAFF_ROLES.includes(p.userRole))
    .sort((a, b) => new Date(a.firstSeenAt) - new Date(b.firstSeenAt));
  for (const p of staff) {
    conectados.push({
      id:      String(p.user),
      nombre:  p.userName || '—',
      inicial: initial(p.userName),
      avatar:  null,
      rol:     p.userRole,
      etiqueta: ROLE_LABELS[p.userRole] || '',
    });
  }

  // Después los alumnos, en el orden del roster (alfabético, como llega de la ruta).
  let presentes = 0;
  for (const alumno of roster) {
    const id = String(alumno._id);
    const p  = onlineById.get(id);
    if (p) {
      presentes += 1;
      conectados.push({
        id,
        nombre:  alumno.name,
        inicial: initial(alumno.name),
        avatar:  alumno.avatar || null,
        rol:     'student',
        etiqueta: '',
      });
    } else {
      ausentes.push({ id, nombre: alumno.name, inicial: initial(alumno.name) });
    }
  }

  return { presentes, total: roster.length, conectados, ausentes };
}

// ¿Esta sesión quedó abierta y sin actividad más allá del límite?
// Solo aplica a sesiones ABIERTAS: una ya cerrada nunca vuelve a evaluarse.
function shouldAutoClose(session, now = new Date()) {
  if (!session || session.closedAt) return false;
  const last = new Date(session.lastActivityAt || session.openedAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > AUTO_CLOSE_MS;
}

// Normaliza el texto de un mensaje antes de guardarlo.
// No escapa HTML: eso lo hace la vista con <%= %>, que es el único lugar donde el escapado
// es correcto. Guardar el texto ya escapado rompería el export a CSV y la búsqueda.
function sanitizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')       // normaliza saltos de Windows
    .replace(/\n{3,}/g, '\n\n')    // colapsa cascadas de Enter a un renglón en blanco
    .trim()
    .slice(0, MSG_MAX);
}

// Minutos estimados de permanencia. pings × POLL_MS, no lastPingAt − firstSeenAt (ver el
// comentario de models/RoomPresence.js).
function minutosPresente(presence) {
  const ms = (presence?.pings || 0) * POLL_MS;
  return Math.max(1, Math.round(ms / 60000));
}

// ── Funciones con base de datos ──────────────────────────────────────────────

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// Abre la sala de una materia. IDEMPOTENTE: si ya hay una sesión abierta devuelve esa misma.
// Dos docentes de la misma materia tocando "Abrir" a la vez es un caso real, no teórico.
async function openSession(course, user, title = '') {
  const abierta = await RoomSession.findOne({ course: course._id, closedAt: null });
  if (abierta) return { session: abierta, creada: false };

  const session = await RoomSession.create({
    course:   course._id,
    school:   course.school?._id || course.school,
    division: course.division?._id || course.division,
    openedBy: user._id,
    title:    String(title || '').trim().slice(0, 80),
  });

  await systemMessage(session, `${user.name} abrió la sala.`);
  return { session, creada: true };
}

// Cierra la sala. `auto` distingue el cierre por inactividad del que hace una persona.
async function closeSession(session, user = null, { auto = false } = {}) {
  if (session.closedAt) return session;

  await systemMessage(
    session,
    auto ? 'La sala se cerró automáticamente por inactividad.'
         : `${user?.name || 'La docente'} cerró la sala.`
  );

  session.closedAt   = new Date();
  session.closedBy   = user?._id || null;
  session.autoClosed = !!auto;
  await session.save();
  return session;
}

// Asigna el `seq` siguiente de la sesión de forma ATÓMICA y crea el mensaje.
// El $inc es lo que hace que esto sea seguro con los dos workers de PM2 en cluster: dos
// mensajes simultáneos reciben números distintos y consecutivos, sin coordinación entre
// procesos y sin que ninguno se pierda del cursor.
async function nextSeq(sessionId) {
  const s = await RoomSession.findByIdAndUpdate(
    sessionId,
    { $inc: { lastSeq: 1 }, $set: { lastActivityAt: new Date() } },
    { new: true, select: 'lastSeq' }
  );
  return s ? s.lastSeq : null;
}

async function postMessage(session, user, text) {
  const limpio = sanitizeText(text);
  if (!limpio) return null;

  const seq = await nextSeq(session._id);
  if (seq === null) return null;

  return RoomMessage.create({
    session:    session._id,
    course:     session.course,
    author:     user._id,
    authorName: user.name,
    authorRole: user.role,
    kind:       'text',
    text:       limpio,
    seq,
  });
}

// Mensaje automático de la propia sala (abrió, cerró, entró preceptoría). Se guarda como un
// mensaje más para que la transcripción se lea en orden con un solo cursor.
async function systemMessage(session, text) {
  const seq = await nextSeq(session._id);
  if (seq === null) return null;
  return RoomMessage.create({
    session: session._id,
    course:  session.course,
    author:  session.openedBy,
    authorName: '',
    authorRole: 'system',
    kind:    'system',
    text:    sanitizeText(text),
    seq,
  });
}

// Registra (o refresca) la presencia de alguien en la sala.
// $setOnInsert en firstSeenAt: una reconexión no puede pisar el primer ingreso. $inc en
// pings: es de donde sale el tiempo estimado de permanencia.
// Devuelve { creada } para que la ruta sepa si tiene que anunciar el ingreso — sin eso, cada
// F5 del preceptor metería otro "ingresó a la sala" en el chat.
async function touchPresence(session, user) {
  const antes = await RoomPresence.findOne({ session: session._id, user: user._id }).select('_id');
  await RoomPresence.updateOne(
    { session: session._id, user: user._id },
    {
      $setOnInsert: { course: session.course, firstSeenAt: new Date() },
      $set:         { lastPingAt: new Date(), userName: user.name, userRole: user.role },
      $inc:         { pings: 1 },
    },
    { upsert: true }
  );
  await RoomSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date() } });
  return { creada: !antes };
}

// Tarjetas de "clases en curso" para los paneles de supervisión.
// UN solo aggregate para toda la pantalla, no una query por tarjeta.
//   divisionIds: undefined = toda la escuela (dirección). Un array = solo esas divisiones
//   (preceptoría). Un array VACÍO significa "ninguna", nunca "todas": es la regla fail-closed
//   del alcance del preceptor (ver models/User.js y middleware/preceptor.js).
async function getOpenSessions(schoolId, { divisionIds = undefined, now = new Date() } = {}) {
  if (!schoolId) return [];
  if (Array.isArray(divisionIds) && divisionIds.length === 0) return [];

  const match = { school: oid(schoolId), closedAt: null };
  if (Array.isArray(divisionIds)) match.division = { $in: divisionIds.map(oid) };

  const cutoff = new Date(now.getTime() - ONLINE_WINDOW_MS);

  const rows = await RoomSession.aggregate([
    { $match: match },
    { $sort:  { openedAt: 1 } },
    { $lookup: { from: 'courses',   localField: 'course',   foreignField: '_id', as: 'curso' } },
    { $unwind: '$curso' },
    { $lookup: { from: 'divisions', localField: 'division', foreignField: '_id', as: 'div' } },
    { $lookup: { from: 'users',     localField: 'curso.owner', foreignField: '_id', as: 'doc' } },
    // Presentes ahora: se cuentan en el pipeline del $lookup para no traer los documentos.
    { $lookup: {
        from: 'roompresences',
        let:  { s: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$session', '$$s'] }, lastPingAt: { $gte: cutoff } } },
          { $sort:  { firstSeenAt: 1 } },
          { $project: { user: 1, userName: 1, userRole: 1 } },
        ],
        as: 'presentes',
    } },
    { $lookup: {
        from: 'roommessages',
        let:  { s: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$session', '$$s'] }, kind: 'text' } },
          { $group: { _id: null, n: { $sum: 1 }, ultimo: { $max: '$createdAt' } } },
        ],
        as: 'msgs',
    } },
  ]);

  return rows.map((r) => {
    const alumnos  = (r.curso.students || []).length;
    const presStud = r.presentes.filter(p => !STAFF_ROLES.includes(p.userRole));
    const msg      = r.msgs[0] || { n: 0, ultimo: null };
    return {
      sessionId: String(r._id),
      courseId:  String(r.curso._id),
      materia:   r.curso.name,
      division:  r.div[0]?.name || '—',
      docente:   r.doc[0]?.name || 'Sin docente',
      aula:      r.curso.room || '',
      titulo:    r.title || '',
      desdeMin:  Math.max(0, Math.round((now - new Date(r.openedAt)) / 60000)),
      presentes: presStud.length,
      total:     alumnos,
      mensajes:  msg.n,
      ultimoMensajeHace: msg.ultimo
        ? Math.max(0, Math.round((now - new Date(msg.ultimo)) / 1000))
        : null,
      // Iniciales para los circulitos de la tarjeta. Se usan las del snapshot de presencia
      // en vez de hacer otro $lookup a users: en una tarjeta de resumen, la inicial alcanza.
      avatares: presStud.slice(0, 4).map(p => ({ inicial: initial(p.userName) })),
    };
  });
}

// Sesiones cerradas HOY, para el pie de los paneles de supervisión.
async function getTodayClosed(schoolId, { divisionIds = undefined, now = new Date() } = {}) {
  if (!schoolId) return [];
  if (Array.isArray(divisionIds) && divisionIds.length === 0) return [];

  const desde = new Date(now); desde.setHours(0, 0, 0, 0);
  const match = { school: oid(schoolId), closedAt: { $gte: desde } };
  if (Array.isArray(divisionIds)) match.division = { $in: divisionIds.map(oid) };

  const rows = await RoomSession.aggregate([
    { $match: match },
    { $sort:  { closedAt: -1 } },
    { $limit: 12 },
    { $lookup: { from: 'courses',   localField: 'course',   foreignField: '_id', as: 'curso' } },
    { $unwind: '$curso' },
    { $lookup: { from: 'divisions', localField: 'division', foreignField: '_id', as: 'div' } },
    { $lookup: {
        from: 'roompresences',
        let:  { s: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$session', '$$s'] } } },
          { $project: { userRole: 1 } },
        ],
        as: 'pres',
    } },
  ]);

  return rows.map(r => ({
    sessionId: String(r._id),
    courseId:  String(r.curso._id),
    materia:   r.curso.name,
    division:  r.div[0]?.name || '—',
    desde:     r.openedAt,
    hasta:     r.closedAt,
    // Ya formateadas por el servidor: la tarjeta del panel las imprime tal cual.
    desdeHora: hora(r.openedAt),
    hastaHora: hora(r.closedAt),
    presentes: r.pres.filter(p => !STAFF_ROLES.includes(p.userRole)).length,
    total:     (r.curso.students || []).length,
  }));
}

// ── Export a CSV ─────────────────────────────────────────────────────────────

// Escapa una celda de CSV. Punto y coma como separador y BOM al principio del archivo porque
// el destino real es Excel en español, que con la coma arma una sola columna.
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRows = (rows) => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');

// Fecha y hora del CSV: también en la zona de la escuela. Un export que dijera la hora en UTC
// serviría para lo contrario de lo que se pide (saber a qué hora entró cada chico a clase).
const fecha = fechaHora;

// CSV de asistencia: una fila por alumno del curso, haya entrado o no.
function csvAsistencia(roster, presences) {
  const byUser = new Map(presences.map(p => [String(p.user), p]));
  const rows = [['Alumno', 'DNI', 'Estado', 'Primer ingreso', 'Último registro', 'Minutos estimados']];
  for (const a of roster) {
    const p = byUser.get(String(a._id));
    rows.push([
      a.name,
      a.dni || '',
      p ? 'Presente' : 'Ausente',
      p ? fecha(p.firstSeenAt) : '',
      p ? fecha(p.lastPingAt)  : '',
      p ? minutosPresente(p)   : 0,
    ]);
  }
  return csvRows(rows);
}

// CSV de transcripción. Los eliminados se incluyen marcados como tales: una transcripción
// con huecos silenciosos no sirve para lo único para lo que se pide.
function csvTranscripcion(messages) {
  const rows = [['#', 'Hora', 'Autor', 'Rol', 'Mensaje', 'Estado']];
  for (const m of messages) {
    rows.push([
      m.seq,
      fecha(m.createdAt),
      m.kind === 'system' ? '(sistema)' : (m.authorName || '—'),
      m.kind === 'system' ? '' : (m.authorRole || ''),
      m.text,
      m.deletedAt ? 'Eliminado' : '',
    ]);
  }
  return csvRows(rows);
}

module.exports = {
  // constantes
  POLL_MS, DIRECTIVO_POLL_MS, ONLINE_WINDOW_MS, AUTO_CLOSE_MS, PURGE_AFTER_MS,
  MSG_MAX, MSG_PER_MIN, EMOJIS, STAFF_ROLES, ROLE_LABELS, TZ,
  // hora (zona fija de la escuela)
  fmt, hora, fechaDia, fechaLarga, fechaCorta, fechaHora, diaEscolar,
  // puras
  isOnline, presenceSummary, shouldAutoClose, sanitizeText, minutosPresente, initial,
  // con base
  openSession, closeSession, postMessage, systemMessage, touchPresence,
  getOpenSessions, getTodayClosed,
  // export
  csvAsistencia, csvTranscripcion,
  // El "dialecto" de CSV del proyecto (punto y coma + BOM, para el Excel en español). Se
  // exporta para que services/attendance.js arme sus planillas con el MISMO, en vez de
  // redefinir el separador y volver a discutir por qué un export abre en una sola columna.
  csvCell, csvRows,
};
