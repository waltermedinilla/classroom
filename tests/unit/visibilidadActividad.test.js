// Tests de la regla de visibilidad de actividades (public/js/visibilidadActividad.js).
//
// Caso real que originó la feature (2026-08-18): el docente prepara la actividad de la clase
// del martes y la carga el domingo con "Disponible desde: martes". Antes quedaba publicada al
// instante para el alumno y, del lado del docente, no había ninguna marca de que estuviera
// programada ni forma de adelantarla o bajarla.
//
// Criterios de aceptación en specs/visibilidad-actividades.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  VISIBLE, PROGRAMADA, OCULTA,
  estadoVisibilidad,
  esVisibleParaAlumno,
  etiquetaVisibilidad,
  proximoOverride,
  filtroVisibleParaAlumno,
} = require('../../public/js/visibilidadActividad');

// Momento fijo para que los tests no dependan del reloj real.
const AHORA  = new Date('2026-08-18T10:00:00Z');
const MANANA = new Date('2026-08-19T08:00:00Z');
const AYER   = new Date('2026-08-17T08:00:00Z');

describe('estadoVisibilidad', () => {
  test('availableFrom futura y sin override → programada (criterio 1)', () => {
    const act = { availableFrom: MANANA };
    assert.strictEqual(estadoVisibilidad(act, AHORA), PROGRAMADA);
    assert.strictEqual(esVisibleParaAlumno(act, AHORA), false);
  });

  test('availableFrom pasada y sin override → visible (criterio 2)', () => {
    assert.strictEqual(estadoVisibilidad({ availableFrom: AYER }, AHORA), VISIBLE);
  });

  test('documento histórico sin visibleOverride se lee como automático (criterio 3)', () => {
    // Lo que hay hoy en producción: availableFrom sí, visibleOverride no existe.
    const viejaPublicada  = { availableFrom: AYER };
    const viejaProgramada = { availableFrom: MANANA };
    assert.strictEqual(estadoVisibilidad(viejaPublicada,  AHORA), VISIBLE);
    assert.strictEqual(estadoVisibilidad(viejaProgramada, AHORA), PROGRAMADA);
    // Y con el campo explícitamente en null (lo que escribe el default del schema): igual.
    assert.strictEqual(estadoVisibilidad({ availableFrom: AYER, visibleOverride: null }, AHORA), VISIBLE);
  });

  test('el ojo en "mostrar" gana sobre una fecha futura (criterio 4)', () => {
    assert.strictEqual(estadoVisibilidad({ availableFrom: MANANA, visibleOverride: true }, AHORA), VISIBLE);
  });

  test('el ojo en "ocultar" gana sobre una fecha ya pasada (criterio 5)', () => {
    assert.strictEqual(estadoVisibilidad({ availableFrom: AYER, visibleOverride: false }, AHORA), OCULTA);
  });

  test('llegada la fecha, la programada se publica sola (criterio 6)', () => {
    // Mismo documento, sin ningún save() en el medio: solo avanza el reloj.
    const act = { availableFrom: MANANA };
    assert.strictEqual(estadoVisibilidad(act, AHORA), PROGRAMADA);
    assert.strictEqual(estadoVisibilidad(act, new Date('2026-08-19T08:00:00Z')), VISIBLE);
    assert.strictEqual(estadoVisibilidad(act, new Date('2026-08-19T09:00:00Z')), VISIBLE);
  });

  test('availableFrom en string ISO (como llega por JSON al navegador)', () => {
    assert.strictEqual(estadoVisibilidad({ availableFrom: MANANA.toISOString() }, AHORA), PROGRAMADA);
    assert.strictEqual(estadoVisibilidad({ availableFrom: AYER.toISOString() },   AHORA), VISIBLE);
  });

  test('sin availableFrom se considera publicada, no invisible', () => {
    assert.strictEqual(estadoVisibilidad({}, AHORA), VISIBLE);
  });

  test('las etiquetas del chip van en español', () => {
    assert.strictEqual(etiquetaVisibilidad(VISIBLE),    'Visible');
    assert.strictEqual(etiquetaVisibilidad(PROGRAMADA), 'Programada');
    assert.strictEqual(etiquetaVisibilidad(OCULTA),     'Oculta');
  });
});

