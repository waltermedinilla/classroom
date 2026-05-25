const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const Course   = require('../models/Course');
const User     = require('../models/User');
const Activity   = require('../models/Activity');
const Submission = require('../models/Submission');
const XLSX       = require('xlsx');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Base para archivos públicos (portadas de cursos: /archivos/{school}/headers/{courseId}/)
const HEADERS_BASE = path.join(__dirname, '../public/archivos');
// Base para avatares de usuarios: /archivos/{school}/avatars/{userId}/avatar.{ext}
const AVATARS_BASE = path.join(__dirname, '../public/archivos');

// Configuración multer para imágenes de portada del curso
// Destino: public/archivos/{schoolId}/headers/{courseId}/
const headerUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const dir = path.join(HEADERS_BASE, schoolId, 'headers', req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      req._headerDir = dir; // Guarda la ruta para usarla en el callback filename
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      try {
        // Antes de guardar la nueva portada, elimina la anterior del disco
        // Solo borra archivos que coincidan con el patrón header.{ext}
        if (req._headerDir && fs.existsSync(req._headerDir)) {
          fs.readdirSync(req._headerDir)
            .filter(f => /^header\.(jpg|jpeg|png|webp)$/.test(f))
            .forEach(f => fs.unlinkSync(path.join(req._headerDir, f)));
        }
      } catch {}
      cb(null, 'header' + ext); // Siempre se llama "header.ext" (sobreescribible)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB máximo
  fileFilter: (req, file, cb) => {
    cb(null, ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Configuración multer para avatar de usuario
// Destino: public/archivos/{schoolId}/avatars/{userId}/
// Siempre sobreescribe el archivo anterior (nombre fijo "avatar.ext")
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const userId   = req.res?.locals?.user?._id?.toString() || 'unknown';
      const dir = path.join(AVATARS_BASE, schoolId, 'avatars', userId);
      fs.mkdirSync(dir, { recursive: true });
      req._avatarDir = dir;
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      try {
        // Borra el avatar anterior antes de guardar el nuevo
        if (req._avatarDir && fs.existsSync(req._avatarDir)) {
          fs.readdirSync(req._avatarDir)
            .filter(f => /^avatar\.(jpg|jpeg|png|webp)$/.test(f))
            .forEach(f => fs.unlinkSync(path.join(req._avatarDir, f)));
        }
      } catch {}
      cb(null, 'avatar' + ext);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB máximo para avatares
  fileFilter: (req, file, cb) => {
    cb(null, ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file.originalname).toLowerCase()));
  },
});

