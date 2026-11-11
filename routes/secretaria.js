// Panel de la Secretaria — /secretaria ("Docentes del día").
// Ver specs/secretaria-docentes-del-dia.spec.md.
//
// Muestra, día por día, qué rastro dejaron en la plataforma los docentes de los cursos que la
// secretaria tiene a cargo: si entraron (IngresoDiario), si estuvieron en una sala en vivo
// (RoomPresence), si publicaron (AuditLog activity/announcement.create) y si corrigieron
// (AuditLog submission.grade/return). Y deja anotar algo por docente y día.
//
// Lo que NO hace, por diseño:
//   - decir que alguien faltó (D2: ausencia de registro ≠ ausencia del docente);
//   - mostrar datos de alumnos, ni siquiera de quién fue la entrega corregida (RN-10);
//   - dejar entrar a las materias.
//
// TODA ruta con :id valida en el servidor que ese docente esté en el alcance. Un id fuera de
// alcance y uno que no existe contestan lo mismo (403): no se distingue "no existe" de "no es
// tuyo" (RN-03).

const express  = require('express');
const mongoose = require('mongoose');

const User           = require('../models/User');
const Course         = require('../models/Course');
const Division       = require('../models/Division');
const RoomPresence   = require('../models/RoomPresence');
const AuditLog       = require('../models/AuditLog');
const IngresoDiario  = require('../models/IngresoDiario');
const NotaDocenteDia = require('../models/NotaDocenteDia');

const { requireAuth }  = require('../middleware/auth');
const { sectionGuard } = require('../middleware/sections');
// El alcance es el de preceptoría, reutilizado tal cual (D1).
const { loadPreceptorScope, inScope } = require('../middleware/preceptor');
const { requireSecretaria, puedeAnotar } = require('../middleware/secretaria');
const { logAudit }  = require('../middleware/audit');
const { logDeRuta } = require('../middleware/route-log');
const { idMalo }    = require('../middleware/objectId');

const S = require('../services/secretariaDia');

const router = express.Router();
// sectionGuard antes del alcance, para no pagar la query de divisiones en un 403 (mismo orden
// que routes/preceptor.js). Hoy es un no-op: secretaria_dia está locked.
router.use(requireAuth, requireSecretaria, sectionGuard('secretaria'), loadPreceptorScope);

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// RN-15: con la auditoría apagada, S3 y S4 no tienen de dónde salir.
const auditoriaApagada = () => process.env.AUDIT_ENABLED === 'false';

// Los docentes del alcance (opcionalmente acotado a un curso) con sus materias. Es la ÚNICA
// fuente de "a quién puede ver": la usan la lista, la ficha y la nota.
async function docentesVisibles(req, curso = null) {
  const divisionIds = curso && inScope(req, curso) ? [String(curso)] : req.scopeDivisionIds;
  if (!divisionIds.length) return { divisionIds, docentes: new Map() };
  const courses = await Course.find({ division: { $in: divisionIds.map(oid) } })
    .select('name division owner coTeachers').lean();
  return { divisionIds, docentes: S.docentesDelAlcance(courses, divisionIds) };
}

