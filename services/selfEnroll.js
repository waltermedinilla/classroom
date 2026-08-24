// AUTOMATRÍCULA DEL ALUMNO — FUNCIÓN TEMPORAL (pedida el 2026-07-31).
//
// El alumno elige su Curso (1°1°, 2°3°…) UNA SOLA VEZ y queda inscripto en todas las
// materias de ese curso. Nació con dos puertas, las dos por acá:
//   1. Al registrarse en /register, si elegía el rol Alumno.
//      ⚠️ MUERTA desde el 2026-08-23: el registro público está CERRADO
//      (services/registroPublico.js). El código de `POST /register` sigue llamando acá,
//      pero detrás del flag, así que hoy no lo ejecuta nadie. Si alguna vez se reabre el
//      registro, esta puerta vuelve sola — tenerlo presente antes de tocar `automatricular`.
//   2. Desde su propio panel, si ya tiene cuenta pero no está en ninguna materia.
//      Es la ÚNICA puerta viva hoy, y la que ejercitan los tests.
//
// ⚠️ VA CONTRA LA DECISIÓN DEL 2026-07-30, a sabiendas: ese día se eliminó "unirse por
// código" justamente para que matricular fuera siempre una acción administrativa, y el
// alumno quedó con la vía de "enviar solicitud". Esto reabre la puerta, y el usuario lo
// pidió explícitamente como algo temporal. Por eso vive en un archivo aparte:
//
//   • Para APAGARLA: AUTOMATRICULA_ACTIVA = false. Las dos pantallas dejan de ofrecer el
//     curso y las dos rutas rechazan el pedido; no hay que tocar nada más.
//   • Para BORRARLA: eliminar este archivo y sus usos en routes/auth.js (GET y POST
//     /register), routes/courses.js (GET / y POST /self-enroll), views/register.ejs,
//     views/dashboard.ejs y public/js/register.js.
//
// LO QUE EL ALUMNO **NO** PUEDE HACER, aunque manipule el request:
//   • Elegir un curso si ya está en alguna materia — eso es lo que hace que sea "una sola
//     vez"; la guarda la aplica cada ruta antes de llamar acá.
//   • Cambiarse de escuela: si su cuenta ya tiene escuela, solo puede elegir cursos de esa.
//   • Elegir un curso vacío: dejaría su cuenta igual de huérfana que antes, con la
//     diferencia de que él creería haber elegido.
//   • Auto-asignarse otro rol: `automatricular()` solo trabaja sobre role === 'student'.

const Course   = require('../models/Course');
const Division = require('../models/Division');
const School   = require('../models/School');
const { enrollStudentInDivisionCourses } = require('../services/enrollment');

const AUTOMATRICULA_ACTIVA = true;

// Cursos que se le pueden ofrecer al alumno: solo los que TIENEN materias cargadas.
// Se devuelve el nombre de la escuela para agrupar el <select> cuando hay más de una.
// `schoolId` acota la lista a una escuela (el alumno que ya tiene cuenta no puede
// cambiarse de escuela eligiendo un curso de otra).
async function cursosDisponibles(schoolId = null) {
  if (!AUTOMATRICULA_ACTIVA) return [];

  const filtro = schoolId ? { school: schoolId } : {};
  const [divisiones, escuelas, conMaterias] = await Promise.all([
    Division.find(filtro).sort({ name: 1 }).select('_id name school').lean(),
    School.find().select('_id name').lean(),
    Course.distinct('division', filtro),
  ]);

  const nombreEscuela = new Map(escuelas.map(e => [e._id.toString(), e.name]));
  const tieneMaterias = new Set(conMaterias.map(String));

  return divisiones
    .filter(d => tieneMaterias.has(d._id.toString()))
    .map(d => ({
      _id:      d._id.toString(),
      name:     d.name,
      schoolId: d.school?.toString() || null,
      escuela:  nombreEscuela.get(d.school?.toString()) || 'Sin escuela',
    }));
}

// Valida el curso elegido y devuelve la división (con su escuela) o null.
// Se expone aparte porque /register necesita saber la escuela ANTES de crear la cuenta:
// es la que define contra qué índice {school, dni} se chequea el DNI duplicado.
async function cursoElegible(divisionId, schoolId = null) {
  if (!AUTOMATRICULA_ACTIVA || !divisionId) return null;
  let division;
  try {
    division = await Division.findById(divisionId).select('_id name school').lean();
  } catch {
    return null; // id con formato inválido
  }
  if (!division) return null;
  if (schoolId && division.school?.toString() !== schoolId.toString()) return null;
  const materias = await Course.countDocuments({ division: division._id });
  if (!materias) return null;
  return division;
}

// Inscribe al alumno en todas las materias del curso elegido.
//
// Devuelve { ok, error?, materias?, curso? }. Nunca lanza por datos del usuario: los
// errores esperables vuelven como `error` para que la ruta los mande tal cual.
//
// La guarda de "una sola vez" (que no esté ya en ninguna materia) la aplica cada ruta,
// no esto: en el registro la cuenta acaba de nacer y el chequeo sobraría.
async function automatricular(req, student, divisionId, via) {
  if (!AUTOMATRICULA_ACTIVA) {
    return { ok: false, error: 'La elección de curso está desactivada. Pedí el alta al administrador.' };
  }
  if (!student || student.role !== 'student') {
    return { ok: false, error: 'Solo los alumnos pueden elegir su curso.' };
  }

  const division = await cursoElegible(divisionId, student.school || null);
  if (!division) {
    return { ok: false, error: 'Ese curso no está disponible. Elegí uno de la lista.' };
  }

  // Las cuentas del registro público viejo tienen school:null y por eso no aparecen en
  // ningún panel (es el arreglo 'usuarios-sin-escuela' de /superadmin/otros). Al elegir
  // curso, la escuela queda implícita: se la asignamos acá y dejan de estar huérfanas.
  if (!student.school) {
    student.school = division.school;
    await student.save({ validateModifiedOnly: true });
  }

  // Mismo camino que usan el alta del admin y la de preceptoría — incluido el
  // enrollmentDates que evita que le aparezcan como pendientes las tareas ya vencidas.
  const materias = await enrollStudentInDivisionCourses(
    req, student, division._id, student.school, via,
  );

  return { ok: true, materias, curso: division.name };
}

module.exports = { AUTOMATRICULA_ACTIVA, cursosDisponibles, cursoElegible, automatricular };
