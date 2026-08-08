// Tests de la lógica pura de la ventana de mantenimiento (services/maintenanceWindow.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Igual que liveRoom.test.js: estas funciones se testean acá y no con un smoke HTTP porque
// dependen del PASO DEL TIEMPO. "Esperá 5 minutos a que se vaya el último usuario" no se
// puede verificar con una request sin esperar 5 minutos de verdad.
//
// Cubren los criterios CA-01 a CA-10 de specs/mantenimiento-ventana.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  normalizeIdleMinutes, normalizeMaxWait, activityCutoff, countsAsActive,
  deadlineOf, shouldPromote, minutesAgo,
  IDLE_DEFAULT_MIN, IDLE_MAX_MIN, MAX_WAIT_MAX_MIN,
} = require('../../services/maintenanceWindow');

const AHORA    = new Date('2026-08-07T21:00:00Z');
const haceMin  = (m) => new Date(AHORA.getTime() - m * 60 * 1000);
const enMin    = (m) => new Date(AHORA.getTime() + m * 60 * 1000);

// ── CA-01: umbral de inactividad ─────────────────────────────────────────────

test('normalizeIdleMinutes: campo vacío o basura cae al default de 5', () => {
  [undefined, null, '', 'abc', NaN, 0, '0'].forEach(v => {
    assert.strictEqual(normalizeIdleMinutes(v), IDLE_DEFAULT_MIN, `falló con ${JSON.stringify(v)}`);
  });
});

test('normalizeIdleMinutes: recorta a los extremos en vez de rechazar', () => {
  assert.strictEqual(normalizeIdleMinutes(-3),  1);
  assert.strictEqual(normalizeIdleMinutes(999), IDLE_MAX_MIN);
});

test('normalizeIdleMinutes: conserva los valores válidos y trunca decimales', () => {
  assert.strictEqual(normalizeIdleMinutes(1),     1);
  assert.strictEqual(normalizeIdleMinutes(5),     5);
  assert.strictEqual(normalizeIdleMinutes(60),    60);
  assert.strictEqual(normalizeIdleMinutes('15'),  15);
  assert.strictEqual(normalizeIdleMinutes(7.9),   7);
});

// ── CA-02: tope de espera ────────────────────────────────────────────────────

test('normalizeMaxWait: sin valor significa esperar indefinidamente (null)', () => {
  [undefined, null, '', 0, -5, 'abc', NaN].forEach(v => {
    assert.strictEqual(normalizeMaxWait(v), null, `falló con ${JSON.stringify(v)}`);
  });
});

test('normalizeMaxWait: conserva un valor razonable y recorta a 24 h', () => {
  assert.strictEqual(normalizeMaxWait(120),   120);
  assert.strictEqual(normalizeMaxWait('90'),  90);
  assert.strictEqual(normalizeMaxWait(99999), MAX_WAIT_MAX_MIN);
});

// ── CA-03 y CA-09: la ventana de actividad y su borde ────────────────────────

test('activityCutoff: 5 minutos antes de ahora, exacto', () => {
  assert.strictEqual(activityCutoff(5, AHORA).getTime(), AHORA.getTime() - 5 * 60 * 1000);
});

test('activityCutoff: normaliza el umbral que recibe', () => {
  assert.strictEqual(activityCutoff('basura', AHORA).getTime(), haceMin(IDLE_DEFAULT_MIN).getTime());
});

test('countsAsActive: alguien que navegó hace 30 s está trabajando', () => {
  assert.strictEqual(countsAsActive(new Date(AHORA.getTime() - 30_000), 5, AHORA), true);
});

test('countsAsActive: el borde de la ventana es inclusivo', () => {
  assert.strictEqual(countsAsActive(haceMin(5), 5, AHORA), true);
  assert.strictEqual(countsAsActive(new Date(haceMin(5).getTime() - 1), 5, AHORA), false);
});

