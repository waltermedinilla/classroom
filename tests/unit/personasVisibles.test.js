// Tests de personasVisibles (services/personasVisibles.js) — proyección de la lista de
// alumnos que ve la solapa Personas de /courses/:id, según quien mira.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Por qué existe este archivo (specs/personas-privacidad-alumno.spec.md, RN-1/RN-2/RN-5/RN-5b):
// la solapa Personas le mostraba el DNI de cada compañero a CUALQUIER alumno matriculado, y el
// DNI ES la contraseña inicial de la cuenta (correo + DNI = entrar a la cuenta ajena). El
// arreglo no es un `if` en la vista (D3, misma lección de fuga_datos_api_curso): el campo no
// tiene que llegar al objeto que se le pasa al template. Esta función pura es esa proyección —
// de PERMITIDOS, no de prohibidos (CA-05): una clave de más filtrada acá es el mismo agujero
// que se vino a cerrar.

const test = require('node:test');
const assert = require('node:assert');

const { personasVisibles } = require('../../services/personasVisibles');

// Alumno "de la base", con todos los campos que trae el populate de hoy y uno de más (phone,
// que ningún populate trae) para probar que la proyección es una whitelist real y no se cuela
// ningún campo ajeno.
const alumnoCompleto = (over = {}) => ({
  _id: 'alu-1', name: 'García, Ana', email: 'ana@escuela.test',
  dni: '30123456', active: true, avatar: 'https://cdn/ana.jpg', phone: '2615550000',
  ...over,
});

// Simula un documento de Mongoose POPULADO: los campos del esquema son getters del
// PROTOTIPO, no propiedades propias enumerables — un `{...doc}` o un `Object.keys(doc)` no
// los ve, pero `doc.dni` sí devuelve el valor. Si personasVisibles armara el objeto con
// spread/Object.keys en vez de leer cada campo por su nombre, este test lo detecta con algo
// parecido a lo que entrega `.populate('students', ...)` en la ruta real — un objeto plano
// armado a mano no lo hubiera notado.
function comoDocumentoPoblado(campos) {
  const proto = {};
  for (const [k, v] of Object.entries(campos)) {
    Object.defineProperty(proto, k, { get: () => v, enumerable: false, configurable: true });
  }
  // toObject() existe en cualquier documento real; el test no exige que la función lo use.
  Object.defineProperty(proto, 'toObject', { value: () => ({ ...campos }), enumerable: false });
  return Object.create(proto);
}

// ── CA-05 — al que NO gestiona, la lista es de PERMITIDOS ───────────────────

test('CA-05 — sin gestión: las claves son EXACTAMENTE _id, name, email, avatar', () => {
  const [r] = personasVisibles([alumnoCompleto()], false);
  assert.deepEqual(Object.keys(r).sort(), ['_id', 'avatar', 'email', 'name']);
});

test('CA-05 — sin gestión: el DNI nunca está en el objeto (ni siquiera como undefined)', () => {
  const [r] = personasVisibles([alumnoCompleto()], false);
  assert.equal('dni' in r, false,
    'una clave "dni" de más es exactamente el agujero que reportó el usuario el 2026-09-29');
});

test('CA-05 — sin gestión: tampoco pasan "active" ni "phone" ni ningún otro campo del documento', () => {
  const [r] = personasVisibles([alumnoCompleto()], false);
  assert.equal('active' in r, false, 'active no está en la lista de permitidos de CA-05');
  assert.equal('phone' in r, false, 'un campo que ni siquiera pide la vista no puede colarse');
});

test('CA-05 — sin gestión: los valores permitidos SÍ viajan y son los correctos', () => {
  const [r] = personasVisibles([alumnoCompleto()], false);
  assert.equal(r._id, 'alu-1');
  assert.equal(r.name, 'García, Ana');
  assert.equal(r.email, 'ana@escuela.test');
  assert.equal(r.avatar, 'https://cdn/ana.jpg');
});

test('CA-05 — funciona igual con un documento de Mongoose poblado (campos no enumerables)', () => {
  const doc = comoDocumentoPoblado(alumnoCompleto());
  const [r] = personasVisibles([doc], false);
  assert.deepEqual(Object.keys(r).sort(), ['_id', 'avatar', 'email', 'name']);
  assert.equal(r.name, 'García, Ana');
  assert.equal('dni' in r, false);
});

