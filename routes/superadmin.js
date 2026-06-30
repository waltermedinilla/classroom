const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const os      = require('os');
const School  = require('../models/School');
const User    = require('../models/User');
const Course  = require('../models/Course');
const Subject    = require('../models/Subject');
const Suggestion = require('../models/Suggestion');
const THEMES     = require('../config/themes');
const { requireAuth }      = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superadmin');

// Multer en memoria para importación Excel (no necesita guardarse en disco)
const xlsUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xls|xlsx)$/i.test(file.originalname);
    ok ? cb(null, true) : cb(new Error('Solo archivos .xls o .xlsx'));
  },
});

const router = express.Router();
// Todos los endpoints requieren login Y rol superadmin (sin filtro de escuela)
router.use(requireAuth, requireSuperAdmin);

/* ─── Dashboard ─── */
// GET /superadmin — Estadísticas globales de la plataforma (todas las escuelas)
// Retorna conteos totales + lista de escuelas con sus propios conteos de usuarios y cursos
router.get('/', async (req, res) => {
  try {
    const [schoolCount, userCount, courseCount] = await Promise.all([
      School.countDocuments(),
      User.countDocuments(),
      Course.countDocuments(),
    ]);
    const schools = await School.find().sort({ name: 1 });

    // Para cada escuela: cuenta usuarios y cursos asociados (en paralelo)
    const schoolsWithStats = await Promise.all(
      schools.map(async (s) => {
        const [users, courses] = await Promise.all([
          User.countDocuments({ school: s._id }),
          Course.countDocuments({ school: s._id }),
        ]);
        return { ...s.toObject(), userCount: users, courseCount: courses };
      })
    );
    res.render('superadmin/dashboard', { schoolCount, userCount, courseCount, schools: schoolsWithStats });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Schools ─── */
// GET /superadmin/schools — Lista todas las escuelas con conteo de usuarios y cursos
router.get('/schools', async (req, res) => {
  try {
    const { search } = req.query;
    const filter = search ? { name: { $regex: search, $options: 'i' } } : {};
    const schools = await School.find(filter).sort({ name: 1 });
    const schoolsWithStats = await Promise.all(
      schools.map(async (s) => {
        const [users, courses] = await Promise.all([
          User.countDocuments({ school: s._id }),
          Course.countDocuments({ school: s._id }),
        ]);
        return { ...s.toObject(), userCount: users, courseCount: courses };
      })
    );
    res.render('superadmin/schools', { schools: schoolsWithStats, search: search || '' });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

router.get('/schools/create', (req, res) => {
  res.render('superadmin/school-form', { school: null });
});

// POST /superadmin/schools/create — Crea una nueva escuela
// El slug se genera automáticamente por el hook pre-validate del model School
router.post('/schools/create', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const school = await School.create({ name, description, color });
    res.status(201).json({ school });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una escuela con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /superadmin/schools/:id — Perfil completo de una escuela: stats, usuarios, cursos, materias
// Carga todos los datos de una vez; los tabs se muestran/ocultan en el cliente
router.get('/schools/:id', async (req, res) => {
  try {
    const school = await School.findById(req.params.id);
    if (!school) return res.status(404).send('Escuela no encontrada');

    const [users, courses, subjects] = await Promise.all([
      User.find({ school: school._id }).sort({ createdAt: -1 }),
      Course.find({ school: school._id }).populate('owner', 'name email').populate('division', 'name').sort({ name: 1 }),
      Subject.find({ school: school._id }).sort({ name: 1 }),
    ]);

    // Conteo de usuarios por rol para las tarjetas de resumen
    const ROLES = ['admin', 'directivo', 'teacher', 'preceptor', 'soe', 'student'];
    const roleCounts = {};
    ROLES.forEach(r => { roleCounts[r] = 0; });
    users.forEach(u => { if (roleCounts[u.role] !== undefined) roleCounts[u.role]++; });

    // baseUrl se pasa a la vista para construir la URL del enlace de invitación
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.render('superadmin/school-profile', { school, users, courses, subjects, roleCounts, baseUrl });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

router.get('/schools/:id/edit', async (req, res) => {
  const school = await School.findById(req.params.id);
  if (!school) return res.status(404).send('Escuela no encontrada');
  res.render('superadmin/school-form', { school });
});

router.post('/schools/:id/edit', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    const school = await School.findByIdAndUpdate(
      req.params.id, { name, description, color },
      { new: true, runValidators: true }
    );
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });
    res.json({ school });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una escuela con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/schools/:id/delete', async (req, res) => {
  try {
    await School.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/schools/:id/invite — genera o regenera el token de invitación de la escuela
// Cualquier token previo queda inválido automáticamente al sobreescribirse
// Retorna { inviteUrl } con la URL completa lista para compartir
router.post('/schools/:id/invite', async (req, res) => {
  try {
    const crypto = require('crypto');
    const school = await School.findById(req.params.id);
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });
    school.inviteToken = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    await school.save();
    const inviteUrl = `${req.protocol}://${req.get('host')}/register/invite/${school.inviteToken}`;
    res.json({ inviteUrl });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/schools/:id/revoke-invite — elimina el token (el enlace queda inválido)
// Los usuarios que intenten usar el enlace antiguo verán pantalla de error
router.post('/schools/:id/revoke-invite', async (req, res) => {
  try {
    const school = await School.findById(req.params.id);
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });
    school.inviteToken = null;
    await school.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Users ─── */
// GET /superadmin/users/create — Formulario de creación de usuario (sin restricción de escuela)
router.get('/users/create', async (req, res) => {
  try {
    const schools = await School.find().sort({ name: 1 }).select('_id name');
    res.render('superadmin/user-form', { schools });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// POST /superadmin/users/create — Crea un usuario con cualquier rol y escuela (incluido superadmin)
router.post('/users/create', async (req, res) => {
  try {
    const { name, email, password, role, school, dni } = req.body;
    const userData = { name, email, password, role, school: school || null };
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

// GET /superadmin/users — Lista paginada de TODOS los usuarios con filtros avanzados
// Query: ?role=teacher&search=Juan&schoolId=none&active=true&page=2&limit=25
// schoolId=none → busca usuarios sin escuela (filter.school = null)
// schoolId=<ObjectId> → busca usuarios de esa escuela
// Retorna a la vista: users, schools, total, page, pages, limit, currentRole, search, currentSchool, currentActive
router.get('/users', async (req, res) => {
  try {
    const { role, search, schoolId, active, page = '1', limit: limitQ = '25' } = req.query;
    const filter = {};

    if (role)             filter.role   = role;
    // schoolId="none" significa "sin escuela asignada"; pasarlo como string a Mongo causaría un cast error
    if (schoolId === 'none') filter.school = null;
    else if (schoolId)   filter.school   = schoolId;
    if (active === 'true')  filter.active = true;
    else if (active === 'false') filter.active = false;
    if (search) filter.$or = [
      { name:  { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];

    // Limita los valores de paginación a opciones válidas (evita queries con limit arbitrario)
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const limitNum = [10, 25, 50, 100].includes(parseInt(limitQ)) ? parseInt(limitQ) : 25;
    const skip     = (pageNum - 1) * limitNum;

    const [users, total, schools] = await Promise.all([
      User.find(filter).populate('school', 'name color').sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      User.countDocuments(filter), // Total sin paginar (para calcular páginas)
      School.find().sort({ name: 1 }).select('_id name'), // Para el filtro de escuela en la vista
    ]);

    const pages = Math.ceil(total / limitNum) || 1; // Al menos 1 página aunque no haya resultados

    res.render('superadmin/users', {
      users, schools, total,
      currentRole:   role     || '',
      search:        search   || '',
      currentSchool: schoolId || '',
      currentActive: active   || '',
      page: pageNum,
      pages,
      limit: limitNum,
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Bulk actions ─── */
// POST /superadmin/users/bulk-school — Asigna una escuela a múltiples usuarios a la vez
// Body: { userIds: string[], schoolId: string | "" }
// schoolId="" → desasigna la escuela (school = null)
router.post('/users/bulk-school', async (req, res) => {
  try {
    const { userIds, schoolId } = req.body;
    if (!Array.isArray(userIds) || !userIds.length)
      return res.status(400).json({ error: 'No se especificaron usuarios' });
    await User.updateMany({ _id: { $in: userIds } }, { school: schoolId || null });
    res.json({ ok: true, updated: userIds.length });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/users/bulk-role — Cambia el rol de múltiples usuarios a la vez
// Body: { userIds: string[], role: string }
// Protección: excluye el propio userId del superadmin para que no pueda cambiarse el rol a sí mismo
router.post('/users/bulk-role', async (req, res) => {
  try {
    const { userIds, role } = req.body;
    if (!Array.isArray(userIds) || !userIds.length)
      return res.status(400).json({ error: 'No se especificaron usuarios' });
    if (!role) return res.status(400).json({ error: 'Rol no especificado' });

    // Filtra el propio userId para evitar auto-cambio de rol en operaciones masivas
    const filtered = userIds.filter(id => id !== req.userId);
    if (!filtered.length) return res.status(400).json({ error: 'No podés cambiar tu propio rol en lote' });

    await User.updateMany({ _id: { $in: filtered } }, { role });
    res.json({ ok: true, updated: filtered.length });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Assign school to user ─── */
// POST /superadmin/users/:id/school — Mueve un usuario a una escuela diferente
// Body: { schoolId: string | "" }
// Error 11000 puede ocurrir si el DNI del usuario ya está registrado en la escuela destino
router.post('/users/:id/school', async (req, res) => {
  try {
    const { schoolId } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { school: schoolId || null },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese DNI en la escuela destino' });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Assign role to user ─── */
// POST /superadmin/users/:id/role — Cambia el rol de un usuario individualmente
// El superadmin puede asignar cualquier rol, incluso superadmin
// No puede cambiarse el rol a sí mismo
router.post('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (req.params.id === req.userId) {
      return res.status(400).json({ error: 'No puedes cambiar tu propio rol' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true, runValidators: true });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Import ─── */
// GET /superadmin/import — Vista de importación masiva (el superadmin puede elegir la escuela destino)
router.get('/import', async (req, res) => {
  try {
    const schools = await School.find().sort({ name: 1 }).select('_id name color');
    res.render('superadmin/import', { schools });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// GET /superadmin/import/template — Descarga una plantilla Excel de ejemplo
// Contiene tres hojas: Usuarios, Materias, Cursos con datos de ejemplo
router.get('/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['nombre', 'dni', 'email', 'contraseña', 'rol'],
    ['Juan Pérez',   '28456789', 'jperez@escuela.edu.ar',  '28456789', 'teacher'],
    ['Ana García',   '35123456', 'agarcia@escuela.edu.ar', '35123456', 'student'],
    ['Carlos López', '22987654', 'clopez@escuela.edu.ar',  '22987654', 'preceptor'],
  ]), 'Usuarios');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['nombre', 'descripcion', 'color'],
    ['Matemáticas',         'Álgebra y geometría',       '#1a73e8'],
    ['Lengua y Literatura', 'Gramática y comprensión',   '#34a853'],
    ['Historia',            'Historia nacional',          '#ea4335'],
  ]), 'Materias');

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['nombre', 'seccion', 'materia', 'aula', 'email_docente'],
    ['Matemáticas 1A', '1A', 'Matemáticas',         '101', 'jperez@escuela.edu.ar'],
    ['Lengua 2B',      '2B', 'Lengua y Literatura',  '203', 'jperez@escuela.edu.ar'],
  ]), 'Cursos');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-importacion.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// POST /superadmin/import/upload — Parsea el Excel de importación del superadmin
// Detecta las hojas "Usuarios", "Materias", "Cursos" (insensible a mayúsculas)
// Retorna: { usuarios, materias, cursos, warnings } como preview antes de confirmar
router.post('/import/upload', xlsUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });

    const result = { usuarios: [], materias: [], cursos: [], warnings: [] };

    // Busca una hoja por nombre (case-insensitive)
    const findSheet = (name) => wb.SheetNames.find(s => s.toLowerCase() === name);

    // Hoja Usuarios: campos nombre, dni, email, contraseña/password, rol
    const usuariosSheet = findSheet('usuarios');
    if (usuariosSheet) {
      XLSX.utils.sheet_to_json(wb.Sheets[usuariosSheet]).forEach((r, i) => {
        const nombre   = r['nombre']?.toString().trim();
        const email    = r['email']?.toString().trim().toLowerCase() || '';
        // Acepta "contraseña", "contrasena" o "password" como nombre de columna
        const password = (r['contraseña'] ?? r['contrasena'] ?? r['password'])?.toString().trim();
        const rol      = r['rol']?.toString().trim() || 'student';
        const dni      = r['dni']?.toString().replace(/\D/g, '').trim() || ''; // Elimina caracteres no numéricos
        if (!nombre || !password || (!email && !dni)) {
          result.warnings.push(`Usuarios fila ${i + 2}: faltan campos requeridos (nombre, contraseña y email o dni)`);
          return;
        }
        result.usuarios.push({ nombre, email, password, rol, dni });
      });
    }

    // Hoja Materias: campos nombre, descripcion, color
    const materiasSheet = findSheet('materias');
    if (materiasSheet) {
      XLSX.utils.sheet_to_json(wb.Sheets[materiasSheet]).forEach((r, i) => {
        const nombre = r['nombre']?.toString().trim();
        if (!nombre) { result.warnings.push(`Materias fila ${i + 2}: falta el nombre`); return; }
        result.materias.push({
          nombre,
          descripcion: r['descripcion']?.toString().trim() || '',
          color:       r['color']?.toString().trim()       || '#1a73e8',
        });
      });
    }

    // Hoja Cursos: campos nombre, seccion, materia, aula, email_docente
    const cursosSheet = findSheet('cursos');
    if (cursosSheet) {
      XLSX.utils.sheet_to_json(wb.Sheets[cursosSheet]).forEach((r, i) => {
        const nombre = r['nombre']?.toString().trim();
        if (!nombre) { result.warnings.push(`Cursos fila ${i + 2}: falta el nombre`); return; }
        result.cursos.push({
          nombre,
          seccion:       r['seccion']?.toString().trim()                   || '',
          materia:       r['materia']?.toString().trim()                   || '',
          aula:          r['aula']?.toString().trim()                      || '',
          email_docente: r['email_docente']?.toString().trim().toLowerCase() || '',
        });
      });
    }

    if (!result.usuarios.length && !result.materias.length && !result.cursos.length) {
      return res.status(400).json({ error: 'No se encontraron datos. Verificá que el archivo tenga las hojas "Usuarios", "Materias" y/o "Cursos".' });
    }

    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'No se pudo leer el archivo: ' + err.message });
  }
});

// POST /superadmin/import/execute — Ejecuta la importación para una escuela específica
// Body: { schoolId, importUsuarios, importMaterias, importCursos, usuarios, materias, cursos }
// Proceso: 1) Usuarios → 2) Resolver docentes para cursos → 3) Materias → 4) Cursos
router.post('/import/execute', async (req, res) => {
  try {
    const { schoolId, importUsuarios, importMaterias, importCursos, usuarios, materias, cursos } = req.body;
    if (!schoolId) return res.status(400).json({ error: 'Escuela no especificada' });

    const results = {
      usuarios: { created: 0, skipped: 0 },
      materias: { created: 0, skipped: 0 },
      cursos:   { created: 0, skipped: 0 },
    };

    // userEmailMap: email o "dni:{dni}" → userId; se construye al crear/resolver cada usuario
    // Se usa después para asignar docentes a cursos
    const userEmailMap = {};

    // Busca un usuario existente: primero por school+DNI, después por email global
    const resolveUser = async (u) => {
      if (u.dni && schoolId) {
        const byDni = await User.findOne({ school: schoolId, dni: u.dni }).select('_id email');
        if (byDni) return byDni;
      }
      if (u.email) {
        return await User.findOne({ email: u.email }).select('_id email');
      }
      return null;
    };

    // 1. Crear/resolver usuarios
    if (importUsuarios && usuarios?.length) {
      for (const u of usuarios) {
        try {
          const userData = { name: u.nombre, password: u.password, role: u.rol, school: schoolId };
          if (u.email) userData.email = u.email;
          if (u.dni)   userData.dni   = u.dni;
          const user = await User.create(userData);
          // Indexa por email Y por "dni:{dni}" para que los cursos puedan resolverlo por cualquiera
          if (u.email) userEmailMap[u.email]           = user._id;
          if (u.dni)   userEmailMap[`dni:${u.dni}`]    = user._id;
          results.usuarios.created++;
        } catch {
          // Ya existe: lo resuelve y lo mapea igual para que los cursos puedan usarlo
          const existing = await resolveUser(u);
          if (existing) {
            if (u.email) userEmailMap[u.email]        = existing._id;
            if (u.dni)   userEmailMap[`dni:${u.dni}`] = existing._id;
          }
          results.usuarios.skipped++;
        }
      }
    }

    // Resolver docentes para cursos aunque no se importen usuarios
    // (el docente puede ya existir en el sistema)
    if (cursos?.length) {
      const emails = [...new Set(cursos.map(c => c.email_docente).filter(Boolean))];
      for (const email of emails) {
        if (!userEmailMap[email]) {
          const existing = await User.findOne({ email }).select('_id');
          if (existing) userEmailMap[email] = existing._id;
        }
      }
    }

    // 2. Crear materias (evita duplicados por nombre+escuela)
    if (importMaterias && materias?.length) {
      for (const m of materias) {
        try {
          const exists = await Subject.findOne({ name: m.nombre, school: schoolId });
          if (!exists) {
            await Subject.create({ name: m.nombre, description: m.descripcion, color: m.color, school: schoolId });
            results.materias.created++;
          } else {
            results.materias.skipped++;
          }
        } catch { results.materias.skipped++; }
      }
    }

    // 3. Crear cursos (el docente debe estar en userEmailMap para asignarlo como owner)
    if (importCursos && cursos?.length) {
      for (const c of cursos) {
        const teacherId = userEmailMap[c.email_docente];
        if (!teacherId) { results.cursos.skipped++; continue; } // Sin docente: no se puede crear
        try {
          await Course.create({ name: c.nombre, section: c.seccion, subject: c.materia, room: c.aula, owner: teacherId, school: schoolId });
          results.cursos.created++;
        } catch { results.cursos.skipped++; }
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor: ' + err.message });
  }
});

/* ─── Temas ─── */
router.get('/themes', async (req, res) => {
  const schools = await School.find().sort({ name: 1 }).select('name color themes');
  res.render('superadmin/themes', { THEMES, schools, activePage: 'themes' });
});

// Ofrecer o actualizar un tema para una escuela (con config completa y fechas)
router.post('/themes/offer', async (req, res) => {
  try {
    const { schoolId, slug, startDate, endDate, config } = req.body;
    if (!THEMES[slug]) return res.status(400).json({ error: 'Tema no válido' });
    const school = await School.findById(schoolId);
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    const existing = school.themes.find(t => t.slug === slug);
    if (existing) {
      // Actualizar el tema existente (puede estar offered/accepted/rejected)
      existing.status    = 'offered';
      existing.offeredBy = res.locals.user._id;
      existing.startDate = startDate || THEMES[slug].defaultStart || null;
      existing.endDate   = endDate   || THEMES[slug].defaultEnd   || null;
      existing.config    = buildConfig(slug, config);
    } else {
      school.themes.push({
        slug,
        status:    'offered',
        offeredBy: res.locals.user._id,
        startDate: startDate || THEMES[slug].defaultStart || null,
        endDate:   endDate   || THEMES[slug].defaultEnd   || null,
        config:    buildConfig(slug, config),
      });
    }
    await school.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Actualizar configuración de un tema ya ofrecido/aceptado
router.post('/themes/config', async (req, res) => {
  try {
    const { schoolId, slug, startDate, endDate, config } = req.body;
    const school = await School.findById(schoolId);
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });
    const t = school.themes.find(t => t.slug === slug);
    if (!t) return res.status(404).json({ error: 'Tema no encontrado en esta escuela' });
    if (startDate) t.startDate = startDate;
    if (endDate)   t.endDate   = endDate;
    t.config = buildConfig(slug, config);
    await school.save();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Revocar (eliminar) un tema de una escuela
router.post('/themes/revoke', async (req, res) => {
  try {
    const { schoolId, slug } = req.body;
    await School.findByIdAndUpdate(schoolId, {
      $pull: { themes: { slug } },
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Construye el objeto config a partir del body, usando defaults del catálogo
function buildConfig(slug, rawConfig = {}) {
  const theme = THEMES[slug];
  const cfg = {};
  Object.entries(theme.features).forEach(([key, feat]) => {
    cfg[key] = { enabled: rawConfig[key]?.enabled !== false };
    Object.entries(feat.params || {}).forEach(([p, def]) => {
      let val = rawConfig[key]?.[p];
      if (val === undefined || val === '') val = def.default;
      if (def.type === 'range') val = Math.min(def.max, Math.max(def.min, parseInt(val) || def.default));
      if (def.type === 'select') val = def.options.includes(val) ? val : def.default;
      cfg[key][p] = val;
    });
  });
  return cfg;
}

/* ─── Monitor del sistema ─── */
router.get('/monitor', (req, res) => {
  res.render('superadmin/monitor', { activePage: 'monitor' });
});

router.get('/monitor/stats', async (req, res) => {
  try {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
    const [activeUsers, totalUsers, totalSchools] = await Promise.all([
      User.countDocuments({ lastSeen: { $gte: fifteenMinAgo } }),
      User.countDocuments(),
      School.countDocuments(),
    ]);

    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const heap     = process.memoryUsage();
    const loadavg  = os.loadavg();
    const cpuCount = os.cpus().length;

    res.json({
      users:   { active: activeUsers, total: totalUsers },
      schools: totalSchools,
      memory: {
        used:    Math.round((totalMem - freeMem) / 1024 / 1024),
        total:   Math.round(totalMem / 1024 / 1024),
        free:    Math.round(freeMem / 1024 / 1024),
        percent: Math.round((totalMem - freeMem) / totalMem * 100),
      },
      heap: {
        used:  Math.round(heap.heapUsed / 1024 / 1024),
        total: Math.round(heap.heapTotal / 1024 / 1024),
        rss:   Math.round(heap.rss / 1024 / 1024),
      },
      load: {
        avg1:    Math.round(loadavg[0] * 100) / 100,
        avg5:    Math.round(loadavg[1] * 100) / 100,
        avg15:   Math.round(loadavg[2] * 100) / 100,
        cpus:    cpuCount,
        percent: Math.min(100, Math.round((loadavg[0] / cpuCount) * 100)),
      },
      uptime: {
        process: Math.round(process.uptime()),
        system:  Math.round(os.uptime()),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Sugerencias ─── */
router.get('/suggestions', async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const filter = status !== 'all' ? { status } : {};
    const [suggestions, pendingCount] = await Promise.all([
      Suggestion.find(filter)
        .populate('user', 'name email role')
        .populate('school', 'name color')
        .sort({ createdAt: -1 }),
      Suggestion.countDocuments({ status: 'pending' }),
    ]);
    res.render('superadmin/suggestions', { suggestions, pendingCount, status, activePage: 'suggestions' });
  } catch {
    res.status(500).send('Error del servidor');
  }
});

router.post('/suggestions/:id/reviewed', async (req, res) => {
  try {
    await Suggestion.findByIdAndUpdate(req.params.id, { status: 'reviewed' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.delete('/suggestions/:id', async (req, res) => {
  try {
    await Suggestion.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
