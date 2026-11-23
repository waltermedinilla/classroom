// Panel del Jefe de Taller — F1 (specs/jefe-de-taller.spec.md).
//
//   GET  /taller           Resumen del día: los MEP con su "Docentes del día" (el mismo servicio
//                          que la Secretaria, RN-F1-3) y la asistencia de las divisiones.
//   GET  /taller/jefes     Qué subió cada Jefe de Sección y cada MEP a su cargo (P1).
//   GET  /taller/materias  Marcar qué materias son de taller (D2).
//   POST /taller/materias
//
// F2 — Control de los MEP:
//   GET  /taller/docentes            La semana o el mes de cada MEP, día por día.
//   GET  /taller/docentes/:id        La ficha del día de un MEP, con la nota.
//   POST /taller/docentes/:id/nota   La nota del día (NotaDocenteDia, la misma de la Secretaria).
//   GET  /taller/horario             Horarios de taller contra el horario oficial (solo lectura).
//
// F4 — Rotación de grupos: routes/tallerRotacion.js, montado en /taller/rotacion.
//
// Las actividades y los docentes son las pantallas de /jefatura con el modo 'por-taller'.
// ⭐ D3: nada de acá escribe en lo de otros. Solo la marca `esTaller` y la nota del día.

const express  = require('express');
const mongoose = require('mongoose');

const Course         = require('../models/Course');
const Division       = require('../models/Division');
const Section        = require('../models/Section');
const User           = require('../models/User');
const Activity       = require('../models/Activity');
const Announcement   = require('../models/Announcement');
const RoomSession    = require('../models/RoomSession');
const AttendanceSession = require('../models/AttendanceSession');
const AttendanceMark = require('../models/AttendanceMark');
const NotaDocenteDia = require('../models/NotaDocenteDia');
const Horario        = require('../models/Horario');
const HorarioOficial = require('../models/HorarioOficial');

const { requireAuth }  = require('../middleware/auth');
const { sectionGuard } = require('../middleware/sections');
const { logAudit }     = require('../middleware/audit');
const { logDeRuta }    = require('../middleware/route-log');
const { idMalo }       = require('../middleware/objectId');

const S = require('../services/secretariaDia');
const T = require('../services/tallerAlcance');
const C = require('../services/tallerControl');
const O = require('../services/secretariaHorarioOficial');
const grillaSvc = require('../services/recursos/horario');
const { filasDelDia } = require('./secretaria');

const router = express.Router();
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Quién entra al panel y quién marca las materias (D1, JT-05). isDenied (config/sections.js)
// solo mira lo que el superadmin apagó por escuela: el acceso BASE por rol se controla acá.
const ROLES_PANEL_TALLER = ['jefetaller', 'directivo', 'admin', 'superadmin'];
const ROLES_MARCAN_TALLER = ['jefetaller', 'admin', 'superadmin'];
// Quién escribe la nota del día sobre un MEP (RN-F2-2). El resto del panel la lee.
const ROLES_ANOTAN_TALLER = ['jefetaller'];