describe('proximoOverride — el ojo es un interruptor de dos posiciones', () => {
  test('programada: el ojo la muestra y el segundo click vuelve al automático (criterio 7)', () => {
    const act = { availableFrom: MANANA };
    assert.strictEqual(proximoOverride(act, AHORA), true);

    // Segundo click: alcanza con volver al automático (la fecha sigue siendo futura),
    // así que NO se fija false — la actividad queda esperando su martes.
    const segundo = proximoOverride({ availableFrom: MANANA, visibleOverride: true }, AHORA);
    assert.strictEqual(segundo, null);
    assert.strictEqual(estadoVisibilidad({ availableFrom: MANANA, visibleOverride: segundo }, AHORA), PROGRAMADA);
    // Y el martes se publica sola igual que si nunca la hubieran tocado.
    assert.strictEqual(estadoVisibilidad({ availableFrom: MANANA, visibleOverride: segundo }, MANANA), VISIBLE);
  });

  test('visible por fecha: el ojo la oculta y el segundo click la devuelve (criterio 8)', () => {
    assert.strictEqual(proximoOverride({ availableFrom: AYER }, AHORA), false);

    const segundo = proximoOverride({ availableFrom: AYER, visibleOverride: false }, AHORA);
    assert.strictEqual(segundo, null);
    assert.strictEqual(estadoVisibilidad({ availableFrom: AYER, visibleOverride: segundo }, AHORA), VISIBLE);
  });

  test('cada click invierte el estado efectivo, siempre', () => {
    const casos = [
      { availableFrom: AYER },
      { availableFrom: MANANA },
      { availableFrom: AYER,   visibleOverride: false },
      { availableFrom: MANANA, visibleOverride: true },
    ];
    casos.forEach(act => {
      const antes   = esVisibleParaAlumno(act, AHORA);
      const despues = esVisibleParaAlumno(
        { availableFrom: act.availableFrom, visibleOverride: proximoOverride(act, AHORA) },
        AHORA,
      );
      assert.strictEqual(despues, !antes, JSON.stringify(act));
    });
  });
});

describe('filtroVisibleParaAlumno', () => {
  // Evaluador mínimo del fragmento de query: solo entiende lo que el filtro usa ($or, $ne,
  // $lte). Sirve para comparar el filtro de Mongo contra la función pura sin levantar la base.
  function matchea(filtro, doc) {
    return Object.entries(filtro).every(([clave, cond]) => {
      if (clave === '$or')  return cond.some(sub => matchea(sub, doc));
      if (clave === '$and') return cond.every(sub => matchea(sub, doc));
      const valor = doc[clave];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('$ne'  in cond) return valor !== cond.$ne;
        if ('$lte' in cond) return valor != null && new Date(valor) <= new Date(cond.$lte);
      }
      return valor === cond;
    });
  }

  test('acepta exactamente los mismos documentos que la función pura (criterio 9)', () => {
    const fechas    = [AYER, AHORA, MANANA];
    const overrides = [undefined, null, true, false];
    const filtro    = filtroVisibleParaAlumno(AHORA);

    fechas.forEach(availableFrom => {
      overrides.forEach(visibleOverride => {
        const doc = { availableFrom };
        if (visibleOverride !== undefined) doc.visibleOverride = visibleOverride;

        assert.strictEqual(
          matchea(filtro, doc),
          esVisibleParaAlumno(doc, AHORA),
          `divergen para ${JSON.stringify({ availableFrom, visibleOverride })}`,
        );
      });
    });
  });

  test('el documento histórico sin el campo entra por el $ne: false', () => {
    const filtro = filtroVisibleParaAlumno(AHORA);
    assert.strictEqual(matchea(filtro, { availableFrom: AYER }),   true);
    assert.strictEqual(matchea(filtro, { availableFrom: MANANA }), false);
  });

  test('devuelve un $or de primer nivel — hay que anidarlo en $and, no asignarlo', () => {
    // El filtro de enrollmentDates de GET /course/:id también usa $or sobre el mismo objeto:
    // si los dos se asignan a query.$or, el segundo pisa al primero y el alumno ve las
    // programadas. Este test deja constancia de por qué la ruta arma un $and.
    assert.ok(Array.isArray(filtroVisibleParaAlumno(AHORA).$or));
  });
});
