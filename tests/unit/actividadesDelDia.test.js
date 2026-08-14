// Tests de la lógica pura de "Actividades del día" (services/actividadesDelDia.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Acá va solo lo que no toca la base: la grilla del calendario, la navegación de meses y la
// validación de los parámetros de la URL. El cruce materias × actividades se prueba por HTTP
// en tests/smoke/specs.js, que es donde hay datos reales.
//
// Cubren parte de los criterios de specs/actividades-en-clase.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  mesValido, diaValido, mesAnterior, mesSiguiente, nombreDelMes, grillaDelMes,
} = require('../../services/actividadesDelDia');

// Aplana la grilla a los números de día, en orden, salteando el relleno.
const numeros = (mes) => grillaDelMes(mes).flat().filter(Boolean).map(c => c.numero);

// ── Validación de lo que llega por la URL ────────────────────────────────────
// Estos strings viajan al $match de Mongo y a la clave de la grilla: si pasa basura, el mes
// se arma con NaN y la pantalla queda en blanco sin decir por qué.

test('mesValido acepta YYYY-MM y rechaza el resto', () => {
  assert.equal(mesValido('2026-08'), true);
  assert.equal(mesValido('2026-01'), true);
  assert.equal(mesValido('2026-13'), false, 'no existe el mes 13');
  assert.equal(mesValido('2026-00'), false);
  assert.equal(mesValido('2026-8'),  false, 'sin el cero adelante no ordena ni matchea');
  assert.equal(mesValido('2026-08-12'), false);
  assert.equal(mesValido(undefined), false);
});

test('diaValido acepta YYYY-MM-DD y rechaza el resto', () => {
  assert.equal(diaValido('2026-08-12'), true);
  assert.equal(diaValido('2026-08-31'), true);
  assert.equal(diaValido('2026-08-32'), false);
  assert.equal(diaValido('2026-08-00'), false);
  assert.equal(diaValido('2026-08'),    false);
  assert.equal(diaValido(null),         false);
});

// ── Navegación de meses ──────────────────────────────────────────────────────
// El caso que rompe una resta hecha a mano es el cruce de año.

test('mesAnterior y mesSiguiente cruzan el año', () => {
  assert.equal(mesAnterior('2026-01'),  '2025-12');
  assert.equal(mesSiguiente('2026-12'), '2027-01');
  assert.equal(mesAnterior('2026-08'),  '2026-07');
  assert.equal(mesSiguiente('2026-08'), '2026-09');
});

test('nombreDelMes usa el mes que se le pide, no el vecino', () => {
  // Se arma en UTC a propósito (ver el comentario del servicio): con la zona del equipo,
  // el 1° a las 00:00 se corre a las 21:00 del último día del mes ANTERIOR y el título
  // del calendario pasa a decir "julio" arriba de una grilla de agosto.
  assert.equal(nombreDelMes('2026-08'), 'agosto de 2026');
  assert.equal(nombreDelMes('2026-01'), 'enero de 2026');
  assert.equal(nombreDelMes('2026-12'), 'diciembre de 2026');
});

// ── La grilla del calendario ─────────────────────────────────────────────────

test('grillaDelMes: semanas de 7 celdas, de domingo a sábado', () => {
  const g = grillaDelMes('2026-01');
  g.forEach(sem => assert.equal(sem.length, 7, 'toda semana tiene 7 celdas'));
  // Enero de 2026 arranca un JUEVES: con la semana empezando en domingo, las cuatro primeras
  // celdas son relleno y el 1 cae en la quinta. Es el mes de la foto que trajo el usuario.
  assert.deepEqual(g[0].slice(0, 4), [null, null, null, null]);
  assert.equal(g[0][4].numero, 1);
  assert.equal(g[0][4].dia, '2026-01-01');
});

test('grillaDelMes trae todos los días del mes y ninguno de más', () => {
  assert.deepEqual(numeros('2026-01'), Array.from({ length: 31 }, (_, i) => i + 1));
  assert.deepEqual(numeros('2026-04'), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(numeros('2026-02').length, 28);
  assert.equal(numeros('2024-02').length, 29, 'febrero bisiesto');
});

test('grillaDelMes: la clave del día es la que usa el resumen del mes', () => {
  const ultima = grillaDelMes('2026-08').flat().filter(Boolean).pop();
  assert.equal(ultima.numero, 31);
  assert.equal(ultima.dia, '2026-08-31');
});
