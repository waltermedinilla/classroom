// Tests de las transiciones de estado del mantenimiento (config/maintenance.js).
// Correr con: npm run test:unit
//
// Tocan disco de verdad (el estado VIVE en disco: es lo que lo hace compartido entre los 2
// workers de PM2), pero contra un archivo temporal, no contra el maintenance.json real de
// la raíz — si no, correr los tests con el server de dev levantado bloquearía la app de
// verdad a mitad de la corrida. Por eso config/maintenance.js lee MAINTENANCE_FILE.
//
// Cubren CA-11 a CA-17 y CA-35 de specs/mantenimiento-ventana.spec.md.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ANTES del require: el módulo resuelve la ruta una sola vez, al cargarse.
const TMP_FILE = path.join(os.tmpdir(), `maintenance-test-${process.pid}.json`);
process.env.MAINTENANCE_FILE = TMP_FILE;

const {
  getMaintenanceState, getPendingState, readRawState,
  setMaintenanceOn, setMaintenancePending, promotePending,
  setMaintenanceOff, restoreRawState,
} = require('../../config/maintenance');

const limpiar = () => fs.rmSync(TMP_FILE, { force: true });

test.beforeEach(limpiar);
test.after(limpiar);

// ── CA-13: estado normal ─────────────────────────────────────────────────────

test('sin archivo, las tres lecturas devuelven null', () => {
  assert.strictEqual(readRawState(), null);
  assert.strictEqual(getMaintenanceState(), null);
  assert.strictEqual(getPendingState(), null);
});

// ── CA-11: mantenimiento activo ──────────────────────────────────────────────

test('con mantenimiento activo bloquea, y no figura como espera', () => {
  setMaintenanceOn({ message: 'Actualizando', eta: '10 min', activatedBy: 'dueño@x.com', reason: 'manual' });

  const state = getMaintenanceState();
  assert.ok(state, 'getMaintenanceState debería devolver el estado activo');
  assert.strictEqual(state.message, 'Actualizando');
  assert.strictEqual(state.reason, 'manual');
  assert.strictEqual(getPendingState(), null);
});

// ── CA-12: EN ESPERA no bloquea (la regla central de la feature) ─────────────

test('con una espera en curso, getMaintenanceState devuelve null', () => {
  setMaintenancePending({
    message: 'Vamos a actualizar', eta: null, idleMinutes: 5,
    maxWaitMinutes: null, notifyActiveUsers: false, requestedBy: 'dueño@x.com',
  });

  // Esto es lo que hace que el middleware de server.js deje pasar a todo el mundo.
  assert.strictEqual(getMaintenanceState(), null,
    'una espera NO puede bloquear: cortaría el trabajo de los que ya están adentro');

  const pending = getPendingState();
  assert.ok(pending, 'getPendingState debería devolver la espera');
  assert.strictEqual(pending.idleMinutes, 5);
  assert.strictEqual(pending.notifyActiveUsers, false);
  assert.ok(pending.requestedAt, 'debería registrar cuándo se pidió, para el cronómetro');
});

test('setMaintenancePending conserva el requestedAt original si se lo pasan', () => {
  const original = '2026-08-07T20:00:00.000Z';
  setMaintenancePending({ idleMinutes: 5, requestedBy: 'x@x.com', requestedAt: original });
  assert.strictEqual(getPendingState().requestedAt, original);
});

// ── CA-14: archivo corrupto ──────────────────────────────────────────────────

test('con el archivo corrupto no se bloquea a nadie ni se lanza (fail-open)', () => {
  fs.writeFileSync(TMP_FILE, 'esto no es json {{{');
  assert.strictEqual(readRawState(), null);
  assert.strictEqual(getMaintenanceState(), null);
  assert.strictEqual(getPendingState(), null);
});

test('un JSON válido que no es un objeto también se trata como corrupto', () => {
  fs.writeFileSync(TMP_FILE, '42');
  assert.strictEqual(getMaintenanceState(), null);
});