function requireTaller(req, res, next) {
  if (!res.locals.user || !ROLES_PANEL_TALLER.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
}

router.use(requireAuth, requireTaller, sectionGuard('taller'));

const puedeMarcar = (user) => !!user && ROLES_MARCAN_TALLER.includes(user.role);
const puedeAnotarTaller = (user) => !!user && ROLES_ANOTAN_TALLER.includes(user.role);

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
    const ventana = T.ventanaDelPeriodo(req.query.periodo, req.query.fecha);
    const { desde, hasta } = ventana;
    const [secciones, talleres] = await Promise.all([
      Section.find({ school }).select('name heads divisions courses').sort({ name: 1 }).lean(),
      talleresDe(school),
    ]);

    const ids = [...new Set([
      ...secciones.flatMap(s => s.heads || []),
      ...talleres.flatMap(m => [m.owner, ...(m.coTeachers || [])]),
    ].filter(Boolean).map(String))];

    const rango = { $gte: desde, $lt: hasta };
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
      activePage: 'jefes', jefes, ventana,
      haySecciones: secciones.length > 0, hayTalleres: talleres.length > 0,
      sinJefes: secciones.length > 0 && !secciones.some(s => (s.heads || []).length),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Lo que hizo cada Sección (pedido del 2026-11-22) ───────────────────────────────────────
// Por Sección: actividades, novedades y clases en vivo de sus materias de taller en el día, la
// semana o el mes, con lo último publicado. "Talleres sin sección" junta los que no están en ninguna.
router.get('/secciones', async (req, res) => {
  if (sinEscuela(res)) return;
  try {
    const school = res.locals.user.school;
    const ventana = T.ventanaDelPeriodo(req.query.periodo, req.query.fecha);
    const rango = { $gte: ventana.desde, $lt: ventana.hasta };
    const [secciones, talleres] = await Promise.all([
      Section.find({ school }).select('name heads divisions courses').sort({ name: 1 }).lean(),
      talleresDe(school),
    ]);
    const ids = talleres.map(m => m._id);
    const LIMITE_ITEMS = 400;
    const [acts, novs, salas] = ids.length ? await Promise.all([
      Activity.find({ course: { $in: ids }, createdAt: rango }).select('title course author createdAt type').sort({ createdAt: -1 }).limit(LIMITE_ITEMS).lean(),
      Announcement.find({ course: { $in: ids }, createdAt: rango }).select('text course author createdAt').sort({ createdAt: -1 }).limit(LIMITE_ITEMS).lean(),
      RoomSession.aggregate([
        { $match: { course: { $in: ids }, openedAt: rango } },
        { $group: { _id: '$course', n: { $sum: 1 } } },
      ]),
    ]) : [[], [], []];

    // Los conteos salen de lo traído; si se llegó al límite, se cuentan aparte para no mentir.
    const contar = async (Modelo, lista) => {
      const m = new Map();
      if (lista.length < LIMITE_ITEMS) { for (const x of lista) m.set(String(x.course), (m.get(String(x.course)) || 0) + 1); return m; }
      for (const g of await Modelo.aggregate([{ $match: { course: { $in: ids }, createdAt: rango } }, { $group: { _id: '$course', n: { $sum: 1 } } }])) m.set(String(g._id), g.n);
      return m;
    };
    const [nAct, nNov] = await Promise.all([contar(Activity, acts), contar(Announcement, novs)]);
    const porMateria = new Map(talleres.map(m => [String(m._id), {
      actividades: nAct.get(String(m._id)) || 0,
      novedades: nNov.get(String(m._id)) || 0,
      clasesEnVivo: (salas.find(x => String(x._id) === String(m._id)) || {}).n || 0,
    }]));

    const userIds = [...new Set([...acts, ...novs].map(x => String(x.author)).concat(secciones.flatMap(s => (s.heads || []).map(String))))];
    const usuarios = userIds.length ? await User.find({ _id: { $in: userIds.map(oid) } }).select('name').lean() : [];
    const nombres = new Map(usuarios.map(u => [String(u._id), u.name]));
    const materiaDe = new Map(talleres.map(m => [String(m._id), m.name]));
    const items = [
      ...acts.map(a => ({ tipo: 'actividad', id: String(a._id), titulo: a.title, course: String(a.course), materia: materiaDe.get(String(a.course)) || '', autor: nombres.get(String(a.author)) || '', fecha: a.createdAt })),
      ...novs.map(n => ({ tipo: 'novedad', id: String(n._id), titulo: String(n.text || '').slice(0, 120), course: String(n.course), materia: materiaDe.get(String(n.course)) || '', autor: nombres.get(String(n.author)) || '', fecha: n.createdAt })),
    ];

    res.render('taller/secciones', {
      activePage: 'secciones', ventana,
      tarjetas: T.resumenPorSeccion({ secciones, talleres, porMateria, items, nombres }),
      hayTalleres: talleres.length > 0,
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

// ── F2 · Control de los MEP ────────────────────────────────────────────────────────────────

// Los MEP de la escuela con sus talleres: la ÚNICA fuente de "a quién controla" (RN-F2-3).
async function mepsDeLaEscuela(school) {
  const talleres = await talleresDe(school);
  const divisionIds = [...new Set(talleres.map(m => String(m.division)).filter(Boolean))];
  return { talleres, divisionIds, docentes: S.docentesDelAlcance(talleres, divisionIds) };
}

// GET /taller/docentes?periodo=semana|mes&fecha=YYYY-MM-DD
router.get('/docentes', async (req, res) => {
  if (sinEscuela(res)) return;
  if (req.query.periodo === 'dia') {
    const f = S.esFecha(req.query.fecha) ? `?fecha=${req.query.fecha}` : '';
    return res.redirect(`/taller${f}`);
  }
  try {
    const school = res.locals.user.school;
    const ventana = T.ventanaDelPeriodo(req.query.periodo === 'mes' ? 'mes' : 'semana', req.query.fecha);
    const { talleres, docentes } = await mepsDeLaEscuela(school);
    if (!talleres.length) {
      return res.render('taller/aviso', { activePage: 'docentes', motivo: 'sin-talleres', puedeMarcar: puedeMarcar(res.locals.user) });
    }
    const [grilla, usuarios] = await Promise.all([
      Horario.findOne({ school }).select('dias turnos').lean(),
      User.find({ _id: { $in: [...docentes.keys()].map(oid) } }).select('name').lean(),
    ]);
    const fechas = C.diasHabiles(ventana, grilla && grilla.dias, S.fechaDe(new Date()));

    // RN-F2-4: cada día con filasDelDia, de a cinco días por vez para no abrir 23 a la par.
    const porDia = new Map();
    for (let i = 0; i < fechas.length; i += 5) {
      const lote = fechas.slice(i, i + 5);
      const res5 = await Promise.all(lote.map(fecha => filasDelDia({ school, fecha, docentes })));
      lote.forEach((f, j) => porDia.set(f, res5[j].filas));
    }
    const meps = usuarios.map(u => ({ id: String(u._id), name: u.name, materias: docentes.get(String(u._id)) || [] }));
    res.render('taller/docentes', {
      activePage: 'docentes', ventana, fechas,
      filas: C.matrizControl({ meps, fechas, porDia }),
      hayGrilla: grillaSvc.horarioCargado(grilla),
      hoy: S.fechaDe(new Date()),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /taller/docentes/:id?fecha=YYYY-MM-DD — la ficha del día de UN MEP.
router.get('/docentes/:id', async (req, res) => {
  if (idMalo(req, res, 'No encontrado')) return;
  if (sinEscuela(res)) return;
  try {
    const ahora = new Date();
    const fecha = S.fechaValida(req.query.fecha, ahora);
    if (req.query.fecha && req.query.fecha !== fecha) return res.redirect(`/taller/docentes/${req.params.id}?fecha=${fecha}`);
    const school = res.locals.user.school;
    const { docentes } = await mepsDeLaEscuela(school);
    const id = String(req.params.id);
    if (!docentes.has(id)) return res.status(404).send('No encontrado');   // RN-F2-3
    const { filas, hayDatoIngreso } = await filasDelDia({ school, fecha, docentes: new Map([[id, docentes.get(id)]]) });
    if (!filas.length) return res.status(404).send('No encontrado');
    res.render('taller/docente', {
      activePage: 'docentes', fila: filas[0], fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha), siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      ESTADOS: S.ESTADOS, NOTA_MAX: S.NOTA_MAX, hayDatoIngreso,
      puedeAnotar: puedeAnotarTaller(res.locals.user),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /taller/docentes/:id/nota — body { fecha, texto }. Texto vacío = borrar (RN-F2-1, RN-F2-2).
router.post('/docentes/:id/nota', async (req, res) => {
  if (idMalo(req, res, 'No encontrado', { como: 'json' })) return;
  if (!puedeAnotarTaller(res.locals.user)) return res.status(403).json({ error: 'Solo el Jefe de Taller puede anotar desde este panel.' });
  const school = res.locals.user.school;
  if (!school) return res.status(400).json({ error: 'Tu usuario no tiene escuela asignada.' });
  try {
    const { fecha } = req.body || {};
    if (!S.esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (S.esFutura(fecha, new Date())) return res.status(400).json({ error: 'No se puede anotar un día que todavía no pasó.' });
    const t = S.textoDeNota(req.body.texto);
    if (t.error) return res.status(400).json({ error: t.error });

    const { docentes } = await mepsDeLaEscuela(school);
    const id = String(req.params.id);
    if (!docentes.has(id)) return res.status(404).json({ error: 'No encontrado' });
    const docente = await User.findById(id).select('name').lean();
    if (!docente) return res.status(404).json({ error: 'No encontrado' });

    const clave = { school, docente: oid(id), fecha };
    const objetivo = [{ type: 'user', id: docente._id, name: docente.name }];
    if (t.borrar) {
      const borrada = await NotaDocenteDia.findOneAndDelete(clave).lean();
      if (borrada) logAudit(req, 'taller.nota_borrar', objetivo, { fecha });
      return res.json({ ok: true, nota: null });
    }
    const nota = await NotaDocenteDia.findOneAndUpdate(
      clave,
      { $set: { texto: t.texto, autor: res.locals.user._id, autorNombre: res.locals.user.name || '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();
    logAudit(req, 'taller.nota_guardar', objetivo, { fecha, largo: t.texto.length });
    res.json({ ok: true, nota: { texto: nota.texto, autorNombre: nota.autorNombre, updatedAt: nota.updatedAt } });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /taller/horario?curso=<divisionId> — los horarios de taller contra el oficial (RN-F2-5, RN-F2-6).
router.get('/horario', async (req, res) => {
  if (sinEscuela(res)) return;
  try {
    const school = res.locals.user.school;
    const talleres = await talleresDe(school);
    if (!talleres.length) {
      return res.render('taller/aviso', { activePage: 'horario', motivo: 'sin-talleres', puedeMarcar: puedeMarcar(res.locals.user) });
    }
    const divisionIds = [...new Set(talleres.map(m => String(m.division)).filter(Boolean))];
    const [grilla, divisiones, oficiales] = await Promise.all([
      Horario.findOne({ school }).lean(),
      Division.find({ _id: { $in: divisionIds.map(oid) } }).select('name').lean(),
      HorarioOficial.find({ school }).lean(),
    ]);
    divisiones.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
    const hayGrilla = grillaSvc.horarioCargado(grilla);

    const docIds = [...new Set(talleres.flatMap(m => [m.owner, ...(m.coTeachers || [])]).filter(Boolean).map(String))];
    const usuarios = docIds.length ? await User.find({ _id: { $in: docIds.map(oid) } }).select('name').lean() : [];
    const nombre = new Map(usuarios.map(u => [String(u._id), u.name]));
    const docentesDe = (m) => [...new Set([m.owner, ...(m.coTeachers || [])].filter(Boolean).map(String))]
      .filter(id => nombre.has(id)).map(id => ({ id, name: nombre.get(id) }));

    const compararDivision = (d) => {
      const suyos = talleres.filter(m => String(m.division) === String(d._id));
      const nums = O.numerosDeDivision(d.name);
      const oficialCompleto = nums ? oficiales.find(o => o.curso === nums[0] && o.division === nums[1]) : null;
      const materias = suyos.map(m => ({ id: String(m._id), name: m.name, horarioClases: m.horarioClases, docentes: docentesDe(m) }));
      if (!oficialCompleto || !hayGrilla) return { suyos, materias, comparacion: { oficial: null, hayImportado: oficiales.length > 0 } };
      const oficial = C.filtrarOficialTaller(oficialCompleto, suyos.map(m => m.name));
      return { suyos, materias, comparacion: { oficial, ...O.compararCurso({ oficial, grilla, materias }) } };
    };

    const curso = divisiones.some(d => String(d._id) === String(req.query.curso)) ? String(req.query.curso) : '';
    if (curso) {
      const d = divisiones.find(x => String(x._id) === curso);
      const r = compararDivision(d);
      return res.render('taller/horario', {
        activePage: 'horario', curso, division: d, divisiones, hayGrilla,
        talleresDelCurso: r.materias, comparacion: r.comparacion,
        NOMBRE_DIA: grillaSvc.NOMBRE_DIA, ETIQUETA_ESTADO: O.ETIQUETA_ESTADO, tarjetas: null,
      });
    }
    const tarjetas = divisiones.map(d => {
      const r = compararDivision(d);
      return { id: String(d._id), name: d.name, talleres: r.suyos.map(m => m.name).sort((a, b) => a.localeCompare(b, 'es')),
        conOficial: !!r.comparacion.oficial, resumen: r.comparacion.resumen || null };
    });
    res.render('taller/horario', {
      activePage: 'horario', curso: '', division: null, divisiones, hayGrilla, tarjetas,
      hayImportado: oficiales.length > 0,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// F4: rotación de grupos.
router.use('/rotacion', require('./tallerRotacion'));

module.exports = router;
module.exports.ROLES_ANOTAN_TALLER = ROLES_ANOTAN_TALLER;
module.exports.ROLES_PANEL_TALLER = ROLES_PANEL_TALLER;
module.exports.ROLES_MARCAN_TALLER = ROLES_MARCAN_TALLER;
