const express = require('express');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const XLSX    = require('xlsx');
const User    = require('../models/User');
const Course  = require('../models/Course');
const Subject = require('../models/Subject');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');

// Multer en memoria para leer el Excel sin guardarlo en disco
const xlsUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Solo archivos .xls o .xlsx'));
  },
});

// Convierte "PEREZ, Juan" a "Juan Perez" (capitalización de nombre y apellido)
const formatName = (raw) => {
  const comma = raw.indexOf(',');
  if (comma === -1) return raw.trim(); // Sin coma: devuelve tal cual
  const apellido = raw.substring(0, comma).trim();
  const nombre   = raw.substring(comma + 1).trim();
  const cap = s => s.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return [cap(nombre), cap(apellido)].filter(Boolean).join(' ');
};

// Extrae el email de una fila del Excel de alumnos
// Revisa columnas 11 y 10 (pueden tener varias líneas concatenadas) y devuelve el primer email válido
const extractEmail = (r) => {
  const candidates = [r[11], r[10]].join('\n').split('\n').map(e => e.trim()).filter(e => e && e.includes('@') && e.includes('.'));
  return candidates[0] || '';
};

// Capitaliza cada palabra de un string (auxiliar reutilizable)
const cap = s => s.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

// Parsea una celda de la columna "persona" del Excel de cargos docentes
// Formato esperado: "20-12345678-9 PEREZ JUAN M"  (CUIL + nombre + sexo)
// Retorna: { cuil, dni, nombre, email } o null si no matchea
const parseTeacher = (persona) => {
  const m = persona.toString().trim().match(/^(\d{2})-(\d{7,9})-(\d)\s+(.+)$/);
  if (!m) return null;
  const dni     = m[2];
  const cuil    = `${m[1]}-${dni}-${m[3]}`;
  const nombreRaw = m[4].trim().replace(/\s+[MF]$/, '').trim(); // Quita la letra de sexo al final
  return { cuil, dni, nombre: cap(nombreRaw), email: `doc.${dni}@esc4039.edu.ar` };
};

const router = express.Router();

// Email del superadmin protegido: nunca puede ser eliminado, deshabilitado ni cambiarle el rol
const PROTECTED_ADMIN_EMAIL = 'waltermedinilla@gmail.com';

// Todos los endpoints del panel admin requieren login Y rol admin/superadmin
router.use(requireAuth, requireAdmin);

/* ─── Dashboard ─── */
// GET /admin — Estadísticas de la escuela del admin autenticado
// Si el admin tiene school asignada, filtra todo por esa escuela; si es superadmin (school null), ve todo
router.get('/', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {}; // Filtro de escuela reutilizable

  // Conteo en paralelo para no hacer 5 queries secuenciales
  const [userCount, courseCount, teacherCount, studentCount, subjectCount] = await Promise.all([
    User.countDocuments(sf),
    Course.countDocuments(sf),
    User.countDocuments({ ...sf, role: 'teacher' }),
    User.countDocuments({ ...sf, role: 'student' }),
    Subject.countDocuments(sf),
  ]);
  res.render('admin/dashboard', { userCount, courseCount, teacherCount, studentCount, subjectCount });
});

/* ─── Users ─── */
// GET /admin/users — Lista usuarios de la escuela con filtros opcionales
// Query: ?role=teacher&search=Juan
// Además construye enrolledMap para saber qué alumnos están matriculados en al menos un curso
// enrolledMap[studentId] = true → está matriculado
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

  // Construcción eficiente del mapa de matriculación:
  // Una sola query trae todos los cursos que contienen a alguno de los alumnos de la lista
  const studentIds = users.filter(u => u.role === 'student').map(u => u._id);
  const enrolledMap = {};
  if (studentIds.length) {
    const courses = await Course.find({ students: { $in: studentIds } }).select('students');
    // Itera los cursos y marca como matriculado a cada alumno encontrado
    courses.forEach(c => c.students.forEach(sid => { enrolledMap[sid.toString()] = true; }));
  }

  res.render('admin/users', { users, enrolledMap, currentRole: role || '', search: search || '' });
});

