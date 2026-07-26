const requireAdmin = (req, res, next) => {
  if (!res.locals.user || !['admin', 'superadmin'].includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// Estrictamente superadmin: rutas /superadmin/tasks*, gestión de plantillas globales.
const requireSuperadmin = (req, res, next) => {
  if (!res.locals.user || res.locals.user.role !== 'superadmin') {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

module.exports = { requireAdmin, requireSuperadmin };
