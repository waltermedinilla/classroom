const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const Activity   = require('../models/Activity');
const Course     = require('../models/Course');
const Submission = require('../models/Submission');
const User       = require('../models/User');
const XLSX       = require('xlsx');
const { requireAuth } = require('../middleware/auth');
const { logAudit }    = require('../middleware/audit');

// Adjuntos del docente: dentro de /public (acceso estático directo)
// Estructura: public/archivos/{schoolId}/actividades/{courseId}/{filename}
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

// Entregas de alumnos: FUERA de /public (protegidas por ruta auth)
// Estructura: archivos/entregas/{schoolId}/{activityId}/{studentId}/{filename}
const ENTREGAS_BASE = path.join(__dirname, '../archivos/entregas');

// Extensiones permitidas para adjuntos del docente
const EXT_ALLOWED     = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
// Extensiones permitidas para entregas de alumnos (incluye imágenes y zip)
const EXT_SUBMISSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.gif', '.zip'];

// Genera un nombre único para evitar colisiones en disco: timestamp + random + extensión original
function uniqueFilename(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  return Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
}

// Multer para adjuntos del docente al crear/editar actividades
// schoolId y courseId vienen de res.locals.user y req.body.courseId respectivamente
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const courseId = req.body.courseId || 'general';
      const dir = path.join(ARCHIVOS_BASE, schoolId, 'actividades', courseId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB por archivo
  fileFilter: (req, file, cb) => {
    cb(null, EXT_ALLOWED.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const SUBMISSION_MAX_SIZE = 20 * 1024 * 1024; // 20 MB por archivo

// Multer para entregas de alumnos
// req.params.id = activityId; req.userId = studentId (seteado por requireAuth)
const submissionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const dir = path.join(ENTREGAS_BASE, schoolId, req.params.id, req.userId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: SUBMISSION_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    cb(null, EXT_SUBMISSIONS.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// GET /activities/new?courseId=...
// Renderiza el formulario de creación de actividad; solo el owner del curso puede acceder
router.get('/new', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.query.courseId).populate('owner', 'name');
    if (!course || course.owner._id.toString() !== res.locals.user._id.toString()) {
      return res.redirect('/courses');
    }
    res.render('activities/new', { course });
  } catch {
    res.redirect('/courses');
  }
});

// GET /activities/course/:courseId
// Lista las actividades de un curso para el usuario autenticado
// Si es owner: devuelve todas las actividades con el array completo de grades
// Si es alumno: solo actividades con availableFrom <= ahora; grades filtrado a su propia nota (myGrade)
// Retorna: { activities: [...], isOwner: bool }
router.get('/course/:courseId', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const userId  = res.locals.user._id.toString();
    const isOwner = course.owner.toString() === userId;

    const query = { course: req.params.courseId };
    // Los alumnos solo ven actividades que ya fueron publicadas (availableFrom <= ahora).
    // Además, si tienen enrollmentDate para este curso (o sea, fueron dados de alta con el
    // flujo "Nuevo usuario → seleccionar Curso"), ocultamos las tareas cuya fecha de entrega
    // ya venció ANTES de que se inscribieran — no las pudieron haber hecho. Se dejan visibles
    // las que no tienen dueDate (nunca vencen) y las que el docente marcó con tardías abiertas
    // (decisión explícita del usuario: si el docente abrió tardías, todos ven la actividad,
    // incluso los alumnos recién llegados). Alumnos sin enrollmentDate (los que ya estaban
    // antes de esta feature, o los que agregó el docente manualmente) ven todo — backward compat.
    if (!isOwner) {
      query.availableFrom = { $lte: new Date() };
      const joinedAt = course.enrollmentDates?.get?.(userId);
      if (joinedAt) {
        query.$or = [
          { dueDate: null },
          { dueDate: { $gte: joinedAt } },
          { allowLateSubmissions: true },
        ];
      }
    }

    const activities = await Activity.find(query)
      .populate('author', 'name')
      .sort({ createdAt: -1 }); // Más recientes primero

    let result;
    if (isOwner) {
      // Para el docente: agrega conteo de entregas por actividad (para el chip "X/Y entregaron")
      const counts = await Submission.aggregate([
        { $match: { activity: { $in: activities.map(a => a._id) } } },
        { $group: { _id: '$activity', count: { $sum: 1 } } },
      ]);
      const countMap     = {};
      counts.forEach(c => { countMap[c._id.toString()] = c.count; });
      const totalStudents = course.students.length;

      result = activities.map(act => {
        const obj          = act.toObject();
        obj.submittedCount = countMap[obj._id.toString()] || 0;
        obj.totalStudents  = totalStudents;
        return obj;
      });
    } else {
      result = activities.map(act => {
        const obj = act.toObject();
        // Para el alumno: extrae solo su propia calificación del array grades y borra el resto
        const myGrade = act.grades.find(g => g.student.toString() === userId);
        obj.myGrade = myGrade ? { points: myGrade.points, feedback: myGrade.feedback || '' } : null;
        delete obj.grades; // No exponer notas de otros alumnos
        return obj;
      });
    }

    res.json({ activities: result, isOwner });
  } catch {
    res.status(500).json({ error: 'Error al cargar actividades' });
  }
});

