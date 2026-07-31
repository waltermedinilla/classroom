// Carga variables de entorno desde .env (PORT, MONGODB_URI, JWT_SECRET)
require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const compression  = require('compression');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const crypto       = require('crypto');
const { spawn }    = require('child_process');
const logger       = require('./config/logger');
const connectDB    = require('./config/db');
const { checkUser } = require('./middleware/auth');
const { schoolCache } = require('./middleware/cache');
const { getMaintenanceState, SYSTEM_OWNER_EMAIL } = require('./config/maintenance');
const School     = require('./models/School');
const Suggestion = require('./models/Suggestion');
const TemplateAssignment = require('./models/TemplateAssignment');
const APP_VERSION = require('./package.json').version;
const { INTEREST_LABELS, INTEREST_ICONS } = require('./config/interests');

// Log del deploy automático (POST /deploy). Va a un archivo propio y no al logger de
// winston a propósito: el proceso que escribe acá sobrevive al worker que lo lanzó
// (ver el spawn detached en /deploy), así que no puede depender del logger de la app.
const DEPLOY_LOG = path.join(__dirname, 'logs', 'deploy.log');

// Raíz del repo en el server de producción. Es la carpeta sobre la que opera el deploy
// (git pull / npm install). Va como constante y no repetida en cada paso del comando
// para que un cambio de ruta no deje la mitad de los pasos apuntando al lugar viejo.
const APP_DIR = '/home/walter/classroom';

const authRoutes         = require('./routes/auth');
const courseRoutes       = require('./routes/courses');
const announcementRoutes = require('./routes/announcements');
const activityRoutes     = require('./routes/activities');
const adminRoutes        = require('./routes/admin');
const superadminRoutes   = require('./routes/superadmin');
const directivoRoutes    = require('./routes/directivo');
const preceptorRoutes    = require('./routes/preceptor');
const backupRoutes       = require('./routes/backup');
const dbFixesRoutes      = require('./routes/dbFixes');
const suggestionRoutes   = require('./routes/suggestions');
const auditRoutes        = require('./routes/audit');
const tasksRoutes        = require('./routes/tasks');

const app  = express();
const PORT = process.env.PORT || 3000;

// La conexión a MongoDB se establece más abajo, antes de app.listen()
// (ver connectDB().then(...) al final del archivo).

// ── Vistas ──────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Tailscale Funnel (y cualquier reverse proxy) termina TLS y reenvía HTTP local.
// trust proxy=1 hace que Express use X-Forwarded-For/Proto para IPs y req.secure reales.
// Necesario para rate limiting por IP real y para cookies con secure:true.
app.set('trust proxy', 1);

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

// Límite general: 1200 peticiones cada 15 minutos por IP
// Cubre el uso normal de un alumno/docente navegando activamente. Se triplicó desde 400
// el 2026-07-28 junto con los otros dos limiters — misma lógica que authLimiter/uploadLimiter:
// ~300 personas de la escuela detrás de la misma IP pública NAT.
const generalLimiter = rateLimit({
  windowMs:          15 * 60 * 1000, // Ventana de 15 minutos
  max:               1200,
  standardHeaders:   true,           // Incluye RateLimit-* en los encabezados
  legacyHeaders:     false,
  message:           { error: 'Demasiadas peticiones. Intentá de nuevo en 15 minutos.' },
  skip: (req) => req.path.startsWith('/css/') || req.path.startsWith('/js/'), // No limita estáticos
});

// Límite para login/registro: 3000 intentos cada 15 minutos por IP.
// La escuela tiene ~300 personas conectadas al mismo WiFi al mismo tiempo (arranque de clase),
// y cada login normal consume ~2-3 requests (GET /login + POST /login + posibles reintentos).
// Con 300 usuarios * 3 = 900 requests esperadas, un límite de 3000 deja mucha holgura para
// picos (reintentos, refresh, sesiones vencidas simultáneas) sin romper la protección
// anti-brute-force: un atacante que intenta 3000 contraseñas en 15 min sigue siendo
// detectable y desalentado. Subimos desde 15 → 1000 → 3000 (triplicado el 2026-07-28
// junto con los otros limiters como blindaje preventivo).
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             3000,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiados intentos. Esperá 15 minutos antes de intentar nuevamente.' },
});

