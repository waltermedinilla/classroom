const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const Announcement = require('../models/Announcement');
const Course   = require('../models/Course');
const { requireAuth } = require('../middleware/auth');
const { logAudit }    = require('../middleware/audit');
const { uploadLimiter } = require('../middleware/rate-limits');
const { logDeRuta } = require('../middleware/route-log');
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
    logDeRuta(err, res);
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
    const allowed = course.canManage(res.locals.user) || course.students.some(s => s.toString() === uid);
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
    logDeRuta(e, res);
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
    const isOwner   = course.canManage(res.locals.user);
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
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /announcements/:id — edita el texto de una novedad. SOLO el autor: nadie corrige
// palabras ajenas, ni siquiera el admin (para eso está el borrado). La imagen no se toca
// acá; para cambiarla hay que borrar la novedad y publicarla de nuevo.
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'La novedad no puede estar vacía' });

    const ann = await Announcement.findById(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Novedad no encontrada' });
    if (ann.author.toString() !== req.userId) {
      return res.status(403).json({ error: 'Solo podés editar tus propias novedades' });
    }

    const course = await Course.findById(ann.course);
    // La materia se borró por debajo: sin curso no hay contexto para auditar ni permisos.
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const textoAnterior = ann.text;
    ann.text     = text.trim();
    ann.editedAt = new Date();
    await ann.save();
    await ann.populate('author', 'name email');
    await ann.populate('comments.author', 'name');

    logAudit(req, 'announcement.edit',
      [
        { type: 'announcement', id: ann._id,    name: ann.text.slice(0, 60) },
        { type: 'course',       id: course._id, name: course.name },
      ],
      textoAnterior !== ann.text ? { de: textoAnterior.slice(0, 60), a: ann.text.slice(0, 60) } : {},
    );

    res.json({ announcement: ann });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /announcements/:id/delete — elimina una novedad, sus comentarios (son subdocumentos,
// se van con ella) y su imagen del disco. Además del autor puede hacerlo quien gestiona la
// materia (docente titular/suplente o admin de la escuela): es la única vía de moderación
// sobre una novedad publicada por un alumno.
router.post('/:id/delete', requireAuth, async (req, res) => {
  try {
    const ann = await Announcement.findById(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Novedad no encontrada' });

    const course = await Course.findById(ann.course);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const esAutor = ann.author.toString() === req.userId;
    if (!esAutor && !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // La imagen vive en /public/archivos/... y su URL la armamos nosotros al crearla.
    // Se resuelve contra ARCHIVOS_BASE y se verifica que no escape de ahí antes de borrar.
    if (ann.image && ann.image.startsWith('/archivos/')) {
      const fp = path.join(ARCHIVOS_BASE, ann.image.replace(/^\/archivos\//, ''));
      if (fp.startsWith(ARCHIVOS_BASE) && fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch {}
      }
    }

    await Announcement.findByIdAndDelete(ann._id);

    logAudit(req, 'announcement.delete',
      [
        { type: 'announcement', id: ann._id,    name: (ann.text || '').slice(0, 60) },
        { type: 'course',       id: course._id, name: course.name },
      ],
      {
        comentarios: (ann.comments || []).length,
        // Distingue el borrado propio de la moderación sobre una novedad ajena.
        como: esAutor ? 'autor' : 'moderación',
      },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
