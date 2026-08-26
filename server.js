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
const { requestLog } = require('./middleware/request-log');
const { schoolCache } = require('./middleware/cache');
const {
  readRawState, getPendingState, promotePending, SYSTEM_OWNER_EMAIL,
} = require('./config/maintenance');
const {
  countActiveUsers, shouldPromote, minutesAgo, CHECK_INTERVAL_MS,
} = require('./services/maintenanceWindow');
const { logAudit } = require('./middleware/audit');
const rateLimitStats = require('./services/rateLimitStats');
// Zona horaria de la escuela: services/liveRoom.js es el UNICO duenio de la hora (ver el
// comentario de su bloque TZ). Se importa aca solo para publicarlo en res.locals.
const { fmt: schoolFmt, diaEscolar } = require('./services/liveRoom');
const School     = require('./models/School');
const Suggestion = require('./models/Suggestion');
const MessageRecipient   = require('./models/MessageRecipient');
const TemplateAssignment = require('./models/TemplateAssignment');
const Reserva            = require('./models/Reserva');
const APP_VERSION = require('./package.json').version;
const { INTEREST_LABELS, INTEREST_ICONS } = require('./config/interests');
const { SECTIONS_BY_KEY, isAllowed, sectionForPath, normalizePath } = require('./config/sections');
// Módulos opcionales por escuela: acá solo se publican en res.locals para que los navs y
// res.locals.can() los vean. El enforcement vive en middleware/modulos.js.
const { MODULOS, moduloActivo } = require('./config/modulos');

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
const roomRoutes         = require('./routes/rooms');
const announcementRoutes = require('./routes/announcements');
const activityRoutes     = require('./routes/activities');
const adminRoutes        = require('./routes/admin');
const sectionsRoutes     = require('./routes/sections');
const recursosRoutes     = require('./routes/recursos');
const reservasRoutes     = require('./routes/reservas');
const superadminRoutes   = require('./routes/superadmin');
const directivoRoutes    = require('./routes/directivo');
const preceptorRoutes    = require('./routes/preceptor');
const attendanceRoutes   = require('./routes/attendance');
const jefaturaRoutes     = require('./routes/jefatura');
const soeRoutes          = require('./routes/soe');
const backupRoutes       = require('./routes/backup');
const dbFixesRoutes      = require('./routes/dbFixes');
const suggestionRoutes   = require('./routes/suggestions');
const messageRoutes      = require('./routes/messages');
const messagesInboxRoutes = require('./routes/messagesInbox');
const diagnosticoRoutes   = require('./routes/diagnostico');
const auditRoutes        = require('./routes/audit');
const tasksRoutes        = require('./routes/tasks');
const rolesRoutes        = require('./routes/roles');

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

// Límite general: 12000 peticiones cada 15 minutos por IP.
//
// Historia del número: 400 → 1200 (2026-07-28) → 12000 (2026-08-13). Cada suba fue por lo
// mismo, y conviene dejarlo escrito para no volver a discutirlo: **toda la escuela sale por
// una sola IP pública NAT**, así que este cupo NO es por persona, es para las ~300 juntas.
// Con 1200 tocaban a 4 requests cada 15 minutos por cabeza — menos que abrir un curso y su
// solapa de actividades. 12000 son ~40 por persona, que cubre navegación activa real con
// margen para el arranque de clase (todos entrando a la misma hora).
//
// Sigue contando por IP a pedido del usuario (2026-08-13). La unidad correcta sería el
// usuario logueado, como en middleware/rate-limits.js, pero acá no se puede sin mover cosas:
// este limiter se monta en la línea ~174, ANTES de cookie-parser y de requireAuth, así que
// `req.userId` todavía no existe. Para cambiarlo habría que adelantar cookieParser y
// verificar el JWT dentro del keyGenerator. Queda anotado como la mejora de fondo.
//
// Lo que un tope alto NO deja desprotegido: los endpoints caros (subidas, mensajes, chat de
// la sala, autoasistencia) ya tienen su propio limiter POR USUARIO, y login/registro pasan
// por authLimiter. Este es la red de última instancia contra un script suelto.
// Rutas de la sala en vivo y de los paneles que la miran. Quedan FUERA de este limiter, y
// no es una optimización: es lo que evita que la feature tire abajo la aplicación entera.
// La sala se sostiene con un poll cada 4 s por persona; con 25 alumnos son ~375 requests por
// minuto, y como toda la escuela sale por una sola IP pública NAT (el motivo documentado de
// que authLimiter sea 3000), el cupo de 1200/15min se agota en poco más de tres minutos. Lo
// que se cae después no es el chat: es login, actividades y entregas para todos.
// La sala tiene su propio límite POR USUARIO en middleware/rate-limits.js, que es la unidad
// correcta para esto.
const LIVE_ROOM_PATHS = /^\/(courses\/[^/]+\/sala|(directivo|preceptor)\/en-vivo)(\/|$)/;