// Límite para subida de archivos: definido en middleware/rate-limits.js y aplicado
// inline en las rutas específicas que hacen upload (activities/create, upload-attachment,
// upload-submission-file, submit, announcements/create). Antes se aplicaba con
// `app.use('/activities', ...)` y golpeaba todos los GET del router, agotando el cupo
// con navegación normal y rompiendo "Mis notas", listado de actividades y novedades.

// ── Health check ─────────────────────────────────────────────────────────────
// GET /health — estado de la instancia. Va montado ANTES del rate limiter y ANTES
// del middleware de mantenimiento a propósito: tiene que responder justamente cuando
// algo anda mal (cupo agotado, sitio en mantenimiento), que es cuando más se lo consulta.
//
// `version` sale de APP_VERSION, que se lee de package.json UNA SOLA VEZ al arrancar el
// worker (línea 19). Por eso es la fuente de verdad de QUÉ CÓDIGO HAY REALMENTE CARGADO
// EN MEMORIA, a diferencia del package.json del disco. Comparar ambos es lo que detecta
// un deploy que copió los archivos pero no recargó los workers — ver el script de deploy
// y el changelog 2026-07-28.
//
// No expone nada sensible: ni rutas, ni env vars, ni datos de usuarios.
app.get('/health', (req, res) => {
  // readyState de Mongoose: 1 = conectado. Cualquier otro valor es un problema.
  const dbUp = require('mongoose').connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status:  dbUp ? 'ok' : 'degraded',
    version: APP_VERSION,
    pid:     process.pid,          // distingue entre workers del cluster
    uptime:  Math.round(process.uptime()), // segundos desde que arrancó ESTE worker
    db:      dbUp ? 'ok' : 'down',
  });
});

// Aplica límite general a todas las rutas dinámicas
app.use(generalLimiter);

