// Sonido de aviso en el chat de la sala en vivo — la mitad del servidor.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sonido-chat-sala.spec.md. Cubre los defaults y el enum del schema (CA-29), la
// lectura invertida al hidratar una sesión vieja (CA-30), la validación pura de /config
// (CA-31), la herencia al abrir (CA-32 y CA-46) y el barrido de "el poll no toca User" (CA-47,
// la parte de código; la parte de tamaño va acá también porque es una cuenta pura). Sin base:
// los modelos se hidratan con `Model.hydrate()`, y para CA-46 se inyecta un User falso en
// leerPreferenciaSonido(), que es la lectura que hace POST /sala/abrir.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const raiz = path.join(__dirname, '..', '..');

const { SONIDO_DE, SONIDO_DE_DEFAULT } = require('../../public/js/salaSonido');
const RoomSession = require('../../models/RoomSession');
const User        = require('../../models/User');
const { configDeSonido, sonidoInicial, leerPreferenciaSonido } = require('../../services/liveRoom');

// ── CA-29 y CA-30: schema y lectura invertida ────────────────────────────────

test('CA-29 (RN-02, RN-03): defaults en false y el mismo enum SONIDO_DE en los dos modelos', () => {
  assert.equal(RoomSession.schema.path('settings.sonido').defaultValue, false,
    'settings.sonido tiene que arrancar en false: la ausencia es APAGADO (RN-03)');
  assert.equal(User.schema.path('salaSonido').defaultValue, false);

  const enumSesion = RoomSession.schema.path('settings.sonidoDe').enumValues;
  const enumUsuario = User.schema.path('salaSonidoDe').enumValues;
  assert.deepStrictEqual(enumSesion, SONIDO_DE);
  assert.deepStrictEqual(enumUsuario, SONIDO_DE);
});

test('CA-30 (RN-03): una sesión hidratada sin los campos nuevos lee la política apagada', () => {
  const { politica } = require('../../public/js/salaSonido');
  const doc = RoomSession.hydrate({
    settings: { studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true },
  });
  assert.equal(politica(doc.settings).activo, false,
    'una sesión abierta antes del despliegue no tiene el campo y tiene que leer apagado');
});

// ── CA-31: configDeSonido valida antes de mutar nada ─────────────────────────

test('CA-31 (RN-06): configDeSonido()', () => {
  assert.deepStrictEqual(configDeSonido({}), { cambios: {}, error: null });
  assert.equal(configDeSonido({ sonido: 'true' }).cambios.sonido, true);
  assert.equal(configDeSonido({ sonido: 'x' }).cambios.sonido, false);
  assert.equal(configDeSonido({ sonidoDe: 'todos' }).cambios.sonidoDe, 'todos');
  for (const v of ['nadie', '', null]) {
    assert.equal(configDeSonido({ sonidoDe: v }).error, 'INVALID_SOUND_OPTION',
      `sonidoDe: ${JSON.stringify(v)} tiene que rechazarse`);
  }
});

// ── CA-32: sonidoInicial resuelve la herencia ────────────────────────────────

test('CA-32 (RN-05): sonidoInicial()', () => {
  assert.deepStrictEqual(sonidoInicial(null), { sonido: false, sonidoDe: SONIDO_DE_DEFAULT });
  assert.deepStrictEqual(sonidoInicial({}), { sonido: false, sonidoDe: SONIDO_DE_DEFAULT });
  assert.deepStrictEqual(
    sonidoInicial({ salaSonido: true, salaSonidoDe: 'todos' }),
    { sonido: true, sonidoDe: 'todos' },
  );
});

// ── CA-46: la lectura al abrir, con un User falso ────────────────────────────

// Un User falso con la forma exacta de la cadena que usa la ruta: findById(id).select(campos).lean().
// `visto` anota con qué se lo llamó, para fijar que se lee solo lo que hace falta.
function modeloQueDevuelve(doc, visto = {}) {
  return {
    findById(id) {
      visto.id = id;
      return { select(campos) { visto.campos = campos; return { lean: async () => doc }; } };
    },
  };
}

