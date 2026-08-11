// Asistencia de preceptoría — /preceptor/asistencia
//
// El preceptor toma la asistencia del DÍA de cada curso a su cargo, de dos maneras:
//   - pase de lista: abre, marca los 25 nombres y cierra;
//   - ventana abierta: la deja abierta y la va completando (en la Fase B, los alumnos se
//     marcan solos desde su pantalla).
//
// Ver specs/asistencia-preceptoria.spec.md.
//
// La regla que sostiene todo este archivo: el alcance se chequea EN EL SERVIDOR en cada
// request. Toda ruta con :divisionId pasa por inScope(), y toda ruta con un id de toma
// verifica además que la división de esa toma esté en el alcance — validar solo el id de la
// toma dejaría leer la asistencia del curso de al lado escribiendo el número en la URL.

const express  = require('express');
const mongoose = require('mongoose');

const Division          = require('../models/Division');
const Course            = require('../models/Course');
const AttendanceSession = require('../models/AttendanceSession');

const { requireAuth } = require('../middleware/auth');
const { requirePreceptor, loadPreceptorScope, inScope } = require('../middleware/preceptor');
const { sectionGuard } = require('../middleware/sections');
const { logAudit } = require('../middleware/audit');
const { attendanceCheckinLimiter } = require('../middleware/rate-limits');

const asistencia = require('../services/attendance');
const live       = require('../services/liveRoom');

const router = express.Router();

// Misma cadena que routes/preceptor.js:40, y en el mismo orden: sectionGuard va ANTES de
// loadPreceptorScope para no pagar la query de divisiones en un request que va a terminar
// en 403. A diferencia del dashboard, esta sección SÍ se puede apagar por escuela.
router.use(requireAuth, requirePreceptor, sectionGuard('preceptor'), loadPreceptorScope);

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// Mismo criterio que routes/rooms.js:42 y middleware/sections.js: la grilla es toda fetch(),
// así que un rechazo llega como JSON cuando se lo pide por JSON y como texto cuando es una
// navegación.
function fallar(req, res, status, mensaje) {
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: mensaje });
  }
  return res.status(status).send(mensaje);
}

// ── Carga y guardas ──────────────────────────────────────────────────────────

// Carga la división de :divisionId validando el alcance.
async function cargarDivision(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.divisionId)) {
      return fallar(req, res, 404, 'Curso no encontrado');
    }
    if (!inScope(req, req.params.divisionId)) {
      return fallar(req, res, 403, 'Acceso denegado');
    }
    const division = await Division.findById(req.params.divisionId).select('_id name school');
    if (!division) return fallar(req, res, 404, 'Curso no encontrado');

    req.division = division;
    next();
  } catch (err) { next(err); }
}

// Carga la toma de :id, valida que su división esté en el alcance y aplica el autocierre por
// cambio de día. El autocierre se evalúa acá, de forma perezosa, y no con un setInterval:
// PM2 corre dos workers y un timer se ejecutaría dos veces (mismo criterio que la sala).
async function cargarToma(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return fallar(req, res, 404, 'Toma de asistencia no encontrada');
    }
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return fallar(req, res, 404, 'Toma de asistencia no encontrada');

    // La guarda que importa: la toma es de un curso que este preceptor tiene a cargo.
    if (!inScope(req, session.division)) return fallar(req, res, 403, 'Acceso denegado');

    if (asistencia.shouldAutoClose(session)) {
      await asistencia.cerrarToma(session, null, { auto: true });
    }

    const division = await Division.findById(session.division).select('_id name school');
    if (!division) return fallar(req, res, 404, 'Curso no encontrado');

    req.toma     = session;
    req.division = division;
    next();
  } catch (err) { next(err); }
}