// ── Body parsers y cookies ───────────────────────────────────────────────────
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// ── Webhook de deploy automático ─────────────────────────────────────────────
// Debe ir ANTES de express.json() para recibir el body como Buffer (necesario para HMAC)
app.post('/deploy', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.DEPLOY_SECRET;
  const sig    = req.headers['x-hub-signature-256'];

  if (!secret || !sig) return res.status(403).json({ error: 'Forbidden' });

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Firma inválida' });
  }

  const payload = JSON.parse(req.body.toString());
  if (payload.ref !== 'refs/heads/main') {
    return res.status(200).json({ message: 'No es main, omitido' });
  }

  res.status(200).json({ message: 'Deploy iniciado' });

  // ⚠️ CRÍTICO: este handler corre DENTRO de un worker de PM2, y el comando de abajo
  // reinicia esos mismos workers. Con `exec()` el comando era hijo del worker, así que
  // PM2 lo mataba junto con su padre a mitad de ejecución: el `git pull` completaba pero
  // el reload no (o solo alcanzaba a un worker del cluster). Resultado: archivos nuevos
  // en disco + código viejo en memoria, con el sitio respondiendo 200 como si nada.
  // Ver el changelog 2026-07-28 para el diagnóstico completo.
  //
  // `detached: true` pone al hijo en su PROPIO grupo de procesos (setsid), y `unref()`
  // lo desprende del event loop del padre. Así sobrevive a la muerte del worker y llega
  // a terminar el reload. `stdio: 'ignore'` es necesario: sin él, los pipes quedan atados
  // al padre y el hijo muere igual cuando ese padre se va.
  //
  // `reload` en vez de `restart`: levanta los workers de a uno, sin downtime.
  // El último paso es la red de seguridad: compara la versión que /health reporta desde
  // MEMORIA contra la que tiene package.json en DISCO. Si no coinciden, el reload no surtió
  // efecto y quedó el Frankenstein (archivos nuevos + código viejo). En ese caso deja un
  // ERROR bien visible en deploy.log en lugar de fallar en silencio, que fue exactamente
  // lo que hizo que este bug pasara días sin detectarse.
  //
  // El `npm install` NO es opcional: sin él, una dependencia nueva agregada en un commit
  // (por ejemplo sharp en v1.0.7) nunca llega al server y los workers recargan contra un
  // node_modules viejo. Corre con el mismo usuario que el worker (walter), así que los
  // permisos de node_modules tienen que ser suyos — un `npm install` corrido como root
  // deja carpetas de root adentro y todos los deploys posteriores fallan con EACCES.
  //
  // Cada paso lleva su propio `|| { echo; exit 1; }` en vez de encadenar todo con `&&`:
  // así deploy.log dice QUÉ paso falló. Con un `&&` plano, el fallo de un paso disparaba
  // el mensaje de error del siguiente y el log mentía sobre la causa.
  const deployCmd = [
    `cd ${APP_DIR} || { echo "ERROR deploy: no se pudo entrar a ${APP_DIR}"; exit 1; }`,
    // package-lock.json es un archivo GENERADO, y `npm install` lo reescribe. Si quedó
    // modificado en el server (basta un npm install manual), el `git pull` de acá aborta
    // con "Los cambios locales serán sobrescritos al fusionar" y el deploy entero muere
    // antes de recargar. Pasó el 2026-07-29 y dejó producción dos versiones atrasada.
    // La versión válida siempre es la del repo, así que se descarta la local sin más.
    // `|| true` porque si el archivo está limpio (el caso normal) igual queremos seguir.
    'git checkout -- package-lock.json 2>/dev/null || true',
    'git pull || { echo "ERROR deploy: git pull fallo"; exit 1; }',
    'npm install --omit=dev --no-audit --no-fund || ' +
      '{ echo "ERROR deploy: npm install fallo, NO se recargan los workers para no dejarlos sin dependencias"; exit 1; }',
    '/usr/local/bin/pm2 reload classroom --update-env || { echo "ERROR deploy: pm2 reload fallo"; exit 1; }',
    'sleep 5', // dale tiempo a los workers a levantar antes de consultarlos
    `DISK=$(node -p "require('${APP_DIR}/package.json').version")`,

    // Verificación de TODOS los workers, no de uno.
    //
    // Antes esto hacía UN solo `curl /health`. En cluster ese request cae en un worker
    // cualquiera: si caía en el que sí había recargado, DISK y MEM coincidían y el deploy
    // escribía "OK deploy verificado" aunque el otro siguiera con el código viejo. Pasó el
    // 2026-07-30 (v1.0.15): un worker quedó 22 h con la versión anterior y el log dio OK.
    // La red de seguridad no podía detectar el fallo que existía para detectar.
    //
    // 20 requests alcanzan para tocar los 2 workers del cluster con margen holgado
    // (PM2 reparte round-robin). Se juntan las versiones DISTINTAS que se vieron: si hay
    // más de una, o la única no es la del disco, el reload quedó a medias.
    // El `echo "$V"` es imprescindible y no es redundante: /health responde el JSON SIN
    // salto de línea final, y sed no agrega uno propio en ese caso. Encadenando 20
    // respuestas directo al pipe salía UNA sola línea "1.0.151.0.15…" que `sort -u` no
    // podía deduplicar, y la comparación fallaba SIEMPRE — incluso con los workers al día.
    'ver_versiones() { for i in $(seq 1 20); do ' +
      `V=$(curl -sS --max-time 5 http://localhost:${PORT}/health 2>/dev/null ` +
      '| sed -n \'s/.*"version":"\\([^"]*\\)".*/\\1/p\'); ' +
      '[ -n "$V" ] && echo "$V"; done | sort -u; }',
    'VISTAS=$(ver_versiones)',
    'CUANTAS=$(echo "$VISTAS" | grep -c .)',

    // Recuperación automática: `reload` levanta de a uno y a veces no completa el segundo.
    // `restart` es más contundente (los baja a todos y los sube), así que sirve de segundo
    // intento. Antes esto exigía intervención manual y producción quedaba a medias sin
    // que nadie se enterara.
    'if [ "$CUANTAS" != "1" ] || [ "$VISTAS" != "$DISK" ]; then',
    '  echo "AVISO deploy: reload quedo a medias (disco=v$DISK, en memoria: $(echo $VISTAS)). Reintentando con restart..."',
    '  /usr/local/bin/pm2 restart classroom --update-env || { echo "ERROR deploy: pm2 restart fallo"; exit 1; }',
    '  sleep 6',
    '  VISTAS=$(ver_versiones)',
    '  CUANTAS=$(echo "$VISTAS" | grep -c .)',
    'fi',

    'if [ "$CUANTAS" = "1" ] && [ "$VISTAS" = "$DISK" ]; then',
    '  echo "OK deploy verificado en todos los workers: v$DISK"',
    'else',
    '  echo "ERROR deploy NO recargo: disco=v$DISK, en memoria: $(echo $VISTAS)"; exit 1',
    'fi',
  ].join('\n');

  // ⚠️ DOBLE FORK — `detached: true` SOLO NO ALCANZA, y esto costó tres deploys rotos.
  //
  // `detached` llama a setsid(): pone al hijo en su propio GRUPO DE PROCESOS, lo que lo
  // protege de las señales dirigidas al grupo del worker. Pero NO cambia quién es su padre:
  // el `sh` sigue colgando por PPID del worker que atendió este webhook. Cuando PM2 recarga
  // ESE worker, se lleva puesto al script — y con él al proceso `pm2` que estaba pidiendo
  // el reload, que muere antes de mandar el del segundo worker.
  //
  // Los dos deploys del 2026-07-31 lo dejaron por escrito en deploy.log, cada uno cortado
  // justo en el reload de SU worker padre:
  //   v1.0.16 → cortó después de "[classroom](0) ✓"  (colgaba del worker 1)
  //   v1.0.17 → cortó antes de "(0) ✓"               (colgaba del worker 0)
  // Resultado: un worker en cada versión, y la verificación de los 20 requests —que existe
  // justamente para detectar esto— nunca llegó a correr, porque va DESPUÉS del reload.
  //
  // `( … ) &` es el doble fork clásico: el sh externo lanza la subshell en background y
  // termina de inmediato, así el trabajo real queda huérfano y el kernel lo reparenta a
  // init (PPID 1). A partir de ahí no está en el árbol de ningún worker y ningún reload
  // puede alcanzarlo. `detached` se mantiene por las señales de grupo: son dos problemas
  // distintos y hacen falta las dos cosas.
  //
  // Cómo saber si esto quedó bien: deploy.log tiene que terminar en
  // "OK deploy verificado en todos los workers". Si vuelve a cortarse en el reload, el
  // script sigue muriendo y el doble fork no surtió efecto.
  const deployScript = `{ date; ${deployCmd}; } >> ${DEPLOY_LOG} 2>&1`;
  const child = spawn('sh', ['-c', `( ${deployScript} ) &`], {
    detached: true,
    stdio:    'ignore',
  });
  child.unref();

  logger.info('Deploy disparado en background', { pid: child.pid, log: DEPLOY_LOG });
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ── Middlewares globales de usuario y escuela ────────────────────────────────
// En TODAS las rutas: verifica el token JWT y pone el usuario en res.locals.user
app.use('*', checkUser);

