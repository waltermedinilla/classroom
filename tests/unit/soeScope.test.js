// Tests del alcance del panel SOE: qué alumnos puede mirar cada quien.
// Correr con: npm run test:unit
//
// El alcance del SOE es el único caso del proyecto que es fail-OPEN a propósito (un SOE
// sin divisiones asignadas ve toda su escuela, al revés que preceptor y jefatura). Por eso
// las reglas están extraídas como funciones puras: la inversión tiene que estar escrita y
// probada en algún lado, o el próximo que lea middleware/soe.js va a "arreglarla".
//
// Cubren los criterios 8 a 13 de specs/soe-orientacion.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { resolverAlcance, alumnoEnAlcance } = require('../../services/soeAcceso');

// Las divisiones de la escuela, ya filtradas por escuela: es lo que el middleware trae de
// la base antes de llamar a la función pura.
const DIVISIONES_ESCUELA = ['d1', 'd2', 'd3'];

const ESCUELA  = 'esc1';
const OTRA     = 'esc2';

describe('resolverAlcance', () => {
  test('soe sin assignedDivisions ve TODA su escuela (criterio 8)', () => {
    // ⚠️ Fail-OPEN deliberado. El gabinete es uno solo por escuela y mira a todos: si esto
    // fuera fail-closed como preceptor, un SOE recién creado no vería ningún alumno y la
    // pantalla parecería rota. Ver D4 en specs/soe-orientacion.spec.md.
    const alcance = resolverAlcance(
      { role: 'soe', school: ESCUELA, assignedDivisions: [] }, DIVISIONES_ESCUELA);
    assert.strictEqual(alcance.todas, true);
    assert.deepStrictEqual(alcance.divisionIds, DIVISIONES_ESCUELA);

    // Y con el campo directamente ausente, igual.
    const sinCampo = resolverAlcance({ role: 'soe', school: ESCUELA }, DIVISIONES_ESCUELA);
    assert.strictEqual(sinCampo.todas, true);
  });

  test('soe con assignedDivisions queda acotado a esas (criterio 9)', () => {
    const alcance = resolverAlcance(
      { role: 'soe', school: ESCUELA, assignedDivisions: ['d2'] }, DIVISIONES_ESCUELA);
    assert.strictEqual(alcance.todas, false);
    assert.deepStrictEqual(alcance.divisionIds, ['d2']);
  });

  test('allDivisions:true le devuelve la escuela entera aunque tenga asignadas', () => {
    const alcance = resolverAlcance(
      { role: 'soe', school: ESCUELA, assignedDivisions: ['d2'], allDivisions: true },
      DIVISIONES_ESCUELA);
    assert.strictEqual(alcance.todas, true);
    assert.deepStrictEqual(alcance.divisionIds, DIVISIONES_ESCUELA);
  });

  test('las asignadas se filtran SIEMPRE por escuela (criterio 10)', () => {
    // Mover un usuario de escuela (POST /superadmin/users/:id/school) no desvincula nada,
    // por decisión explícita del proyecto: le quedan divisiones de la escuela anterior
    // pegadas en el array. Sin este filtro las seguiría viendo desde la escuela nueva.
    const alcance = resolverAlcance(
      { role: 'soe', school: ESCUELA, assignedDivisions: ['d2', 'zombie-de-otra-escuela'] },
      DIVISIONES_ESCUELA);
    assert.deepStrictEqual(alcance.divisionIds, ['d2']);
  });

  test('todas las asignadas son de otra escuela → no ve nada, pero tampoco todo', () => {
    // El caso peligroso: si el filtro dejara el array vacío y después la regla de
    // "vacío = todas" se aplicara sobre ESE vacío, un usuario mal migrado se quedaría con
    // la escuela entera. El fail-open mira las asignadas ORIGINALES, no las filtradas.
    const alcance = resolverAlcance(
      { role: 'soe', school: ESCUELA, assignedDivisions: ['zombie1', 'zombie2'] },
      DIVISIONES_ESCUELA);
    assert.strictEqual(alcance.todas, false);
    assert.deepStrictEqual(alcance.divisionIds, []);
  });

  test('usuario sin escuela no ve nada', () => {
    const alcance = resolverAlcance({ role: 'soe', school: null }, DIVISIONES_ESCUELA);
    assert.strictEqual(alcance.todas, false);
    assert.deepStrictEqual(alcance.divisionIds, []);
  });

  test('directivo con acceso ve toda la escuela, sin importar sus divisiones (criterio 13)', () => {
    // Un directivo puede tener assignedDivisions cargadas de cuando fue preceptor. Acá no
    // aplican: el que no es SOE no se acota por divisiones, se acota por soeAccess (que ya
    // resolvió requireSoe antes de llegar hasta acá).
    for (const role of ['directivo', 'admin', 'superadmin']) {
      const alcance = resolverAlcance(
        { role, school: ESCUELA, assignedDivisions: ['d2'] }, DIVISIONES_ESCUELA);
      assert.strictEqual(alcance.todas, true, `${role} debería ver todo`);
      assert.deepStrictEqual(alcance.divisionIds, DIVISIONES_ESCUELA);
    }
  });
});

