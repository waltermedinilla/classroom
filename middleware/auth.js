const jwt = require('jsonwebtoken');
const User = require('../models/User');

// requireAuth — guarda de ruta: solo pasa si hay un JWT válido en la cookie "token"
// Si falla, redirige a /login. Setea req.userId con el ID del usuario decodificado.
const requireAuth = (req, res, next) => {
  // checkUser ya pudo haber detectado usuario deshabilitado y setear este flag
  if (req.userDisabled) return res.redirect('/login');

  const token = req.cookies.token;
  if (!token) return res.redirect('/login');

  try {
    // Verifica firma y expiración del JWT; lanza si es inválido
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.userId = decoded.userId; // Disponible en todas las rutas protegidas
    next();
  } catch (err) {
    // Token expirado o manipulado: limpia la cookie y redirige
    res.clearCookie('token');
    return res.redirect('/login');
  }
};

// checkUser — middleware global (montado en '*' en server.js)
// No bloquea rutas: solo intenta hidratar res.locals.user y res.locals.impersonating
// Resultado: res.locals.user = doc User sin password, o null si no hay sesión válida
const checkUser = async (req, res, next) => {
  const token      = req.cookies.token;      // Token del usuario activo (o suplantado)
  const adminToken = req.cookies.adminToken; // Token del admin original durante suplantación

  if (!token) {
    // Sin sesión: pone null para que las vistas EJS no fallen al leer res.locals.user
    res.locals.user         = null;
    res.locals.impersonating = null;
    return next();
  }

  try {
    // Decodifica el token principal para obtener el userId
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Busca el usuario en la BD; excluye el campo password por seguridad
    res.locals.user = await User.findById(decoded.userId).select('-password');

    // Actualiza lastSeen como máximo cada 5 minutos (fire-and-forget, no bloquea la respuesta)
    if (res.locals.user) {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      User.updateOne(
        { _id: decoded.userId, $or: [{ lastSeen: { $lt: fiveMinAgo } }, { lastSeen: null }] },
        { $set: { lastSeen: new Date() } }
      ).catch(() => {});
    }

    // Si la cuenta está deshabilitada: borra ambas cookies y marca req.userDisabled
    // requireAuth revisa este flag antes de verificar el JWT
    if (res.locals.user && res.locals.user.active === false) {
      res.clearCookie('token');
      res.clearCookie('adminToken');
      res.locals.user         = null;
      res.locals.impersonating = null;
      req.userDisabled        = true;
      return next();
    }

    // Si hay adminToken, el admin está suplantando a otro usuario
    // adminToken guarda el JWT del admin original; se usa para volver con /exit-impersonate
    if (adminToken) {
      try {
        const adminDecoded = jwt.verify(adminToken, process.env.JWT_SECRET);
        res.locals.impersonating = await User.findById(adminDecoded.userId).select('-password');
      } catch {
        // adminToken inválido o expirado: lo ignoramos sin romper la sesión
        res.locals.impersonating = null;
      }
    } else {
      res.locals.impersonating = null;
    }
  } catch (err) {
    // Token principal inválido: limpia el estado (no redirige, eso lo hace requireAuth)
    res.locals.user         = null;
    res.locals.impersonating = null;
  }

  next();
};

module.exports = { requireAuth, checkUser };
