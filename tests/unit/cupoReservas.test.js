// Tests del cupo de los recursos divisibles (services/recursos/cupo.js).
// Correr con: npm run test:unit
//
// ── POR QUÉ ESTE ARCHIVO SÍ TOCA MONGO ─────────────────────────────────────────────────
// El resto de los unitarios del módulo son puros. Éste no puede serlo: lo que se está
// probando ES la atomicidad de una operación de Mongo. Un doble mock no prueba nada —el bug
// que esto previene vive exactamente en la diferencia entre `findOneAndUpdate` con filtro y
// `leer` + `if` + `escribir`.
//
// Mismo criterio y mismo patrón que tests/unit/backupTarball.test.js, que también conecta.
// La diferencia: acá se usa una BASE APARTE (classroom-test-cupo) y se borra al terminar,
// para no ensuciar el espejo local con reservas de prueba.
//
// ⚠️ LOS TESTS DE CARRERA VAN CON Promise.all, NO EN SECUENCIA. Un test secuencial pasa
// igual con la versión ingenua y no mide nada. Verificado a mano: reemplazando tomar() por
// leer-comparar-crear, "dos aprobaciones simultáneas no se pasan del carro" falla.
//
// Cubre los criterios CA-15 a CA-21 de specs/recursos-reservas.spec.md.

const test     = require('node:test');
const assert   = require('node:assert');
const mongoose = require('mongoose');

const SlotOcupacion = require('../../models/SlotOcupacion');
const Reserva       = require('../../models/Reserva');
const cupo          = require('../../services/recursos/cupo');

const URI = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/classroom-test-cupo';

// Un casillero cualquiera: recurso × día × turno × módulo.
const RECURSO   = new mongoose.Types.ObjectId();
const CAPACIDAD = 30;   // las netbooks de la escuela
const SLOT = { recurso: RECURSO, date: '2026-09-02', turno: 'manana', modulo: 3 };

test.before(async () => {
  await mongoose.connect(URI);
  // Los índices importan acá: el único de SlotOcupacion es lo que hace seguro el "insertar si
  // no existe" de tomar(). Sin él, dos inserciones simultáneas crearían dos casilleros y cada
  // uno contaría por su cuenta.
  await SlotOcupacion.init();
  await Reserva.init();
});

test.after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test.beforeEach(async () => {
  await SlotOcupacion.deleteMany({});
  await Reserva.deleteMany({});
});

// ── CA-15: tomar y devolver ─────────────────────────────────────────────────

test('tomar crea el casillero la primera vez', async () => {
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 0, 'arranca sin casillero');

  const r = await cupo.tomar({ ...SLOT, unidades: 12, capacidad: CAPACIDAD });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ocupadas, 12);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 12);
});

test('dos docentes con 15 cada uno entran justos; el tercero no', async () => {
  const a = await cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD });
  const b = await cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.ocupadas, 30);

  const c = await cupo.tomar({ ...SLOT, unidades: 1, capacidad: CAPACIDAD });
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.libres, 0, 'y tiene que poder decir cuánto queda');
});

test('cuando no entra, informa cuántas quedan — que es lo que salva la aprobación', async () => {
  await cupo.tomar({ ...SLOT, unidades: 24, capacidad: CAPACIDAD });

  const r = await cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.libres, 6);
  // Es el número con el que el administrativo puede confirmar por 6 en vez de rechazar.
});

test('devolver libera exactamente lo que se tomó', async () => {
  await cupo.tomar({ ...SLOT, unidades: 20, capacidad: CAPACIDAD });
  await cupo.devolver({ ...SLOT, unidades: 8 });

  assert.strictEqual(await cupo.ocupadasEn(SLOT), 12);
  const r = await cupo.tomar({ ...SLOT, unidades: 18, capacidad: CAPACIDAD });
  assert.strictEqual(r.ok, true, 'lo devuelto se puede volver a pedir');
});

test('devolver de más no deja el contador en negativo', async () => {
  await cupo.tomar({ ...SLOT, unidades: 5, capacidad: CAPACIDAD });
  const r = await cupo.devolver({ ...SLOT, unidades: 99 });

  assert.strictEqual(await cupo.ocupadasEn(SLOT), 0);
  assert.strictEqual(r.descuadrado, true, 'y avisa que algo no cerraba');
});

// ── CA-16: los topes que evitan pasarse ─────────────────────────────────────

test('pedir más que la capacidad se rechaza sin crear el casillero', async () => {
  // Sin la guarda, `capacidad - unidades` queda negativo, el filtro del $inc no matchea nunca
  // y el código caería al camino de "crear el casillero" — insertando 40 unidades en un
  // recurso de 30 sin que nada lo detenga.
  const r = await cupo.tomar({ ...SLOT, unidades: 40, capacidad: CAPACIDAD });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 0, 'no puede haber quedado nada escrito');
});

