const express  = require('express');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const XLSX     = require('xlsx');
const path     = require('path');
const fs       = require('fs');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Subject  = require('../models/Subject');
const Division = require('../models/Division');
// Sección = recorte con nombre a cargo de un Jefe de Sección (models/Section.js). No
// confundir con el sectionGuard de más abajo, que es el de las solapas del panel.
const Section  = require('../models/Section');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const ActivityView = require('../models/ActivityView');
const Announcement = require('../models/Announcement');
const { requireAuth }  = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
// Permisos por solapa que el superadmin configura en /superadmin/roles. Solo puede quitar
// lo que requireAdmin ya concedió, nunca agregar (ver middleware/sections.js).
const { sectionGuard } = require('../middleware/sections');
const { invalidateUser, invalidateSchool } = require('../middleware/cache');
const { logAudit } = require('../middleware/audit');
// Matrícula de alumnos en las materias de una división. Extraída a services/ porque el
// panel de preceptoría (routes/preceptor.js) da de alta alumnos con la misma semántica.
const { enrollStudentInDivisionCourses } = require('../services/enrollment');
// DNI obligatorio en toda alta/edición desde 2026-07-30 (ver services/dni.js).
const { normalizeDni } = require('../services/dni');
const School   = require('../models/School');
const THEMES   = require('../config/themes');
const ActivityTemplate   = require('../models/ActivityTemplate');
const TemplateAssignment = require('../models/TemplateAssignment');
const { logDeRuta, logRechazo } = require('../middleware/route-log');

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

    // 1b-bis. Borra los acuses de lectura. No es solo higiene: el chip "N vieron" cuenta
    // documentos ActivityView por actividad, así que un registro colgado seguiría sumando.
    await ActivityView.deleteMany({ activity: { $in: activityIds } });

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

// sectionGuard cubre todo el router de una sola vez, GET y POST: si la escuela le
// deshabilitó "Usuarios" al rol admin, también quedan cerrados /admin/users/:id/delete,
// /reset-password, /impersonate y demás acciones que cuelgan de esa solapa.
router.use(requireAuth, requireAdmin, sectionGuard('admin'));

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
  // Curso (División) de cada alumno para la columna "Curso". Es un array y no un string
  // porque la matrícula por materia no garantiza uno solo: un alumno mal cargado puede
  // figurar en materias de dos cursos distintos (es el diagnóstico 'alumnos-en-varios-cursos'
  // de /superadmin/otros). Mostrar los dos hace visible el problema en vez de esconderlo
  // eligiendo uno al azar.
  const cursoMap = {};
  if (studentIds.length) {
    const enLaPagina = new Set(studentIds.map(String));
    const courses = await Course.find({ students: { $in: studentIds } })
      .select('students division')
      .populate('division', 'name');
    courses.forEach(c => c.students.forEach(sid => {
      const k = sid.toString();
      // c.students trae TODOS los alumnos de la materia, no solo los de esta página.
      if (!enLaPagina.has(k)) return;
      enrolledMap[k] = true;
      if (!c.division?.name) return;
      (cursoMap[k] = cursoMap[k] || new Set()).add(c.division.name);
    }));
    for (const k of Object.keys(cursoMap)) {
      cursoMap[k] = [...cursoMap[k]].sort((a, b) => a.localeCompare(b, 'es'));
    }
  }

  // Divisiones para el combobox del modal "Nuevo usuario" (solo se muestra con rol Alumno)
  const divisions = school
    ? await Division.find({ school }).sort({ name: 1 }).select('_id name').lean()
    : [];

  // Contadores para la columna "Nov·Act·Msg" (una consulta bulk por métrica, no una por usuario)
  const { getUserActivityStats } = require('../services/userActivityStats');
  const activityStats = await getUserActivityStats(users.map(u => u._id));

  const totalPages  = Math.ceil(total / LIMIT);
  const queryParams = { ...(role && { role }), ...(search && { search }) };
  res.render('admin/users', { users, enrolledMap, cursoMap, activityStats, divisions, currentRole: role || '', search: search || '', page, totalPages, total, queryParams });
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

// Filtra una lista de ids de división dejando solo las que existen y son de `school`.
// Se usa al asignarle el alcance a un preceptor (alta y reasignación): sin este filtro,
// un POST armado a mano podría dejarle divisiones de otra escuela en el array.
async function resolveScopeDivisions(divisionIds, school) {
  if (!Array.isArray(divisionIds) || !divisionIds.length || !school) return [];
  const validas = await Division.find({ _id: { $in: divisionIds }, school }).select('_id').lean();
  return validas.map(d => d._id);
}

