const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const User = require('../models/User');
const Course = require('../models/Course');
const Subject = require('../models/Subject');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

const xlsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Solo archivos .xls o .xlsx'));
  },
});

const formatName = (raw) => {
  const comma = raw.indexOf(',');
  if (comma === -1) return raw.trim();
  const apellido = raw.substring(0, comma).trim();
  const nombre = raw.substring(comma + 1).trim();
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
  const dni = m[2];
  const cuil = `${m[1]}-${dni}-${m[3]}`;
  const nombreRaw = m[4].trim().replace(/\s+[MF]$/, '').trim();
  return {
    cuil,
    dni,
    nombre: cap(nombreRaw),
    email: `doc.${dni}@esc4039.edu.ar`,
  };
};

const router = express.Router();
const PROTECTED_ADMIN_EMAIL = 'waltermedinilla@gmail.com';

router.use(requireAuth, requireAdmin);

/* ─── Dashboard ─── */
router.get('/', async (req, res) => {
  const [userCount, courseCount, teacherCount, studentCount, subjectCount] = await Promise.all([
    User.countDocuments(),
    Course.countDocuments(),
    User.countDocuments({ role: 'teacher' }),
    User.countDocuments({ role: 'student' }),
    Subject.countDocuments(),
  ]);
  res.render('admin/dashboard', { userCount, courseCount, teacherCount, studentCount, subjectCount });
});

/* ─── Users ─── */
router.get('/users', async (req, res) => {
  const { role, search } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (search) filter.$or = [
    { name: { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
  ];
  const users = await User.find(filter).sort({ createdAt: -1 });
  res.render('admin/users', { users, currentRole: role || '', search: search || '' });
});

router.get('/users/create', (req, res) => {
  res.render('admin/user-form', { user: null });
});

router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const user = await User.create({ name, email, password, role });
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/users/:id', async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).send('Usuario no encontrado');
  const [createdCourses, joinedCourses] = await Promise.all([
    Course.find({ owner: target._id }).populate('owner', 'name email'),
    Course.find({ students: target._id }).populate('owner', 'name email'),
  ]);
  res.render('admin/user-profile', { target, createdCourses, joinedCourses, PROTECTED_ADMIN_EMAIL });
});

router.post('/users/:id/role', async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL) {
      return res.status(400).json({ error: 'No se puede modificar el rol del administrador principal' });
    }
    if (req.params.id === req.userId && req.body.role !== 'admin') {
      return res.status(400).json({ error: 'No puedes cambiar tu propio rol de admin' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true, runValidators: true });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/users/:id/delete', async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL) {
      return res.status(400).json({ error: 'No se puede eliminar el administrador principal' });
    }
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Impersonation ─── */
router.post('/users/:id/impersonate', async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.email === PROTECTED_ADMIN_EMAIL) {
      return res.status(400).json({ error: 'No puedes suplantar al administrador principal' });
    }
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'Ya eres este usuario' });
    }
    const twoHours = 2 * 60 * 60 * 1000;
    res.cookie('adminToken', req.cookies.token, { httpOnly: true, maxAge: twoHours });
    const targetToken = jwt.sign({ userId: target._id }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', targetToken, { httpOnly: true, maxAge: twoHours });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Subjects (Materias) ─── */
router.get('/subjects', async (req, res) => {
  const { search } = req.query;
  const filter = {};
  if (search) filter.name = { $regex: search, $options: 'i' };
  const subjects = await Subject.find(filter).sort({ name: 1 });
  const subjectsWithCount = await Promise.all(
    subjects.map(async (s) => {
      const courseCount = await Course.countDocuments({ subject: s.name });
      return { ...s.toObject(), courseCount };
    })
  );
  res.render('admin/subjects', { subjects: subjectsWithCount, search: search || '' });
});

router.get('/subjects/create', (req, res) => {
  res.render('admin/subject-form', { subject: null });
});

router.post('/subjects/create', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const subject = await Subject.create({ name, description, color });
    res.status(201).json({ subject });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una materia con ese nombre' });
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/subjects/:id/edit', async (req, res) => {
  const subject = await Subject.findById(req.params.id);
  if (!subject) return res.status(404).send('Materia no encontrada');
  res.render('admin/subject-form', { subject });
});

router.post('/subjects/:id/edit', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const subject = await Subject.findByIdAndUpdate(
      req.params.id, { name, description, color },
      { new: true, runValidators: true }
    );
    if (!subject) return res.status(404).json({ error: 'Materia no encontrada' });
    res.json({ subject });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una materia con ese nombre' });
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/subjects/:id', async (req, res) => {
  const subject = await Subject.findById(req.params.id);
  if (!subject) return res.status(404).send('Materia no encontrada');
  const courses = await Course.find({ subject: subject.name }).populate('owner', 'name email');
  res.render('admin/subject-detail', { subject, courses });
});

