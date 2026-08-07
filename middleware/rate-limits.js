// Rate limiters compartidos. Se definen acá (no en server.js) para poder aplicarse
// inline en las rutas específicas que realmente los necesitan (ej: solo endpoints con
// multer), en vez de con `app.use('/prefix', ...)` que golpea TODA la sub-app y bloquea
// también los GET normales. Ver historia: 2026-07-28 — alumnos y docentes veían
// "Error al cargar notas" y no cargaban actividades/novedades porque el uploadLimiter
// se aplicaba a todo `/activities` y `/announcements`, incluyendo lecturas.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Sube archivos: 1800 requests/hora por IP. La escuela tiene ~300 personas detrás de la
// misma IP pública NAT (mismo motivo por el que authLimiter usa 3000, ver server.js);
// el valor original de 60/hora se agotaba en minutos y disparó el bug del 2026-07-28
// ("Error al cargar notas"). Se triplicó a 1800 para blindar contra picos de uso escolar
// (docentes subiendo recursos + alumnos entregando en simultáneo al arranque de clase)
// y evitar que un caso extremo vuelva a agotarlo. Un abuser real que sube 1800 archivos
// en una hora sigue siendo detectable.
const uploadLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             1800,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Límite de subidas alcanzado. Intentá de nuevo en 1 hora.' },
});

// Escritura en la sala en vivo: 10 mensajes por minuto POR USUARIO.
//
// El keyGenerator es lo importante acá, no el número. Todos los limiters de este proyecto
// cuentan por IP, y la escuela entera sale por una sola IP pública NAT (~300 personas): un
// límite por IP sobre el chat significaría que la clase de 2°3° deja sin escribir a la de
// 5°1°. Con la clave por usuario, el que abusa se limita a sí mismo.
//
// 10/min es holgado para una conversación real (un mensaje cada 6 segundos sostenido) y
// corta el spam de quien mantiene Enter apretado.
const roomMessageLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  // req.userId lo setea middleware/auth.js; el fallback por IP solo actuaría si esto se
  // montara sin requireAuth, cosa que routes/rooms.js no hace.
  //
  // El fallback pasa por ipKeyGenerator y no por req.ip pelado: express-rate-limit v8 rechaza
  // el arranque si no (ERR_ERL_KEY_GEN_IPV6). El helper normaliza las IPv6 a su /56, para que
  // un usuario con un prefijo entero a disposición no esquive el límite cambiando de dirección.
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  message:         { error: 'Esperá un momento antes de escribir de nuevo.' },
});

module.exports = { uploadLimiter, roomMessageLimiter };