// POST /activities/create
// Crea una nueva actividad con adjuntos y/o links
// multipart/form-data: { courseId, title, description?, dueDate?, availableFrom?, points?, links?, files? }
// links es un JSON string de array: [{ url, name? }]
// Retorna: { activity } con autor populado (201)
router.post('/create', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    const { courseId, title, description, dueDate, availableFrom, points, links, type } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Solo el docente puede crear actividades' });
    }

    const schoolId    = res.locals.user.school?.toString() || 'general';
    const attachments = [];

    // Archivos pre-subidos vía /upload-attachment (URL ya guardada en disco)
    if (req.body.uploadedFiles) {
      JSON.parse(req.body.uploadedFiles).forEach(f => {
        if (f.url) attachments.push({ type: 'file', name: f.name, url: f.url, mime: f.mime || '' });
      });
    }

    // Archivos enviados directamente en el FormData (compatibilidad)
    (req.files || []).forEach(f => {
      attachments.push({
        type: 'file',
        name: f.originalname,
        url:  `/archivos/${schoolId}/actividades/${courseId}/${f.filename}`,
        mime: f.mimetype,
      });
    });

    // Parsea y agrega los links; se valida que tengan url
    if (links) {
      JSON.parse(links).forEach(l => {
        if (l.url) attachments.push({ type: 'link', name: l.name || l.url, url: l.url, mime: '' });
      });
    }

    const activity = await Activity.create({
      course:        courseId,
      author:        res.locals.user._id,
      title:         title?.trim(),
      description:   description?.trim() || '',
      dueDate:       dueDate || null,
      availableFrom: availableFrom || new Date(), // Por defecto: disponible de inmediato
      points:        points !== '' && points != null ? Number(points) : null,
      type:          type || 'tarea',
      attachments,
    });

    await activity.populate('author', 'name');

    logAudit(req, 'activity.create',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        tipo:      activity.type,
        adjuntos:  attachments.length,
        ...(activity.points != null ? { puntos: activity.points } : {}),
      },
    );

    res.status(201).json({ activity });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al crear actividad' });
  }
});

// Multer exclusivo para pre-subida: lee courseId desde req.query para evitar problemas
// de timing con el stream multipart (los text fields del body llegan junto con el archivo)
const uploadSingle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const courseId = req.query.courseId || 'general';
      const dir = path.join(ARCHIVOS_BASE, schoolId, 'actividades', courseId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB para PDFs escolares grandes
  fileFilter: (req, file, cb) => {
    cb(null, EXT_ALLOWED.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// POST /activities/upload-attachment?courseId=...
// Pre-sube un adjunto antes de crear la actividad; courseId viene en la query string.
// Body multipart: { file }
// Retorna: { url, name, mime }
router.post('/upload-attachment', requireAuth, (req, res, next) => {
  // Intercepta errores de multer para devolver JSON en español en lugar del mensaje en inglés
  uploadSingle.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'El archivo es demasiado grande (máximo 50 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Error al procesar el archivo' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tipo de archivo no permitido (PDF, Word, Excel)' });
    const courseId = req.query.courseId;
    const course = await Course.findById(courseId);
    if (!course) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Curso no encontrado' });
    }
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Sin acceso al curso' });
    }
    const schoolId = res.locals.user.school?.toString() || 'general';
    const url = `/archivos/${schoolId}/actividades/${courseId}/${req.file.filename}`;
    res.json({ url, name: req.file.originalname, mime: req.file.mimetype });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: err.message || 'Error al subir el archivo' });
  }
});

