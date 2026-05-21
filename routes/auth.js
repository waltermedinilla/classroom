const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

const maxAge = 7 * 24 * 60 * 60 * 1000;

const createToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

router.get('/login', (req, res) => {
  if (req.cookies.token) return res.redirect('/');
  res.render('login');
});

router.get('/register', (req, res) => {
  if (req.cookies.token) return res.redirect('/');
  res.render('register', { roles: User.getRoles().filter(r => r !== 'admin') });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const userCount = await User.countDocuments();
    const userRole = userCount === 0 ? 'admin' : (role || 'student');
    const user = await User.create({ name, email, password, role: userRole });
    const token = createToken(user._id);
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.status(201).json({ user });
  } catch (err) {
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

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }
    const token = createToken(user._id);
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('adminToken');
  res.json({ message: 'Sesión cerrada' });
});

router.get('/exit-impersonate', (req, res) => {
  const adminToken = req.cookies.adminToken;
  if (!adminToken) return res.redirect('/');
  res.clearCookie('adminToken');
  try {
    jwt.verify(adminToken, process.env.JWT_SECRET);
    res.cookie('token', adminToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  } catch {
    res.clearCookie('token');
  }
  res.redirect('/admin');
});

module.exports = router;