// GET /courses — Dashboard: lista todos los cursos del usuario autenticado
// Para alumnos también calcula pendingSummary: actividades sin entregar que están abiertas
// Retorna cursos creados (isOwner: true) y cursos en los que está inscripto (isOwner: false)
router.get('/', requireAuth, async (req, res) => {
  try {
    const [created, joined] = await Promise.all([
      Course.find({ owner: req.userId }).populate('owner', 'name email'),
      Course.find({ students: req.userId }).populate('owner', 'name email'),
    ]);
    const courses = [
      ...created.map(c => ({ ...c.toObject(), isOwner: true  })),
      ...joined.map(c  => ({ ...c.toObject(), isOwner: false })),
    ].sort((a, b) => a.name.localeCompare(b.name, 'es'));

    // Resumen de pendientes: solo para alumnos, solo si tiene cursos
    let pendingSummary = null;
    if (res.locals.user?.role === 'student' && joined.length > 0) {
      const now        = new Date();
      const courseIds  = joined.map(c => c._id);

      // Actividades disponibles en los cursos del alumno
      const activities = await Activity.find({
        course:        { $in: courseIds },
        availableFrom: { $lte: now },
      }).select('_id dueDate allowLateSubmissions');

      // Actividades ya entregadas por este alumno
      const submissions  = await Submission.find({
        student:  req.userId,
        activity: { $in: activities.map(a => a._id) },
      }).select('activity');
      const submittedSet = new Set(submissions.map(s => s.activity.toString()));

      // Pendiente = sin entrega Y (sin fecha límite | fecha futura | tardías abiertas)
      const pending = activities.filter(a => {
        if (submittedSet.has(a._id.toString())) return false;
        if (!a.dueDate) return true;
        if (new Date(a.dueDate) >= now)         return true;
        if (a.allowLateSubmissions)             return true;
        return false;
      });

      // Las que vencen hoy (entre ahora y fin de día)
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 999);
      const dueToday = pending.filter(a => a.dueDate && new Date(a.dueDate) <= endOfToday).length;

      if (pending.length > 0) pendingSummary = { total: pending.length, dueToday };
    }

    res.render('dashboard', { courses, pendingSummary });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

router.get('/create', requireAuth, (req, res) => {
  res.render('create-course');
});

// POST /courses/create — Crea un nuevo curso
// Body: { name, section, subject, room }
// Hereda la escuela del usuario autenticado (res.locals.user.school)
// Retorna: { course } con 201
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { name, section, subject, room } = req.body;
    const course = await Course.create({
      name, section, subject, room,
      owner: req.userId,
      school: res.locals.user?.school || null, // El curso queda vinculado a la escuela del docente
    });
    res.status(201).json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/join — El alumno se une a un curso con su código de 6 caracteres
// Body: { code }
// Validación multi-escuela: si ambos tienen escuela, deben coincidir
router.post('/join', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    const course = await Course.findOne({ code: code.toUpperCase() }); // El código siempre está en mayúsculas
    if (!course) {
      return res.status(404).json({ error: 'No se encontró un curso con ese código' });
    }
    if (course.owner.toString() === req.userId) {
      return res.status(400).json({ error: 'No puedes unirte a tu propio curso' });
    }
    if (course.students.includes(req.userId)) {
      return res.status(400).json({ error: 'Ya estás en este curso' });
    }

    // Impide que alumnos de una escuela se unan a cursos de otra institución
    const userSchool   = res.locals.user?.school?.toString();
    const courseSchool = course.school?.toString();
    if (userSchool && courseSchool && userSchool !== courseSchool) {
      return res.status(403).json({ error: 'Este curso no pertenece a tu institución' });
    }

    course.students.push(req.userId);
    await course.save();
    res.json({ course });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /courses/profile — Perfil del usuario autenticado (docente o alumno)
// Docente: cursos creados, total alumnos, actividades creadas
// Alumno: cursos en los que está inscripto
router.get('/profile', requireAuth, async (req, res) => {
  try {
    if (res.locals.user?.role === 'student') {
      const joinedCourses = await Course.find({ students: req.userId }).populate('owner', 'name email');
      return res.render('profile', { joinedCourses, createdCourses: [], activityCount: 0, totalStudents: 0 });
    }
    const [createdCourses, activityCount] = await Promise.all([
      Course.find({ owner: req.userId }).populate('owner', 'name email'),
      Activity.countDocuments({ author: req.userId }),
    ]);
    const totalStudents = createdCourses.reduce((sum, c) => sum + c.students.length, 0);
    res.render('profile', { createdCourses, activityCount, totalStudents, joinedCourses: [] });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// POST /courses/profile/avatar — Sube o reemplaza el avatar del usuario autenticado
router.post('/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    const schoolId = res.locals.user?.school?.toString() || 'general';
    const userId   = res.locals.user._id.toString();
    const avatarUrl = `/archivos/${schoolId}/avatars/${userId}/${req.file.filename}`;
    await User.findByIdAndUpdate(userId, { avatar: avatarUrl });
    res.json({ avatar: avatarUrl });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: 'Error al guardar el avatar' });
  }
});

// DELETE /courses/profile/avatar — Elimina el avatar del usuario y vuelve a usar la inicial
router.delete('/profile/avatar', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (user.avatar) {
      try {
        fs.unlinkSync(path.join(__dirname, '../public', user.avatar));
      } catch {}
      await User.findByIdAndUpdate(user._id, { avatar: null });
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error al eliminar el avatar' });
  }
});

// GET /courses/:id — Página principal de un curso (stream de novedades + tabs)
// Solo accede el owner o un alumno inscripto
// Renderiza la vista course.ejs con el doc Course populado
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('students', 'name email dni active avatar'); // avatar para mostrar foto de perfil
    if (!course) {
      return res.status(404).send('Curso no encontrado');
    }
    const isOwner   = course.owner._id.toString() === req.userId;
    const isStudent = course.students.some(s => s._id.toString() === req.userId);
    if (!isOwner && !isStudent) {
      return res.status(403).send('Acceso denegado');
    }
    res.render('course', { course });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// POST /courses/:id/add-student — El docente agrega un alumno por email
// Body: { email }
// Validación multi-escuela: alumno y curso deben ser de la misma institución
router.post('/:id/add-student', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== req.userId) {
      return res.status(403).json({ error: 'Solo el docente puede agregar alumnos' });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'El correo es requerido' });

    const student = await User.findOne({ email: email.toLowerCase().trim() });
    if (!student) return res.status(404).json({ error: 'No se encontró ningún usuario con ese correo' });
    if (student._id.toString() === req.userId) {
      return res.status(400).json({ error: 'No podés agregarte a vos mismo como alumno' });
    }

    // Verifica que ambos pertenezcan a la misma escuela (solo cuando ambos tienen escuela asignada)
    if (course.school && student.school && course.school.toString() !== student.school.toString()) {
      return res.status(403).json({ error: 'El alumno no pertenece a esta institución' });
    }
    if (course.students.some(s => s.toString() === student._id.toString())) {
      return res.status(400).json({ error: 'El alumno ya está inscripto en este curso' });
    }

    course.students.push(student._id);
    await course.save();
    res.json({ student: { _id: student._id, name: student.name, email: student.email } });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /courses/:id/students/:studentId — El docente quita un alumno del curso
