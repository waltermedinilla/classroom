const express = require('express');
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const School = require('../models/School');
// DNI obligatorio en toda alta desde 2026-07-30 (ver services/dni.js).
const { normalizeDni } = require('../services/dni');
// Automatrícula del alumno — TEMPORAL, ver la cabecera de services/selfEnroll.js.
const {
  AUTOMATRICULA_ACTIVA, cursosDisponibles, cursoElegible, automatricular,
} = require('../services/selfEnroll');
// Ventana de mantenimiento: mientras el sistema está EN ESPERA se corta la puerta de
// entrada, pero el que ya está adentro sigue trabajando sin enterarse de nada
// (ver specs/mantenimiento-ventana.spec.md).
const { getPendingState, SYSTEM_OWNER_EMAIL } = require('../config/maintenance');

const router = express.Router();

const PENDING_INGRESS_ERROR = 'El sistema entra en mantenimiento en unos minutos y no se '
  + 'admiten nuevos ingresos. Volvé a intentar más tarde.';

// Devuelve la espera en curso si este ingreso hay que rechazarlo, o null si puede pasar.
//
// El dueño SIEMPRE puede entrar: si se le vence la cookie durante una espera que él mismo
// programó, sin esta excepción quedaría afuera de su propio panel y sin forma de apagar el
// mantenimiento (el mismo agujero que se tapó el 2026-07-27 con el redirect a /login).
// Se chequea antes de validar la contraseña, pero no revela nada que el login no revele ya.
function ingresoBloqueado(email) {
  if (email && String(email).trim().toLowerCase() === SYSTEM_OWNER_EMAIL) return null;
  return getPendingState();
}

function rechazarIngreso(res) {
  return res.status(503).json({ maintenance: true, pending: true, error: PENDING_INGRESS_ERROR });
}

const maxAge = 7 * 24 * 60 * 60 * 1000;
const cookieOpts = {
  httpOnly: true,
  maxAge,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production', // Funnel sirve HTTPS; necesario para secure cookies
};

// Crea un JWT firmado con el secreto del .env; expiración en 7 días
// Retorna el token string que se setea como cookie httpOnly
const createToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

// GET /login — muestra el formulario de login
// Si ya tiene sesión VÁLIDA (checkUser la verificó), redirige directo al inicio.
// Se chequea res.locals.user y no la cookie: una cookie con token vencido dispararía
// un bucle infinito /login → / → /login (el navegador muestra ERR_TOO_MANY_REDIRECTS).
router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  // Con una espera en curso el formulario se muestra igual, pero con el aviso arriba: que
  // no lo descubra recién después de tipear la contraseña.
  res.render('login', { maintenancePending: getPendingState() });
});

// GET /register — muestra el formulario de registro
// Pasa los roles disponibles excluyendo 'admin' (los admins solo los crea el superadmin)
router.get('/register', async (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('register', {
    roles: User.getRoles().filter(r => r !== 'admin'),
    // Lista para el select de Curso que se despliega al elegir el rol Alumno. Con la
    // automatrícula apagada vuelve vacía y la vista no pinta el campo.
    cursos: await cursosDisponibles(),
  });
});

