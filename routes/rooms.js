// Sala en vivo de una materia: presencia de los que están conectados + chat de la clase.
// Ver specs/sala-en-vivo.spec.md.
//
// Se monta en /courses (antes que routes/courses.js) y todas sus rutas cuelgan de
// /courses/:id/sala. No colisiona con el GET /courses/:id de aquel router —un path de un
// solo segmento no matchea— pero se monta primero para que el orden sea explícito.
//
// NOTA DE CARGA: el poll de esta ruta corre cada 4 segundos por cada persona que esté en una
// sala. Todo lo que se agregue acá adentro se multiplica por 25 alumnos. Las rutas de la sala
// están exceptuadas del generalLimiter en server.js (ver el comentario largo allá) y tienen
// su propio límite por usuario para la escritura.

const express  = require('express');
const mongoose = require('mongoose');

const Course       = require('../models/Course');
const RoomSession  = require('../models/RoomSession');
const RoomMessage  = require('../models/RoomMessage');
const RoomPresence = require('../models/RoomPresence');

const { requireAuth }        = require('../middleware/auth');
const { logAudit }           = require('../middleware/audit');
const { roomMessageLimiter } = require('../middleware/rate-limits');
const { loadPreceptorScope } = require('../middleware/preceptor');
const live = require('../services/liveRoom');

const router = express.Router();

// Roles que entran a mirar SIN aparecer en la sala. Solo el equipo directivo, y solo si no
// son además docentes de esa materia (en ese caso entran como docentes, visibles).
// El preceptor NO está acá a propósito: su ingreso es siempre visible (ver el comentario de
// resolverModo).
const OBSERVER_ROLES = ['directivo', 'admin', 'superadmin'];

// ── Helpers de respuesta ─────────────────────────────────────────────────────

// El usuario autenticado. Vive en res.locals (lo pone middleware/auth.js), no en req.
const usuario = (req) => req.res.locals.user;

// Mismo criterio que middleware/sections.js: la sala es toda fetch(), así que un rechazo
// tiene que llegar como JSON cuando se lo pide por JSON, y como texto cuando es una navegación.
function fallar(req, res, status, mensaje) {
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: mensaje });
  }
  return res.status(status).send(mensaje);
}

// ── Carga del curso y resolución de permisos ─────────────────────────────────

// Resuelve el alcance del preceptor SOLO cuando hace falta. loadPreceptorScope consulta
// todas las divisiones de la escuela para los roles sin límite, y esto corre en cada poll:
// llamarlo para un alumno sería una query de más cada 4 segundos, por alumno.
function scopeSiEsPreceptor(req, res, next) {
  if (res.locals.user?.role !== 'preceptor') {
    req.scopeDivisionIds = [];
    return next();
  }
  return loadPreceptorScope(req, res, next);
}

// Carga el curso de :id y decide si este usuario puede estar en su sala.
// Deja en req: course, esAlumno, esGestor (puede abrir/cerrar/moderar), modo.
async function cargarSala(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return fallar(req, res, 404, 'Curso no encontrado');
    }

    // El select tiene que traer school y division además de owner/coTeachers: canManage y
    // canWatchLive los necesitan, y sin ellos el chequeo falla por omisión (ver Course.js).
    const course = await Course.findById(req.params.id)
      .populate('students', 'name avatar dni')
      .populate('division', 'name')
      .populate('owner', 'name');
    if (!course) return fallar(req, res, 404, 'Curso no encontrado');

    // Mismo orden que la solapa Personas (routes/courses.js): los nombres se cargan como
    // "APELLIDO, Nombre", así que ordenar por el string completo alcanza.
    course.students.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));

    const user      = res.locals.user;
    const esAlumno  = course.students.some(s => s._id.toString() === req.userId);
    const esGestor  = course.canManage(user);
    const puedeVer  = esAlumno || course.canWatchLive(user, req.scopeDivisionIds || []);

    if (!puedeVer) return fallar(req, res, 403, 'Acceso denegado');

    req.course   = course;
    req.esAlumno = esAlumno;
    req.esGestor = esGestor;
    next();
  } catch (err) {
    next(err);
  }
}

