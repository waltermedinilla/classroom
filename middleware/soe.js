// Guardas y resolución de alcance del panel del Servicio de Orientación Escolar.
//
// Dos barreras distintas, que conviene no confundir:
//
//   1. ¿PUEDE ENTRAR? → requireSoe, que pregunta services/soeAcceso.js cuánto ve este rol
//      en esta escuela (School.soeAccess). Fail-CLOSED: default 'none' para todos menos el
//      propio SOE y el superadmin.
//   2. ¿PUEDE VER A ESTE ALUMNO? → loadSoeScope + alumnoEnScope. Fail-OPEN a propósito: un
//      SOE sin divisiones asignadas ve toda su escuela (ver D4 de la spec).
//
// La primera decide cuánto del legajo se le arma; la segunda, de qué chicos. Las dos reglas
// puras viven en services/soeAcceso.js para poder testearlas sin base — acá está solamente
// el pegamento con Mongo y con Express.

const Division = require('../models/Division');
const Course   = require('../models/Course');
const User     = require('../models/User');

const {
  NINGUNO, nivelAcceso, puedeEscribir, resolverAlcance, alumnoEnAlcance,
} = require('../services/soeAcceso');

// Mismo status y mismo texto que el resto de los paneles, con la rama JSON de
// middleware/sections.js: la ficha del legajo usa fetch() para guardar, y sin esto un
// rechazo devolvería HTML donde el navegador espera JSON.
function denegar(req, res) {
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return res.status(403).send('Acceso denegado');
}

// ¿Entra al panel? Y de paso deja el nivel resuelto para las vistas, que lo necesitan para
// decidir qué dibujar (criterio 25: en nivel 'resumen' los formularios no se dibujan, no
// alcanza con que el POST responda 403).
const requireSoe = (req, res, next) => {
  const user = res.locals.user;
  const nivel = nivelAcceso(res.locals.school, user && user.role);

  res.locals.soeNivel    = nivel;
  res.locals.soeEscribe  = puedeEscribir(user && user.role);
  res.locals.soeCompleto = nivel === 'completo';

  if (nivel === NINGUNO) return denegar(req, res);
  next();
};

// Guarda de escritura. Va en cada POST/PATCH/DELETE del panel, aparte de requireSoe: un
// directivo con nivel 'completo' entra y lee, pero no escribe una línea del legajo.
const requireEscrituraSoe = (req, res, next) => {
  if (!puedeEscribir(res.locals.user && res.locals.user.role)) return denegar(req, res);
  next();
};

// Resuelve el alcance UNA vez por request y lo deja en:
//   req.soeAlcance      { todas: Boolean, divisionIds: [String] }
//   res.locals.scopeAll Boolean — solo para que la vista cambie el texto
//
// Una sola query, indexada por `school`. El filtro por escuela se aplica SIEMPRE, también
// sobre assignedDivisions: mover un usuario de escuela no desvincula nada (decisión
// explícita del proyecto), así que le quedan divisiones zombi de la anterior.
const loadSoeScope = async (req, res, next) => {
  const user = res.locals.user;
  req.soeAlcance      = { todas: false, divisionIds: [] };
  req.soeSchoolId     = null;
  res.locals.scopeAll = false;

  if (!user || !user.school) return next(); // sin escuela no hay alumnos que atender
  req.soeSchoolId = user.school;

  try {
    const divisiones = await Division.find({ school: user.school }).select('_id').lean();
    req.soeAlcance      = resolverAlcance(user, divisiones.map(d => d._id.toString()));
    res.locals.scopeAll = req.soeAlcance.todas;
    next();
  } catch (err) {
    next(err);
  }
};

// Las divisiones ACTUALES de un alumno. No existe User.division: un alumno se ubica por las
// materias donde está inscripto (mismo criterio que services/attendance.js:184). Puede dar
// más de una — recursantes y contraturno cursan materias de dos divisiones.
async function divisionesDelAlumno(studentId) {
  const cursos = await Course.find({ students: studentId }).select('division').lean();
  return [...new Set(cursos.map(c => c.division).filter(Boolean).map(String))];
}

// ¿Este alumno está dentro del alcance del request? Devuelve el doc del alumno si sí, y
// null si no — así la ruta hace una sola llamada en vez de chequear y después buscar.
//
// Devuelve null también cuando el id no es de un alumno: el panel es de alumnos, y dejar
// abrir el "legajo" de un docente sería una forma silenciosa de fichar al personal.
//
// Es la barrera de TODA ruta con un :studentId. Sin esto, cambiar el id en la barra de
// direcciones alcanzaría para leer el legajo de un chico de otro curso — o de otra escuela.
async function alumnoEnScope(req, studentId) {
  if (!studentId || !req.soeSchoolId) return null;

  const alumno = await User.findOne({ _id: studentId, role: 'student' })
    .select('name email dni avatar school lastSeen bio interests futureGoal active')
    .lean();
  if (!alumno) return null;

  const divisiones = await divisionesDelAlumno(alumno._id);

  return alumnoEnAlcance(req.soeAlcance, { school: alumno.school, divisiones }, req.soeSchoolId)
    ? { ...alumno, divisiones }
    : null;
}

module.exports = {
  requireSoe, requireEscrituraSoe, loadSoeScope, divisionesDelAlumno, alumnoEnScope,
};
