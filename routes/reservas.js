// Calendario de reservas — /reservas
//
// El lado de QUIEN PIDE: el docente (y el preceptor o el directivo que organiza un acto) ve
// la semana de un recurso, pide un módulo libre y cancela lo suyo. La administración del
// módulo —horario, alta de recursos, aprobación de pedidos— vive en routes/recursos.js.
//
// Están separados a propósito y no por prolijidad: son dos oficios distintos, con dos guardas
// distintas, y mezclarlos repetiría la deuda de routes/rooms.js (~700 líneas mezclando la
// sala con los adjuntos) que el usuario pidió explícitamente no volver a generar.

const express = require('express');

const Recurso = require('../models/Recurso');
const Reserva = require('../models/Reserva');
const Course  = require('../models/Course');

const { requireAuth }    = require('../middleware/auth');
const { requireModulo }  = require('../middleware/modulos');
const { requireSection } = require('../middleware/sections');
const { logAudit }       = require('../middleware/audit');
const { idMalo }         = require('../middleware/objectId');
const { logDeRuta }      = require('../middleware/route-log');

const horarioSvc = require('../services/recursos/horario');
const disp       = require('../services/recursos/disponibilidad');
const reservaSvc = require('../services/recursos/reservas');
const live       = require('../services/liveRoom');

const router = express.Router();

// Los mismos roles que `app_reservas` en config/sections.js. El alumno NO está: reservar la
// sala de computación es una decisión institucional, no algo que se pide desde el banco.
const ROLES_CON_ACCESO = ['teacher', 'preceptor', 'directivo', 'jefe', 'admin', 'superadmin'];

const requireAccesoReservas = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// requireSection y no sectionGuard: esto es UNA solapa del catálogo, no un panel entero.
router.use(requireAuth, requireAccesoReservas, requireModulo('recursos'), requireSection('app_reservas'));

// Quién puede cancelar una reserva: su dueño, o la administración de la escuela. El docente
// no puede tocar la de otro — para eso está la bandeja del administrativo.
const puedeCancelar = (user, reserva) =>
  String(reserva.docente) === String(user._id) || ['admin', 'superadmin'].includes(user.role);