// GET /admin/users/create — Formulario de nuevo usuario (user: null = modo creación)
router.get('/users/create', (req, res) => {
  res.render('admin/user-form', { user: null });
});

// POST /admin/users/create — Crea un usuario en la escuela del admin
// Body: { name, email, password, role, dni? }
// Hereda automáticamente la escuela del admin autenticado
router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role, dni } = req.body;
    // Los admins no pueden crear superadmins (solo el panel superadmin puede hacerlo)
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

// GET /admin/users/:id — Perfil de un usuario con sus cursos creados y unidos
// Verifica que el usuario target pertenezca a la escuela del admin
router.get('/users/:id', async (req, res) => {
  const school = res.locals.user.school;
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).send('Usuario no encontrado');

  // El admin no puede ver perfiles de usuarios de otras escuelas
  if (school && target.school?.toString() !== school.toString()) {
    return res.status(403).send('Acceso denegado');
  }

  // Carga cursos con escuela para mostrar badge "(Sin Matricular)" si course.school es null
  const [createdCourses, joinedCourses] = await Promise.all([
    Course.find({ owner:    target._id }).populate('owner', 'name email').populate('school', 'name'),
    Course.find({ students: target._id }).populate('owner', 'name email').populate('school', 'name'),
  ]);
  res.render('admin/user-profile', { target, createdCourses, joinedCourses, PROTECTED_ADMIN_EMAIL });
});

// POST /admin/users/:id/role — Cambia el rol de un usuario
// Protecciones: no tocar PROTECTED_ADMIN_EMAIL, no el propio admin, no asignar superadmin
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
    // Un admin no puede rebajarse a sí mismo a un rol distinto de admin
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

// POST /admin/users/:id/toggle-active — Habilita o deshabilita la cuenta de un usuario
// No puede usarse sobre cuentas protegidas ni sobre la propia cuenta del admin
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
    target.active = !target.active; // Invierte el flag
    await target.save({ validateModifiedOnly: true }); // No revalida campos no modificados
    res.json({ active: target.active });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /admin/users/:id/reset-password — Restablece la contraseña al DNI del usuario
// Si no tiene DNI, usa "Classroom1234" como contraseña temporal
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
    target.password = newPassword; // El hook pre-save se encargará del hasheo
    await target.save();
    // Devuelve un hint para que el admin sepa qué contraseña comunicar al usuario
    res.json({ ok: true, hint: target.dni ? 'DNI del usuario' : 'Classroom1234' });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /admin/users/:id/delete — Elimina permanentemente un usuario
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
// POST /admin/users/:id/impersonate — El admin toma la sesión de otro usuario
// Mecanismo: guarda el JWT del admin en adminToken y genera un nuevo token para el target
// Para volver: GET /exit-impersonate (en routes/auth.js) restaura el adminToken como token
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
    // Guarda el token actual del admin en adminToken (para poder volver)
    res.cookie('adminToken', req.cookies.token, { httpOnly: true, maxAge: twoHours });
    // Genera un JWT temporal (2h) para el usuario target
    const targetToken = jwt.sign({ userId: target._id }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', targetToken, { httpOnly: true, maxAge: twoHours });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Subjects ─── */
// GET /admin/subjects — Lista materias con conteo de cursos asociados por escuela
router.get('/subjects', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const { search } = req.query;
  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };
  const subjects = await Subject.find(filter).sort({ name: 1 });

  // Para cada materia cuenta cuántos cursos tienen ese nombre y misma escuela
  // courseCount === 0 → badge "(Sin Matricular)" en la vista
  const subjectsWithCount = await Promise.all(
    subjects.map(async (s) => {
      const courseCount = await Course.countDocuments({ subject: s.name, ...sf });
      return { ...s.toObject(), courseCount };
    })
  );
  res.render('admin/subjects', { subjects: subjectsWithCount, search: search || '' });
});

router.get('/subjects/create', (req, res) => {
  res.render('admin/subject-form', { subject: null });
});

// POST /admin/subjects/create — Crea una materia en la escuela del admin
// Si el usuario es superadmin (school=null) puede pasar el schoolId en el body
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

