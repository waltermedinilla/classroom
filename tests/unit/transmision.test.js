// Reglas puras de la transmisión en vivo (services/transmision.js).
//
// Se prueban sin base y sin Express, igual que las de services/liveRoom.js. Lo que vive acá es
// quién puede emitir, quién puede mirar, y cómo se comporta la cola de manos levantadas — que
// es la parte que Meet no tiene y la que más fácil se rompe al tocarla.

const { test } = require('node:test');
const assert   = require('node:assert');

const t    = require('../../services/transmision');
const live = require('../../services/liveRoom');
const { PALABRA_INACTIVA_MS } = require('../../config/transmision');

const ANA  = { _id: 'aaa', name: 'GOMEZ, Ana' };
const LUIS = { _id: 'bbb', name: 'PEREZ, Luis' };
const EVA  = { _id: 'ccc', name: 'DIAZ, Eva' };

// Una sesión de sala con la transmisión en el estado que se pida.
const sala = (transmision = {}, mutedStudents = []) => ({
  _id: 's1',
  mutedStudents,
  transmision: { ...t.APAGADA, ...transmision },
});

const ctx = (o) => ({ esGestor: false, esAlumno: false, esPersonal: false, userId: null, habilitado: false, ...o });

// ── Emitir ───────────────────────────────────────────────────────────────────

test('el docente habilitado puede emitir', () => {
  assert.strictEqual(
    t.puedeEmitir(sala(), ctx({ esGestor: true, habilitado: true, userId: ANA._id })), true);
});

test('⭐ el docente NO habilitado en el módulo no puede emitir', () => {
  // Es la mitad del pedido del usuario: la feature se despliega apagada y se habilita docente
  // por docente. Un gestor sin habilitar tiene que quedar exactamente como está hoy.
  assert.strictEqual(
    t.puedeEmitir(sala(), ctx({ esGestor: true, habilitado: false, userId: ANA._id })), false);
});

test('el alumno no emite por su cuenta, ni con la transmisión al aire', () => {
  const s = sala({ activa: true });
  assert.strictEqual(t.puedeEmitir(s, ctx({ esAlumno: true, userId: LUIS._id })), false);
});

test('el alumno CON la palabra sí emite', () => {
  const s = sala({ activa: true, palabra: LUIS._id });
  assert.strictEqual(t.puedeEmitir(s, ctx({ esAlumno: true, userId: LUIS._id })), true);
});

test('la palabra es de a uno: el otro alumno sigue sin poder', () => {
  const s = sala({ activa: true, palabra: LUIS._id });
  assert.strictEqual(t.puedeEmitir(s, ctx({ esAlumno: true, userId: EVA._id })), false);
});

test('con la transmisión apagada, la palabra vieja no habilita a nadie', () => {
  const s = sala({ activa: false, palabra: LUIS._id });
  assert.strictEqual(t.puedeEmitir(s, ctx({ esAlumno: true, userId: LUIS._id })), false);
});

test('preceptoría y dirección NUNCA emiten (RN-8)', () => {
  const s = sala({ activa: true });
  assert.strictEqual(t.puedeEmitir(s, ctx({ esPersonal: true, habilitado: true, userId: EVA._id })), false);
});

// ── Mirar ────────────────────────────────────────────────────────────────────

test('⭐ el alumno mira sin estar habilitado en el módulo', () => {
  // LA sutileza de D10: el eje de persona se mide sobre quien EMITE. Si se midiera sobre quien
  // mira, cada alumno tendría que estar en la lista para ver a su profesora.
  const s = sala({ activa: true });
  assert.strictEqual(t.puedeVer(s, ctx({ esAlumno: true, habilitado: false, userId: LUIS._id })), true);
});

test('con la transmisión apagada no hay nada que mirar', () => {
  assert.strictEqual(t.puedeVer(sala(), ctx({ esAlumno: true })), false);
});

test('preceptoría y dirección pueden mirar', () => {
  assert.strictEqual(t.puedeVer(sala({ activa: true }), ctx({ esPersonal: true })), true);
});

// ── La cola de manos ─────────────────────────────────────────────────────────

test('levantar la mano dos veces no adelanta el turno', () => {
  let manos = t.levantarMano([], LUIS);
  manos = t.levantarMano(manos, EVA);
  manos = t.levantarMano(manos, LUIS);   // otra vez
  assert.strictEqual(manos.length, 2);
  assert.strictEqual(String(manos[0].user), LUIS._id, 'Luis sigue primero');
});

test('⭐ la cola respeta el ORDEN DE LLEGADA, no el alfabético', () => {
  // DIAZ va antes que PEREZ por nombre, pero levantó la mano después.
  let manos = t.levantarMano([], LUIS);
  manos = t.levantarMano(manos, EVA);
  assert.deepStrictEqual(manos.map(m => m.nombre), ['PEREZ, Luis', 'DIAZ, Eva']);
  assert.strictEqual(t.siguienteEnLaCola(manos).nombre, 'PEREZ, Luis');
});

test('sacar a alguien del medio no reordena a los demás', () => {
  let manos = t.levantarMano([], LUIS);
  manos = t.levantarMano(manos, EVA);
  manos = t.levantarMano(manos, ANA);
  manos = t.bajarMano(manos, EVA._id);
  assert.deepStrictEqual(manos.map(m => m.nombre), ['PEREZ, Luis', 'GOMEZ, Ana']);
});

test('la cola vacía no tiene siguiente', () => {
  assert.strictEqual(t.siguienteEnLaCola([]), null);
  assert.strictEqual(t.siguienteEnLaCola(undefined), null);
});

test('bajar una mano que no está no rompe nada', () => {
  const manos = t.levantarMano([], LUIS);
  assert.strictEqual(t.bajarMano(manos, 'zzz').length, 1);
});

