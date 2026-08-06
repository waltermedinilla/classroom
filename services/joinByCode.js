// CÓDIGO DE CLASE — el alumno se suma a una materia tipeando su código.
//
// Repuesto el 2026-07-31 a pedido del usuario. Ya había existido: se deshabilitó por flag
// el 2026-07-29 y se eliminó del todo el 2026-07-30, para que matricular fuera siempre una
// acción administrativa con registro de quién inscribió a cada uno. Vuelve, pero acotado.
//
//   • Para APAGARLO: JOIN_BY_CODE_ACTIVO = false. El botón desaparece del panel del alumno,
//     el código deja de mostrarse en la materia y la ruta rechaza. Nada más que tocar.
//   • Para BORRARLO: eliminar este archivo y sus usos en routes/courses.js (POST /join y el
//     render de la materia), views/dashboard.ejs y views/course.ejs.
//
// LA REGLA QUE LO HACE SEGURO — solo materias de SU PROPIO CURSO.
// El código sirve únicamente si la materia pertenece a una División donde el alumno YA está
// matriculado. Es lo que evita que un código reenviado por WhatsApp lo meta en materias de
// otro año, que es exactamente el desorden que hoy diagnostica 'alumnos-en-varios-cursos'
// en /superadmin/otros. Caso de uso real: el docente crea una materia nueva en el curso y
// dicta el código en clase, en vez de pedirle al admin que matricule a los 30 uno por uno.
//
// Corolario: un alumno SIN ninguna materia no puede usar el código, porque todavía no tiene
// curso contra el cual validar. Ese es el caso de la automatrícula (ver services/selfEnroll.js):
// primero elige curso, después puede sumar materias sueltas de ese curso con el código.

const Course = require('../models/Course');
const { logAudit } = require('../middleware/audit');
// Tope de materias del alumno: el botón ya no se muestra al llegar, pero la ruta también
// tiene que rechazar — el panel se puede saltear con un request armado a mano.
const { MAX_MATERIAS_ALUMNO, alcanzoTopeDeMaterias } = require('../services/enrollment');

const JOIN_BY_CODE_ACTIVO = true;

// El docente lo dicta en voz alta y el alumno lo tipea: hay que perdonar minúsculas,
// espacios y el cero/o mal escuchado no — eso NO se corrige, porque cambiaría el código
// por otro que podría existir. Solo se normaliza lo que no puede generar ambigüedad.
function normalizarCodigo(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

// Divisiones donde el alumno tiene al menos una materia. Es su "curso" a los efectos de
// esta función; son varias solo si quedó mal cargado en más de una (ver el diagnóstico
// 'alumnos-en-varios-cursos'), y en ese caso se aceptan todas.
async function divisionesDelAlumno(studentId) {
  const materias = await Course.find({ students: studentId }).select('division').lean();
  return new Set(materias.map(m => m.division?.toString()).filter(Boolean));
}

// Suma al alumno a la materia del código. Devuelve { ok, error?, materia? }.
// Nunca lanza por datos del usuario: los errores esperables vuelven en `error`.
async function unirPorCodigo(req, student, code) {
  if (!JOIN_BY_CODE_ACTIVO) {
    return { ok: false, error: 'El código de clase está desactivado. Pedile el alta al administrador.' };
  }
  if (!student || student.role !== 'student') {
    return { ok: false, error: 'Solo los alumnos pueden unirse con un código.' };
  }

  const codigo = normalizarCodigo(code);
  if (!codigo) return { ok: false, error: 'Escribí el código de la clase.' };

  const materia = await Course.findOne({ code: codigo })
    .select('_id name code school division students enrollmentDates')
    .populate('division', 'name');
  // Mismo mensaje para "no existe" y "es de otra escuela": responder distinto convertiría
  // esto en un oráculo para adivinar códigos ajenos a fuerza de probar.
  const otraEscuela = materia && student.school &&
    materia.school?.toString() !== student.school.toString();
  if (!materia || otraEscuela) {
    return { ok: false, error: 'Ese código no corresponde a ninguna materia.' };
  }

  if ((materia.students || []).some(s => s.toString() === student._id.toString())) {
    return { ok: false, error: `Ya estás en ${materia.name}.` };
  }

  // Va después de "ya estás en X" para que ese mensaje, que es el más específico, gane.
  if (await alcanzoTopeDeMaterias(student._id)) {
    return {
      ok: false,
      error: `Ya tenés ${MAX_MATERIAS_ALUMNO} materias o más. Si te falta alguna, pedile el alta al administrador.`,
    };
  }

  const misDivisiones = await divisionesDelAlumno(student._id);
  if (!misDivisiones.size) {
    return {
      ok: false,
      error: 'Todavía no estás en ningún curso. Elegí tu curso primero y después podés sumar materias con el código.',
    };
  }
  if (!misDivisiones.has(materia.division?._id?.toString() || materia.division?.toString())) {
    return {
      ok: false,
      error: `Ese código es de una materia de ${materia.division?.name || 'otro curso'}, que no es tu curso. ` +
             'Si te corresponde cursarla, pedile el cambio al administrador.',
    };
  }

  materia.students.push(student._id);
  // enrollmentDates = ahora, igual que en services/enrollment.js: routes/activities.js lo usa
  // para NO mostrarle las tareas que vencieron antes de que se sumara.
  materia.enrollmentDates.set(student._id.toString(), new Date());
  await materia.save({ validateModifiedOnly: true });

  logAudit(req, 'course.join',
    [{ type: 'course', id: materia._id, name: materia.name }],
    { via: 'codigo-de-clase' },
  );

  return { ok: true, materia: { _id: materia._id, name: materia.name } };
}

module.exports = { JOIN_BY_CODE_ACTIVO, normalizarCodigo, unirPorCodigo };