// Payload de la grilla. Es la ÚNICA forma de la toma: la usan el render inicial y el poll,
// para que no puedan divergir.
async function estadoDeToma(session, division) {
  const marcas = await asistencia.marcasDeToma(session._id);

  // Sugerencia de la sala en vivo: los que todavía no están marcados pero están conectados
  // AHORA a una clase de este curso. Solo con la toma abierta — en una planilla cerrada no
  // hay nada que sugerir, y sería una query por poll al pedo.
  let enClase = [];
  if (!session.closedAt) {
    const enSala = await asistencia.presentesEnSalasDeDivision(division);
    if (enSala.size) {
      // Se sugiere a todo el que NO figura asistiendo (ni presente ni tarde) y está en una
      // clase en vivo ahora mismo. Incluye a los que el preceptor marcó ausente: ese es el
      // caso más útil de todos —"marcaste ausente a Juan y está en Matemática en este
      // momento"—, no ruido. Filtrando solo por "sin marcar", después del primer cierre la
      // sugerencia no volvía a mostrar a nadie nunca.
      const YA_ASISTE = ['presente', 'tarde'];
      enClase = marcas
        .filter(m => !YA_ASISTE.includes(m.status) && enSala.has(String(m.student)))
        .map(m => ({
          studentId: String(m.student),
          nombre:    m.studentName || '—',
          materia:   enSala.get(String(m.student)),
        }));
    }
  }

  return {
    tomaId: String(session._id),
    estado: session.closedAt ? 'cerrada' : 'abierta',
    modo:   session.mode,
    pasadas: session.pasadas || 1,
    autoasistencia: session.settings?.selfCheckin === true,
    // Ya formateadas por el servidor, con la zona de la escuela: la vista las imprime tal
    // cual. Ver el comentario de TZ en services/liveRoom.js.
    abiertaDesde: live.hora(session.openedAt),
    cierraA:      session.closesAt ? live.hora(session.closesAt) : null,
    cerradaA:     session.closedAt ? live.hora(session.closedAt) : null,
    autoCerrada:  !!session.autoClosed,
    resumen: asistencia.resumen(marcas),
    marcas: marcas.map(m => ({
      studentId: String(m.student),
      nombre:    m.studentName || '—',
      estado:    m.status,
      origen:    m.source,
      hora:      m.markedAt ? live.hora(m.markedAt) : '',
      seMarcoSolo: !!m.selfMarkedAt,
      nota:      m.note || '',
    })),
    // Alumnos sin marcar que están AHORA en una sala en vivo de este curso. Es una
    // SUGERENCIA: la sala nunca marca sola (decisión del usuario).
    enClase,
  };
}

// ── Panel: una tarjeta por curso ─────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  if (!res.locals.user.school) return res.render('preceptor/no-scope', { motivo: 'sin-escuela' });
  if (!req.scopeDivisionIds.length) return res.render('preceptor/no-scope', { motivo: 'sin-cursos' });

  try {
    // Primero se cierran las tomas que quedaron abiertas de días anteriores: entrar al panel
    // es todo el disparador que hace falta.
    await asistencia.autocerrarVencidas(req.scopeDivisionIds);

    const [divisiones, hoyPorDivision] = await Promise.all([
      Division.find({ _id: { $in: req.scopeDivisionIds.map(oid) } })
        .sort({ name: 1 }).select('_id name').lean(),
      asistencia.estadoDeHoy(req.scopeDivisionIds),
    ]);

    const cursos = divisiones.map(d => {
      const hoy = hoyPorDivision.get(String(d._id));
      return {
        _id:  String(d._id),
        name: d.name,
        toma: hoy ? {
          id:      String(hoy.session._id),
          estado:  hoy.session.closedAt ? 'cerrada' : 'abierta',
          modo:    hoy.session.mode,
          resumen: hoy.resumen,
          hora:    live.hora(hoy.session.closedAt || hoy.session.openedAt),
          // Cuántas veces se pasó lista sobre esta misma planilla.
          pasadas: hoy.session.pasadas || 1,
        } : null,
      };
    });

    res.render('preceptor/asistencia', {
      cursos,
      fecha: live.fechaLarga(new Date()),
      scopeAll: res.locals.scopeAll,
      activePage: 'asistencia',
    });
  } catch (err) { next(err); }
});

// ── Abrir la toma del día ────────────────────────────────────────────────────

