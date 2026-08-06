const express  = require('express');
const path     = require('path');
const Course   = require('../models/Course');
const Division = require('../models/Division');
const User     = require('../models/User');
const Activity   = require('../models/Activity');
const Announcement = require('../models/Announcement');
const Submission = require('../models/Submission');
const XLSX       = require('xlsx');
const { requireAuth } = require('../middleware/auth');
// Permisos por solapa configurados en /superadmin/roles (ver middleware/sections.js).
const { requireSection } = require('../middleware/sections');
const { invalidateUser } = require('../middleware/cache');
const { logAudit } = require('../middleware/audit');
const { SYSTEM_OWNER_EMAIL } = require('../config/maintenance');
// Lista cerrada de intereses del perfil. Se pasa a la vista para pintar los chips y se
// reusa en PATCH /profile/about para validar lo que llega (ver config/interests.js).
const { INTERESTS, MAX_INTERESTS } = require('../config/interests');
// Subida de imágenes: multer en memoria + redimensionado/compresión a WebP antes de
// escribir en disco (ver middleware/image-upload.js y config/imagePresets.js).
const {
  subirImagen, guardarImagenOptimizada, borrarPorUrlPublica, ImagenInvalidaError,
} = require('../middleware/image-upload');
// Automatrícula del alumno — TEMPORAL, ver la cabecera de services/selfEnroll.js.
const { cursosDisponibles, automatricular } = require('../services/selfEnroll');
// Código de clase — apagable, ver la cabecera de services/joinByCode.js.
const { JOIN_BY_CODE_ACTIVO, unirPorCodigo } = require('../services/joinByCode');

const router = express.Router();

const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

