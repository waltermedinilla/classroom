const express  = require('express');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const XLSX     = require('xlsx');
const path     = require('path');
const fs       = require('fs');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Subject  = require('../models/Subject');
const Division = require('../models/Division');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const Announcement = require('../models/Announcement');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { invalidateUser, invalidateSchool } = require('../middleware/cache');
const { logAudit } = require('../middleware/audit');
const School   = require('../models/School');
const THEMES   = require('../config/themes');

// Rutas base de archivos en disco (deben coincidir con las de routes/activities.js
// y routes/announcements.js) para poder eliminar los archivos físicos en la cascada.
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');
const ENTREGAS_BASE = path.join(__dirname, '../archivos/entregas');

// Elimina en cascada todo lo asociado a un curso: actividades, entregas, novedades
// y sus archivos físicos. Se usa al borrar un curso desde el panel de administración.
async function cascadeDeleteCourse(courseId) {
  // 1. Actividades del curso + entregas de sus alumnos
  const activities = await Activity.find({ course: courseId });
  const activityIds = activities.map(a => a._id);

  if (activityIds.length) {
    // 1a. Borra los archivos físicos de cada entrega
    const submissions = await Submission.find({ activity: { $in: activityIds } });
    submissions.forEach(sub => {
      sub.files.forEach(f => {
        const fp = path.join(ENTREGAS_BASE, f.storagePath);
        if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
      });
    });
    // 1b. Borra los documentos Submission
    await Submission.deleteMany({ activity: { $in: activityIds } });

    // 1c. Borra los adjuntos del docente de cada actividad
    activities.forEach(act => {
      act.attachments
        .filter(a => a.type === 'file' && a.url.startsWith('/archivos/'))
        .forEach(a => {
          const fp = path.join(ARCHIVOS_BASE, a.url.replace(/^\/archivos\//, ''));
          if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
        });
    });
    // 1d. Borra los documentos Activity
    await Activity.deleteMany({ course: courseId });
  }

  // 2. Novedades del curso + sus imágenes
  const announcements = await Announcement.find({ course: courseId });
  announcements.forEach(ann => {
    if (ann.image && ann.image.startsWith('/archivos/')) {
      const fp = path.join(ARCHIVOS_BASE, ann.image.replace(/^\/archivos\//, ''));
      if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch {} }
    }
  });
  await Announcement.deleteMany({ course: courseId });

  // 3. Finalmente, el curso
  await Course.findByIdAndDelete(courseId);
}

const xlsUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Solo archivos .xls o .xlsx'));
  },
});

const formatName = (raw) => {
  const comma = raw.indexOf(',');
  if (comma === -1) return raw.trim();
  const apellido = raw.substring(0, comma).trim();
  const nombre   = raw.substring(comma + 1).trim();
  const cap = s => s.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return [cap(nombre), cap(apellido)].filter(Boolean).join(' ');
};

const extractEmail = (r) => {
  const candidates = [r[11], r[10]].join('\n').split('\n').map(e => e.trim()).filter(e => e && e.includes('@') && e.includes('.'));
  return candidates[0] || '';
};

const cap = s => s.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

const parseTeacher = (persona) => {
  const m = persona.toString().trim().match(/^(\d{2})-(\d{7,9})-(\d)\s+(.+)$/);
  if (!m) return null;
  const dni      = m[2];
  const cuil     = `${m[1]}-${dni}-${m[3]}`;
  const nombreRaw = m[4].trim().replace(/\s+[MF]$/, '').trim();
  return { cuil, dni, nombre: cap(nombreRaw), email: `doc.${dni}@esc4039.edu.ar` };
};

const router = express.Router();

const PROTECTED_ADMIN_EMAIL = 'waltermedinilla@gmail.com';

router.use(requireAuth, requireAdmin);

/* ─── Dashboard ─── */
router.get('/', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const [userCount, courseCount, teacherCount, studentCount, subjectCount, divisionCount] = await Promise.all([
    User.countDocuments(sf),
    Course.countDocuments(sf),
    User.countDocuments({ ...sf, role: 'teacher' }),
    User.countDocuments({ ...sf, role: 'student' }),
    Subject.countDocuments(sf),
    Division.countDocuments(sf),
  ]);
  res.render('admin/dashboard', { userCount, courseCount, teacherCount, studentCount, subjectCount, divisionCount });
});