// En TODAS las rutas: inyecta res.locals.school con el doc de la escuela del usuario
// Cache TTL 5 min (ver middleware/cache.js): evita un findById por request en toda la app.
// Las rutas que editan una escuela (nombre, color, temas) invalidan la entrada por su _id.
app.use('*', async (req, res, next) => {
  try {
    const schoolId = res.locals.user?.school;
    if (!schoolId) {
      res.locals.school = null;
      return next();
    }
    const key = schoolId.toString();
    let school = schoolCache.get(key);
    if (!school) {
      school = await School.findById(schoolId).select('name color slug _id themes').lean();
      if (school) schoolCache.set(key, school);
    }
    res.locals.school = school || null;
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
  res.locals.appVersion = APP_VERSION;
  // Diccionarios de intereses del perfil (config/interests.js). Van en locals globales
  // para que partials/about-info.ejs funcione desde cualquier vista sin que cada ruta
  // tenga que acordarse de pasarlos — es un include que se usa en varios paneles.
  res.locals.INTEREST_LABELS = INTEREST_LABELS;
  res.locals.INTEREST_ICONS  = INTEREST_ICONS;
  // Feature flags del gestor de plantillas de actividades. Ver plan
  // composed-launching-cray.md (fase 1). Los booleanos se resuelven una vez
  // por request para que las vistas puedan condicionar UI sin releer env vars.
  res.locals.taskTemplatesEnabled        = process.env.TASK_TEMPLATES_ENABLED !== 'false';
  res.locals.taskTemplatesTeacherEnabled = process.env.TASK_TEMPLATES_TEACHER_ENABLED === 'true';
  next();
});

// ── Modo mantenimiento ───────────────────────────────────────────────────────
// Se activa manualmente desde /superadmin/backup o automáticamente durante un
// restore (ver routes/backup.js). El dueño del sistema tiene bypass total (puede
// seguir usando la app normalmente para verificar que todo esté bien); cualquier
// otro usuario logueado ve la página de mantenimiento en TODO menos login/logout/estáticos
// (para poder autenticarse y para que la propia página de mantenimiento se vea bien)
// y el webhook de deploy (para no bloquear un despliegue en curso).
// Usuarios NO logueados: si aterrizan en cualquier ruta bloqueada, los mandamos a
// /login antes de mostrar la pantalla de mantenimiento. Así el dueño puede volver
// a autenticarse si se le venció la cookie o se le reinició la máquina — sin este
// redirect, la pantalla de mantenimiento no linkea al login y quedaría lockeado
// (mitigable borrando maintenance.json a mano, pero incómodo en producción).
app.use((req, res, next) => {
  const state = getMaintenanceState();
  if (!state) return next();
  if (res.locals.user?.email === SYSTEM_OWNER_EMAIL) return next();

  const exempt = ['/login', '/logout', '/favicon.png', '/Logo.jpg', '/deploy'].includes(req.path)
    || req.path.startsWith('/css/') || req.path.startsWith('/js/');
  if (exempt) return next();

  // Sin sesión activa: al login, para que el dueño (o cualquiera) pueda intentar entrar.
  // Solo aplica a navegaciones HTML — un cliente JSON sin auth ya iba a recibir 401 igual,
  // le devolvemos el 503 estándar como hasta ahora.
  if (!res.locals.user && req.accepts('html') && req.method === 'GET') {
    return res.redirect('/login');
  }

  res.set('Retry-After', '300');
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(503).json({ maintenance: true, message: state.message, eta: state.eta });
  }
  res.status(503).render('maintenance', { message: state.message, eta: state.eta });
});

