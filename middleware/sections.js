// Enforcement de los permisos por rol que el superadmin configura en /superadmin/roles.
//
// Esta capa se SUMA a los middlewares de rol que ya existían (requireAdmin,
// requireDirectivo, requirePreceptor): corre después de ellos y solo puede QUITAR acceso,
// nunca darlo. Por eso ninguno de esos middlewares se tocó — si algo falla acá, lo que
// queda es exactamente el comportamiento de antes.
//
// Sin esto, deshabilitar una solapa solo la escondería del menú y la URL seguiría
// funcionando escribiéndola a mano.
const { sectionsForPanel, isDenied } = require('../config/sections');

// Mismo status y mismo texto que middleware/admin.js, para que el usuario vea siempre la
// misma pantalla de rechazo. La rama JSON existe porque los paneles están llenos de
// fetch() (ver views/admin/tasks/index.ejs): sin ella, un toggle rechazado recibiría HTML
// donde espera JSON. Es el mismo criterio del manejador de errores global de server.js.
function denegar(req, res) {
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return res.status(403).send('Acceso denegado');
}

// Guarda puntual para una sección concreta. Se usa donde el router no se corresponde con
// un panel entero — por ejemplo /admin/audit, que vive en routes/audit.js (montado en "/")
// y por lo tanto nunca pasa por el sectionGuard('admin') de routes/admin.js.
const requireSection = (key) => (req, res, next) => {
  const user = res.locals.user;
  if (!user) return next(); // sin usuario no hay rol que evaluar: decide requireAuth
  return isDenied(res.locals.school, user.role, key) ? denegar(req, res) : next();
};

// Guarda de PANEL: se monta UNA vez por router y resuelve sola qué sección corresponde al
// path pedido. Cubre GET, POST y todos los sub-paths, que es justamente lo que evita
// olvidarse de una acción: apagar "Usuarios" apaga también /admin/users/:id/delete,
// /reset-password, /impersonate, etc.
function sectionGuard(panel) {
  // Prefijo más largo primero. Necesario para que /admin/users/:id no caiga en /admin
  // (que es la sección "Resumen" del panel).
  const secs = sectionsForPanel(panel).slice().sort((a, b) => b.path.length - a.path.length);

  return (req, res, next) => {
    const user = res.locals.user;
    if (!user) return next();
    // originalUrl y no req.path: adentro de un router montado, req.path viene sin el
    // prefijo del mount (en routes/admin.js, /admin/users llega como /users).
    const url = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
    // Match por límite de segmento, nunca startsWith pelado: si no, /admin/usersDeOtraCosa
    // heredaría los permisos de /admin/users.
    const sec = secs.find(s => url === s.path || url.startsWith(s.path + '/'));
    if (!sec) return next(); // path que no está en el catálogo: lo resuelve el 404 del router
    return isDenied(res.locals.school, user.role, sec.key) ? denegar(req, res) : next();
  };
}

module.exports = { requireSection, sectionGuard };
