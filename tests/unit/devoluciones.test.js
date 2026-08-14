// Tests de la recolección de notas y devoluciones del docente (public/js/devoluciones.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// EL BUG QUE ESTOS TESTS BLOQUEAN (reclamado por los docentes el 2026-08-13):
// la tabla de calificaciones iteraba los inputs de NOTA y, si la nota estaba vacía, salteaba
// la fila entera con un `return`. El comentario que el docente había escrito para el alumno
// nunca se mandaba al servidor — y encima la pantalla decía "✓ Notas guardadas".
// El primer test de este archivo es exactamente ese caso.

const test   = require('node:test');
const assert = require('node:assert');

const { recolectarDevoluciones, resumenGuardado } = require('../../public/js/devoluciones');

// Fila como la arma saveAllGrades a partir del DOM. Por defecto: nada cargado antes.
const fila = (over = {}) => ({
  studentId: 'alu1', nombre: 'Ana', nota: '', feedback: '',
  notaPrevia: '', feedbackPrevia: '', ...over,
});

// ── El bug reclamado ─────────────────────────────────────────────────────────

test('la devolución escrita SIN nota se guarda igual (bug 2026-08-13)', () => {
  const { guardar } = recolectarDevoluciones([
    fila({ feedback: 'Muy buen trabajo, revisá la consigna 3' }),
  ], 10);

  assert.equal(guardar.length, 1, 'la fila no se puede descartar por no tener nota');
  assert.equal(guardar[0].studentId, 'alu1');
  assert.equal(guardar[0].feedback, 'Muy buen trabajo, revisá la consigna 3');
  assert.equal('points' in guardar[0], false,
    'sin nota no se manda points: el servidor no debe pisar una nota ya cargada');
});

test('editar la devolución de un alumno ya calificado no toca su nota', () => {
  // El docente ve la nota 8 en pantalla, no la toca, y escribe la devolución.
  const { guardar } = recolectarDevoluciones([
    fila({ nota: '8', notaPrevia: '8', feedback: 'Prolijo', feedbackPrevia: '' }),
  ], 10);

  assert.equal(guardar.length, 1);
  assert.equal(guardar[0].feedback, 'Prolijo');
  assert.equal('points' in guardar[0], false,
    'la nota no cambió: no se manda, y el servidor conserva el 8 que ya estaba');
});

test('poner la nota por primera vez la manda junto con la devolución que ya había', () => {
  const { guardar } = recolectarDevoluciones([
    fila({ nota: '8', notaPrevia: '', feedback: 'Prolijo', feedbackPrevia: 'Prolijo' }),
  ], 10);

  assert.deepEqual(guardar, [{ studentId: 'alu1', points: 8, feedback: 'Prolijo' }]);
});

test('vaciar el textarea manda la devolución vacía para poder borrarla', () => {
  const { guardar } = recolectarDevoluciones([
    fila({ feedback: '', feedbackPrevia: 'Comentario viejo' }),
  ], 10);

  assert.equal(guardar.length, 1);
  assert.equal(guardar[0].feedback, '');
});

// ── Nota + devolución juntas ─────────────────────────────────────────────────

test('nota y devolución cargadas juntas viajan en la misma entrada', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ nota: '7', feedback: 'Bien encarado' }),
  ], 10);

  assert.equal(invalidas.length, 0);
  assert.deepEqual(guardar, [{ studentId: 'alu1', points: 7, feedback: 'Bien encarado' }]);
});

test('la nota viaja como número, no como el string del input', () => {
  const { guardar } = recolectarDevoluciones([fila({ nota: '9' })], 10);
  assert.strictEqual(guardar[0].points, 9);
});

test('acepta los extremos del rango: 0 y el máximo', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: '0' }),
    fila({ studentId: 'b', nota: '10' }),
  ], 10);

  assert.equal(invalidas.length, 0, '0 y el máximo son notas válidas');
  assert.deepEqual(guardar.map(g => g.points), [0, 10]);
});

// ── Filas que no hay que mandar ──────────────────────────────────────────────

