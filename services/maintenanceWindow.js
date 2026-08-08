// Ventana de mantenimiento: decidir CUÁNDO se puede bloquear la plataforma sin cortarle
// el trabajo a nadie. Ver specs/mantenimiento-ventana.spec.md.
//
// La lógica que depende del paso del tiempo vive acá, con `now` inyectable, por el mismo
// motivo que services/liveRoom.js: probar "esperá 5 minutos a que se vaya el último" con
// una request real significaría esperar 5 minutos de verdad.
//
// La señal de "hay alguien trabajando" es User.lastSeen, que middleware/auth.js ya escribe
// en cada request con throttle de 1 minuto. No se inventa una señal nueva: cualquier
// navegación real —incluido el poll de la sala en vivo, que pasa por el mismo middleware—
// la refresca.

const User = require('../models/User');
const { SYSTEM_OWNER_EMAIL } = require('../config/maintenance');

// Silencio que cuenta como "esta persona ya no está trabajando". 5 min es holgado con un
// throttle de lastSeen de 1 min: 4 minutos de margen para que nadie quede marcado como
// ido por estar leyendo una consigna larga.
const IDLE_DEFAULT_MIN = 5;
// Menos de 1 minuto no tiene sentido: lastSeen se escribe como máximo una vez por minuto
// (middleware/auth.js), así que una ventana más corta daría "no hay nadie" con gente
// navegando. Si alguien sube ese throttle, este mínimo tiene que subir con él.
const IDLE_MIN_MIN = 1;
const IDLE_MAX_MIN = 60;

// Tope del tope de espera: 24 h.
const MAX_WAIT_MAX_MIN = 1440;

// Cada cuánto mira el promotor si la plataforma se vació (server.js).
const CHECK_INTERVAL_MS = 30_000;

// Cuánta gente lista el panel. "3 personas" no ayuda a decidir; "Ana (docente), hace 0 min"
// sí. Más de 25 nombres tampoco se leen.
const ACTIVITY_LIST_MAX = 25;

// ─── Puras ───────────────────────────────────────────────────────────────────

// Acepta basura (undefined, '', 'abc', 0) y devuelve el default; un negativo se recorta al
// mínimo en vez de caer al default, porque "-3" es una intención de poco tiempo, no un
// campo vacío.
function normalizeIdleMinutes(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n === 0) return IDLE_DEFAULT_MIN;
  return Math.min(IDLE_MAX_MIN, Math.max(IDLE_MIN_MIN, n));
}

// null = esperar lo que haga falta (es el default: el usuario pidió "que espere").
function normalizeMaxWait(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_WAIT_MAX_MIN, n);
}

// Momento a partir del cual un lastSeen cuenta como "está trabajando ahora".
function activityCutoff(idleMinutes, now = new Date()) {
  return new Date(now.getTime() - normalizeIdleMinutes(idleMinutes) * 60 * 1000);
}

// Borde INCLUSIVO: un lastSeen de exactamente `idleMinutes` atrás todavía cuenta como
// activo (misma convención que isOnline() en services/liveRoom.js).
function countsAsActive(lastSeen, idleMinutes, now = new Date()) {
  if (!lastSeen) return false;
  const t = new Date(lastSeen).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= activityCutoff(idleMinutes, now).getTime();
}

// Cuándo se activa el mantenimiento aunque siga habiendo gente (RN-09). null = nunca.
function deadlineOf(pending) {
  if (!pending || !pending.maxWaitMinutes) return null;
  const start = new Date(pending.requestedAt).getTime();
  // Un requestedAt roto NO puede derivar en una fecha inválida: `new Date(NaN) > now` es
  // false, pero cualquier comparación posterior sería impredecible. Sin fecha, no hay tope.
  if (!Number.isFinite(start)) return null;
  return new Date(start + pending.maxWaitMinutes * 60 * 1000);
}

// La decisión completa: ¿ya se puede bloquear?
function shouldPromote({ pending, activeCount, now = new Date() }) {
  if (!pending) return { promote: false, why: null };
  // Un conteo que no es un número (query fallida, undefined) NO promueve: activar un
  // mantenimiento por no haber podido contar sería exactamente lo contrario de esperar.
  if (Number.isFinite(activeCount) && activeCount <= 0) {
    return { promote: true, why: 'empty' };
  }
  const deadline = deadlineOf(pending);
  if (deadline && now.getTime() >= deadline.getTime()) {
    return { promote: true, why: 'deadline' };
  }
  return { promote: false, why: null };
}

// Minutos enteros transcurridos. Una fecha futura o basura da 0 (nunca negativo).
function minutesAgo(date, now = new Date()) {
  if (!date) return 0;
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return 0;
  const diff = now.getTime() - t;
  return diff <= 0 ? 0 : Math.floor(diff / 60000);
}

// ─── Con base de datos ───────────────────────────────────────────────────────

// Filtro compartido: excluye al dueño (si contara, mirando su propio panel refrescaría
// lastSeen cada 10 s y bloquearía su propio mantenimiento para siempre) y a las cuentas
// deshabilitadas, que no pueden navegar aunque tengan un lastSeen reciente.
function activeFilter(idleMinutes, now) {
  return {
    lastSeen: { $gte: activityCutoff(idleMinutes, now) },
    active:   { $ne: false },
    email:    { $ne: SYSTEM_OWNER_EMAIL },
  };
}

// Una sola aggregation: el total sale de sumar los grupos, no de una segunda query.
async function countActiveUsers({ idleMinutes, now = new Date() } = {}) {
  const rows = await User.aggregate([
    { $match: activeFilter(idleMinutes, now) },
    { $group: { _id: '$role', count: { $sum: 1 } } },
  ]);
  const byRole = {};
  let count = 0;
  rows.forEach(r => { byRole[r._id || 'sin rol'] = r.count; count += r.count; });
  return { count, byRole };
}

async function listActiveUsers({ idleMinutes, now = new Date(), limit = ACTIVITY_LIST_MAX } = {}) {
  const users = await User.find(activeFilter(idleMinutes, now))
    .select('name role lastSeen')
    .sort({ lastSeen: -1 })
    .limit(limit)
    .lean();
  return users.map(u => ({
    name:       u.name || '(sin nombre)',
    role:       u.role || '',
    minutesAgo: minutesAgo(u.lastSeen, now),
  }));
}

module.exports = {
  IDLE_DEFAULT_MIN, IDLE_MIN_MIN, IDLE_MAX_MIN, MAX_WAIT_MAX_MIN,
  CHECK_INTERVAL_MS, ACTIVITY_LIST_MAX,
  normalizeIdleMinutes, normalizeMaxWait, activityCutoff, countsAsActive,
  deadlineOf, shouldPromote, minutesAgo,
  countActiveUsers, listActiveUsers,
};