// ¿Este usuario puede pedir el modo observación?
// EL MODO LO DECIDE EL ROL, NO LA URL. `?modo=observacion` solo tiene efecto para el equipo
// directivo; para cualquier otro rol se ignora. Si el parámetro por sí solo habilitara el
// modo silencioso, cualquiera que lo descubriera podría espiar sin aparecer — y el preceptor,
// cuyo ingreso tiene que verse (es quien controla la asistencia: su trabajo es que se note
// que está mirando), podría esconderse escribiéndolo a mano.
function puedeObservar(req) {
  if (req.esAlumno || req.esGestor) return false;
  return OBSERVER_ROLES.includes(usuario(req).role);
}

// Resuelve el modo REAL y lo deja en req.modo. Setea 'observacion' cuando el usuario es del
// equipo directivo y todavía no dejó rastro en la sala.
//
// El criterio es la PRESENCIA en la base, no el query param. Derivar el modo de la URL era un
// agujero: el POST de un mensaje no lleva `?modo=observacion`, así que el mismo directivo que
// estaba mirando en silencio pasaba a contar como visible y podía escribir — quedando
// "presente" para el curso sin haberse presentado nunca. La presencia, en cambio, es la misma
// para todas las rutas y es exactamente lo que crea el botón "Presentarme".
//
// Efecto secundario buscado: quien ya se presentó no puede volver a esconderse en esa sesión
// aunque agregue el parámetro a mano. Ya lo vieron; ocultarlo después sería peor.
async function aplicarModo(req, session) {
  req.modo = 'visible';
  if (!session || !puedeObservar(req)) return req.modo;
  const presente = await RoomPresence.exists({ session: session._id, user: usuario(req)._id });
  if (!presente) req.modo = 'observacion';
  return req.modo;
}

// ── Sesión actual ────────────────────────────────────────────────────────────

// Devuelve la sesión abierta de la materia, aplicando el autocierre por inactividad.
//
// El autocierre se evalúa acá, de forma perezosa, y no con un setInterval: PM2 corre dos
// workers, así que un timer se ejecutaría dos veces y sería otra forma de que la app se pise
// a sí misma en cluster. Cada poll ya pasa por acá, que es todo el disparador que hace falta.
async function sesionAbierta(courseId) {
  const session = await RoomSession.findOne({ course: courseId, closedAt: null });
  if (!session) return null;
  if (live.shouldAutoClose(session)) {
    await live.closeSession(session, null, { auto: true });
    return null;
  }
  return session;
}

// ¿Este usuario puede escribir en esta sesión, ahora?
function puedeEscribir(session, req) {
  if (!session || session.closedAt) return false;
  if (req.modo === 'observacion') return false;   // mirar sin aparecer implica no hablar
  if (req.esGestor) return true;                  // la docente escribe siempre
  if (!req.esAlumno) return true;                 // preceptoría y dirección presentada
  if (!session.settings.studentsCanWrite) return false;
  return !(session.mutedStudents || []).some(id => id.toString() === req.userId);
}

// Payload que consume la vista. Es la ÚNICA forma de la sala: la usan el render inicial y el
// poll, para que no puedan divergir.
async function estadoDeSala(req, session, since = 0) {
  const course = req.course;

  if (!session) {
    return {
      estado: 'cerrada', sessionId: null, seq: 0, puedoEscribir: false,
      mensajes: [], settings: { studentsCanWrite: true, reactionsOn: true },
      presencia: { presentes: 0, total: course.students.length, conectados: [], ausentes: [] },
    };
  }

  // since = 0 (primera carga) trae los últimos 100 y no la conversación entera: una clase
  // larga puede tener cientos de mensajes y nadie sube a leer el principio.
  const query = { session: session._id };
  let mensajes;
  if (since > 0) {
    mensajes = await RoomMessage.find({ ...query, seq: { $gt: since } }).sort({ seq: 1 });
  } else {
    mensajes = (await RoomMessage.find(query).sort({ seq: -1 }).limit(100)).reverse();
  }

  const presences = await RoomPresence.find({ session: session._id }).lean();
  const presencia = live.presenceSummary(presences, course.students);

  return {
    estado:    'abierta',
    sessionId: String(session._id),
    seq:       session.lastSeq,
    puedoEscribir: puedeEscribir(session, req),
    settings:  session.settings,
    presencia,
    mensajes:  mensajes.map(m => serializarMensaje(m, req.userId)),
  };
}

