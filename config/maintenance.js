const fs   = require('fs');
const path = require('path');

// Único dueño del sistema: puede activar/desactivar mantenimiento y tiene bypass total
// mientras está activo. Mismo email que ya se usaba (duplicado) como BACKUP_ALLOWED_EMAIL
// en routes/backup.js — se consolida acá para no repetirlo una tercera vez.
const SYSTEM_OWNER_EMAIL = 'waltermedinilla@gmail.com';

const DEFAULT_MESSAGE = 'Estamos actualizando el sistema. Volvemos en breve.';

// Estado de mantenimiento persistido en disco (NO en memoria) — igual razón que el
// preview de restore en routes/backup.js: en PM2 cluster (2 workers) el disco se
// comparte entre procesos, la memoria no. Si esto viviera en un Map, activar el modo
// en el worker que atendió el toggle no bloquearía las requests que caigan en el otro.
// Además, leer el archivo en cada request (sin cache) garantiza que apagar el modo
// tenga efecto inmediato en TODOS los workers en la request siguiente, sin esperar
// ningún TTL — a diferencia del cache de usuario/escuela, acá la inmediatez importa más
// que ahorrar una lectura de archivo (que es de unos pocos bytes).
//
// La ruta se puede pisar con MAINTENANCE_FILE. Es SOLO para los tests unitarios: sin eso,
// testear las transiciones de estado obligaría a escribir maintenance.json en la raíz del
// repo — con el server de dev corriendo, eso bloquearía la app de verdad a mitad del test.
const MAINTENANCE_FILE = process.env.MAINTENANCE_FILE
  || path.join(__dirname, '../maintenance.json');

// ─────────────────────────────────────────────────────────────────────────────
// Tres estados posibles, uno solo a la vez (ver specs/mantenimiento-ventana.spec.md):
//
//   normal     → el archivo no existe
//   en espera  → { pending: true }  — NO bloquea a nadie que ya esté adentro; solo corta
//                los ingresos nuevos, y el promotor lo asciende a "activo" cuando la
//                plataforma se vacía (ver server.js)
//   activo     → { active: true }   — el 503 para todos menos el dueño (lo de siempre)
//
// `active` y `pending` NUNCA son ambos true.
// ─────────────────────────────────────────────────────────────────────────────

// Devuelve el objeto crudo del archivo, sea cual sea el estado, o null.
function readRawState() {
  if (!fs.existsSync(MAINTENANCE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
    // Un JSON válido pero que no es un objeto (un número, un string, null) se trata igual
    // que un archivo corrupto: fail-open, la escuela no se queda afuera por un archivo roto.
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null; // archivo corrupto/vacío — se trata como "no hay mantenimiento activo"
  }
}

function writeState(state) {
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(state, null, 2));
  return state;
}

// Estado que BLOQUEA. Devuelve null si el mantenimiento está solo "en espera": es
// exactamente lo que hace que una ventana programada no le corte el trabajo a nadie,
// sin tocar el middleware que ya existía.
function getMaintenanceState() {
  const state = readRawState();
  return state && state.active === true ? state : null;
}

// Estado "en espera": hay un mantenimiento pedido, esperando a que la plataforma se vacíe.
function getPendingState() {
  const state = readRawState();
  return state && state.pending === true && state.active !== true ? state : null;
}

// Activa el modo. `reason`: 'manual' (toggle desde /superadmin/backup), 'restore'
// (activado automáticamente durante una restauración) o 'auto' (lo ascendió el promotor
// desde una ventana en espera).
function setMaintenanceOn({ message, eta, activatedBy, reason, promotedBy = null }) {
  return writeState({
    active: true,
    pending: false,
    message: message || DEFAULT_MESSAGE,
    eta: eta || null,
    activatedAt: new Date().toISOString(),
    activatedBy,
    reason,
    ...(promotedBy ? { promotedBy } : {}),
  });
}

// Deja el sistema "en espera". `requestedAt` se puede pasar para conservar el cronómetro
// original cuando se reprograma una espera ya en curso (cambiar el mensaje no reinicia
// la cuenta de cuánto hace que se está esperando).
function setMaintenancePending({
  message, eta, idleMinutes, maxWaitMinutes = null,
  notifyActiveUsers = false, requestedBy, requestedAt,
}) {
  return writeState({
    active: false,
    pending: true,
    message: message || DEFAULT_MESSAGE,
    eta: eta || null,
    idleMinutes,
    maxWaitMinutes,
    notifyActiveUsers: !!notifyActiveUsers,
    requestedAt: requestedAt || new Date().toISOString(),
    requestedBy,
  });
}

// Asciende una espera a mantenimiento real, heredando lo que el dueño ya había escrito.
// `promotedBy`: 'empty' (se vació la plataforma) o 'deadline' (venció el tope de espera).
function promotePending(pending, promotedBy) {
  return setMaintenanceOn({
    message: pending.message,
    eta: pending.eta,
    activatedBy: pending.requestedBy,
    reason: 'auto',
    promotedBy,
  });
}

// Apaga TODO: tanto un mantenimiento activo como una espera en curso. Es el "apagá todo"
// del panel, y evita que quede una espera zombi corriendo por detrás.
//
// Borrado síncrono (antes era fs.unlink con callback vacío): las transiciones se testean
// leyendo el estado justo después de escribirlo, y con el borrado asíncrono ese chequeo
// era una carrera. El archivo son unos pocos bytes; el costo es irrelevante.
function setMaintenanceOff() {
  fs.rmSync(MAINTENANCE_FILE, { force: true });
}

// Reescribe un estado crudo tal cual (o borra el archivo si el snapshot es null).
// Lo usa el /restore para devolver las cosas como estaban: sin esto, un restore que
// arranca con una ventana EN ESPERA la borraría al terminar.
function restoreRawState(snapshot) {
  if (!snapshot) return setMaintenanceOff();
  writeState(snapshot);
}

module.exports = {
  getMaintenanceState,
  getPendingState,
  readRawState,
  setMaintenanceOn,
  setMaintenancePending,
  promotePending,
  setMaintenanceOff,
  restoreRawState,
  SYSTEM_OWNER_EMAIL,
  DEFAULT_MESSAGE,
  MAINTENANCE_FILE,
};
