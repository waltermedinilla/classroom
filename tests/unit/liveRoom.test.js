// Tests de la lógica pura de la sala en vivo (services/liveRoom.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Estas funciones se testean acá y no con un smoke HTTP porque dependen del PASO DEL TIEMPO:
// la ventana de "conectado ahora" y el autocierre a las 3 h necesitan poder inyectar el
// `now`, cosa que una request real no permite sin esperar tres horas.
//
// Cubren los criterios CA-01 a CA-06 de specs/sala-en-vivo.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  isOnline, presenceSummary, shouldAutoClose, sanitizeText, minutosPresente,
  ONLINE_WINDOW_MS, AUTO_CLOSE_MS, MSG_MAX, POLL_MS,
} = require('../../services/liveRoom');

const AHORA = new Date('2026-08-06T14:30:00Z');
const haceMs = (ms) => new Date(AHORA.getTime() - ms);

// ── CA-01: ventana de "conectado ahora" ──────────────────────────────────────

test('isOnline: un ping de hace 10 s cuenta como conectado', () => {
  assert.strictEqual(isOnline(haceMs(10 * 1000), AHORA), true);
});

test('isOnline: un ping de hace 60 s ya no cuenta', () => {
  assert.strictEqual(isOnline(haceMs(60 * 1000), AHORA), false);
});

test('isOnline: el borde de 45 s es inclusivo', () => {
  assert.strictEqual(isOnline(haceMs(ONLINE_WINDOW_MS), AHORA), true);
  assert.strictEqual(isOnline(haceMs(ONLINE_WINDOW_MS + 1), AHORA), false);
});

test('isOnline: sin ping, o con una fecha basura, no rompe', () => {
  assert.strictEqual(isOnline(null, AHORA), false);
  assert.strictEqual(isOnline(undefined, AHORA), false);
  assert.strictEqual(isOnline('no es una fecha', AHORA), false);
});

// ── CA-02: el docente aparece primero pero no suma a "presentes" ─────────────

const alumno = (n) => ({ _id: `a${n}`, name: `Alumno ${n}`, avatar: null });
const roster25 = Array.from({ length: 25 }, (_, i) => alumno(i + 1));

const presencia = (userId, role, msDesdeUltimoPing, msDesdeIngreso = 60 * 60 * 1000) => ({
  user: userId,
  userName: userId === 'prof' ? 'Prof. Gómez' : `Alumno ${String(userId).slice(1)}`,
  userRole: role,
  firstSeenAt: haceMs(msDesdeIngreso),
  lastPingAt:  haceMs(msDesdeUltimoPing),
  pings: 10,
});

test('presenceSummary: cuenta solo alumnos y pone al docente primero', () => {
  const presences = [
    presencia('a1', 'student', 5 * 1000),
    presencia('a2', 'student', 5 * 1000),
    presencia('a3', 'student', 5 * 1000),
    presencia('a4', 'student', 5 * 60 * 1000),   // se desconectó hace 5 min
    presencia('prof', 'teacher', 5 * 1000),
  ];

  const r = presenceSummary(presences, roster25, AHORA);

  assert.strictEqual(r.presentes, 3, 'la docente no suma al conteo de alumnos presentes');
  assert.strictEqual(r.total, 25);
  assert.strictEqual(r.conectados[0].rol, 'teacher', 'la docente va primera en la fila');
  assert.strictEqual(r.conectados[0].etiqueta, 'Docente');
  assert.strictEqual(r.conectados.length, 4, '3 alumnos + la docente');
  // El que dejó de pollear sigue existiendo, pero del lado de los ausentes.
  assert.ok(r.ausentes.some(a => a.id === 'a4'));
  assert.strictEqual(r.ausentes.length, 22);
});

test('presenceSummary: el preceptor también es personal, no alumno presente', () => {
  const r = presenceSummary(
    [presencia('a1', 'student', 1000), presencia('prec', 'preceptor', 1000)],
    roster25, AHORA
  );
  assert.strictEqual(r.presentes, 1);
  assert.strictEqual(r.conectados[0].rol, 'preceptor');
  assert.strictEqual(r.conectados[0].etiqueta, 'Preceptoría');
});