test('unidades inválidas se rechazan', async () => {
  for (const u of [0, -3, 1.5, NaN, null, 'ocho']) {
    const r = await cupo.tomar({ ...SLOT, unidades: u, capacidad: CAPACIDAD });
    assert.strictEqual(r.ok, false, `unidades=${u} tendría que rechazarse`);
  }
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 0);
});

// ── CA-17: LA CARRERA ───────────────────────────────────────────────────────
//
// El motivo de existir de todo este archivo. Con dos workers de PM2, dos aprobaciones
// simultáneas sobre el mismo casillero leen el mismo total y confirman las dos.

test('dos aprobaciones simultáneas de 15 y 15 entran las dos, sin pasarse', async () => {
  const [a, b] = await Promise.all([
    cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD }),
    cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD }),
  ]);

  assert.ok(a.ok && b.ok, 'las dos entran: 15 + 15 = 30, justo');
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 30);
});

test('dos simultáneas de 20 y 20: gana UNA sola, y el carro no queda en 40', async () => {
  const [a, b] = await Promise.all([
    cupo.tomar({ ...SLOT, unidades: 20, capacidad: CAPACIDAD }),
    cupo.tomar({ ...SLOT, unidades: 20, capacidad: CAPACIDAD }),
  ]);

  const ganadoras = [a, b].filter(r => r.ok).length;
  assert.strictEqual(ganadoras, 1, 'exactamente una');
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 20, 'nunca 40');
});

test('diez pedidos simultáneos de 4: entran siete y el contador cierra', async () => {
  // 10 × 4 = 40 sobre un carro de 30: tienen que entrar exactamente 7 (28) y sobrar 2.
  const rs = await Promise.all(
    Array.from({ length: 10 }, () => cupo.tomar({ ...SLOT, unidades: 4, capacidad: CAPACIDAD })),
  );

  const ok = rs.filter(r => r.ok).length;
  assert.strictEqual(ok, 7);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 28);
  // El invariante que importa: el contador es EXACTAMENTE la suma de lo concedido.
  assert.strictEqual(await cupo.ocupadasEn(SLOT), ok * 4);
});

test('la carrera por CREAR el casillero no duplica el contador', async () => {
  // Los dos llegan cuando el casillero todavía no existe. Uno lo inserta, el otro recibe
  // E11000 del índice único de SlotOcupacion y reintenta contra el camino del $inc.
  const [a, b] = await Promise.all([
    cupo.tomar({ ...SLOT, unidades: 5, capacidad: CAPACIDAD }),
    cupo.tomar({ ...SLOT, unidades: 7, capacidad: CAPACIDAD }),
  ]);

  assert.ok(a.ok && b.ok);
  assert.strictEqual(await SlotOcupacion.countDocuments(SLOT), 1, 'UN casillero, no dos');
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 12);
});

test('los casilleros son independientes entre sí', async () => {
  const otroDia    = { ...SLOT, date: '2026-09-03' };
  const otroModulo = { ...SLOT, modulo: 4 };

  await cupo.tomar({ ...SLOT, unidades: 30, capacidad: CAPACIDAD });

  assert.strictEqual((await cupo.tomar({ ...otroDia, unidades: 30, capacidad: CAPACIDAD })).ok, true);
  assert.strictEqual((await cupo.tomar({ ...otroModulo, unidades: 30, capacidad: CAPACIDAD })).ok, true);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 30, 'y el original no se movió');
});

// ── CA-18: ajustar lo otorgado ──────────────────────────────────────────────
//
// Es lo que hace el administrativo cuando edita la cantidad de una reserva ya confirmada.

test('bajar lo otorgado libera la diferencia', async () => {
  await cupo.tomar({ ...SLOT, unidades: 15, capacidad: CAPACIDAD });
  await cupo.ajustar({ ...SLOT, antes: 15, ahora: 8, capacidad: CAPACIDAD });

  assert.strictEqual(await cupo.ocupadasEn(SLOT), 8, 'se liberaron 7');
});

test('subir lo otorgado entra si hay lugar', async () => {
  await cupo.tomar({ ...SLOT, unidades: 8, capacidad: CAPACIDAD });
  const r = await cupo.ajustar({ ...SLOT, antes: 8, ahora: 20, capacidad: CAPACIDAD });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 20);
});