test('no manda las filas que el docente no tocó', () => {
  const { guardar } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: '8', notaPrevia: '8', feedback: 'Igual', feedbackPrevia: 'Igual' }),
    fila({ studentId: 'b' }), // alumno sin nota ni devolución, nunca tocado
  ], 10);

  assert.equal(guardar.length, 0);
});

test('los espacios de más no cuentan como un cambio', () => {
  const { guardar } = recolectarDevoluciones([
    fila({ feedback: '  Igual  ', feedbackPrevia: 'Igual' }),
  ], 10);

  assert.equal(guardar.length, 0);
});

// ── Notas mal cargadas: se avisan, no se descartan calladas ──────────────────

test('la nota mayor al máximo se reporta como inválida y no se guarda', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ nota: '11' }),
  ], 10);

  assert.equal(guardar.length, 0);
  assert.equal(invalidas.length, 1, 'antes se descartaba sin avisarle al docente');
  assert.equal(invalidas[0].nombre, 'Ana');
  assert.equal(invalidas[0].nota, '11');
});

test('la nota negativa o no numérica se reporta como inválida', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: '-1' }),
    fila({ studentId: 'b', nota: 'ocho' }),
  ], 10);

  assert.equal(guardar.length, 0);
  assert.equal(invalidas.length, 2);
});

test('sin máximo definido no hay tope superior', () => {
  const { guardar, invalidas } = recolectarDevoluciones([fila({ nota: '150' })], null);

  assert.equal(invalidas.length, 0);
  assert.equal(guardar[0].points, 150);
});

test('una nota inválida no arrastra a las filas buenas', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: '99' }),
    fila({ studentId: 'b', nota: '7', feedback: 'Muy bien' }),
    fila({ studentId: 'c', feedback: 'Rehacer el punto 2' }),
  ], 10);

  assert.deepEqual(invalidas.map(i => i.studentId), ['a']);
  assert.deepEqual(guardar.map(g => g.studentId), ['b', 'c']);
});

// ── Entradas raras ───────────────────────────────────────────────────────────

test('no explota con una lista vacía ni con undefined', () => {
  assert.deepEqual(recolectarDevoluciones([], 10), { guardar: [], invalidas: [] });
  assert.deepEqual(recolectarDevoluciones(undefined, 10), { guardar: [], invalidas: [] });
});

test('trata null y undefined de los campos como vacío', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    { studentId: 'a', nota: null, feedback: undefined },
  ], 10);

  assert.equal(guardar.length, 0);
  assert.equal(invalidas.length, 0);
});

test('la nota previa numérica (viene del servidor, no del DOM) se compara sin falsos cambios', () => {
  // studentGrades trae points como Number; el input lo muestra como string.
  const { guardar } = recolectarDevoluciones([
    fila({ nota: '8', notaPrevia: 8 }),
  ], 10);

  assert.equal(guardar.length, 0, '8 y "8" son la misma nota');
});

// ── El cartel de confirmación ────────────────────────────────────────────────
// Antes decía "✓ Notas guardadas" incluso cuando no se había guardado nada.

test('resumenGuardado no dice "guardado" cuando no se guardó nada', () => {
  assert.equal(resumenGuardado([]), 'No había cambios para guardar');
});

test('resumenGuardado distingue notas de devoluciones', () => {
  const soloNota = [{ studentId: 'a', points: 7, feedback: '' }];
  const soloDev  = [{ studentId: 'b', feedback: 'Ojo con la ortografía' }];

  assert.match(resumenGuardado(soloNota), /nota/i);
  assert.doesNotMatch(resumenGuardado(soloNota), /devoluci/i);
  assert.match(resumenGuardado(soloDev), /devoluci/i);
  assert.match(resumenGuardado([...soloNota, ...soloDev]), /nota.*devoluci/i);
});

test('una nota de 0 cuenta como nota en el resumen', () => {
  // Con `e.points !== undefined` un 0 sigue siendo nota; con un chequeo por falsy, no.
  assert.match(resumenGuardado([{ studentId: 'a', points: 0, feedback: '' }]), /1 nota/);
});
