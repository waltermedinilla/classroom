// Rotación de grupos de taller — F4 de specs/jefe-de-taller.spec.md. Montado en /taller/rotacion
// por routes/taller.js, que ya pasó requireAuth, el rol del panel y sectionGuard('taller').
//
//   GET  /                         Cursos con taller: grupos y rotaciones.
//   GET  /grupos/:divisionId       Armar los grupos.            POST: guarda (taller.grupos)
//   GET  /nueva?division=          Formulario de rotación.
//   POST /                         Crea y genera el calendario (taller.rotacion_crear)
//   GET  /:id                      La grilla períodos × grupos.
//   POST /:id/calendario           Correcciones a mano          (taller.rotacion_editar)
//   POST /:id/generar              Vuelve a generar             (taller.rotacion_editar)
//   POST /:id/borrar               Borra                        (taller.rotacion_borrar)
//
// RN-F4-3: editan jefetaller, admin y superadmin; el directivo mira. Todo se filtra por escuela
// y por materias de taller de la división (RN-F4-5): lo de otra escuela da 404.

const express  = require('express');
const mongoose = require('mongoose');

const Course         = require('../models/Course');
const Division       = require('../models/Division');
const User           = require('../models/User');
const GruposTaller   = require('../models/GruposTaller');
const RotacionTaller = require('../models/RotacionTaller');

const { logAudit }  = require('../middleware/audit');
const { logDeRuta } = require('../middleware/route-log');
const { idMalo }    = require('../middleware/objectId');
const R = require('../services/tallerRotacion');
const S = require('../services/secretariaDia');

const router = express.Router();
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const ROLES_EDITAN_ROTACION = ['jefetaller', 'admin', 'superadmin'];
const puedeEditar = (user) => !!user && ROLES_EDITAN_ROTACION.includes(user.role);
const ETIQUETA_CAMBIA = { semana: 'cada semana', quincena: 'cada quincena', mes: 'cada mes', manual: 'en fechas elegidas' };

function soloEditores(req, res) {
  if (puedeEditar(res.locals.user)) return false;
  res.status(403).json({ error: 'Solo el Jefe de Taller o un administrador pueden cambiar grupos y rotaciones.' });
  return true;
}

function escuela(res) {
  const school = res.locals.user.school;
  if (!school) res.render('taller/aviso', { activePage: 'rotacion', motivo: 'sin-escuela' });
  return school;
}

// Las materias de taller de UNA división de la escuela (RN-F4-5). [] si no hay o no es suya.
async function talleresDeDivision(school, divisionId) {
  if (!mongoose.isValidObjectId(divisionId)) return [];
  return Course.find({ school, esTaller: true, division: oid(divisionId) })
    .select('name owner coTeachers').sort({ name: 1 }).lean();
}

// Los alumnos de una división: los inscriptos en cualquiera de sus materias.
async function alumnosDeDivision(school, divisionId) {
  const materias = await Course.find({ school, division: oid(divisionId) }).select('students').lean();
  const ids = [...new Set(materias.flatMap(m => (m.students || []).map(String)))];
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids.map(oid) }, role: 'student' }).select('name active').lean();
  return users.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

const hoyAR = () => S.fechaDe(new Date());