// GET /activities/my-pending
// Página del alumno: listado de todas sus actividades pendientes en todos sus cursos
// Solo accesible para alumnos (redirige a /courses si el rol no es student)
router.get('/my-pending', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (user.role !== 'student') return res.redirect('/courses');

    const now = new Date();
    // Traemos también enrollmentDates para poder aplicar por curso el mismo filtro de
    // "no mostrar actividades vencidas antes de la inscripción del alumno" que usamos en
    // GET /activities/course/:id. Sin este filtro acá, "Mis pendientes" mostraría tareas
    // que no le figuran al alumno cuando entra al curso — inconsistencia visible al usuario.
    const joinedCourses = await Course.find({ students: user._id }).select('name _id enrollmentDates');
    const courseIds = joinedCourses.map(c => c._id);
    const userIdStr = user._id.toString();
    const joinedAtByCourse = {};
    joinedCourses.forEach(c => {
      const dt = c.enrollmentDates?.get?.(userIdStr);
      if (dt) joinedAtByCourse[c._id.toString()] = dt;
    });

    const activities = await Activity.find({
      course:        { $in: courseIds },
      availableFrom: { $lte: now },
    }).populate('course', 'name').sort({ dueDate: 1, createdAt: 1 });

    const submissions = await Submission.find({
      student:  user._id,
      activity: { $in: activities.map(a => a._id) },
    }).select('activity');
    const submittedSet = new Set(submissions.map(s => s.activity.toString()));

    // Filtra las que están realmente pendientes (sin entrega y plazo aún abierto)
    // + oculta las vencidas ANTES de la inscripción del alumno (misma regla que /course/:id)
    const pending = activities.filter(a => {
      if (submittedSet.has(a._id.toString())) return false;
      // Regla de inscripción: solo aplica si el alumno tiene joinedAt registrado para ese curso
      const joinedAt = joinedAtByCourse[a.course._id.toString()];
      if (joinedAt && a.dueDate && new Date(a.dueDate) < joinedAt && !a.allowLateSubmissions) {
        return false;
      }
      if (!a.dueDate) return true;
      if (new Date(a.dueDate) >= now) return true;
      if (a.allowLateSubmissions) return true;
      return false;
    });

    res.render('activities/pending', { pending });
  } catch {
    res.status(500).send('Error del servidor');
  }
});

// GET /activities/:id/grades
// Devuelve la actividad + notas por alumno para el docente
// Construye la lista cruzando course.students con activity.grades
// Retorna: { activity, studentGrades: [{ _id, name, email, points }] }
router.get('/:id/grades', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id).populate('author', 'name');
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course).populate('students', 'name email');
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // Índice O(1) studentId → { points, feedback } para cruzar con la lista de alumnos
    const gradeMap = {};
    activity.grades.forEach(g => {
      gradeMap[g.student.toString()] = { points: g.points, feedback: g.feedback || '' };
    });

    // Para cada alumno inscripto: su nota y feedback, o null si no fue calificado todavía
    const studentGrades = course.students.map(s => ({
      _id:      s._id,
      name:     s.name,
      email:    s.email,
      points:   gradeMap[s._id.toString()]?.points ?? null,
      feedback: gradeMap[s._id.toString()]?.feedback || '',
    }));

    res.json({ activity, studentGrades });
  } catch {
    res.status(500).json({ error: 'Error al cargar calificaciones' });
  }
});