router.post('/subjects/:id/delete', async (req, res) => {
  try {
    await Subject.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Import ─── */
router.get('/import', async (req, res) => {
  const [teachers, subjects] = await Promise.all([
    User.find({ role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email role'),
    Subject.find().sort({ name: 1 }).select('_id name color'),
  ]);
  res.render('admin/import', { teachers, subjects });
});

router.post('/import/upload', xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const sheetName = wb.SheetNames[0];
    const headers = rawData[0].map(h => h.toString().toLowerCase());

    /* ── Archivo de Cargos (División + Materia + Persona) ── */
    if (headers.includes('división') || headers.includes('materia')) {
      const rows = rawData.slice(1).filter(r => r[5] && r[6]);
      const entries = rows.map(r => ({
        division: r[5].toString().trim(),
        materia: r[6].toString().trim(),
        turno: r[7].toString().trim(),
        persona: r[9].toString().trim(),
      })).filter(e => e.division && e.materia);

      const teacherMap = {};
      entries.forEach(e => {
        const t = parseTeacher(e.persona);
        if (t && !teacherMap[t.cuil]) teacherMap[t.cuil] = t;
      });

      const materias = [...new Set(entries.map(e => e.materia))].sort();
      const divisiones = [...new Set(entries.map(e => e.division))].sort();

      return res.json({
        type: 'cargos',
        entries,
        teachers: Object.values(teacherMap),
        materias,
        divisiones,
        sheetName,
      });
    }

    /* ── Archivo de Alumnos (Cuil + Alumno + Curso) ── */
    const rows = rawData.slice(2).filter(r => r[0]);
    const students = [];
    let skipped = 0;
    rows.forEach(r => {
      const email = extractEmail(r);
      if (!email) { skipped++; return; }
      students.push({
        nombre: formatName(r[4].toString()),
        cuil: r[0].toString().trim(),
        dni: r[1].toString().replace('DNI', '').trim(),
        curso: r[5].toString().trim(),
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
  /* ── Ejecución para archivo de Cargos ── */
  if (req.body.type === 'cargos') {
    const { importDocentes, importCursosMaterias, importMaterias, inscribirAlumnos, entries, teachers } = req.body;
    const results = { docentes: { created: 0, skipped: 0 }, cursos: { created: 0, skipped: 0 }, materias: { created: 0, skipped: 0 }, inscriptos: 0 };

    // 1. Crear docentes
    const teacherMap = {}; // cuil → userId
    if (importDocentes && teachers?.length) {
      for (const t of teachers) {
        try {
          const user = await User.create({ name: t.nombre, email: t.email, password: t.dni, role: 'teacher' });
          teacherMap[t.cuil] = user._id;
          results.docentes.created++;
        } catch {
          const existing = await User.findOne({ email: t.email }).select('_id');
          if (existing) teacherMap[t.cuil] = existing._id;
          results.docentes.skipped++;
        }
      }
    } else if (teachers?.length) {
      for (const t of teachers) {
        const existing = await User.findOne({ email: t.email }).select('_id');
        if (existing) teacherMap[t.cuil] = existing._id;
      }
    }

    // 2. Crear materias (subjects)
    if (importMaterias && entries?.length) {
      const nombres = [...new Set(entries.map(e => e.materia))];
      for (const nombre of nombres) {
        try {
          const exists = await Subject.findOne({ name: nombre });
          if (!exists) { await Subject.create({ name: nombre }); results.materias.created++; }
          else results.materias.skipped++;
        } catch { results.materias.skipped++; }
      }
    }

    // 3. Crear cursos por materia
    const createdCourseMap = {}; // "division|materia" → courseId
    if (importCursosMaterias && entries?.length) {
      for (const e of entries) {
        const parsedT = parseTeacher(e.persona);
        const teacher = parsedT ? teachers.find(t => t.cuil === parsedT.cuil) : null;
        const teacherId = teacher ? teacherMap[teacher.cuil] : null;
        if (!teacherId) { results.cursos.skipped++; continue; }
        try {
          const course = await Course.create({
            name: e.materia,
            section: e.division,
            subject: e.materia,
            owner: teacherId,
          });
          createdCourseMap[`${e.division}|${e.materia}`] = course._id;
          results.cursos.created++;
        } catch { results.cursos.skipped++; }
      }
    }

    // 4. Inscribir alumnos existentes
    if (inscribirAlumnos && Object.keys(createdCourseMap).length) {
      const divisionMap = {};
      for (const key of Object.keys(createdCourseMap)) {
        const div = key.split('|')[0];
        if (!divisionMap[div]) divisionMap[div] = [];
        divisionMap[div].push(createdCourseMap[key]);
      }
      for (const [division, courseIds] of Object.entries(divisionMap)) {
        const divCourse = await Course.findOne({ $or: [{ name: division }, { section: division }] }).select('students');
        if (!divCourse || !divCourse.students.length) continue;
        for (const courseId of courseIds) {
          await Course.findByIdAndUpdate(courseId, { $addToSet: { students: { $each: divCourse.students } } });
          results.inscriptos += divCourse.students.length;
        }
      }
    }

    return res.json({ results });
  }

  /* ── Ejecución para archivo de Alumnos ── */
  const { importAlumnos, importCursos, importMaterias, students, cursosConfig } = req.body;
  const results = {
    alumnos: { created: 0, skipped: 0 },
    cursos: { created: 0, skipped: 0 },
    materias: { created: 0, skipped: 0 },
    inscriptos: 0,
  };

  const alumnoMap = {};
  if (importAlumnos && students?.length) {
    for (const s of students) {
      try {
        const user = await User.create({ name: s.nombre, email: s.email, password: s.dni, role: 'student' });
        alumnoMap[s.email] = user._id;
        results.alumnos.created++;
      } catch {
        const existing = await User.findOne({ email: s.email }).select('_id');
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
        const course = await Course.create({
          name: c.name,
          section: c.section || '',
          subject: c.subjectName || '',
          owner: c.teacherId,
        });
        courseNameToId[c.name] = course._id;
        results.cursos.created++;
      } catch {
        results.cursos.skipped++;
      }
    }

    if (students?.length) {
      for (const s of students) {
        const userId = alumnoMap[s.email];
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
        const exists = await Subject.findOne({ name });
        if (!exists) {
          await Subject.create({ name, color: '#1a73e8' });
          results.materias.created++;
        } else {
          results.materias.skipped++;
        }
      } catch {
        results.materias.skipped++;
      }
    }
  }

  res.json({ results });
});

module.exports = router;
