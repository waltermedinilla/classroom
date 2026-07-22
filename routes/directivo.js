const express  = require('express');
const mongoose = require('mongoose');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Division = require('../models/Division');
const Activity = require('../models/Activity');
const Submission = require('../models/Submission');
const { requireAuth }      = require('../middleware/auth');
const { requireDirectivo } = require('../middleware/directivo');

const router = express.Router();
router.use(requireAuth, requireDirectivo);

// Convierte un string a ObjectId (para pipelines de aggregate, donde el $match requiere
// el tipo exacto — a diferencia de find, que castea automáticamente).
const oid = (id) => new mongoose.Types.ObjectId(id.toString());

/* ─── Dashboard (A1) ─────────────────────────────────────────────────────── */
// Panorama institucional: 6 tarjetas de conteos + 3 secciones "requiere atención".
// Todas las queries scoped a la escuela del usuario (multi-tenant).
router.get('/', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.render('directivo/no-school');

  const monthAgo      = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
  const twoWeeksAgo   = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const now           = new Date();

  try {
    const [
      studentCount, teacherCount, courseCount, divisionCount,
      connectedNow, newLastMonth,
    ] = await Promise.all([
      User.countDocuments({ school, role: 'student' }),
      User.countDocuments({ school, role: 'teacher' }),
      Course.countDocuments({ school }),
      Division.countDocuments({ school }),
      User.countDocuments({ school, lastSeen: { $gte: fifteenMinAgo } }),
      User.countDocuments({ school, createdAt: { $gte: monthAgo } }),
    ]);

    // "Cursos sin docente" — en el schema el owner es requerido, así que interpretamos
    // como "cursos cuyo docente está deshabilitado" (owner válido pero inactivo).
    // Se hace en dos pasos para evitar populate con match que puede ser costoso.
    // Incluye admins porque el schema Course permite que un admin sea dueño (ver routes/admin.js).
    const inactiveTeacherIds = await User.find({
      school, role: { $in: ['teacher', 'admin'] }, active: false,
    }).distinct('_id');
    const orphanedCourses = inactiveTeacherIds.length
      ? await Course.countDocuments({ school, owner: { $in: inactiveTeacherIds } })
      : 0;

    // "Alumnos sin matricular" — students que no aparecen en ningún Course.students.
    const enrolledIds = await Course.find({ school }).distinct('students');
    const enrolledSet = new Set(enrolledIds.map(String));
    const allStudents = await User.find({ school, role: 'student', active: true }).select('_id');
    const unenrolledCount = allStudents.filter(s => !enrolledSet.has(s._id.toString())).length;

    // "Actividades vencidas sin calificar hace > 15 días" — para cursos de esta escuela.
    // Sin calificar = grades.length === 0. Vencidas hace > 15 días = dueDate < twoWeeksAgo.
    const schoolCourseIds = await Course.find({ school }).distinct('_id');
    const overdueUngradedCount = await Activity.countDocuments({
      course:  { $in: schoolCourseIds },
      dueDate: { $ne: null, $lt: twoWeeksAgo },
      grades:  { $size: 0 },
    });

    res.render('directivo/dashboard', {
      stats: {
        studentCount, teacherCount, courseCount, divisionCount,
        connectedNow, newLastMonth,
      },
      attention: {
        orphanedCourses,     // Cursos con docente deshabilitado
        unenrolledCount,     // Alumnos sin matricular
        overdueUngradedCount // Actividades vencidas sin calificar hace > 15 días
      },
      activePage: 'dashboard',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Listado de cursos con métricas (A2) ────────────────────────────────── */
// Una fila por curso con: # actividades, # alumnos, tasa de entrega, actividades vencidas sin calificar.
// Filtros: búsqueda por nombre, por división. Orden: por tasa de entrega ascendente
// (los "flojos" arriba, que es lo primero que un directivo quiere ver).
router.get('/courses', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.render('directivo/no-school');

  const { search, division: divisionFilter, sort = 'rate-asc' } = req.query;
  const now  = new Date();
  const LIMIT = 25;
  const page  = Math.max(1, parseInt(req.query.page) || 1);

  try {
    // Match inicial sobre Course, luego lookup a activities y submissions.
    // Un solo aggregate para no hacer N+3 queries por curso.
    const match = { school: oid(school) };
    if (divisionFilter) match.division = oid(divisionFilter);
    if (search) match.name = { $regex: search, $options: 'i' };

    const courses = await Course.aggregate([
      { $match: match },
      { $lookup: { from: 'activities', localField: '_id', foreignField: 'course', as: 'acts' } },
      { $lookup: {
          from: 'submissions',
          let: { actIds: '$acts._id' },
          pipeline: [{ $match: { $expr: { $in: ['$activity', '$$actIds'] } } }],
          as: 'subs',
      } },
      { $lookup: { from: 'users',     localField: 'owner',    foreignField: '_id', as: 'ownerDoc' } },
      { $lookup: { from: 'divisions', localField: 'division', foreignField: '_id', as: 'divisionDoc' } },
      { $project: {
          name: 1,
          studentCount:    { $size: { $ifNull: ['$students', []] } },
          activityCount:   { $size: '$acts' },
          submissionCount: { $size: '$subs' },
          // Actividades vencidas (dueDate < ahora) sin ninguna calificación cargada
          overdueUngraded: { $size: { $filter: {
            input: '$acts',
            cond: { $and: [
              { $ne: ['$$this.dueDate', null] },
              { $lt: ['$$this.dueDate', now] },
              { $eq: [{ $size: { $ifNull: ['$$this.grades', []] } }, 0] },
            ] },
          } } },
          owner:    { $arrayElemAt: ['$ownerDoc', 0] },
          division: { $arrayElemAt: ['$divisionDoc', 0] },
      } },
      { $project: {
          name: 1, studentCount: 1, activityCount: 1, submissionCount: 1, overdueUngraded: 1,
          'owner._id': 1, 'owner.name': 1, 'owner.active': 1,
          'division._id': 1, 'division.name': 1,
      } },
    ]);

    // Cálculo de tasa de entrega en JS para poder ordenar arbitrariamente
    // (evita ramas complicadas en el aggregate por división por cero).
    courses.forEach(c => {
      const expected = c.activityCount * c.studentCount;
      c.expectedSubmissions = expected;
      c.deliveryRate = expected > 0 ? Math.round((c.submissionCount / expected) * 100) : null;
    });

    // Orden: 'rate-asc' (default, los peores arriba), 'rate-desc', 'name'
    if (sort === 'name') {
      courses.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    } else if (sort === 'rate-desc') {
      courses.sort((a, b) => (b.deliveryRate ?? -1) - (a.deliveryRate ?? -1));
    } else {
      // Cursos sin actividades (rate=null) van al final
      courses.sort((a, b) => {
        if (a.deliveryRate === null && b.deliveryRate === null) return 0;
        if (a.deliveryRate === null) return 1;
        if (b.deliveryRate === null) return -1;
        return a.deliveryRate - b.deliveryRate;
      });
    }

    const divisions = await Division.find({ school }).sort({ name: 1 }).select('_id name');

    // Paginación en JS: ya ordenamos toda la lista según prioridad, ahora slice() a la página.
    // Se hace después del ordenamiento para preservar "peores tasas primero" a nivel escuela.
    // El clamp de `safePage` evita el "Mostrando 24951–485" cuando el usuario pide una página fuera de rango.
    const total      = courses.length;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const safePage   = Math.min(page, totalPages);
    const pageStart  = (safePage - 1) * LIMIT;
    const pageCourses = courses.slice(pageStart, pageStart + LIMIT);

    res.render('directivo/courses', {
      courses: pageCourses,
      divisions,
      search:         search || '',
      divisionFilter: divisionFilter || '',
      sort,
      page: safePage, totalPages, total,
      queryParams: { ...(search && { search }), ...(divisionFilter && { division: divisionFilter }), sort },
      activePage: 'courses',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Detalle read-only de un curso ──────────────────────────────────────── */
// Lista de actividades del curso con estado (¿venció? ¿cuántos entregaron? ¿cuántos calificados?)
// y lista de alumnos con su tasa de entrega individual.
router.get('/courses/:id', async (req, res) => {
  const school = res.locals.user.school;
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner',    'name email active')
      .populate('division', 'name')
      .populate('students', 'name email dni active');
    if (!course) return res.status(404).send('Curso no encontrado');
    if (school && course.school?.toString() !== school.toString()) {
      return res.status(403).send('Acceso denegado');
    }

    const activities = await Activity.find({ course: course._id }).sort({ createdAt: -1 });
    const activityIds = activities.map(a => a._id);
    const submissions = await Submission.find({ activity: { $in: activityIds } })
      .select('activity student');

    // Cruces: por actividad (cuántos entregaron) y por alumno (cuántas entregó de las totales)
    const now = new Date();
    const submissionsByActivity = {};
    const submissionsByStudent  = {};
    submissions.forEach(s => {
      const aid = s.activity.toString();
      const sid = s.student.toString();
      submissionsByActivity[aid] = (submissionsByActivity[aid] || 0) + 1;
      submissionsByStudent[sid]  = (submissionsByStudent[sid]  || 0) + 1;
    });

    const activitiesWithStats = activities.map(act => {
      const submitted = submissionsByActivity[act._id.toString()] || 0;
      const graded    = act.grades.length;
      const overdue   = act.dueDate && act.dueDate < now;
      return {
        _id: act._id, title: act.title, type: act.type, points: act.points,
        dueDate: act.dueDate, availableFrom: act.availableFrom,
        submitted, graded, overdue,
        totalStudents: course.students.length,
      };
    });

    const studentsWithStats = course.students.map(s => {
      const submitted = submissionsByStudent[s._id.toString()] || 0;
      return {
        _id: s._id, name: s.name, email: s.email, dni: s.dni, active: s.active,
        submitted,
        totalActivities: activities.length,
        deliveryRate: activities.length > 0 ? Math.round((submitted / activities.length) * 100) : null,
      };
    });

    res.render('directivo/course-detail', {
      course,
      activities: activitiesWithStats,
      students:   studentsWithStats,
      activePage: 'courses',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── M1 · Promedios por curso y por división ────────────────────────────── */
// Calcula el promedio ponderado (normalizado a 0-10) de cada curso y de cada división.
// Normalización: cada nota `points` se divide por `activity.points` (el máximo) y se
// multiplica por 10. Actividades con `points: null` (sin puntaje definido) se descartan
// porque no se pueden normalizar. Distribución en buckets: <4, 4-6, 6-8, 8-10.
router.get('/grades', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.render('directivo/no-school');

  try {
    // Aggregate único desde Activity, desenrollando grades[] y cruzando con Course
    // para poder agrupar por curso y por división en una sola pasada.
    const rows = await Activity.aggregate([
      { $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseDoc' } },
      { $unwind: '$courseDoc' },
      { $match: { 'courseDoc.school': oid(school), points: { $ne: null, $gt: 0 } } },
      { $unwind: '$grades' },
      // Nota normalizada 0-10: (points_obtenidos / points_maximos) * 10
      { $project: {
          courseId:   '$courseDoc._id',
          courseName: '$courseDoc.name',
          divisionId: '$courseDoc.division',
          teacherId:  '$courseDoc.owner',
          normalized: { $multiply: [{ $divide: ['$grades.points', '$points'] }, 10] },
      } },
    ]);

    // Cálculos en JS: promedio y distribución en buckets, agrupando por curso y por división.
    // Se hace en JS (no en el pipeline) porque los buckets requieren lógica condicional
    // que en aggregate quedaría muy verbosa y el volumen de rows es acotado.
    const byCourse   = new Map();
    const byDivision = new Map();

    const emptyBuckets = () => ({ b0: 0, b1: 0, b2: 0, b3: 0 }); // <4, 4-6, 6-8, 8-10
    const addBucket = (obj, val) => {
      if      (val < 4)  obj.b0++;
      else if (val < 6)  obj.b1++;
      else if (val < 8)  obj.b2++;
      else               obj.b3++;
    };

    rows.forEach(r => {
      const cKey = r.courseId.toString();
      if (!byCourse.has(cKey)) byCourse.set(cKey, {
        courseId: r.courseId, courseName: r.courseName,
        divisionId: r.divisionId, teacherId: r.teacherId,
        sum: 0, count: 0, buckets: emptyBuckets(),
      });
      const c = byCourse.get(cKey);
      c.sum += r.normalized; c.count++;
      addBucket(c.buckets, r.normalized);

      const dKey = r.divisionId.toString();
      if (!byDivision.has(dKey)) byDivision.set(dKey, {
        divisionId: r.divisionId, sum: 0, count: 0, buckets: emptyBuckets(),
      });
      const d = byDivision.get(dKey);
      d.sum += r.normalized; d.count++;
      addBucket(d.buckets, r.normalized);
    });

    // Enriquecemos con nombre de división y docente en un solo populate manual.
    // Los admins también pueden ser owner de un curso (ver routes/admin.js), sin incluirlos
    // acá la columna "Docente" quedaba en "—" para esos cursos.
    const [divisions, teachers] = await Promise.all([
      Division.find({ school }).select('_id name').lean(),
      User.find({ school, role: { $in: ['teacher', 'admin'] } }).select('_id name').lean(),
    ]);
    const divisionName = Object.fromEntries(divisions.map(d => [d._id.toString(), d.name]));
    const teacherName  = Object.fromEntries(teachers.map(t  => [t._id.toString(),  t.name]));

    const coursesByAvg = [...byCourse.values()].map(c => ({
      courseId: c.courseId, name: c.courseName,
      division: divisionName[c.divisionId?.toString()] || '—',
      teacher:  teacherName[c.teacherId?.toString()]   || '—',
      avg:      Math.round((c.sum / c.count) * 10) / 10,
      count:    c.count,
      buckets:  c.buckets,
    })).sort((a, b) => a.avg - b.avg); // peores promedios primero

    const divisionsByAvg = [...byDivision.values()].map(d => ({
      name:    divisionName[d.divisionId?.toString()] || '—',
      avg:     Math.round((d.sum / d.count) * 10) / 10,
      count:   d.count,
      buckets: d.buckets,
    })).sort((a, b) => a.name.localeCompare(b.name, 'es'));

    // Promedio global de la escuela
    const totalCount = rows.length;
    const totalSum   = rows.reduce((a, r) => a + r.normalized, 0);
    const schoolAvg  = totalCount ? Math.round((totalSum / totalCount) * 10) / 10 : null;

    res.render('directivo/grades', {
      coursesByAvg, divisionsByAvg,
      schoolAvg, totalCount,
      activePage: 'grades',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── M2 · Alumnos con foco de atención ──────────────────────────────────── */
// Lista todos los alumnos de la escuela con métricas clave del último mes:
// entregas hechas, tardías, promedio normalizado 0-10. Etiqueta con estado:
//   - Bajo rendimiento (promedio < 6)
//   - Silencioso (0 entregas en el mes)
//   - Muchas tardías (>30% de sus entregas están fuera de plazo)
// Filtro `?estado=bajo|silencioso|tardias` limita a un solo estado.
router.get('/students', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.render('directivo/no-school');

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filter   = req.query.estado || '';
  const LIMIT    = 25;
  const page     = Math.max(1, parseInt(req.query.page) || 1);

  try {
    const students = await User.find({ school, role: 'student', active: true })
      .select('_id name email dni').lean();
    const studentIds = students.map(s => s._id);
    if (!studentIds.length) {
      return res.render('directivo/students', {
        students: [], counts: { bajo: 0, silencioso: 0, tardias: 0, total: 0 },
        filter, page: 1, totalPages: 1, total: 0,
        queryParams: { ...(filter && { estado: filter }) },
        activePage: 'students',
      });
    }

    // Aggregate 1: entregas del último mes por alumno (rápido, index {student, createdAt})
    const monthlySubs = await Submission.aggregate([
      { $match: { student: { $in: studentIds }, createdAt: { $gte: monthAgo } } },
      { $group: { _id: '$student', count: { $sum: 1 } } },
    ]);
    const monthlyCountByStudent = Object.fromEntries(monthlySubs.map(s => [s._id.toString(), s.count]));

    // Aggregate 2: entregas totales por alumno + cuántas fueron tardías
    // Se compara `updatedAt` (última modificación de la entrega, o sea el último reenvío)
    // contra `activity.dueDate`. Usar `createdAt` fallaría cuando un alumno entrega a tiempo
    // y después reenvía tarde: `createdAt` queda fijo en la primera entrega y no captura
    // esa tardanza. El schema Submission documenta que `updatedAt` refleja el último reenvío.
    const allSubs = await Submission.aggregate([
      { $match: { student: { $in: studentIds } } },
      { $lookup: { from: 'activities', localField: 'activity', foreignField: '_id', as: 'act' } },
      { $unwind: '$act' },
      { $project: {
          student: 1,
          isLate: {
            $and: [
              { $ne: ['$act.dueDate', null] },
              { $gt: ['$updatedAt', '$act.dueDate'] },
            ],
          },
      } },
      { $group: {
          _id: '$student',
          total: { $sum: 1 },
          late:  { $sum: { $cond: ['$isLate', 1, 0] } },
      } },
    ]);
    const totalByStudent = Object.fromEntries(allSubs.map(s => [s._id.toString(), s]));

    // Aggregate 3: promedio normalizado por alumno (mismo pattern que M1 pero agrupando por student)
    const gradeRows = await Activity.aggregate([
      { $lookup: { from: 'courses', localField: 'course', foreignField: '_id', as: 'courseDoc' } },
      { $unwind: '$courseDoc' },
      { $match: { 'courseDoc.school': oid(school), points: { $ne: null, $gt: 0 } } },
      { $unwind: '$grades' },
      { $match: { 'grades.student': { $in: studentIds } } },
      { $project: {
          student:    '$grades.student',
          normalized: { $multiply: [{ $divide: ['$grades.points', '$points'] }, 10] },
      } },
      { $group: {
          _id: '$student',
          sum:   { $sum: '$normalized' },
          count: { $sum: 1 },
      } },
    ]);
    const avgByStudent = Object.fromEntries(gradeRows.map(g => [g._id.toString(), g.sum / g.count]));

    // Compone la fila por alumno + calcula estado
    const rows = students.map(s => {
      const sid   = s._id.toString();
      const stats = totalByStudent[sid] || { total: 0, late: 0 };
      const avg   = avgByStudent[sid] != null ? Math.round(avgByStudent[sid] * 10) / 10 : null;
      const monthlyCount = monthlyCountByStudent[sid] || 0;
      const latePct      = stats.total > 0 ? Math.round((stats.late / stats.total) * 100) : 0;

      const flags = {
        bajo:       avg !== null && avg < 6,
        silencioso: monthlyCount === 0,
        tardias:    stats.total >= 3 && latePct > 30,
      };

      return {
        _id: s._id, name: s.name, email: s.email, dni: s.dni,
        monthlyCount, totalSubs: stats.total, lateSubs: stats.late, latePct,
        avg, flags,
      };
    });

    const counts = {
      bajo:       rows.filter(r => r.flags.bajo).length,
      silencioso: rows.filter(r => r.flags.silencioso).length,
      tardias:    rows.filter(r => r.flags.tardias).length,
      total:      rows.length,
    };

    let filtered = rows;
    if (filter === 'bajo')       filtered = rows.filter(r => r.flags.bajo);
    else if (filter === 'silencioso') filtered = rows.filter(r => r.flags.silencioso);
    else if (filter === 'tardias')    filtered = rows.filter(r => r.flags.tardias);

    // Orden: los que tienen problemas primero (más flags activos = más arriba)
    filtered.sort((a, b) => {
      const flagsA = Object.values(a.flags).filter(Boolean).length;
      const flagsB = Object.values(b.flags).filter(Boolean).length;
      if (flagsA !== flagsB) return flagsB - flagsA;
      return a.name.localeCompare(b.name, 'es');
    });

    // Paginación después del orden y filtrado. Los `counts` de arriba muestran totales
    // de TODA la escuela (para los chips) — independiente de la página actual.
    const total      = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const safePage   = Math.min(page, totalPages); // evita rangos "Mostrando N–M" fuera del array
    const pageStart  = (safePage - 1) * LIMIT;
    const pageStudents = filtered.slice(pageStart, pageStart + LIMIT);

    res.render('directivo/students', {
      students: pageStudents, counts, filter,
      page: safePage, totalPages, total,
      queryParams: { ...(filter && { estado: filter }) },
      activePage: 'students',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── M4 · Perfil read-only de alumno ────────────────────────────────────── */
router.get('/students/:id', async (req, res) => {
  const school = res.locals.user.school;
  try {
    const student = await User.findById(req.params.id).select('_id name email dni active role school createdAt');
    if (!student) return res.status(404).send('Alumno no encontrado');
    if (student.role !== 'student') return res.status(404).send('El usuario no es alumno');
    if (school && student.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');

    const courses = await Course.find({ students: student._id })
      .populate('owner', 'name')
      .populate('division', 'name')
      .select('_id name owner division');

    // Todas las entregas del alumno con actividad y curso populados
    const submissions = await Submission.find({ student: student._id })
      .populate({ path: 'activity', select: 'title dueDate points course grades',
                  populate: { path: 'course', select: 'name' } })
      .sort({ createdAt: -1 });

    // Para cada entrega calculamos si fue tardía y la nota (buscándola en activity.grades).
    // Usa `updatedAt` (último reenvío) — ver comentario en `/directivo/students` aggregate 2.
    const entries = submissions.filter(s => s.activity).map(sub => {
      const late = sub.activity.dueDate && sub.updatedAt > sub.activity.dueDate;
      const g = sub.activity.grades.find(g => g.student.toString() === student._id.toString());
      const normalized = g && sub.activity.points > 0
        ? Math.round(((g.points / sub.activity.points) * 10) * 10) / 10
        : null;
      return {
        activityTitle: sub.activity.title,
        courseName:    sub.activity.course?.name || '—',
        submittedAt:   sub.createdAt,
        dueDate:       sub.activity.dueDate,
        late,
        points:        g ? g.points : null,
        maxPoints:     sub.activity.points,
        normalized,
        feedback:      g ? (g.feedback || '') : '',
      };
    });

    const avgNormalized = entries.filter(e => e.normalized !== null).reduce((a, e, _, arr) =>
      a + e.normalized / arr.length, 0);
    const graded = entries.filter(e => e.normalized !== null).length;

    res.render('directivo/student-detail', {
      student, courses, entries,
      stats: {
        totalSubs: entries.length,
        graded,
        lateSubs: entries.filter(e => e.late).length,
        avg: graded ? Math.round(avgNormalized * 10) / 10 : null,
      },
      activePage: 'students',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── M3 · Actividad de docentes ─────────────────────────────────────────── */
// Lista todos los docentes de la escuela con: cursos que dictan, cantidad de alumnos
// atendidos, actividades publicadas último mes, entregas sin calificar hace > 15 días,
// promedio general normalizado de sus cursos.
router.get('/teachers', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.render('directivo/no-school');

  const monthAgo    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const LIMIT = 25;
  const page  = Math.max(1, parseInt(req.query.page) || 1);

  try {
    // Incluye admins: el schema Course permite que un admin sea dueño (ver routes/admin.js),
    // y sin ellos se perdían filas de docentes activos dictando cursos.
    const teachers = await User.find({ school, role: { $in: ['teacher', 'admin'] } })
      .select('_id name email role active').lean();

    // Cursos por docente (owner) para saber a cuántos alumnos y cursos "atiende" cada uno
    const courses = await Course.find({ school }).select('_id owner students').lean();
    const coursesByOwner = new Map();
    courses.forEach(c => {
      const key = c.owner.toString();
      if (!coursesByOwner.has(key)) coursesByOwner.set(key, { courseIds: [], studentSet: new Set() });
      const bag = coursesByOwner.get(key);
      bag.courseIds.push(c._id);
      c.students.forEach(sid => bag.studentSet.add(sid.toString()));
    });

    // Actividades del último mes por curso → mapeamos a docente
    const monthlyActs = await Activity.aggregate([
      { $match: { course: { $in: courses.map(c => c._id) }, createdAt: { $gte: monthAgo } } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]);
    const courseOwnerMap = Object.fromEntries(courses.map(c => [c._id.toString(), c.owner.toString()]));
    const monthlyByTeacher = {};
    monthlyActs.forEach(m => {
      const t = courseOwnerMap[m._id.toString()];
      if (t) monthlyByTeacher[t] = (monthlyByTeacher[t] || 0) + m.count;
    });

    // Actividades vencidas sin calificar hace > 15 días por docente
    const overdueActs = await Activity.aggregate([
      { $match: {
          course:  { $in: courses.map(c => c._id) },
          dueDate: { $ne: null, $lt: twoWeeksAgo },
          grades:  { $size: 0 },
      } },
      { $group: { _id: '$course', count: { $sum: 1 } } },
    ]);
    const overdueByTeacher = {};
    overdueActs.forEach(o => {
      const t = courseOwnerMap[o._id.toString()];
      if (t) overdueByTeacher[t] = (overdueByTeacher[t] || 0) + o.count;
    });

    // Promedio normalizado de las notas puestas por el docente (por sus cursos)
    const gradeRows = await Activity.aggregate([
      { $match: { course: { $in: courses.map(c => c._id) }, points: { $ne: null, $gt: 0 } } },
      { $unwind: '$grades' },
      { $project: {
          course: 1,
          normalized: { $multiply: [{ $divide: ['$grades.points', '$points'] }, 10] },
      } },
      { $group: {
          _id: '$course',
          sum:   { $sum: '$normalized' },
          count: { $sum: 1 },
      } },
    ]);
    const teacherAvgAgg = {}; // teacherId → { sum, count }
    gradeRows.forEach(g => {
      const t = courseOwnerMap[g._id.toString()];
      if (!t) return;
      if (!teacherAvgAgg[t]) teacherAvgAgg[t] = { sum: 0, count: 0 };
      teacherAvgAgg[t].sum   += g.sum;
      teacherAvgAgg[t].count += g.count;
    });

    const rows = teachers.map(t => {
      const bag  = coursesByOwner.get(t._id.toString()) || { courseIds: [], studentSet: new Set() };
      const agg  = teacherAvgAgg[t._id.toString()];
      return {
        _id: t._id, name: t.name, email: t.email, active: t.active,
        courseCount:  bag.courseIds.length,
        studentCount: bag.studentSet.size,
        monthlyActs:  monthlyByTeacher[t._id.toString()] || 0,
        overdueActs:  overdueByTeacher[t._id.toString()] || 0,
        avg:          agg && agg.count > 0 ? Math.round((agg.sum / agg.count) * 10) / 10 : null,
      };
    });

    // Ordena: los con más "sin calificar" arriba (foco de atención)
    rows.sort((a, b) => (b.overdueActs - a.overdueActs) || a.name.localeCompare(b.name, 'es'));

    // Paginación en JS (mismo criterio que courses/students)
    const total      = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / LIMIT));
    const safePage   = Math.min(page, totalPages); // clamp para page > totalPages
    const pageStart  = (safePage - 1) * LIMIT;
    const pageTeachers = rows.slice(pageStart, pageStart + LIMIT);

    res.render('directivo/teachers', {
      teachers: pageTeachers,
      page: safePage, totalPages, total,
      queryParams: {},
      activePage: 'teachers',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── M4 · Perfil read-only de docente ───────────────────────────────────── */
router.get('/teachers/:id', async (req, res) => {
  const school = res.locals.user.school;
  try {
    const teacher = await User.findById(req.params.id).select('_id name email active role school createdAt');
    if (!teacher) return res.status(404).send('Docente no encontrado');
    // Admins también pueden ser owner de un curso; el listado /directivo/teachers los incluye
    // así que este perfil debe aceptarlos, sino los links caerían en 404.
    if (!['teacher', 'admin'].includes(teacher.role)) return res.status(404).send('El usuario no es docente');
    if (school && teacher.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');

    const courses = await Course.find({ owner: teacher._id })
      .populate('division', 'name')
      .select('_id name division students');

    // Actividades de todos sus cursos, con conteo de entregas y calificadas
    const courseIds = courses.map(c => c._id);
    const activities = await Activity.find({ course: { $in: courseIds } })
      .populate('course', 'name')
      .sort({ createdAt: -1 });
    const submissionCounts = await Submission.aggregate([
      { $match: { activity: { $in: activities.map(a => a._id) } } },
      { $group: { _id: '$activity', count: { $sum: 1 } } },
    ]);
    const submittedByAct = Object.fromEntries(submissionCounts.map(s => [s._id.toString(), s.count]));

    const now = new Date();
    const activityRows = activities.map(a => ({
      _id:        a._id,
      title:      a.title,
      courseName: a.course?.name || '—',
      dueDate:    a.dueDate,
      overdue:    a.dueDate && a.dueDate < now,
      submitted:  submittedByAct[a._id.toString()] || 0,
      graded:     a.grades.length,
    }));

    res.render('directivo/teacher-detail', {
      teacher,
      courses: courses.map(c => ({
        _id: c._id, name: c.name,
        division: c.division?.name || '—',
        studentCount: c.students.length,
      })),
      activities: activityRows,
      stats: {
        totalCourses:    courses.length,
        totalActivities: activities.length,
        totalStudents:   [...new Set(courses.flatMap(c => c.students.map(s => s.toString())))].length,
      },
      activePage: 'teachers',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

module.exports = router;