router.post('/:divisionId/abrir', cargarDivision, async (req, res, next) => {
  try {
    const opciones = {
      mode:        req.body.mode,
      selfCheckin: req.body.selfCheckin,
      // Minutos, no una hora absoluta: ver el comentario en services/attendance.js.
      closesInMin: req.body.closesInMin,
    };
    const { session, creada } = await asistencia.abrirToma(req.division, res.locals.user, opciones);

    // Ya se tomó lista hoy en este curso. NO se crea una segunda planilla: el preceptor pasa
    // lista varias veces en el día y al final queda UNA sola (decisión del usuario). Si la
    // había cerrado, esto es una pasada nueva; si sigue abierta, simplemente se sigue en ella
    // —que es lo que pasa cuando entran dos preceptores del mismo curso—.
    let pasadaNueva = false;
    if (!creada && session.closedAt) {
      await asistencia.nuevaPasada(session, res.locals.user, opciones);
      pasadaNueva = true;
    }

    if (creada) {
      logAudit(req, 'attendance.open',
        [{ type: 'division', id: req.division._id, name: req.division.name }],
        { tomaId: String(session._id), modo: session.mode,
          autoasistencia: session.settings?.selfCheckin === true,
          alumnos: session.rosterSize });
    } else if (pasadaNueva) {
      logAudit(req, 'attendance.reopen',
        [{ type: 'division', id: req.division._id, name: req.division.name }],
        { tomaId: String(session._id), pasada: session.pasadas, modo: session.mode });
    }

    res.json({ ok: true, tomaId: String(session._id), creada, pasadaNueva,
               pasadas: session.pasadas || 1 });
  } catch (err) { next(err); }
});

// ── La grilla del curso ──────────────────────────────────────────────────────

// Abre la toma de HOY de este curso. Si no hay ninguna, vuelve al panel: abrir es un acto
// explícito y no puede pasar por navegar a una URL.
router.get('/:divisionId', cargarDivision, async (req, res, next) => {
  try {
    await asistencia.autocerrarVencidas([String(req.division._id)]);

    const session = await AttendanceSession.findOne({
      division: req.division._id, date: asistencia.diaEscolar(),
    });

    if (!session) return res.redirect('/preceptor/asistencia');

    res.render('preceptor/asistencia-toma', {
      division: req.division,
      toma:     await estadoDeToma(session, req.division),
      estados:  asistencia.ESTADOS,
      estadoLabels: asistencia.ESTADO_LABELS,
      fecha:    live.fechaLarga(session.openedAt),
      pollMs:   asistencia.POLL_MS,
      activePage: 'asistencia',
    });
  } catch (err) { next(err); }
});

router.get('/toma/:id/poll', cargarToma, async (req, res, next) => {
  try {
    res.json(await estadoDeToma(req.toma, req.division));
  } catch (err) { next(err); }
});

// ── Marcar ───────────────────────────────────────────────────────────────────

router.post('/toma/:id/marcar', cargarToma, async (req, res, next) => {
  try {
    if (req.toma.closedAt) return fallar(req, res, 409, 'La toma de asistencia está cerrada');

    const estado = asistencia.normalizarEstado(req.body.status);
    if (!estado) return fallar(req, res, 400, 'Estado de asistencia no válido');

    const r = await asistencia.marcar(
      req.toma, req.body.studentId, estado, res.locals.user, req.body.note);
    if (!r) return fallar(req, res, 404, 'Alumno no encontrado');

    // Solo se audita pisar una marca que YA tenía estado. El pase de lista normal son 30
    // marcas por curso y por día: auditarlas todas ahogaría /admin/audit y no agregaría nada,
    // porque quién marcó y cuándo ya vive en la marca misma.
    if (r.corregida) {
      logAudit(req, 'attendance.change',
        [{ type: 'division', id: req.division._id, name: req.division.name },
         { type: 'user',     id: r.mark.student,   name: r.mark.studentName }],
        { tomaId: String(req.toma._id), de: r.anterior, a: estado });
    }

    // La hora vuelve YA FORMATEADA con la zona de la escuela para que la fila se actualice
    // sola, sin tener que pedir el poll entero después de cada click.
    res.json({ ok: true, estado, corregida: r.corregida, hora: live.hora(r.mark.markedAt) });
  } catch (err) { next(err); }
});

