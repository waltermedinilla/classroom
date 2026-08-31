// Tests de la regla de caducidad de pendientes (public/js/pendienteActividad.js).
//
// Caso real que originó la feature (2026-08-23): al alumno le figuraban como "tareas para
// entregar" actividades expiradas hacía semanas. Eran dos agujeros — la actividad sin fecha
// de entrega y la vencida con tardías abiertas — que el filtro anterior dejaba pendientes
// para siempre. En el espejo local eran 113 de 674 actividades.
//
// Criterios de aceptación en specs/pendientes-vencidos.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  DIAS_SIN_FECHA, DIAS_TARDIAS,
  caducaEl,
  sigueSiendoPendiente,
  porUrgencia,
} = require('../../public/js/pendienteActividad');

// Reloj fijo para que los tests no dependan del reloj real.
const AHORA  = new Date('2026-08-23T12:00:00Z');
const UN_DIA = 24 * 60 * 60 * 1000;

// Días ANTES de AHORA (hace(3) = hace tres días). Con negativo da futuro.
const hace = dias => new Date(AHORA.getTime() - dias * UN_DIA);

describe('actividad SIN fecha de entrega', () => {
  test('publicada hace 14 días → sigue pendiente (criterio 1)', () => {
    const act = { dueDate: null, availableFrom: hace(14) };
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
  });

  test('publicada hace 16 días → ya no es pendiente (criterio 2)', () => {
    const act = { dueDate: null, availableFrom: hace(16) };
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), false);
  });

  test('los días se cuentan desde availableFrom, no desde createdAt (criterio 3)', () => {
    // El docente la cargó hace 40 días programada para hace 2: recién ahí arrancan los 15.
    const act = { dueDate: null, createdAt: hace(40), availableFrom: hace(2) };
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
    assert.strictEqual(caducaEl(act).getTime(), hace(2).getTime() + DIAS_SIN_FECHA * UN_DIA);
  });

  test('documento histórico sin availableFrom se cae a createdAt (criterio 4)', () => {
    assert.strictEqual(sigueSiendoPendiente({ dueDate: null, createdAt: hace(3)  }, AHORA), true);
    assert.strictEqual(sigueSiendoPendiente({ dueDate: null, createdAt: hace(20) }, AHORA), false);
  });

  test('sin ninguna de las tres fechas queda pendiente, no desaparece (criterio 5)', () => {
    const act = { dueDate: null };
    assert.strictEqual(caducaEl(act), null);
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
  });
});

describe('actividad CON fecha de entrega', () => {
  test('vence mañana → pendiente, con tardías y sin tardías (criterio 6)', () => {
    assert.strictEqual(sigueSiendoPendiente({ dueDate: hace(-1) }, AHORA), true);
    assert.strictEqual(
      sigueSiendoPendiente({ dueDate: hace(-1), allowLateSubmissions: true }, AHORA), true);
  });

  test('vencida sin tardías → no es pendiente, aunque venció recién (criterio 7)', () => {
    const reciencito = new Date(AHORA.getTime() - 60 * 1000);
    assert.strictEqual(sigueSiendoPendiente({ dueDate: reciencito }, AHORA), false);
    assert.strictEqual(sigueSiendoPendiente({ dueDate: hace(30) }, AHORA), false);
  });

  test('vencida hace 13 días con tardías abiertas → todavía pendiente (criterio 8)', () => {
    const act = { dueDate: hace(13), allowLateSubmissions: true };
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
    assert.strictEqual(caducaEl(act).getTime(), hace(13).getTime() + DIAS_TARDIAS * UN_DIA);
  });

  test('vencida hace 15 días con tardías abiertas → ya no (criterio 9)', () => {
    assert.strictEqual(
      sigueSiendoPendiente({ dueDate: hace(15), allowLateSubmissions: true }, AHORA), false);
  });

  test('la fecha de entrega le gana a la de publicación', () => {
    // Publicada hace 30 días (pasada la ventana de sin-fecha) pero vence la semana que
    // viene: manda el dueDate. La ventana de 15 días es SOLO para las que no tienen fecha.
    const act = { availableFrom: hace(30), dueDate: hace(-7) };
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
  });
});

describe('caducidad sin tocar la base', () => {
  test('el mismo documento deja de ser pendiente al avanzar el reloj (criterio 10)', () => {
    const act = { dueDate: null, availableFrom: new Date('2026-08-01T10:00:00Z') };
    // Corte: 2026-08-16T10:00:00Z
    assert.strictEqual(sigueSiendoPendiente(act, new Date('2026-08-16T09:59:00Z')), true);
    assert.strictEqual(sigueSiendoPendiente(act, new Date('2026-08-16T10:00:01Z')), false);
  });

  test('vuelve a figurar sola si el docente le pone fecha futura', () => {
    const caducada = { dueDate: null, availableFrom: hace(20) };
    assert.strictEqual(sigueSiendoPendiente(caducada, AHORA), false);
    const conFecha = { ...caducada, dueDate: hace(-5) };
    assert.strictEqual(sigueSiendoPendiente(conFecha, AHORA), true);
  });
});