// POST /activities/:id/grade
// Guarda o actualiza la nota y el feedback de un alumno (solo el docente owner)
// Body: { studentId, points, feedback? }
// Upsert manual: si ya existe un registro de ese alumno lo actualiza, si no lo inserta
router.post('/:id/grade', requireAuth, async (req, res) => {
  try {
    const { studentId, points, feedback } = req.body;
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const existing = activity.grades.find(g => g.student.toString() === studentId);
    if (existing) {
      existing.points   = Number(points);
      existing.gradedAt = new Date();
      if (feedback !== undefined) existing.feedback = feedback.trim();
    } else {
      activity.grades.push({ student: studentId, points: Number(points), feedback: (feedback || '').trim() });
    }

    await activity.save();

    // Snapshot del alumno calificado (nombre para el log). Query minimal, solo name.
    const student = await User.findById(studentId).select('name').lean();
    logAudit(req, 'submission.grade',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'user',     id: studentId,    name: student?.name || '' },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        puntos: Number(points),
        ...(activity.points != null ? { maximo: activity.points } : {}),
      },
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /activities/:id
// Elimina una actividad con CASCADA COMPLETA:
// 1. Borra archivos de entrega de cada alumno del disco (ENTREGAS_BASE/{storagePath})
// 2. Borra todos los documentos Submission de la BD
// 3. Borra archivos adjuntos del docente del disco (ARCHIVOS_BASE/{relPath})
// 4. Borra el documento Activity de la BD
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // 1. Borrar archivos físicos de entregas de alumnos
    // storagePath es relativo desde ENTREGAS_BASE: schoolId/actId/studentId/filename
    const submissions = await Submission.find({ activity: req.params.id });
    submissions.forEach(sub => {
      sub.files.forEach(f => {
        const fp = path.join(ENTREGAS_BASE, f.storagePath);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
    });

    // 2. Borrar todos los documentos Submission (incluye texto/comentario del alumno)
    await Submission.deleteMany({ activity: req.params.id });

    // 3. Borrar archivos adjuntos del docente del disco
    // La URL tiene formato /archivos/{relPath}; se convierte a ruta absoluta via ARCHIVOS_BASE
    activity.attachments
      .filter(a => a.type === 'file' && a.url.startsWith('/archivos/'))
      .forEach(a => {
        const relPath = a.url.replace(/^\/archivos\//, '');
        const fp = path.join(ARCHIVOS_BASE, relPath);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });

    // 4. Borrar el documento Activity de la BD
    await activity.deleteOne();

    logAudit(req, 'activity.delete',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        entregas_borradas: submissions.length,
        adjuntos_borrados: (activity.attachments || []).filter(a => a.type === 'file').length,
      },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar: ' + err.message });
  }
});

// PATCH /activities/:id/toggle-late
// Invierte el flag allowLateSubmissions de la actividad (solo el docente owner)
// Se usa cuando el plazo venció y el docente quiere abrir/cerrar entregas tardías
// Retorna: { allowLateSubmissions: bool }
router.patch('/:id/toggle-late', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    activity.allowLateSubmissions = !activity.allowLateSubmissions;
    await activity.save();

    logAudit(req, 'activity.toggle_late',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { habilitadas: activity.allowLateSubmissions ? 'sí' : 'no' },
    );

    res.json({ allowLateSubmissions: activity.allowLateSubmissions });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /activities/:id
// Edita campos básicos de la actividad (no modifica adjuntos ni calificaciones)
// Body: { title, description?, dueDate?, availableFrom?, points?, type? }
// Retorna: { activity }
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { title, description, dueDate, availableFrom, points, type } = req.body;
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (!title?.trim()) return res.status(400).json({ error: 'El título es requerido' });

    activity.title         = title.trim();
    activity.description   = description?.trim() || '';
    activity.dueDate       = dueDate || null;
    activity.availableFrom = availableFrom || activity.availableFrom;
    activity.points        = points !== '' && points != null ? Number(points) : null;
    if (type) activity.type = type;
    await activity.save();

    logAudit(req, 'activity.edit',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {},
    );

    res.json({ activity });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al editar' });
  }
});

/* ─── Entregas ─── */

// GET /activities/submission-file/:filename
// Descarga protegida de archivos de entrega: solo el alumno que entregó o el docente del curso
// Verifica propiedad buscando el Submission por filename, luego chequea si es el alumno o el docente
router.get('/submission-file/:filename', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = res.locals.user._id.toString();

    // Busca la entrega que contiene este archivo (por el filename único)
    const submission = await Submission.findOne({ 'files.filename': filename }).populate('activity');
    if (!submission) return res.status(404).send('Archivo no encontrado');

    const isStudent = submission.student.toString() === userId;
    if (!isStudent) {
      // Si no es el alumno, verifica que sea el docente dueño del curso
      const course = await Course.findById(submission.activity.course);
      if (!course || course.owner.toString() !== userId) return res.status(403).send('Acceso denegado');
    }

    const file     = submission.files.find(f => f.filename === filename);
    const filePath = path.join(ENTREGAS_BASE, file.storagePath);
    if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado en disco');

    // Fuerza descarga con el nombre original del archivo (respeta caracteres UTF-8)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(filePath);
  } catch {
    res.status(500).send('Error del servidor');
  }
});

