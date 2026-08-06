// Panel del rol Jefe de Sección — /jefatura
//
// Qué es: seguimiento de la producción docente dentro de una SECCIÓN (models/Section.js),
// que es un recorte del establecimiento armado a mano por el admin — divisiones enteras
// mezcladas con materias sueltas. El jefe ve las actividades que publican los docentes de
// esas materias, quién entregó y con qué nota.
//
// ES UN PANEL DE SOLO LECTURA. No hay ni un POST en este archivo, a propósito: el rol se
// definió así. Agregar uno cambia la naturaleza del rol y hay que decidirlo explícitamente,
// no de pasada.
//
// REGLA: toda ruta con un :id valida contra el alcance (materiaEnScope / docenteEnScope).
// Que algo no aparezca en la grilla no impide que alguien escriba el id en la URL, y acá
// lo que hay del otro lado son notas de alumnos.
//
// ATRIBUCIÓN: se cuenta por Activity.author, NO por Course.owner. El pedido fue ver "las
// actividades que HAGAN los docentes": importa quién hizo el trabajo, no quién figura como
// titular, así que un suplente que sostiene la materia aparece con su producción y no en
// cero. Es una divergencia consciente con routes/directivo.js, que en sus columnas de
// conteo atribuye la materia al owner (ver el comentario largo en directivo.js:644).

const express    = require('express');
const mongoose   = require('mongoose');
const Course     = require('../models/Course');
const Division   = require('../models/Division');
const Activity   = require('../models/Activity');
const Submission = require('../models/Submission');
const User       = require('../models/User');
const { requireAuth }   = require('../middleware/auth');
const { sectionGuard }  = require('../middleware/sections');
const {
  requireJefe, loadJefaturaScope, materiaEnScope, docenteEnScope,
} = require('../middleware/jefatura');
// Ventana de la serie mensual, compartida con routes/directivo.js para que el mismo docente
// no se vea con meses distintos según qué panel lo mire.
const {
  inicioVentanaSerie, etiquetasMeses, mesCorto, serieDesdeConteos,
} = require('../services/serieMensual');

const router = express.Router();

// Mismo orden que routes/preceptor.js: sectionGuard va ANTES del loader de alcance para no
// pagar sus dos queries en un request que va a terminar en 403 igual.
router.use(requireAuth, requireJefe, sectionGuard('jefatura'), loadJefaturaScope);

const LIMIT = 25;
const oid   = (id) => new mongoose.Types.ObjectId(id);

// Pantalla de "no tenés alcance". Es lo que ve un jefe recién creado al que todavía nadie
// puso en una sección — que es el estado por defecto, porque el rol se puede asignar por
// caminos que no preguntan por secciones.
function sinAlcance(req, res, activePage) {
  const motivo = !res.locals.user.school
    ? 'sin-escuela'
    : (req.scopeSections.length ? 'secciones-vacias' : 'sin-secciones');
  return res.render('jefatura/no-scope', { motivo, activePage });
}

// Las opciones de los dos <select> del filtro y las materias del alcance con sus docentes.
// Se resuelve en una sola pasada sobre las materias del alcance porque de ahí salen las
// tres cosas: las divisiones, los docentes y el mapa materia → división.
async function contextoDelAlcance(req) {
  const materias = await Course.find({ _id: { $in: req.scopeCourseIds } })
    .select('_id name division owner coTeachers').lean();

  const divisionIds = [...new Set(materias.map(m => m.division).filter(Boolean).map(String))];
  const docenteIds  = [...new Set(
    materias.flatMap(m => [m.owner, ...(m.coTeachers || [])]).filter(Boolean).map(String)
  )];

  const [divisiones, docentes] = await Promise.all([
    Division.find({ _id: { $in: divisionIds } }).sort({ name: 1 }).select('_id name').lean(),
    User.find({ _id: { $in: docenteIds } }).sort({ name: 1 }).select('_id name email active').lean(),
  ]);

  return { materias, divisiones, docentes };
}

/* ─── Actividades (pantalla de entrada) ─────────────────────────────────────
   A diferencia del panel del directivo —que trae todo a memoria y pagina en JS— acá los
   filtros se expresan en Mongo y se pagina con skip/limit. El único conteo que cuesta una
   query aparte es el de entregas, y se hace SOLO sobre las 25 actividades de la página.  */