router.post('/toma/:id/marcar-lote', cargarToma, async (req, res, next) => {
  try {
    if (req.toma.closedAt) return fallar(req, res, 409, 'La toma de asistencia está cerrada');

    const estado = asistencia.normalizarEstado(req.body.status);
    if (!estado) return fallar(req, res, 400, 'Estado de asistencia no válido');

    const n = await asistencia.marcarLote(
      req.toma, req.body.studentIds, estado, res.locals.user);
    res.json({ ok: true, marcados: n });
  } catch (err) { next(err); }
});

// ── Cerrar ───────────────────────────────────────────────────────────────────

router.post('/toma/:id/cerrar', cargarToma, async (req, res, next) => {
  try {
    if (req.toma.closedAt) return res.json({ ok: true, yaCerrada: true });

    await asistencia.cerrarToma(req.toma, res.locals.user);
    const marcas = await asistencia.marcasDeToma(req.toma._id);
    const r = asistencia.resumen(marcas);

    logAudit(req, 'attendance.close',
      [{ type: 'division', id: req.division._id, name: req.division.name }],
      { tomaId: String(req.toma._id), ...r });

    res.json({ ok: true, resumen: r });
  } catch (err) { next(err); }
});

// Reabre la toma de HOY para corregir algo (el que llegó 8:40 con la planilla ya cerrada).
//
// Solo la de hoy, y no es una limitación arbitraria: una toma de ayer se vuelve a cerrar sola
// en el request siguiente (shouldAutoClose), así que "reabrirla" duraría hasta el próximo
// click y sería peor que no ofrecerlo. Corregir días anteriores va con el historial.
//
// Las marcas NO se tocan: las que el cierre puso en 'ausente' siguen ahí. Reabrir devuelve la
// planilla al estado editable, no la borra.
router.post('/toma/:id/reabrir', cargarToma, async (req, res, next) => {
  try {
    if (!req.toma.closedAt) return res.json({ ok: true, yaAbierta: true });
    if (req.toma.date !== asistencia.diaEscolar()) {
      return fallar(req, res, 409, 'Solo se puede reabrir la toma de asistencia de hoy');
    }

    // Reabrir desde la grilla es otra pasada sobre la misma planilla, igual que "Pasar lista
    // otra vez" desde el panel: mismo servicio, para que no puedan divergir. Sin opciones, así
    // conserva el modo que ya tenía.
    await asistencia.nuevaPasada(req.toma, res.locals.user);

    logAudit(req, 'attendance.reopen',
      [{ type: 'division', id: req.division._id, name: req.division.name }],
      { tomaId: String(req.toma._id), pasada: req.toma.pasadas });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Historial del curso ──────────────────────────────────────────────────────

// Resuelve el rango pedido, o el del mes en curso. Devuelve null si vino mal escrito: con
// eso quien llama corta con 400 en vez de disparar una consulta sin límites contra la
// colección más grande del sistema.
function rangoDeLaQuery(req) {
  if (!req.query.desde && !req.query.hasta) return asistencia.rangoDelMes();
  return asistencia.rangoValido(req.query.desde, req.query.hasta);
}

router.get('/:divisionId/historial', cargarDivision, async (req, res, next) => {
  try {
    const rango = rangoDeLaQuery(req);
    if (!rango) return fallar(req, res, 400, 'El rango de fechas no es válido');

    const historial = await asistencia.historialDeDivision(
      req.division._id, rango.desde, rango.hasta);

    res.render('preceptor/asistencia-historial', {
      division: req.division,
      historial,
      hoy: asistencia.diaEscolar(),
      activePage: 'asistencia',
    });
  } catch (err) { next(err); }
});

// GET /preceptor/asistencia/:divisionId/export?tipo=dia|mes
//   tipo=dia  → ?fecha=YYYY-MM-DD (y opcionalmente ?tomaId=), una fila por alumno
//   tipo=mes  → ?desde=&hasta=,    una fila por alumno y una columna por día
router.get('/:divisionId/export', cargarDivision, async (req, res, next) => {
  try {
    const tipo = req.query.tipo === 'mes' ? 'mes' : 'dia';
    // Los nombres de curso terminan en símbolo ("3° 2°"), así que además de reemplazar hay
    // que recortar los guiones de las puntas: si no, el archivo sale "asistencia-3-2--fecha".
    const slug = req.division.name.replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

    let csv, nombre;
    if (tipo === 'mes') {
      const rango = rangoDeLaQuery(req);
      if (!rango) return fallar(req, res, 400, 'El rango de fechas no es válido');

      const historial = await asistencia.historialDeDivision(
        req.division._id, rango.desde, rango.hasta);
      csv    = asistencia.csvAsistenciaMes(historial);
      nombre = `asistencia-${slug}-${rango.desde}-a-${rango.hasta}.csv`;
    } else {
      const fecha = asistencia.rangoValido(req.query.fecha, req.query.fecha);
      if (!fecha) return fallar(req, res, 400, 'El rango de fechas no es válido');

      // Una sola planilla por curso y por día (índice único de AttendanceSession), así que
      // no hay que elegir entre varias.
      const toma = await AttendanceSession.findOne({
        division: req.division._id, date: fecha.desde,
      }).select('_id').lean();
      if (!toma) return fallar(req, res, 404, 'Toma de asistencia no encontrada');

      csv    = asistencia.csvAsistenciaDia(await asistencia.marcasDeToma(toma._id));
      nombre = `asistencia-${slug}-${fecha.desde}.csv`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// ── Rutas del alumno ─────────────────────────────────────────────────────────
//
// Van en un router aparte, montado en /asistencia: el alumno no pasa por requirePreceptor ni
// por el alcance por divisiones. Las dos rutas validan por su cuenta que quien llama sea
// alumno y que esté en la nómina de esa toma.

const alumnoRouter = express.Router();
alumnoRouter.use(requireAuth);

// GET /asistencia/abierta — lo que consume el cartel del inicio.
// Devuelve un ARRAY y no una toma suelta: un alumno puede cursar en más de una división
// (repitentes con materias de dos años). En la práctica trae una sola.
alumnoRouter.get('/abierta', async (req, res, next) => {
  try {
    if (res.locals.user.role !== 'student') return res.json({ tomas: [] });

    const divisionIds = await Course.distinct('division', { students: req.userId });
    res.json({
      tomas: await asistencia.tomasAbiertasDelAlumno(res.locals.user, divisionIds),
    });
  } catch (err) { next(err); }
});

// POST /asistencia/:id/presente — el botón "Dar asistencia".
//
// El BODY SE IGNORA POR COMPLETO. No lleva ni a quién marcar ni con qué estado: el alumno se
// marca a sí mismo y siempre como presente. Si mandara `studentId` de un compañero o
// `status: 'justificado'`, no tendría ningún efecto — es la puerta que hay que dejar cerrada.
alumnoRouter.post('/:id/presente', attendanceCheckinLimiter, async (req, res, next) => {
  try {
    if (res.locals.user.role !== 'student') {
      return fallar(req, res, 403, 'Acceso denegado');
    }
    if (!mongoose.isValidObjectId(req.params.id)) {
      return fallar(req, res, 404, 'Toma de asistencia no encontrada');
    }

    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return fallar(req, res, 404, 'Toma de asistencia no encontrada');

    // Mismo autocierre perezoso que en el panel: sin esto, una ventana olvidada el viernes
    // seguiría aceptando asistencias el lunes.
    if (asistencia.shouldAutoClose(session)) {
      await asistencia.cerrarToma(session, null, { auto: true });
    }
    if (!asistencia.puedeAutoMarcarse(session)) {
      return fallar(req, res, 409, 'Este curso no tiene la asistencia abierta para alumnos');
    }

    // Estar en la nómina congelada ES la prueba de que cursa en esa división: las marcas se
    // crearon al abrir la toma, a partir de los alumnos de las materias de ese curso.
    const r = await asistencia.autoMarcarse(session, res.locals.user);
    if (!r) return fallar(req, res, 403, 'No figurás en la lista de este curso');

    res.json({
      ok: true, yaDi: r.yaDi, estado: r.estado,
      // false = el preceptor ya había decidido otra cosa y su decisión manda. Queda
      // registrado que el alumno dijo estar, y él lo ve en la grilla.
      respetada: r.respetada,
    });
  } catch (err) { next(err); }
});

module.exports = { panelRouter: router, alumnoRouter };