/* ─── Users ─── */
router.get('/users', async (req, res) => {
  const school = res.locals.user.school;
  const { role, search } = req.query;
  const LIMIT = 25;
  const page  = Math.max(1, parseInt(req.query.page) || 1);

  const filter = school ? { school } : {};
  if (role)   filter.role = role;
  if (search) filter.$or  = [
    { name:  { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
  ];

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * LIMIT).limit(LIMIT),
    User.countDocuments(filter),
  ]);

  const studentIds = users.filter(u => u.role === 'student').map(u => u._id);
  const enrolledMap = {};
  if (studentIds.length) {
    const courses = await Course.find({ students: { $in: studentIds } }).select('students');
    courses.forEach(c => c.students.forEach(sid => { enrolledMap[sid.toString()] = true; }));
  }

  const totalPages  = Math.ceil(total / LIMIT);
  const queryParams = { ...(role && { role }), ...(search && { search }) };
  res.render('admin/users', { users, enrolledMap, currentRole: role || '', search: search || '', page, totalPages, total, queryParams });
});

router.get('/users/create', async (req, res) => {
  // Cargamos las divisiones (Cursos) de la escuela del admin para el combobox
  // condicional del formulario — solo se muestra al elegir rol Alumno.
  const school = res.locals.user.school;
  const divisions = school
    ? await Division.find({ school }).sort({ name: 1 }).select('_id name').lean()
    : [];
  res.render('admin/user-form', { user: null, divisions });
});

router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role, dni, divisionId } = req.body;
    if (role === 'superadmin') return res.status(403).json({ error: 'No permitido' });
    const userData = { name, email, password, role, school: res.locals.user.school };
    if (dni) userData.dni = dni;
    const user = await User.create(userData);

    logAudit(req, 'user.create',
      [{ type: 'user', id: user._id, name: user.name }],
      { rol: user.role, ...(user.email ? { email: user.email } : {}) },
    );

    // Si es alumno y el admin eligió un Curso: lo inscribimos en TODAS las materias
    // de ese Curso, guardando joinedAt = ahora en Course.enrollmentDates para que las
    // tareas vencidas ANTES de esta fecha no le figuren (ver filtro en routes/activities.js).
    let enrolledIn = 0;
    if (role === 'student' && divisionId && res.locals.user.school) {
      // Validar que la división pertenezca a la misma escuela (defensa en profundidad,
      // aunque el select solo muestra las de la escuela del admin).
      const division = await Division.findOne({ _id: divisionId, school: res.locals.user.school }).select('_id name');
      if (division) {
        const courses = await Course.find({ division: division._id, school: res.locals.user.school }).select('_id name students enrollmentDates');
        const now = new Date();
        for (const c of courses) {
          if (c.students.some(s => s.toString() === user._id.toString())) continue; // ya inscripto: no duplicar
          c.students.push(user._id);
          c.enrollmentDates.set(user._id.toString(), now);
          await c.save({ validateModifiedOnly: true });
          enrolledIn++;
        }

        if (enrolledIn > 0) {
          logAudit(req, 'course.add_student',
            [
              { type: 'division', id: division._id, name: division.name },
              { type: 'user',     id: user._id,     name: user.name },
            ],
            { materias: enrolledIn, via: 'alta-alumno-con-curso' },
          );
        }
      }
    }

    res.status(201).json({ user, enrolledIn });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/users/:id', async (req, res) => {
  const school = res.locals.user.school;
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).send('Usuario no encontrado');
  if (school && target.school?.toString() !== school.toString()) {
    return res.status(403).send('Acceso denegado');
  }
  const [createdCourses, joinedCourses] = await Promise.all([
    Course.find({ owner:    target._id }).populate('owner', 'name email').populate('school', 'name').populate('division', 'name'),
    Course.find({ students: target._id }).populate('owner', 'name email').populate('school', 'name').populate('division', 'name'),
  ]);
  res.render('admin/user-profile', { target, createdCourses, joinedCourses, PROTECTED_ADMIN_EMAIL });
});