// Nombres de rol en español, solo para el mensaje de error de DNI-en-otro-rol de acá abajo
// (el mapa completo res.locals.roleNames vive en server.js como middleware EJS, no como
// módulo reusable — para un solo mensaje de error no vale la pena extraerlo).
const ROLE_LABEL = {
  admin: 'Administrador', directivo: 'Directivo', teacher: 'Docente',
  preceptor: 'Preceptor', jefe: 'Jefe de Sección', soe: 'SOE', student: 'Alumno', superadmin: 'Superadministrador',
};

router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role, dni, divisionId, divisionIds, allDivisions } = req.body;
    if (role === 'superadmin') return res.status(403).json({ error: 'No permitido' });

    const school = res.locals.user.school;

    // DNI obligatorio para cualquier rol. Se normaliza a solo dígitos antes de guardarlo,
    // que es como lo indexa {school, dni} y como lo busca /register/lookup.
    const { value: trimmedDni, error: dniError } = normalizeDni(dni);
    if (dniError) return res.status(400).json({ error: dniError });

    // ── Alumno con DNI: puede ser una persona que YA existe en el sistema ──────
    // El índice único {school,dni} solo permite UNA cuenta por DNI en la escuela, así
    // que si ya existe alguien con este DNI, "crear un alumno nuevo" no es lo correcto:
    // o ya es alumno (solo falta completar su matrícula) o tiene otro rol (conflicto real).
    // Se chequea ANTES de intentar crear — antes esto fallaba con el error 11000 del
    // índice, devolviendo el mensaje engañoso "El correo ya está registrado" aunque el
    // email fuera distinto y el verdadero choque fuera el DNI.
    if (role === 'student' && school) {
      const existing = await User.findOne({ school, dni: trimmedDni });
      if (existing) {
        if (existing.role !== 'student') {
          return res.status(409).json({
            error: `Este DNI ya pertenece a ${existing.name} (${ROLE_LABEL[existing.role] || existing.role}) — no se puede matricular como alumno.`,
          });
        }
        // Ya existe como alumno: no se crea una cuenta nueva. Se completa su matrícula
        // en las materias del Curso elegido que todavía le falten (si se eligió alguno).
        const enrolledIn = await enrollStudentInDivisionCourses(req, existing, divisionId, school, 'alta-alumno-dni-existente');
        return res.status(200).json({ user: existing, enrolledIn, existedAlready: true });
      }
    }

    const userData = { name, email, password, role, school, dni: trimmedDni };

    // Preceptor: además del alta hay que definir su alcance (qué cursos ve y administra).
    // Se valida contra la escuela del admin — un id de otra escuela se descarta acá, no
    // se guarda para que después lo filtre el middleware.
    if (role === 'preceptor') {
      userData.allDivisions = allDivisions === true;
      userData.assignedDivisions = userData.allDivisions
        ? []
        : await resolveScopeDivisions(divisionIds, school);
    }

    const user = await User.create(userData);

    logAudit(req, 'user.create',
      [{ type: 'user', id: user._id, name: user.name }],
      { rol: user.role, ...(user.email ? { email: user.email } : {}) },
    );

    // Si es alumno y el admin eligió un Curso: lo inscribimos en TODAS las materias
    // de ese Curso, guardando joinedAt = ahora en Course.enrollmentDates para que las
    // tareas vencidas ANTES de esta fecha no le figuren (ver filtro en routes/activities.js).
    const enrolledIn = role === 'student'
      ? await enrollStudentInDivisionCourses(req, user, divisionId, school, 'alta-alumno-con-curso')
      : 0;

    res.status(201).json({ user, enrolledIn, existedAlready: false });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
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
  const [createdCourses, joinedCourses, coTaughtCourses] = await Promise.all([
    Course.find({ owner:    target._id }).populate('owner', 'name email').populate('school', 'name').populate('division', 'name'),
    Course.find({ students: target._id }).populate('owner', 'name email').populate('school', 'name').populate('division', 'name'),
    // Materias donde es SUPLENTE. Iban por separado de las suyas como titular porque hasta
    // ahora no se mostraban en ningún lado: el perfil de un docente que solo era suplente
    // se veía idéntico al de uno sin ninguna materia.
    Course.find({ coTeachers: target._id }).populate('owner', 'name email').populate('school', 'name').populate('division', 'name'),
  ]);

  // Alcance del preceptor: la vista muestra el bloque de asignación de cursos solo si el
  // usuario ES preceptor. Se carga siempre que haya escuela para que, al cambiarle el rol
  // a preceptor desde esta misma pantalla, el bloque ya tenga las divisiones y no haya que
  // recargar. Sin esto, un usuario convertido a preceptor desde el listado quedaba sin
  // ningún lugar visible donde asignarle cursos.
  const schoolDivisions = target.school
    ? await Division.find({ school: target.school }).sort({ name: 1 }).select('_id name').lean()
    : [];

  // Materias de la escuela para el bloque "Materias que dicta" (espejo del bloque de
  // cursos del preceptor). Mismo criterio que allá: se carga siempre que haya escuela, no
  // solo si el usuario ya es docente, para que al cambiarle el rol a Docente desde esta
  // misma pantalla el bloque aparezca cargado sin tener que recargar.
  const schoolCourses = target.school
    ? await Course.find({ school: target.school })
        .populate('division', 'name')
        .sort({ name: 1 })
        .select('_id name division owner coTeachers')
        .lean()
    : [];

  res.render('admin/user-profile', {
    target, createdCourses, joinedCourses, coTaughtCourses, PROTECTED_ADMIN_EMAIL,
    schoolDivisions,
    assignedDivisionIds: (target.assignedDivisions || []).map(d => d.toString()),
    schoolCourses,
  });
});