// POST /activities/:id/upload-submission-file
// Pre-sube UN archivo al path final de la entrega, igual que el docente hace con
// /activities/upload-attachment. Devuelve la metadata para que el frontend la mande
// en el JSON del submit final (ver POST /:id/submit).
// Body multipart: { file }
// Retorna: { storagePath, name, filename, mime, size }
router.post('/:id/upload-submission-file', requireAuth, (req, res, next) => {
  // Intercepta errores de multer para devolver JSON en español, como en /upload-attachment
  submissionUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `El archivo es demasiado grande (máximo ${SUBMISSION_MAX_SIZE / 1024 / 1024} MB)` });
      }
      return res.status(400).json({ error: err.message || 'Error al procesar el archivo' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Tipo de archivo no permitido (PDF, Word, Excel, imágenes o ZIP)' });

    const activity = await Activity.findById(req.params.id);
    if (!activity) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Actividad no encontrada' }); }

    const course = await Course.findById(activity.course);
    const userId = res.locals.user._id.toString();

    // Solo alumnos inscriptos: mismo chequeo que /submit
    if (!course.students.map(s => s.toString()).includes(userId)) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'No estás inscripto en este curso' });
    }
    // Bloquea si el plazo venció y no hay entregas tardías habilitadas
    if (activity.dueDate && new Date(activity.dueDate) < new Date() && !activity.allowLateSubmissions) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.' });
    }

    const schoolId = res.locals.user.school?.toString() || 'general';
    res.json({
      storagePath: [schoolId, req.params.id, userId, req.file.filename].join('/'),
      name:        req.file.originalname,
      filename:    req.file.filename,
      mime:        req.file.mimetype,
      size:        req.file.size,
    });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: err.message || 'Error al subir el archivo' });
  }
});

// POST /activities/:id/submit
// El alumno entrega o reenvía su trabajo para una actividad.
// Acepta dos formatos por compatibilidad:
//   1. JSON: { text?, uploadedFiles?: [{ storagePath, name, filename, mime, size }] }
//      → los archivos ya se pre-subieron con /upload-submission-file (flujo nuevo, con
//        progreso real por archivo).
//   2. multipart/form-data: { text?, files? }  (flujo viejo — se mantiene por si algún
//      cliente/test aún lo usa).
// Si hay nuevos archivos: reemplaza los anteriores (borra del disco + upsert en BD).
// Si no hay archivos nuevos: mantiene los archivos anteriores, solo actualiza el texto.
// Middleware: solo corre el parseo multipart si el request efectivamente lo es.
// El body-parser JSON global (server.js) ya se encarga del flujo nuevo (application/json).
const conditionalMultipart = (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return submissionUpload.array('files', 10)(req, res, next);
  next();
};

