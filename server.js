// Carga variables de entorno desde .env (PORT, MONGODB_URI, JWT_SECRET)
require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const compression  = require('compression');   // Gzip de respuestas HTTP
const helmet       = require('helmet');        // Encabezados de seguridad HTTP
const rateLimit    = require('express-rate-limit');
const connectDB    = require('./config/db');
const { checkUser } = require('./middleware/auth');
const School = require('./models/School');

const authRoutes         = require('./routes/auth');
const courseRoutes       = require('./routes/courses');
const announcementRoutes = require('./routes/announcements');
const activityRoutes     = require('./routes/activities');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');

const app  = express();
const PORT = process.env.PORT || 3000;

connectDB();

// ── Vistas ──────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Compresión Gzip ──────────────────────────────────────────────────────────
// Comprime todas las respuestas > 1 KB. Reduce el tamaño del HTML/JSON un 60-70%,
// lo que disminuye la carga de red cuando muchos usuarios acceden al mismo tiempo.
app.use(compression());

// ── Seguridad HTTP (helmet) ──────────────────────────────────────────────────
// Agrega encabezados de seguridad estándar: X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, etc. CSP desactivado porque las vistas usan inline styles/scripts.
app.use(helmet({
  contentSecurityPolicy: false, // Desactivado: las vistas EJS usan <style> y <script> inline
  crossOriginEmbedderPolicy: false, // Necesario para cargar recursos externos (Google Fonts, CDN)
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
// Limita peticiones por IP para evitar que un usuario sature el servidor.
// En modo PM2 cluster, cada worker tiene su propio conteo (limitación aceptable para una escuela).

// Límite general: 400 peticiones cada 15 minutos por IP
// Cubre el uso normal de un alumno/docente navegando activamente
const generalLimiter = rateLimit({
  windowMs:          15 * 60 * 1000, // Ventana de 15 minutos
  max:               400,
  standardHeaders:   true,           // Incluye RateLimit-* en los encabezados
  legacyHeaders:     false,
  message:           { error: 'Demasiadas peticiones. Intentá de nuevo en 15 minutos.' },
  skip: (req) => req.path.startsWith('/css/') || req.path.startsWith('/js/'), // No limita estáticos
});

// Límite para login/registro: 15 intentos cada 15 minutos por IP (previene fuerza bruta)
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             15,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiados intentos. Esperá 15 minutos antes de intentar nuevamente.' },
});

// Límite para subida de archivos: 60 por hora por IP (previene abuso de almacenamiento)
const uploadLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // Ventana de 1 hora
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Límite de subidas alcanzado. Intentá de nuevo en 1 hora.' },
});

// Aplica límite general a todas las rutas dinámicas
app.use(generalLimiter);

// ── Body parsers y cookies ───────────────────────────────────────────────────
// Sirve archivos estáticos antes de cualquier middleware dinámico para máximo rendimiento
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' })); // Limita el tamaño del body JSON
app.use(cookieParser());

// ── Middlewares globales de usuario y escuela ────────────────────────────────
// En TODAS las rutas: verifica el token JWT y pone el usuario en res.locals.user
app.use('*', checkUser);

// En TODAS las rutas: inyecta res.locals.school con el doc de la escuela del usuario
app.use('*', async (req, res, next) => {
  try {
    const schoolId = res.locals.user?.school;
    res.locals.school = schoolId
      ? await School.findById(schoolId).select('name color slug _id')
      : null;
  } catch {
    res.locals.school = null;
  }
  next();
});

// En TODAS las rutas: inyecta el mapa de traducción rol → español
app.use((req, res, next) => {
  res.locals.roleNames = {
    superadmin: 'Superadministrador',
    admin:      'Administrador',
    directivo:  'Directivo',
    teacher:    'Docente',
    preceptor:  'Preceptor',
    soe:        'SOE',
    student:    'Alumno',
  };
  next();
});

// ── Rutas ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!res.locals.user) return res.redirect('/login');
  res.redirect('/courses');
});

// Rate limiter específico para autenticación (antes de montar el router)
app.use('/login',    authLimiter);
app.use('/register', authLimiter);

// Rate limiter para subida de archivos
app.use('/activities', uploadLimiter);
app.use('/announcements', uploadLimiter);

app.use('/',           authRoutes);
app.use('/courses',    courseRoutes);
app.use('/announcements', announcementRoutes);
app.use('/activities', activityRoutes);
app.use('/admin',      adminRoutes);
app.use('/superadmin', superadminRoutes);

// ── Manejador de errores global ──────────────────────────────────────────────
// Captura cualquier error no manejado en los middlewares/rutas.
// Sin esto, un error inesperado puede colgar la request sin responder al cliente.
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  const status = err.status || err.statusCode || 500;
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: err.message || 'Error del servidor' });
  }
  res.status(status).send(status === 404 ? 'Página no encontrada' : 'Error del servidor');
});

// ── Inicio del servidor ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Servidor en http://localhost:${PORT} (PID ${process.pid})`);
});

// ── Cierre ordenado (graceful shutdown) ─────────────────────────────────────
// Cuando PM2 reinicia o detiene el proceso, espera que las requests en curso terminen
// antes de cerrar. Evita cortar conexiones activas de usuarios.
const shutdown = (signal) => {
  console.log(`[${signal}] Cerrando servidor (PID ${process.pid})...`);
  server.close(() => {
    console.log('Servidor cerrado correctamente.');
    process.exit(0);
  });
  // Fuerza el cierre después de 10 segundos si hay requests colgadas
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Captura de errores no manejados ─────────────────────────────────────────
// Evita que una promesa rechazada o una excepción sin catch cierren el proceso.
// PM2 reiniciará el proceso de todas formas, pero estos handlers dan tiempo para loguear.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
  // En excepciones no capturadas es más seguro salir; PM2 reiniciará el worker
  process.exit(1);
});