function serializarMensaje(m, userId) {
  const borrado = !!m.deletedAt;
  return {
    id:    String(m._id),
    seq:   m.seq,
    kind:  m.kind,
    autor: m.kind === 'system' ? '' : (m.authorName || '—'),
    rol:   m.authorRole || '',
    esMio: String(m.author) === String(userId),
    // El texto original se conserva en la base (es lo que permite reconstruir qué pasó si
    // hubo un problema), pero NO se manda al cliente una vez borrado.
    texto:   borrado ? 'Mensaje eliminado' : m.text,
    borrado,
    hora:    m.createdAt,
    reacciones: (m.reactions || []).map(r => ({
      emoji: r.emoji,
      n:     r.users.length,
      mia:   r.users.some(u => String(u) === String(userId)),
    })),
  };
}

router.use('/:id/sala', requireAuth, scopeSiEsPreceptor, cargarSala);

// ── Vista ────────────────────────────────────────────────────────────────────

// GET /courses/:id/sala — la sala como página propia.
// Existe además de la solapa de la materia porque dirección y preceptoría NO tienen acceso a
// GET /courses/:id (y no deben tenerlo): entran acá, que renderiza el mismo partial.
router.get('/:id/sala', async (req, res, next) => {
  try {
    const session = await sesionAbierta(req.course._id);
    await aplicarModo(req, session);

    // Ingreso del personal a una sala abierta.
    if (session && !req.esAlumno && !req.esGestor) {
      // El parámetro solo decide para quien PODRÍA observar y todavía no se hizo ver: si ya
      // tiene presencia, aplicarModo ya devolvió 'visible' y acá no se esconde.
      const quiereObservar = req.query.modo === 'observacion' && req.modo === 'observacion';
      if (quiereObservar) {
        // No toca la presencia ni anuncia nada: para la clase, nadie entró. Queda el registro
        // de auditoría, que es el único lugar donde consta.
        logAudit(req, 'room.observe',
          [{ type: 'course', id: req.course._id, name: req.course.name }],
          { sessionId: String(session._id), docente: req.course.owner?.name || '' });
      } else {
        await anunciarIngreso(req, session);
        req.modo = 'visible';
      }
    }

    const estado = await estadoDeSala(req, session);
    res.render('rooms/standalone', {
      course: req.course,
      sala:   estado,
      modo:   req.modo,
      esGestor: req.esGestor,
      esAlumno: req.esAlumno,
      emojis: live.EMOJIS,
      pollMs: live.POLL_MS,
    });
  } catch (err) { next(err); }
});

// Marca la presencia del personal (preceptoría, o dirección que se presentó) y lo anuncia una
// sola vez. El `creada` de touchPresence es lo que evita que cada F5 meta otro aviso.
async function anunciarIngreso(req, session) {
  const { creada } = await live.touchPresence(session, usuario(req));
  if (creada) {
    const quien = usuario(req);
    const rol   = live.ROLE_LABELS[quien.role] || 'el equipo de la escuela';
    await live.systemMessage(session, `${quien.name}, de ${rol.toLowerCase()}, ingresó a la sala.`);
    logAudit(req, 'room.join_staff',
      [{ type: 'course', id: req.course._id, name: req.course.name }],
      { sessionId: String(session._id) });
  }
}

// ── Poll ─────────────────────────────────────────────────────────────────────

