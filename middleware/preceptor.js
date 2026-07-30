// Guardas y resolución de alcance del panel de preceptoría.
//
// Un preceptor no ve la escuela entera: ve las divisiones que tiene asignadas
// (User.assignedDivisions) o todas, si un admin le marcó User.allDivisions. Ese conjunto
// —el "alcance"— es la única barrera entre un preceptor y los datos de los demás cursos,
// así que se resuelve UNA vez por request acá y todas las rutas de routes/preceptor.js
// consultan el resultado en vez de recalcularlo.
//
// Regla que no hay que romper: el alcance vacío significa "no ve nada", nunca "ve todo".
// Ver el comentario largo en models/User.js sobre por qué es fail-closed.

const Division = require('../models/Division');

// Roles que pueden entrar al panel. Los de mayor privilegio ven lo que ve un preceptor,
// misma filosofía que middleware/directivo.js y middleware/admin.js.
const ROLES_CON_ACCESO = ['preceptor', 'directivo', 'admin', 'superadmin'];

// Roles que NO están acotados a divisiones asignadas: ven todas las de su escuela.
const ROLES_SIN_LIMITE = ['directivo', 'admin', 'superadmin'];

const requirePreceptor = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// Resuelve el alcance y lo deja en req.scopeDivisionIds (Array<String>) y en
// res.locals.scopeAll (Boolean, solo para que las vistas puedan cambiar el texto).
//
// El filtro por escuela se aplica SIEMPRE, incluso sobre assignedDivisions: si un
// superadmin mueve un usuario de escuela (POST /superadmin/users/:id/school no desvincula
// nada, por decisión explícita), le quedarían divisiones de la escuela anterior pegadas en
// el array. Sin este filtro seguiría viéndolas desde su escuela nueva.
const loadPreceptorScope = async (req, res, next) => {
  const user = res.locals.user;
  res.locals.scopeAll = false;
  req.scopeDivisionIds = [];

  if (!user || !user.school) return next(); // sin escuela no hay nada que mostrar

  try {
    if (ROLES_SIN_LIMITE.includes(user.role) || user.allDivisions === true) {
      const todas = await Division.find({ school: user.school }).select('_id').lean();
      req.scopeDivisionIds = todas.map(d => d._id.toString());
      res.locals.scopeAll  = true;
      return next();
    }

    const asignadas = user.assignedDivisions || [];
    if (!asignadas.length) return next(); // fail-closed: sin asignaciones, sin acceso

    const validas = await Division.find({
      _id: { $in: asignadas }, school: user.school,
    }).select('_id').lean();
    req.scopeDivisionIds = validas.map(d => d._id.toString());
    next();
  } catch (err) {
    next(err);
  }
};

// ¿La división `divisionId` está dentro del alcance del request? Se usa en cada ruta con
// un :id en la URL — sin esto, cambiar el número en la barra de direcciones alcanzaría
// para leer la división de al lado.
const inScope = (req, divisionId) =>
  !!divisionId && req.scopeDivisionIds.includes(divisionId.toString());

module.exports = { requirePreceptor, loadPreceptorScope, inScope, ROLES_SIN_LIMITE };
