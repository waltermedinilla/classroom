// Telemetría del rate limit general: cuánto del cupo se consume, cuántos 429 hubo y quién
// provocó el pico. Alimenta la sección "Rate limit" de /superadmin/monitor.
//
// Ver specs/monitor-ratelimit.spec.md. Nació del 2026-08-13, cuando el cupo se agotó
// corriendo dos suites seguidas y no había forma de contestar "¿qué tan cerca del techo
// venimos en un día normal de clase?" — la única huella de un 429 era una línea warn.
//
// ⚠️ REGLA DE ORO DE ESTE ARCHIVO: esto es telemetría. Si algo falla acá (Mongo caído, un
// campo inesperado), se descarta la muestra y la aplicación sigue. Nada de lo que pasa en
// este módulo puede tumbar un request. Mismo criterio que el `disk = null` de /monitor/stats.
const RateLimitSample = require('../models/RateLimitSample');

// Cada cuánto se vuelcan a Mongo los contadores en memoria.
const VOLCADO_MS = 60 * 1000;

/* ─── Parte pura (testeable sin Mongo ni HTTP) ─────────────────────────────── */

// Inicio del minuto al que pertenece una fecha. Es la unidad de agregación: sin truncar,
// cada muestra caería en su propio milisegundo y no habría nada que sumar.
function truncarAlMinuto(fecha) {
  const d = new Date(fecha);
  d.setSeconds(0, 0);
  return d;
}

// Rangos que acepta el endpoint. El bucket crece con la ventana para no mandarle 10080
// puntos al navegador cuando se piden 7 días.
const RANGOS = {
  '1h':  { ventanaMin: 60,        bucketMin: 1  },
  '6h':  { ventanaMin: 60 * 6,    bucketMin: 5  },
  '24h': { ventanaMin: 60 * 24,   bucketMin: 15 },
  '7d':  { ventanaMin: 60 * 24 * 7, bucketMin: 60 },
};

const rangoValido = (rango) => Object.prototype.hasOwnProperty.call(RANGOS, rango);

// Devuelve la config del rango, cayendo en '1h' si viene basura por la query string.
function configDeRango(rango) {
  return RANGOS[rango] || RANGOS['1h'];
}

// Agrupa las muestras crudas (una por minuto y por worker) en los puntos que se dibujan.
//
// Acá es donde se resuelve el problema del cluster: las muestras de los DOS workers para el
// mismo minuto se SUMAN en un solo punto. Graficar la lectura de un worker suelto daría un
// diente de sierra sin significado, porque el round-robin decide cuál contesta cada refresco.
//
// `picoUsado` se agrega con máximo y no con suma: es "qué tan cerca del techo llegó una IP",
// y sumar los picos de dos workers daría un número que no le pasó a nadie.
function agregarSerie(muestras, bucketMin) {
  const bucketMs = bucketMin * 60 * 1000;
  const porBucket = new Map();

  (muestras || []).forEach(m => {
    const ms    = new Date(m.minuto).getTime();
    const clave = Math.floor(ms / bucketMs) * bucketMs;
    const punto = porBucket.get(clave) || {
      t: new Date(clave), pasadas: 0, bloqueadas: 0, picoUsado: 0, picoIp: '',
    };
    punto.pasadas    += m.pasadas    || 0;
    punto.bloqueadas += m.bloqueadas || 0;
    if ((m.picoUsado || 0) > punto.picoUsado) {
      punto.picoUsado = m.picoUsado || 0;
      punto.picoIp    = m.picoIp    || '';
    }
    porBucket.set(clave, punto);
  });

  return [...porBucket.values()].sort((a, b) => a.t - b.t);
}

// Números de cabecera: lo que se lee de un vistazo sin mirar el gráfico.
function resumirMuestras(muestras) {
  const lista = muestras || [];
  let bloqueadasTotal = 0, picoMaximo = 0, picoIp = '', ultimoBloqueo = null;
  // pids POR MINUTO, no del rango entero: contar los distintos de toda la ventana daría
  // 5 "workers" en un día con cuatro deploys, porque cada reinicio estrena PID. Lo que
  // interesa es la concurrencia real —cuántos procesos atendían A LA VEZ—, porque de eso
  // depende el techo efectivo (cada worker tiene su propio cupo), y eso es el máximo de
  // pids distintos vistos dentro de un mismo minuto.
  const pidsPorMinuto = new Map();

  lista.forEach(m => {
    bloqueadasTotal += m.bloqueadas || 0;
    if ((m.picoUsado || 0) > picoMaximo) {
      picoMaximo = m.picoUsado || 0;
      picoIp     = m.picoIp    || '';
    }
    if ((m.bloqueadas || 0) > 0) {
      const t = new Date(m.minuto);
      if (!ultimoBloqueo || t > ultimoBloqueo) ultimoBloqueo = t;
    }
    if (m.pid != null) {
      const clave = new Date(m.minuto).getTime();
      if (!pidsPorMinuto.has(clave)) pidsPorMinuto.set(clave, new Set());
      pidsPorMinuto.get(clave).add(m.pid);
    }
  });

  const workers = Math.max(0, ...[...pidsPorMinuto.values()].map(s => s.size));

  // El límite se lee de la muestra más reciente que lo tenga: el `max` cambió en el pasado
  // (400 → 1200 → 12000) y el techo que corresponde dibujar es el vigente, no el de hoy
  // aplicado hacia atrás.
  const conLimite = lista.filter(m => m.limite != null);
  const limite    = conLimite.length ? conLimite[conLimite.length - 1].limite : null;

  return { bloqueadasTotal, ultimoBloqueo, picoMaximo, picoIp, limite, workers };
}