// ── Bandeja de sugerencias: contador de respuestas sin leer ─────────────────
// Inyecta res.locals.unreadSuggestionCount para el badge del sobre en el header.
// Mismo patrón defensivo que el resto de los middlewares globales: try/catch que
// nunca puede tumbar una request, y un killswitch por env var para apagarlo sin
// redeploy si algún día hiciera falta (ej. sospecha de que esta query pesa en
// producción bajo carga — no debería, el índice {user:1, status:1} la hace
// sub-milisegundo, pero la opción de apagarla en caliente no cuesta nada tenerla).
const SUGGESTIONS_INBOX_ENABLED = process.env.SUGGESTIONS_INBOX_ENABLED !== 'false';
app.use(async (req, res, next) => {
  res.locals.unreadSuggestionCount = 0;
  if (SUGGESTIONS_INBOX_ENABLED && res.locals.user) {
    try {
      res.locals.unreadSuggestionCount = await Suggestion.countDocuments({
        user:       res.locals.user._id,
        status:     'answered',
        readByUser: false,
      });
    } catch {
      // Se queda en 0: el sobre simplemente no muestra badge, nunca rompe la página.
    }
  }
  next();
});

// ── Plantillas de tareas ofrecidas y sin responder ──────────────────────────
// Inyecta res.locals.pendingTaskTemplates para el dot rojo del nav "Plantillas"
// (mismo patrón que el de la solapa Tema). Solo cuenta si el user es admin de
// una escuela y el feature flag está prendido. Índice {school:1, status:1} en
// TemplateAssignment mantiene esta query sub-milisegundo.
app.use(async (req, res, next) => {
  res.locals.pendingTaskTemplates = 0;
  const u = res.locals.user;
  if (u && u.role === 'admin' && u.school && res.locals.taskTemplatesEnabled) {
    try {
      res.locals.pendingTaskTemplates = await TemplateAssignment.countDocuments({
        school: u.school,
        status: 'offered',
      });
    } catch {
      // Idem: si falla el conteo, el badge no aparece y listo.
    }
  }
  next();
});

