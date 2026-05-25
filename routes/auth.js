const express = require('express');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const School = require('../models/School');

const router = express.Router();

// Duración de la sesión: 7 días en milisegundos (para la cookie) y en texto (para el JWT)
const maxAge = 7 * 24 * 60 * 60 * 1000;

// Crea un JWT firmado con el secreto del .env; expiración en 7 días
// Retorna el token string que se setea como cookie httpOnly
const createToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

// GET /login — muestra el formulario de login
// Si ya tiene cookie válida, redirige directo al inicio
router.get('/login', (req, res) => {
  if (req.cookies.token) return res.redirect('/');
  res.render('login');
});

// GET /register — muestra el formulario de registro
// Pasa los roles disponibles excluyendo 'admin' (los admins solo los crea el superadmin)
router.get('/register', (req, res) => {
  if (req.cookies.token) return res.redirect('/');
  res.render('register', { roles: User.getRoles().filter(r => r !== 'admin') });
});

// POST /register — crea un nuevo usuario y abre sesión inmediatamente
// Body: { name, email, password, role }
// Retorna: { user } con 201, o error 400 si email duplicado / validación falla
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const userRole = role || 'student'; // Si no se envía rol, se asigna student por defecto
    const user = await User.create({ name, email, password, role: userRole });

    // Genera token y lo pone en cookie httpOnly (no accesible desde JS del navegador)
    const token = createToken(user._id);
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.status(201).json({ user });
  } catch (err) {
    // Error 11000 = índice único violado → email ya registrado
    if (err.code === 11000) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /login — autentica al usuario con email + contraseña
// Body: { email, password }
// Retorna: { user } con 200, o error 400/403 si credenciales inválidas o cuenta deshabilitada
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Busca por email (insensible a mayúsculas por el índice lowercase del schema)
    const user = await User.findOne({ email });
    if (!user) {
      // Mensaje genérico para no revelar si el email existe o no
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }

    // Compara la contraseña enviada con el hash bcrypt almacenado
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }

    // Cuenta deshabilitada: no puede iniciar sesión aunque las credenciales sean correctas
    if (user.active === false) {
      return res.status(403).json({ error: 'Tu cuenta está deshabilitada. Contactá al administrador.' });
    }

    const token = createToken(user._id);
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /register/invite/:token — muestra el formulario de registro vinculado a una escuela
// Si el token no existe en ninguna escuela → pantalla de enlace inválido
router.get('/register/invite/:token', async (req, res) => {
  if (req.cookies.token) return res.redirect('/');
  try {
    const school = await School.findOne({ inviteToken: req.params.token });
    const roles = User.getRoles().filter(r => !['superadmin', 'admin'].includes(r));
    // school=null indica enlace inválido; la vista maneja ambos casos
    res.render('invite-register', { school: school || null, token: req.params.token, roles });
  } catch (err) {
    res.render('invite-register', { school: null, token: req.params.token, roles: [] });
  }
});

// POST /register/invite/:token — crea el usuario y lo asocia a la escuela del enlace
// Body: { name, email, password, role }
// Retorna: { user } 201 o error 400
router.post('/register/invite/:token', async (req, res) => {
  try {
    const school = await School.findOne({ inviteToken: req.params.token });
    if (!school) return res.status(400).json({ error: 'El enlace no es válido o fue revocado.' });

    const { name, email, password, role } = req.body;
    // Solo roles no privilegiados pueden auto-registrarse por invitación
    const allowed = ['student', 'teacher', 'preceptor', 'soe', 'directivo'];
    const userRole = allowed.includes(role) ? role : 'student';

    const user = await User.create({ name, email, password, role: userRole, school: school._id });
    const token = createToken(user._id);
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /logout — cierra la sesión borrando las cookies
// Limpia también adminToken por si estaba en modo suplantación
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('adminToken');
  res.json({ message: 'Sesión cerrada' });
});

// GET /exit-impersonate — el admin vuelve a su propia sesión después de suplantar un usuario
// Mecanismo: adminToken guarda el JWT original del admin → se restaura como token principal
router.get('/exit-impersonate', (req, res) => {
  const adminToken = req.cookies.adminToken;
  if (!adminToken) return res.redirect('/');

  res.clearCookie('adminToken');
  try {
    // Verifica que el adminToken siga siendo válido (no expirado)
    jwt.verify(adminToken, process.env.JWT_SECRET);
    // Restaura la sesión del admin original
    res.cookie('token', adminToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  } catch {
    // Si el adminToken expiró, cierra sesión completamente
    res.clearCookie('token');
  }
  res.redirect('/admin'); // Vuelve al panel de administración
});

module.exports = router;