/* ─── Parte con estado (contadores del worker) ─────────────────────────────── */

// minutoISO → { pasadas, bloqueadas, picoUsado, picoIp, ips:Set, limite, ventanaMs }
// Se acumula por minuto y no en un único contador porque el volcado corre cada 60s sin
// estar alineado con el borde del minuto: un flush cualquiera puede tener datos de dos.
const buffer = new Map();
let timer = null;

function baldeDe(fecha) {
  const clave = truncarAlMinuto(fecha).toISOString();
  if (!buffer.has(clave)) {
    buffer.set(clave, {
      pasadas: 0, bloqueadas: 0, picoUsado: 0, picoIp: '',
      ips: new Set(), limite: null, ventanaMs: null,
    });
  }
  return buffer.get(clave);
}

// Middleware. Va montado INMEDIATAMENTE DESPUÉS del generalLimiter en server.js: lee el
// `req.rateLimit` que éste deja seteado ({ limit, used, remaining, resetTime }).
//
// No hace nada si el limiter no corrió (rutas exentas por `skip`: estáticos y el polling de
// la sala en vivo). Eso significa que esta métrica NO refleja el tráfico total del servidor
// sino el que consume cupo — la vista tiene que decirlo, o el número engaña.
function registrarPaso(req, res, next) {
  try {
    const rl = req.rateLimit;
    if (rl) {
      const b = baldeDe(new Date());
      b.pasadas++;
      b.ips.add(req.ip);
      if ((rl.used || 0) > b.picoUsado) {
        b.picoUsado = rl.used || 0;
        b.picoIp    = req.ip || '';
      }
      if (rl.limit != null) b.limite = rl.limit;
      if (rl.resetTime)     b.ventanaMs = Math.max(0, new Date(rl.resetTime) - Date.now());
    }
  } catch { /* telemetría: nunca romper el request */ }
  next();
}

// Se llama desde el `handler` del limiter, NO desde un middleware. Cuando el cupo se agota,
// express-rate-limit responde el 429 y no llama a next(): para cualquier middleware de más
// abajo esas requests no existen, y contarlas ahí daría siempre cero — justo el número que
// importa.
function registrarBloqueo(req) {
  try {
    const b = baldeDe(new Date());
    b.bloqueadas++;
    b.ips.add(req.ip);
    const rl = req.rateLimit;
    if (rl?.limit != null) b.limite = rl.limit;
    if ((rl?.used || 0) > b.picoUsado) {
      b.picoUsado = rl.used;
      b.picoIp    = req.ip || '';
    }
  } catch { /* idem */ }
}

// Vuelca a Mongo lo acumulado y limpia el buffer. Exportada para poder llamarla desde los
// tests y en el apagado del proceso sin esperar al intervalo.
async function volcar() {
  if (buffer.size === 0) return 0;

  // Se vacía ANTES de escribir: si Mongo falla, se pierde un minuto de telemetría y no se
  // acumula un buffer que crece sin techo mientras la base está caída.
  const pendientes = [...buffer.entries()];
  buffer.clear();

  let escritas = 0;
  for (const [minutoISO, b] of pendientes) {
    try {
      const minuto = new Date(minutoISO);
      await RateLimitSample.updateOne(
        { minuto, pid: process.pid },
        {
          $inc: { pasadas: b.pasadas, bloqueadas: b.bloqueadas },
          // $max y no $set: si este minuto ya se volcó antes, el pico que vale es el mayor
          // de los dos, no el del último flush.
          $max: { picoUsado: b.picoUsado, claves: b.ips.size },
          $set: {
            ...(b.limite    != null ? { limite: b.limite }       : {}),
            ...(b.ventanaMs != null ? { ventanaMs: b.ventanaMs } : {}),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      // La IP del pico va en un segundo paso condicionado: $max ya dejó `picoUsado` en el
      // mayor de los dos valores, así que la condición `picoUsado: b.picoUsado` solo matchea
      // si el pico ganador es el de ESTE flush. Sin esto, un flush con pico menor podría
      // dejar su IP pegada al pico de otro.
      if (b.picoIp) {
        await RateLimitSample.updateOne(
          { minuto, pid: process.pid, picoUsado: b.picoUsado },
          { $set: { picoIp: b.picoIp } },
        );
      }
      escritas++;
    } catch { /* Mongo caído: se descarta la muestra y se sigue */ }
  }
  return escritas;
}

// Arranca el volcado periódico. Se llama explícitamente desde server.js y NO al requerir el
// módulo: si arrancara solo, los tests unitarios quedarían con un timer colgado.
function iniciarVolcado(ms = VOLCADO_MS) {
  if (timer) return timer;
  timer = setInterval(() => { volcar(); }, ms);
  // unref: un intervalo de telemetría no puede ser el motivo de que el proceso no cierre.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function detenerVolcado() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Solo para tests: mirar y limpiar el buffer sin tocar Mongo.
function _buffer() { return buffer; }
function _reset()  { buffer.clear(); detenerVolcado(); }

module.exports = {
  truncarAlMinuto, rangoValido, configDeRango, agregarSerie, resumirMuestras,
  registrarPaso, registrarBloqueo, volcar, iniciarVolcado, detenerVolcado,
  RANGOS, VOLCADO_MS, _buffer, _reset,
};