test('countsAsActive: sin lastSeen, o con basura, no cuenta como activo', () => {
  assert.strictEqual(countsAsActive(null, 5, AHORA), false);
  assert.strictEqual(countsAsActive(undefined, 5, AHORA), false);
  assert.strictEqual(countsAsActive('no es una fecha', 5, AHORA), false);
});

// ── CA-04: el tope de espera ─────────────────────────────────────────────────

const espera = (extra = {}) => ({
  pending: true,
  requestedAt: haceMin(30).toISOString(),
  idleMinutes: 5,
  maxWaitMinutes: null,
  ...extra,
});

test('deadlineOf: sin tope configurado no hay fecha límite', () => {
  assert.strictEqual(deadlineOf(espera()), null);
  assert.strictEqual(deadlineOf(null), null);
});

test('deadlineOf: requestedAt + maxWaitMinutes', () => {
  const d = deadlineOf(espera({ maxWaitMinutes: 120 }));
  assert.strictEqual(d.getTime(), haceMin(30).getTime() + 120 * 60 * 1000);
});

test('deadlineOf: un requestedAt roto no genera una fecha inválida', () => {
  assert.strictEqual(deadlineOf(espera({ requestedAt: 'ayer', maxWaitMinutes: 120 })), null);
});

// ── CA-05 a CA-08: la decisión de promover ───────────────────────────────────

test('shouldPromote: sin nadie trabajando, se activa el mantenimiento', () => {
  assert.deepStrictEqual(
    shouldPromote({ pending: espera(), activeCount: 0, now: AHORA }),
    { promote: true, why: 'empty' },
  );
});

test('shouldPromote: con gente adentro y sin tope, sigue esperando', () => {
  assert.deepStrictEqual(
    shouldPromote({ pending: espera(), activeCount: 3, now: AHORA }),
    { promote: false, why: null },
  );
});

test('shouldPromote: vencido el tope, se activa aunque quede gente', () => {
  // Espera pedida hace 30 min con tope de 20 → ya venció.
  assert.deepStrictEqual(
    shouldPromote({ pending: espera({ maxWaitMinutes: 20 }), activeCount: 3, now: AHORA }),
    { promote: true, why: 'deadline' },
  );
});

test('shouldPromote: con el tope todavía corriendo, sigue esperando', () => {
  assert.deepStrictEqual(
    shouldPromote({ pending: espera({ maxWaitMinutes: 120 }), activeCount: 3, now: AHORA }),
    { promote: false, why: null },
  );
});

test('shouldPromote: sin espera en curso nunca promueve', () => {
  assert.strictEqual(shouldPromote({ pending: null, activeCount: 0, now: AHORA }).promote, false);
});

test('shouldPromote: un conteo que no es número NO promueve', () => {
  // Si la query falló, activar el mantenimiento sería lo contrario de esperar: se estaría
  // bloqueando la escuela por no haber podido contar.
  [undefined, null, NaN, 'cero'].forEach(v => {
    assert.strictEqual(
      shouldPromote({ pending: espera(), activeCount: v, now: AHORA }).promote, false,
      `promovió con activeCount = ${JSON.stringify(v)}`,
    );
  });
});

// ── CA-10: hace cuánto ───────────────────────────────────────────────────────

test('minutesAgo: minutos enteros hacia abajo', () => {
  assert.strictEqual(minutesAgo(haceMin(0.5), AHORA), 0);   // 30 s
  assert.strictEqual(minutesAgo(haceMin(1.5), AHORA), 1);   // 90 s
  assert.strictEqual(minutesAgo(haceMin(42),  AHORA), 42);
});

test('minutesAgo: una fecha futura o basura da 0, nunca negativo', () => {
  assert.strictEqual(minutesAgo(enMin(10), AHORA), 0);
  assert.strictEqual(minutesAgo(null, AHORA), 0);
  assert.strictEqual(minutesAgo('cuando sea', AHORA), 0);
});
