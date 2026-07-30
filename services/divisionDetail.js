// Detalle de una división: sus materias (con docente), su nómina de alumnos y las
// métricas agregadas de ambas.
//
// Extraído de routes/directivo.js cuando el panel de preceptoría necesitó exactamente la
// misma pantalla acotada a las divisiones a cargo. Duplicar estas agregaciones garantizaba
// que en unos meses los dos paneles mostraran números distintos para la misma división.
//
// Contrato:
//   getDivisionDetail(divisionId) → { division, courses, students, stats } | null
//   Devuelve null si la división no existe. NO valida escuela: eso es responsabilidad del
//   caller, que es quien sabe contra qué escuela comparar (ver el chequeo de multi-tenant
//   en routes/directivo.js y routes/preceptor.js).
//
// Alumnos ÚNICOS: un alumno cursa varias materias del mismo año, así que sumar
// `students.length` de cada materia lo contaría repetido. De ahí el Set sobre el flatMap.

const User       = require('../models/User');
const Course     = require('../models/Course');
const Division   = require('../models/Division');
const Activity   = require('../models/Activity');
const Submission = require('../models/Submission');

async function getDivisionDetail(divisionId) {
  const division = await Division.findById(divisionId);
  if (!division) return null;

  const courses = await Course.find({ division: division._id })
    .populate('owner',      'name email active')
    .populate('coTeachers', 'name email active')
    .select('_id name owner coTeachers students');
  const courseIds = courses.map(c => c._id);

  const activities = await Activity.find({ course: { $in: courseIds } })
    .select('_id course dueDate grades points');

  const entregas = await Submission.aggregate([
    { $match: { activity: { $in: activities.map(a => a._id) } } },
    { $group: { _id: '$activity', count: { $sum: 1 }, alumnos: { $addToSet: '$student' } } },
  ]);
  const entregasPorAct = Object.fromEntries(entregas.map(e => [e._id.toString(), e.count]));

  // Entregas por alumno: se cuenta a nivel alumno para la tabla de la nómina.
  const entregasPorAlumno = {};
  for (const e of entregas) {
    for (const sid of e.alumnos) {
      const k = sid.toString();
      entregasPorAlumno[k] = (entregasPorAlumno[k] || 0) + 1;
    }
  }

  const now = new Date();
  const actsPorCurso = {};
  activities.forEach(a => {
    const k = a.course.toString();
    if (!actsPorCurso[k]) actsPorCurso[k] = { total: 0, vencidasSinCalificar: 0, entregas: 0 };
    actsPorCurso[k].total++;
    actsPorCurso[k].entregas += entregasPorAct[a._id.toString()] || 0;
    if (a.dueDate && a.dueDate < now && a.grades.length === 0) actsPorCurso[k].vencidasSinCalificar++;
  });

  const courseRows = courses.map(c => {
    const bag = actsPorCurso[c._id.toString()] || { total: 0, vencidasSinCalificar: 0, entregas: 0 };
    const esperadas = bag.total * c.students.length;
    return {
      _id: c._id, name: c.name,
      teacher: c.owner?.name || '—',
      teacherActive: c.owner?.active !== false,
      // Co-docentes con los mismos permisos que el owner sobre la materia (ver
      // Course.coTeachers). La vista del directivo muestra solo `teacher`; la de
      // preceptoría los lista a todos, que es lo que un preceptor necesita saber
      // para contactar a quien dicta.
      coTeachers: (c.coTeachers || []).map(t => ({ name: t.name, active: t.active !== false })),
      students: c.students.length,
      activities: bag.total,
      entregas: bag.entregas,
      esperadas,
      tasa: esperadas > 0 ? Math.round((bag.entregas / esperadas) * 100) : null,
      vencidasSinCalificar: bag.vencidasSinCalificar,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'es'));

  // Alumnos únicos de la división (un alumno cursa varias materias del mismo año).
  const alumnoIds = [...new Set(courses.flatMap(c => c.students.map(s => s.toString())))];
  const alumnos = await User.find({ _id: { $in: alumnoIds } })
    .select('_id name email dni active phone').sort({ name: 1 }).lean();

  // Promedio normalizado 0-10 por alumno dentro de esta división. La guarda `points > 0`
  // evita que una actividad sin puntaje definido rompa el $divide.
  const notas = await Activity.aggregate([
    { $match: { course: { $in: courseIds }, points: { $ne: null, $gt: 0 } } },
    { $unwind: '$grades' },
    { $group: {
        _id: '$grades.student',
        sum:   { $sum: { $multiply: [{ $divide: ['$grades.points', '$points'] }, 10] } },
        count: { $sum: 1 },
    } },
  ]);
  const promPorAlumno = Object.fromEntries(
    notas.map(n => [n._id.toString(), Math.round((n.sum / n.count) * 10) / 10]),
  );

  const studentRows = alumnos.map(a => ({
    _id: a._id, name: a.name, email: a.email, dni: a.dni,
    phone: a.phone, active: a.active,
    entregas: entregasPorAlumno[a._id.toString()] || 0,
    promedio: promPorAlumno[a._id.toString()] ?? null,
  }));

  const totalEntregas  = Object.values(entregasPorAct).reduce((x, y) => x + y, 0);
  const totalEsperadas = courseRows.reduce((acc, c) => acc + c.esperadas, 0);

  return {
    division,
    courses:  courseRows,
    students: studentRows,
    stats: {
      materias:    courses.length,
      alumnos:     alumnos.length,
      docentes:    new Set(courses.map(c => c.owner?._id?.toString()).filter(Boolean)).size,
      actividades: activities.length,
      tasa:        totalEsperadas > 0 ? Math.round((totalEntregas / totalEsperadas) * 100) : null,
    },
  };
}

module.exports = { getDivisionDetail };