// ── CA-06 — al que gestiona, no se le saca nada ──────────────────────────────

test('CA-06 — con gestión: las claves son las que ya usa la vista del gestor', () => {
  const [r] = personasVisibles([alumnoCompleto()], true);
  assert.deepEqual(Object.keys(r).sort(), ['_id', 'active', 'avatar', 'dni', 'email', 'name']);
});

test('CA-06 — con gestión: los valores (incluido el DNI) llegan intactos', () => {
  const [r] = personasVisibles([alumnoCompleto()], true);
  assert.equal(r.dni, '30123456');
  assert.equal(r.active, true);
});

test('CA-06 — con gestión: tampoco se cuela un campo ajeno como "phone"', () => {
  const [r] = personasVisibles([alumnoCompleto()], true);
  assert.equal('phone' in r, false);
});

test('CA-06 — funciona igual con un documento de Mongoose poblado', () => {
  const doc = comoDocumentoPoblado(alumnoCompleto());
  const [r] = personasVisibles([doc], true);
  assert.deepEqual(Object.keys(r).sort(), ['_id', 'active', 'avatar', 'dni', 'email', 'name']);
  assert.equal(r.dni, '30123456');
});

// ── CA-07 — entradas raras: no explota ───────────────────────────────────────

test('CA-07 — students vacío devuelve lista vacía, gestione o no quien mira', () => {
  assert.deepEqual(personasVisibles([], false), []);
  assert.deepEqual(personasVisibles([], true), []);
});

test('CA-07 — students undefined no explota (mismo criterio defensivo que recolectarDevoluciones)', () => {
  assert.deepEqual(personasVisibles(undefined, false), []);
  assert.deepEqual(personasVisibles(undefined, true), []);
});

test('CA-07 — alumno sin DNI no tira error, ni con gestión ni sin ella', () => {
  const sinDni = alumnoCompleto({ dni: undefined });
  assert.doesNotThrow(() => personasVisibles([sinDni], false));
  assert.doesNotThrow(() => personasVisibles([sinDni], true));
});

test('CA-07 — alumno sin avatar no tira error; si la clave viaja, no inventa un valor', () => {
  // La spec (CA-05/CA-07) no fija si, sin avatar, la clave se omite o viaja en null/undefined
  // — ver PREGUNTAS del reporte del tester. Este test solo exige que no se invente una URL.
  const sinAvatar = alumnoCompleto({ avatar: null });
  assert.doesNotThrow(() => personasVisibles([sinAvatar], false));
  const [r] = personasVisibles([sinAvatar], false);
  assert.ok(!('avatar' in r) || r.avatar == null,
    'sin avatar, la clave no puede tener un valor inventado (ni siquiera vacío-string)');
});

// ── CA-09b — active:false se descarta SOLO para el que no gestiona ──────────

test('CA-09b — sin gestión: el compañero con active:false NO figura en la lista', () => {
  const lista = [alumnoCompleto({ _id: 'activo' }), alumnoCompleto({ _id: 'inactivo', active: false })];
  const r = personasVisibles(lista, false);
  assert.deepEqual(r.map(x => x._id), ['activo']);
});

test('CA-09b — sin gestión: una cuenta vieja SIN el campo "active" se muestra (default true, models/User.js)', () => {
  const sinCampo = alumnoCompleto();
  delete sinCampo.active;
  const r = personasVisibles([sinCampo], false);
  assert.equal(r.length, 1, 'la ausencia del campo active no puede tratarse como active:false');
  assert.equal(r[0]._id, 'alu-1');
});

test('CA-09b — sin gestión: con varios activos y uno solo inactivo, solo se descarta ese', () => {
  const lista = [
    alumnoCompleto({ _id: 'a' }),
    alumnoCompleto({ _id: 'b', active: false }),
    alumnoCompleto({ _id: 'c' }),
  ];
  const r = personasVisibles(lista, false);
  assert.deepEqual(r.map(x => x._id), ['a', 'c']);
});

test('CA-09b / RN-3 — con gestión, NO se descarta a nadie por active:false: el gestor los ve a todos', () => {
  const lista = [alumnoCompleto({ _id: 'activo' }), alumnoCompleto({ _id: 'inactivo', active: false })];
  const r = personasVisibles(lista, true);
  assert.deepEqual(r.map(x => x._id).sort(), ['activo', 'inactivo']);
});