// ── Rutas ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!res.locals.user) return res.redirect('/login');
  // El directivo cae directo en su panel institucional (no en /courses, donde
  // solo vería los cursos donde alguien lo haya inscripto explícitamente).
  if (res.locals.user.role === 'directivo') return res.redirect('/directivo');
  // El preceptor cae en su panel de cursos a cargo. Igual que el directivo: en /courses
  // solo vería las materias donde alguien lo haya inscripto explícitamente, que no es su
  // trabajo. /courses le sigue quedando accesible desde el menú por si está matriculado
  // en alguna materia.
  if (res.locals.user.role === 'preceptor') return res.redirect('/preceptor');
  // Admin/superadmin caen en su propio panel, no en /courses — ese dashboard
  // ("Tus clases") es para docente/alumno. Antes, si el admin también era
  // dueño de alguna materia (Course.owner puede serlo, ver routes/admin.js),
  // /courses lo hacía aterrizar ahí por defecto como si su rol fuera docente.
  if (res.locals.user.role === 'superadmin') return res.redirect('/superadmin');
  if (res.locals.user.role === 'admin')      return res.redirect('/admin');
  res.redirect('/courses');
});

// Rate limiter específico para autenticación (antes de montar el router)
app.use('/login',    authLimiter);
app.use('/register', authLimiter);

app.use('/',           authRoutes);
app.use('/courses',    courseRoutes);
app.use('/announcements', announcementRoutes);
app.use('/activities', activityRoutes);
// Auditoría: define rutas absolutas (/admin/audit y /superadmin/audit). Se monta
// ANTES de adminRoutes/superadminRoutes para que intercepte esas rutas antes de
// caer en el 404 de los otros routers (que no las conocen).
app.use('/',            auditRoutes);
app.use('/admin',      adminRoutes);
// Montado ANTES de /superadmin para que Express lo intercepte primero sin ambigüedad
// (aunque hoy superadmin.js no tiene rutas que choquen con /backup/*).
app.use('/superadmin/backup', backupRoutes);
// Mismo criterio de montaje que /backup: va ANTES de /superadmin para que Express lo
// intercepte sin ambigüedad (superadmin.js no conoce estas rutas y caerían en su 404).
app.use('/superadmin/otros', dbFixesRoutes);
// Mismo criterio: /superadmin/tasks va antes de /superadmin para que Express lo
// intercepte sin ambigüedad. El feature flag se chequea dentro del router.
if (process.env.TASK_TEMPLATES_ENABLED !== 'false') {
  app.use('/superadmin/tasks', tasksRoutes);
}
app.use('/superadmin',  superadminRoutes);
app.use('/directivo',   directivoRoutes);
app.use('/preceptor',   preceptorRoutes);
app.use('/suggestions', suggestionRoutes);

// ── Manejador de errores global ──────────────────────────────────────────────
// Captura cualquier error no manejado en los middlewares/rutas.
// Sin esto, un error inesperado puede colgar la request sin responder al cliente.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  logger.error(`${req.method} ${req.path}`, {
    status,
    error:  err.message,
    stack:  err.stack,
    user:   res.locals.user?._id,
    ip:     req.ip,
  });
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: err.message || 'Error del servidor' });
  }
  res.status(status).send(status === 404 ? 'Página no encontrada' : 'Error del servidor');
});

// ── Captura de errores no manejados ─────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Inicio del servidor (espera a que MongoDB esté listo) ────────────────────
connectDB().then(() => {
  const server = app.listen(PORT, () => {
    logger.info(`Servidor iniciado en puerto ${PORT} (PID ${process.pid})`);
  });

  const shutdown = (signal) => {
    logger.info(`Cerrando servidor por ${signal} (PID ${process.pid})`);
    server.close(() => {
      logger.info('Servidor cerrado correctamente.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
});
