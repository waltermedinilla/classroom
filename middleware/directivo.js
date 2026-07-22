// requireDirectivo — guarda de ruta: acepta directivo, admin y superadmin.
// Filosofía: los roles con más privilegios pueden ver todo lo que ve un directivo
// (misma lógica que middleware/admin.js que acepta admin + superadmin).
const requireDirectivo = (req, res, next) => {
  if (!res.locals.user || !['directivo', 'admin', 'superadmin'].includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

module.exports = { requireDirectivo };