// POST /users/:id/divisions — define el alcance de un preceptor (qué cursos ve/administra).
//
// Body: { allDivisions: Boolean, divisionIds: String[] }
// allDivisions:true ignora divisionIds y vacía el array: el alcance pasa a resolverse
// dinámicamente contra las divisiones de la escuela (ver middleware/preceptor.js), así que
// las divisiones que se creen después quedan incluidas sin tener que volver acá.
router.post('/users/:id/divisions', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (target.role !== 'preceptor') {
      return res.status(400).json({ error: 'Solo los preceptores tienen cursos a cargo' });
    }

    const todos = req.body.allDivisions === true;
    target.allDivisions      = todos;
    target.assignedDivisions = todos
      ? []
      : await resolveScopeDivisions(req.body.divisionIds, target.school);
    await target.save({ validateModifiedOnly: true });

    // El alcance se resuelve en cada request desde el doc cacheado (TTL 45s): sin
    // invalidar, el preceptor seguiría viendo los cursos viejos hasta que expire.
    invalidateUser(target._id);

    logAudit(req, 'user.assign_divisions',
      [{ type: 'user', id: target._id, name: target.name }],
      todos ? { alcance: 'todos los cursos' } : { cursos: target.assignedDivisions.length },
      { schoolId: target.school || null },
    );

    res.json({
      ok: true,
      allDivisions: target.allDivisions,
      count: target.assignedDivisions.length,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /users/:id/courses — matricula a un DOCENTE en varias materias de una sola pasada,
// desde su propio perfil. Es el espejo de /users/:id/divisions (el alcance del preceptor):
// hasta ahora al docente solo se lo podía matricular materia por materia, entrando a cada
// una — con 450 materias eso volvía impracticable cargar el horario de alguien que dicta
// ocho. Body: { courseIds: String[] } con la lista COMPLETA de materias deseadas.
//
// Siempre lo agrega como SUPLENTE (Course.coTeachers), nunca como titular: el titular es
// uno solo y pisarlo desde acá le sacaría la materia a otro docente sin avisar. Para
// cambiar al titular está el modal de /admin/courses o la solapa Personas de la materia.
//
// Las materias donde YA es titular se ignoran: vienen tildadas y bloqueadas en la vista,
// pero un POST armado a mano no debe poder destildarlas (quitarlo dejaría la materia sin
// docente). Desmarcar una materia donde es suplente sí lo saca.
router.post('/users/:id/courses', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (school && target.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (target.role !== 'teacher') {
      return res.status(400).json({ error: 'Solo los docentes pueden tener materias a cargo' });
    }
    if (target.active === false) {
      return res.status(400).json({ error: 'La cuenta está deshabilitada: habilitala antes de asignarle materias.' });
    }
    if (!target.school) {
      return res.status(400).json({ error: 'El docente no está asignado a ninguna escuela' });
    }

    // Se filtra contra las materias de SU escuela: un id de otra escuela armado a mano
    // se descarta acá, no se guarda para que después lo tenga que filtrar cada vista.
    const pedidas = Array.isArray(req.body.courseIds) ? req.body.courseIds : [];
    const validas = pedidas.length
      ? await Course.find({ _id: { $in: pedidas.filter(id => mongoose.Types.ObjectId.isValid(id)) }, school: target.school })
          .select('_id').lean()
      : [];
    const deseadas = new Set(validas.map(c => c._id.toString()));

    // Estado actual: dónde es titular (intocable) y dónde es suplente (lo que sí se edita).
    const [comoTitular, comoSuplente] = await Promise.all([
      Course.find({ school: target.school, owner: target._id }).select('_id').lean(),
      Course.find({ school: target.school, coTeachers: target._id }).select('_id').lean(),
    ]);
    const titulares = new Set(comoTitular.map(c => c._id.toString()));
    const suplencias = new Set(comoSuplente.map(c => c._id.toString()));

    const agregar = [...deseadas].filter(id => !titulares.has(id) && !suplencias.has(id));
    const quitar  = [...suplencias].filter(id => !deseadas.has(id));

    if (agregar.length) {
      await Course.updateMany({ _id: { $in: agregar } }, { $addToSet: { coTeachers: target._id } });
    }
    if (quitar.length) {
      await Course.updateMany({ _id: { $in: quitar } }, { $pull: { coTeachers: target._id } });
    }

    const suplenteFinal = suplencias.size + agregar.length - quitar.length;

    if (agregar.length || quitar.length) {
      logAudit(req, 'user.assign_courses',
        [{ type: 'user', id: target._id, name: target.name }],
        { agregadas: agregar.length, quitadas: quitar.length, total: titulares.size + suplenteFinal },
        { schoolId: target.school || null },
      );
    }

    res.json({
      ok: true,
      agregadas: agregar.length,
      quitadas:  quitar.length,
      titular:   titulares.size,
      suplente:  suplenteFinal,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
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
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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

    // Un docente titular no se puede borrar sin más: Course.owner quedaría apuntando a un
    // usuario inexistente y populate('owner') devuelve null, lo que rompía el listado de
    // /admin/courses con un 500 (pasó en producción con 2 materias de "Ciencias Naturales").
    // Las vistas ahora toleran el hueco, pero igual hay que reasignar antes de borrar: una
    // materia sin titular no tiene quién cargue actividades ni califique.
    const ownedCourses = await Course.countDocuments({ owner: req.params.id });
    if (ownedCourses > 0) {
      return res.status(409).json({
        error: `No se puede eliminar: es docente titular de ${ownedCourses} materia(s). Reasigná esas materias a otro docente y volvé a intentarlo.`,
      });
    }

    await User.findByIdAndDelete(req.params.id);
    // Acuses de lectura del usuario borrado. Si quedaran, el chip "N vieron" del docente
    // contaría a alguien que ya no está en el curso y podría mostrar más vistos que alumnos.
    await ActivityView.deleteMany({ student: req.params.id });
    // coTeachers y students son arrays: una referencia colgada no rompe el populate, pero
    // infla los contadores de alumnos y deja suplentes fantasma. Se limpian acá.
    await Course.updateMany(
      { $or: [{ coTeachers: req.params.id }, { students: req.params.id }] },
      { $pull: { coTeachers: req.params.id, students: req.params.id } },
    );
    invalidateUser(req.params.id);

    logAudit(req, 'user.delete',
      [{ type: 'user', id: target._id, name: target.name }],
      { rol: target.role, ...(target.email ? { email: target.email } : {}) },
      { schoolId: target.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Impersonation ─── */
router.post('/users/:id/impersonate', async (req, res) => {
  try {
    const school = res.locals.user.school;
    // Cada rechazo deja constancia del MOTIVO, no solo del código. Esta ruta era el punto
    // ciego más grande del proyecto: su `catch` respondía 500 sin loguear y sus cinco
    // validaciones devolvían 4xx en silencio, así que ante un "no me deja suplantar" no
    // había manera de saber cuál había saltado — tres de ellas comparten el código 400.
    const rechazar = (status, motivo) => {
      logRechazo(res, status, motivo, { destino: req.params.id });
      return res.status(status).json({ error: motivo });
    };

    const target = await User.findById(req.params.id);
    if (!target) return rechazar(404, 'Usuario no encontrado');
    if (target.email === PROTECTED_ADMIN_EMAIL || target.role === 'superadmin') {
      return rechazar(400, 'No puedes suplantar a este usuario');
    }
    if (target.active === false) {
      return rechazar(400, 'No podés suplantar a un usuario deshabilitado');
    }
    if (school && target.school?.toString() !== school.toString()) {
      return rechazar(403, 'Sin acceso');
    }
    if (req.params.id === req.userId) return rechazar(400, 'Ya eres este usuario');
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
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Courses (admin CRUD) ─── */

// Resuelve y valida al docente que se va a poner al frente de una materia.
//
// Punto de verdad único de las cuatro vías de matriculación: crear la materia, editarla,
// cambiar el titular y agregar un suplente. Antes cada una validaba distinto y la de
// editar (`POST /courses/:id/edit`) no validaba nada más que la existencia del id: aceptaba
// como titular a un alumno, a un preceptor o a un docente de otra escuela. La materia
// quedaba en manos de alguien que ni siquiera podía abrirla y en el listado figuraba con
// docente asignado, así que el problema no se veía hasta que el docente real reclamaba.
//
// `schoolId` es la escuela contra la que validar: la del admin, o la de la materia cuando
// quien opera es el superadmin (que no tiene escuela propia). Sin escuela de ningún lado
// no se valida pertenencia — es el caso de las materias viejas sin `school`.
//
// Devuelve { teacher } o { error } con el mensaje ya redactado para la respuesta.
async function resolveCourseTeacher(teacherId, schoolId) {
  if (!teacherId) return { error: 'Falta el docente' };
  if (!mongoose.Types.ObjectId.isValid(teacherId)) return { error: 'Docente no válido' };

  const teacher = await User.findById(teacherId).select('_id name email role school active');
  if (!teacher) return { error: 'Docente no válido' };

  if (teacher.role !== 'teacher') {
    return { error: `${teacher.name} tiene el rol ${ROLE_LABEL[teacher.role] || teacher.role}: solo un Docente puede estar a cargo de una materia.` };
  }
  if (schoolId && teacher.school?.toString() !== schoolId.toString()) {
    return { error: 'El docente no pertenece a esta institución' };
  }
  // Un docente deshabilitado no puede entrar, así que asignarlo deja la materia sin
  // docente real — y así la cuenta el tablero del directivo ("cursos sin docente").
  if (teacher.active === false) {
    return { error: `La cuenta de ${teacher.name} está deshabilitada: habilitala antes de asignarle materias.` };
  }
  return { teacher };
}

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
    // active: los deshabilitados no se ofrecen — resolveCourseTeacher los rechaza, así que
    // listarlos solo servía para que el admin eligiera y se comiera un error.
    User.find({ ...sf, role: 'teacher', active: { $ne: false } }).sort({ name: 1 }).select('_id name email'),
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
    // active: los deshabilitados no se ofrecen — resolveCourseTeacher los rechaza, así que
    // listarlos solo servía para que el admin eligiera y se comiera un error.
    User.find({ ...sf, role: 'teacher', active: { $ne: false } }).sort({ name: 1 }).select('_id name email'),
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
    const { teacher, error } = await resolveCourseTeacher(teacherId, school);
    if (error) return res.status(400).json({ error });

    const course = await Course.create({ name, room: room || '', division: division._id, owner: teacher._id, school });

    logAudit(req, 'course.create',
      [
        { type: 'course',   id: course._id,   name: course.name },
        { type: 'division', id: division._id, name: division.name },
        { type: 'user',     id: teacher._id,  name: teacher.name },
      ],
      {},
    );

    res.status(201).json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.get('/courses/:id/edit', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const course = await Course.findById(req.params.id).populate('division').populate('owner', 'name email').populate('coTeachers', 'name email');
  if (!course) return res.status(404).send('Materia no encontrada');
  if (school && course.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  const [divisions, teachers, subjects] = await Promise.all([
    Division.find(sf).sort({ name: 1 }),
    // active: los deshabilitados no se ofrecen — resolveCourseTeacher los rechaza, así que
    // listarlos solo servía para que el admin eligiera y se comiera un error.
    User.find({ ...sf, role: 'teacher', active: { $ne: false } }).sort({ name: 1 }).select('_id name email'),
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
      const { teacher, error } = await resolveCourseTeacher(teacherId, school || existing.school);
      if (error) return res.status(400).json({ error });
      updates.owner = teacher._id;
      // Si el nuevo titular ya figuraba como suplente hay que sacarlo de ahí, igual que en
      // /assign-teacher: si no, queda listado dos veces (como TITULAR y como SUPLENTE) en
      // la solapa Personas y en este mismo formulario.
      if ((existing.coTeachers || []).some(t => t.toString() === teacher._id.toString())) {
        updates.coTeachers = existing.coTeachers.filter(t => t.toString() !== teacher._id.toString());
      }
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
    logDeRuta(err, res);
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
    const { teacher, error } = await resolveCourseTeacher(req.body.teacherId, school || course.school);
    if (error) return res.status(400).json({ error });
    course.owner = teacher._id;
    // Si el nuevo titular ya figuraba como suplente, sacarlo de ahí: si no, queda listado
    // dos veces en la solapa Personas (como TITULAR y como SUPLENTE) y en el form de admin.
    if (course.coTeachers.some(t => t.toString() === teacher._id.toString())) {
      course.coTeachers = course.coTeachers.filter(t => t.toString() !== teacher._id.toString());
    }
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
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /admin/courses/:id/co-teachers — agrega un docente suplente (no reemplaza al
// titular, a diferencia de /assign-teacher). Para sacarlo, ver el /delete de abajo.
router.post('/courses/:id/co-teachers', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && course.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const { teacher, error } = await resolveCourseTeacher(req.body.teacherId, school || course.school);
    if (error) return res.status(400).json({ error });

    if (course.owner.toString() === teacher._id.toString()) {
      return res.status(400).json({ error: 'Ya es el docente titular de esta materia' });
    }
    if (course.coTeachers.some(t => t.toString() === teacher._id.toString())) {
      return res.status(400).json({ error: 'Ya es suplente de esta materia' });
    }

    course.coTeachers.push(teacher._id);
    await course.save({ validateModifiedOnly: true });

    logAudit(req, 'course.add_coteacher',
      [
        { type: 'course', id: course._id,  name: course.name },
        { type: 'user',   id: teacher._id, name: teacher.name },
      ],
      {},
      { schoolId: course.school || null },
    );

    res.json({ teacher: { _id: teacher._id, name: teacher.name, email: teacher.email } });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /admin/courses/:id/co-teachers/:teacherId/delete — saca un suplente de la materia.
// No toca al titular (para cambiarlo está /assign-teacher): quitar al owner dejaría la
// materia huérfana y la alerta del directivo la marcaría como "sin docente".
router.post('/courses/:id/co-teachers/:teacherId/delete', async (req, res) => {
  try {
    const school = res.locals.user.school;
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Materia no encontrada' });
    if (school && course.school?.toString() !== school.toString()) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const { teacherId } = req.params;
    if (!course.coTeachers.some(t => t.toString() === teacherId)) {
      return res.status(404).json({ error: 'Ese docente no es suplente de esta materia' });
    }

    course.coTeachers = course.coTeachers.filter(t => t.toString() !== teacherId);
    await course.save({ validateModifiedOnly: true });

    const teacher = await User.findById(teacherId).select('name');

    logAudit(req, 'course.remove_coteacher',
      [
        { type: 'course', id: course._id, name: course.name },
        { type: 'user',   id: teacherId,  name: teacher?.name || 'Docente' },
      ],
      {},
      { schoolId: course.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
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

    // Si la materia estaba elegida suelta en alguna sección, se la saca de ahí. Las
    // secciones que la incluían por su división entera no se tocan: siguen bien.
    await Section.updateMany({ courses: course._id }, { $pull: { courses: course._id } });

    logAudit(req, 'course.delete',
      [{ type: 'course', id: course._id, name: course.name }],
      { alumnos: (course.students || []).length },
      { schoolId: course.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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

    // La división puede estar dentro de una o más secciones (models/Section.js). Dejarla
    // colgada no rompe el alcance —se resuelve con un find() que ya no la devuelve— pero
    // la sección acumularía ids muertos y el contador de la pantalla mentiría.
    await Section.updateMany({ divisions: division._id }, { $pull: { divisions: division._id } });

    logAudit(req, 'division.delete',
      [{ type: 'division', id: division._id, name: division.name }],
      {},
      { schoolId: division.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Secciones (alcance del rol Jefe de Sección) ─────────────────────────────
   Una Sección es un recorte del establecimiento con nombre: mezcla divisiones ENTERAS con
   materias sueltas, y tiene uno o más jefes. Ver models/Section.js para el porqué de la
   forma; acá solo está el CRUD.

   OJO con la palabra: estas Secciones son datos de la escuela. Las "secciones" de
   config/sections.js y del sectionGuard de arriba son las SOLAPAS del panel. No se tocan
   entre sí.                                                                              */

// Filtra una lista de ids dejando solo los que existen y son de `school`. Mismo criterio y
// mismo motivo que resolveScopeDivisions: sin esto, un POST armado a mano podría meter
// materias de otra escuela dentro de una sección y el jefe las vería.
async function resolveDeLaEscuela(Model, ids, school, extraFiltro = {}) {
  if (!Array.isArray(ids) || !ids.length || !school) return [];
  const validos = await Model.find({ _id: { $in: ids.filter(mongoose.isValidObjectId) }, school, ...extraFiltro })
    .select('_id').lean();
  return validos.map(d => d._id);
}

// Cuántas materias abarca realmente una sección, con el mismo criterio que usa el panel del
// jefe: las materias de sus divisiones enteras MÁS las sueltas, sin contar dos veces una
// materia que esté por los dos caminos.
async function materiasDeSeccion(seccion, school) {
  if (!seccion.divisions.length && !seccion.courses.length) return 0;
  return Course.countDocuments({
    school,
    $or: [
      { division: { $in: seccion.divisions } },
      { _id: { $in: seccion.courses } },
    ],
  });
}

router.get('/secciones', async (req, res) => {
  const school = res.locals.user.school;
  const sf     = school ? { school } : {};
  const { search } = req.query;
  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };

  const secciones = await Section.find(filter)
    .populate('divisions', 'name')
    .populate('heads', 'name email active')
    .sort({ name: 1 })
    .lean();

  const filas = await Promise.all(secciones.map(async (s) => ({
    ...s,
    materias: await materiasDeSeccion(s, school),
  })));

  res.render('admin/sections', { secciones: filas, search: search || '' });
});

// El formulario de alta y el de edición son la misma vista. Las dos ramas cargan el árbol
// completo de divisiones y materias de la escuela: son ~40 y ~420 documentos, chico como
// para mandarlo entero y armar el acordeón del lado del navegador.
async function datosFormularioSeccion(school) {
  const [divisiones, materias, jefes] = await Promise.all([
    Division.find({ school }).sort({ name: 1 }).select('_id name').lean(),
    Course.find({ school }).sort({ name: 1 }).select('_id name division').lean(),
    // Solo usuarios con el rol: asignar como jefe a alguien que no lo es le dejaría el
    // alcance guardado sin poder entrar nunca al panel.
    User.find({ school, role: 'jefe' }).sort({ name: 1 }).select('_id name email active').lean(),
  ]);
  return {
    divisiones: divisiones.map(d => ({ id: d._id.toString(), nombre: d.name })),
    materias:   materias.map(c => ({ id: c._id.toString(), nombre: c.name, division: c.division?.toString() || '' })),
    jefes:      jefes.map(u => ({ id: u._id.toString(), nombre: u.name, email: u.email, activo: u.active !== false })),
  };
}

router.get('/secciones/create', async (req, res) => {
  const school = res.locals.user.school;
  if (!school) return res.status(400).send('Sin escuela asignada');
  res.render('admin/section-form', { seccion: null, ...await datosFormularioSeccion(school) });
});

router.get('/secciones/:id/edit', async (req, res) => {
  const school  = res.locals.user.school;
  const seccion = await Section.findById(req.params.id).lean();
  if (!seccion) return res.status(404).send('Sección no encontrada');
  if (school && seccion.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  res.render('admin/section-form', {
    seccion: {
      ...seccion,
      divisions: seccion.divisions.map(String),
      courses:   seccion.courses.map(String),
      heads:     seccion.heads.map(String),
    },
    ...await datosFormularioSeccion(school),
  });
});

// Deja el body en la forma que se guarda, validando las tres listas contra la escuela.
// Devuelve un string con el error si algo no cierra, o null si está todo bien.
async function armarSeccion(body, school) {
  const divisions = await resolveDeLaEscuela(Division, body.divisionIds, school);
  const courses   = await resolveDeLaEscuela(Course,   body.courseIds,   school);
  const heads     = await resolveDeLaEscuela(User,     body.headIds,     school, { role: 'jefe' });

  // Que la sección quede vacía no se bloquea: el admin puede querer crearla y llenarla
  // después. La pantalla avisa en ámbar, y el jefe ve la pantalla de "sin alcance".
  if (Array.isArray(body.headIds) && body.headIds.length !== heads.length) {
    return { error: 'Alguno de los jefes elegidos no existe, no es de esta escuela o ya no tiene el rol Jefe de Sección.' };
  }
  return { datos: { name: (body.name || '').trim(), divisions, courses, heads } };
}

router.post('/secciones/create', async (req, res) => {
  try {
    const school = res.locals.user.school;
    if (!school) return res.status(400).json({ error: 'Sin escuela asignada' });

    const { datos, error } = await armarSeccion(req.body, school);
    if (error) return res.status(400).json({ error });

    const seccion = await Section.create({ ...datos, school });

    logAudit(req, 'section.create',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      { cursos: seccion.divisions.length, materias: seccion.courses.length, jefes: seccion.heads.length },
    );

    res.status(201).json({ seccion });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una sección con ese nombre en esta escuela' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/secciones/:id/edit', async (req, res) => {
  try {
    const school   = res.locals.user.school;
    const existing = await Section.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sección no encontrada' });
    if (school && existing.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });

    const { datos, error } = await armarSeccion(req.body, school);
    if (error) return res.status(400).json({ error });

    const seccion = await Section.findByIdAndUpdate(req.params.id, datos, { new: true, runValidators: true });

    // No hace falta invalidateUser: los jefes se resuelven leyendo Section en cada request
    // (middleware/jefatura.js), no desde el doc de usuario cacheado. El cambio se ve ya.
    logAudit(req, 'section.edit',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      {
        ...(existing.name !== seccion.name ? { de: existing.name, a: seccion.name } : {}),
        cursos: seccion.divisions.length, materias: seccion.courses.length, jefes: seccion.heads.length,
      },
      { schoolId: existing.school || null },
    );

    res.json({ seccion });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una sección con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Sin guarda referencial a propósito: borrar una sección no destruye ningún dato de la
// escuela, solo les saca el alcance a sus jefes. La vista lo dice en el confirm().
router.post('/secciones/:id/delete', async (req, res) => {
  try {
    const school  = res.locals.user.school;
    const seccion = await Section.findById(req.params.id);
    if (!seccion) return res.status(404).json({ error: 'Sección no encontrada' });
    if (school && seccion.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });

    await Section.findByIdAndDelete(req.params.id);

    logAudit(req, 'section.delete',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      { jefes: seccion.heads.length },
      { schoolId: seccion.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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
    logDeRuta(err, res);
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
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Import ─── */
router.get('/import', async (req, res) => {
  const school = res.locals.user.school;
  const sf = school ? { school } : {};
  const [teachers, subjects] = await Promise.all([
    User.find({ ...sf, role: 'teacher' }).sort({ name: 1 }).select('_id name email role'),
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
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Plantillas de tareas ofrecidas a la escuela ─── */
// Fase 4 del gestor de plantillas. Mismo patrón que /admin/theme:
// el admin ve lo que le fue OFRECIDO por el superadmin y decide aceptar o rechazar.
// La lista incluye ofrecidas, aceptadas y rechazadas — todas las que llegaron
// alguna vez. Si el superadmin revoca, el doc se borra y desaparece de la lista.
router.get('/task-templates', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!res.locals.taskTemplatesEnabled) return res.status(404).send('No disponible');
    const schoolId = res.locals.user.school;
    if (!schoolId) return res.status(400).send('Este usuario no tiene escuela asignada');

    const assignments = await TemplateAssignment.find({ school: schoolId })
      .populate('template', 'title description questions defaultPoints updatedAt status')
      .sort({ updatedAt: -1 })
      .lean();

    // Filtro plantillas que quedaron sin template (borradas por superadmin — no debería
    // pasar por la guarda de DELETE, pero por defensa igual filtramos).
    const rows = assignments.filter(a => a.template);
    res.render('admin/task-templates/index', { assignments: rows, activePage: 'task-templates' });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /admin/task-templates/respond — el admin acepta o rechaza una oferta.
// Body: { templateId, action: 'accept' | 'reject' }. Actualiza status y registra
// respondedBy + respondedAt. Solo válido sobre TemplateAssignment de la propia escuela.
router.post('/task-templates/respond', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!res.locals.taskTemplatesEnabled) return res.status(404).json({ error: 'No disponible' });
    const { templateId, action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida' });
    }
    const status = action === 'accept' ? 'accepted' : 'rejected';
    const schoolId = res.locals.user.school;

    const a = await TemplateAssignment.findOneAndUpdate(
      { template: templateId, school: schoolId },
      { $set: { status, respondedBy: req.userId, respondedAt: new Date() } },
      { new: true },
    ).populate('template', 'title');
    if (!a) return res.status(404).json({ error: 'Esta plantilla no está ofrecida a tu escuela' });

    logAudit(req, action === 'accept' ? 'task_template.accept' : 'task_template.reject',
      [{ type: 'task_template', id: a.template._id, name: a.template.title }],
    );
    res.json({ assignment: a });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Tareas: ajustes de la escuela ─── */
// Solapa donde el admin configura el comportamiento de las actividades para toda su
// escuela. Hoy tiene un solo ajuste (el aviso del acuse de lectura), pero es el lugar
// previsto para los que vengan: por eso la vista itera sobre school.settings y no
// hardcodea un único checkbox suelto.
router.get('/tasks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const school = await School.findById(res.locals.user.school).select('name settings');
    if (!school) return res.status(404).send('Escuela no encontrada');
    res.render('admin/tasks/index', { school, activePage: 'tasks' });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /admin/tasks/settings — guarda un ajuste de la escuela.
// Body: { key, value }. La key se valida contra una lista blanca y el value se castea a
// booleano: nunca se persiste el body crudo (mismo criterio que buildConfig() en superadmin).
const TASK_SETTINGS = ['showViewReceiptToStudents'];

router.post('/tasks/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!TASK_SETTINGS.includes(key)) return res.status(400).json({ error: 'Ajuste inválido' });

    const boolValue = value === true || value === 'true';
    const schoolId  = res.locals.user.school;
    if (!schoolId) return res.status(400).json({ error: 'Este usuario no tiene escuela asignada' });

    const school = await School.findByIdAndUpdate(
      schoolId,
      { $set: { [`settings.${key}`]: boolValue } },
      { new: true },
    ).select('name settings');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    // Obligatorio: res.locals.school va cacheado 5 min por worker (ver server.js).
    // Sin esto el admin guarda, recarga y sigue viendo el valor viejo.
    invalidateSchool(schoolId);

    logAudit(req, 'school.settings_update',
      [{ type: 'school', id: school._id, name: school.name }],
      { ajuste: key, valor: boolValue },
    );
    res.json({ ok: true, settings: school.settings });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