router.get('/', async (req, res, next) => {
  try {
    if (!req.scopeCourseIds.length) return sinAlcance(req, res, 'actividades');

    const { materias, divisiones, docentes } = await contextoDelAlcance(req);
    const { search, division: divisionFiltro, docente: docenteFiltro, estado } = req.query;
    const sort = req.query.sort === 'vencimiento' ? 'vencimiento' : 'recientes';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const now  = new Date();

    // Filtro por curso: se intersecta el alcance con las materias de esa división. Si el
    // id no es del alcance, la intersección queda vacía y no se filtra nada de más.
    let idsMaterias = req.scopeCourseIds;
    if (divisionFiltro) {
      idsMaterias = materias
        .filter(m => String(m.division) === divisionFiltro)
        .map(m => m._id.toString());
    }

    const filtro = { course: { $in: idsMaterias.map(oid) } };
    if (search) filtro.title = { $regex: search, $options: 'i' };
    if (docenteFiltro && mongoose.isValidObjectId(docenteFiltro)) filtro.author = oid(docenteFiltro);

    // Los tres estados se expresan en Mongo para poder paginar de verdad. "Sin calificar"
    // es el que importa: vencida y sin una sola nota puesta.
    if (estado === 'sin-calificar')  Object.assign(filtro, { dueDate: { $lt: now, $ne: null }, grades: { $size: 0 } });
    else if (estado === 'vencidas')  Object.assign(filtro, { dueDate: { $lt: now, $ne: null } });
    else if (estado === 'en-curso')  filtro.$or = [{ dueDate: null }, { dueDate: { $gte: now } }];

    const orden = sort === 'vencimiento'
      ? { dueDate: -1 }   // descendente deja las "sin fecha" al final (Mongo las ordena como el mínimo)
      : { createdAt: -1 };

    const [total, actividades] = await Promise.all([
      Activity.countDocuments(filtro),
      Activity.find(filtro)
        .select('_id title type dueDate createdAt grades course author')
        .populate({ path: 'course', select: 'name division', populate: { path: 'division', select: 'name' } })
        .populate('author', 'name')
        .sort(orden)
        .skip((page - 1) * LIMIT)
        .limit(LIMIT)
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / LIMIT));

    // Entregas solo de esta página: es lo que hace que el listado no dependa del tamaño de
    // la sección. Mismo aggregate que usa routes/activities.js para los chips del docente.
    const conteos = actividades.length
      ? await Submission.aggregate([
          { $match: { activity: { $in: actividades.map(a => a._id) } } },
          { $group: { _id: '$activity', n: { $sum: 1 } } },
        ])
      : [];
    const entregasPorActividad = Object.fromEntries(conteos.map(c => [c._id.toString(), c.n]));

    const filas = actividades.map(a => ({
      _id:        a._id,
      title:      a.title,
      type:       a.type,
      courseName: a.course?.name || '—',
      divisionName: a.course?.division?.name || '—',
      docente:    a.author?.name || 'Sin docente',
      dueDate:    a.dueDate,
      overdue:    !!a.dueDate && a.dueDate < now,
      submitted:  entregasPorActividad[a._id.toString()] || 0,
      graded:     (a.grades || []).length,
    }));

    const queryParams = {
      ...(search && { search }),
      ...(divisionFiltro && { division: divisionFiltro }),
      ...(docenteFiltro && { docente: docenteFiltro }),
      ...(estado && { estado }),
      ...(req.query.sort && { sort }),
    };

    res.render('jefatura/activities', {
      actividades: filas, divisiones, docentes,
      search: search || '', divisionFiltro: divisionFiltro || '',
      docenteFiltro: docenteFiltro || '', estado: estado || '', sort,
      page: Math.min(page, totalPages), totalPages, total, queryParams,
      secciones: req.scopeSections, activePage: 'actividades',
    });
  } catch (err) { next(err); }
});

/* ─── Entregas de una actividad ─────────────────────────────────────────────
   Se lista la NÓMINA COMPLETA de la materia, no solo los que entregaron: para un jefe de
   sección el dato que importa es justamente quién NO entregó. Los alumnos que se
   incorporaron después del vencimiento se marcan aparte (enrollmentDates), porque figurar
   como "sin entregar" una tarea que venció antes de su alta sería mentir.

   Acá es donde el rol ve notas de alumnos. Está acotado por diseño: se llega solo desde una
   actividad de una materia de sus secciones, no hay buscador de alumnos ni ficha personal,
   y no se exponen datos de contacto.                                                      */
