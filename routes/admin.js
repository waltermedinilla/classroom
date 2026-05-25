const express  = require('express');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const XLSX     = require('xlsx');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Subject  = require('../models/Subject');
const Division = require('../models/Division');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

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
  const filter = school ? { school } : {};
  if (role) filter.role = role;
  if (search) filter.$or = [
    { name:  { $regex: search, $options: 'i' } },
    { email: { $regex: search, $options: 'i' } },
  ];
  const users = await User.find(filter).sort({ createdAt: -1 });
  const studentIds = users.filter(u => u.role === 'student').map(u => u._id);
  const enrolledMap = {};
  if (studentIds.length) {
    const courses = await Course.find({ students: { $in: studentIds } }).select('students');
    courses.forEach(c => c.students.forEach(sid => { enrolledMap[sid.toString()] = true; }));
  }
  res.render('admin/users', { users, enrolledMap, currentRole: role || '', search: search || '' });
});

router.get('/users/create', (req, res) => {
  res.render('admin/user-form', { user: null });
});

router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role, dni } = req.body;
    if (role === 'superadmin') return res.status(403).json({ error: 'No permitido' });
    const userData = { name, email, password, role, school: res.locals.user.school };
    if (dni) userData.dni = dni;
    const user = await User.create(userData);
    res.status(201).json({ user });
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
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true, runValidators: true });
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
    const division = await Division.findByIdAndUpdate(req.params.id, { name }, { new: true, runValidators: true });
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
  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };
  const subjects = await Subject.find(filter).sort({ name: 1 });

  // Cuenta materias usando Course.name (ya no existe Course.subject)
  const subjectsWithCount = await Promise.all(
    subjects.map(async (s) => {
      const courseCount = await Course.countDocuments({ name: s.name, ...sf });
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
    const { name, description, color, school: bodySchool } = req.body;
    const schoolId = res.locals.user.school || bodySchool || null;
    const subject = await Subject.create({ name, description, color, school: schoolId });
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
    const subject = await Subject.findByIdAndUpdate(req.params.id, { name, description, color }, { new: true, runValidators: true });
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

router.post('/import/upload', xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const wb    = XLSX.read(req.file.buffer, { type: 'buffer' });
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
        const divDoc = await findOrCreateDivision(c.section, school);
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

  res.json({ results });
});

module.exports = router;
