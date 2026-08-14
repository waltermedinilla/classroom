const mongoose = require('mongoose');

// Una muestra por MINUTO y por WORKER del consumo del rate limit general.
//
// ── Por qué lleva `pid` ──────────────────────────────────────────────────────
// ecosystem.config.js levanta `instances: 2` en modo cluster, y express-rate-limit usa un
// MemoryStore que vive DENTRO de cada worker: hay dos contadores independientes para la
// misma IP. Sin el pid en la clave, los dos workers se pisarían el documento del minuto y
// el número quedaría a merced de cuál escribió último. Con el pid, cada uno escribe el
// suyo y el endpoint los SUMA al consultar (ver services/rateLimitStats.js).
//
// El corolario incómodo de esa arquitectura: el techo efectivo real es ~2x el `max`
// configurado, porque una IP recibe 429 recién cuando el worker que le tocó agotó su
// cuenta. Esta colección es la que lo va a hacer visible. La solución de fondo sería un
// store compartido para el limiter; está anotada como D-03 en
// specs/monitor-ratelimit.spec.md y NO se hizo.
const rateLimitSampleSchema = new mongoose.Schema({
  // Inicio del minuto, truncado (segundos y ms en cero). Es la unidad de agregación.
  minuto:     { type: Date,   required: true },
  // Worker que escribió esta muestra (process.pid)
  pid:        { type: Number, required: true },

  // Requests que el limiter contó y dejó pasar durante ese minuto
  pasadas:    { type: Number, default: 0 },
  // Requests rechazadas con 429. Se cuentan desde el `handler` del limiter y no desde un
  // middleware posterior: al agotarse el cupo, el limiter responde y NO llama a next(),
  // así que para cualquier middleware de más abajo esas requests no existen.
  bloqueadas: { type: Number, default: 0 },

  // Mayor `used` visto en el minuto: qué tan cerca del techo se llegó.
  picoUsado:  { type: Number, default: 0 },
  // IP que provocó ese pico. Es lo único que distingue "toda la escuela navegando" de "un
  // script suelto", que es la única pregunta accionable cuando el número se dispara.
  // Se guarda SOLO la del pico del minuto, no todas las vistas (decisión D-01, aprobada
  // por el usuario el 2026-08-13).
  picoIp:     { type: String, default: '' },

  // Claves (IPs) distintas vistas en el minuto por este worker
  claves:     { type: Number, default: 0 },

  // Config vigente cuando se tomó la muestra. Guardarla permite dibujar el techo histórico
  // y ver en qué punto se cambió, en vez de comparar contra el valor de hoy y malinterpretar
  // los datos viejos (el `max` ya pasó por 400 → 1200 → 12000).
  limite:     { type: Number },
  ventanaMs:  { type: Number },

  // Índice TTL: la telemetría se borra sola a los 14 días. Alcanza para comparar dos
  // semanas de clase y mantiene la colección chica (2 workers x 1440 min = 2880 docs/día).
  createdAt:  { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 },
});

// Único: el volcado hace upsert sobre esta clave, así que dos flushes del mismo minuto
// acumulan en el mismo documento en vez de duplicarlo.
rateLimitSampleSchema.index({ minuto: 1, pid: 1 }, { unique: true });

module.exports = mongoose.model('RateLimitSample', rateLimitSampleSchema);
