// Tests de las decisiones puras de tools/comprimir-historico.js.
//
// Se prueban las DOS que, si se equivocan, arruinan archivos en silencio:
//   1. de qué fecha es un archivo (decide a cuáles se los toca)
//   2. si vale la pena reemplazarlo (decide si se los toca)
//
// La compresión en sí no se prueba acá: eso es sharp, y ya tiene sus propios tests en
// tests/images/. Lo que puede fallar sin que nadie lo note es el criterio.

'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const { fechaDeSubida, valeLaPena, AHORRO_MINIMO } = require('../../tools/comprimir-historico');

const stat = ms => ({ mtimeMs: ms });

test('la fecha sale del nombre del archivo, no del sistema de archivos', () => {
  // El nombre real de una entrega: <timestamp en ms>-<aleatorio>.jpg
  // 1785463964709 = 2026-07-31. El mtime dice otra cosa a propósito: gana el nombre, porque
  // el mtime ya sobrevivió a dos mudanzas de servidor y pudo alterarse en el camino.
  const t = fechaDeSubida('/x/1785463964709-y2i5z32ryd.jpg', stat(1600000000000));
  assert.strictEqual(t, 1785463964709);
});

test('sin timestamp en el nombre, cae al mtime', () => {
  const t = fechaDeSubida('/x/foto-de-la-tarea.jpg', stat(1785463964709));
  assert.strictEqual(t, 1785463964709);
});

test('un numero de 13 digitos que NO es una fecha razonable se ignora', () => {
  // 9999999999999 sería el año 2286: es una coincidencia de 13 dígitos, no un timestamp.
  // Sin esta guarda, un archivo así quedaría siempre fuera de cualquier filtro "hasta".
  const t = fechaDeSubida('/x/9999999999999-abc.jpg', stat(1785463964709));
  assert.strictEqual(t, 1785463964709);
});

test('el timestamp tiene que estar al PRINCIPIO del nombre', () => {
  const t = fechaDeSubida('/x/tarea-1785463964709.jpg', stat(1600000000000));
  assert.strictEqual(t, 1600000000000, 'un numero en el medio no es el prefijo de fecha');
});

test('se reemplaza cuando el ahorro alcanza el umbral', () => {
  // El caso real medido en produccion: 2,4 MB -> 0,6 MB, 75% de ahorro.
  assert.strictEqual(valeLaPena(2_400_000, 600_000), true);
});

test('NO se reemplaza si el ahorro es menor al umbral', () => {
  // 10% de ahorro: no justifica sumarle una generacion de perdida a la entrega de un alumno.
  assert.strictEqual(valeLaPena(1_000_000, 900_000), false);
});

test('NO se reemplaza si el archivo ENGORDA', () => {
  // Pasa con imagenes que ya venian optimizadas: recomprimirlas las agranda.
  // Tiene que quedar descartado por la misma comparacion, sin un caso aparte.
  assert.strictEqual(valeLaPena(500_000, 700_000), false);
});

test('el limite exacto del umbral cuenta como que vale la pena', () => {
  const justo = Math.round(1_000_000 * (1 - AHORRO_MINIMO));
  assert.strictEqual(valeLaPena(1_000_000, justo), true);
});

test('un archivo de tamano cero nunca se reemplaza', () => {
  // Sin esta guarda, 1 - x/0 da -Infinity o NaN y la comparacion se vuelve impredecible.
  assert.strictEqual(valeLaPena(0, 0), false);
});
