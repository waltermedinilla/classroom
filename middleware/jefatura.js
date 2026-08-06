// Guardas y resolución de alcance del panel de Jefatura de Sección.
//
// Un Jefe de Sección no ve la escuela entera: ve las Secciones donde un admin lo puso como
// jefe (Section.heads). Una sección mezcla divisiones ENTERAS con materias sueltas, así que
// el alcance se resuelve siempre a un conjunto de MATERIAS (Course), que es el grano contra
// el que cuelgan las actividades.
//
// Igual que en middleware/preceptor.js, el alcance se resuelve UNA vez por request y todas
// las rutas consultan el resultado en vez de recalcularlo.
//
// REGLA QUE NO HAY QUE ROMPER: alcance vacío significa "no ve nada", nunca "ve todo". El rol
// se puede asignar por varios caminos que no preguntan por secciones (cambio de rol
// individual o en lote desde /admin y /superadmin), y en todos ellos el usuario queda sin
// ninguna sección. Si "vacío" significara "todas", esos caminos entregarían la escuela entera.
//
// ⚠️ Nada que ver con middleware/sections.js: aquél es el enforcement de las SOLAPAS del
// panel. Acá "sección" es la entidad de datos de models/Section.js.

const Section = require('../models/Section');
const Course  = require('../models/Course');

// Roles que pueden entrar al panel. Los de mayor privilegio ven lo mismo que un jefe,
// misma filosofía que middleware/directivo.js y middleware/preceptor.js.
const ROLES_CON_ACCESO = ['jefe', 'directivo', 'admin', 'superadmin'];

// Roles que NO están acotados a las secciones donde figuran como jefe: ven todas las
// secciones de su escuela. Un directivo o un admin entra a mirar el panel sin que nadie
// tenga que agregarlo como jefe de cada sección.
const ROLES_SIN_LIMITE = ['directivo', 'admin', 'superadmin'];

const requireJefe = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// Resuelve el alcance y lo deja en:
//   req.scopeCourseIds  Array<String> — las materias que el usuario puede mirar
//   req.scopeSections   [{ _id, name, divisions, courses }] — para los títulos de la vista
//   res.locals.scopeAll Boolean — true si entró por rol y no por ser jefe de algo
//
// Cuesta dos queries, las dos indexadas: { heads: 1 } en Section y { division: 1 } / _id
// en Course. Mismo orden de magnitud que loadPreceptorScope.
const loadJefaturaScope = async (req, res, next) => {
  const user = res.locals.user;
  res.locals.scopeAll   = false;
  req.scopeCourseIds    = [];
  req.scopeSections     = [];

  if (!user || !user.school) return next(); // sin escuela no hay nada que mostrar

  try {
    const sinLimite = ROLES_SIN_LIMITE.includes(user.role);
    res.locals.scopeAll = sinLimite;

    // El filtro por escuela se aplica SIEMPRE, también sobre las secciones donde figura
    // como jefe: si un superadmin lo mueve de escuela (POST /superadmin/users/:id/school no
    // desvincula nada, por decisión explícita), quedaría como jefe de secciones de la
    // escuela anterior.
    const filtro = sinLimite
      ? { school: user.school }
      : { school: user.school, heads: user._id };

    const secciones = await Section.find(filtro)
      .select('_id name divisions courses')
      .sort({ name: 1 })
      .lean();

    if (!secciones.length) return next(); // fail-closed: sin secciones, sin acceso

    const divisionIds = [...new Set(secciones.flatMap(s => (s.divisions || []).map(String)))];
    const sueltas     = [...new Set(secciones.flatMap(s => (s.courses   || []).map(String)))];
    if (!divisionIds.length && !sueltas.length) {
      req.scopeSections = secciones;  // hay secciones pero están vacías: se avisa distinto
      return next();
    }

    // Resolución DINÁMICA: las materias de una división entera se buscan ACÁ, no se guardan
    // en la sección. Por eso una materia creada después de armar la sección —o cargada con
    // el alta masiva de /superadmin/otros— entra sola, sin que nadie edite nada.
    //
    // El filtro por escuela cubre además los ids que quedaron colgados en la sección.
    const materias = await Course.find({
      school: user.school,
      $or: [
        { division: { $in: divisionIds } },
        { _id:      { $in: sueltas } },
      ],
    }).select('_id').lean();

    req.scopeCourseIds = materias.map(m => m._id.toString());
    req.scopeSections  = secciones;
    next();
  } catch (err) {
    next(err);
  }
};

// ¿Esta materia está dentro del alcance del request? Es la barrera de TODA ruta con un :id.
// Sin esto, cambiar el id en la barra de direcciones alcanzaría para leer las actividades
// —y las notas— de una materia de otra sección.
const materiaEnScope = (req, courseId) =>
  !!courseId && req.scopeCourseIds.includes(courseId.toString());

// ¿Este docente dicta alguna materia del alcance? Titular o suplente: un suplente que
// sostiene la materia tiene que poder abrirse igual que el titular.
const docenteEnScope = async (req, teacherId) => {
  if (!teacherId || !req.scopeCourseIds.length) return false;
  const n = await Course.countDocuments({
    _id: { $in: req.scopeCourseIds },
    $or: [{ owner: teacherId }, { coTeachers: teacherId }],
  });
  return n > 0;
};

module.exports = {
  requireJefe, loadJefaturaScope, materiaEnScope, docenteEnScope,
  ROLES_CON_ACCESO, ROLES_SIN_LIMITE,
};
