// Tests de la lógica pura de la audiencia de un mensaje (services/messageAudience.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Se testea acá y no con un smoke HTTP porque es DECISIÓN, no persistencia: qué filtro se
// arma y cómo se combinan los conjuntos. Que la query después traiga los documentos
// correctos lo cubren los specs de humo (criterios 15-23 de la spec).
//
// Cubren los criterios 1-9 de specs/mensajeria-superadmin.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const { construirFiltroGrupo, filtroSueltos, combinarIds } =
  require('../../services/messageAudience');

// Ids con forma de ObjectId (24 hex) para que las comparaciones por String() sean realistas.
const ID = (n) => String(n).padStart(24, 'a');
const REMITENTE = ID(1);
const ESCUELA_A = ID(90);
const ESCUELA_B = ID(91);

// ── Criterio 1: un rol ───────────────────────────────────────────────────────

test('construirFiltroGrupo: un rol filtra por ese rol y solo por usuarios activos', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ roles: ['teacher'] }),
    { active: true, role: { $in: ['teacher'] } },
  );
});

// ── Criterio 2: dos roles ────────────────────────────────────────────────────

test('construirFiltroGrupo: dos roles entran los dos en el $in', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ roles: ['teacher', 'student'] }),
    { active: true, role: { $in: ['teacher', 'student'] } },
  );
});

test('construirFiltroGrupo: descarta roles que no existen y no repite', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ roles: ['teacher', 'inventado', 'teacher'] }),
    { active: true, role: { $in: ['teacher'] } },
  );
});

// ── Criterio 3: rol + escuela se intersectan ─────────────────────────────────

test('construirFiltroGrupo: rol + escuela van juntos en el mismo filtro (intersección)', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ roles: ['teacher'], schools: [ESCUELA_A] }),
    { active: true, role: { $in: ['teacher'] }, school: { $in: [ESCUELA_A] } },
  );
});

test('construirFiltroGrupo: varias escuelas entran las dos', () => {
  const f = construirFiltroGrupo({ roles: ['student'], schools: [ESCUELA_A, ESCUELA_B] });
  assert.deepStrictEqual(f.school, { $in: [ESCUELA_A, ESCUELA_B] });
});

// La escuela ACOTA, no selecciona: sin rol y sin "toda la comunidad" no hay grupo. Es a
// propósito — que tildar una escuela sola mandara a la escuela entera es exactamente el
// accidente que RN-05 trata de evitar.
test('construirFiltroGrupo: una escuela sola, sin rol ni everyone, no arma grupo', () => {
  assert.strictEqual(construirFiltroGrupo({ schools: [ESCUELA_A] }), null);
});

// ── Criterio 4: everyone ignora los roles ────────────────────────────────────

test('construirFiltroGrupo: everyone es "sin filtro de rol", solo activos', () => {
  assert.deepStrictEqual(construirFiltroGrupo({ everyone: true }), { active: true });
});

test('construirFiltroGrupo: everyone IGNORA los roles aunque vengan cargados', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ everyone: true, roles: ['teacher'] }),
    { active: true },
  );
});

test('construirFiltroGrupo: everyone sigue respetando el filtro de escuela', () => {
  assert.deepStrictEqual(
    construirFiltroGrupo({ everyone: true, schools: [ESCUELA_A] }),
    { active: true, school: { $in: [ESCUELA_A] } },
  );
});

// ── Criterio 7: los elegidos a mano también tienen que estar activos ─────────

test('filtroSueltos: exige active:true igual que el grupo', () => {
  assert.deepStrictEqual(
    filtroSueltos([ID(2), ID(3)]),
    { _id: { $in: [ID(2), ID(3)] }, active: true },
  );
});

test('filtroSueltos: sin ids no hay filtro', () => {
  assert.strictEqual(filtroSueltos([]), null);
  assert.strictEqual(filtroSueltos(undefined), null);
});

// ── Criterio 5: los sueltos se SUMAN al grupo ────────────────────────────────

test('combinarIds: los elegidos a mano se suman al grupo, no lo intersectan', () => {
  const r = combinarIds([ID(10), ID(11)], [ID(50)], REMITENTE);
  assert.deepStrictEqual(r.sort(), [ID(10), ID(11), ID(50)].sort());
});

test('combinarIds: sin grupo, quedan solo los elegidos a mano', () => {
  assert.deepStrictEqual(combinarIds([], [ID(50)], REMITENTE), [ID(50)]);
});

// ── Criterio 6: el remitente nunca se autoenvía ──────────────────────────────

test('combinarIds: el remitente sale del grupo', () => {
  const r = combinarIds([ID(10), REMITENTE], [], REMITENTE);
  assert.deepStrictEqual(r, [ID(10)]);
});

test('combinarIds: el remitente sale aunque se haya elegido a sí mismo a mano', () => {
  const r = combinarIds([], [REMITENTE, ID(50)], REMITENTE);
  assert.deepStrictEqual(r, [ID(50)]);
});

// ── Criterio 9: nunca ids repetidos ──────────────────────────────────────────

test('combinarIds: una persona que entra por los dos caminos aparece una sola vez', () => {
  const r = combinarIds([ID(10), ID(11)], [ID(10)], REMITENTE);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.sort(), [ID(10), ID(11)].sort());
});

test('combinarIds: tolera ObjectId y string mezclados sin duplicar', () => {
  // Un ObjectId de Mongoose no es === a su string, pero es la misma persona.
  const comoObjectId = { toString: () => ID(10) };
  const r = combinarIds([comoObjectId], [ID(10)], REMITENTE);
  assert.deepStrictEqual(r, [ID(10)]);
});

// ── Criterio 8: sin nada elegido no hay audiencia ────────────────────────────

test('construirFiltroGrupo: sin everyone y sin roles no hay grupo', () => {
  [{}, { roles: [] }, { everyone: false, roles: [] }, undefined].forEach(v => {
    assert.strictEqual(construirFiltroGrupo(v), null, `falló con ${JSON.stringify(v)}`);
  });
});

test('combinarIds: sin grupo y sin sueltos devuelve vacío (el POST responde 400)', () => {
  assert.deepStrictEqual(combinarIds([], [], REMITENTE), []);
});