// ── CA-15 y CA-35: la promoción automática ───────────────────────────────────

test('promotePending hereda lo que escribió el dueño y marca el origen', () => {
  setMaintenancePending({
    message: 'Actualización del sistema', eta: '15 minutos', idleMinutes: 5,
    requestedBy: 'dueño@x.com',
  });

  const pending = getPendingState();
  promotePending(pending, 'empty');

  const state = getMaintenanceState();
  assert.ok(state, 'después de promover tiene que bloquear');
  assert.strictEqual(state.active, true);
  assert.strictEqual(state.pending, false);
  assert.strictEqual(state.message, 'Actualización del sistema');
  assert.strictEqual(state.eta, '15 minutos');
  assert.strictEqual(state.activatedBy, 'dueño@x.com');
  assert.strictEqual(state.reason, 'auto');
  assert.strictEqual(state.promotedBy, 'empty');
  assert.ok(state.activatedAt, 'debería registrar cuándo se activó');
  assert.strictEqual(getPendingState(), null, 'ya no hay espera: ahora está activo');
});

test('promotePending por vencimiento del tope queda registrado como deadline', () => {
  setMaintenancePending({ idleMinutes: 5, maxWaitMinutes: 120, requestedBy: 'dueño@x.com' });
  promotePending(getPendingState(), 'deadline');
  assert.strictEqual(getMaintenanceState().promotedBy, 'deadline');
});

// ── CA-16: apagar apaga todo ─────────────────────────────────────────────────

test('setMaintenanceOff cancela también una espera en curso', () => {
  setMaintenancePending({ idleMinutes: 5, requestedBy: 'dueño@x.com' });
  setMaintenanceOff();
  assert.strictEqual(readRawState(), null, 'no puede quedar una espera zombi corriendo por detrás');
});

test('setMaintenanceOff sin nada activo no rompe', () => {
  assert.doesNotThrow(() => setMaintenanceOff());
});

// ── CA-17: snapshot/restore del estado (lo usa /restore) ─────────────────────

test('restoreRawState devuelve el estado exactamente como estaba', () => {
  setMaintenancePending({ message: 'Espera previa', idleMinutes: 7, requestedBy: 'dueño@x.com' });
  const snapshot = readRawState();

  // Un restore de backup activa mantenimiento por su cuenta y al terminar tiene que dejar
  // las cosas como estaban — sin esto, se comería la espera que había pedido el dueño.
  setMaintenanceOn({ message: 'Restaurando', activatedBy: 'dueño@x.com', reason: 'restore' });
  assert.ok(getMaintenanceState(), 'durante el restore sí bloquea');

  restoreRawState(snapshot);
  assert.deepStrictEqual(readRawState(), snapshot);
  assert.strictEqual(getPendingState().message, 'Espera previa');
});

test('restoreRawState(null) deja el sistema abierto', () => {
  setMaintenanceOn({ activatedBy: 'dueño@x.com', reason: 'restore' });
  restoreRawState(null);
  assert.strictEqual(readRawState(), null);
});

// ── CA-45: compatibilidad con el formato viejo ───────────────────────────────

test('un maintenance.json escrito por la versión anterior sigue bloqueando', () => {
  fs.writeFileSync(TMP_FILE, JSON.stringify({
    active: true,
    message: 'Estamos actualizando el sistema. Volvemos en breve.',
    eta: null,
    activatedAt: '2026-07-22T18:00:00.000Z',
    activatedBy: 'waltermedinilla@gmail.com',
    reason: 'manual',
  }));

  assert.ok(getMaintenanceState(), 'el formato viejo (sin campo pending) tiene que seguir bloqueando');
  assert.strictEqual(getPendingState(), null);

  setMaintenanceOff();
  assert.strictEqual(getMaintenanceState(), null);
});
