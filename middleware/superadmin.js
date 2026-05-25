const requireSuperAdmin = (req, res, next) => {
  if (!res.locals.user || res.locals.user.role !== 'superadmin') {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

module.exports = { requireSuperAdmin };
