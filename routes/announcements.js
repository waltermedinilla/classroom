const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const Announcement = require('../models/Announcement');
const Course   = require('../models/Course');
const { requireAuth } = require('../middleware/auth');

const fs = require('fs');
const router = express.Router();

// Base para los archivos de novedades (dentro de /public → acceso estático)
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

// Configuración de almacenamiento de imágenes de novedades
// Destino: public/archivos/{schoolId}/novedades/{courseId}/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // schoolId viene del usuario autenticado; courseId viene del body del formulario
    const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
    const courseId = req.body.courseId || 'general';
    const dir = path.join(ARCHIVOS_BASE, schoolId, 'novedades', courseId);
    fs.mkdirSync(dir, { recursive: true }); // Crea la carpeta si no existe
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Nombre único: timestamp + número aleatorio + extensión original
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

// Multer: solo acepta imágenes (jpeg, jpg, png, gif, webp) de hasta 5 MB
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk  = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) return cb(null, true);
    cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif, webp)'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// GET /announcements/course/:courseId
// Devuelve todas las novedades de un curso, con autor y comentarios populados
// Ordenadas de más antigua a más nueva (para construir el stream cronológico en el frontend)
router.get('/course/:courseId', requireAuth, async (req, res) => {
  try {
    const announcements = await Announcement.find({ course: req.params.courseId })
      .populate('author', 'name email')      // Nombre del que publicó
      .populate('comments.author', 'name')   // Nombre de cada comentarista
      .sort({ createdAt: 1 });               // Ascendente: los más viejos primero
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /announcements/:id/comment
// Agrega un comentario a una novedad existente
// Body: { text }
// Retorna: { comment } con el nuevo comentario populado con el nombre del autor
router.post('/:id/comment', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'El comentario no puede estar vacío' });

    const ann = await Announcement.findById(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Novedad no encontrada' });

    // Verifica que el usuario sea miembro del curso (owner o alumno inscripto)
    const course  = await Course.findById(ann.course);
    const uid     = req.userId;
    const allowed = course.owner.toString() === uid || course.students.some(s => s.toString() === uid);
    if (!allowed) return res.status(403).json({ error: 'Sin acceso' });

    // Inserta el comentario en el array anidado y guarda el documento
    ann.comments.push({ author: uid, text: text.trim() });
    await ann.save();

    // Populamos el autor del último comentario para devolver datos completos al frontend
    await ann.populate('comments.author', 'name');
    const newComment = ann.comments[ann.comments.length - 1];
    res.status(201).json({ comment: newComment });
  } catch (e) {
    res.status(500).json({ error: 'Error al comentar' });
  }
});

// POST /announcements/create
// Crea una nueva novedad en un curso; opcionalmente con imagen adjunta
// multipart/form-data: { courseId, text, image? }
// Retorna: { announcement } con autor populado
router.post('/create', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { courseId, text } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    // Tanto el docente como los alumnos inscriptos pueden publicar novedades
    const isOwner   = course.owner.toString() === req.userId;
    const isStudent = course.students.some(s => s.toString() === req.userId);
    if (!isOwner && !isStudent) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    // Si se subió imagen, construye la URL pública; si no, guarda null
    const announcement = await Announcement.create({
      course: courseId,
      author: req.userId,
      text,
      image: req.file
        ? `/archivos/${res.locals.user.school?.toString() || 'general'}/novedades/${courseId}/${req.file.filename}`
        : null,
    });

    // Populamos el autor para que el frontend pueda mostrar el nombre inmediatamente
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
