// Tests de la disponibilidad y las repeticiones (services/recursos/disponibilidad.js).
// Correr con: npm run test:unit
//
// Todo puro. Se testea acá y no con un smoke HTTP por los dos motivos de siempre en este
// proyecto:
//   - Depende del PASO DEL TIEMPO (qué fecha ya pasó, hasta cuándo se repite): hay que poder
//     inyectar el `hoy`, cosa que una request real no permite sin esperar a mañana.
//   - Depende de la ZONA HORARIA, y acá el bug que más caro sale es el que corre una fecha un
//     día: producción corre en UTC y el navegador tiene la zona que tenga.
//
// Cubre los criterios CA-07 a CA-14 de specs/recursos-reservas.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  sumarDias, diaSemana, lunesDe, diasDeSemana,
  diaCorto, diaLargo, diaNum,
  expandirSerie, MAX_FECHAS_SERIE, HORIZONTE_MAX_DIAS,
  estadoCelda, maximoPedible, esPasado,
} = require('../../services/recursos/disponibilidad');

// Recursos de la escuela, tal como quedaron cargados.
const SALA     = { divisible: false, capacidad: 20 };
const NETBOOKS = { divisible: true,  capacidad: 30, maxPorPedido: 15 };

// ── CA-07: la aritmética de días no se corre por zona horaria ───────────────
//
// 'YYYY-MM-DD' es un casillero de almanaque, no un instante. Si esto se resolviera con la
// zona local, el mismo cálculo daría distinto en el servidor (UTC) y en la máquina del aula.