// ── Inicio ────────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const school = escuela(res); if (!school) return;
  try {
    const talleres = await Course.find({ school, esTaller: true }).select('name division').lean();
    if (!talleres.length) {
      return res.render('taller/aviso', { activePage: 'rotacion', motivo: 'sin-talleres', puedeMarcar: puedeEditar(res.locals.user) });
    }
    const divisionIds = [...new Set(talleres.map(t => String(t.division)).filter(Boolean))];
    const [divisiones, grupos, rotaciones] = await Promise.all([
      Division.find({ _id: { $in: divisionIds.map(oid) }, school }).select('name').lean(),
      GruposTaller.find({ school }).select('division grupos.nombre grupos.alumnos').lean(),
      RotacionTaller.find({ school }).select('division nombre desde hasta cambiaCada estaciones.nombre').sort({ desde: -1 }).lean(),
    ]);
    const hoy = hoyAR();
    const cursos = divisiones
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
      .map(d => {
        const g = grupos.find(x => String(x.division) === String(d._id));
        return {
          id: String(d._id), name: d.name,
          talleres: talleres.filter(t => String(t.division) === String(d._id)).map(t => t.name).sort((a, b) => a.localeCompare(b, 'es')),
          grupos: g ? g.grupos.map(x => ({ nombre: x.nombre, alumnos: (x.alumnos || []).length })) : [],
          rotaciones: rotaciones.filter(r => String(r.division) === String(d._id)).map(r => ({
            id: String(r._id), nombre: r.nombre, desde: r.desde, hasta: r.hasta,
            cambia: ETIQUETA_CAMBIA[r.cambiaCada], estaciones: (r.estaciones || []).length,
            vigente: r.desde <= hoy && hoy <= r.hasta,
          })),
        };
      });
    res.render('taller/rotacion', { activePage: 'rotacion', cursos, puedeEditar: puedeEditar(res.locals.user) });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Grupos ────────────────────────────────────────────────────────────────────────────────
router.get('/grupos/:divisionId', async (req, res) => {
  if (idMalo(req, res, 'No encontrado', { param: 'divisionId' })) return;
  const school = escuela(res); if (!school) return;
  try {
    const divisionId = req.params.divisionId;
    const [talleres, division] = await Promise.all([
      talleresDeDivision(school, divisionId),
      Division.findOne({ _id: oid(divisionId), school }).select('name').lean(),
    ]);
    if (!division || !talleres.length) return res.status(404).send('No encontrado');
    const [alumnos, doc] = await Promise.all([
      alumnosDeDivision(school, divisionId),
      GruposTaller.findOne({ school, division: oid(divisionId) }).lean(),
    ]);
    res.render('taller/rotacion-grupos', {
      activePage: 'rotacion', division,
      alumnos: alumnos.map(a => ({ id: String(a._id), name: a.name, active: a.active !== false })),
      grupos: doc ? doc.grupos.map(g => ({ id: String(g._id), nombre: g.nombre, alumnos: (g.alumnos || []).map(String) })) : [],
      puedeEditar: puedeEditar(res.locals.user), MAX_GRUPOS: R.MAX_GRUPOS,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// body JSON: { grupos: [{ id?, nombre, alumnos: [userId] }] } — reemplaza la lista entera.
router.post('/grupos/:divisionId', async (req, res) => {
  if (idMalo(req, res, 'No encontrado', { como: 'json', param: 'divisionId' })) return;
  if (soloEditores(req, res)) return;
  const school = res.locals.user.school;
  if (!school) return res.status(400).json({ error: 'Tu usuario no tiene escuela asignada.' });
  try {
    const divisionId = req.params.divisionId;
    const [talleres, division] = await Promise.all([
      talleresDeDivision(school, divisionId),
      Division.findOne({ _id: oid(divisionId), school }).select('name').lean(),
    ]);
    if (!division || !talleres.length) return res.status(404).json({ error: 'No encontrado' });
    const alumnos = await alumnosDeDivision(school, divisionId);
    const v = R.validarGrupos((req.body || {}).grupos, alumnos.map(a => String(a._id)));
    if (v.error) return res.status(400).json({ error: v.error });

    const previo = await GruposTaller.findOne({ school, division: oid(divisionId) }).select('grupos._id').lean();
    const existentes = new Set(((previo && previo.grupos) || []).map(g => String(g._id)));
    const grupos = v.grupos.map(g => ({
      _id: g.id && existentes.has(g.id) ? oid(g.id) : new mongoose.Types.ObjectId(),
      nombre: g.nombre, alumnos: g.alumnos.map(oid),
    }));
    await GruposTaller.findOneAndUpdate(
      { school, division: oid(divisionId) },
      { $set: { grupos, actualizadoPor: res.locals.user._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    );
    logAudit(req, 'taller.grupos', [{ type: 'division', id: division._id, name: division.name }],
      { grupos: grupos.length, alumnos: grupos.reduce((a, g) => a + g.alumnos.length, 0) });
    res.json({ ok: true, grupos: grupos.map(g => ({ id: String(g._id), nombre: g.nombre })) });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar. Probá de nuevo.' });
  }
});

// ── Nueva rotación ────────────────────────────────────────────────────────────────────────
router.get('/nueva', async (req, res) => {
  if (!puedeEditar(res.locals.user)) return res.status(403).send('Acceso denegado');
  const school = escuela(res); if (!school) return;
  try {
    const divisionId = String(req.query.division || '');
    const talleres = await talleresDeDivision(school, divisionId);
    const division = talleres.length ? await Division.findOne({ _id: oid(divisionId), school }).select('name').lean() : null;
    if (!division) return res.status(404).send('No encontrado');
    const doc = await GruposTaller.findOne({ school, division: division._id }).select('grupos.nombre').lean();
    res.render('taller/rotacion-nueva', {
      activePage: 'rotacion', division,
      talleres: talleres.map(t => ({ id: String(t._id), name: t.name })),
      grupos: doc ? doc.grupos.map(g => g.nombre) : [],
      hoy: hoyAR(), CAMBIA_CADA: R.CAMBIA_CADA, ETIQUETA_CAMBIA,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Arma el calendario circular con los grupos actuales de la división.
async function calendarioCircular(school, division, periodos, estaciones) {
  const doc = await GruposTaller.findOne({ school, division }).select('grupos._id').lean();
  const grupos = ((doc && doc.grupos) || []).map(g => g._id);
  return R.generarCalendario({ periodos, grupos, estaciones });
}

// body JSON: { division, nombre, desde, hasta, cambiaCada, cortes: [fecha], estaciones: [{ course, nombre, admiteVarios }] }
router.post('/', async (req, res) => {
  if (soloEditores(req, res)) return;
  const school = res.locals.user.school;
  if (!school) return res.status(400).json({ error: 'Tu usuario no tiene escuela asignada.' });
  try {
    const body = req.body || {};
    const talleres = await talleresDeDivision(school, body.division);
    const division = talleres.length ? await Division.findOne({ _id: oid(body.division), school }).select('name').lean() : null;
    if (!division) return res.status(404).json({ error: 'No encontrado' });
    const v = R.validarRotacion(body, talleres);
    if (v.error) return res.status(400).json({ error: v.error });

    const estaciones = v.estaciones.map(e => ({ _id: new mongoose.Types.ObjectId(), ...e, course: oid(e.course) }));
    const cal = await calendarioCircular(school, division._id, v.periodos, estaciones);
    if (cal.error) return res.status(400).json({ error: cal.error });

    const rot = await RotacionTaller.create({
      school, division: division._id, nombre: v.nombre, desde: v.desde, hasta: v.hasta, cambiaCada: v.cambiaCada,
      estaciones, periodos: cal.periodos, creadoPor: res.locals.user._id, actualizadoPor: res.locals.user._id,
    });
    logAudit(req, 'taller.rotacion_crear', [{ type: 'division', id: division._id, name: division.name }],
      { rotacion: String(rot._id), nombre: v.nombre, periodos: cal.periodos.length, estaciones: estaciones.length });
    res.json({ ok: true, id: String(rot._id) });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo crear la rotación. Probá de nuevo.' });
  }
});

// ── Una rotación ──────────────────────────────────────────────────────────────────────────
async function rotacionDeLaEscuela(req, res, { como } = {}) {
  if (idMalo(req, res, 'No encontrado', { como })) return null;
  const school = res.locals.user.school;
  const rot = school ? await RotacionTaller.findOne({ _id: oid(req.params.id), school }).lean() : null;
  if (!rot) {
    if (como === 'json') res.status(404).json({ error: 'No encontrado' });
    else res.status(404).send('No encontrado');
    return null;
  }
  return rot;
}

router.get('/:id', async (req, res) => {
  try {
    const rot = await rotacionDeLaEscuela(req, res);
    if (!rot) return;
    const [division, doc, materias] = await Promise.all([
      Division.findById(rot.division).select('name').lean(),
      GruposTaller.findOne({ school: rot.school, division: rot.division }).lean(),
      Course.find({ _id: { $in: rot.estaciones.map(e => e.course) } }).select('name owner coTeachers').lean(),
    ]);
    const docIds = [...new Set(materias.flatMap(m => [m.owner, ...(m.coTeachers || [])]).filter(Boolean).map(String))];
    const usuarios = docIds.length ? await User.find({ _id: { $in: docIds.map(oid) } }).select('name').lean() : [];
    const nombre = new Map(usuarios.map(u => [String(u._id), u.name]));
    const materiaDe = new Map(materias.map(m => [String(m._id), m]));
    const estaciones = rot.estaciones.map(e => {
      const m = materiaDe.get(String(e.course));
      const meps = m ? [...new Set([m.owner, ...(m.coTeachers || [])].filter(Boolean).map(String))].map(id => nombre.get(id)).filter(Boolean) : [];
      return { id: String(e._id), nombre: e.nombre, materia: m ? m.name : 'Materia eliminada', meps, admiteVarios: !!e.admiteVarios };
    });

    // Columnas: los grupos actuales, y al final los que figuran en el calendario y ya no existen (RN-F4-6).
    const actuales = ((doc && doc.grupos) || []).map(g => ({ id: String(g._id), nombre: g.nombre, alumnos: (g.alumnos || []).length, existe: true }));
    const enCal = new Set(rot.periodos.flatMap(p => p.asignacion.map(a => String(a.grupo))));
    const borrados = [...enCal].filter(id => !actuales.some(g => g.id === id)).map(id => ({ id, nombre: 'Grupo eliminado', alumnos: 0, existe: false }));
    const hoy = hoyAR();
    res.render('taller/rotacion-ver', {
      activePage: 'rotacion', division, hoy,
      rotacion: {
        id: String(rot._id), nombre: rot.nombre, desde: rot.desde, hasta: rot.hasta, cambia: ETIQUETA_CAMBIA[rot.cambiaCada],
        actual: R.periodoDeHoy(rot, hoy),
        periodos: rot.periodos.map(p => ({
          desde: p.desde, hasta: p.hasta,
          asignacion: Object.fromEntries(p.asignacion.map(a => [String(a.grupo), a.estacion ? String(a.estacion) : ''])),
        })),
      },
      grupos: [...actuales, ...borrados], estaciones,
      puedeEditar: puedeEditar(res.locals.user),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// body JSON: { periodos: [{ asignacion: [{ grupo, estacion | null }] }] }, uno por período.
router.post('/:id/calendario', async (req, res) => {
  if (soloEditores(req, res)) return;
  try {
    const rot = await rotacionDeLaEscuela(req, res, { como: 'json' });
    if (!rot) return;
    const doc = await GruposTaller.findOne({ school: rot.school, division: rot.division }).select('grupos._id').lean();
    const v = R.validarCalendario({
      entrada: (req.body || {}).periodos, periodosGuardados: rot.periodos,
      grupos: ((doc && doc.grupos) || []).map(g => String(g._id)), estaciones: rot.estaciones,
    });
    if (v.error) return res.status(400).json({ error: v.error });
    const periodos = v.periodos.map(p => ({ ...p, asignacion: p.asignacion.map(a => ({ grupo: oid(a.grupo), estacion: a.estacion ? oid(a.estacion) : null })) }));
    await RotacionTaller.updateOne({ _id: rot._id, school: rot.school }, { $set: { periodos, actualizadoPor: res.locals.user._id } });
    logAudit(req, 'taller.rotacion_editar', [{ type: 'rotacion', id: rot._id, name: rot.nombre }], { como: 'a mano' });
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar. Probá de nuevo.' });
  }
});

router.post('/:id/generar', async (req, res) => {
  if (soloEditores(req, res)) return;
  try {
    const rot = await rotacionDeLaEscuela(req, res, { como: 'json' });
    if (!rot) return;
    const cal = await calendarioCircular(rot.school, rot.division, rot.periodos, rot.estaciones);
    if (cal.error) return res.status(400).json({ error: cal.error });
    await RotacionTaller.updateOne({ _id: rot._id, school: rot.school }, { $set: { periodos: cal.periodos, actualizadoPor: res.locals.user._id } });
    logAudit(req, 'taller.rotacion_editar', [{ type: 'rotacion', id: rot._id, name: rot.nombre }], { como: 'generar' });
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo generar. Probá de nuevo.' });
  }
});

router.post('/:id/borrar', async (req, res) => {
  if (soloEditores(req, res)) return;
  try {
    const rot = await rotacionDeLaEscuela(req, res, { como: 'json' });
    if (!rot) return;
    await RotacionTaller.deleteOne({ _id: rot._id, school: rot.school });
    logAudit(req, 'taller.rotacion_borrar', [{ type: 'rotacion', id: rot._id, name: rot.nombre }], { desde: rot.desde, hasta: rot.hasta });
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo borrar. Probá de nuevo.' });
  }
});

module.exports = router;
module.exports.ROLES_EDITAN_ROTACION = ROLES_EDITAN_ROTACION;
