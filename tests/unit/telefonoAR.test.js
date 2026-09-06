// Tests de la normalización de celulares argentinos a E.164 (services/telefonoAR.js).
//
// Es la pieza más fácil de arruinar de la verificación de contacto y la más barata de dejar
// probada: módulo puro, sin base ni red. Los casos de abajo son los que la gente ESCRIBE de
// verdad en el campo "Celular" del perfil, no variantes inventadas — el «15» del marcado local
// y el «9» del internacional se pisan entre sí, así que `+54 261 15 555-1234` está mal de dos
// formas a la vez y es de lo más común que se carga.
//
// Criterios de aceptación en specs/verificacion-de-contacto.spec.md (sección "Normalización de
// teléfono").

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { normalizar, enmascarar } = require('../../services/telefonoAR');

// El mismo celular de Mendoza escrito de las ocho formas en que llega.
const MENDOZA = '+5492615551234';

describe('normalizar — el número argentino, escrito como lo escribe la gente', () => {
  const equivalentes = [
    ['2615551234',          'los 10 dígitos pelados'],
    ['261 555 1234',        'con espacios'],
    ['261 15 555-1234',     'con el 15 del marcado local'],
    ['261155551234',        'con el 15 y todo pegado'],
    ['0261 155551234',      'con el 0 de larga distancia y el 15'],
    ['(261) 15 555 1234',   'con paréntesis, como sale de una agenda'],
    ['+54 9 261 555 1234',  'internacional bien escrito'],
    [MENDOZA,               'internacional ya normalizado'],
    ['+54 261 15 555-1234', 'internacional MAL escrito: +54 y 15 juntos'],
  ];

  for (const [entrada, descripcion] of equivalentes) {
    test(`"${entrada}" → ${MENDOZA} (${descripcion})`, () => {
      const r = normalizar(entrada);
      assert.strictEqual(r.error, null, `no debería dar error: ${r.error}`);
      assert.strictEqual(r.e164, MENDOZA);
    });
  }

  test('Buenos Aires: el área de 2 dígitos también deja sacar el 15', () => {
    // 11 (área) + 15 (local) + 5555-1234 (abonado)
    assert.strictEqual(normalizar('11 15 5555 1234').e164, '+5491155551234');
    assert.strictEqual(normalizar('1155551234').e164,      '+5491155551234');
  });

  test('área de 4 dígitos (2604, San Rafael): el abonado es más corto y sigue dando 10', () => {
    assert.strictEqual(normalizar('2604 15 55-1234').e164, '+5492604551234');
    assert.strictEqual(normalizar('2604551234').e164,      '+5492604551234');
  });
});

describe('normalizar — lo que no se toca', () => {
  test('otro país se respeta tal cual', () => {
    const r = normalizar('+1 415 555 2671');
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.e164, '+14155552671');
  });

  test('un 15 que NO es el del marcado local no se saca', () => {
    // 261 555-1512: el "15" está adentro del número de abonado. Sacarlo dejaría 8 dígitos,
    // así que la regla de "tiene que quedar en 10" lo protege.
    assert.strictEqual(normalizar('261 555 1512').e164, '+5492615551512');
  });

  test('un número de Buenos Aires que empieza con 15 no se mutila', () => {
    // 11-5545-1234 escrito sin el área es 1155451234: ya son 10 dígitos, no se toca nada.
    assert.strictEqual(normalizar('1155451234').e164, '+5491155451234');
  });
});

describe('normalizar — lo que se rechaza', () => {
  test('vacío NO es un error: es alguien que todavía no cargó su celular', () => {
    for (const vacio of ['', '   ', null, undefined]) {
      const r = normalizar(vacio);
      assert.strictEqual(r.e164, null);
      assert.strictEqual(r.error, null, 'un campo vacío no le tiene que gritar a nadie');
    }
  });

  test('demasiado corto → error visible', () => {
    const r = normalizar('1234');
    assert.strictEqual(r.e164, null);
    assert.ok(r.error, 'tiene que explicar por qué no sirve');
  });

  test('demasiado largo → error visible', () => {
    const r = normalizar('261555123456789');
    assert.strictEqual(r.e164, null);
    assert.ok(r.error);
  });

  test('internacional fuera del rango de E.164 → error', () => {
    assert.ok(normalizar('+123').error);
    assert.ok(normalizar('+1234567890123456').error);
  });

  test('texto sin ningún dígito → error', () => {
    const r = normalizar('no tengo');
    assert.strictEqual(r.e164, null);
    assert.ok(r.error);
  });
});

describe('enmascarar', () => {
  test('deja reconocer el propio número sin dictárselo a nadie', () => {
    assert.strictEqual(enmascarar(MENDOZA), '+549261***1234');
  });

  test('sin número no rompe', () => {
    assert.strictEqual(enmascarar(null), '');
    assert.strictEqual(enmascarar(''),   '');
  });
});
