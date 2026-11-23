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
const Horario        = require('../models/Horario');
const HorarioOficial = require('../models/HorarioOficial');

const { requireAuth }  = require('../middleware/auth');
const { sectionGuard } = require('../middleware/sections');
// El alcance es el de preceptoría, reutilizado tal cual (D1).
const { loadPreceptorScope, inScope } = require('../middleware/preceptor');
const { requireSecretaria, puedeAnotar, puedeCargarHorario } = require('../middleware/secretaria');
const { logAudit }  = require('../middleware/audit');
const { logDeRuta } = require('../middleware/route-log');
const { idMalo }    = require('../middleware/objectId');

const S = require('../services/secretariaDia');
const P = require('../services/secretariaPuntualidad');
const H = require('../services/secretariaHorarioCurso');
const O = require('../services/secretariaHorarioOficial');
const live = require('../services/liveRoom');
const grillaSvc = require('../services/recursos/horario');

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
    .select('name division owner coTeachers horarioClases').lean();
  return { divisionIds, docentes: S.docentesDelAlcance(courses, divisionIds) };
}

// Junta todo lo del día para una lista de docentes y arma las filas. Las consultas usan la
// ventana HOLGADA y el recorte fino lo hace services/secretariaDia.js (RN-05).
async function filasDelDia({ school, fecha, docentes }) {
  const ids = [...docentes.keys()];
  if (!ids.length) return { filas: [], hayDatoIngreso: false, hayGrilla: false };
  const idsOid = ids.map(oid);
  const cursosIds = [...new Set([...docentes.values()].flat().map(m => m.id))];
  const ventana = S.ventanaDelDia(fecha);

  const [usuarios, ingresos, hayDato, presencias, auditorias, notas, grilla] = await Promise.all([
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
    // La grilla de módulos: contra ella se mide la puntualidad (specs/secretaria-puntualidad.spec.md).
    Horario.findOne({ school }).lean(),
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
      const puntualidad = P.puntualidad({ fecha, materias, grilla, senales, hayDatoIngreso });
      return {
        id, name: u.name, active: u.active !== false,
        materias,
        senales,
        estado: S.estadoDelDia(senales, { hayDatoIngreso }),
        eventos: S.eventosDeLaLinea(senales),
        nota: notaDe.get(id) || null,
        puntualidad,
        textoPuntualidad: P.textoPuntualidad(puntualidad),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { filas, hayDatoIngreso, hayGrilla: grillaSvc.horarioCargado(grilla) };
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
    const { filas, hayDatoIngreso, hayGrilla } = await filasDelDia({ school, fecha, docentes });

    res.render('secretaria/dia', {
      fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha),
      siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      curso, vista, divisiones,
      filas,
      resumen: S.resumen(filas.map(f => f.estado)),
      tardes: filas.filter(f => f.puntualidad.estado === 'tarde').length,
      conHorario: filas.filter(f => f.puntualidad.estado !== 'sinClase').length,
      ESTADOS: S.ESTADOS,
      hayDatoIngreso, hayGrilla,
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

// ── Horario de clases de las materias (specs/secretaria-puntualidad.spec.md) ──────────────────

// GET /secretaria/horario?curso=<divisionId> — las materias del alcance con su grilla de
// días × módulos. La ve todo el que entra al panel; editan solo ROLES_QUE_CARGAN_HORARIO.
router.get('/horario', async (req, res) => {
  if (noScope(req, res)) return;
  try {
    const school = res.locals.user.school;
    const curso = inScope(req, req.query.curso) ? String(req.query.curso) : '';
    const divisionIds = curso ? [curso] : req.scopeDivisionIds;
    const [grilla, divisiones, materias] = await Promise.all([
      Horario.findOne({ school }).lean(),
      Division.find({ _id: { $in: req.scopeDivisionIds.map(oid) } }).select('name').sort({ name: 1 }).lean(),
      Course.find({ division: { $in: divisionIds.map(oid) } })
        .select('name division horarioClases').sort({ name: 1 }).lean(),
    ]);
    const nombreDiv = new Map(divisiones.map(d => [String(d._id), d.name]));
    const porCurso = [];
    for (const d of divisiones) {
      if (curso && String(d._id) !== curso) continue;
      const lista = materias.filter(m => String(m.division) === String(d._id)).map(m => ({
        id: String(m._id), name: m.name,
        // RP-03: las entradas cuya franja ya no existe se marcan, no se esconden.
        horarioClases: (m.horarioClases || []).map(e => ({
          dia: e.dia, turno: e.turno, orden: e.orden,
          existe: !!grillaSvc.moduloDe(grilla, e.turno, e.orden),
        })),
      }));
      if (lista.length) porCurso.push({ id: String(d._id), name: nombreDiv.get(String(d._id)) || '', materias: lista });
    }

    const hayGrilla = grillaSvc.horarioCargado(grilla);
    res.render('secretaria/horario', {
      porCurso, divisiones, curso,
      hayGrilla,
      // Solo lo que la pantalla necesita para dibujar la grilla: días y franjas de clase.
      grilla: hayGrilla ? {
        dias: (grilla.dias || []).map(Number).sort((a, b) => a - b),
        turnos: grilla.turnos.map(t => ({
          id: t.id, label: t.label,
          modulos: grillaSvc.modulosDeClase(t).map(f => ({ orden: f.orden, label: f.label, desde: f.desde, hasta: f.hasta })),
        })).filter(t => t.modulos.length),
      } : null,
      NOMBRE_DIA: grillaSvc.NOMBRE_DIA,
      puedeEditar: puedeCargarHorario(res.locals.user),
      activePage: 'horario',
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /secretaria/horario/:courseId — reemplaza el horario de UNA materia.
// Body JSON: { entradas: [{ dia, turno, orden }, …] }. Lista vacía = sin horario.
router.post('/horario/:courseId', async (req, res) => {
  if (idMalo(req, res, 'Acceso denegado', { como: 'json', param: 'courseId' })) return;
  if (!puedeCargarHorario(res.locals.user)) {
    return res.status(403).json({ error: 'No tenés permiso para cargar horarios.' });
  }
  const school = res.locals.user.school;
  if (!school || !req.scopeDivisionIds.length) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const course = await Course.findById(req.params.courseId).select('name division').lean();
    // Fuera de alcance e inexistente contestan lo mismo (como RN-03 de la fase 1).
    if (!course || !inScope(req, course.division)) return res.status(403).json({ error: 'Acceso denegado' });

    const grilla = await Horario.findOne({ school }).lean();
    const v = P.validarHorarioClases((req.body || {}).entradas, grilla);
    if (!v.ok) return res.status(400).json({ error: v.error });

    await Course.updateOne({ _id: course._id }, { $set: { horarioClases: v.entradas } });
    logAudit(req, 'course.horario_clases', [{ type: 'course', id: course._id, name: course.name }],
      { modulos: v.entradas.length });
    res.json({ ok: true, entradas: v.entradas });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar el horario' });
  }
});

// ── Horario del curso (specs/secretaria-horario-del-curso.spec.md) ───────────────────────────
// La grilla de la semana de un curso, como la de la otra plataforma, con el control del día y
// la carga celda por celda. No hay datos nuevos (D1): todo es Course.horarioClases.

// GET /secretaria/curso?curso=<divisionId>&turno=<id>&fecha=YYYY-MM-DD&modo=ver|cargar
router.get('/curso', async (req, res) => {
  if (noScope(req, res)) return;
  try {
    const school = res.locals.user.school;
    const ahora = new Date();
    const fecha = S.fechaValida(req.query.fecha, ahora);
    if (req.query.fecha && req.query.fecha !== fecha) {
      const q = new URLSearchParams({ ...req.query, fecha });
      return res.redirect(`/secretaria/curso?${q}`);
    }
    const [grilla, divisiones] = await Promise.all([
      Horario.findOne({ school }).lean(),
      Division.find({ _id: { $in: req.scopeDivisionIds.map(oid) } }).select('name').sort({ name: 1 }).lean(),
    ]);
    // D4: un ?curso= fuera del alcance se ignora y se muestra el primero.
    const curso = inScope(req, req.query.curso) ? String(req.query.curso) : (divisiones[0] ? String(divisiones[0]._id) : '');
    const puedeEditar = puedeCargarHorario(res.locals.user);
    // "comparar" (specs/secretaria-horario-oficial.spec.md) lo ve todo el que ve la pantalla.
    const modo = req.query.modo === 'cargar' && puedeEditar ? 'cargar'
      : req.query.modo === 'comparar' ? 'comparar' : 'ver';
    const base = {
      divisiones, curso, fecha, hoy: S.fechaDe(ahora),
      anterior: S.diaAnterior(fecha),
      siguiente: fecha < S.fechaDe(ahora) ? S.diaSiguiente(fecha) : null,
      modo, puedeEditar, NOMBRE_DIA: grillaSvc.NOMBRE_DIA, activePage: 'curso',
    };
    if (!grillaSvc.horarioCargado(grilla) || !curso) {
      return res.render('secretaria/curso', { ...base, hayGrilla: grillaSvc.horarioCargado(grilla), grillaCurso: null });
    }

    const materias = await Course.find({ division: oid(curso) }).select('name owner coTeachers horarioClases').sort({ name: 1 }).lean();
    const docenteIds = [...new Set(materias.flatMap(m => [m.owner, ...(m.coTeachers || [])]).filter(Boolean).map(String))];
    const idsOid = docenteIds.map(oid);
    const ventana = S.ventanaDelDia(fecha);
    const [usuarios, otrasMaterias, ingresos, hayDato, presencias] = await Promise.all([
      User.find({ _id: { $in: idsOid } }).select('name').lean(),
      // Las demás materias de estos docentes en la escuela: para los choques (D6) y para saber
      // cuál es su primera clase del día (D3).
      Course.find({
        school, _id: { $nin: materias.map(m => m._id) },
        $or: [{ owner: { $in: idsOid } }, { coTeachers: { $in: idsOid } }],
      }).select('name division owner coTeachers horarioClases').lean(),
      IngresoDiario.find({ user: { $in: idsOid }, fecha }).lean(),
      IngresoDiario.exists({ school, fecha: { $lte: fecha } }),
      RoomPresence.find({ user: { $in: idsOid }, firstSeenAt: ventana }).select('user course firstSeenAt').lean(),
    ]);

    const nombre = new Map(usuarios.map(u => [String(u._id), u.name]));
    const docentesDe = (m) => [...new Set([m.owner, ...(m.coTeachers || [])].filter(Boolean).map(String))]
      .filter(id => nombre.has(id)).map(id => ({ id, name: nombre.get(id) }));
    const grillaCurso = H.grillaDelCurso({
      grilla,
      materias: materias.map(m => ({ id: String(m._id), name: m.name, horarioClases: m.horarioClases, docentes: docentesDe(m) })),
    });

    // Choques: nombres de curso solo para los del alcance (D4).
    const divOtras = await Division.find({ _id: { $in: [...new Set(otrasMaterias.map(m => String(m.division)))].map(oid) } }).select('name').lean();
    const nombreDiv = new Map(divOtras.map(d => [String(d._id), d.name]));
    const otras = [];
    for (const m of otrasMaterias) {
      for (const d of docentesDe(m)) {
        if (!docenteIds.includes(d.id)) continue;
        otras.push({
          docenteId: d.id, materiaId: String(m._id), materia: m.name,
          curso: nombreDiv.get(String(m.division)) || '', enAlcance: inScope(req, m.division),
          horarioClases: m.horarioClases,
        });
      }
    }
    const avisos = H.choques({ grillaCurso, otras });

    // Control del día (D3): solo la columna del día elegido, si es un día de la grilla.
    const diaControl = P.diaSemana(fecha);
    const control = {};
    if (grillaCurso.dias.includes(diaControl)) {
      const hayDatoIngreso = !!hayDato;
      const ingresoDe = new Map(ingresos.map(i => [String(i.user), i]));
      const presDe = new Map();
      for (const p of presencias) {
        const k = String(p.user);
        if (!presDe.has(k)) presDe.set(k, []);
        presDe.get(k).push(p);
      }
      const esHoy = fecha === S.fechaDe(ahora);
      const ahoraMin = grillaSvc.aMinutos(live.hora(ahora));
      const porDocente = new Map();
      for (const id of docenteIds) {
        const suyas = [...materias, ...otrasMaterias].filter(m => docentesDe(m).some(d => d.id === id));
        porDocente.set(id, {
          primerInicio: H.primerInicioDelDia({ fecha, grilla, materiasDelDocente: suyas }),
          llegada: H.llegadaDelDia({ fecha, ingreso: ingresoDe.get(id), presencias: presDe.get(id) || [], hayDatoIngreso }),
          presencias: presDe.get(id) || [],
        });
      }
      for (const t of grillaCurso.turnos) {
        for (const mod of t.modulos) {
          const celda = mod.celdas[diaControl];
          for (const mat of celda.materias) {
            const resultados = mat.docentes.map(d => {
              const info = porDocente.get(d.id);
              const r = H.puntualidadDeClase({
                clase: { materiaId: mat.materiaId, desde: mod.desde, hasta: mod.hasta },
                fecha, esPrimera: info.primerInicio === grillaSvc.aMinutos(mod.desde),
                llegada: info.llegada, presencias: info.presencias, esHoy, ahoraMin,
              });
              return { docente: d.name, ...r };
            });
            control[`${t.id}|${mod.orden}|${mat.materiaId}`] = {
              estado: H.mejorEstado(resultados.map(r => r.estado)), porDocente: resultados,
            };
          }
        }
      }
    }

    const turno = grillaCurso.turnos.some(t => t.id === req.query.turno) ? req.query.turno : grillaCurso.turnos[0].id;

    // Comparar con el horario oficial: el curso oficial con los mismos números que esta división (D2).
    let comparacion = null;
    if (modo === 'comparar') {
      const div = divisiones.find(d => String(d._id) === curso);
      const nums = div && O.numerosDeDivision(div.name);
      const oficial = nums ? await HorarioOficial.findOne({ school, curso: nums[0], division: nums[1] }).lean() : null;
      comparacion = oficial
        ? { oficial, ...O.compararCurso({
            oficial, grilla,
            materias: materias.map(m => ({ id: String(m._id), name: m.name, horarioClases: m.horarioClases, docentes: docentesDe(m) })),
          }) }
        : { oficial: null, hayImportado: !!(await HorarioOficial.exists({ school })) };
    }

    res.render('secretaria/curso', {
      ...base, hayGrilla: true, grillaCurso, turno, diaControl,
      avisos: Object.fromEntries(avisos), control,
      materias: materias.map(m => ({ id: String(m._id), name: m.name })),
      comparacion, ETIQUETA_ESTADO: O.ETIQUETA_ESTADO,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Horario oficial (specs/secretaria-horario-oficial.spec.md) ───────────────────────────────

// Los usuarios de la escuela que pueden ser docentes: todos menos alumnos y superadmin.
const ROLES_DOCENTES = ['admin', 'directivo', 'teacher', 'preceptor', 'jefe', 'soe', 'secretaria'];

// GET /secretaria/oficial — importar (quien carga horarios) y el resumen de la escuela.
router.get('/oficial', async (req, res) => {
  if (noScope(req, res)) return;
  try {
    const school = res.locals.user.school;
    const [oficiales, divisiones, grilla, usuarios] = await Promise.all([
      HorarioOficial.find({ school }).sort({ curso: 1, division: 1 }).lean(),
      Division.find({ school }).select('name').lean(),
      Horario.findOne({ school }).lean(),
      User.find({ school, role: { $in: ROLES_DOCENTES } }).select('name').lean(),
    ]);
    const divs = divisiones.map(d => ({ id: String(d._id), name: d.name }));
    const nombreDiv = new Map(divs.map(d => [d.id, d.name]));

    // D7: la secretaria ve los cursos de su alcance; admin y superadmin, todos.
    const filas = oficiales.map(o => {
      const divisionId = O.divisionDe(o, divs);
      return { oficial: o, divisionId, division: divisionId ? nombreDiv.get(divisionId) : null,
               enAlcance: !divisionId || inScope(req, divisionId) };
    }).filter(f => f.enAlcance);

    const ids = filas.map(f => f.divisionId).filter(Boolean);
    const materias = ids.length
      ? await Course.find({ division: { $in: ids.map(oid) } }).select('name division owner coTeachers horarioClases').lean()
      : [];
    const nombre = new Map(usuarios.map(u => [String(u._id), u.name]));
    const faltantes = [...new Set(materias.flatMap(m => [m.owner, ...(m.coTeachers || [])]).filter(Boolean).map(String))]
      .filter(id => !nombre.has(id));
    if (faltantes.length) {
      for (const u of await User.find({ _id: { $in: faltantes.map(oid) } }).select('name').lean()) nombre.set(String(u._id), u.name);
    }
    const docentesDe = (m) => [...new Set([m.owner, ...(m.coTeachers || [])].filter(Boolean).map(String))]
      .filter(id => nombre.has(id)).map(id => ({ id, name: nombre.get(id) }));

    for (const f of filas) {
      if (!f.divisionId || !grillaSvc.horarioCargado(grilla)) continue;
      const delCurso = materias.filter(m => String(m.division) === f.divisionId)
        .map(m => ({ id: String(m._id), name: m.name, horarioClases: m.horarioClases, docentes: docentesDe(m) }));
      f.resumen = O.compararCurso({ oficial: f.oficial, grilla, materias: delCurso }).resumen;
    }

    res.render('secretaria/oficial', {
      activePage: 'oficial', filas,
      importado: oficiales.length ? oficiales.reduce((a, o) => (o.updatedAt > a ? o.updatedAt : a), oficiales[0].updatedAt) : null,
      docentes: O.docentesDelOficial(filas.map(f => f.oficial), usuarios.map(u => ({ id: String(u._id), name: u.name }))),
      hayGrilla: grillaSvc.horarioCargado(grilla),
      puedeImportar: puedeCargarHorario(res.locals.user),
      error: null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /secretaria/oficial — body: el JSON del horario oficial. Reemplaza el de la escuela (D1).
router.post('/oficial', async (req, res) => {
  if (!puedeCargarHorario(res.locals.user)) {
    return res.status(403).json({ error: 'Solo la secretaría o un administrador pueden importar el horario oficial.' });
  }
  try {
    const school = res.locals.user.school;
    if (!school) return res.status(400).json({ error: 'Tu usuario no tiene escuela asignada.' });
    const { cursos, errores } = O.validarDocumento(req.body);
    if (errores.length) return res.status(400).json({ error: 'El archivo tiene errores. No se importó nada.', errores: errores.slice(0, 50) });

    const fuente = String((req.body && req.body.fuente) || '').slice(0, 300);
    await HorarioOficial.deleteMany({ school });
    await HorarioOficial.insertMany(cursos.map(c => ({ ...c, school, fuente, importadoPor: res.locals.user._id })));
    const renglones = cursos.reduce((a, c) => a + c.entradas.length, 0);
    logAudit(req, 'secretaria.oficial_importar', [], { cursos: cursos.length, renglones });
    res.json({ ok: true, cursos: cursos.length, renglones });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo importar. Probá de nuevo.' });
  }
});

// POST /secretaria/curso/:divisionId/celda — body { dia, turno, orden, courseId | null } (RH-02).
router.post('/curso/:divisionId/celda', async (req, res) => {
  if (idMalo(req, res, 'Acceso denegado', { como: 'json', param: 'divisionId' })) return;
  if (!puedeCargarHorario(res.locals.user)) {
    return res.status(403).json({ error: 'No tenés permiso para cargar horarios.' });
  }
  const school = res.locals.user.school;
  if (!school || !inScope(req, req.params.divisionId)) return res.status(403).json({ error: 'Acceso denegado' });
  try {
    const { dia, turno, orden } = req.body || {};
    const courseId = (req.body || {}).courseId || null;
    const grilla = await Horario.findOne({ school }).lean();
    const v = P.validarHorarioClases([{ dia, turno, orden }], grilla);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const celda = v.entradas[0];

    const materias = await Course.find({ division: oid(req.params.divisionId) }).select('name horarioClases').lean();
    if (courseId && !materias.some(m => String(m._id) === String(courseId))) {
      return res.status(400).json({ error: 'Esa materia no es de este curso' });
    }
    const cambios = H.aplicarCelda(materias.map(m => ({ id: String(m._id), horarioClases: m.horarioClases })), celda, courseId);
    if (cambios.length) {
      await Course.bulkWrite(cambios.map(c => ({
        updateOne: { filter: { _id: oid(c.id) }, update: { $set: { horarioClases: c.horarioClases } } },
      })));
      const nombreDe = new Map(materias.map(m => [String(m._id), m.name]));
      for (const c of cambios) {
        logAudit(req, 'course.horario_clases', [{ type: 'course', id: c.id, name: nombreDe.get(c.id) || '' }],
          { modulos: c.horarioClases.length, desde: 'grilla' });
      }
    }
    res.json({ ok: true, cambios: cambios.length });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar el horario' });
  }
});

module.exports = router;
// El panel del Jefe de Taller arma el mismo "Docentes del día" con los MEP (specs/jefe-de-taller.spec.md, RN-F1-3).
module.exports.filasDelDia = filasDelDia;