test('presenceSummary: las iniciales salen en mayúscula y toleran nombres vacíos', () => {
  const r = presenceSummary([presencia('a1', 'student', 1000)], [alumno(1)], AHORA);
  assert.strictEqual(r.conectados[0].inicial, 'A');
  const vacio = presenceSummary([], [{ _id: 'x', name: '' }], AHORA);
  assert.strictEqual(vacio.ausentes[0].inicial, '—');
});

// ── CA-03: materia sin alumnos ──────────────────────────────────────────────

test('presenceSummary: una materia sin alumnos da 0 de 0, sin NaN', () => {
  const r = presenceSummary([], [], AHORA);
  assert.strictEqual(r.presentes, 0);
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.conectados, []);
  assert.deepStrictEqual(r.ausentes, []);
  assert.ok(!Number.isNaN(r.presentes) && !Number.isNaN(r.total));
});

test('presenceSummary: sin argumentos no explota', () => {
  const r = presenceSummary();
  assert.strictEqual(r.presentes, 0);
  assert.strictEqual(r.total, 0);
});

// ── CA-04: autocierre ───────────────────────────────────────────────────────

test('shouldAutoClose: a las 2 h 59 min todavía no', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS - 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

test('shouldAutoClose: a las 3 h 01 min sí', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS + 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), true);
});

test('shouldAutoClose: una sesión ya cerrada nunca se vuelve a cerrar', () => {
  const s = { closedAt: haceMs(1000), lastActivityAt: haceMs(AUTO_CLOSE_MS * 10) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

test('shouldAutoClose: sin lastActivityAt usa openedAt', () => {
  const s = { closedAt: null, openedAt: haceMs(AUTO_CLOSE_MS + 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), true);
});

test('shouldAutoClose: sin sesión devuelve false, no rompe', () => {
  assert.strictEqual(shouldAutoClose(null, AHORA), false);
  assert.strictEqual(shouldAutoClose(undefined, AHORA), false);
});

// ── CA-05: normalización del texto ──────────────────────────────────────────

test('sanitizeText: corta en el máximo', () => {
  assert.strictEqual(sanitizeText('x'.repeat(800)).length, MSG_MAX);
});

test('sanitizeText: solo espacios queda vacío', () => {
  assert.strictEqual(sanitizeText('   '), '');
  assert.strictEqual(sanitizeText('\n\n\t  \n'), '');
});

test('sanitizeText: colapsa cascadas de Enter a un renglón en blanco', () => {
  assert.strictEqual(sanitizeText('hola\n\n\n\n\n\nchau'), 'hola\n\nchau');
});

test('sanitizeText: normaliza saltos de Windows', () => {
  assert.strictEqual(sanitizeText('a\r\nb'), 'a\nb');
});

test('sanitizeText: entradas que no son string devuelven vacío', () => {
  assert.strictEqual(sanitizeText(null), '');
  assert.strictEqual(sanitizeText(undefined), '');
  assert.strictEqual(sanitizeText(42), '');
  assert.strictEqual(sanitizeText({}), '');
});

test('sanitizeText: conserva emojis enteros', () => {
  assert.strictEqual(sanitizeText('presente 👋 profe'), 'presente 👋 profe');
});

// ── CA-06: el texto NO se escapa acá ────────────────────────────────────────

test('sanitizeText: no escapa HTML — de eso se encarga la vista con <%= %>', () => {
  const payload = '<script>alert(1)</script>';
  assert.strictEqual(sanitizeText(payload), payload);
});

// ── Permanencia estimada ────────────────────────────────────────────────────

test('minutosPresente: sale de los pings, no de la resta de fechas', () => {
  // 15 pings × 4 s = 60 s = 1 minuto.
  assert.strictEqual(minutosPresente({ pings: 15 }), 1);
  // 150 pings × 4 s = 600 s = 10 minutos.
  assert.strictEqual(minutosPresente({ pings: 150 }), 10);
  assert.strictEqual(POLL_MS, 4000, 'si cambia POLL_MS, estos números cambian');
});

test('minutosPresente: quien entró y se fue enseguida cuenta 1, no 0', () => {
  assert.strictEqual(minutosPresente({ pings: 1 }), 1);
  assert.strictEqual(minutosPresente({}), 1);
  assert.strictEqual(minutosPresente(null), 1);
});