describe('alumnoEnAlcance', () => {
  const TODAS   = { todas: true,  divisionIds: DIVISIONES_ESCUELA };
  const ACOTADO = { todas: false, divisionIds: ['d2'] };

  test('con alcance total, cualquier alumno de la escuela entra', () => {
    assert.strictEqual(
      alumnoEnAlcance(TODAS, { school: ESCUELA, divisiones: ['d3'] }, ESCUELA), true);
  });

  test('un alumno de otra división no entra en un alcance acotado (criterio 9)', () => {
    assert.strictEqual(
      alumnoEnAlcance(ACOTADO, { school: ESCUELA, divisiones: ['d1'] }, ESCUELA), false);
    assert.strictEqual(
      alumnoEnAlcance(ACOTADO, { school: ESCUELA, divisiones: ['d2'] }, ESCUELA), true);
  });

  test('vale con que UNA de sus divisiones esté en el alcance', () => {
    // Un alumno puede cursar materias de más de una división (recursantes, contraturno).
    assert.strictEqual(
      alumnoEnAlcance(ACOTADO, { school: ESCUELA, divisiones: ['d1', 'd2'] }, ESCUELA), true);
  });

  test('manda la división ACTUAL del alumno, no el snapshot del legajo (criterio 11)', () => {
    // SoeCase.division es un snapshot para poder listar sin joins. Si el alumno pasó de d1
    // a d2, quien lo tiene que ver es el SOE de d2 — aunque el legajo siga diciendo d1.
    // Por eso esta función recibe las divisiones resueltas en el momento y nunca lee el caso.
    const alumnoQueSeMudo = { school: ESCUELA, divisiones: ['d2'] }; // el legajo dice 'd1'
    assert.strictEqual(alumnoEnAlcance(ACOTADO, alumnoQueSeMudo, ESCUELA), true);
    const soeDeLaVieja = { todas: false, divisionIds: ['d1'] };
    assert.strictEqual(alumnoEnAlcance(soeDeLaVieja, alumnoQueSeMudo, ESCUELA), false);
  });

  test('un alumno de otra escuela nunca entra, ni con alcance total (criterio 12)', () => {
    // El caso de escribir un id ajeno en la barra de direcciones. El chequeo de escuela va
    // ANTES que el de divisiones: con alcance total no habría ninguna división que comparar.
    assert.strictEqual(
      alumnoEnAlcance(TODAS, { school: OTRA, divisiones: ['d1'] }, ESCUELA), false);
    assert.strictEqual(
      alumnoEnAlcance(ACOTADO, { school: OTRA, divisiones: ['d2'] }, ESCUELA), false);
  });

  test('un alumno sin ninguna materia no entra en un alcance acotado', () => {
    // No tiene división que lo ubique. Con alcance total sí se lo puede atender (es de la
    // escuela); acotado, no hay forma de saber si le toca a este SOE.
    assert.strictEqual(
      alumnoEnAlcance(ACOTADO, { school: ESCUELA, divisiones: [] }, ESCUELA), false);
    assert.strictEqual(
      alumnoEnAlcance(TODAS, { school: ESCUELA, divisiones: [] }, ESCUELA), true);
  });

  test('sin alumno o sin escuela del usuario → false', () => {
    assert.strictEqual(alumnoEnAlcance(TODAS, null, ESCUELA), false);
    assert.strictEqual(alumnoEnAlcance(TODAS, { school: ESCUELA, divisiones: ['d1'] }, null), false);
  });

  test('compara ids como string aunque lleguen como ObjectId', () => {
    // Lo que llega de Mongoose son ObjectId, y ObjectId !== string con ===. Este es el bug
    // clásico que convierte una guarda en un "siempre false" silencioso.
    const oid = (s) => ({ toString: () => s });
    assert.strictEqual(
      alumnoEnAlcance({ todas: false, divisionIds: ['d2'] },
        { school: oid(ESCUELA), divisiones: [oid('d2')] }, oid(ESCUELA)), true);
  });
});
