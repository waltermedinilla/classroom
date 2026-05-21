const express = require('express');
const multer = require('multer');
const path = require('path');
const Announcement = require('../models/Announcement');
const Course = require('../models/Course');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads');
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get('/course/:courseId', requireAuth, async (req, res) => {
  try {
    const announcements = await Announcement.find({ course: req.params.courseId })
      .populate('author', 'name email')
      .sort({ createdAt: 1 });
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/create', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { courseId, text } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const isOwner = course.owner.toString() === req.userId;
    const isStudent = course.students.some(s => s.toString() === req.userId);
    if (!isOwner && !isStudent) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const announcement = await Announcement.create({
      course: courseId,
      author: req.userId,
      text,
      image: req.file ? '/uploads/' + req.file.filename : null,
    });

    const populated = await announcement.populate('author', 'name email');
    res.status(201).json({ announcement: populated });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