// GET /courses/:id/sala/poll?since=N — el latido de la sala.
// Es la ruta más caliente de la feature: corre cada 4 s por cada persona conectada.
router.get('/:id/sala/poll', async (req, res, next) => {
  try {
    const session = await sesionAbierta(req.course._id);
    const since   = Math.max(0, parseInt(req.query.since, 10) || 0);
    await aplicarModo(req, session);

    // La presencia se registra en el poll, no en el render: así el que deja la pestaña
    // abierta sigue contando como presente y el que la cierra desaparece solo.
    // En observación NO se registra: es lo que hace que dirección no aparezca.
    if (session && req.modo !== 'observacion') {
      await live.touchPresence(session, usuario(req));
    }

    res.json(await estadoDeSala(req, session, since));
  } catch (err) { next(err); }
});

// ── Abrir / cerrar ───────────────────────────────────────────────────────────

router.post('/:id/sala/abrir', async (req, res, next) => {
  try {
    if (!req.esGestor) return fallar(req, res, 403, 'Solo la o el docente puede hacer esto');

    const { session, creada } = await live.openSession(req.course, usuario(req), req.body.title);
    if (creada) {
      logAudit(req, 'room.open',
        [{ type: 'course', id: req.course._id, name: req.course.name }],
        { sessionId: String(session._id) });
    }
    res.json({ ok: true, sessionId: String(session._id), creada });
  } catch (err) { next(err); }
});