// ─────────────────────────────────────────────────────────────────────────────
// El calendario semanal
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const user   = res.locals.user;
    const school = user.school;
    const hoy    = live.diaEscolar();

    const [recursos, horario] = await Promise.all([
      reservaSvc.recursosDe(school),
      reservaSvc.horarioDe(school),
    ]);

    // Una escuela con el módulo prendido pero sin horario cargado no puede reservar nada. Se
    // dice, en vez de pintar una grilla vacía que parece un error de la pantalla.
    if (!horarioSvc.horarioCargado(horario) || !recursos.length) {
      return res.render('reservas/index', {
        sinConfigurar: true, recursos, horario,
        horarioCargado: horarioSvc.horarioCargado(horario),
        recurso: null, semana: null, grilla: [], misCursos: [],
        REPETICIONES: disp.REPETICIONES, NOMBRE_DIA: horarioSvc.NOMBRE_DIA, hoy,
        diaCorto: disp.diaCorto, diaLargo: disp.diaLargo, diaNum: disp.diaNum,
        puedeDirecto: false, error: null,
      });
    }

    const recurso = recursos.find(r => String(r._id) === String(req.query.recurso)) || recursos[0];

    // La semana que se pinta. Siempre empieza en lunes, para que el docente compare martes
    // con martes; el parámetro se ancla al lunes de su semana aunque llegue cualquier día.
    // Una fecha con cualquier otra forma se ignora y se usa hoy: `?semana=borrame` no puede
    // hacer que lunesDe() haga aritmética sobre NaN y devuelva "NaN-NaN-NaN".
    const crudo = String(req.query.semana || '');
    const lunes = disp.lunesDe(/^\d{4}-\d{2}-\d{2}$/.test(crudo) ? crudo : hoy);
    const dias  = disp.diasDeSemana(lunes, horario.dias || [1, 2, 3, 4, 5]);

    const reservas = await Reserva.find({
      recurso: recurso._id,
      date: { $in: dias.map(d => d.date) },
      status: { $in: ['pendiente', 'confirmada'] },
    }).populate('docente', 'name').populate('course', 'name').lean();

    // Índice por casillero, para no recorrer el array entero por cada celda de la grilla
    // (7 módulos × 5 días × 2 turnos = 70 celdas).
    const porCasillero = new Map();
    for (const r of reservas) {
      const k = `${r.date}|${r.turno}|${r.modulo}`;
      if (!porCasillero.has(k)) porCasillero.set(k, []);
      porCasillero.get(k).push(r);
    }

    // La grilla: un bloque por turno, una fila por franja (recreos incluidos), una celda por
    // día. Se arma acá y no en la vista para que el .ejs solo pinte.
    const grilla = (horario.turnos || []).map(turno => ({
      turno,
      filas: disp.filasDeTurno(turno).map(franja => ({
        franja,
        celdas: franja.tipo === 'recreo' ? [] : dias.map(d => {
          const enCelda = porCasillero.get(`${d.date}|${turno.id}|${franja.orden}`) || [];
          const estado  = disp.estadoCelda({ recurso, reservas: enCelda, userId: user._id });
          return {
            ...estado,
            date: d.date,
            pasado: disp.esPasado(d.date, hoy),
            esHoy:  d.date === hoy,
            maxPedible: disp.maximoPedible(recurso, estado),
          };
        }),
      })),
    }));

    // Para autocompletar el pedido: las materias que dicta este usuario. Que el formulario
    // salga precargado es lo que convierte el pedido en un clic en vez de un trámite.
    const misCursos = await Course.find({
      school, $or: [{ owner: user._id }, { coTeachers: user._id }],
    }).select('name division').populate('division', 'name').sort({ name: 1 }).lean();

    res.render('reservas/index', {
      sinConfigurar: false,
      recursos, recurso, horario, grilla, dias, misCursos, hoy,
      horarioCargado: true,
      semana: { lunes, anterior: disp.sumarDias(lunes, -7), siguiente: disp.sumarDias(lunes, 7) },
      REPETICIONES: disp.REPETICIONES,
      NOMBRE_DIA: horarioSvc.NOMBRE_DIA,
      // Fechas de calendario: se formatean en UTC. Ver disponibilidad.js — `fmt` las correría
      // un día, porque interpreta 'YYYY-MM-DD' como medianoche UTC y la muestra en Argentina.
      diaCorto: disp.diaCorto, diaLargo: disp.diaLargo, diaNum: disp.diaNum,
      puedeDirecto: await reservaSvc.puedeReservarDirecto(recurso, user._id),
      error: req.query.error || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudo cargar el calendario de reservas');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pedir
// ─────────────────────────────────────────────────────────────────────────────

router.post('/pedir', async (req, res) => {
  try {
    const user   = res.locals.user;
    const school = res.locals.school;

    const recurso = await Recurso.findOne({
      _id: req.body.recurso, school: user.school, activo: true,
    }).lean();
    if (!recurso) return res.status(404).json({ error: 'Ese recurso no existe.' });

    const horario = await reservaSvc.horarioDe(user.school);
    if (!horarioSvc.horarioCargado(horario)) {
      return res.status(400).json({ error: 'La escuela todavía no cargó el horario.' });
    }

    // El tope de lo que se puede PEDIR se revalida acá: el `max` de un <input> se edita con
    // el inspector en dos segundos, y el formulario no es una guarda.
    if (recurso.divisible) {
      const tope = recurso.maxPorPedido || recurso.capacidad;
      const u = Math.trunc(Number(req.body.unidades));
      if (!Number.isInteger(u) || u < 1 || u > tope) {
        return res.status(400).json({ error: `Podés pedir entre 1 y ${tope}.` });
      }
    }

    // La materia tiene que ser suya: si no, el pedido diría que la clase es de otro.
    let course = null, division = null;
    if (req.body.course) {
      const c = await Course.findOne({
        _id: req.body.course, school: user.school,
        $or: [{ owner: user._id }, { coTeachers: user._id }],
      }).select('_id division').lean();
      if (!c) return res.status(400).json({ error: 'Esa materia no es tuya.' });
      course = c._id; division = c.division;
    }

    const { creadas, omitidas, error } = await reservaSvc.pedir({
      req, school, recurso, docente: user, horario,
      turno: req.body.turno, modulo: req.body.modulo,
      desde: req.body.fecha, repeticion: req.body.repeticion || 'unica', hasta: req.body.hasta || null,
      unidades: req.body.unidades, course, division,
      motivo: String(req.body.motivo || '').trim().slice(0, 300),
      hoy: live.diaEscolar(),
    });
    if (error) return res.status(400).json({ error });

    // Los pedidos NO se auditan uno por uno (ver config/audit-actions.js): en una escuela con
    // repetición semanal son cientos por cuatrimestre y taparían la pantalla de auditoría.
    // Quién pidió y cuándo ya vive en la propia Reserva.
    const confirmadas = creadas.filter(r => r.status === 'confirmada').length;
    res.json({
      ok: true,
      creadas: creadas.length,
      confirmadas,
      pendientes: creadas.length - confirmadas,
      omitidas,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo registrar el pedido' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Mis reservas
// ─────────────────────────────────────────────────────────────────────────────

router.get('/mias', async (req, res) => {
  try {
    const user = res.locals.user;
    const hoy  = live.diaEscolar();

    const [horario, reservas] = await Promise.all([
      reservaSvc.horarioDe(user.school),
      Reserva.find({ docente: user._id, date: { $gte: disp.sumarDias(hoy, -30) } })
        .populate('recurso', 'name tipo divisible')
        .populate('course', 'name')
        .sort({ date: 1, turno: 1, modulo: 1 })
        .lean(),
    ]);

    res.render('reservas/mias', {
      reservas, hoy,
      diaCorto: disp.diaCorto,
      fmtModulo: (turno, modulo) => {
        const f = horarioSvc.moduloDe(horario, turno, modulo);
        return f ? `${f.label} (${f.desde}-${f.hasta})` : `Módulo ${modulo}`;
      },
      nombreTurno: (id) => horarioSvc.turnoDe(horario, id)?.label || id,
      error: req.query.error || null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('No se pudieron cargar tus reservas');
  }
});

// Cancelar. Devuelve el cupo si estaba confirmada — liberar() se encarga, y es el único
// camino por el que se cancela, justamente para que ese descuento no dependa de acordarse.
router.post('/:id/cancelar', async (req, res) => {
  if (idMalo(req, res, 'Reserva no encontrada')) return;
  try {
    const user    = res.locals.user;
    const reserva = await Reserva.findOne({ _id: req.params.id, school: user.school });
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (!puedeCancelar(user, reserva)) return res.status(403).json({ error: 'No es tu reserva.' });
    if (!['pendiente', 'confirmada'].includes(reserva.status)) {
      return res.status(400).json({ error: 'Esa reserva ya no está activa.' });
    }

    // Cancelar el pasado no rompe nada, pero tampoco significa nada: la clase ya fue.
    if (disp.esPasado(reserva.date, live.diaEscolar())) {
      return res.status(400).json({ error: 'Esa fecha ya pasó.' });
    }

    // "Cancelar toda la serie": el docente que reservó 30 martes y se queda sin proyecto no
    // tiene que cancelar 30 veces. Solo hacia adelante — lo ya usado no se toca.
    const serie = req.body.serie === 'si' && reserva.serie;
    const objetivo = serie
      ? await Reserva.find({
        serie: reserva.serie, docente: reserva.docente,
        status: { $in: ['pendiente', 'confirmada'] }, date: { $gte: live.diaEscolar() },
      })
      : [reserva];

    for (const r of objetivo) {
      await reservaSvc.liberar(r, { status: 'cancelada', porUsuario: user._id });
    }

    logAudit(req, 'booking.cancel', [{ type: 'recurso', id: reserva.recurso, name: '' }],
      { fecha: reserva.date, turno: reserva.turno, modulo: reserva.modulo, cantidad: objetivo.length });

    res.json({ ok: true, canceladas: objetivo.length });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo cancelar' });
  }
});

module.exports = router;
