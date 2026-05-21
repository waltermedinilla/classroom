const requireAdmin = (req, res, next) => {
  if (!res.locals.user || res.locals.user.role !== 'admin') {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

module.exports = { requireAdmin };
