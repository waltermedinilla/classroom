// Panel del Jefe de Taller — F1 (specs/jefe-de-taller.spec.md).
//
//   GET  /taller           Resumen del día: los MEP con su "Docentes del día" (el mismo servicio
//                          que la Secretaria, RN-F1-3) y la asistencia de las divisiones.
//   GET  /taller/jefes     Qué subió cada Jefe de Sección y cada MEP a su cargo (P1).
//   GET  /taller/materias  Marcar qué materias son de taller (D2).
//   POST /taller/materias
//
// Las actividades y los docentes son las pantallas de /jefatura con el modo 'por-taller'.
// ⭐ D3: nada de acá escribe en lo de otros. Solo la marca `esTaller`.

const express  = require('express');
const mongoose = require('mongoose');

const Course         = require('../models/Course');
const Division       = require('../models/Division');
const Section        = require('../models/Section');
const User           = require('../models/User');
const Activity       = require('../models/Activity');
const Announcement   = require('../models/Announcement');
const AttendanceSession = require('../models/AttendanceSession');
const AttendanceMark = require('../models/AttendanceMark');

const { requireAuth }  = require('../middleware/auth');
const { sectionGuard } = require('../middleware/sections');
const { logAudit }     = require('../middleware/audit');
const { logDeRuta }    = require('../middleware/route-log');

const S = require('../services/secretariaDia');
const T = require('../services/tallerAlcance');
const { filasDelDia } = require('./secretaria');

const router = express.Router();
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Quién entra al panel y quién marca las materias (D1, JT-05). isDenied (config/sections.js)
// solo mira lo que el superadmin apagó por escuela: el acceso BASE por rol se controla acá.
const ROLES_PANEL_TALLER = ['jefetaller', 'directivo', 'admin', 'superadmin'];
const ROLES_MARCAN_TALLER = ['jefetaller', 'admin', 'superadmin'];