test('subir lo otorgado sin lugar NO deja el cupo a medias', async () => {
  // Una edición a medias sería peor que una rechazada: la reserva diría 25 y el contador 30.
  await cupo.tomar({ ...SLOT, unidades: 10, capacidad: CAPACIDAD });   // este docente
  await cupo.tomar({ ...SLOT, unidades: 18, capacidad: CAPACIDAD });   // otro
  // Quedan 2 libres; se intenta subir de 10 a 25 (necesita 15 más).
  const r = await cupo.ajustar({ ...SLOT, antes: 10, ahora: 25, capacidad: CAPACIDAD });

  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.libres, 2);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 28, 'el contador quedó como estaba');
});

// ── CA-19: el antídoto contra la desincronización ───────────────────────────
//
// `ocupadas` es estado derivado. La verdad vive en las reservas confirmadas, y tiene que
// haber una forma de reconstruirlo — si no, un camino de salida que se olvide de devolver
// filtra cupo para siempre y nadie puede saber por qué.

const reservaFalsa = (unidades, extra = {}) => ({
  school: new mongoose.Types.ObjectId(),
  recurso: RECURSO, date: SLOT.date, turno: SLOT.turno, modulo: SLOT.modulo,
  docente: new mongoose.Types.ObjectId(),
  status: 'confirmada', unidades, unidadesPedidas: unidades,
  exclusiva: false,
  ...extra,
});

test('recalcular detecta un contador inflado y lo arregla', async () => {
  await Reserva.create(reservaFalsa(8));
  await Reserva.create(reservaFalsa(4));
  // Se simula la fuga: el contador quedó en 20 y las reservas suman 12.
  await SlotOcupacion.create({ ...SLOT, ocupadas: 20 });

  const antes = await cupo.recalcular({ aplicar: false });
  assert.strictEqual(antes.diferencias.length, 1);
  assert.strictEqual(antes.diferencias[0].guardado, 20);
  assert.strictEqual(antes.diferencias[0].real, 12);
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 20, 'sin aplicar NO toca nada');

  await cupo.recalcular({ aplicar: true });
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 12);

  const despues = await cupo.recalcular({ aplicar: false });
  assert.strictEqual(despues.diferencias.length, 0, 'y queda cuadrado');
});

test('recalcular no cuenta las canceladas, rechazadas ni pendientes', async () => {
  await Reserva.create(reservaFalsa(10));
  await Reserva.create(reservaFalsa(5, { status: 'cancelada' }));
  await Reserva.create(reservaFalsa(7, { status: 'rechazada' }));
  await Reserva.create(reservaFalsa(9, { status: 'pendiente' }));

  await cupo.recalcular({ aplicar: true });
  assert.strictEqual(await cupo.ocupadasEn(SLOT), 10, 'solo la confirmada');
});

test('recalcular ignora los recursos exclusivos, que no tienen contador', async () => {
  // La sala se guarda con el índice único de models/Reserva.js, no con SlotOcupacion. Si el
  // recalculador les inventara casilleros, aparecerían diferencias fantasma para siempre.
  await Reserva.create(reservaFalsa(1, { exclusiva: true }));

  const r = await cupo.recalcular({ aplicar: true });
  assert.strictEqual(r.diferencias.length, 0);
  assert.strictEqual(await SlotOcupacion.countDocuments({}), 0);
});

// ── CA-20: el índice de los exclusivos ──────────────────────────────────────
//
// La otra mitad de la guarda. Para la sala no hay contador: manda el índice único parcial.

test('dos reservas confirmadas del mismo casillero exclusivo: la segunda rebota', async () => {
  await Reserva.create(reservaFalsa(1, { exclusiva: true }));

  await assert.rejects(
    () => Reserva.create(reservaFalsa(1, { exclusiva: true })),
    (err) => err.code === 11000,
    'tiene que rebotar con E11000, no entrar',
  );
});

test('una reserva CANCELADA no bloquea el casillero para siempre', async () => {
  // Es la mitad `status: 'confirmada'` del partialFilterExpression. Sin ella, el módulo
  // quedaría muerto después de la primera cancelación.
  await Reserva.create(reservaFalsa(1, { exclusiva: true, status: 'cancelada' }));
  await Reserva.create(reservaFalsa(1, { exclusiva: true, status: 'rechazada' }));

  const nueva = await Reserva.create(reservaFalsa(1, { exclusiva: true }));
  assert.strictEqual(nueva.status, 'confirmada');
});

test('dos reservas confirmadas DIVISIBLES del mismo casillero conviven', async () => {
  // Es la mitad `exclusiva: true`. Sin ella, la segunda reserva legítima de netbooks sobre el
  // mismo módulo chocaría contra la primera y el reparto sería imposible.
  await Reserva.create(reservaFalsa(15));
  await Reserva.create(reservaFalsa(15));

  assert.strictEqual(await Reserva.countDocuments({ status: 'confirmada' }), 2);
});