// GET /courses — Dashboard
router.get('/', requireAuth, async (req, res) => {
  try {
    const [created, joined] = await Promise.all([
      // Incluye materias donde el usuario es owner O co-docente (ver Course.coTeachers,
      // sumado al consolidar materias duplicadas — un co-docente debe ver la materia acá
      // igual que el owner original).
      Course.find({ $or: [{ owner: req.userId }, { coTeachers: req.userId }] })
        .populate('owner', 'name email')
        .populate('division', 'name'),
      Course.find({ students: req.userId })
        .populate('owner', 'name email')
        .populate('division', 'name'),
    ]);
    const courses = [
      ...created.map(c => ({ ...c.toObject(), isOwner: true  })),
      ...joined.map(c  => ({ ...c.toObject(), isOwner: false })),
    ].sort((a, b) => a.name.localeCompare(b.name, 'es'));

    let pendingSummary = null;
    if (res.locals.user?.role === 'student' && joined.length > 0) {
      const now        = new Date();
      const courseIds  = joined.map(c => c._id);
      const activities = await Activity.find({
        course:        { $in: courseIds },
        availableFrom: { $lte: now },
      }).select('_id dueDate allowLateSubmissions');
      const submissions  = await Submission.find({
        student:  req.userId,
        activity: { $in: activities.map(a => a._id) },
      }).select('activity');
      const submittedSet = new Set(submissions.map(s => s.activity.toString()));
      const pending = activities.filter(a => {
        if (submittedSet.has(a._id.toString())) return false;
        if (!a.dueDate) return true;
        if (new Date(a.dueDate) >= now)         return true;
        if (a.allowLateSubmissions)             return true;
        return false;
      });
      const endOfToday = new Date(now);
      endOfToday.setHours(23, 59, 59, 999);
      const dueToday = pending.filter(a => a.dueDate && new Date(a.dueDate) <= endOfToday).length;
      if (pending.length > 0) pendingSummary = { total: pending.length, dueToday };
    }

    // Aviso para completar el perfil personal (bio / intereses / proyecto).
    // Solo alumnos y docentes: admin, superadmin y directivo aterrizan en sus propios
    // paneles y para ellos el perfil no aporta nada institucional.
    //
    // A propósito NO se pide teléfono ni redes: son datos de contacto y buena parte de los
    // alumnos son menores. Empujar por ellos desde un banner sería presionar por información
    // sensible; que los cargue quien quiera, desde el perfil, sin que el sistema insista.
    //
    // El aviso desaparece solo al completar los campos: PATCH /profile/about llama a
    // invalidateUser, así que el user cacheado se refresca en el próximo request.
    let profilePrompt = null;
    const u = res.locals.user;
    if (u && ['student', 'teacher'].includes(u.role)) {
      const faltantes = [];
      if (!u.bio)                                 faltantes.push('una breve presentación');
      if (!u.interests || u.interests.length === 0) faltantes.push('tus intereses');
      if (!u.futureGoal) {
        faltantes.push(u.role === 'student' ? 'a qué te gustaría dedicarte' : 'tu formación');
      }
      if (faltantes.length > 0) {
        profilePrompt = { faltantes, total: 3, completos: 3 - faltantes.length };
      }
    }

    // Alumno que no está en ninguna materia: puede elegir su curso una sola vez y quedar
    // matriculado (TEMPORAL, ver services/selfEnroll.js). Se calcula con joined y no con
    // courses porque un alumno nunca es owner: si tuviera una sola materia, ya no aplica.
    const autoMatricula = res.locals.user?.role === 'student' && joined.length === 0
      ? await cursosDisponibles(res.locals.user.school || null)
      : [];

    res.render('dashboard', { courses, pendingSummary, profilePrompt, autoMatricula,
      joinByCode: JOIN_BY_CODE_ACTIVO });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// GET /courses/divisions — Devuelve las divisiones de la escuela del usuario (JSON)
router.get('/divisions', requireAuth, async (req, res) => {
  try {
    const school = res.locals.user?.school;
    if (!school) return res.json({ divisions: [] });
    const divisions = await Division.find({ school }).sort({ name: 1 });
    res.json({ divisions });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/self-enroll — el alumno elige su curso y queda matriculado
//
// FUNCIÓN TEMPORAL (ver services/selfEnroll.js). Va ANTES de cualquier ruta /:id para que
// "self-enroll" no se lea como un id de materia.
//
// "Una sola vez" es literal y se apoya en el estado, no en un flag: la ruta solo acepta al
// alumno que HOY no está en ninguna materia. Después de matricularse, el mismo pedido
// devuelve 409 y el bloque desaparece del panel. Es también lo que evita que se sume cursos
// de a uno hasta quedar en varios: para eso está el alta administrativa.
router.post('/self-enroll', requireAuth, async (req, res) => {
  try {
    if (res.locals.user?.role !== 'student') {
      return res.status(403).json({ error: 'Solo los alumnos pueden elegir su curso.' });
    }
    const yaTieneMaterias = await Course.exists({ students: req.userId });
    if (yaTieneMaterias) {
      return res.status(409).json({
        error: 'Ya estás matriculado. Si el curso no es el que te corresponde, pedile el cambio al administrador.',
      });
    }

    // Documento real y no el user cacheado: automatricular() puede tener que guardarle la
    // escuela (las cuentas del registro público viejo la tienen en null).
    const student = await User.findById(req.userId);
    if (!student) return res.status(404).json({ error: 'No se encontró tu cuenta.' });

    const r = await automatricular(req, student, req.body.divisionId, 'panel-alumno-automatricula');
    if (!r.ok) return res.status(400).json({ error: r.error });

    // El doc de usuario vive cacheado 45 s por worker y puede haber cambiado su escuela:
    // sin invalidar, seguiría viéndose como "sin escuela" hasta que expire el TTL.
    invalidateUser(req.userId);

    res.json({ ok: true, materias: r.materias, curso: r.curso });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/create — Crea una nueva materia dentro de una división
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { name, divisionId, room } = req.body;
    // Ni el preceptor ni el jefe de sección dictan materias: las administran o las miran
    // desde su panel. Sin este chequeo podrían crear una materia y quedar como owner, lo
    // que por isTeacher() les habilitaría calificar y gestionar alumnos de esa materia —
    // en el caso del jefe, además, rompería la propiedad de que su rol es de SOLO LECTURA.
    // Lo detectó el smoke `jefatura-no-entra-a-otros-paneles`.
    //
    // NOTA: esta ruta sigue sin validar el rol para el resto de los usuarios — un alumno
    // logueado puede hacer el mismo POST. Es un agujero preexistente (está en el backlog):
    // convertir esto en una lista blanca exige decidir antes si directivo y SOE conservan
    // la posibilidad, que hoy la UI les ofrece.
    if (['preceptor', 'jefe'].includes(res.locals.user?.role)) {
      return res.status(403).json({ error: 'Tu rol no puede crear materias' });
    }
    const school = res.locals.user?.school;
    if (!school) {
      return res.status(400).json({ error: 'Tu cuenta no está asignada a ninguna escuela' });
    }
    const division = await Division.findOne({ _id: divisionId, school });
    if (!division) {
      return res.status(400).json({ error: 'División no válida o no pertenece a tu institución' });
    }
    const course = await Course.create({
      name, room: room || '',
      division: division._id,
      school,
      owner: req.userId,
    });

    logAudit(req, 'course.create',
      [
        { type: 'course',   id: course._id,   name: course.name },
        { type: 'division', id: division._id, name: division.name },
      ],
      { ...(course.room ? { aula: course.room } : {}) },
    );

    res.status(201).json({ course });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/join — el alumno se suma a una materia tipeando su código de clase.
//
// Historia, porque la ruta fue y vino: existía, se apagó por flag el 2026-07-29, se eliminó
// del todo el 2026-07-30 (matricular tenía que ser siempre administrativo) y se repuso el
// 2026-07-31 a pedido del usuario, esta vez ACOTADA a las materias del propio curso del
// alumno. La regla y el flag para apagarla viven en services/joinByCode.js.
//
// Las vías administrativas siguen intactas y son las que dejan registro de quién inscribió
// a cada uno: el alta con Curso desde /admin/users/create o desde preceptoría (ambas usan
// services/enrollment.js), y `POST /courses/:id/add-student` para una materia suelta.
router.post('/join', requireAuth, async (req, res) => {
  try {
    if (res.locals.user?.role !== 'student') {
      return res.status(403).json({ error: 'Solo los alumnos pueden unirse con un código.' });
    }
    const student = await User.findById(req.userId).select('_id name role school');
    if (!student) return res.status(404).json({ error: 'No se encontró tu cuenta.' });

    const r = await unirPorCodigo(req, student, req.body.code);
    if (!r.ok) return res.status(400).json({ error: r.error });

    res.json({ ok: true, materia: r.materia });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});
//
// El campo `Course.code` sigue en el modelo pero ya no se usa ni se muestra en ningún lado.

// Limpia un celular: conserva dígitos, +, espacios, guiones y paréntesis; exige 7-20 caracteres.
function sanitizePhone(raw) {
  const value = String(raw || '').trim();
  if (!value) return { value: '', error: null };
  if (!/^[0-9+\-\s()]{7,20}$/.test(value)) {
    return { value: null, error: 'El celular tiene un formato inválido' };
  }
  return { value, error: null };
}

// Normaliza un handle de red social: acepta "@user", "user" o una URL completa del dominio
// dado, y devuelve solo el handle limpio (sin @, sin dominio, sin query string ni path extra).
// Nunca se guarda la URL completa — se reconstruye al mostrarla.
function sanitizeSocialHandle(raw, domain) {
  let value = String(raw || '').trim();
  if (!value) return { value: '', error: null };
  value = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (value.toLowerCase().startsWith(domain + '/')) value = value.slice(domain.length + 1);
  value = value.split('?')[0].split('/')[0].replace(/^@/, '');
  if (!/^[a-zA-Z0-9_.\-]{1,50}$/.test(value)) {
    return { value: null, error: 'El usuario/link no tiene un formato válido' };
  }
  return { value, error: null };
}

// Permisos de la solapa "Mi perfil" (config/sections.js). Un solo router.use en vez de
// repetir la guarda en las 7 rutas de /profile: así una ruta nueva de perfil queda
// cubierta sin que haya que acordarse. Cubre la vista y también las mutaciones (avatar,
// contraseña, email, contacto, intereses).
router.use('/profile', requireSection('app_profile'));

// GET /courses/profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    if (res.locals.user?.role === 'student') {
      const joinedCourses = await Course.find({ students: req.userId })
        .populate('owner', 'name email')
        .populate('division', 'name');
      return res.render('profile', { joinedCourses, createdCourses: [], activityCount: 0, totalStudents: 0, systemOwnerEmail: SYSTEM_OWNER_EMAIL, INTERESTS, MAX_INTERESTS });
    }
    const [createdCourses, activityCount] = await Promise.all([
      // Incluye materias co-dictadas (ver Course.coTeachers), mismo motivo que en GET /courses.
      Course.find({ $or: [{ owner: req.userId }, { coTeachers: req.userId }] })
        .populate('owner', 'name email')
        .populate('division', 'name'),
      Activity.countDocuments({ author: req.userId }),
    ]);
    const totalStudents = createdCourses.reduce((sum, c) => sum + c.students.length, 0);
    res.render('profile', { createdCourses, activityCount, totalStudents, joinedCourses: [], systemOwnerEmail: SYSTEM_OWNER_EMAIL, INTERESTS, MAX_INTERESTS });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// POST /courses/profile/avatar
// La imagen llega en memoria y se guarda ya optimizada (preset 'avatar': 512×512 WebP).
// El nombre lleva un sufijo único por subida, así que la URL cambia y el navegador no
// muestra el avatar anterior de su cache. Las versiones previas las borra
// guardarImagenOptimizada() DESPUÉS de escribir la nueva.
router.post('/profile/avatar', requireAuth, subirImagen('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Formato no permitido (JPG, PNG, WebP o GIF)' });
    const schoolId = res.locals.user?.school?.toString() || 'general';
    const userId   = res.locals.user._id.toString();
    const dir      = path.join(ARCHIVOS_BASE, schoolId, 'avatars', userId);

    const guardada = await guardarImagenOptimizada(req.file, { preset: 'avatar', dir, base: 'avatar' });

    const avatarUrl = `/archivos/${schoolId}/avatars/${userId}/${guardada.filename}`;
    await User.findByIdAndUpdate(userId, { avatar: avatarUrl });
    invalidateUser(userId);
    res.json({ avatar: avatarUrl });
  } catch (err) {
    // El archivo nunca llegó al disco (memoryStorage), así que no hay nada que limpiar.
    if (err instanceof ImagenInvalidaError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Error al guardar el avatar' });
  }
});

// DELETE /courses/profile/avatar
router.delete('/profile/avatar', requireAuth, async (req, res) => {
  try {
    const user = res.locals.user;
    if (user.avatar) {
      borrarPorUrlPublica(user.avatar);
      await User.findByIdAndUpdate(user._id, { avatar: null });
      invalidateUser(user._id);
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error al eliminar el avatar' });
  }
});

// POST /courses/profile/change-password
router.post('/profile/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Completá todos los campos' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }
    const user = await User.findById(req.userId).select('+password');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    }
    user.password = newPassword;
    await user.save();

    logAudit(req, 'user.password_change',
      [{ type: 'user', id: user._id, name: user.name }],
      {},
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/profile/change-email
// Cualquier rol puede cambiar su propio correo. Requiere la contraseña actual (mismo
// resguardo que change-password) para que una sesión abierta en una compu compartida no
// pueda usarse para redirigir la cuenta a otro correo sin que el dueño se entere.
// La cuenta protegida (ver PROTECTED_ADMIN_EMAIL en routes/admin.js, mismo valor que
// SYSTEM_OWNER_EMAIL) NO puede autocambiarse el email: ese string está hardcodeado como
// constante de seguridad en varios archivos (borrado/rol/mantenimiento) — si esa cuenta
// cambiara de dirección, esas protecciones quedarían apuntando a un email que ya no es
// el suyo. Decisión explícita del dueño del sistema, no un descuido.
router.post('/profile/change-email', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body;
    if (!currentPassword || !newEmail) {
      return res.status(400).json({ error: 'Completá todos los campos' });
    }
    const normalized = newEmail.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return res.status(400).json({ error: 'Ingresá un correo electrónico válido' });
    }

    const user = await User.findById(req.userId).select('+password');
    if (user.email === SYSTEM_OWNER_EMAIL) {
      return res.status(403).json({ error: 'Esta cuenta no puede cambiar su correo por este medio' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    }

    if (normalized === user.email) {
      return res.status(400).json({ error: 'Ese ya es tu correo actual' });
    }

    const oldEmail = user.email;
    user.email = normalized;
    await user.save();
    invalidateUser(user._id);

    logAudit(req, 'user.email_change',
      [{ type: 'user', id: user._id, name: user.name }],
      { de: oldEmail, a: normalized },
    );

    res.json({ ok: true, email: user.email });
  } catch (err) {
    // Índice único violado: el correo ya está en uso por otra cuenta
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PATCH /courses/profile/contact
// El propio usuario actualiza sus datos de contacto (celular, Instagram, Facebook). Todos
// los campos son opcionales; mandar '' borra el campo. Solo se guarda el handle/número
// limpio — el link completo (instagram.com/…, wa.me/…) se arma al mostrarlo, nunca al guardar.
router.patch('/profile/contact', requireAuth, async (req, res) => {
  try {
    const phoneResult    = sanitizePhone(req.body.phone);
    const instaResult    = sanitizeSocialHandle(req.body.instagram, 'instagram.com');
    const facebookResult = sanitizeSocialHandle(req.body.facebook, 'facebook.com');

    const error = phoneResult.error || instaResult.error || facebookResult.error;
    if (error) return res.status(400).json({ error });

    const user = await User.findByIdAndUpdate(req.userId, {
      phone:     phoneResult.value || null,
      instagram: instaResult.value || null,
      facebook:  facebookResult.value || null,
    }, { new: true, runValidators: true });
    invalidateUser(user._id);

    logAudit(req, 'user.contact_change',
      [{ type: 'user', id: user._id, name: user.name }],
      {},
    );

    res.json({ ok: true, phone: user.phone, instagram: user.instagram, facebook: user.facebook });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PATCH /courses/profile/about
// El propio usuario actualiza su perfil personal: presentación, intereses y proyecto/formación.
// Va separada de /profile/contact a propósito: son datos de naturaleza distinta y el usuario
// puede guardar una sección sin tocar la otra.
//
// Los intereses se validan contra la lista CERRADA de config/interests.js. No alcanza con
// validar en el frontend: un POST directo podría mandar cualquier string y quedaría guardado
// y renderizado en el panel del directivo.
router.patch('/profile/about', requireAuth, async (req, res) => {
  try {
    const { INTEREST_IDS, MAX_INTERESTS } = require('../config/interests');

    const bio        = typeof req.body.bio === 'string' ? req.body.bio.trim() : '';
    const futureGoal = typeof req.body.futureGoal === 'string' ? req.body.futureGoal.trim() : '';

    if (bio.length > 280) {
      return res.status(400).json({ error: 'La presentación no puede superar los 280 caracteres' });
    }
    if (futureGoal.length > 120) {
      return res.status(400).json({ error: 'El proyecto o especialidad no puede superar los 120 caracteres' });
    }

    // Se filtra contra la whitelist y se deduplica: cualquier id desconocido se descarta
    // en silencio en vez de rechazar todo el formulario (si la lista cambió, el usuario no
    // pierde el resto de lo que cargó).
    const recibidos = Array.isArray(req.body.interests) ? req.body.interests : [];
    const interests = [...new Set(recibidos.filter(i => INTEREST_IDS.includes(i)))];

    if (interests.length > MAX_INTERESTS) {
      return res.status(400).json({ error: `Podés elegir hasta ${MAX_INTERESTS} intereses` });
    }

    const user = await User.findByIdAndUpdate(req.userId, {
      bio:        bio || null,
      interests,
      futureGoal: futureGoal || null,
    }, { new: true, runValidators: true });
    invalidateUser(user._id);

    logAudit(req, 'user.contact_change',
      [{ type: 'user', id: user._id, name: user.name }],
      { seccion: 'perfil personal' },
    );

    res.json({ ok: true, bio: user.bio, interests: user.interests, futureGoal: user.futureGoal });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /courses/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('coTeachers', 'name email')
      .populate('students', 'name email dni active avatar')
      .populate('division', 'name');
    if (!course) return res.status(404).send('Curso no encontrado');
    const isOwner   = course.canManage(res.locals.user);
    const isStudent = course.students.some(s => s._id.toString() === req.userId);
    if (!isOwner && !isStudent) return res.status(403).send('Acceso denegado');

    // Orden alfabético por apellido para la solapa Personas — los nombres se cargan
    // como "APELLIDO, Nombre", así que ordenar por el string completo alcanza.
    course.students.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));

    // Docente destacado en la esquina superior derecha de la ficha: solo a modo de
    // figurar, NO cambia quién es el titular real (course.owner sigue intacto). Por
    // defecto se muestra el titular; si hay suplentes y alguno creó más tareas+novedades
    // que el titular en esta materia, se muestra ese suplente en su lugar.
    let featuredTeacher = course.owner;
    if (course.coTeachers.length > 0) {
      // filter(Boolean): el titular puede faltar si se eliminó al usuario dueño.
      const candidates = [course.owner, ...course.coTeachers].filter(Boolean);
      const counts = await Promise.all(candidates.map(async (t) => {
        const [activities, announcements] = await Promise.all([
          Activity.countDocuments({ course: course._id, author: t._id }),
          Announcement.countDocuments({ course: course._id, author: t._id }),
        ]);
        return activities + announcements;
      }));
      let bestIdx = 0;
      for (let i = 1; i < candidates.length; i++) {
        if (counts[i] > counts[bestIdx]) bestIdx = i;
      }
      featuredTeacher = candidates[bestIdx];
    }

    // Gestión de docentes desde la solapa Personas: solo para admin/superadmin (el docente
    // no se administra a sí mismo). Las acciones pegan contra las rutas de /admin/courses,
    // que ya existen y están detrás de requireAdmin — acá solo se arma el selector.
    const manageTeachers = ['admin', 'superadmin'].includes(res.locals.user.role);
    let schoolTeachers = [];
    if (manageTeachers) {
      // owner puede venir null (docente eliminado, referencia colgada): en ese caso no hay
      // nadie "tomado" y todos los docentes de la escuela quedan disponibles para asignar.
      const taken = new Set([...(course.owner ? [course.owner._id.toString()] : []), ...course.coTeachers.map(t => t._id.toString())]);
      schoolTeachers = (await User.find({ role: 'teacher', active: { $ne: false }, ...(course.school ? { school: course.school } : {}) })
        .sort({ name: 1 }).select('_id name email').lean())
        .filter(t => !taken.has(t._id.toString()));
    }

    res.render('course', {
      course, featuredTeacher, joinByCode: JOIN_BY_CODE_ACTIVO,
      manageTeachers, schoolTeachers,
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

// POST /courses/:id/add-student
router.post('/:id/add-student', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Solo el docente puede agregar alumnos' });
    }
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'El correo es requerido' });
    const student = await User.findOne({ email: email.toLowerCase().trim() });
    if (!student) return res.status(404).json({ error: 'No se encontró ningún usuario con ese correo' });
    if (student._id.toString() === req.userId) {
      return res.status(400).json({ error: 'No podés agregarte a vos mismo como alumno' });
    }
    if (course.school && student.school && course.school.toString() !== student.school.toString()) {
      return res.status(403).json({ error: 'El alumno no pertenece a esta institución' });
    }
    if (course.students.some(s => s.toString() === student._id.toString())) {
      return res.status(400).json({ error: 'El alumno ya está inscripto en este curso' });
    }
    course.students.push(student._id);
    await course.save();

    logAudit(req, 'course.add_student',
      [
        { type: 'course', id: course._id,  name: course.name },
        { type: 'user',   id: student._id, name: student.name },
      ],
      {},
    );

    res.json({ student: { _id: student._id, name: student.name, email: student.email } });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /courses/:id/students/:studentId
router.delete('/:id/students/:studentId', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Solo el docente puede quitar alumnos' });
    }
    if (!course.students.some(s => s.toString() === req.params.studentId)) {
      return res.status(404).json({ error: 'Alumno no encontrado en este curso' });
    }
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

    // Snapshot del nombre del alumno para que el evento siga legible aunque se borre.
    const removed = await User.findById(req.params.studentId).select('name').lean();
    logAudit(req, 'course.remove_student',
      [
        { type: 'course', id: course._id,           name: course.name },
        { type: 'user',   id: req.params.studentId, name: removed?.name || '' },
      ],
      {},
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/:id/students/:studentId/toggle-active
router.post('/:id/students/:studentId/toggle-active', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Solo el docente puede modificar alumnos' });
    }
    if (!course.students.some(s => s.toString() === req.params.studentId)) {
      return res.status(404).json({ error: 'Alumno no encontrado en este curso' });
    }
    const student = await User.findById(req.params.studentId).select('active email role');
    if (!student) return res.status(404).json({ error: 'Usuario no encontrado' });
    student.active = !(student.active !== false);
    await student.save();
    invalidateUser(student._id);
    res.json({ active: student.active });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /courses/:id/gradebook
router.get('/:id/gradebook', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate('students', 'name email');
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) return res.status(403).json({ error: 'Sin acceso' });
    const activities = await Activity.find({ course: req.params.id }).sort({ createdAt: -1 });
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

// GET /courses/:id/export-students
router.get('/:id/export-students', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).populate('students', 'name email dni active');
    if (!course) return res.status(404).send('Curso no encontrado');
    if (!course.canManage(res.locals.user)) return res.status(403).send('Sin acceso');
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

// GET /courses/:id/data
router.get('/:id/data', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'name email')
      .populate('students', 'name email')
      .populate('division', 'name');
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    res.json({ course });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /courses/:id/customize
// El chequeo de ownership va ANTES del multer. Históricamente era OBLIGATORIO: el multer
// viejo borraba la portada anterior dentro de su callback `filename()`, que corre antes
// que el handler, así que un docente A podía borrar la portada del curso de un docente B
// iterando sobre IDs — la request terminaba en 403, pero el archivo ya no estaba.
// Hoy la subida es en memoria y el borrado ocurre dentro del handler (después de validar),
// con lo cual el agujero está cerrado por diseño. Este middleware queda igual: validar
// antes de leer 8 MB de multipart sigue siendo lo correcto, y es defensa en profundidad.
router.post('/:id/customize', requireAuth, async (req, res, next) => {
  try {
    // select incluye coTeachers: si solo trajéramos 'owner', isTeacher() no podría ver a
    // los co-docentes (this.coTeachers vendría undefined) y los rechazaría por error.
    // Y `school` por lo mismo, para el caso admin de canManage().
    const course = await Course.findById(req.params.id).select('owner coTeachers school');
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Solo el docente puede personalizar el curso' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
}, subirImagen('image'), async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    const { mode, color, color2, removeImage } = req.body;
    const schoolId  = res.locals.user?.school?.toString() || 'general';
    const newHeader = {};
    if (mode === 'image') {
      newHeader.color  = color  || '#1a73e8';
      newHeader.color2 = null;
      if (req.file) {
        // preset 'header': 1600×600 con fit 'inside' — la portada se ve completa, sin recorte
        const dir = path.join(ARCHIVOS_BASE, schoolId, 'headers', req.params.id);
        const guardada = await guardarImagenOptimizada(req.file, { preset: 'header', dir, base: 'header' });
        newHeader.image = `/archivos/${schoolId}/headers/${req.params.id}/${guardada.filename}`;
      } else if (removeImage === 'true') {
        borrarPorUrlPublica(course.header?.image);
        newHeader.image = null;
      } else {
        newHeader.image = course.header?.image || null;
      }
    } else {
      borrarPorUrlPublica(course.header?.image);
      newHeader.color  = color  || '#1a73e8';
      newHeader.color2 = color2 || null;
      newHeader.image  = null;
    }
    await Course.findByIdAndUpdate(req.params.id, { $set: { header: newHeader } });
    res.json({ header: newHeader });
  } catch (err) {
    if (err instanceof ImagenInvalidaError) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Error al guardar la personalización' });
  }
});

module.exports = router;
