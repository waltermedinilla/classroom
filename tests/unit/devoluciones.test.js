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

const {
  recolectarDevoluciones, resumenGuardado, notaValidaManual, NOTA_MINIMA,
} = require('../../public/js/devoluciones');

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

// ⚠️ Este test decía "acepta los extremos: 0 y el máximo" hasta el 2026-09-06. Cambió porque
// cambió la regla, no porque estuviera mal escrito: la nota mínima de la escuela es 1.
test('acepta los extremos del rango: la mínima y el máximo', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: String(NOTA_MINIMA) }),
    fila({ studentId: 'b', nota: '10' }),
  ], 10);

  assert.equal(invalidas.length, 0, 'la mínima y el máximo son notas válidas');
  assert.deepEqual(guardar.map(g => g.points), [NOTA_MINIMA, 10]);
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

// ── La nota mínima es 1 (2026-09-06) ─────────────────────────────────────────
//
// Por qué existe esta tanda: `Number('')` fabricó 128 notas en 0 que ningún docente puso, y una
// vez reparadas aparecieron 47 ceros MÁS, todos posteriores al fix del bug — o sea tipeados a
// mano. El 0 es lo que la gente escribe para decir "corregí pero no le pongo nota". La regla de
// la escuela es que la nota más baja es 1.

test('el 0 cargado a mano es inválido: la nota mínima es 1', () => {
  const veredicto = notaValidaManual('0', 10);

  assert.equal(veredicto.ok, false);
  assert.equal(veredicto.points, undefined, 'una nota rechazada no devuelve valor');
});

test('el rechazo del 0 nombra la alternativa, no solo el error', () => {
  // El mensaje es la mitad del arreglo: quien escribe 0 quiere decir "sin nota", y si no se le
  // dice cómo se hace eso, va a volver a escribir 0 (o a inventar un 1 que no corresponde).
  const { error } = notaValidaManual('0', 10);

  assert.match(error, /más baja es 1/i, 'tiene que decir cuál es el mínimo');
  assert.match(error, /vacío/i,         'tiene que decir que se deja el casillero vacío');
  assert.match(error, /devoluci/i,      'tiene que nombrar la devolución sin nota');
});

test('la mínima exacta se acepta y devuelve número', () => {
  const veredicto = notaValidaManual(String(NOTA_MINIMA), 10);

  assert.equal(veredicto.ok, true);
  assert.strictEqual(veredicto.points, NOTA_MINIMA);
});

test('notaValidaManual sigue cubriendo el resto del rango', () => {
  assert.equal(notaValidaManual('-1', 10).ok,   false, 'negativa');
  assert.equal(notaValidaManual('ocho', 10).ok, false, 'no numérica');
  assert.equal(notaValidaManual('11', 10).ok,   false, 'por encima del máximo');
  assert.equal(notaValidaManual('150', null).ok, true, 'sin máximo no hay tope');
  assert.equal(notaValidaManual(7, 10).ok,       true, 'acepta número, no solo string');
});

test('la tabla de notas rechaza el 0 y dice por qué en esa fila', () => {
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ studentId: 'a', nota: '0' }),
    fila({ studentId: 'b', nota: '6' }),
  ], 10);

  assert.deepEqual(guardar.map(g => g.studentId), ['b'], 'el 0 no se guarda; el 6 sí');
  assert.deepEqual(invalidas.map(i => i.studentId), ['a']);
  assert.match(invalidas[0].error, /más baja es 1/i,
    'el motivo viaja por fila: con 30 alumnos, "fuera de rango" no dice cuál falló ni por qué');
});

test('el 0 con devolución escrita tampoco entra, pero la devolución no se pierde', () => {
  // Es EXACTAMENTE el caso que fabricó los 47: corregir, escribir la devolución y poner 0.
  // Lo que corresponde es que se guarde la devolución sin nota, no que se guarde un 0.
  const { guardar, invalidas } = recolectarDevoluciones([
    fila({ nota: '0', feedback: 'Rehacer el punto 2' }),
  ], 10);

  assert.equal(guardar.length, 0, 'con la nota inválida la fila entera se frena y se avisa');
  assert.equal(invalidas.length, 1);
  assert.equal(invalidas[0].nota, '0');
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
  //
  // ⚠️ Que la carga manual ya no acepte el 0 NO vuelve inútil este test: resumenGuardado cuenta
  // lo que le pasan, y lo que distingue es "hay nota" de "no hay nota" (`undefined`). El 0 es el
  // valor con el que esa distinción se rompe si alguien la escribe como `if (e.points)`. Además
  // el autocalificador sí produce ceros legítimos.
  assert.match(resumenGuardado([{ studentId: 'a', points: 0, feedback: '' }]), /1 nota/);
});