router.post('/:id/submit', requireAuth, conditionalMultipart, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    const userId = res.locals.user._id.toString();

    // Solo alumnos inscriptos en el curso pueden entregar
    if (!course.students.map(s => s.toString()).includes(userId)) {
      return res.status(403).json({ error: 'No estás inscripto en este curso' });
    }

    // Bloquea si el plazo venció y el docente no habilitó entregas tardías
    if (activity.dueDate && new Date(activity.dueDate) < new Date() && !activity.allowLateSubmissions) {
      return res.status(403).json({ error: 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.' });
    }

    const schoolId = res.locals.user.school?.toString() || 'general';
    const { text } = req.body;

    // Archivos pre-subidos vía /upload-submission-file (flujo nuevo)
    // Se filtran los storagePath para asegurar que apunten al userId del solicitante:
    // impide que un alumno referencie archivos de otro pasando storagePaths arbitrarios.
    const preUploadedRaw = req.body.uploadedFiles
      ? (typeof req.body.uploadedFiles === 'string' ? JSON.parse(req.body.uploadedFiles) : req.body.uploadedFiles)
      : [];
    const expectedPrefix = [schoolId, req.params.id, userId, ''].join('/');
    const preUploadedFiles = preUploadedRaw
      .filter(f => f && f.storagePath && f.storagePath.startsWith(expectedPrefix))
      .map(f => ({
        name:        f.name,
        filename:    f.filename,
        storagePath: f.storagePath,
        mime:        f.mime || '',
        size:        f.size || 0,
      }));

    // Archivos que llegan directo en el FormData (flujo viejo, compatibilidad)
    const multipartFiles = (req.files || []).map(f => ({
      name:        f.originalname,
      filename:    f.filename,
      storagePath: [schoolId, req.params.id, userId, f.filename].join('/'),
      mime:        f.mimetype,
      size:        f.size,
    }));

    const newFiles = [...preUploadedFiles, ...multipartFiles];

    const existing = await Submission.findOne({ activity: req.params.id, student: userId });

    let filesToSave;
    if (newFiles.length > 0) {
      // Con nuevos archivos: borra los anteriores del disco antes de guardar los nuevos
      if (existing) {
        existing.files.forEach(f => {
          const fp = path.join(ENTREGAS_BASE, f.storagePath);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        });
      }
      filesToSave = newFiles;
    } else {
      // Sin nuevos archivos: mantiene los archivos anteriores (solo cambia el texto)
      filesToSave = existing?.files || [];
    }

    // Upsert: crea la entrega si no existe, la actualiza si ya existe
    // $setOnInsert solo aplica en la creación: preserva la fecha original de la primera entrega
    const submission = await Submission.findOneAndUpdate(
      { activity: req.params.id, student: userId },
      {
        $set:         { files: filesToSave, text: text?.trim() || '' },
        $setOnInsert: { firstSubmittedAt: new Date() },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Distingue primera entrega vs reenvío usando el snapshot de `existing`
    // capturado ANTES del upsert. La fecha de la actividad puede ser null
    // (actividad sin plazo) — en ese caso, `tardia` no se agrega al meta.
    const now = new Date();
    const wasLate = activity.dueDate && now > new Date(activity.dueDate);
    logAudit(req, existing ? 'submission.update' : 'submission.create',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        archivos: filesToSave.length,
        ...(activity.dueDate ? { tardia: wasLate ? 'sí' : 'no' } : {}),
      },
    );

    res.json({ submission });
  } catch (err) {
    // Si multer subió archivos antes de que falle el proceso, los limpia del disco
    (req.files || []).forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    res.status(500).json({ error: 'Error al enviar la entrega: ' + err.message });
  }
});

// GET /activities/:id/export-grades
// Genera y descarga un Excel con todas las calificaciones de la actividad (solo el docente owner)
// Columnas: Alumno, DNI, Email, Nota, Máximo, Feedback, Fecha calificación
router.get('/:id/export-grades', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).send('Actividad no encontrada');

    const course = await Course.findById(activity.course).populate('students', 'name email dni');
    if (!course || course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).send('Sin acceso');
    }

    // Índice rápido de calificaciones por studentId
    const gradeMap = {};
    activity.grades.forEach(g => {
      gradeMap[g.student.toString()] = { points: g.points, feedback: g.feedback || '', gradedAt: g.gradedAt };
    });

    const maxPts = activity.points != null ? activity.points : '';

    // Una fila por alumno inscripto (aunque no haya sido calificado)
    const rows = course.students.map(s => {
      const g = gradeMap[s._id.toString()];
      return {
        'Alumno':              s.name,
        'DNI':                 s.dni || '',
        'Email':               s.email,
        'Nota':                g?.points != null ? g.points : '',
        'Máximo':              maxPts,
        'Feedback docente':    g?.feedback || '',
        'Fecha calificación':  g?.gradedAt ? new Date(g.gradedAt).toLocaleDateString('es-ES') : '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    // Ajusta el ancho de las columnas automáticamente según el contenido más largo de cada una
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length)) + 2,
    }));
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Calificaciones');

    const safeName  = activity.title.replace(/[^a-z0-9áéíóúüñ ]/gi, '_').trim();
    const filename  = `${safeName}_calificaciones.xlsx`;
    const buf       = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).send('Error al generar el archivo: ' + err.message);
  }
});

// GET /activities/:id/my-submission
// El alumno consulta su propia entrega para mostrar en el modal de detalle
// Retorna: { submission } o { submission: null } si todavía no entregó
router.get('/:id/my-submission', requireAuth, async (req, res) => {
  try {
    const submission = await Submission.findOne({
      activity: req.params.id,
      student:  res.locals.user._id,
    });
    res.json({ submission: submission || null });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /activities/:id/submissions
// El docente ve todas las entregas de una actividad con datos del alumno
// Retorna: { submissions } array con student populado (name, email, dni)
router.get('/:id/submissions', requireAuth, async (req, res) => {
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (course.owner.toString() !== res.locals.user._id.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const submissions = await Submission.find({ activity: req.params.id })
      .populate('student', 'name email dni')
      .sort({ updatedAt: -1 }); // Las más recientes primero

    res.json({ submissions });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