router.post('/:id/sala/cerrar', async (req, res, next) => {
  try {
    if (!req.esGestor) return fallar(req, res, 403, 'Solo la o el docente puede hacer esto');

    const session = await sesionAbierta(req.course._id);
    if (!session) return res.json({ ok: true, yaCerrada: true });

    await live.closeSession(session, usuario(req));
    logAudit(req, 'room.close',
      [{ type: 'course', id: req.course._id, name: req.course.name }],
      { sessionId: String(session._id) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Mensajes ─────────────────────────────────────────────────────────────────

router.post('/:id/sala/mensajes', roomMessageLimiter, async (req, res, next) => {
  try {
    const session = await sesionAbierta(req.course._id);
    if (!session) return fallar(req, res, 409, 'La sala está cerrada');
    // El modo se resuelve acá también, y no solo al renderizar: este POST no lleva el
    // parámetro de la URL, y sin esto quien estaba observando en silencio podía escribir.
    await aplicarModo(req, session);
    if (!puedeEscribir(session, req)) return fallar(req, res, 403, 'No podés escribir en esta sala');

    const msg = await live.postMessage(session, usuario(req), req.body.text);
    if (!msg) return fallar(req, res, 400, 'El mensaje está vacío');

    res.json({ ok: true, mensaje: serializarMensaje(msg, req.userId) });
  } catch (err) { next(err); }
});

router.delete('/:id/sala/mensajes/:mid', async (req, res, next) => {
  try {
    if (!req.esGestor) return fallar(req, res, 403, 'Solo la o el docente puede hacer esto');
    if (!mongoose.isValidObjectId(req.params.mid)) {
      return fallar(req, res, 404, 'Mensaje no encontrado');
    }

    // El texto NO se borra: se marca. Ver models/RoomMessage.js.
    const msg = await RoomMessage.findOneAndUpdate(
      { _id: req.params.mid, course: req.course._id, deletedAt: null },
      { $set: { deletedAt: new Date(), deletedBy: usuario(req)._id } },
      { new: true }
    );
    if (!msg) return fallar(req, res, 404, 'Mensaje no encontrado');

    logAudit(req, 'room.delete_message',
      [{ type: 'course', id: req.course._id, name: req.course.name }],
      { sessionId: String(msg.session), autor: msg.authorName, seq: msg.seq });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/sala/mensajes/:mid/reaccion', async (req, res, next) => {
  try {
    const emoji = String(req.body.emoji || '');
    if (!live.EMOJIS.includes(emoji)) return fallar(req, res, 400, 'Emoji no válido');
    if (!mongoose.isValidObjectId(req.params.mid)) {
      return fallar(req, res, 404, 'Mensaje no encontrado');
    }

    const session = await sesionAbierta(req.course._id);
    if (!session) return fallar(req, res, 409, 'La sala está cerrada');
    if (!session.settings.reactionsOn) return fallar(req, res, 403, 'Las reacciones están desactivadas');
    await aplicarModo(req, session);
    if (req.modo === 'observacion') return fallar(req, res, 403, 'No podés reaccionar en esta sala');

    const msg = await RoomMessage.findOne({ _id: req.params.mid, session: session._id });
    if (!msg) return fallar(req, res, 404, 'Mensaje no encontrado');

    // Toggle: la segunda pulsada del mismo emoji saca la reacción en vez de duplicarla.
    const r = msg.reactions.find(x => x.emoji === emoji);
    if (!r) {
      msg.reactions.push({ emoji, users: [usuario(req)._id] });
    } else {
      const i = r.users.findIndex(u => String(u) === req.userId);
      if (i >= 0) r.users.splice(i, 1); else r.users.push(usuario(req)._id);
      if (r.users.length === 0) msg.reactions = msg.reactions.filter(x => x.emoji !== emoji);
    }
    await msg.save();

    res.json({ ok: true, mensaje: serializarMensaje(msg, req.userId) });
  } catch (err) { next(err); }
});

// ── Moderación y configuración ───────────────────────────────────────────────

router.post('/:id/sala/config', async (req, res, next) => {
  try {
    if (!req.esGestor) return fallar(req, res, 403, 'Solo la o el docente puede hacer esto');
    const session = await sesionAbierta(req.course._id);
    if (!session) return fallar(req, res, 409, 'La sala está cerrada');

    if (req.body.studentsCanWrite !== undefined) {
      session.settings.studentsCanWrite = req.body.studentsCanWrite === true
                                       || req.body.studentsCanWrite === 'true';
    }
    if (req.body.reactionsOn !== undefined) {
      session.settings.reactionsOn = req.body.reactionsOn === true
                                  || req.body.reactionsOn === 'true';
    }
    await session.save();
    await live.systemMessage(session, session.settings.studentsCanWrite
      ? 'La docente habilitó la palabra para el curso.'
      : 'La docente puso la sala en modo "solo docente".');

    res.json({ ok: true, settings: session.settings });
  } catch (err) { next(err); }
});

router.post('/:id/sala/silenciar/:uid', async (req, res, next) => {
  try {
    if (!req.esGestor) return fallar(req, res, 403, 'Solo la o el docente puede hacer esto');
    if (!mongoose.isValidObjectId(req.params.uid)) {
      return fallar(req, res, 404, 'Alumno no encontrado');
    }
    const session = await sesionAbierta(req.course._id);
    if (!session) return fallar(req, res, 409, 'La sala está cerrada');

    const alumno = req.course.students.find(s => s._id.toString() === req.params.uid);
    if (!alumno) return fallar(req, res, 404, 'Alumno no encontrado');

    const mutear = req.body.muted === true || req.body.muted === 'true';
    if (mutear) {
      await RoomSession.updateOne({ _id: session._id }, { $addToSet: { mutedStudents: alumno._id } });
    } else {
      await RoomSession.updateOne({ _id: session._id }, { $pull: { mutedStudents: alumno._id } });
    }

    logAudit(req, 'room.mute',
      [{ type: 'course', id: req.course._id, name: req.course.name },
       { type: 'user',   id: alumno._id,     name: alumno.name }],
      { sessionId: String(session._id), silenciado: mutear });

    res.json({ ok: true, muted: mutear });
  } catch (err) { next(err); }
});

// ── Presentarse (solo dirección, saliendo del modo observación) ──────────────

router.post('/:id/sala/presentarme', async (req, res, next) => {
  try {
    if (!OBSERVER_ROLES.includes(usuario(req).role) || req.esAlumno) {
      return fallar(req, res, 403, 'Acceso denegado');
    }
    const session = await sesionAbierta(req.course._id);
    if (!session) return fallar(req, res, 409, 'La sala está cerrada');

    await anunciarIngreso(req, session);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Historial de clases ──────────────────────────────────────────────────────

// GET /courses/:id/sala/clases — listado de clases anteriores.
// Va ANTES de cualquier ruta con :sid para que "clases" no se lea como un id.
router.get('/:id/sala/clases', async (req, res, next) => {
  try {
    const sesiones = await RoomSession.find({ course: req.course._id })
      .sort({ openedAt: -1 }).limit(60).lean();

    // Presentes de cada sesión, en una sola query en vez de una por clase.
    const ids   = sesiones.map(s => s._id);
    const pres  = await RoomPresence.find({ session: { $in: ids } })
      .select('session userRole').lean();
    const porSesion = new Map();
    for (const p of pres) {
      if (live.STAFF_ROLES.includes(p.userRole)) continue;
      const k = String(p.session);
      porSesion.set(k, (porSesion.get(k) || 0) + 1);
    }

    res.render('rooms/clases', {
      course: req.course,
      total:  req.course.students.length,
      sesiones: sesiones.map(s => ({
        ...s,
        presentes: porSesion.get(String(s._id)) || 0,
        enVivo:    !s.closedAt,
      })),
    });
  } catch (err) { next(err); }
});

// Carga una sesión de ESTA materia. El chequeo de pertenencia no es decorativo: sin él,
// cambiar el id en la barra de direcciones dejaría leer la clase de otra división.
async function cargarSesion(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.sid)) {
    return fallar(req, res, 404, 'Clase no encontrada');
  }
  const session = await RoomSession.findOne({ _id: req.params.sid, course: req.course._id });
  if (!session) return fallar(req, res, 404, 'Clase no encontrada');
  req.session_ = session;
  next();
}

// GET /courses/:id/sala/clases/:sid — transcripción + asistencia de una clase.
router.get('/:id/sala/clases/:sid', cargarSesion, async (req, res, next) => {
  try {
    const [mensajes, presences] = await Promise.all([
      RoomMessage.find({ session: req.session_._id }).sort({ seq: 1 }).lean(),
      RoomPresence.find({ session: req.session_._id }).lean(),
    ]);

    const porUser = new Map(presences.map(p => [String(p.user), p]));
    const asistencia = req.course.students.map(a => {
      const p = porUser.get(String(a._id));
      return {
        nombre:  a.name,
        presente: !!p,
        desde:   p ? p.firstSeenAt : null,
        minutos: p ? live.minutosPresente(p) : 0,
      };
    });

    res.render('rooms/session', {
      course:  req.course,
      sesion:  req.session_,
      mensajes,
      asistencia,
      presentes: asistencia.filter(a => a.presente).length,
      // Una clase purgada conserva su asistencia pero ya no su conversación (3 meses,
      // cleanup-rooms.js). Distinguir "no hay mensajes" de "los mensajes ya no están" evita
      // que la pantalla parezca rota.
      purgada: mensajes.length === 0
               && !!req.session_.closedAt
               && (Date.now() - new Date(req.session_.closedAt).getTime()) > live.PURGE_AFTER_MS,
    });
  } catch (err) { next(err); }
});

// GET /courses/:id/sala/clases/:sid/export?tipo=asistencia|transcripcion
router.get('/:id/sala/clases/:sid/export', cargarSesion, async (req, res, next) => {
  try {
    const tipo  = req.query.tipo === 'transcripcion' ? 'transcripcion' : 'asistencia';
    const fecha = new Date(req.session_.openedAt).toISOString().slice(0, 10);
    const slug  = req.course.name.replace(/[^\w]+/g, '-').toLowerCase();

    let csv;
    if (tipo === 'transcripcion') {
      const mensajes = await RoomMessage.find({ session: req.session_._id }).sort({ seq: 1 }).lean();
      csv = live.csvTranscripcion(mensajes);
    } else {
      const presences = await RoomPresence.find({ session: req.session_._id }).lean();
      csv = live.csvAsistencia(req.course.students, presences);
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${tipo}-${slug}-${fecha}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

module.exports = router;
