// Guarda del panel de la Secretaria — /secretaria ("Docentes del día").
// Ver specs/secretaria-docentes-del-dia.spec.md.
//
// El ALCANCE no se resuelve acá: es el mismo de preceptoría (User.assignedDivisions /
// allDivisions, fail-closed) y lo resuelve loadPreceptorScope de middleware/preceptor.js, que
// no mira el rol para eso. Se reutiliza tal cual en vez de copiarlo: dos copias del alcance es
// cómo dos paneles terminan viendo cursos distintos para la misma persona (D1).

// Quién entra al panel. Directivo, admin y superadmin entran viendo toda su escuela
// (ROLES_SIN_LIMITE de middleware/preceptor.js), y además pueden LEER las anotaciones (RN-13).
const ROLES_CON_ACCESO = ['secretaria', 'directivo', 'admin', 'superadmin'];

// Quién ESCRIBE anotaciones (RN-12). Solo la secretaria: el resto mira.
const ROLES_QUE_ANOTAN = ['secretaria'];

// Quién CARGA el horario de clases de las materias (specs/secretaria-puntualidad.spec.md).
// El directivo entra a la pantalla y lo ve, pero no lo edita.
const ROLES_QUE_CARGAN_HORARIO = ['secretaria', 'admin', 'superadmin'];

const requireSecretaria = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

const puedeAnotar = (user) => !!user && ROLES_QUE_ANOTAN.includes(user.role);
const puedeCargarHorario = (user) => !!user && ROLES_QUE_CARGAN_HORARIO.includes(user.role);

module.exports = {
  requireSecretaria, puedeAnotar, puedeCargarHorario,
  ROLES_CON_ACCESO, ROLES_QUE_ANOTAN, ROLES_QUE_CARGAN_HORARIO,
};
