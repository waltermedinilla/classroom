// Los DOS EJES de un módulo opcional: la escuela lo prende, y adentro se elige a quién.
//
// Estrenado por `transmision` (ver D10 de specs/transmision-en-vivo.spec.md). Lo que se prueba
// acá es la regla de habilitación sola, sin base y sin Express: es la que decide si un docente
// puede transmitir, y equivocarla en un sentido deja la feature muerta y en el otro se la
// reparte a toda la escuela.
//
// ⚠️ El caso que hay que no romper nunca es el de moduloActivo(): la firma vieja tiene 4 usos
// (server.js, middleware/modulos.js, el resumen de la escuela) y este cambio NO la toca.

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  MODULOS, moduloActivo, moduloActivoPara, modulosActivos,
} = require('../../config/modulos');

// Ids con forma de ObjectId. Se comparan como texto, igual que hace la función.
const ANA  = { _id: '507f1f77bcf86cd799439011', name: 'GOMEZ, Ana' };
const LUIS = { _id: '507f1f77bcf86cd799439012', name: 'PEREZ, Luis' };

const escuela = (modules) => ({ _id: 'esc1', name: 'Escuela 4-118', modules });

// ── El catálogo ──────────────────────────────────────────────────────────────

test('el catálogo declara transmision como módulo de dos ejes', () => {
  const tx = MODULOS.find(m => m.id === 'transmision');
  assert.ok(tx, 'transmision tiene que estar en el catálogo');
  assert.strictEqual(tx.alcance, 'escuela+persona');
  // Sin solapas propias: vive adentro de la solapa "En vivo", que ya existe.
  assert.deepStrictEqual(tx.secciones, []);
});

test('recursos sigue siendo de un solo eje', () => {
  const r = MODULOS.find(m => m.id === 'recursos');
  assert.strictEqual(r.alcance, 'escuela');
});

// ── Eje 1: la escuela ────────────────────────────────────────────────────────

test('se despliega APAGADO: una escuela sin el campo no tiene transmisión', () => {
  assert.strictEqual(moduloActivo(escuela(undefined), 'transmision'), false);
  assert.strictEqual(moduloActivoPara(escuela(undefined), ANA, 'transmision'), false);
});

test('escuela con el módulo apagado: ni siquiera un docente de la lista puede', () => {
  const s = escuela({ transmision: { enabled: false, alcance: 'lista', personas: [ANA._id] } });
  assert.strictEqual(moduloActivo(s, 'transmision'), false);
  assert.strictEqual(moduloActivoPara(s, ANA, 'transmision'), false);
});

test('sin escuela, fail-closed', () => {
  assert.strictEqual(moduloActivo(null, 'transmision'), false);
  assert.strictEqual(moduloActivoPara(null, ANA, 'transmision'), false);
});

test('un id que no existe en el catálogo nunca habilita nada', () => {
  const s = escuela({ inventado: { enabled: true } });
  assert.strictEqual(moduloActivo(s, 'inventado'), false);
  assert.strictEqual(moduloActivoPara(s, ANA, 'inventado'), false);
});

// ── Eje 2: las personas ──────────────────────────────────────────────────────

test('prender la escuela NO le da la transmisión a nadie todavía', () => {
  // Es el estado por el que se empieza, y el motivo del default alcance:'lista'.
  const s = escuela({ transmision: { enabled: true, alcance: 'lista', personas: [] } });
  assert.strictEqual(moduloActivo(s, 'transmision'), true,  'la escuela sí lo tiene');
  assert.strictEqual(moduloActivoPara(s, ANA, 'transmision'), false, 'pero ningún docente');
});

test('el docente de la lista puede; el que no está, no', () => {
  const s = escuela({ transmision: { enabled: true, alcance: 'lista', personas: [ANA._id] } });
  assert.strictEqual(moduloActivoPara(s, ANA,  'transmision'), true);
  assert.strictEqual(moduloActivoPara(s, LUIS, 'transmision'), false);
});

test('alcance "todos" habilita sin mirar la lista', () => {
  const s = escuela({ transmision: { enabled: true, alcance: 'todos', personas: [] } });
  assert.strictEqual(moduloActivoPara(s, ANA,  'transmision'), true);
  assert.strictEqual(moduloActivoPara(s, LUIS, 'transmision'), true);
});

test('los ids se comparan como texto: ObjectId y string dan lo mismo', () => {
  // En la base `personas` son ObjectId; en un test, strings. La función usa String() en los dos
  // lados justamente para que esto no dependa de por dónde vino el dato.
  const comoObjectId = { toString: () => ANA._id };
  const s = escuela({ transmision: { enabled: true, alcance: 'lista', personas: [comoObjectId] } });
  assert.strictEqual(moduloActivoPara(s, ANA, 'transmision'), true);
});

test('sin usuario, fail-closed aunque la escuela lo tenga', () => {
  const s = escuela({ transmision: { enabled: true, alcance: 'lista', personas: [ANA._id] } });
  assert.strictEqual(moduloActivoPara(s, null,      'transmision'), false);
  assert.strictEqual(moduloActivoPara(s, undefined, 'transmision'), false);
  assert.strictEqual(moduloActivoPara(s, {},        'transmision'), false);
});

test('sin usuario y alcance "todos" SÍ habilita: no hay a quién buscar en ninguna lista', () => {
  // No es una inconsistencia con el test de arriba: con 'todos' la pregunta "¿está en la lista?"
  // no se hace. Queda escrito para que nadie lo "arregle" agregándole un chequeo de user.
  const s = escuela({ transmision: { enabled: true, alcance: 'todos' } });
  assert.strictEqual(moduloActivoPara(s, null, 'transmision'), true);
});

test('alcance ausente en la base se comporta como "lista" (fail-closed)', () => {
  // Una escuela cuyo doc se escribió antes de que existiera el campo.
  const s = escuela({ transmision: { enabled: true } });
  assert.strictEqual(moduloActivoPara(s, ANA, 'transmision'), false);
});

// ── El eje de persona NO aplica a los módulos de un eje ──────────────────────

test('recursos no mira personas: prendido para la escuela, vale para todos', () => {
  const s = escuela({ recursos: { enabled: true } });
  assert.strictEqual(moduloActivoPara(s, ANA,  'recursos'), true);
  assert.strictEqual(moduloActivoPara(s, LUIS, 'recursos'), true);
  assert.strictEqual(moduloActivoPara(s, null, 'recursos'), true);
});

// ── Compatibilidad: lo que no se puede haber roto ────────────────────────────

test('moduloActivo conserva su firma y su significado (4 usos existentes)', () => {
  const s = escuela({ recursos: { enabled: true }, transmision: { enabled: false } });
  assert.strictEqual(moduloActivo(s, 'recursos'),    true);
  assert.strictEqual(moduloActivo(s, 'transmision'), false);
});

test('modulosActivos lista por ESCUELA, no por persona', () => {
  // Con la escuela prendida y ningún docente habilitado, transmision igual figura: el resumen
  // del panel contesta "qué tiene esta escuela", no "qué puede hacer fulano".
  const s = escuela({ transmision: { enabled: true, alcance: 'lista', personas: [] } });
  assert.deepStrictEqual(modulosActivos(s), ['transmision']);
});