router.get('/actividades/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Actividad no encontrada');

    const actividad = await Activity.findById(req.params.id)
      .populate({ path: 'course', select: 'name division students enrollmentDates', populate: { path: 'division', select: 'name' } })
      .populate('author', 'name email')
      .lean();
    if (!actividad) return res.status(404).send('Actividad no encontrada');
    if (!materiaEnScope(req, actividad.course?._id)) return res.status(403).send('Acceso denegado');

    const alumnos = await User.find({ _id: { $in: actividad.course.students || [] }, role: 'student' })
      .sort({ name: 1 }).select('_id name email active').lean();

    const entregas = await Submission.find({ activity: actividad._id })
      .select('student firstSubmittedAt createdAt files text').lean();
    const entregaPorAlumno = Object.fromEntries(entregas.map(s => [s.student.toString(), s]));
    const notaPorAlumno    = Object.fromEntries(
      (actividad.grades || []).map(g => [g.student.toString(), g])
    );

    const vence  = actividad.dueDate ? new Date(actividad.dueDate) : null;
    const altas  = actividad.course.enrollmentDates || {};

    const filas = alumnos.map(a => {
      const clave   = a._id.toString();
      const entrega = entregaPorAlumno[clave];
      const nota    = notaPorAlumno[clave];
      const cuando  = entrega ? new Date(entrega.firstSubmittedAt || entrega.createdAt) : null;
      const alta    = altas[clave] ? new Date(altas[clave]) : null;

      return {
        nombre:  a.name,
        activo:  a.active !== false,
        entrego: !!entrega,
        cuando,
        tarde:   !!(cuando && vence && cuando > vence),
        // Se incorporó después de que venciera: no se le puede reprochar la falta.
        tardio:  !entrega && !!(alta && vence && alta > vence),
        nota:    nota ? nota.points : null,
        feedback: nota ? nota.feedback : '',
      };
    });

    const resumen = {
      alumnos:      filas.length,
      entregaron:   filas.filter(f => f.entrego).length,
      tarde:        filas.filter(f => f.tarde).length,
      calificadas:  filas.filter(f => f.nota !== null).length,
      sinEntregar:  filas.filter(f => !f.entrego && !f.tardio).length,
    };

    res.render('jefatura/activity-submissions', {
      actividad, filas, resumen, vence,
      secciones: req.scopeSections, activePage: 'actividades',
    });
  } catch (err) { next(err); }
});

/* ─── Docentes de la sección ───────────────────────────────────────────────── */
router.get('/docentes', async (req, res, next) => {
  try {
    if (!req.scopeCourseIds.length) return sinAlcance(req, res, 'docentes');

    const { materias, docentes } = await contextoDelAlcance(req);
    const now       = new Date();
    const desdeMes  = new Date(now.getFullYear(), now.getMonth(), 1);
    const search    = (req.query.search || '').trim();
    const sort      = ['acts-desc', 'nombre'].includes(req.query.sort) ? req.query.sort : 'pendientes';
    const page      = Math.max(1, parseInt(req.query.page) || 1);

    // Materias del alcance por docente (titular O suplente). El conteo de actividades, en
    // cambio, va por Activity.author — ver la nota de atribución al principio del archivo.
    const materiasPorDocente = new Map();
    for (const m of materias) {
      for (const t of [m.owner, ...(m.coTeachers || [])].filter(Boolean)) {
        const k = t.toString();
        if (!materiasPorDocente.has(k)) materiasPorDocente.set(k, []);
        materiasPorDocente.get(k).push(m);
      }
    }

    const idsAlcance = req.scopeCourseIds.map(oid);
    const [porAutor, delMes, pendientes, ultimas] = await Promise.all([
      Activity.aggregate([
        { $match: { course: { $in: idsAlcance } } },
        { $group: { _id: '$author', n: { $sum: 1 } } },
      ]),
      Activity.aggregate([
        { $match: { course: { $in: idsAlcance }, createdAt: { $gte: desdeMes } } },
        { $group: { _id: '$author', n: { $sum: 1 } } },
      ]),
      Activity.aggregate([
        { $match: { course: { $in: idsAlcance }, dueDate: { $lt: now, $ne: null }, grades: { $size: 0 } } },
        { $group: { _id: '$author', n: { $sum: 1 } } },
      ]),
      Activity.aggregate([
        { $match: { course: { $in: idsAlcance } } },
        { $group: { _id: '$author', ultima: { $max: '$createdAt' } } },
      ]),
    ]);
    const mapa = (arr, campo = 'n') => Object.fromEntries(arr.map(x => [String(x._id), x[campo]]));
    const totalPorAutor = mapa(porAutor);
    const mesPorAutor   = mapa(delMes);
    const pendPorAutor  = mapa(pendientes);
    const ultimaPorAutor = mapa(ultimas, 'ultima');

    let filas = docentes.map(d => {
      const k = d._id.toString();
      return {
        _id:         d._id,
        nombre:      d.name,
        activo:      d.active !== false,
        materias:    (materiasPorDocente.get(k) || []).length,
        actividades: totalPorAutor[k]  || 0,
        delMes:      mesPorAutor[k]    || 0,
        pendientes:  pendPorAutor[k]   || 0,
        ultima:      ultimaPorAutor[k] || null,
      };
    });

    if (search) {
      const q = search.toLowerCase();
      filas = filas.filter(f => f.nombre.toLowerCase().includes(q));
    }

    // Por defecto: los que más actividades vencidas sin calificar tienen. Es el orden por
    // el que un jefe de sección abre esta pantalla.
    if (sort === 'acts-desc')    filas.sort((a, b) => b.actividades - a.actividades);
    else if (sort === 'nombre')  filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    else                         filas.sort((a, b) => b.pendientes - a.pendientes || b.actividades - a.actividades);

    const total      = filas.length;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const safePage   = Math.min(page, totalPages);

    res.render('jefatura/teachers', {
      docentes: filas.slice((safePage - 1) * LIMIT, safePage * LIMIT),
      search, sort, page: safePage, totalPages, total,
      queryParams: { ...(search && { search }), ...(req.query.sort && { sort }) },
      secciones: req.scopeSections, activePage: 'docentes',
    });
  } catch (err) { next(err); }
});

