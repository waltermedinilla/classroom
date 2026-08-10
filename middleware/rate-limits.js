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

// Envío de mensajes del superadmin: 20 por hora POR USUARIO.
//
// Un solo envío puede crear cientos de documentos (uno por destinatario), así que el límite
// acá no protege contra el spam de texto sino contra la escritura en masa: un doble click
// sostenido o un script suelto. 20/hora es holgadísimo para el uso real —nadie manda 20
// comunicados en una hora— y deja el daño de un accidente en algo que se limpia.
//
// Por usuario y no por IP, mismo motivo que roomMessageLimiter: la escuela entera sale por
// una sola IP pública NAT.
const messageSendLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  message:         { error: 'Llegaste al límite de envíos por hora. Probá de nuevo más tarde.' },
});

// Respuesta del destinatario a un mensaje: 10 por minuto POR USUARIO. Calcado de
// roomMessageLimiter, y por lo mismo: con clave por IP, un alumno respondiendo dejaría sin
// escribir al resto de la escuela.
const messageReplyLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  message:         { error: 'Esperá un momento antes de escribir de nuevo.' },
});

// Alumno dándose la asistencia: 10 cada 5 minutos POR USUARIO.
//
// El uso legítimo es UNA vez por día, pero llega concentrado: 400 chicos tocando el botón
// entre 7:25 y 7:35. Por eso el límite no busca frenar el volumen normal —para eso está el
// generalLimiter— sino el doble click, el F5 nervioso y las dos pestañas abiertas. Con 10 en
// 5 minutos, nadie que use el botón como se debe lo ve nunca.
//
// Por usuario y no por IP, mismo motivo que roomMessageLimiter: la escuela entera sale por
// una sola IP pública NAT, y con clave por IP el primer curso que entre dejaría al resto sin
// poder darse la asistencia.
const attendanceCheckinLimiter = rateLimit({
  windowMs:        5 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  message:         { error: 'Esperá un momento antes de volver a intentar.' },
});

module.exports = {
  uploadLimiter, roomMessageLimiter, messageSendLimiter, messageReplyLimiter,
  attendanceCheckinLimiter,
};
