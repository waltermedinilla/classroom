// Rate limiters compartidos. Se definen acá (no en server.js) para poder aplicarse
// inline en las rutas específicas que realmente los necesitan (ej: solo endpoints con
// multer), en vez de con `app.use('/prefix', ...)` que golpea TODA la sub-app y bloquea
// también los GET normales. Ver historia: 2026-07-28 — alumnos y docentes veían
// "Error al cargar notas" y no cargaban actividades/novedades porque el uploadLimiter
// se aplicaba a todo `/activities` y `/announcements`, incluyendo lecturas.
const rateLimit = require('express-rate-limit');

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

module.exports = { uploadLimiter };