/* ─── Ficha de un docente ───────────────────────────────────────────────────
   Molde de GET /directivo/teachers/:id, pero ACOTADO al alcance: sus materias son las de
   la sección, no todas las que dicta en la escuela, y sus actividades son las que publicó
   en esas materias. Un mismo docente puede verse distinto desde dos secciones, y está bien:
   cada jefe ve lo que pasa en la suya.                                                    */
router.get('/docentes/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Docente no encontrado');
    if (!await docenteEnScope(req, req.params.id)) return res.status(403).send('Acceso denegado');

    const docente = await User.findById(req.params.id).select('_id name email active role').lean();
    if (!docente) return res.status(404).send('Docente no encontrado');

    const materias = await Course.find({
      _id: { $in: req.scopeCourseIds },
      $or: [{ owner: docente._id }, { coTeachers: docente._id }],
    }).populate('division', 'name').select('_id name division students owner').lean();

    const idsMaterias = materias.map(m => m._id);
    const now = new Date();

    const actividades = await Activity.find({ course: { $in: idsMaterias }, author: docente._id })
      .select('_id title dueDate createdAt grades course')
      .populate('course', 'name')
      .sort({ createdAt: -1 })
      .lean();

    const conteos = actividades.length
      ? await Submission.aggregate([
          { $match: { activity: { $in: actividades.map(a => a._id) } } },
          { $group: { _id: '$activity', n: { $sum: 1 } } },
        ])
      : [];
    const entregasPorActividad = Object.fromEntries(conteos.map(c => [c._id.toString(), c.n]));

    const filas = actividades.map(a => ({
      _id:        a._id,
      title:      a.title,
      courseName: a.course?.name || '—',
      dueDate:    a.dueDate,
      overdue:    !!a.dueDate && a.dueDate < now,
      submitted:  entregasPorActividad[a._id.toString()] || 0,
      graded:     (a.grades || []).length,
    }));

    // Serie mensual: creadas (por autoría) contra corregidas (por fecha de calificación).
    const desde  = inicioVentanaSerie();
    const meses  = etiquetasMeses(desde);
    const [creadas, corregidas] = await Promise.all([
      Activity.aggregate([
        { $match: { course: { $in: idsMaterias }, author: docente._id, createdAt: { $gte: desde } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      Activity.aggregate([
        { $match: { course: { $in: idsMaterias }, author: docente._id } },
        { $unwind: '$grades' },
        { $match: { 'grades.gradedAt': { $gte: desde } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$grades.gradedAt' } }, n: { $sum: 1 } } },
      ]),
    ]);
    const aMapa = (arr) => Object.fromEntries(arr.map(x => [x._id, x.n]));

    const alumnos = new Set(materias.flatMap(m => (m.students || []).map(String)));

    res.render('jefatura/teacher-detail', {
      docente,
      materias: materias.map(m => ({
        _id: m._id, nombre: m.name,
        division: m.division?.name || '—',
        alumnos: (m.students || []).length,
        esTitular: String(m.owner) === String(docente._id),
      })),
      actividades: filas,
      stats: {
        materias: materias.length,
        alumnos: alumnos.size,
        actividades: filas.length,
        pendientes: filas.filter(a => a.overdue && a.graded === 0).length,
      },
      serie: {
        meses: meses.map(mesCorto),
        creadas:    serieDesdeConteos(meses, aMapa(creadas)),
        corregidas: serieDesdeConteos(meses, aMapa(corregidas)),
      },
      secciones: req.scopeSections, activePage: 'docentes',
    });
  } catch (err) { next(err); }
});

module.exports = router;