router.post('/users/:id/role', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return res.status(400).json({ error: 'No se puede modificar este usuario' });
    }
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (req.params.id === req.userId && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'No puedes cambiar tu propio rol de admin' });
    }
    if (req.body.role === 'superadmin') return res.status(403).json({ error: 'No permitido' });
    const oldRole = target.role;
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true, runValidators: true });
    invalidateUser(req.params.id);

    logAudit(req, 'user.role_change',
      [{ type: 'user', id: user._id, name: user.name }],
      { de: oldRole, a: user.role },
      { schoolId: target.school || null },
    );

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/users/:id/toggle-active', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return res.status(400).json({ error: 'No se puede modificar este usuario' });
    }
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'No podés deshabilitarte a vos mismo' });
    }
    target.active = !target.active;
    await target.save({ validateModifiedOnly: true });
    invalidateUser(req.params.id);

    logAudit(req, 'user.toggle_active',
      [{ type: 'user', id: target._id, name: target.name }],
      { estado: target.active ? 'habilitado' : 'deshabilitado' },
      { schoolId: target.school || null },
    );

    res.json({ active: target.active });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return res.status(400).json({ error: 'No se puede modificar este usuario' });
    }
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const newPassword = target.dni || 'Classroom1234';
    target.password = newPassword;
    await target.save();

    logAudit(req, 'user.reset_password',
      [{ type: 'user', id: target._id, name: target.name }],
      { origen: target.dni ? 'DNI' : 'default' },
      { schoolId: target.school || null },
    );

    res.json({ ok: true, hint: target.dni ? 'DNI del usuario' : 'Classroom1234' });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/users/:id/delete', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return res.status(400).json({ error: 'No se puede eliminar este usuario' });
    }
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (req.params.id === req.userId) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    await User.findByIdAndDelete(req.params.id);
    invalidateUser(req.params.id);

    logAudit(req, 'user.delete',
      [{ type: 'user', id: target._id, name: target.name }],
      { rol: target.role, ...(target.email ? { email: target.email } : {}) },
      { schoolId: target.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Impersonation ─── */
router.post('/users/:id/impersonate', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return res.status(400).json({ error: 'No puedes suplantar a este usuario' });
    }
    if (target.active === false) {
      return res.status(400).json({ error: 'No podés suplantar a un usuario deshabilitado' });
    }
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (req.params.id === req.userId) return res.status(400).json({ error: 'Ya eres este usuario' });
    const twoHours = 2 * 60 * 60 * 1000;
    const impersonateOpts = { httpOnly: true, maxAge: twoHours, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
    res.cookie('adminToken', req.cookies.token, impersonateOpts);
    const targetToken = jwt.sign({ userId: target._id }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', targetToken, impersonateOpts);

    logAudit(req, 'user.impersonate',
      [{ type: 'user', id: target._id, name: target.name }],
      { rol_destino: target.role },
      { schoolId: target.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Courses (admin CRUD) ─── */
router.get('/courses', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const { division: divisionFilter, search } = req.query;
  const LIMIT = 25;
  const page  = Math.max(1, parseInt(req.query.page) || 1);

  const filter = { ...sf };
  if (divisionFilter) filter.division = divisionFilter;
  if (search) filter.name = { $regex: search, $options: 'i' };

  const [courses, total, divisions, teachers] = await Promise.all([
    Course.find(filter)
      .populate('division', 'name')
      .populate('owner', 'name email')
      .sort({ name: 1 })
      .skip((page - 1) * LIMIT)
      .limit(LIMIT),
    Course.countDocuments(filter),
    Division.find(sf).sort({ name: 1 }),
    User.find({ ...sf, role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email'),
  ]);

  const totalPages  = Math.ceil(total / LIMIT);
  const queryParams = { ...(divisionFilter && { division: divisionFilter }), ...(search && { search }) };
  res.render('admin/courses', { courses, divisions, teachers, search: search || '', divisionFilter: divisionFilter || '', page, totalPages, total, queryParams });
});

router.get('/courses/create', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const [divisions, teachers, subjects] = await Promise.all([
    Division.find(sf).sort({ name: 1 }),
    User.find({ ...sf, role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email'),
    Subject.find(sf).sort({ name: 1 }).select('name'),
  ]);
  res.render('admin/course-form', { course: null, divisions, teachers, subjects });
});

router.post('/courses/create', async (req, res) => {
  try {
    const { name, divisionId, teacherId, room } = req.body;
    const school = res.locals.user.school;
    if (!school) return res.status(400).json({ error: 'Sin escuela asignada' });

    const division = await Division.findOne({ _id: divisionId, school });
    if (!division) return res.status(400).json({ error: 'División no válida' });
    const teacher = await User.findOne({ _id: teacherId, school });
    if (!teacher) return res.status(400).json({ error: 'Docente no válido' });

    const course = await Course.create({ name, room: room || '', division: division._id, owner: teacher._id, school });

    logAudit(req, 'course.create',
      [
        { type: 'course',   id: course._id,   name: course.name },
        { type: 'division', id: division._id, name: division.name },
        { type: 'user',     id: teacher._id,  name: teacher.name },
      ],
      { codigo: course.code },
    );

    res.status(201).json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/courses/:id/edit', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const course = await Course.findById(req.params.id).populate('division').populate('owner', 'name email');
  if (!course) return res.status(404).send('Materia no encontrada');
  if (school && course.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  const [divisions, teachers, subjects] = await Promise.all([
    Division.find(sf).sort({ name: 1 }),
    User.find({ ...sf, role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email'),
    Subject.find(sf).sort({ name: 1 }).select('name'),
  ]);
  res.render('admin/course-form', { course, divisions, teachers, subjects });
});

router.post('/courses/:id/edit', async (req, res) => {
  try {
    const school   = res.locals.user.school;
    const existing = await Course.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && existing.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });

    const { name, divisionId, teacherId, room } = req.body;
    const updates = { name, room: room || '' };

    if (divisionId) {
      const division = await Division.findOne({ _id: divisionId, school: school || existing.school });
      if (!division) return res.status(400).json({ error: 'División no válida' });
      updates.division = division._id;
    }
    if (teacherId) {
      const teacher = await User.findOne({ _id: teacherId });
      if (!teacher) return res.status(400).json({ error: 'Docente no válido' });
      updates.owner = teacher._id;
    }

    const course = await Course.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });

    logAudit(req, 'course.edit',
      [{ type: 'course', id: course._id, name: course.name }],
      {},
      { schoolId: existing.school || null },
    );

    res.json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/courses/:id/assign-teacher', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && course.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const { teacherId } = req.body;
    if (!teacherId) return res.status(400).json({ error: 'Falta el docente' });
    const teacher = await User.findOne({ _id: teacherId, school: school || course.school });
    if (!teacher) return res.status(400).json({ error: 'Docente no válido' });
    course.owner = teacher._id;
    await course.save({ validateModifiedOnly: true });

    logAudit(req, 'course.assign_teacher',
      [
        { type: 'course', id: course._id,  name: course.name },
        { type: 'user',   id: teacher._id, name: teacher.name },
      ],
      {},
      { schoolId: course.school || null },
    );

    res.json({ teacherName: teacher.name, teacherId: teacher._id });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/courses/:id/delete', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && course.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    await cascadeDeleteCourse(req.params.id);

    logAudit(req, 'course.delete',
      [{ type: 'course', id: course._id, name: course.name }],
      { alumnos: (course.students || []).length },
      { schoolId: course.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Divisions ─── */
router.get('/divisions', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const { search } = req.query;
  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };
  const divisions = await Division.find(filter).sort({ name: 1 });

  const divisionsWithCount = await Promise.all(
    divisions.map(async (d) => {
      const courseCount = await Course.countDocuments({ division: d._id });
      return { ...d.toObject(), courseCount };
    })
  );
  res.render('admin/divisions', { divisions: divisionsWithCount, search: search || '' });
});

router.get('/divisions/create', (req, res) => {
  res.render('admin/division-form', { division: null });
});

router.post('/divisions/create', async (req, res) => {
  try {
    const { name } = req.body;
    const schoolId = res.locals.user.school;
    if (!schoolId) return res.status(400).json({ error: 'Sin escuela asignada' });
    const division = await Division.create({ name, school: schoolId });

    logAudit(req, 'division.create',
      [{ type: 'division', id: division._id, name: division.name }],
      {},
    );

    res.status(201).json({ division });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe un curso con ese nombre en esta escuela' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/divisions/:id/edit', async (req, res) => {
  const school   = res.locals.user.school;
  const division = await Division.findById(req.params.id);
  if (!division) return res.status(404).send('Curso no encontrado');
  if (school && division.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  res.render('admin/division-form', { division });
});

router.post('/divisions/:id/edit', async (req, res) => {
  try {
    const school   = res.locals.user.school;
    const existing = await Division.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Curso no encontrado' });
    if (school && existing.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    const { name } = req.body;
    const oldName = existing.name;
    const division = await Division.findByIdAndUpdate(req.params.id, { name }, { new: true, runValidators: true });

    logAudit(req, 'division.edit',
      [{ type: 'division', id: division._id, name: division.name }],
      oldName !== division.name ? { de: oldName, a: division.name } : {},
      { schoolId: existing.school || null },
    );

    res.json({ division });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe un curso con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/divisions/:id/delete', async (req, res) => {
  try {
    const school   = res.locals.user.school;
    const division = await Division.findById(req.params.id);
    if (!division) return res.status(404).json({ error: 'Curso no encontrado' });
    if (school && division.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    const courseCount = await Course.countDocuments({ division: req.params.id });
    if (courseCount > 0) {
      return res.status(409).json({ error: `No se puede eliminar: tiene ${courseCount} materia(s) asociada(s)` });
    }
    await Division.findByIdAndDelete(req.params.id);

    logAudit(req, 'division.delete',
      [{ type: 'division', id: division._id, name: division.name }],
      {},
      { schoolId: division.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Subjects ─── */
router.get('/subjects', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const { search } = req.query;
  const LIMIT = 20;
  const page  = Math.max(1, parseInt(req.query.page) || 1);

  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };

  const [subjects, total] = await Promise.all([
    Subject.find(filter).sort({ name: 1 }).skip((page - 1) * LIMIT).limit(LIMIT),
    Subject.countDocuments(filter),
  ]);

  const subjectsWithCount = await Promise.all(
    subjects.map(async (s) => {
      const courseCount = await Course.countDocuments({ name: s.name, ...sf });
      return { ...s.toObject(), courseCount };
    })
  );

  const totalPages  = Math.ceil(total / LIMIT);
  const queryParams = { ...(search && { search }) };
  res.render('admin/subjects', { subjects: subjectsWithCount, search: search || '', page, totalPages, total, queryParams });
});

router.get('/subjects/create', (req, res) => {
  res.render('admin/subject-form', { subject: null });
});

router.post('/subjects/create', async (req, res) => {
  try {
    const { name, description, color, school: bodySchool } = req.body;
    const schoolId = res.locals.user.school || bodySchool || null;
    const subject = await Subject.create({ name, description, color, school: schoolId });

    logAudit(req, 'subject.create',
      [{ type: 'subject', id: subject._id, name: subject.name }],
      {},
      { schoolId: schoolId || null },
    );

    res.status(201).json({ subject });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una materia con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/subjects/:id/edit', async (req, res) => {
  const school  = res.locals.user.school;
  const subject = await Subject.findById(req.params.id);
  if (!subject) return res.status(404).send('Materia no encontrada');
  if (school && subject.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  res.render('admin/subject-form', { subject });
});

router.post('/subjects/:id/edit', async (req, res) => {
  try {
    const school   = res.locals.user.school;
    const existing = await Subject.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && existing.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    const { name, description, color } = req.body;
    const oldName = existing.name;
    const subject = await Subject.findByIdAndUpdate(req.params.id, { name, description, color }, { new: true, runValidators: true });

    logAudit(req, 'subject.edit',
      [{ type: 'subject', id: subject._id, name: subject.name }],
      oldName !== subject.name ? { de: oldName, a: subject.name } : {},
      { schoolId: existing.school || null },
    );

    res.json({ subject });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una materia con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/subjects/:id', async (req, res) => {
  const school  = res.locals.user.school;
  const sf      = school ? { school } : {};
  const subject = await Subject.findById(req.params.id);
  if (!subject) return res.status(404).send('Materia no encontrada');
  if (school && subject.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  // Busca por Course.name en lugar de Course.subject
  const courses = await Course.find({ name: subject.name, ...sf })
    .populate('owner',    'name email')
    .populate('school',   'name')
    .populate('division', 'name');
  res.render('admin/subject-detail', { subject, courses });
});

router.post('/subjects/:id/delete', async (req, res) => {
  try {
    const school  = res.locals.user.school;
    const subject = await Subject.findById(req.params.id);
    if (!subject) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && subject.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    await Subject.findByIdAndDelete(req.params.id);

    logAudit(req, 'subject.delete',
      [{ type: 'subject', id: subject._id, name: subject.name }],
      {},
      { schoolId: subject.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Import ─── */
router.get('/import', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const [teachers, subjects] = await Promise.all([
    User.find({ ...sf, role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email role'),
    Subject.find(sf).sort({ name: 1 }).select('_id name color'),
  ]);
  res.render('admin/import', { teachers, subjects });
});

// GET /admin/import/template — Genera y descarga la plantilla Excel del sistema
router.get('/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();

  const makeSheet = (rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map(w => ({ wch: w }));
    return ws;
  };

  XLSX.utils.book_append_sheet(wb, makeSheet([
    ['Nombre'],
    ['1°1°'],
    ['1°2°'],
    ['2°1°'],
    ['2°2°'],
    ['3°1°'],
  ], [14]), 'Cursos');

  XLSX.utils.book_append_sheet(wb, makeSheet([
    ['Apellido y Nombre', 'DNI',       'Email'],
    ['García Juan',       '12345678',  'garcia@escuela.edu.ar'],
    ['López María',       '23456789',  'lopez@escuela.edu.ar'],
  ], [30, 12, 34]), 'Docentes');

  XLSX.utils.book_append_sheet(wb, makeSheet([
    ['Apellido y Nombre', 'DNI',       'Email',                       'Curso'],
    ['Rodríguez Ana',     '34567890',  'rodriguez@escuela.edu.ar',    '1°1°'],
    ['Pérez Carlos',      '45678901',  'perez@escuela.edu.ar',        '1°1°'],
    ['Gómez Laura',       '56789012',  'gomez@escuela.edu.ar',        '1°2°'],
  ], [30, 12, 34, 10]), 'Alumnos');

  XLSX.utils.book_append_sheet(wb, makeSheet([
    ['Materia',      'Curso', 'DNI Docente'],
    ['Matemática',   '1°1°',  '12345678'],
    ['Historia',     '1°1°',  '23456789'],
    ['Matemática',   '1°2°',  '12345678'],
    ['Lengua',       '1°2°',  '23456789'],
  ], [20, 10, 14]), 'Materias');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_importacion_classroom.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/import/upload', xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    // ── Detección formato "sistema" (plantilla propia): hojas Cursos/Docentes/Alumnos/Materias
    const sheetNames = wb.SheetNames.map(s => s.toLowerCase().trim());
    const isSistema  = ['cursos','docentes','alumnos','materias'].some(n => sheetNames.includes(n));

    if (isSistema) {
      const getSheet = (name) => {
        const key = wb.SheetNames.find(s => s.toLowerCase().trim() === name);
        return key ? XLSX.utils.sheet_to_json(wb.Sheets[key], { header: 1, defval: '' }) : [];
      };
      const cursosRaw   = getSheet('cursos');
      const docentesRaw = getSheet('docentes');
      const alumnosRaw  = getSheet('alumnos');
      const materiasRaw = getSheet('materias');

      const cursos = cursosRaw.slice(1).map(r => r[0]?.toString().trim()).filter(Boolean);

      const docentes = docentesRaw.slice(1).filter(r => r[0]).map(r => ({
        nombre: r[0].toString().trim(),
        dni:    r[1]?.toString().replace(/\D/g,'').trim() || '',
        email:  r[2]?.toString().trim() || '',
      })).filter(d => d.nombre && (d.email || d.dni));

      let skippedAlumnos = 0;
      const alumnos = [];
      alumnosRaw.slice(1).filter(r => r[0]).forEach(r => {
        const email = r[2]?.toString().trim() || '';
        if (!email || !email.includes('@')) { skippedAlumnos++; return; }
        alumnos.push({
          nombre: r[0].toString().trim(),
          dni:    r[1]?.toString().replace(/\D/g,'').trim() || '',
          email,
          curso:  r[3]?.toString().trim() || '',
        });
      });

      const materias = materiasRaw.slice(1).filter(r => r[0] && r[1]).map(r => ({
        materia:    r[0].toString().trim(),
        curso:      r[1].toString().trim(),
        dniDocente: r[2]?.toString().replace(/\D/g,'').trim() || '',
      }));

      return res.json({
        type: 'sistema',
        cursos, docentes, alumnos, materias,
        skippedAlumnos,
        sheetName: 'Plantilla del Sistema',
      });
    }

    const ws    = wb.Sheets[wb.SheetNames[0]];
    const rawData   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const sheetName = wb.SheetNames[0];
    const headers   = rawData[0].map(h => h.toString().toLowerCase());

    if (headers.includes('división') || headers.includes('materia')) {
      const rows = rawData.slice(1).filter(r => r[5] && r[6]);
      const entries = rows.map(r => ({
        division: r[5].toString().trim(),
        materia:  r[6].toString().trim(),
        turno:    r[7].toString().trim(),
        persona:  r[9].toString().trim(),
      })).filter(e => e.division && e.materia);

      const teacherMap = {};
      entries.forEach(e => {
        const t = parseTeacher(e.persona);
        if (t && !teacherMap[t.cuil]) teacherMap[t.cuil] = t;
      });

      return res.json({
        type:       'cargos',
        entries,
        teachers:   Object.values(teacherMap),
        materias:   [...new Set(entries.map(e => e.materia))].sort(),
        divisiones: [...new Set(entries.map(e => e.division))].sort(),
        sheetName,
      });
    }

    const rows     = rawData.slice(2).filter(r => r[0]);
    const students = [];
    let skipped    = 0;
    rows.forEach(r => {
      const email = extractEmail(r);
      if (!email) { skipped++; return; }
      students.push({
        nombre: formatName(r[4].toString()),
        cuil:   r[0].toString().trim(),
        dni:    r[1].toString().replace('DNI', '').trim(),
        curso:  r[5].toString().trim(),
        email,
      });
    });
    const cursos = [...new Set(rows.map(r => r[5].toString().trim()))].sort();
    res.json({ type: 'alumnos', students, cursos, skipped, total: rows.length, sheetName });
  } catch (err) {
    res.status(400).json({ error: 'No se pudo leer el archivo: ' + err.message });
  }
});

router.post('/import/execute', async (req, res) => {
  const school = res.locals.user.school;

  // Función auxiliar: busca o crea una división de forma atómica
  const findOrCreateDivision = async (name, schoolId) => {
    if (!name || !schoolId) return null;
    return Division.findOneAndUpdate(
      { name, school: schoolId },
      { name, school: schoolId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  };

  if (req.body.type === 'cargos') {
    const { importDocentes, importCursosMaterias, importMaterias, inscribirAlumnos, entries, teachers } = req.body;
    const results = { docentes: { created: 0, skipped: 0 }, cursos: { created: 0, skipped: 0 }, materias: { created: 0, skipped: 0 }, inscriptos: 0 };

    const resolveTeacher = async (t, schoolId) => {
      if (t.dni && schoolId) {
        const byDni = await User.findOne({ school: schoolId, dni: t.dni }).select('_id');
        if (byDni) return byDni;
      }
      return await User.findOne({ email: t.email }).select('_id');
    };

    const teacherMap = {};
    if (importDocentes && teachers?.length) {
      for (const t of teachers) {
        try {
          const user = await User.create({ name: t.nombre, email: t.email, password: t.dni, role: 'teacher', school, dni: t.dni });
          teacherMap[t.cuil] = user._id;
          results.docentes.created++;
        } catch {
          const existing = await resolveTeacher(t, school);
          if (existing) teacherMap[t.cuil] = existing._id;
          results.docentes.skipped++;
        }
      }
    } else if (teachers?.length) {
      for (const t of teachers) {
        const existing = await resolveTeacher(t, school);
        if (existing) teacherMap[t.cuil] = existing._id;
      }
    }

    if (importMaterias && entries?.length) {
      const nombres = [...new Set(entries.map(e => e.materia))];
      for (const nombre of nombres) {
        try {
          const exists = await Subject.findOne({ name: nombre, school: school || null });
          if (!exists) { await Subject.create({ name: nombre, school }); results.materias.created++; }
          else results.materias.skipped++;
        } catch { results.materias.skipped++; }
      }
    }

    const createdCourseMap = {};
    if (importCursosMaterias && entries?.length) {
      for (const e of entries) {
        const parsedT   = parseTeacher(e.persona);
        const teacher   = parsedT ? teachers.find(t => t.cuil === parsedT.cuil) : null;
        const teacherId = teacher ? teacherMap[teacher.cuil] : null;
        if (!teacherId) { results.cursos.skipped++; continue; }
        try {
          const divDoc = await findOrCreateDivision(e.division, school);
          if (!divDoc) { results.cursos.skipped++; continue; }
          const course = await Course.create({ name: e.materia, division: divDoc._id, owner: teacherId, school });
          createdCourseMap[`${e.division}|${e.materia}`] = course._id;
          results.cursos.created++;
        } catch { results.cursos.skipped++; }
      }
    }

    if (inscribirAlumnos && Object.keys(createdCourseMap).length) {
      const divisionMap = {};
      for (const key of Object.keys(createdCourseMap)) {
        const div = key.split('|')[0];
        if (!divisionMap[div]) divisionMap[div] = [];
        divisionMap[div].push(createdCourseMap[key]);
      }
      for (const [divisionName, courseIds] of Object.entries(divisionMap)) {
        const divDoc = await Division.findOne({ name: divisionName, ...(school ? { school } : {}) });
        if (!divDoc) continue;
        const divCourse = await Course.findOne({ division: divDoc._id, ...(school ? { school } : {}) }).select('students');
        if (!divCourse || !divCourse.students.length) continue;
        for (const courseId of courseIds) {
          await Course.findByIdAndUpdate(courseId, { $addToSet: { students: { $each: divCourse.students } } });
          results.inscriptos += divCourse.students.length;
        }
      }
    }

    logAudit(req, 'import.execute', [],
      {
        flujo: 'cargos',
        docentes_nuevos: results.docentes.created,
        cursos_nuevos:   results.cursos.created,
        materias_nuevas: results.materias.created,
        inscriptos:      results.inscriptos,
      },
    );

    return res.json({ results });
  }

  /* ── Flujo Sistema (plantilla propia) ── */
  if (req.body.type === 'sistema') {
    const { cursos, docentes, alumnos, materias } = req.body;
    const results = {
      divisiones: { created: 0, skipped: 0 },
      docentes:   { created: 0, skipped: 0 },
      alumnos:    { created: 0, skipped: 0 },
      cursos:     { created: 0, skipped: 0 },
      inscriptos: 0,
    };

    // 1. Divisiones
    const divisionMap = {};
    if (cursos?.length) {
      for (const name of cursos) {
        try {
          const div = await findOrCreateDivision(name, school);
          if (div) { divisionMap[name] = div._id; results.divisiones.created++; }
          else results.divisiones.skipped++;
        } catch { results.divisiones.skipped++; }
      }
    }

    // 2. Docentes
    const teacherByDni = {};
    if (docentes?.length) {
      for (const d of docentes) {
        const emailToUse = d.email || `doc.${d.dni}@esc4039.edu.ar`;
        try {
          const user = await User.create({ name: d.nombre, email: emailToUse, password: d.dni || 'changeme', role: 'teacher', school, dni: d.dni });
          if (d.dni) teacherByDni[d.dni] = user._id;
          results.docentes.created++;
        } catch {
          let existing = null;
          if (d.dni && school) existing = await User.findOne({ school, dni: d.dni }).select('_id');
          if (!existing && emailToUse) existing = await User.findOne({ email: emailToUse }).select('_id');
          if (existing && d.dni) teacherByDni[d.dni] = existing._id;
          results.docentes.skipped++;
        }
      }
    }

    // 3. Alumnos
    const studentByCurso = {};
    if (alumnos?.length) {
      for (const a of alumnos) {
        try {
          const user = await User.create({ name: a.nombre, email: a.email, password: a.dni || 'changeme', role: 'student', school, dni: a.dni });
          if (!studentByCurso[a.curso]) studentByCurso[a.curso] = [];
          studentByCurso[a.curso].push(user._id);
          results.alumnos.created++;
        } catch {
          let existing = null;
          if (a.dni && school) existing = await User.findOne({ school, dni: a.dni }).select('_id');
          if (!existing) existing = await User.findOne({ email: a.email }).select('_id');
          if (existing) {
            if (!studentByCurso[a.curso]) studentByCurso[a.curso] = [];
            studentByCurso[a.curso].push(existing._id);
          }
          results.alumnos.skipped++;
        }
      }
    }

    // 4. Materias (Course instances)
    if (materias?.length) {
      for (const m of materias) {
        const divId     = divisionMap[m.curso];
        const teacherId = m.dniDocente ? teacherByDni[m.dniDocente] : null;
        if (!divId || !teacherId) { results.cursos.skipped++; continue; }
        try {
          const course = await Course.create({ name: m.materia, division: divId, owner: teacherId, school });
          results.cursos.created++;
          // enroll students from the same division
          const divStudents = studentByCurso[m.curso] || [];
          if (divStudents.length) {
            await Course.findByIdAndUpdate(course._id, { $addToSet: { students: { $each: divStudents } } });
            results.inscriptos += divStudents.length;
          }
        } catch { results.cursos.skipped++; }
      }
    }

    logAudit(req, 'import.execute', [],
      {
        flujo:             'sistema',
        divisiones_nuevas: results.divisiones.created,
        docentes_nuevos:   results.docentes.created,
        alumnos_nuevos:    results.alumnos.created,
        cursos_nuevos:     results.cursos.created,
        inscriptos:        results.inscriptos,
      },
    );

    return res.json({ results });
  }

  /* ── Flujo de Alumnos ── */
  const { importAlumnos, importCursos, importMaterias, students, cursosConfig } = req.body;
  const results = { alumnos: { created: 0, skipped: 0 }, cursos: { created: 0, skipped: 0 }, materias: { created: 0, skipped: 0 }, inscriptos: 0 };

  const alumnoMap = {};
  if (importAlumnos && students?.length) {
    for (const s of students) {
      try {
        const user = await User.create({ name: s.nombre, email: s.email, password: s.dni, role: 'student', school, dni: s.dni });
        alumnoMap[s.email] = user._id;
        results.alumnos.created++;
      } catch {
        let existing = null;
        if (s.dni && school) existing = await User.findOne({ school, dni: s.dni }).select('_id');
        if (!existing) existing = await User.findOne({ email: s.email }).select('_id');
        if (existing) alumnoMap[s.email] = existing._id;
        results.alumnos.skipped++;
      }
    }
  }

  const courseNameToId = {};
  if (importCursos && cursosConfig?.length) {
    for (const c of cursosConfig) {
      if (!c.teacherId) { results.cursos.skipped++; continue; }
      try {
        // c.section es el nombre de la división (ej: "1A", "2°1°")
        const divDoc = await findOrCreateDivision(c.section || c.name, school);
        if (!divDoc) { results.cursos.skipped++; continue; }
        const course = await Course.create({ name: c.name, division: divDoc._id, owner: c.teacherId, school });
        courseNameToId[c.name] = course._id;
        results.cursos.created++;
      } catch { results.cursos.skipped++; }
    }

    if (students?.length) {
      for (const s of students) {
        const userId   = alumnoMap[s.email];
        const courseId = courseNameToId[s.curso];
        if (userId && courseId) {
          await Course.findByIdAndUpdate(courseId, { $addToSet: { students: userId } });
          results.inscriptos++;
        }
      }
    }
  }

  if (importMaterias && cursosConfig?.length) {
    const names = [...new Set(cursosConfig.map(c => c.subjectName).filter(Boolean))];
    for (const name of names) {
      try {
        const exists = await Subject.findOne({ name, school: school || null });
        if (!exists) { await Subject.create({ name, color: '#1a73e8', school }); results.materias.created++; }
        else results.materias.skipped++;
      } catch { results.materias.skipped++; }
    }
  }

  logAudit(req, 'import.execute', [],
    {
      flujo:           'alumnos',
      alumnos_nuevos:  results.alumnos.created,
      cursos_nuevos:   results.cursos.created,
      materias_nuevas: results.materias.created,
      inscriptos:      results.inscriptos,
    },
  );

  res.json({ results });
});

/* ─── Tema ─── */
router.get('/theme', requireAuth, requireAdmin, async (req, res) => {
  const school = await School.findById(res.locals.user.school);
  if (!school) return res.status(404).send('Escuela no encontrada');
  res.render('admin/theme', { school, THEMES, activePage: 'theme' });
});

// Aceptar o rechazar un tema ofrecido
router.post('/theme/respond', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { slug, action } = req.body;
    const status = action === 'accept' ? 'accepted' : 'rejected';
    await School.findOneAndUpdate(
      { _id: res.locals.user.school, 'themes.slug': slug },
      { $set: { 'themes.$.status': status } }
    );
    invalidateSchool(res.locals.user.school);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