test('el nombre va como snapshot, no como referencia', () => {
  const manos = t.levantarMano([], LUIS);
  assert.strictEqual(manos[0].nombre, 'PEREZ, Luis');
});

// ── Pedir y dar la palabra ───────────────────────────────────────────────────

test('el alumno silenciado NO puede levantar la mano (RN-5)', () => {
  const s = sala({ activa: true }, [LUIS._id]);
  assert.strictEqual(t.puedeLevantarMano(s, ctx({ esAlumno: true, userId: LUIS._id })), false);
  assert.strictEqual(t.puedeLevantarMano(s, ctx({ esAlumno: true, userId: EVA._id })), true);
});

test('⭐ no se le puede dar la palabra a un alumno silenciado', () => {
  // Silenciar a alguien lo silencia entero. Sin esta regla, el docente podría sortear su propia
  // moderación abriéndole el micrófono al que acaba de callar.
  const s = sala({ activa: true }, [LUIS._id]);
  const motivo = t.porQueNoLaPalabra(s, LUIS._id);
  assert.match(motivo, /silenciada/i);
});

test('con la transmisión apagada no hay palabra que dar', () => {
  assert.match(t.porQueNoLaPalabra(sala(), LUIS._id), /no está al aire/i);
});

test('a un alumno normal sí se le puede dar', () => {
  assert.strictEqual(t.porQueNoLaPalabra(sala({ activa: true }), EVA._id), null);
});

test('la palabra se vence sola a los 5 minutos', () => {
  const desde = new Date('2026-08-31T10:00:00Z');
  const s = sala({ activa: true, palabra: LUIS._id, palabraDesde: desde });
  const justoAntes = desde.getTime() + PALABRA_INACTIVA_MS - 1000;
  const justoDespues = desde.getTime() + PALABRA_INACTIVA_MS + 1000;
  assert.strictEqual(t.palabraVencida(s, justoAntes), false);
  assert.strictEqual(t.palabraVencida(s, justoDespues), true);
});

test('sin nadie con la palabra, nada se vence', () => {
  assert.strictEqual(t.palabraVencida(sala({ activa: true })), false);
});

// ── El estado que ve el navegador ────────────────────────────────────────────

test('una forma SOLA: apagada devuelve el mismo objeto con defaults', () => {
  const e = t.estadoParaCliente(sala(), ctx({ esAlumno: true, userId: LUIS._id }));
  assert.strictEqual(e.activa, false);
  assert.strictEqual(e.capaMax, '360p');
  assert.deepStrictEqual(e.manos, []);
  assert.strictEqual(e.palabra, null);
  assert.strictEqual(e.espectadores, 0, 'nunca undefined: la vista lo pintaría');
});

test('una sesión vieja sin el campo transmision no rompe el poll', () => {
  // Retrocompatibilidad (R7): las salas abiertas en el momento del deploy leen undefined.
  const vieja = { _id: 's0', mutedStudents: [] };
  const e = t.estadoParaCliente(vieja, ctx({ esAlumno: true }));
  assert.strictEqual(e.activa, false);
  assert.strictEqual(e.puedoVer, false);
});

test('el estado dice quién tiene la palabra y si soy yo', () => {
  const s = sala({ activa: true, palabra: LUIS._id, manos: [{ user: LUIS._id, nombre: 'PEREZ, Luis', desde: new Date() }] });
  const mio  = t.estadoParaCliente(s, ctx({ esAlumno: true, userId: LUIS._id }));
  const ajeno = t.estadoParaCliente(s, ctx({ esAlumno: true, userId: EVA._id }));
  assert.strictEqual(mio.palabra.mia, true);
  assert.strictEqual(ajeno.palabra.mia, false);
  assert.strictEqual(mio.palabra.nombre, 'PEREZ, Luis');
});

test('el motivo de la degradación viaja al cliente', () => {
  const s = sala({ activa: true, capaMax: '180p', degradadaPor: 'aforo' });
  const e = t.estadoParaCliente(s, ctx({ esGestor: true, habilitado: true }));
  assert.strictEqual(e.capaMax, '180p');
  assert.strictEqual(e.degradadaPor, 'aforo');
});

// ── El autocierre (RN-4) ─────────────────────────────────────────────────────

test('⭐ una clase expositiva NO se autocierra: la transmisión es actividad', () => {
  // EL BUG QUE ESTO EVITA: en una clase expositiva el chat se queda mudo —los chicos escuchan,
  // no teclean—, así que sin esta regla el autocierre le corta el video a la docente a los 30
  // minutos, en el medio de su explicación. Este test FALLA sin el arreglo de shouldAutoClose.
  const hace35min = new Date(Date.now() - 35 * 60 * 1000);
  const conVideo = { closedAt: null, lastActivityAt: hace35min, transmision: { activa: true } };
  const sinVideo = { closedAt: null, lastActivityAt: hace35min, transmision: { activa: false } };

  assert.strictEqual(live.shouldAutoClose(conVideo), false, 'con la transmisión al aire NO se cierra');
  assert.strictEqual(live.shouldAutoClose(sinVideo), true,  'sin transmisión, el autocierre sigue igual que siempre');
});

test('el autocierre de las salas sin transmisión no cambió', () => {
  // Regresión: las sesiones viejas no tienen el campo y tienen que comportarse igual que antes.
  const hace35min = new Date(Date.now() - 35 * 60 * 1000);
  assert.strictEqual(live.shouldAutoClose({ closedAt: null, lastActivityAt: hace35min }), true);
  assert.strictEqual(live.shouldAutoClose({ closedAt: null, lastActivityAt: new Date() }), false);
});