const RATE_LIMIT_MSG = { error: 'Demasiadas peticiones. Intentá de nuevo en 15 minutos.' };

const generalLimiter = rateLimit({
  windowMs:          15 * 60 * 1000, // Ventana de 15 minutos
  max:               12000,
  standardHeaders:   true,           // Incluye RateLimit-* en los encabezados
  legacyHeaders:     false,
  message:           RATE_LIMIT_MSG,
  skip: (req) => req.path.startsWith('/css/')
              || req.path.startsWith('/js/')      // No limita estáticos
              || LIVE_ROOM_PATHS.test(req.path),  // Ni el polling de la sala en vivo
  // El handler es el ÚNICO lugar donde se pueden contar los 429: al agotarse el cupo,
  // express-rate-limit responde acá y no llama a next(), así que para el middleware de
  // telemetría de más abajo esas requests no existen. Definirlo desactiva el envío
  // automático de `message`, por eso se responde a mano con el mismo cuerpo de siempre.
  handler: (req, res, _next, options) => {
    rateLimitStats.registrarBloqueo(req);
    res.status(options.statusCode).json(RATE_LIMIT_MSG);
  },
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
// upload-image, upload-submission-file, submit, announcements/create). Antes se aplicaba con
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

// ── Access log ───────────────────────────────────────────────────────────────
// Va ANTES del rate limiter y del static a propósito: así también quedan registrados los
// 429 (cupo agotado) y los 404 de assets, que son dos cosas que el usuario reporta como
// "no me anda" y que sin esto no dejan ninguna huella. Los estáticos en régimen normal no
// ensucian nada — el middleware solo registra los que fallan (ver RUIDOSAS).
//
// Va DESPUÉS de /health para no registrar el polling del propio script de deploy.
app.use(requestLog);

// Aplica límite general a todas las rutas dinámicas
app.use(generalLimiter);

// Telemetría del cupo, para la sección "Rate limit" de /superadmin/monitor. Va pegado al
// limiter porque lee el `req.rateLimit` que éste deja seteado, y solo mira: no decide nada
// ni puede fallar hacia afuera. Las rutas exentas por `skip` no pasan por acá, así que la
// métrica mide el tráfico que CONSUME CUPO, no el total.
app.use(rateLimitStats.registrarPaso);

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
    // ⚠️ `fetch` + `reset --hard`, NO `git pull`. El árbol de producción tiene que ser un
    // ESPEJO de origin/main: nadie edita código en el server, así que no hay nada local que
    // valga la pena conservar. `pull` hace un merge, y un merge se NIEGA a pisar archivos
    // modificados o sin seguimiento. Consecuencia: basta que el árbol se ensucie UNA vez
    // para que TODOS los deploys posteriores aborten en el mismo punto hasta que alguien
    // entre por SSH. `reset --hard` no tiene ese pudor — pisa modificados y sin seguimiento
    // por igual — así que el deploy se vuelve idempotente y se autorrepara.
    //
    // Pasó el 2026-08-08 y dejó producción tres commits atrás: un `git pull` anterior
    // corrido como root había escrito los archivos y muerto antes de mover HEAD, dejando
    // el árbol con los 15 archivos modificados de 1ac404a y sus 15 archivos nuevos sin
    // seguimiento. Cada deploy siguiente moría igual, en "Los cambios locales de los
    // siguientes archivos serán sobrescritos al fusionar".
    //
    // Esto además reemplaza al `git checkout -- package-lock.json` que iba acá antes:
    // `npm install` reescribe ese archivo generado y ensuciaba el árbol (bug del
    // 2026-07-29). El reset lo cubre junto con todo lo demás, sin caso especial.
    'git fetch origin || { echo "ERROR deploy: git fetch fallo"; exit 1; }',
    'git reset --hard origin/main || ' +
      '{ echo "ERROR deploy: git reset --hard fallo. Si dice Permiso denegado, hay archivos ' +
      `de root en el repo: chown -R walter:walter ${APP_DIR}"; exit 1; }`,
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
      school = await School.findById(schoolId).select('name color slug _id themes settings rolePermissions soeAccess modules').lean();
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
    jefe:       'Jefe de Sección',
    soe:        'SOE',
    student:    'Alumno',
  };
  res.locals.appVersion = APP_VERSION;
  // Formateador de fechas con la zona de la escuela, disponible en TODAS las vistas.
  // El servidor de produccion corre en UTC: sin esto, cada .ejs que llamaba a
  // toLocaleDateString por su cuenta imprimia tres horas de mas en vencimientos,
  // entregas y auditoria. Una sola fuente de hora para servidor y navegador
  // (la mitad del navegador la cubre public/js/fecha.js, alimentado por el mismo TZ).
  res.locals.fmt = schoolFmt;
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
  // ── Módulos opcionales por escuela (config/modulos.js) ──────────────────────
  // A diferencia de los dos flags de arriba, éstos NO salen del entorno sino de
  // School.modules: son por escuela. Se publican con el mismo nombre que el campo `flag`
  // de sus secciones en config/sections.js, que es lo que hace que res.locals.can() los
  // respete y esconda la solapa sola.
  //
  // ⚠️ El `!!` no es cosmético: can() compara `res.locals[flag] === false`, así que un
  // `undefined` —que es lo que devolvería el optional chaining de una escuela sin el
  // campo— NO esconde nada. Tiene que ser el booleano false, literal.
  for (const m of MODULOS) {
    res.locals[m.localsKey] = moduloActivo(res.locals.school, m.id);
  }
  // Helper único para las vistas: ¿este usuario ve esta solapa? Resuelve de una sola vez
  // el rol, los permisos que la escuela configuró en /superadmin/roles y el feature flag,
  // para que los *-nav.ejs no tengan que combinar tres condiciones distintas y se puedan
  // desincronizar entre sí. Es un closure: se evalúa recién al renderizar, cuando
  // res.locals.school y res.locals.user ya están resueltos por los middlewares de arriba.
  res.locals.can = (key) => {
    const sec = SECTIONS_BY_KEY[key];
    if (sec && sec.flag && res.locals[sec.flag] === false) return false;
    // Pantallas que administran UNA escuela: el superadmin no tiene escuela propia, así
    // que el nav de /admin le ofrecía Tema, Tareas y Plantillas y las tres morían en
    // "Escuela no encontrada". Se esconden en vez de dejar el callejón sin salida. La ruta
    // no cambia: sigue contestando lo mismo si se escribe la URL a mano.
    if (sec && sec.needsSchool && !(res.locals.user && res.locals.user.school)) return false;
    return isAllowed(res.locals.school, res.locals.user && res.locals.user.role, key);
  };
  // ── Analítica de producto (PostHog) ─────────────────────────────────────────
  // Apagada por default: sin POSTHOG_KEY en el entorno, res.locals.posthogKey queda
  // vacío y el partial partials/analytics-init.ejs no imprime nada — así el dev local
  // y los smoke tests (que nunca corren JS de navegador) no dependen de esto para nada.
  // POSTHOG_HOST default a la región EU (no la US) a propósito: esta es una plataforma
  // escolar con alumnos menores, y EU es la región con el compromiso de residencia de
  // datos más fuerte que ofrece PostHog Cloud.
  res.locals.posthogKey  = process.env.POSTHOG_KEY || '';
  res.locals.posthogHost = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';
  // Nombre de pantalla para la analítica: reusa las mismas claves del catálogo de
  // /superadmin/roles cuando la URL cae en una sección conocida (así "Importar" es
  // "admin_import" en el nav, en el 403 y en los reportes de PostHog), y cae a la URL
  // normalizada (con :id en vez del ObjectId real) para el resto de la app — dashboard
  // de materias, detalle de curso, login, perfil, etc.
  const _sec = sectionForPath(req.originalUrl);
  res.locals.screenKey = _sec ? _sec.key : normalizePath(req.originalUrl);
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
// Hay un TERCER estado, "en espera" (ver specs/mantenimiento-ventana.spec.md): el dueño ya
// pidió el mantenimiento pero la plataforma todavía tiene gente trabajando. En ese estado
// acá NO se bloquea nada — el corte se aplica solo a los ingresos nuevos, en routes/auth.js —
// y el promotor de más abajo lo asciende a mantenimiento real cuando se vacía.
//
// Se lee el estado crudo una sola vez (en vez de llamar a getMaintenanceState y después a
// getPendingState) para no duplicar el acceso a disco en cada request.
app.use((req, res, next) => {
  const raw = readRawState();

  // Bandera para el banner opcional de los que YA están adentro. Siempre definida: la
  // incluyen todas las vistas a través de partials/header.ejs.
  res.locals.maintenancePending = null;

  if (raw && raw.pending === true && raw.active !== true) {
    if (raw.notifyActiveUsers && res.locals.user
        && res.locals.user.email !== SYSTEM_OWNER_EMAIL) {
      res.locals.maintenancePending = { message: raw.message, eta: raw.eta };
    }
    return next(); // una espera NUNCA le corta el trabajo a quien ya está adentro
  }

  const state = raw && raw.active === true ? raw : null;
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
  // Marca para el access log: este 503 es DELIBERADO, no una falla. Sin esto, una ventana
  // de mantenimiento escribiría un ERROR por cada request que llega — con la plataforma
  // entera rebotando, error.log quedaría sepultado en alarmas falsas justo el día que más
  // hace falta leerlo. Ver middleware/request-log.js.
  res.locals.mantenimiento = true;
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(503).json({ maintenance: true, message: state.message, eta: state.eta });
  }
  res.status(503).render('maintenance', { message: state.message, eta: state.eta });
});