// Junta todo lo del día para una lista de docentes y arma las filas. Las consultas usan la
// ventana HOLGADA y el recorte fino lo hace services/secretariaDia.js (RN-05).
async function filasDelDia({ school, fecha, docentes }) {
  const ids = [...docentes.keys()];
  if (!ids.length) return { filas: [], hayDatoIngreso: false };
  const idsOid = ids.map(oid);
  const cursosIds = [...new Set([...docentes.values()].flat().map(m => m.id))];
  const ventana = S.ventanaDelDia(fecha);

  const [usuarios, ingresos, hayDato, presencias, auditorias, notas] = await Promise.all([
    User.find({ _id: { $in: idsOid } }).select('name role active').lean(),
    IngresoDiario.find({ user: { $in: idsOid }, fecha }).lean(),
    // RN-07: ¿la escuela ya registraba ingresos ese día? Basta con un documento de esa fecha o
    // anterior. Antes del deploy no hay, y el ingreso se muestra "sin dato".
    IngresoDiario.exists({ school, fecha: { $lte: fecha } }),
    RoomPresence.find({ user: { $in: idsOid }, firstSeenAt: ventana, course: { $in: cursosIds.map(oid) } })
      .select('user course firstSeenAt lastPingAt msPresente pings').lean(),
    AuditLog.find({ 'actor.userId': { $in: idsOid }, timestamp: ventana, action: { $in: S.ACCIONES_SENAL } })
      .select('action timestamp targets actor.userId').lean(),
    NotaDocenteDia.find({ school, docente: { $in: idsOid }, fecha }).lean(),
  ]);

  const nombres = {};
  for (const lista of docentes.values()) for (const m of lista) nombres[m.id] = m.name;

  const porDocente = (arr, campo) => {
    const m = new Map();
    for (const x of arr) {
      const k = String(campo(x));
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  };
  const ingresoDe = new Map(ingresos.map(i => [String(i.user), i]));
  const presDe    = porDocente(presencias, p => p.user);
  const audDe     = porDocente(auditorias, a => a.actor && a.actor.userId);
  const notaDe    = new Map(notas.map(n => [String(n.docente), n]));
  const usuarioDe = new Map(usuarios.map(u => [String(u._id), u]));
  const hayDatoIngreso = !!hayDato;

  const filas = ids
    .filter(id => usuarioDe.has(id))   // un owner que ya no existe no es una fila
    .map(id => {
      const materias = docentes.get(id);
      const senales = S.senalesDelDocente({
        fecha,
        ingreso: ingresoDe.get(id) || null,
        presencias: presDe.get(id) || [],
        auditorias: audDe.get(id) || [],
        cursosAlcance: materias.map(m => m.id),
        nombres,
      });
      const u = usuarioDe.get(id);
      return {
        id, name: u.name, active: u.active !== false,
        materias,
        senales,
        estado: S.estadoDelDia(senales, { hayDatoIngreso }),
        eventos: S.eventosDeLaLinea(senales),
        nota: notaDe.get(id) || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { filas, hayDatoIngreso };
}

function noScope(req, res) {
  if (!res.locals.user.school) { res.render('secretaria/no-scope', { motivo: 'sin-escuela' }); return true; }
  if (!req.scopeDivisionIds.length) { res.render('secretaria/no-scope', { motivo: 'sin-cursos' }); return true; }
  return false;
}

// GET /secretaria?fecha=YYYY-MM-DD&curso=<divisionId>&vista=lista|linea
// Es la pantalla de entrada y se sirve en "/" mismo, sin redirect: es el path de la solapa en
// config/sections.js, y el chequeo de roles (tests/roles/check-roles.js) espera un 200 ahí.
// '/dia' queda como alias por si alguien guardó el enlace.
router.get(['/', '/dia'], async (req, res) => {
  if (noScope(req, res)) return;
  try {
    const ahora = new Date();
    const fecha = S.fechaValida(req.query.fecha, ahora);
    // RN-09: una fecha futura o mal formada no se pinta "como si fuera hoy" con la URL vieja:
    // se redirige, así lo que dice la barra de direcciones es lo que se ve.
    if (req.query.fecha && req.query.fecha !== fecha) {
      const q = new URLSearchParams({ ...req.query, fecha });
      return res.redirect(`/secretaria?${q}`);
    }
    const curso = inScope(req, req.query.curso) ? String(req.query.curso) : '';
    const vista = req.query.vista === 'linea' ? 'linea' : 'lista';

    const school = res.locals.user.school;
    const [{ docentes }, divisiones] = await Promise.all([
      docentesVisibles(req, curso),
      Division.find({ _id: { $in: req.scopeDivisionIds.map(oid) } }).select('name').sort({ name: 1 }).lean(),
    ]);
    const { filas, hayDatoIngreso } = await filasDelDia({ school, fecha, docentes });

    res.render('secretaria/dia', {
      fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha),
      siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      curso, vista, divisiones,
      filas,
      resumen: S.resumen(filas.map(f => f.estado)),
      ESTADOS: S.ESTADOS,
      hayDatoIngreso,
      auditoriaApagada: auditoriaApagada(),
      puedeAnotar: puedeAnotar(res.locals.user),
      activePage: 'dia',
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /secretaria/docentes/:id?fecha=YYYY-MM-DD — el día de UN docente.
router.get('/docentes/:id', async (req, res) => {
  if (idMalo(req, res, 'Acceso denegado')) return;
  if (noScope(req, res)) return;
  try {
    const ahora = new Date();
    const fecha = S.fechaValida(req.query.fecha, ahora);
    if (req.query.fecha && req.query.fecha !== fecha) {
      return res.redirect(`/secretaria/docentes/${req.params.id}?fecha=${fecha}`);
    }
    const { docentes } = await docentesVisibles(req);
    const id = String(req.params.id);
    // RN-03: fuera de alcance e inexistente contestan lo mismo.
    if (!docentes.has(id)) return res.status(403).send('Acceso denegado');

    const solo = new Map([[id, docentes.get(id)]]);
    const { filas, hayDatoIngreso } = await filasDelDia({ school: res.locals.user.school, fecha, docentes: solo });
    if (!filas.length) return res.status(403).send('Acceso denegado');

    res.render('secretaria/docente', {
      fila: filas[0],
      fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha),
      siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      ESTADOS: S.ESTADOS, NOTA_MAX: S.NOTA_MAX,
      hayDatoIngreso,
      auditoriaApagada: auditoriaApagada(),
      puedeAnotar: puedeAnotar(res.locals.user),
      activePage: 'dia',
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /secretaria/docentes/:id/nota — crea, reemplaza o (con texto vacío) borra la anotación.
// Body: { fecha, texto }. Responde JSON.
router.post('/docentes/:id/nota', async (req, res) => {
  if (idMalo(req, res, 'Acceso denegado', { como: 'json' })) return;
  // RN-12: solo la secretaria anota. El directivo y el admin entran al panel, pero miran.
  if (!puedeAnotar(res.locals.user)) return res.status(403).json({ error: 'Solo la secretaria puede anotar.' });
  const school = res.locals.user.school;
  if (!school || !req.scopeDivisionIds.length) return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const { fecha } = req.body || {};
    if (!S.esFecha(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
    if (S.esFutura(fecha, new Date())) {
      return res.status(400).json({ error: 'No se puede anotar un día que todavía no pasó.' });
    }
    const t = S.textoDeNota(req.body.texto);
    if (t.error) return res.status(400).json({ error: t.error });

    const { docentes } = await docentesVisibles(req);
    const id = String(req.params.id);
    if (!docentes.has(id)) return res.status(403).json({ error: 'Acceso denegado' });
    const docente = await User.findById(id).select('name').lean();
    if (!docente) return res.status(403).json({ error: 'Acceso denegado' });

    const clave = { school, docente: oid(id), fecha };
    const objetivo = [{ type: 'user', id: docente._id, name: docente.name }];

    if (t.borrar) {
      const borrada = await NotaDocenteDia.findOneAndDelete(clave).lean();
      if (borrada) logAudit(req, 'secretaria.nota_borrar', objetivo, { fecha });
      return res.json({ ok: true, nota: null });
    }

    const nota = await NotaDocenteDia.findOneAndUpdate(
      clave,
      { $set: { texto: t.texto, autor: res.locals.user._id, autorNombre: res.locals.user.name || '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();
    logAudit(req, 'secretaria.nota_guardar', objetivo, { fecha, largo: t.texto.length });
    res.json({ ok: true, nota: { texto: nota.texto, autorNombre: nota.autorNombre, updatedAt: nota.updatedAt } });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