test('sumarDias cruza fin de mes, fin de año y el 29 de febrero', () => {
  assert.strictEqual(sumarDias('2026-08-31', 1),  '2026-09-01');
  assert.strictEqual(sumarDias('2026-12-31', 1),  '2027-01-01');
  assert.strictEqual(sumarDias('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(sumarDias('2028-02-28', 1),  '2028-02-29', '2028 es bisiesto');
  assert.strictEqual(sumarDias('2026-08-26', 7),  '2026-09-02');
});

test('diaSemana da 1 para lunes y 7 para domingo', () => {
  // getUTCDay() da 0 para domingo; si eso se filtrara, el domingo se pintaría primero en la
  // grilla y el lunes segundo.
  assert.strictEqual(diaSemana('2026-08-24'), 1, 'lunes');
  assert.strictEqual(diaSemana('2026-08-25'), 2, 'martes');
  assert.strictEqual(diaSemana('2026-08-29'), 6, 'sábado');
  assert.strictEqual(diaSemana('2026-08-30'), 7, 'domingo');
});

test('lunesDe ancla cualquier día en el lunes de su semana', () => {
  for (const d of ['2026-08-24', '2026-08-26', '2026-08-28', '2026-08-30']) {
    assert.strictEqual(lunesDe(d), '2026-08-24', d);
  }
  assert.strictEqual(lunesDe('2026-08-31'), '2026-08-31', 'la semana siguiente');
});

test('diasDeSemana devuelve solo los días con actividad, en orden', () => {
  const l = diasDeSemana('2026-08-24', [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(l.map(d => d.date),
    ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28']);

  // La escuela no tiene sábado: no se pinta una columna vacía.
  assert.strictEqual(l.length, 5);
  assert.ok(!l.some(d => d.dow === 6));
});

// ── CA-08: mostrar un día no lo corre ───────────────────────────────────────
//
// Es el bug que entra por la puerta de al lado del de las tres horas: `new Date('2026-08-25')`
// es medianoche UTC, y formatearla en America/Argentina la muestra como el 24 a las 21:00.

test('el día que se muestra es el día que dice el string', () => {
  assert.match(diaCorto('2026-08-25'), /^25 /, 'no puede decir 24');
  assert.match(diaLargo('2026-08-25'), /^martes/, '25/08/2026 es martes');
  assert.strictEqual(diaNum('2026-08-25'), '25/8');

  // El 1 de enero es el caso peor: correrlo un día cambia el AÑO.
  assert.match(diaLargo('2026-01-01'), /1 de enero/);
});

test('una fecha inválida se muestra vacía, no como "Invalid Date"', () => {
  assert.strictEqual(diaCorto('borrame'), '');
  assert.strictEqual(diaLargo(null), '');
  assert.strictEqual(diaNum(undefined), '');
});

// ── CA-09: las repeticiones ─────────────────────────────────────────────────
//
// Se MATERIALIZAN: esto devuelve la lista de fechas y después se crea una Reserva por cada
// una. Ver el comentario del índice en models/Reserva.js.

test('la repetición única es una sola fecha', () => {
  const { fechas, error } = expandirSerie({ desde: '2026-08-26', repeticion: 'unica' });
  assert.strictEqual(error, null);
  assert.deepStrictEqual(fechas, ['2026-08-26']);
});

test('la semanal cae siempre el mismo día de la semana', () => {
  const { fechas } = expandirSerie({
    desde: '2026-08-26', repeticion: 'semanal', hasta: '2026-09-16',
  });
  assert.deepStrictEqual(fechas, ['2026-08-26', '2026-09-02', '2026-09-09', '2026-09-16']);
  assert.ok(fechas.every(f => diaSemana(f) === 3), 'todos miércoles');
});

test('cada 15 días saltea una semana', () => {
  const { fechas } = expandirSerie({
    desde: '2026-08-26', repeticion: 'quincenal', hasta: '2026-10-07',
  });
  assert.deepStrictEqual(fechas, ['2026-08-26', '2026-09-09', '2026-09-23', '2026-10-07']);
});

test('no se puede arrancar una serie un día sin actividad', () => {
  const { fechas, error } = expandirSerie({
    desde: '2026-08-29', repeticion: 'semanal', hasta: '2026-09-30', dias: [1, 2, 3, 4, 5],
  });
  assert.strictEqual(fechas.length, 0);
  assert.match(error, /no tiene actividad/i);
});

test('una repetición sin fecha final se rechaza', () => {
  // Sin tope, "todos los martes" son infinitos martes.
  const { error } = expandirSerie({ desde: '2026-08-25', repeticion: 'semanal' });
  assert.match(error, /hasta qué fecha/i);
});

test('los dos topes: horizonte de un año y cantidad de fechas', () => {
  const lejos = expandirSerie({
    desde: '2026-08-25', repeticion: 'semanal', hasta: '2030-08-25',
  });
  assert.match(lejos.error, /más de un año/i);

  // Dentro del año pero con demasiadas fechas: un ciclo lectivo entero son ~40 semanas.
  const muchas = expandirSerie({
    desde: '2026-01-06', repeticion: 'semanal', hasta: '2026-12-15',
  });
  assert.match(muchas.error, new RegExp(String(MAX_FECHAS_SERIE)));
  assert.ok(HORIZONTE_MAX_DIAS >= 365);
});

test('una fecha final anterior a la inicial se rechaza', () => {
  const { error } = expandirSerie({
    desde: '2026-08-26', repeticion: 'semanal', hasta: '2026-08-01',
  });
  assert.match(error, /anterior/i);
});

// ── CA-10: el estado de una celda ───────────────────────────────────────────
//
// La celda dice cosas distintas según el recurso, y no es cosmético: "ocupada" con 12 de 30
// netbooks tomadas es falso, y el docente que necesita 10 se va creyendo que no hay.

test('sala: una sola reserva confirmada la deja sin lugar', () => {
  const c = estadoCelda({ recurso: SALA, reservas: [{ status: 'confirmada', unidades: 1, docente: 'a' }] });
  assert.strictEqual(c.capacidad, 1, 'un recurso exclusivo vale 1, no sus 20 máquinas');
  assert.strictEqual(c.libres, 0);
  assert.strictEqual(c.completo, true);
});

test('sala vacía: libre', () => {
  const c = estadoCelda({ recurso: SALA, reservas: [] });
  assert.strictEqual(c.libres, 1);
  assert.strictEqual(c.completo, false);
});

test('netbooks: 12 tomadas dejan 18 libres, y la celda NO está completa', () => {
  const c = estadoCelda({ recurso: NETBOOKS, reservas: [{ status: 'confirmada', unidades: 12, docente: 'a' }] });
  assert.strictEqual(c.tomadas, 12);
  assert.strictEqual(c.libres, 18);
  assert.strictEqual(c.completo, false);
});

test('netbooks: dos docentes con 15 cada uno agotan el carro', () => {
  const c = estadoCelda({ recurso: NETBOOKS, reservas: [
    { status: 'confirmada', unidades: 15, docente: 'a' },
    { status: 'confirmada', unidades: 15, docente: 'b' },
  ] });
  assert.strictEqual(c.tomadas, 30);
  assert.strictEqual(c.libres, 0);
  assert.strictEqual(c.completo, true);
});

test('un PENDIENTE no ocupa cupo', () => {
  // Es la contracara del índice parcial de models/Reserva.js: los pendientes no bloquean el
  // casillero. Si contaran, un pedido sin resolver le cerraría la puerta a un docente ya
  // autorizado.
  const c = estadoCelda({ recurso: NETBOOKS, reservas: [
    { status: 'pendiente', unidades: 20, docente: 'a' },
  ] });
  assert.strictEqual(c.tomadas, 0);
  assert.strictEqual(c.libres, 30);
  assert.strictEqual(c.pendientes.length, 1);
});

test('la celda reconoce lo propio: reserva mía y pedido mío en espera', () => {
  const mia = estadoCelda({
    recurso: SALA, userId: 'u1',
    reservas: [{ status: 'confirmada', unidades: 1, docente: 'u1' }],
  });
  assert.strictEqual(mia.esMia, true);

  const pend = estadoCelda({
    recurso: NETBOOKS, userId: 'u1',
    reservas: [{ status: 'pendiente', unidades: 5, docente: 'u1' }],
  });
  assert.strictEqual(pend.tengoPendiente, true);
  assert.strictEqual(pend.esMia, false);
});

// ── CA-11: el tope de lo que se puede pedir ─────────────────────────────────
//
// Es el `max` del formulario Y el número que revalida la ruta: un `max` de un <input> se
// edita con el inspector en dos segundos.

test('maximoPedible topea por maxPorPedido y por lo que queda libre', () => {
  const vacia = estadoCelda({ recurso: NETBOOKS, reservas: [] });
  assert.strictEqual(maximoPedible(NETBOOKS, vacia), 15, 'con 30 libres, el tope es el del pedido');

  const con22 = estadoCelda({ recurso: NETBOOKS, reservas: [{ status: 'confirmada', unidades: 22, docente: 'a' }] });
  assert.strictEqual(maximoPedible(NETBOOKS, con22), 8, 'quedan 8: manda lo que hay, no el tope');

  const llena = estadoCelda({ recurso: NETBOOKS, reservas: [{ status: 'confirmada', unidades: 30, docente: 'a' }] });
  assert.strictEqual(maximoPedible(NETBOOKS, llena), 0);
});

test('en un recurso exclusivo siempre se pide 1', () => {
  const c = estadoCelda({ recurso: SALA, reservas: [] });
  assert.strictEqual(maximoPedible(SALA, c), 1, 'no se piden "5 salas de computación"');
});

test('sin maxPorPedido el tope es la capacidad entera', () => {
  const pool = { divisible: true, capacidad: 8, maxPorPedido: null };
  const c = estadoCelda({ recurso: pool, reservas: [] });
  assert.strictEqual(maximoPedible(pool, c), 8);
});

// ── CA-12: el pasado ────────────────────────────────────────────────────────
test('esPasado compara días, no instantes', () => {
  assert.strictEqual(esPasado('2026-08-24', '2026-08-25'), true);
  assert.strictEqual(esPasado('2026-08-25', '2026-08-25'), false, 'hoy todavía se puede usar');
  assert.strictEqual(esPasado('2026-08-26', '2026-08-25'), false);
  assert.strictEqual(esPasado('borrame', '2026-08-25'), false, 'basura no es "pasado"');
});
