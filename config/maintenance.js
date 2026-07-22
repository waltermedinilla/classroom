const fs   = require('fs');
const path = require('path');

// Único dueño del sistema: puede activar/desactivar mantenimiento y tiene bypass total
// mientras está activo. Mismo email que ya se usaba (duplicado) como BACKUP_ALLOWED_EMAIL
// en routes/backup.js — se consolida acá para no repetirlo una tercera vez.
const SYSTEM_OWNER_EMAIL = 'waltermedinilla@gmail.com';

// Estado de mantenimiento persistido en disco (NO en memoria) — igual razón que el
// preview de restore en routes/backup.js: en PM2 cluster (2 workers) el disco se
// comparte entre procesos, la memoria no. Si esto viviera en un Map, activar el modo
// en el worker que atendió el toggle no bloquearía las requests que caigan en el otro.
// Además, leer el archivo en cada request (sin cache) garantiza que apagar el modo
// tenga efecto inmediato en TODOS los workers en la request siguiente, sin esperar
// ningún TTL — a diferencia del cache de usuario/escuela, acá la inmediatez importa más
// que ahorrar una lectura de archivo (que es de unos pocos bytes).
const MAINTENANCE_FILE = path.join(__dirname, '../maintenance.json');

// Devuelve el estado actual, o null si no está activo.
function getMaintenanceState() {
  if (!fs.existsSync(MAINTENANCE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
  } catch {
    return null; // archivo corrupto/vacío — se trata como "no hay mantenimiento activo"
  }
}

// Activa el modo. `reason`: 'manual' (toggle desde /superadmin/backup) o 'restore'
// (activado automáticamente durante una restauración).
function setMaintenanceOn({ message, eta, activatedBy, reason }) {
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({
    active: true,
    message: message || 'Estamos actualizando el sistema. Volvemos en breve.',
    eta: eta || null,
    activatedAt: new Date().toISOString(),
    activatedBy,
    reason,
  }, null, 2));
}

function setMaintenanceOff() {
  fs.unlink(MAINTENANCE_FILE, () => {});
}

module.exports = { getMaintenanceState, setMaintenanceOn, setMaintenanceOff, SYSTEM_OWNER_EMAIL };