// POST /register — crea un nuevo usuario y abre sesión inmediatamente
// Body: { name, email, password, role, dni, divisionId? }
// Retorna: { user, materias } con 201, o error 400 si email duplicado / validación falla
router.post('/register', async (req, res) => {
  try {
    // Crear una cuenta es la forma más extrema de "querer entrar en este momento": si con
    // una espera en curso no se admiten logins, tampoco altas nuevas.
    if (getPendingState()) return rechazarIngreso(res);

    const { name, email, password, role, dni, divisionId } = req.body;
    // DNI obligatorio también acá: la regla es que nadie entra al sistema sin DNI, sin
    // importar por qué puerta (ver services/dni.js).
    const { value: dniValue, error: dniError } = normalizeDni(dni);
    if (dniError) return res.status(400).json({ error: dniError });
    // 'preceptor' NO está en la lista: desde que el rol administra alumnos (alta, edición
    // de datos, baja de cuentas) dejó de ser un rol que uno pueda auto-asignarse, igual
    // que 'admin'. Lo crea un administrador desde /admin/users/create, que es donde además
    // se le define qué cursos tiene a cargo.
    const allowedRoles = ['student', 'teacher', 'soe', 'directivo'];
    const userRole = allowedRoles.includes(role) ? role : 'student';

    // ── Curso elegido por el alumno (TEMPORAL, ver services/selfEnroll.js) ──────────
    // Se resuelve ANTES de crear la cuenta porque de él sale la escuela, y la escuela es
    // la que define contra qué índice {school, dni} hay que chequear el DNI duplicado.
    let curso = null;
    if (userRole === 'student' && AUTOMATRICULA_ACTIVA) {
      curso = await cursoElegible(divisionId);
      if (!curso) {
        return res.status(400).json({ error: 'Elegí tu curso de la lista para poder ver tus materias.' });
      }
      // Sin este chequeo, una segunda cuenta con el mismo DNI se crearía igual (el índice
      // único la frenaría con un 11000 que habla del correo) o, peor, entraría al mismo
      // curso y sería exactamente el duplicado que detecta 'dni-duplicado-en-curso'.
      const yaExiste = await User.findOne({ school: curso.school, dni: dniValue }).select('name');
      if (yaExiste) {
        return res.status(409).json({
          error: 'Ya existe una cuenta con ese DNI en esta escuela. Si es tuya, iniciá sesión o ' +
                 'buscá tus datos de acceso con el DNI acá arriba.',
        });
      }
    }

    const user = await User.create({
      name, email, password, role: userRole, dni: dniValue,
      school: curso ? curso.school : null,
    });

    let materias = 0;
    if (curso) {
      // El actor de la auditoría es el propio alumno que se acaba de registrar. Se setea
      // a mano porque checkUser corrió antes de que la cuenta existiera y res.locals.user
      // está vacío: sin esto el evento quedaría sin actor ni escuela.
      res.locals.user = user;
      const r = await automatricular(req, user, curso._id, 'registro-automatricula');
      materias = r.materias || 0;
    }

    const token = createToken(user._id);
    res.cookie('token', token, cookieOpts);
    res.status(201).json({ user, materias });
  } catch (err) {
    // Error 11000 = índice único violado → email ya registrado
    if (err.code === 11000) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /login — autentica al usuario con email + contraseña
// Body: { email, password }
// Retorna: { user } con 200, o error 400/403 si credenciales inválidas o cuenta deshabilitada
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Mantenimiento en espera: no entra nadie nuevo (salvo el dueño). Los que ya tienen
    // sesión abierta no pasan por acá y siguen trabajando normalmente.
    if (ingresoBloqueado(email)) return rechazarIngreso(res);

    // Busca por email (insensible a mayúsculas por el índice lowercase del schema)
    const user = await User.findOne({ email });
    if (!user) {
      // Mensaje genérico para no revelar si el email existe o no
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }

    // Compara la contraseña enviada con el hash bcrypt almacenado
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Correo electrónico o contraseña inválidos' });
    }

    // Cuenta deshabilitada: no puede iniciar sesión aunque las credenciales sean correctas
    if (user.active === false) {
      return res.status(403).json({ error: 'Tu cuenta está deshabilitada. Contactá al administrador.' });
    }

    const token = createToken(user._id);
    res.cookie('token', token, cookieOpts);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /register/invite/:token — muestra el formulario de registro vinculado a una escuela
// Si el token no existe en ninguna escuela → pantalla de enlace inválido
router.get('/register/invite/:token', async (req, res) => {
  if (res.locals.user) return res.redirect('/');
  try {
    const school = await School.findOne({ inviteToken: req.params.token });
    // Misma lista que valida el POST de abajo: 'preceptor' quedó fuera al pasar a ser un
    // rol con permisos de administración sobre alumnos.
    const roles = User.getRoles().filter(r => !['superadmin', 'admin', 'preceptor'].includes(r));
    // school=null indica enlace inválido; la vista maneja ambos casos
    res.render('invite-register', { school: school || null, token: req.params.token, roles });
  } catch (err) {
    res.render('invite-register', { school: null, token: req.params.token, roles: [] });
  }
});

// POST /register/invite/:token — crea el usuario y lo asocia a la escuela del enlace
// Body: { name, email, password, role, dni }
// Retorna: { user } 201 o error 400
router.post('/register/invite/:token', async (req, res) => {
  try {
    if (getPendingState()) return rechazarIngreso(res);

    const school = await School.findOne({ inviteToken: req.params.token });
    if (!school) return res.status(400).json({ error: 'El enlace no es válido o fue revocado.' });

    const { name, email, password, role, dni } = req.body;
    // Solo roles no privilegiados pueden auto-registrarse por invitación.
    // 'preceptor' salió de la lista: administra alumnos, así que lo crea un admin.
    const allowed = ['student', 'teacher', 'soe', 'directivo'];
    const userRole = allowed.includes(role) ? role : 'student';

    const { value: dniValue, error: dniError } = normalizeDni(dni);
    if (dniError) return res.status(400).json({ error: dniError });

    // El DNI es único por escuela ({school, dni}). Acá SÍ se conoce la escuela (la del
    // enlace), así que se chequea antes para dar un mensaje claro en vez del 11000 crudo,
    // que hablaría del correo aunque el choque real sea el documento.
    const yaExiste = await User.findOne({ school: school._id, dni: dniValue }).select('name');
    if (yaExiste) {
      return res.status(409).json({
        error: 'Ya existe una cuenta con ese DNI en esta escuela. Si es tuya, iniciá sesión o pedí que te restablezcan la contraseña.',
      });
    }

    const user = await User.create({
      name, email, password, role: userRole, school: school._id, dni: dniValue,
    });
    const token = createToken(user._id);
    res.cookie('token', token, cookieOpts);
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /register/lookup?dni= — busca un usuario pre-registrado por DNI (sin autenticación)
// Devuelve nombre, email y DNI para que el usuario sepa cómo iniciar sesión.
// Solo usuarios activos; rate-limited por authLimiter en server.js (15 req / 15 min).
router.get('/register/lookup', async (req, res) => {
  const dni = (req.query.dni || '').replace(/\D/g, '').trim();
  if (dni.length < 6) {
    return res.status(400).json({ error: 'Ingresá un DNI válido (mínimo 6 dígitos)' });
  }
  try {
    const users = await User.find({ dni, active: true })
      .select('name email dni')
      .lean();
    if (!users.length) {
      return res.status(404).json({ error: 'No se encontró ningún usuario con ese DNI' });
    }
    res.json({ users });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /logout — cierra la sesión borrando las cookies
// Limpia también adminToken por si estaba en modo suplantación
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.clearCookie('adminToken');
  res.json({ message: 'Sesión cerrada' });
});

// GET /exit-impersonate — el admin vuelve a su propia sesión después de suplantar un usuario
// Mecanismo: adminToken guarda el JWT original del admin → se restaura como token principal
router.get('/exit-impersonate', (req, res) => {
  const adminToken = req.cookies.adminToken;
  if (!adminToken) return res.redirect('/');

  res.clearCookie('adminToken');
  try {
    // Verifica que el adminToken siga siendo válido (no expirado)
    jwt.verify(adminToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // Restaura la sesión del admin original
    res.cookie('token', adminToken, cookieOpts);
  } catch {
    // Si el adminToken expiró, cierra sesión completamente
    res.clearCookie('token');
  }
  // A la raíz, no a /admin: quien suplanta puede ser admin O superadmin, y mandar a todos
  // a /admin dejaba al superadmin en el panel de administración — con las solapas de admin
  // y sin las suyas — como si al volver hubiera cambiado de rol. `GET /` ya reparte por rol
  // (ver server.js): superadmin → /superadmin, admin → /admin. Si el adminToken venció, no
  // queda sesión y la misma ruta lo manda a /login.
  res.redirect('/');
});

module.exports = router;
