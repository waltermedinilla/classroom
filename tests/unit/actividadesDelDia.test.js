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
  rangoValido, rangoDeHoy, rangoDeSemana, campoValido, CAMPOS,
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

// ══════════════════════════════════════════════════════════════════════════════
// Solapa "Actividades Diarias" del directivo (specs/directivo-actividades-diarias.spec.md).
// Misma regla de fondo, pero por RANGO y sobre toda la escuela. Acá va solo lo puro; el cruce
// materias × actividades se prueba por HTTP en tests/smoke/specs.js.
// ══════════════════════════════════════════════════════════════════════════════

// ── El rango que llega por la URL ────────────────────────────────────────────
// Estos dos strings se interpolan en el $match de Mongo. Si pasa basura, el aggregate se arma
// con Invalid Date y la pantalla queda en blanco sin decir por qué.

test('rangoValido acepta un rango bien formado', () => {
  assert.equal(rangoValido('2026-08-01', '2026-08-31'), true);
  assert.equal(rangoValido('2026-08-17', '2026-08-17'), true, 'un solo día es un rango válido');
});

test('rangoValido rechaza el rango dado vuelta', () => {
  // El caso real: el usuario toca las dos fechas en cualquier orden. Sin esto, el $match no
  // matchea nada y la pantalla muestra TODO como pendiente — que se lee como "nadie cargó nada".
  assert.equal(rangoValido('2026-08-31', '2026-08-01'), false);
});

test('rangoValido rechaza lo que no es una fecha', () => {
  assert.equal(rangoValido('ayer', 'hoy'), false);
  assert.equal(rangoValido(null, '2026-08-01'), false);
  assert.equal(rangoValido('2026-08-01', undefined), false);
  assert.equal(rangoValido('2026-13-01', '2026-13-02'), false, 'no existe el mes 13');
  assert.equal(rangoValido('2026-08', '2026-09'), false, 'YYYY-MM no alcanza');
});

test('rangoValido pone un techo al tamaño del rango', () => {
  // No es una regla de negocio, es un fusible: "desde 2015 hasta hoy" escrito a mano en la URL
  // no tiene por qué colgar la pantalla de nadie.
  assert.equal(rangoValido('2026-01-01', '2027-01-02'), true,  '366 días es el tope, entra');
  assert.equal(rangoValido('2026-01-01', '2027-01-03'), false, '367 días ya no');
  assert.equal(rangoValido('2015-01-01', '2026-08-17'), false);
});

// ── Los atajos de rango ──────────────────────────────────────────────────────

test('rangoDeSemana devuelve lunes a viernes', () => {
  // 2026-08-17 es lunes. La semana escolar termina el viernes: el fin de semana no tiene
  // actividad que mirar y solo ensucia el rango.
  assert.deepEqual(rangoDeSemana('2026-08-17'), { desde: '2026-08-17', hasta: '2026-08-21' });
  assert.deepEqual(rangoDeSemana('2026-08-19'), { desde: '2026-08-17', hasta: '2026-08-21' }, 'miércoles');
  assert.deepEqual(rangoDeSemana('2026-08-21'), { desde: '2026-08-17', hasta: '2026-08-21' }, 'viernes');
});

test('rangoDeSemana: el domingo NO salta a la semana siguiente', () => {
  // Es el caso que rompe la resta hecha a ojo: getUTCDay() devuelve 0 el domingo, y restarle
  // 0 - 1 manda al lunes de la semana que VIENE. Un directivo que abre la solapa un domingo
  // tiene que ver la semana que pasó, no una semana vacía que todavía no empezó.
  assert.deepEqual(rangoDeSemana('2026-08-16'), { desde: '2026-08-10', hasta: '2026-08-14' });
});

test('rangoDeSemana: el sábado sigue siendo la semana que termina', () => {
  assert.deepEqual(rangoDeSemana('2026-08-22'), { desde: '2026-08-17', hasta: '2026-08-21' });
});

test('rangoDeSemana cruza el mes y el año', () => {
  // Miércoles 2026-09-02: el lunes quedó en agosto.
  assert.deepEqual(rangoDeSemana('2026-09-02'), { desde: '2026-08-31', hasta: '2026-09-04' });
  // Viernes 2027-01-01: el lunes quedó en 2026.
  assert.deepEqual(rangoDeSemana('2027-01-01'), { desde: '2026-12-28', hasta: '2027-01-01' });
});

test('rangoDeHoy devuelve el mismo día en las dos puntas', () => {
  const r = rangoDeHoy();
  assert.equal(r.desde, r.hasta);
  assert.equal(diaValido(r.desde), true, 'y tiene que ser un día que el $match entienda');
});

// ── Qué fecha de la actividad se mide ────────────────────────────────────────

test('campoValido acepta los dos modos y nada más', () => {
  assert.equal(campoValido('creacion'), true);
  assert.equal(campoValido('entrega'),  true);
  assert.equal(campoValido('createdAt'), false, 'la llave es la del catálogo, no el campo de Mongo');
  assert.equal(campoValido(''), false);
  assert.equal(campoValido(undefined), false);
});

test('campoValido no se come lo heredado de Object.prototype', () => {
  // CAMPOS[campo] se interpola como NOMBRE DE CAMPO en el $match y en el $dateToString, y la
  // llave llega de la query string. Con un `in` o un truthy check en vez de hasOwn, un
  // ?campo=constructor pasaría la validación y armaría el pipeline con basura.
  assert.equal(campoValido('__proto__'), false);
  assert.equal(campoValido('constructor'), false);
  assert.equal(campoValido('toString'), false);
});

test('CAMPOS mapea a los campos reales de Activity', () => {
  assert.equal(CAMPOS.creacion, 'createdAt');
  assert.equal(CAMPOS.entrega,  'dueDate');
});
