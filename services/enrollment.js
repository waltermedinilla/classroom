// Matrícula de alumnos en las materias de una división.
//
// Vivía dentro de routes/admin.js hasta que el panel de preceptoría necesitó el mismo
// comportamiento exacto. Se extrajo sin cambios de lógica: el alta de alumno del admin
// y la del preceptor tienen que inscribir igual, o los alumnos cargados por una vía
// verían actividades distintas que los cargados por la otra.
//
// Contrato:
//   enrollStudentInDivisionCourses(req, student, divisionId, school, via) → Number
//   Devuelve la cantidad de materias NUEVAS en las que quedó inscripto (0 si no había
//   nada que hacer, si la división no existe o si no pertenece a `school`).
//
// El parámetro `via` es solo metadata de auditoría: identifica desde qué flujo se llamó
// ('alta-alumno-con-curso', 'alta-alumno-preceptor', …) para poder distinguirlos después
// en el timeline, ya que todos registran la misma acción 'course.add_student'.

const Course     = require('../models/Course');
const Division   = require('../models/Division');
const Activity   = require('../models/Activity');
const Submission = require('../models/Submission');
const { logAudit } = require('../middleware/audit');

// TOPE DE MATERIAS DEL ALUMNO (pedido el 2026-08-06).
//
// Con 9 o más materias el alumno ya tiene su curso completo, así que el panel deja de
// ofrecerle sumar más: desaparecen «Unirme con un código» y «Enviar solicitud para unirme»
// (views/dashboard.ejs) y la ruta POST /courses/join rechaza (services/joinByCode.js).
//
// NO limita el alta administrativa: el admin, el preceptor y el docente pueden seguir
// matriculando por encima del tope. Es un freno a la vía del alumno, no una regla de la
// base. Para moverlo o sacarlo, cambiar este número (Infinity lo desactiva de hecho).
const MAX_MATERIAS_ALUMNO = 9;

// ¿El alumno ya llegó al tope? Cuenta las materias donde figura como alumno.
async function alcanzoTopeDeMaterias(studentId) {
  const materias = await Course.countDocuments({ students: studentId });
  return materias >= MAX_MATERIAS_ALUMNO;
}

// Inscribe a `student` en las materias del Curso `divisionId` donde todavía no figura.
// Usado tanto para un alumno recién creado como para uno que ya existía (encontrado por
// DNI) — en ambos casos la regla es la misma: completar lo que le falta, sin duplicar.
async function enrollStudentInDivisionCourses(req, student, divisionId, school, via) {
  if (!divisionId || !school) return 0;
  // Valida que la división pertenezca a la misma escuela (defensa en profundidad,
  // aunque el select del formulario solo muestra las de la escuela del admin).
  const division = await Division.findOne({ _id: divisionId, school }).select('_id name');
  if (!division) return 0;

  const courses = await Course.find({ division: division._id, school }).select('_id name students enrollmentDates');
  const now = new Date();
  let enrolledIn = 0;
  for (const c of courses) {
    if (c.students.some(s => s.toString() === student._id.toString())) continue; // ya inscripto: no duplicar
    c.students.push(student._id);
    // enrollmentDates marca desde cuándo cuenta la matrícula: routes/activities.js lo usa
    // para NO mostrarle al alumno las tareas que vencieron antes de que se incorporara.
    c.enrollmentDates.set(student._id.toString(), now);
    await c.save({ validateModifiedOnly: true });
    enrolledIn++;
  }

  if (enrolledIn > 0) {
    logAudit(req, 'course.add_student',
      [
        { type: 'division', id: division._id, name: division.name },
        { type: 'user',     id: student._id,  name: student.name },
      ],
      { materias: enrolledIn, via },
    );
  }
  return enrolledIn;
}

// ¿En cuántas actividades de las materias de esta división entregó algo el alumno?
//
// Es la guarda que decide si se lo puede desmatricular. Mismo criterio que la ruta del
// docente (`DELETE /courses/:id/students/:studentId`): si ya entregó, sacarlo escondería
// trabajo suyo y la corrección del docente, así que se bloquea. Que el sistema se comporte
// igual para docentes y preceptores evita la sorpresa de "a mí me deja y a vos no".
//
// Devuelve { entregas, materias } — materias es la cantidad de materias donde hay entregas.
async function contarEntregasEnDivision(studentId, divisionId, school) {
  const filtro = { division: divisionId };
  if (school) filtro.school = school;
  const courseIds = await Course.find(filtro).distinct('_id');
  if (!courseIds.length) return { entregas: 0, materias: 0 };

  const actividades = await Activity.find({ course: { $in: courseIds } }).select('_id course').lean();
  if (!actividades.length) return { entregas: 0, materias: 0 };

  const entregas = await Submission.find({
    student:  studentId,
    activity: { $in: actividades.map(a => a._id) },
  }).select('activity').lean();

  const cursoDeActividad = Object.fromEntries(actividades.map(a => [a._id.toString(), a.course.toString()]));
  const materiasConEntrega = new Set(
    entregas.map(e => cursoDeActividad[e.activity.toString()]).filter(Boolean)
  );
  return { entregas: entregas.length, materias: materiasConEntrega.size };
}

// Saca al alumno de TODAS las materias de una división.
//
// No borra la cuenta ni sus entregas: solo lo quita de `students[]` y limpia su marca en
// `enrollmentDates`. Se lo puede volver a matricular después sin rastros.
//
// Devuelve { removed } con la cantidad de materias de las que se lo sacó. NO chequea
// entregas: esa validación va en la ruta, que es la que puede devolver el 409 con el
// detalle para la pantalla.
async function unenrollStudentFromDivision(req, student, divisionId, school, via) {
  if (!divisionId || !school) return 0;
  const division = await Division.findOne({ _id: divisionId, school }).select('_id name');
  if (!division) return 0;

  const courses = await Course.find({ division: division._id, school })
    .select('_id name students enrollmentDates');
  let removed = 0;
  for (const c of courses) {
    const estaba = c.students.some(s => s.toString() === student._id.toString());
    if (!estaba) continue;
    c.students = c.students.filter(s => s.toString() !== student._id.toString());
    // Se borra también la fecha de matrícula: si mañana se lo vuelve a inscribir, la que
    // corresponde es la nueva, no la vieja (de la que dependía qué tareas vencidas veía).
    c.enrollmentDates.delete(student._id.toString());
    await c.save({ validateModifiedOnly: true });
    removed++;
  }

  if (removed > 0) {
    logAudit(req, 'course.remove_student',
      [
        { type: 'division', id: division._id, name: division.name },
        { type: 'user',     id: student._id,  name: student.name },
      ],
      { materias: removed, via },
    );
  }
  return removed;
}

module.exports = {
  enrollStudentInDivisionCourses,
  unenrollStudentFromDivision,
  contarEntregasEnDivision,
  MAX_MATERIAS_ALUMNO,
  alcanzoTopeDeMaterias,
};
