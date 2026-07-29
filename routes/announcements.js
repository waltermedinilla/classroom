const express  = require('express');
const path     = require('path');
const Announcement = require('../models/Announcement');
const Course   = require('../models/Course');
const { requireAuth } = require('../middleware/auth');
const { logAudit }    = require('../middleware/audit');
const { uploadLimiter } = require('../middleware/rate-limits');
// La imagen se recibe en memoria y se guarda ya redimensionada y en WebP
// (preset 'novedad': 1600 px de lado mayor). Ver middleware/image-upload.js.
const {
  subirImagen, guardarImagenOptimizada, ImagenInvalidaError,
} = require('../middleware/image-upload');

const router = express.Router();

// Base para los archivos de novedades (dentro de /public → acceso estático)
// Destino: public/archivos/{schoolId}/novedades/{courseId}/
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

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

    // Verifica que el usuario sea miembro del curso (docente o alumno inscripto)
    const course  = await Course.findById(ann.course);
    const uid     = req.userId;
    const allowed = course.isTeacher(uid) || course.students.some(s => s.toString() === uid);
    if (!allowed) return res.status(403).json({ error: 'Sin acceso' });

    // Inserta el comentario en el array anidado y guarda el documento
    ann.comments.push({ author: uid, text: text.trim() });
    await ann.save();

    // Populamos el autor del último comentario para devolver datos completos al frontend
    await ann.populate('comments.author', 'name');
    const newComment = ann.comments[ann.comments.length - 1];

    logAudit(req, 'announcement.comment',
      [
        { type: 'announcement', id: ann._id,    name: (ann.text || '').slice(0, 60) },
        { type: 'course',       id: course._id, name: course.name },
      ],
      {},
    );

    res.status(201).json({ comment: newComment });
  } catch (e) {
    res.status(500).json({ error: 'Error al comentar' });
  }
});

// POST /announcements/create
// Crea una nueva novedad en un curso; opcionalmente con imagen adjunta
// multipart/form-data: { courseId, text, image? }
// Retorna: { announcement } con autor populado
router.post('/create', requireAuth, uploadLimiter, subirImagen('image'), async (req, res) => {
  try {
    const { courseId, text } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    // Tanto el docente (owner o co-docente) como los alumnos inscriptos pueden publicar novedades
    const isOwner   = course.isTeacher(req.userId);
    const isStudent = course.students.some(s => s.toString() === req.userId);
    if (!isOwner && !isStudent) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    // Si se subió imagen, se optimiza, se escribe en disco y se arma la URL pública.
    // Sin `base`: cada novedad tiene su propia imagen, no reemplaza a ninguna anterior.
    // El permiso ya está validado arriba, así que recién acá se toca el disco.
    const schoolId = res.locals.user.school?.toString() || 'general';
    let imageUrl = null;
    if (req.file) {
      const dir = path.join(ARCHIVOS_BASE, schoolId, 'novedades', courseId);
      const guardada = await guardarImagenOptimizada(req.file, { preset: 'novedad', dir });
      imageUrl = `/archivos/${schoolId}/novedades/${courseId}/${guardada.filename}`;
    }

    const announcement = await Announcement.create({
      course: courseId,
      author: req.userId,
      text,
      image: imageUrl,
    });

    // Populamos el autor para que el frontend pueda mostrar el nombre inmediatamente
    const populated = await announcement.populate('author', 'name email');

    logAudit(req, 'announcement.create',
      [
        { type: 'announcement', id: announcement._id, name: (text || '').slice(0, 60) },
        { type: 'course',       id: course._id,       name: course.name },
      ],
      {
        con_imagen: req.file ? 'sí' : 'no',
      },
    );

    res.status(201).json({ announcement: populated });
  } catch (err) {
    if (err instanceof ImagenInvalidaError) {
      return res.status(400).json({ error: err.message });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
