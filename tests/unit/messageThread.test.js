// Tests de la lógica pura del hilo de un mensaje (services/messageThread.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Cubren los criterios 10-14 de specs/mensajeria-superadmin.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const { MAX_MENSAJES, hilo, esperaAlDestinatario, puedeResponderElUsuario, cuantosMensajes } =
  require('../../services/messageThread');

const ENVIO = new Date('2026-08-10T12:00:00Z');
const luego = (min) => new Date(ENVIO.getTime() + min * 60 * 1000);

const mensaje = (extra = {}) => ({
  _id: 'm1', body: 'Carguen las notas antes del 20.', sender: 'super1',
  allowReplies: true, createdAt: ENVIO, ...extra,
});

const destinatario = (thread = []) => ({ _id: 'r1', user: 'u1', thread });

const delUsuario = (text, min) => ({ from: 'user',  author: 'u1',     text, at: luego(min) });
const delStaff   = (text, min) => ({ from: 'staff', author: 'super1', text, at: luego(min) });

// ── Criterio 10: un mensaje sin respuestas ya es un hilo de uno ──────────────

test('hilo: un mensaje que nadie contestó devuelve un solo ítem, del staff, con el body', () => {
  const items = hilo(mensaje(), destinatario());
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].from, 'staff');
  assert.strictEqual(items[0].text, 'Carguen las notas antes del 20.');
  assert.strictEqual(items[0].at, ENVIO);
});

test('hilo: el mensaje original va con indice -1 (no vive en thread[])', () => {
  assert.strictEqual(hilo(mensaje(), destinatario())[0].indice, -1);
});

test('hilo: sin destinatario no rompe, devuelve solo el mensaje', () => {
  assert.strictEqual(hilo(mensaje(), null).length, 1);
});

test('hilo: sin mensaje devuelve vacío', () => {
  assert.deepStrictEqual(hilo(null, destinatario()), []);
});

// ── Criterio 11: orden cronológico, body primero ────────────────────────────

test('hilo: primero el body y después thread[], en orden', () => {
  const items = hilo(mensaje(), destinatario([
    delUsuario('¿Hasta qué hora?', 10),
    delStaff('Hasta las 23:59.', 20),
  ]));
  assert.deepStrictEqual(items.map(i => i.from), ['staff', 'user', 'staff']);
  assert.deepStrictEqual(items.map(i => i.text), [
    'Carguen las notas antes del 20.', '¿Hasta qué hora?', 'Hasta las 23:59.',
  ]);
});

test('hilo: los mensajes del thread llevan su índice real dentro del array', () => {
  const items = hilo(mensaje(), destinatario([delUsuario('a', 1), delStaff('b', 2)]));
  assert.deepStrictEqual(items.map(i => i.indice), [-1, 0, 1]);
});

test('hilo: editedAt viaja tal cual; el mensaje original nunca está editado', () => {
  const conEdicion = { ...delUsuario('a', 1), editedAt: luego(5) };
  const items = hilo(mensaje(), destinatario([conEdicion]));
  assert.strictEqual(items[0].editedAt, null);
  assert.strictEqual(items[1].editedAt, conEdicion.editedAt);
});

test('cuantosMensajes: cuenta el body más el thread', () => {
  assert.strictEqual(cuantosMensajes(mensaje(), destinatario()), 1);
  assert.strictEqual(cuantosMensajes(mensaje(), destinatario([delUsuario('a', 1)])), 2);
});

// ── Criterio 12: sin respuestas habilitadas no se responde ──────────────────

test('puedeResponderElUsuario: false si allowReplies es false, aunque el hilo esté vacío', () => {
  assert.strictEqual(
    puedeResponderElUsuario(mensaje({ allowReplies: false }), destinatario()),
    false,
  );
});

test('puedeResponderElUsuario: false si allowReplies es false, aunque ya haya conversación', () => {
  // El toggle se puede apagar después de enviado (RN-08): lo escrito se conserva, pero
  // no se puede escribir más.
  assert.strictEqual(
    puedeResponderElUsuario(
      mensaje({ allowReplies: false }),
      destinatario([delUsuario('a', 1), delStaff('b', 2)]),
    ),
    false,
  );
});

test('puedeResponderElUsuario: true con allowReplies y hilo corto', () => {
  assert.strictEqual(puedeResponderElUsuario(mensaje(), destinatario()), true);
});

// ── Criterio 13: el tope de 20 ──────────────────────────────────────────────

test('MAX_MENSAJES es 20, el mismo criterio que las sugerencias', () => {
  assert.strictEqual(MAX_MENSAJES, 20);
});

test('puedeResponderElUsuario: false al llegar al tope, con allowReplies en true', () => {
  // 19 en el thread + el body = 20.
  const thread = Array.from({ length: MAX_MENSAJES - 1 }, (_, i) =>
    i % 2 === 0 ? delUsuario('a' + i, i) : delStaff('b' + i, i));
  const rec = destinatario(thread);
  assert.strictEqual(cuantosMensajes(mensaje(), rec), MAX_MENSAJES);
  assert.strictEqual(puedeResponderElUsuario(mensaje(), rec), false);
});

test('puedeResponderElUsuario: true justo un mensaje antes del tope', () => {
  const thread = Array.from({ length: MAX_MENSAJES - 2 }, (_, i) =>
    i % 2 === 0 ? delUsuario('a' + i, i) : delStaff('b' + i, i));
  assert.strictEqual(puedeResponderElUsuario(mensaje(), destinatario(thread)), true);
});

// ── Criterio 14: de quién es el turno ───────────────────────────────────────

test('esperaAlDestinatario: true cuando lo último lo escribió el staff', () => {
  assert.strictEqual(esperaAlDestinatario(mensaje(), destinatario()), true);
  assert.strictEqual(
    esperaAlDestinatario(mensaje(), destinatario([delUsuario('a', 1), delStaff('b', 2)])),
    true,
  );
});

test('esperaAlDestinatario: false cuando el último lo escribió el destinatario', () => {
  assert.strictEqual(
    esperaAlDestinatario(mensaje(), destinatario([delUsuario('a', 1)])),
    false,
  );
});
