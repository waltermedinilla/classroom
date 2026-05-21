const jwt = require('jsonwebtoken');
const User = require('../models/User');

const requireAuth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.clearCookie('token');
    return res.redirect('/login');
  }
};

const checkUser = async (req, res, next) => {
  const token = req.cookies.token;
  const adminToken = req.cookies.adminToken;

  if (!token) {
    res.locals.user = null;
    res.locals.impersonating = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    res.locals.user = await User.findById(decoded.userId).select('-password');

    if (adminToken) {
      try {
        const adminDecoded = jwt.verify(adminToken, process.env.JWT_SECRET);
        res.locals.impersonating = await User.findById(adminDecoded.userId).select('-password');
      } catch {
        res.locals.impersonating = null;
      }
    } else {
      res.locals.impersonating = null;
    }
  } catch (err) {
    res.locals.user = null;
    res.locals.impersonating = null;
  }

  next();
};

module.exports = { requireAuth, checkUser };