describe('la vencida antes de la inscripción del alumno (2026-08-31)', () => {
  // GET /activities/course/:id le ocultaba al alumno las actividades vencidas ANTES de su
  // alta —le tapaba el material de todas las clases anteriores— y /activities/my-pending
  // tenía una copia del mismo filtro. Al sacar el primero se sacó también la copia, y lo que
  // permite sacarla sin cambiar un solo número es esta regla: sin tardías, la vencida ya no
  // cuenta como pendiente, sin importar cuándo se inscribió nadie.
  //
  // Si alguien afloja caducaEl() y rompe esa garantía, "Mis pendientes" se le llena de tareas
  // viejas al alumno el día que lo dan de alta. Este es el test que se cae.
  const alta = hace(5);   // el alumno entró al curso hace 5 días

  test('vencida antes del alta y sin tardías → no le figura como pendiente', () => {
    const act = { dueDate: hace(20) };
    assert.ok(act.dueDate < alta, 'el fixture tiene que vencer ANTES del alta');
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), false);
  });

  test('vencida antes del alta pero con tardías abiertas y en ventana → sigue pendiente', () => {
    // La puede entregar, así que le cuenta. Es lo mismo que pasaba antes del cambio: el filtro
    // viejo también dejaba pasar las de tardías abiertas, y por eso sacarlo no movió nada.
    const act = { dueDate: hace(6), allowLateSubmissions: true };
    assert.ok(act.dueDate < alta, 'el fixture tiene que vencer ANTES del alta');
    assert.strictEqual(sigueSiendoPendiente(act, AHORA), true);
  });
});

describe('orden de la lista (porUrgencia)', () => {
  // Con fecha se identifican por el título; sin fecha, por cuándo se publicaron.
  const vence = (t, dias) => ({ t, dueDate: hace(-dias) });
  const sinFecha = (t, publicadaHace) => ({ t, dueDate: null, availableFrom: hace(publicadaHace) });
  const orden = lista => [...lista].sort(porUrgencia).map(x => x.t);

  test('lo que vence primero va arriba (criterio 18)', () => {
    assert.deepStrictEqual(
      orden([vence('en 10 dias', 10), vence('manana', 1), vence('en 3 dias', 3)]),
      ['manana', 'en 3 dias', 'en 10 dias']);
  });

  test('las SIN fecha van al final, no al principio (criterio 19)', () => {
    // El bug: Mongo ordena los `null` ANTES que cualquier fecha, así que la lista arrancaba
    // con lo que no tiene plazo. Este es el test que se cae si alguien vuelve al sort de Mongo.
    assert.deepStrictEqual(
      orden([sinFecha('sin fecha', 5), vence('manana', 1), vence('en 10 dias', 10)]),
      ['manana', 'en 10 dias', 'sin fecha']);
  });

  test('la vencida con tardías abiertas encabeza: es la que está por perderse (criterio 20)', () => {
    assert.deepStrictEqual(
      orden([vence('manana', 1), vence('vencio hace 3', -3), sinFecha('sin fecha', 5)]),
      ['vencio hace 3', 'manana', 'sin fecha']);
  });

  test('entre las sin fecha, la más vieja primero (criterio 21)', () => {
    // Es la que está más cerca de caducar de la lista.
    assert.deepStrictEqual(
      orden([sinFecha('de hace 2', 2), sinFecha('de hace 12', 12), sinFecha('de hace 7', 7)]),
      ['de hace 12', 'de hace 7', 'de hace 2']);
  });

  test('NO se ordena por caducidad: la sin fecha a punto de caer no se trepa (criterio 22)', () => {
    // Publicada hace 14 días → caduca mañana, antes que la tarea que vence en 3. Si el
    // comparador usara caducaEl() se pondría primera, que es el bug de vuelta.
    const casiCaducada = sinFecha('sin fecha casi caducada', 14);
    assert.ok(caducaEl(casiCaducada).getTime() < new Date(hace(-3)).getTime(),
      'el fixture tiene que caducar ANTES de que venza la otra, si no el test no prueba nada');
    assert.deepStrictEqual(orden([casiCaducada, vence('en 3 dias', 3)]),
      ['en 3 dias', 'sin fecha casi caducada']);
  });

  test('acepta string ISO igual que Date', () => {
    const iso = { t: 'iso', dueDate: hace(-1).toISOString() };
    assert.deepStrictEqual(orden([vence('en 5 dias', 5), iso]), ['iso', 'en 5 dias']);
  });
});

describe('formato de las fechas', () => {
  test('acepta Date y string ISO, que es como llegan por JSON (criterio 11)', () => {
    const comoDate = { dueDate: hace(3), allowLateSubmissions: true };
    const comoISO  = { dueDate: hace(3).toISOString(), allowLateSubmissions: true };
    assert.strictEqual(sigueSiendoPendiente(comoDate, AHORA), true);
    assert.strictEqual(sigueSiendoPendiente(comoISO,  AHORA), true);
    assert.strictEqual(caducaEl(comoISO).getTime(), caducaEl(comoDate).getTime());

    // Y el `ahora` también puede venir como string.
    assert.strictEqual(sigueSiendoPendiente(comoISO, AHORA.toISOString()), true);
  });

  test('las ventanas son las que decidió el usuario', () => {
    assert.strictEqual(DIAS_SIN_FECHA, 15);
    assert.strictEqual(DIAS_TARDIAS,   14);
  });
});
