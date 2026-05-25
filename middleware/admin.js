const requireAdmin = (req, res, next) => {
  if (!res.locals.user || !['admin', 'superadmin'].includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

module.exports = { requireAdmin };