// GET /admin/subjects/:id — Detalle de una materia con los cursos que la usan
// Popula school del curso para mostrar badge si el curso no tiene escuela asignada
router.get('/subjects/:id', async (req, res) => {
  const school  = res.locals.user.school;
  const sf      = school ? { school } : {};
  const subject = await Subject.findById(req.params.id);
  if (!subject) return res.status(404).send('Materia no encontrada');
  if (school && subject.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');

  // Cursos con mismo nombre de materia en la misma escuela; incluye owner y school para la vista
  const courses = await Course.find({ subject: subject.name, ...sf })
    .populate('owner',  'name email')
    .populate('school', 'name');
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
// GET /admin/import — Carga la vista de importación con docentes y materias existentes
// para poder pre-asignarlos al importar desde Excel
router.get('/import', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const [teachers, subjects] = await Promise.all([
    User.find({ ...sf, role: { $in: ['teacher', 'admin'] } }).sort({ name: 1 }).select('_id name email role'),
    Subject.find(sf).sort({ name: 1 }).select('_id name color'),
  ]);
  res.render('admin/import', { teachers, subjects });
});

// POST /admin/import/upload — Lee y parsea el Excel; detecta tipo de archivo (cargos o alumnos)
// Si el header incluye "división" o "materia" → tipo 'cargos' (formato ministerial de cargos docentes)
// Si no → tipo 'alumnos' (padrón de alumnos del sistema de gestión)
// Retorna JSON con los datos parseados para que el frontend muestre un preview antes de confirmar
router.post('/admin/import/upload', xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const wb    = XLSX.read(req.file.buffer, { type: 'buffer' }); // Lee desde buffer en memoria
    const ws    = wb.Sheets[wb.SheetNames[0]]; // Primera hoja del archivo
    const rawData   = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }); // Array de arrays
    const sheetName = wb.SheetNames[0];
    const headers   = rawData[0].map(h => h.toString().toLowerCase());

    if (headers.includes('división') || headers.includes('materia')) {
      // Tipo cargos: columna 5=división, 6=materia, 7=turno, 9=persona (CUIL + nombre)
      const rows = rawData.slice(1).filter(r => r[5] && r[6]);
      const entries = rows.map(r => ({
        division: r[5].toString().trim(),
        materia:  r[6].toString().trim(),
        turno:    r[7].toString().trim(),
        persona:  r[9].toString().trim(),
      })).filter(e => e.division && e.materia);

      // Deduplica docentes por CUIL para no crear duplicados al importar
      const teacherMap = {};
      entries.forEach(e => {
        const t = parseTeacher(e.persona);
        if (t && !teacherMap[t.cuil]) teacherMap[t.cuil] = t;
      });

      return res.json({
        type:      'cargos',
        entries,
        teachers:  Object.values(teacherMap),
        materias:  [...new Set(entries.map(e => e.materia))].sort(),
        divisiones: [...new Set(entries.map(e => e.division))].sort(),
        sheetName,
      });
    }

    // Tipo alumnos: fila 0 = encabezados, fila 1 = metadatos → datos desde fila 2
    // columna 0=CUIL, 1=DNI, 4=nombre, 5=curso, 10-11=email
    const rows     = rawData.slice(2).filter(r => r[0]);
    const students = [];
    let skipped    = 0;
    rows.forEach(r => {
      const email = extractEmail(r);
      if (!email) { skipped++; return; } // Sin email: no se puede crear la cuenta
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

// POST /admin/import/execute — Ejecuta la importación confirmada por el usuario
// Soporta dos flujos: type='cargos' (docentes + cursos + materias) y type='alumnos' (alumnos + cursos)
// Todos los errores por duplicado son "skipped" (no cortan el proceso)
router.post('/admin/import/execute', async (req, res) => {
  const school = res.locals.user.school;

  if (req.body.type === 'cargos') {
    const { importDocentes, importCursosMaterias, importMaterias, inscribirAlumnos, entries, teachers } = req.body;
    const results = { docentes: { created: 0, skipped: 0 }, cursos: { created: 0, skipped: 0 }, materias: { created: 0, skipped: 0 }, inscriptos: 0 };

    // Busca un docente existente por DNI (dentro de la escuela) o por email (global)
    const resolveTeacher = async (t, schoolId) => {
      if (t.dni && schoolId) {
        const byDni = await User.findOne({ school: schoolId, dni: t.dni }).select('_id');
        if (byDni) return byDni; // Prioridad: DNI en la escuela
      }
      return await User.findOne({ email: t.email }).select('_id'); // Fallback: email global
    };

    // teacherMap: cuil → userId; se construye al crear/resolver cada docente
    const teacherMap = {};
    if (importDocentes && teachers?.length) {
      for (const t of teachers) {
        try {
          const user = await User.create({ name: t.nombre, email: t.email, password: t.dni, role: 'teacher', school, dni: t.dni });
          teacherMap[t.cuil] = user._id;
          results.docentes.created++;
        } catch {
          // Si ya existe (duplicado), lo resuelve y mapea igual para poder usarlo en cursos
          const existing = await resolveTeacher(t, school);
          if (existing) teacherMap[t.cuil] = existing._id;
          results.docentes.skipped++;
        }
      }
    } else if (teachers?.length) {
      // Si no importa docentes pero los necesita para cursos: solo los resuelve, no los crea
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

    // createdCourseMap: "división|materia" → courseId; necesario para inscribir alumnos
    const createdCourseMap = {};
    if (importCursosMaterias && entries?.length) {
      for (const e of entries) {
        const parsedT  = parseTeacher(e.persona);
        const teacher  = parsedT ? teachers.find(t => t.cuil === parsedT.cuil) : null;
        const teacherId = teacher ? teacherMap[teacher.cuil] : null;
        if (!teacherId) { results.cursos.skipped++; continue; }
        try {
          const course = await Course.create({ name: e.materia, section: e.division, subject: e.materia, owner: teacherId, school });
          createdCourseMap[`${e.division}|${e.materia}`] = course._id;
          results.cursos.created++;
        } catch { results.cursos.skipped++; }
      }
    }

    // Inscribe alumnos: busca alumnos del curso "división" y los agrega a todos los cursos de esa división
    if (inscribirAlumnos && Object.keys(createdCourseMap).length) {
      // divisionMap: división → [courseIds de esa división]
      const divisionMap = {};
      for (const key of Object.keys(createdCourseMap)) {
        const div = key.split('|')[0];
        if (!divisionMap[div]) divisionMap[div] = [];
        divisionMap[div].push(createdCourseMap[key]);
      }
      for (const [division, courseIds] of Object.entries(divisionMap)) {
        // Busca el curso "base" de la división que ya tiene alumnos inscriptos
        const divCourse = await Course.findOne({ $or: [{ name: division }, { section: division }], ...(school ? { school } : {}) }).select('students');
        if (!divCourse || !divCourse.students.length) continue;
        // Inscribe esos alumnos en cada curso nuevo de la misma división
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

  // alumnoMap: email → userId para usarlo al inscribir en cursos
  const alumnoMap = {};
  if (importAlumnos && students?.length) {
    for (const s of students) {
      try {
        const user = await User.create({ name: s.nombre, email: s.email, password: s.dni, role: 'student', school, dni: s.dni });
        alumnoMap[s.email] = user._id;
        results.alumnos.created++;
      } catch {
        // Alumno ya existe: lo busca por DNI en la escuela primero, luego por email
        let existing = null;
        if (s.dni && school) existing = await User.findOne({ school, dni: s.dni }).select('_id');
        if (!existing) existing = await User.findOne({ email: s.email }).select('_id');
        if (existing) alumnoMap[s.email] = existing._id;
        results.alumnos.skipped++;
      }
    }
  }

  // courseNameToId: nombre del curso → courseId para inscribir alumnos después
  const courseNameToId = {};
  if (importCursos && cursosConfig?.length) {
    for (const c of cursosConfig) {
      if (!c.teacherId) { results.cursos.skipped++; continue; } // Sin docente: no se puede crear
      try {
        const course = await Course.create({ name: c.name, section: c.section || '', subject: c.subjectName || '', owner: c.teacherId, school });
        courseNameToId[c.name] = course._id;
        results.cursos.created++;
      } catch { results.cursos.skipped++; }
    }

    // Inscribe alumnos en su curso según la columna "curso" del Excel
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