// ── Bandeja del sobre: contador de cosas sin leer ───────────────────────────
// Inyecta los contadores del badge del sobre del header. Son DOS fuentes:
//   unreadSuggestionCount → respuestas del equipo a sugerencias propias
//   unreadMessageCount    → mensajes del superadmin sin abrir, o con respuesta nueva
//   unreadInboxCount      → la suma, que es lo que pinta el header
//
// unreadSuggestionCount se conserva con su nombre y su significado de siempre: ya lo
// consumen vistas y specs de humo, y renombrarlo no compraba nada.
//
// Mismo patrón defensivo que el resto de los middlewares globales: try/catch que nunca
// puede tumbar una request, y un killswitch por env var para apagar cada fuente sin
// redeploy si algún día hiciera falta (ej. sospecha de que la query pesa en producción
// bajo carga — no debería, las dos van por índice, pero la opción de apagarlas en
// caliente no cuesta nada tenerla).
//
// Las dos cuentas van en Promise.all y no en serie: este middleware corre en CADA request,
// así que su costo es el de la más lenta, no la suma de las dos.
const SUGGESTIONS_INBOX_ENABLED = process.env.SUGGESTIONS_INBOX_ENABLED !== 'false';
const MESSAGES_ENABLED          = process.env.MESSAGES_ENABLED !== 'false';
app.use(async (req, res, next) => {
  res.locals.unreadSuggestionCount = 0;
  res.locals.unreadMessageCount    = 0;

  if (res.locals.user) {
    const uid = res.locals.user._id;
    const [sugerencias, mensajes] = await Promise.all([
      SUGGESTIONS_INBOX_ENABLED
        ? Suggestion.countDocuments({ user: uid, status: 'answered', readByUser: false })
            .catch(() => 0)
        : 0,
      MESSAGES_ENABLED
        // Sin abrir (readAt null) O con una respuesta nueva del superadmin sobre uno ya
        // leído (unreadForUser). Sin la segunda condición, contestar un hilo ya leído no
        // encendería el badge nunca.
        ? MessageRecipient.countDocuments({
            user: uid,
            $or:  [{ readAt: null }, { unreadForUser: true }],
          }).catch(() => 0)
        : 0,
    ]);
    // Si una de las dos falló se queda en 0 y la otra sigue contando: el sobre nunca rompe
    // la página, y una feature caída no se lleva puesta a la otra.
    res.locals.unreadSuggestionCount = sugerencias;
    res.locals.unreadMessageCount    = mensajes;
  }

  res.locals.unreadInboxCount =
    res.locals.unreadSuggestionCount + res.locals.unreadMessageCount;
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

// ── Reservas de recursos esperando resolución ───────────────────────────────
// Inyecta res.locals.pendingReservas para el punto rojo de la solapa "Recursos". Mismo patrón
// que el de arriba, con las mismas dos condiciones: solo para el admin de una escuela, y solo
// si el módulo está prendido para esa escuela (si no, la solapa ni existe).
//
// Se cuentan solo los pedidos de HOY EN ADELANTE: un pendiente de la semana pasada ya no se
// puede aprobar —la clase pasó— y un badge que nunca baja deja de significar algo.
// Índice {school:1, status:1, date:1} en Reserva: la query es sub-milisegundo.
app.use(async (req, res, next) => {
  res.locals.pendingReservas = 0;
  const u = res.locals.user;
  if (u && u.role === 'admin' && u.school && res.locals.recursosEnabled) {
    try {
      res.locals.pendingReservas = await Reserva.countDocuments({
        school: u.school, status: 'pendiente', date: { $gte: diaEscolar() },
      });
    } catch {
      // Si falla el conteo, el badge no aparece y listo. Nunca puede tirar la request.
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
  // El jefe de sección, igual: en /courses solo vería las materias donde alguien lo haya
  // inscripto, que no es su trabajo. Su panel es el seguimiento de sus secciones.
  if (res.locals.user.role === 'jefe') return res.redirect('/jefatura');
  // El SOE cae en su panel de legajos. Mismo motivo que los tres de arriba: en /courses no
  // tiene nada suyo. Su trabajo son los alumnos de la escuela, no las materias.
  if (res.locals.user.role === 'soe') return res.redirect('/soe');
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
// La sala en vivo va ANTES que courseRoutes. No hay colisión real (sus paths tienen el
// segmento /sala y el GET /courses/:id es de un solo segmento), pero el orden explícito evita
// que una ruta nueva en courses.js se coma /courses/:id/sala sin que nadie lo note.
app.use('/courses',    roomRoutes);
app.use('/courses',    courseRoutes);
app.use('/announcements', announcementRoutes);
app.use('/activities', activityRoutes);
// Auditoría: define rutas absolutas (/admin/audit y /superadmin/audit). Se monta
// ANTES de adminRoutes/superadminRoutes para que intercepte esas rutas antes de
// caer en el 404 de los otros routers (que no las conocen).
app.use('/',            auditRoutes);
// Secciones: va ANTES de /admin porque gana el primero que matchea. El router de admin
// exige rol admin para todo el panel; este deja entrar además al Jefe de Sección, acotado
// a las secciones que tiene a cargo. Si se montara después, nunca llegaría un request.
app.use('/admin/secciones', sectionsRoutes);
// Recursos: mismo criterio que /admin/secciones — va ANTES de /admin porque gana el primero
// que matchea, y este router tiene su propia guarda de módulo (requireModulo) que el panel de
// admin no conoce. Montado después, adminRoutes se comería el request y contestaría su 404.
app.use('/admin/recursos', recursosRoutes);
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
// Mismo criterio de montaje que /backup y /otros: antes de /superadmin, que es catch-all.
app.use('/superadmin/roles', rolesRoutes);
// Idem. El killswitch se chequea además DENTRO del router, para que montarlo sin condición
// nunca abra la feature por accidente.
if (process.env.MESSAGES_ENABLED !== 'false') {
  app.use('/superadmin/messages', messageRoutes);
}
app.use('/superadmin',  superadminRoutes);
app.use('/directivo',   directivoRoutes);
// La asistencia va ANTES de /preceptor, con el mismo criterio que /superadmin/backup y
// compañía: sin este orden el request atraviesa igual toda la cadena de preceptorRoutes
// —incluido loadPreceptorScope, que consulta divisiones— antes de caer acá, y paga esa
// query dos veces. No rompe nada, pero es trabajo al pedo en cada request.
app.use('/preceptor/asistencia', attendanceRoutes.panelRouter);
app.use('/preceptor',   preceptorRoutes);
// Las dos rutas del ALUMNO para darse la asistencia. Van por separado del panel: no pasan
// por requirePreceptor ni por el alcance por divisiones — validan por su cuenta que quien
// llama sea alumno y esté en la nómina de esa toma.
app.use('/asistencia',  attendanceRoutes.alumnoRouter);
app.use('/jefatura',    jefaturaRoutes);
app.use('/soe',         soeRoutes);
// El lado del docente del módulo de recursos. Va suelto en la raíz (y no bajo /admin) porque
// no es una pantalla de administración: la usa quien da clase.
app.use('/reservas',    reservasRoutes);
app.use('/suggestions', suggestionRoutes);
// Bandeja del destinatario de los mensajes del superadmin. El panel del que ENVÍA se monta
// más arriba, junto al resto de los sub-routers de /superadmin.
app.use('/messages',    messagesInboxRoutes);
// Reportes de falla que el navegador manda porque el servidor no puede verlos solo — hoy,
// subidas que se cortaron en camino y por lo tanto no dejaron línea en el access log.
app.use('/diagnostico', diagnosticoRoutes);

// ── Manejador de errores global ──────────────────────────────────────────────
// Captura cualquier error no manejado en los middlewares/rutas.
// Sin esto, un error inesperado puede colgar la request sin responder al cliente.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  logger.error(`${req.method} ${req.path}`, {
    requestId: req.id || null,
    status,
    error:  err.message,
    stack:  err.stack,
    user:   res.locals.user?._id,
    ip:     req.ip,
  });
  // El id viaja también en la RESPUESTA. Es lo que convierte un reporte de "me dio error"
  // en algo accionable: el usuario copia esa referencia y con
  // `grep <id> logs/combined.log` sale la request entera —access log, rechazos y stack—
  // sin tener que reconstruir qué estaba haciendo y a qué hora.
  const ref = req.id ? ` (ref: ${req.id})` : '';
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(status).json({ error: err.message || 'Error del servidor', requestId: req.id || null });
  }
  res.status(status).send(status === 404 ? 'Página no encontrada' : `Error del servidor${ref}`);
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

  // Node corta cualquier request que tarde más de 5 min en llegar completa (default de
  // requestTimeout). Subir un backup de varios cientos de MB desde una conexión hogareña
  // se pasa de largo y el corte se ve como "error de conexión" a mitad de la subida.
  // headersTimeout sigue en el default (65 s), que es lo que frena un slowloris de headers.
  server.requestTimeout = 60 * 60 * 1000; // 1 h

  // ── Promotor de la ventana de mantenimiento ────────────────────────────────
  // Mira cada 30 s si la plataforma ya se vació para activar el mantenimiento que el dueño
  // dejó EN ESPERA. Sin espera pedida no hace ni una query: solo la lectura del archivo de
  // estado, que son unos pocos bytes (la misma que ya hace el middleware de arriba).
  //
  // Corre en UN SOLO worker. Con los 2 de PM2 ejecutándolo, ambos podrían leer "hay espera"
  // en el mismo tick y escribir dos eventos de auditoría para una única promoción. PM2 setea
  // NODE_APP_INSTANCE en modo cluster; en dev queda undefined y corre igual.
  const schedulerWorker = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';

  async function checkMaintenanceWindow() {
    const pending = getPendingState();
    if (!pending) return;

    const now = new Date();
    const { count } = await countActiveUsers({ idleMinutes: pending.idleMinutes, now });
    const { promote, why } = shouldPromote({ pending, activeCount: count, now });
    if (!promote) return;

    promotePending(pending, why);
    const espero = minutesAgo(pending.requestedAt, now);
    logger.info(`Mantenimiento activado automáticamente (${why}) tras ${espero} min de espera`);

    // logAudit espera un req; acá no hay uno. El shim le da el actor (quien programó la
    // ventana) y el helper ya tolera que no haya ip ni user-agent.
    logAudit(
      { res: { locals: { user: { email: pending.requestedBy, name: 'Mantenimiento automático', role: 'superadmin' } } } },
      'system.maintenance_on', [],
      { automatico: true, motivo: why, esperoMinutos: espero },
    );
  }

  if (process.env.MAINTENANCE_SCHEDULER !== 'false' && schedulerWorker) {
    const timer = setInterval(() => {
      // Si Mongo no responde NO se promueve: activar un mantenimiento por no haber podido
      // contar sería exactamente lo contrario de esperar a que la gente termine.
      checkMaintenanceWindow().catch(err => {
        logger.warn('No se pudo evaluar la ventana de mantenimiento', { error: err.message });
      });
    }, CHECK_INTERVAL_MS);
    timer.unref(); // no demora el shutdown
    logger.info(`Promotor de mantenimiento activo (cada ${CHECK_INTERVAL_MS / 1000}s, PID ${process.pid})`);
  }

  // ── Telemetría del rate limit ──────────────────────────────────────────────
  // Vuelca a Mongo cada minuto lo que el worker acumuló en memoria. Corre en TODOS los
  // workers (a diferencia del promotor de mantenimiento): cada uno tiene su propio contador
  // de rate limit y su propia porción del tráfico, así que si uno no volcara, su parte
  // simplemente no existiría en el gráfico.
  rateLimitStats.iniciarVolcado();

  const shutdown = (signal) => {
    logger.info(`Cerrando servidor por ${signal} (PID ${process.pid})`);
    // Último volcado antes de cerrar: sin esto se pierde el minuto en curso en cada deploy,
    // y los deploys son justo el momento en el que uno mira estos números.
    rateLimitStats.volcar().catch(() => {});
    server.close(() => {
      logger.info('Servidor cerrado correctamente.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
});
