const express = require('express');
const Course = require('../models/Course');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const createdCourses = await Course.find({ owner: req.userId }).populate('owner', 'name email');
    const joinedCourses = await Course.find({ students: req.userId }).populate('owner', 'name email');
    res.render('dashboard', { createdCourses, joinedCourses });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

router.get('/create', requireAuth, (req, res) => {
  res.render('create-course');
});

router.post('/create', requireAuth, async (req, res) => {
  try {
    const { name, section, subject, room } = req.body;
    const course = await Course.create({ name, section, subject, room, owner: req.userId });
    res.status(201).json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/join', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const course = await Course.findOne({ code: code.toUpperCase() });
    if (!course) {
      return res.status(404).json({ error: 'No se encontró un curso con ese código' });
    }
    if (course.owner.toString() === req.userId) {
      return res.status(400).json({ error: 'No puedes unirte a tu propio curso' });
    }
    if (course.students.includes(req.userId)) {
      return res.status(400).json({ error: 'Ya estás en este curso' });
    }
    course.students.push(req.userId);
    await course.save();
    res.json({ course });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('students', 'name email');
    if (!course) {
      return res.status(404).send('Curso no encontrado');
    }
    const isOwner = course.owner._id.toString() === req.userId;
    const isStudent = course.students.some(s => s._id.toString() === req.userId);
    if (!isOwner && !isStudent) {
      return res.status(403).send('Acceso denegado');
    }
    res.render('course', { course });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

router.get('/:id/data', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('students', 'name email');
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    res.json({ course });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
