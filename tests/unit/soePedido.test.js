// Tests de los catálogos del pedido de derivación preceptor → SOE (services/soeAcceso.js).
// Correr con: npm run test:unit
//
// El único que importa de verdad es el primero: que `derivacion` NO esté en la lista que
// dibuja el formulario. Ver la trampa del D3 de specs/soe-derivacion-y-linea-de-tiempo.spec.md
// — si el SOE puede elegir ese tipo a mano, puede fabricar una derivación de preceptoría que
// nunca existió, y la línea de tiempo la muestra igual de firme que a la real.
//
// Cubren los criterios 12 a 14 de la spec.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  TIPOS_ENTRADA, TIPOS_ENTRADA_MANUALES,
  TIPO_ENTRADA_LABELS, TIPO_ENTRADA_ICONS,
  URGENCIAS, URGENCIA_LABELS,
  ESTADOS_PEDIDO, ESTADO_PEDIDO_LABELS,
} = require('../../services/soeAcceso');

describe('tipos de entrada: el enum y lo que ofrece el formulario', () => {
  test('el enum acepta `derivacion` pero el formulario NO lo ofrece (criterio 12)', () => {
    assert.ok(TIPOS_ENTRADA.includes('derivacion'),
      'el schema tiene que aceptarlo: es el hito que empuja POST /soe/pedidos/:id/tomar');
    assert.ok(!TIPOS_ENTRADA_MANUALES.includes('derivacion'),
      'el SOE no puede fabricar a mano una derivación de preceptoría');
  });

  test('todo lo que ofrece el formulario lo acepta el schema (criterio 13)', () => {
    // Al revés sería un ValidationError en la cara del usuario al guardar una entrada.
    for (const t of TIPOS_ENTRADA_MANUALES) {
      assert.ok(TIPOS_ENTRADA.includes(t), `${t} está en el <select> pero no en el enum`);
    }
  });

  test('la lista manual es el enum menos `derivacion`, y nada más', () => {
    // Evita el olvido al revés: sumar un tipo nuevo al enum y que no aparezca en el
    // formulario sin que nadie se entere.
    assert.deepStrictEqual(
      TIPOS_ENTRADA_MANUALES.slice().sort(),
      TIPOS_ENTRADA.filter(t => t !== 'derivacion').sort(),
    );
  });

  test('cada tipo tiene label e ícono (criterio 14)', () => {
    for (const t of TIPOS_ENTRADA) {
      assert.ok(TIPO_ENTRADA_LABELS[t], `falta el label de ${t}`);
      assert.ok(TIPO_ENTRADA_ICONS[t],  `falta el ícono de ${t}`);
    }
  });
});

describe('catálogos del pedido', () => {
  test('las urgencias tienen su label', () => {
    assert.deepStrictEqual(URGENCIAS, ['baja', 'media', 'alta']);
    for (const u of URGENCIAS) assert.ok(URGENCIA_LABELS[u], `falta el label de ${u}`);
  });

  test('los estados del pedido tienen su label', () => {
    assert.deepStrictEqual(ESTADOS_PEDIDO, ['pendiente', 'tomada', 'descartada']);
    for (const e of ESTADOS_PEDIDO) assert.ok(ESTADO_PEDIDO_LABELS[e], `falta el label de ${e}`);
  });
});