const APAGADO = { sonido: false, sonidoDe: SONIDO_DE_DEFAULT };

test('CA-46 (RN-05): si leer la preferencia falla, leerPreferenciaSonido devuelve el sonido apagado y no propaga', async () => {
  const modelosQueFallan = {
    'la query rechaza': {
      findById: () => ({ select: () => ({ lean: () => Promise.reject(new Error('Mongo caído')) }) }),
    },
    'el modelo tira antes de devolver la promesa': {
      findById: () => { throw new Error('findById explotó'); },
    },
  };
  for (const [caso, modelo] of Object.entries(modelosQueFallan)) {
    let r;
    await assert.doesNotReject(async () => { r = await leerPreferenciaSonido(modelo, 'u1'); },
      `${caso}: el error no puede llegar a /abrir, la sala se abre igual (RN-05)`);
    assert.deepStrictEqual(r, APAGADO, `${caso}: la sala tiene que abrir con el sonido apagado`);
  }
});

test('RN-05: leerPreferenciaSonido lee de la base solo salaSonido y salaSonidoDe, y los pasa por sonidoInicial', async () => {
  const visto = {};
  assert.deepStrictEqual(
    await leerPreferenciaSonido(modeloQueDevuelve({ salaSonido: true, salaSonidoDe: 'todos' }, visto), 'u1'),
    { sonido: true, sonidoDe: 'todos' },
  );
  assert.equal(visto.id, 'u1', 'tiene que leer a quien abre');
  assert.equal(visto.campos, 'salaSonido salaSonidoDe', 'el .select() es solo de los dos campos de sonido');

  assert.deepStrictEqual(await leerPreferenciaSonido(modeloQueDevuelve({ _id: 'u1' }), 'u1'), APAGADO,
    'un usuario que nunca eligió (sin los campos) abre con el sonido apagado (RN-03)');
});

// ── CA-47: el poll no toca User ──────────────────────────────────────────────

test('CA-47 (RN-08) — barrido: estadoDeSala y el handler de /sala/poll no referencian User', () => {
  const txt = fs.readFileSync(path.join(raiz, 'routes/rooms.js'), 'utf8');

  const iFn = txt.indexOf('async function estadoDeSala(');
  assert.ok(iFn > 0, 'tiene que existir estadoDeSala()');
  const finFn = txt.indexOf('\n// Las reacciones', iFn);
  const cuerpoEstadoDeSala = txt.slice(iFn, finFn > 0 ? finFn : iFn + 4000);
  assert.ok(!/\bUser\b/.test(cuerpoEstadoDeSala),
    'estadoDeSala no puede consultar User: el poll no puede sumar una query por vuelta (RN-08)');

  const iPoll = txt.indexOf("router.get('/:id/sala/poll'");
  assert.ok(iPoll > 0, 'tiene que existir el handler de GET /sala/poll');
  const finPoll = txt.indexOf('\nrouter.', iPoll + 10);
  const cuerpoPoll = txt.slice(iPoll, finPoll > 0 ? finPoll : iPoll + 3000);
  assert.ok(!/\bUser\b/.test(cuerpoPoll),
    'el manejador de GET /sala/poll no puede referenciar User');
});

test('CA-47 (RN-08) — costo: los dos campos nuevos agregan a lo sumo 40 bytes al settings del poll', () => {
  const sinCampos = JSON.stringify({ studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true });
  const conCampos = JSON.stringify({
    studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true,
    sonido: false, sonidoDe: SONIDO_DE_DEFAULT,
  });
  const extra = Buffer.byteLength(conCampos, 'utf8') - Buffer.byteLength(sinCampos, 'utf8');
  assert.ok(extra <= 40, `los campos de sonido agregan ${extra} bytes, más de los 40 presupuestados por RN-08`);
});