function requireTaller(req, res, next) {
  if (!res.locals.user || !ROLES_PANEL_TALLER.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
}

router.use(requireAuth, requireTaller, sectionGuard('taller'));

const puedeMarcar = (user) => !!user && ROLES_MARCAN_TALLER.includes(user.role);

function sinEscuela(res) {
  if (res.locals.user.school) return false;
  res.render('taller/aviso', { activePage: '', motivo: 'sin-escuela' });
  return true;
}

async function talleresDe(school) {
  return Course.find({ school, esTaller: true })
    .select('name division owner coTeachers horarioClases').lean();
}

// ── Resumen del día ────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  if (sinEscuela(res)) return;
  try {
    const school = res.locals.user.school;
    const ahora = new Date();
    const fecha = S.fechaValida(req.query.fecha, ahora);
    const talleres = await talleresDe(school);
    if (!talleres.length) {
      return res.render('taller/aviso', { activePage: 'resumen', motivo: 'sin-talleres', puedeMarcar: puedeMarcar(res.locals.user) });
    }

    const divisionIds = [...new Set(talleres.map(m => String(m.division)).filter(Boolean))];
    const docentes = S.docentesDelAlcance(talleres, divisionIds);
    const [{ filas, hayDatoIngreso, hayGrilla }, divisiones, tomas] = await Promise.all([
      filasDelDia({ school, fecha, docentes }),
      Division.find({ _id: { $in: divisionIds.map(oid) } }).select('name').sort({ name: 1 }).lean(),
      AttendanceSession.find({ division: { $in: divisionIds.map(oid) }, date: fecha }).select('_id division closedAt').lean(),
    ]);

    // Asistencia de cada división ese día (lo que cargó el preceptor), en números.
    const marcas = tomas.length
      ? await AttendanceMark.aggregate([
          { $match: { session: { $in: tomas.map(t => t._id) } } },
          { $group: { _id: { session: '$session', status: '$status' }, n: { $sum: 1 } } },
        ])
      : [];
    const tomaDe = new Map(tomas.map(t => [String(t._id), t]));
    const asistencia = new Map();
    for (const m of marcas) {
      const t = tomaDe.get(String(m._id.session));
      if (!t) continue;
      const k = String(t.division);
      if (!asistencia.has(k)) asistencia.set(k, { presente: 0, tarde: 0, ausente: 0, justificado: 0, sinMarcar: 0, abierta: false });
      const a = asistencia.get(k);
      a[m._id.status == null ? 'sinMarcar' : m._id.status] += m.n;
      if (!t.closedAt) a.abierta = true;
    }

    // ¿Qué materias de taller tienen clase ese día según la grilla?
    const diaSemana = new Date(`${fecha}T12:00:00`).getDay();   // 0 domingo … 6 sábado
    const conClase = new Set(talleres.filter(m => (m.horarioClases || []).some(h => Number(h.dia) === diaSemana)).map(m => String(m._id)));

    res.render('taller/resumen', {
      activePage: 'resumen', fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha), siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      filas, hayDatoIngreso, hayGrilla, conClase, ESTADOS: S.ESTADOS, resumen: S.resumen(filas.map(f => f.estado)),
      divisiones: divisiones.map(d => ({ id: String(d._id), name: d.name, asistencia: asistencia.get(String(d._id)) || null })),
      cantidadTalleres: talleres.length,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Jefes de Sección y sus MEP (P1) ────────────────────────────────────────────────────────
router.get('/jefes', async (req, res) => {
  if (sinEscuela(res)) return;
  try {
    const school = res.locals.user.school;
    const { desde, hasta, periodo } = T.ventanaDelPeriodo(req.query.periodo);
    const [secciones, talleres] = await Promise.all([
      Section.find({ school }).select('name heads divisions courses').sort({ name: 1 }).lean(),
      talleresDe(school),
    ]);

    const ids = [...new Set([
      ...secciones.flatMap(s => s.heads || []),
      ...talleres.flatMap(m => [m.owner, ...(m.coTeachers || [])]),
    ].filter(Boolean).map(String))];

    const rango = { $gte: desde, $lte: hasta };
    const [usuarios, acts, novs] = ids.length ? await Promise.all([
      User.find({ _id: { $in: ids.map(oid) } }).select('name').lean(),
      Activity.aggregate([
        { $match: { author: { $in: ids.map(oid) }, createdAt: rango } },
        { $group: { _id: '$author', n: { $sum: 1 }, ultima: { $max: '$createdAt' } } },
      ]),
      Announcement.aggregate([
        { $match: { author: { $in: ids.map(oid) }, createdAt: rango } },
        { $group: { _id: '$author', n: { $sum: 1 }, ultima: { $max: '$createdAt' } } },
      ]),
    ]) : [[], [], []];

    const subidas = new Map();
    const sumar = (lista, campo) => {
      for (const x of lista) {
        const k = String(x._id);
        if (!subidas.has(k)) subidas.set(k, { actividades: 0, novedades: 0, ultima: null });
        const s = subidas.get(k);
        s[campo] = x.n;
        if (!s.ultima || x.ultima > s.ultima) s.ultima = x.ultima;
      }
    };
    sumar(acts, 'actividades');
    sumar(novs, 'novedades');

    const jefes = T.jefesYMeps({
      secciones, talleres,
      nombres: new Map(usuarios.map(u => [String(u._id), u.name])),
      subidas,
    });

    res.render('taller/jefes', {
      activePage: 'jefes', jefes, periodo, desde, hasta,
      haySecciones: secciones.length > 0, hayTalleres: talleres.length > 0,
      sinJefes: secciones.length > 0 && !secciones.some(s => (s.heads || []).length),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Materias de taller (D2) ────────────────────────────────────────────────────────────────
router.get('/materias', async (req, res) => {
  if (!puedeMarcar(res.locals.user)) return res.status(403).send('Acceso denegado');
  if (sinEscuela(res)) return;
  try {
    const school = res.locals.user.school;
    const [materias, divisiones] = await Promise.all([
      Course.find({ school }).select('name division esTaller').lean(),
      Division.find({ school }).select('name').lean(),
    ]);
    const nombreDiv = new Map(divisiones.map(d => [String(d._id), d.name]));
    const grupos = new Map();
    for (const m of materias) {
      const k = String(m.division || '');
      if (!grupos.has(k)) grupos.set(k, { id: k, name: nombreDiv.get(k) || 'Sin curso', materias: [] });
      grupos.get(k).materias.push({ id: String(m._id), name: m.name, esTaller: !!m.esTaller, sugerida: T.sugerirTaller(m.name) });
    }
    const lista = [...grupos.values()]
      .map(g => ({ ...g, materias: g.materias.sort((a, b) => a.name.localeCompare(b.name, 'es')) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
    res.render('taller/materias', {
      activePage: 'materias', grupos: lista,
      marcadas: materias.filter(m => m.esTaller).length,
      sugeridasSinMarcar: materias.filter(m => !m.esTaller && T.sugerirTaller(m.name)).length,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// body JSON: { marcar: [courseId], desmarcar: [courseId] }. Solo materias de su escuela.
router.post('/materias', async (req, res) => {
  if (!puedeMarcar(res.locals.user)) return res.status(403).json({ error: 'Acceso denegado' });
  const school = res.locals.user.school;
  if (!school) return res.status(400).json({ error: 'Tu usuario no tiene escuela asignada.' });
  const limpiar = (x) => [...new Set((Array.isArray(x) ? x : []).map(String))].filter(id => mongoose.isValidObjectId(id)).slice(0, 2000);
  const marcar = limpiar(req.body && req.body.marcar);
  const desmarcar = limpiar(req.body && req.body.desmarcar).filter(id => !marcar.includes(id));
  if (!marcar.length && !desmarcar.length) return res.status(400).json({ error: 'No hay cambios para guardar.' });
  try {
    const [a, b] = await Promise.all([
      marcar.length ? Course.updateMany({ _id: { $in: marcar.map(oid) }, school }, { $set: { esTaller: true } }) : { modifiedCount: 0 },
      desmarcar.length ? Course.updateMany({ _id: { $in: desmarcar.map(oid) }, school }, { $set: { esTaller: false } }) : { modifiedCount: 0 },
    ]);
    logAudit(req, 'taller.materias', [], { marcadas: a.modifiedCount || 0, desmarcadas: b.modifiedCount || 0 });
    res.json({ ok: true, marcadas: a.modifiedCount || 0, desmarcadas: b.modifiedCount || 0 });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar. Probá de nuevo.' });
  }
});

module.exports = router;
module.exports.ROLES_PANEL_TALLER = ROLES_PANEL_TALLER;
module.exports.ROLES_MARCAN_TALLER = ROLES_MARCAN_TALLER;