// Bloqueado si el alumno ya entregó alguna actividad en este curso (datos que no deben perderse)
router.delete('/:id/students/:studentId', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== req.userId) {
      return res.status(403).json({ error: 'Solo el docente puede quitar alumnos' });
    }
    if (!course.students.some(s => s.toString() === req.params.studentId)) {
      return res.status(404).json({ error: 'Alumno no encontrado en este curso' });
    }

    // Bloquea si el alumno tiene entregas en alguna actividad del curso
    const activityIds = await Activity.find({ course: req.params.id }).distinct('_id');
    const hasSubmission = await Submission.exists({
      activity: { $in: activityIds },
      student:  req.params.studentId,
    });
    if (hasSubmission) {
      return res.status(409).json({ error: 'No se puede quitar al alumno porque ya realizó entregas en este curso.' });
    }

    course.students = course.students.filter(s => s.toString() !== req.params.studentId);
    await course.save();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/:id/students/:studentId/toggle-active — El docente habilita o deshabilita un alumno
// Solo el owner del curso puede hacerlo; no aplica a la cuenta protegida ni al propio docente
router.post('/:id/students/:studentId/toggle-active', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== req.userId) {
      return res.status(403).json({ error: 'Solo el docente puede modificar alumnos' });
    }
    if (!course.students.some(s => s.toString() === req.params.studentId)) {
      return res.status(404).json({ error: 'Alumno no encontrado en este curso' });
    }
    const student = await User.findById(req.params.studentId).select('active email role');
    if (!student) return res.status(404).json({ error: 'Usuario no encontrado' });
    student.active = !(student.active !== false); // false o undefined → true; true → false
    await student.save();
    res.json({ active: student.active });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /courses/:id/gradebook — Tabla de notas del docente (todas las actividades × todos los alumnos)
// Solo accesible por el owner del curso
// Retorna: { students, activities, gradeMap } donde gradeMap[actId][studentId] = points
router.get('/:id/gradebook', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('students', 'name email');
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== req.userId) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const activities = await Activity.find({ course: req.params.id })
      .sort({ createdAt: -1 });

    // Construye un mapa anidado para acceso O(1) en el frontend: gradeMap[actId][studentId]
    const gradeMap = {};
    activities.forEach(act => {
      gradeMap[act._id.toString()] = {};
      act.grades.forEach(g => {
        gradeMap[act._id.toString()][g.student.toString()] = g.points;
      });
    });

    res.json({
      students:   course.students,
      activities: activities.map(a => ({ _id: a._id, title: a.title, dueDate: a.dueDate, points: a.points })),
      gradeMap,
    });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /courses/:id/export-students — Genera y descarga un Excel con la lista de alumnos del curso
// Solo accesible por el owner del curso
router.get('/:id/export-students', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('students', 'name email dni active');
    if (!course) return res.status(404).send('Curso no encontrado');
    if (course.owner.toString() !== req.userId) return res.status(403).send('Sin acceso');

    const rows = course.students.map((s, i) => ({
      '#':       i + 1,
      'Nombre':  s.name,
      'DNI':     s.dni || '',
      'Email':   s.email,
      'Estado':  s.active === false ? 'Deshabilitado' : 'Activo',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length)) + 2,
    }));
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Alumnos');
    const safeName = course.name.replace(/[^a-z0-9áéíóúüñ ]/gi, '_').trim();
    const filename = `${safeName}_alumnos.xlsx`;
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error al generar el archivo: ' + err.message);
  }
});

// GET /courses/:id/data — Devuelve el doc completo del curso como JSON (usado por el frontend)
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

// POST /courses/:id/customize — El docente personaliza la portada del curso
// multipart/form-data: { mode, color, color2?, removeImage?, image? }
// mode "image": guarda imagen con fusión de color. mode "gradient" / "solid": solo colores
// Retorna: { header } con los nuevos valores guardados
router.post('/:id/customize', requireAuth, headerUpload.single('image'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== req.userId) {
      return res.status(403).json({ error: 'Solo el docente puede personalizar el curso' });
    }

    const { mode, color, color2, removeImage } = req.body;
    const schoolId  = res.locals.user?.school?.toString() || 'general';
    const newHeader = {};

    if (mode === 'image') {
      newHeader.color  = color  || '#1a73e8';
      newHeader.color2 = null; // Modo imagen no usa degradado

      if (req.file) {
        // Nueva imagen subida: construye la URL pública
        newHeader.image = `/archivos/${schoolId}/headers/${req.params.id}/${req.file.filename}`;
      } else if (removeImage === 'true') {
        // El docente eligió quitar la imagen: la borra del disco y setea null
        if (course.header?.image) {
          try { fs.unlinkSync(path.join(__dirname, '../public', course.header.image)); } catch {}
        }
        newHeader.image = null;
      } else {
        // Sin cambio en la imagen: mantiene la anterior
        newHeader.image = course.header?.image || null;
      }
    } else {
      // Modo color sólido o degradado: elimina imagen anterior si existía
      if (course.header?.image) {
        try { fs.unlinkSync(path.join(__dirname, '../public', course.header.image)); } catch {}
      }
      newHeader.color  = color  || '#1a73e8';
      newHeader.color2 = color2 || null; // null = color sólido (sin degradado)
      newHeader.image  = null;
    }

    await Course.findByIdAndUpdate(req.params.id, { $set: { header: newHeader } });
    res.json({ header: newHeader });
  } catch (err) {
    // Si multer subió un archivo antes de que ocurra el error, lo limpia del disco
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: 'Error al guardar la personalización' });
  }
});

module.exports = router;
