// Tests de services/jefaturaAcceso.js y del costo de middleware/jefatura.js
// (marcarDocenteJefe / pertenenciaJefatura).
// Correr con: npm run test:unit
//
// specs/docente-jefe-de-seccion.spec.md § Tests necesarios pide, para este archivo:
//   - modoJefatura y decidirAccesoJefatura: CA-08, CA-14, y los 8 roles de User.getRoles()
//   - esElegibleComoJefe: cada combinación de rol, estado y escuela
//   - resolverHeads: los siete pasos de RN-22, duplicados, headIds que no es array, orden
//   - marcarDocenteJefe y pertenenciaJefatura, con un modelo Section falso: CA-25 a CA-29
//   - loadJefaturaScope con un teacher sin secciones y logRechazo espiado: CA-11
//   - la guarda del catálogo: CA-52
//
// Por qué acá y no en el smoke: decidirAccesoJefatura y resolverHeads son funciones PURAS
// (services/jefaturaAcceso.js no toca la base ni el reloj) y se pueden probar con la escuela
// y los usuarios en estados que por HTTP costaría fabricar — un jefe deshabilitado, un id de
// otra escuela, un headIds que llega roto. El smoke (tests/smoke/specs.js, bloque
// docente-jefe-*) cubre las mismas reglas del lado HTTP: rutas, sesión y persistencia real.
//
// NOTA PARA QUIEN CORRA ESTO ANTES DE LA IMPLEMENTACIÓN: todo el archivo falla al arrancar,
// con "Cannot find module '../../services/jefaturaAcceso'" — services/jefaturaAcceso.js
// todavía no existe (D1/D2, § Entidades/Schemas). Es la señal correcta: no hay una sola
// aserción que pueda evaluarse hasta que el módulo puro exista.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ROLES_JEFATURA_SIN_LIMITE,
  ROLES_JEFATURA_POR_ROL,
  ROLES_JEFATURA_POR_SECCION,
  ROLES_ELEGIBLES_JEFE,
  modoJefatura,
  decidirAccesoJefatura,
  esElegibleComoJefe,
  resolverHeads,
} = require('../../services/jefaturaAcceso');

const User = require('../../models/User');
const { SECTIONS } = require('../../config/sections');

// ═════════════════════════════════════════════════════════════════════════
// A. modoJefatura / decidirAccesoJefatura — RN-02, CA-08, CA-14
// ═════════════════════════════════════════════════════════════════════════

describe('modoJefatura', () => {
  test('clasifica los 8 roles de User.getRoles() sin dejar ninguno afuera', () => {
    // Tabla espejo de la de RN-02. Si mañana se agrega un rol nuevo a models/User.js y
    // nadie lo suma acá, `esperado[rol]` da undefined y el test avisa ANTES de que el rol
    // nuevo quede sin clasificar en producción (fail-closed silencioso).
    const esperado = {
      superadmin: 'sin-limite',
      admin: 'sin-limite',
      directivo: 'sin-limite',
      jefe: 'por-rol',
      teacher: 'por-seccion',
      preceptor: null,
      soe: null,
      student: null,
    };
    const roles = User.getRoles();
    assert.strictEqual(roles.length, Object.keys(esperado).length,
      `User.getRoles() tiene ${roles.length} roles y este test solo clasifica ${Object.keys(esperado).length}: sumá el que falta`);
    for (const rol of roles) {
      assert.ok(Object.prototype.hasOwnProperty.call(esperado, rol), `'${rol}' no está en la tabla esperada de este test`);
      assert.strictEqual(modoJefatura(rol), esperado[rol], `modoJefatura('${rol}')`);
    }
  });

  test('las tres constantes de servicio coinciden con la tabla', () => {
    assert.deepStrictEqual([...ROLES_JEFATURA_SIN_LIMITE].sort(), ['admin', 'directivo', 'superadmin']);
    assert.deepStrictEqual(ROLES_JEFATURA_POR_ROL, ['jefe']);
    assert.deepStrictEqual(ROLES_JEFATURA_POR_SECCION, ['teacher']);
  });

  test('sin rol, con rol vacío o inventado → null', () => {
    assert.strictEqual(modoJefatura(null), null);
    assert.strictEqual(modoJefatura(undefined), null);
    assert.strictEqual(modoJefatura(''), null);
    assert.strictEqual(modoJefatura('coordinador'), null);
  });
});

describe('decidirAccesoJefatura', () => {
  test('CA-08: teacher con 0, 1 y 50 secciones — scopeAll siempre false', () => {
    const u = { role: 'teacher', school: 'E' };
    assert.deepStrictEqual(decidirAccesoJefatura(u, 0),  { entra: false, scopeAll: false });
    assert.deepStrictEqual(decidirAccesoJefatura(u, 1),  { entra: true,  scopeAll: false });
    assert.deepStrictEqual(decidirAccesoJefatura(u, 50), { entra: true,  scopeAll: false });
  });

  test('CA-08: teacher sin escuela no entra aunque tenga secciones', () => {
    const sinEscuela = { role: 'teacher', school: null };
    assert.strictEqual(decidirAccesoJefatura(sinEscuela, 3).entra, false);
    assert.strictEqual(decidirAccesoJefatura({ role: 'teacher' }, 3).entra, false);
  });

  test('CA-14: directivo, admin y superadmin entran siempre con scopeAll, cualquier n', () => {
    for (const role of ['directivo', 'admin', 'superadmin']) {
      for (const n of [0, 1, 50]) {
        assert.deepStrictEqual(decidirAccesoJefatura({ role, school: 'E' }, n), { entra: true, scopeAll: true },
          `${role} con n=${n}`);
      }
      // Ni siquiera necesitan escuela: ven todas las secciones por rol.
      assert.deepStrictEqual(decidirAccesoJefatura({ role, school: null }, 0), { entra: true, scopeAll: true });
    }
  });

  test('CA-14: jefe entra siempre por rol, scopeAll false, aun con 0 secciones', () => {
    assert.deepStrictEqual(decidirAccesoJefatura({ role: 'jefe', school: 'E' }, 0), { entra: true, scopeAll: false });
    assert.deepStrictEqual(decidirAccesoJefatura({ role: 'jefe', school: 'E' }, 5), { entra: true, scopeAll: false });
  });

  test('preceptor, soe y student nunca entran, aunque figuren en heads (n > 0)', () => {
    for (const role of ['preceptor', 'soe', 'student']) {
      assert.deepStrictEqual(decidirAccesoJefatura({ role, school: 'E' }, 1), { entra: false, scopeAll: false }, role);
      assert.deepStrictEqual(decidirAccesoJefatura({ role, school: 'E' }, 0), { entra: false, scopeAll: false }, role);
    }
  });

  test('user null o sin role → entra false, scopeAll false', () => {
    assert.deepStrictEqual(decidirAccesoJefatura(null, 5), { entra: false, scopeAll: false });
    assert.deepStrictEqual(decidirAccesoJefatura(undefined, 5), { entra: false, scopeAll: false });
    assert.deepStrictEqual(decidirAccesoJefatura({ school: 'E' }, 5), { entra: false, scopeAll: false });
  });

  test('scopeAll es true SOLO en modo sin-limite: nunca para por-seccion, con ningún n', () => {
    for (const n of [0, 1, 1000]) {
      assert.strictEqual(decidirAccesoJefatura({ role: 'teacher', school: 'E' }, n).scopeAll, false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. esElegibleComoJefe — RN-19, RN-22.3, DA-1, DA-3
// ═════════════════════════════════════════════════════════════════════════

describe('esElegibleComoJefe', () => {
  const E = '6a2229fce256f3bb84930a9d';
  const OTRA = '000000000000000000000001';

  test('jefe y teacher activos de la escuela son elegibles', () => {
    assert.strictEqual(esElegibleComoJefe({ _id: 'u1', role: 'jefe', school: E, active: true }, E), true);
    assert.strictEqual(esElegibleComoJefe({ _id: 'u2', role: 'teacher', school: E, active: true }, E), true);
  });

  test('active ausente (undefined) cuenta como activo — mismo criterio que el resto del proyecto', () => {
    assert.strictEqual(esElegibleComoJefe({ _id: 'u3', role: 'teacher', school: E }, E), true);
  });

  test('active === false no es elegible (DA-1)', () => {
    assert.strictEqual(esElegibleComoJefe({ _id: 'u4', role: 'jefe', school: E, active: false }, E), false);
    assert.strictEqual(esElegibleComoJefe({ _id: 'u5', role: 'teacher', school: E, active: false }, E), false);
  });

  test('otro rol (directivo, admin, preceptor, soe, student, superadmin) no es elegible (DA-3)', () => {
    for (const role of ['directivo', 'admin', 'preceptor', 'soe', 'student', 'superadmin']) {
      assert.strictEqual(esElegibleComoJefe({ _id: 'u6', role, school: E, active: true }, E), false, role);
    }
  });

  test('de otra escuela no es elegible, aunque el rol y el estado estén bien', () => {
    assert.strictEqual(esElegibleComoJefe({ _id: 'u7', role: 'teacher', school: OTRA, active: true }, E), false);
  });

  test('usuario inexistente (null/undefined) no es elegible', () => {
    assert.strictEqual(esElegibleComoJefe(null, E), false);
    assert.strictEqual(esElegibleComoJefe(undefined, E), false);
  });

  test('compara escuelas por String(): funciona con ObjectId-like además de string', () => {
    const objectIdFalso = { toString: () => E };
    assert.strictEqual(esElegibleComoJefe({ _id: 'u8', role: 'jefe', school: objectIdFalso, active: true }, E), true);
    assert.strictEqual(esElegibleComoJefe({ _id: 'u9', role: 'jefe', school: E, active: true }, objectIdFalso), true);
  });

  test('sin escuela (usuario o parámetro) no es elegible', () => {
    assert.strictEqual(esElegibleComoJefe({ _id: 'u10', role: 'jefe', school: null, active: true }, E), false);
    assert.strictEqual(esElegibleComoJefe({ _id: 'u11', role: 'jefe', school: E, active: true }, null), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. resolverHeads — RN-22, los siete pasos
// ═════════════════════════════════════════════════════════════════════════

describe('resolverHeads', () => {
  const E = 'E';
  const OTRA = 'OTRA-ESCUELA';

  // Construye el Map usuarios: id → { _id, name, role, school, active }
  const mapa = (...entradas) => new Map(entradas.map(u => [String(u._id), u]));

  test('RN-22.1: headIds que no es array cuenta como []', () => {
    const r = resolverHeads({ pedidos: 'esto-no-es-un-array', actuales: [], usuarios: mapa(), school: E });
    assert.deepStrictEqual(r.heads, []);
    assert.deepStrictEqual(r.agregados, []);
    assert.deepStrictEqual(r.rechazados, []);
  });

  test('RN-22.1: pedidos undefined también cuenta como []', () => {
    const r = resolverHeads({ pedidos: undefined, actuales: [], usuarios: mapa(), school: E });
    assert.deepStrictEqual(r.heads, []);
  });

  test('RN-22.1: los duplicados en headIds se deduplican', () => {
    const jefe = { _id: 'j1', name: 'Jefe Uno', role: 'jefe', school: E, active: true };
    const r = resolverHeads({ pedidos: ['j1', 'j1', 'j1'], actuales: [], usuarios: mapa(jefe), school: E });
    assert.deepStrictEqual(r.heads.map(String), ['j1']);
    assert.deepStrictEqual(r.agregados, ['Jefe Uno']); // una sola vez, no tres
  });

  test('RN-22.2: un jefe que ya estaba se conserva SIN revalidar rol ni estado', () => {
    // Vino con el rol Preceptor y deshabilitado: ninguna de las dos cosas lo elegiría hoy
    // como candidato nuevo, pero como YA estaba a cargo, la regla no lo revisa.
    const yaEstaba = { _id: 'x1', name: 'Ex Jefe Preceptor', role: 'preceptor', school: E, active: false };
    const r = resolverHeads({ pedidos: ['x1'], actuales: ['x1'], usuarios: mapa(yaEstaba), school: E });
    assert.deepStrictEqual(r.heads.map(String), ['x1']);
    assert.deepStrictEqual(r.agregados, [], 'no es nuevo, no cuenta como agregado');
    assert.deepStrictEqual(r.quitados, []);
    assert.deepStrictEqual(r.descartados, []);
  });

  test('RN-22.3: un id nuevo se acepta solo si esElegibleComoJefe, y queda en agregados', () => {
    const nuevoTeacher = { _id: 't1', name: 'Docente Nuevo', role: 'teacher', school: E, active: true };
    const r = resolverHeads({ pedidos: ['t1'], actuales: [], usuarios: mapa(nuevoTeacher), school: E });
    assert.deepStrictEqual(r.heads.map(String), ['t1']);
    assert.deepStrictEqual(r.agregados, ['Docente Nuevo']);
    assert.deepStrictEqual(r.rechazados, []);
  });

  test('RN-22.4: id nuevo malformado o inexistente → rechazado con nombre null', () => {
    const r = resolverHeads({ pedidos: ['no-existe-este-id'], actuales: [], usuarios: mapa(), school: E });
    assert.deepStrictEqual(r.heads, []);
    assert.strictEqual(r.rechazados.length, 1);
    assert.strictEqual(r.rechazados[0].id, 'no-existe-este-id');
    assert.strictEqual(r.rechazados[0].nombre, null);
  });

  test('RN-22.4: id nuevo de otra escuela → rechazado con nombre null (D3 de identidad-multiescuela)', () => {
    const deOtraEscuela = { _id: 'o1', name: 'De Otra Escuela', role: 'teacher', school: OTRA, active: true };
    const r = resolverHeads({ pedidos: ['o1'], actuales: [], usuarios: mapa(deOtraEscuela), school: E });
    assert.strictEqual(r.rechazados.length, 1);
    assert.strictEqual(r.rechazados[0].nombre, null, 'no se expone el nombre de alguien de otra escuela');
  });

  test('RN-22.4: id nuevo deshabilitado → rechazado, CON nombre (para el aviso del editor)', () => {
    const deshabilitado = { _id: 'd1', name: 'Cuenta Apagada', role: 'teacher', school: E, active: false };
    const r = resolverHeads({ pedidos: ['d1'], actuales: [], usuarios: mapa(deshabilitado), school: E });
    assert.strictEqual(r.rechazados.length, 1);
    assert.strictEqual(r.rechazados[0].nombre, 'Cuenta Apagada');
  });

  test('RN-22.4: id nuevo con rol no elegible → rechazado, CON nombre', () => {
    const alumno = { _id: 'a1', name: 'Un Alumno', role: 'student', school: E, active: true };
    const r = resolverHeads({ pedidos: ['a1'], actuales: [], usuarios: mapa(alumno), school: E });
    assert.strictEqual(r.rechazados.length, 1);
    assert.strictEqual(r.rechazados[0].nombre, 'Un Alumno');
  });

  test('RN-22.4: mezcla de válidos y rechazados — los rechazados no ensucian a los válidos', () => {
    const bueno = { _id: 'b1', name: 'Válido', role: 'jefe', school: E, active: true };
    const malo  = { _id: 'm1', name: 'Malo', role: 'student', school: E, active: true };
    const r = resolverHeads({ pedidos: ['b1', 'm1'], actuales: [], usuarios: mapa(bueno, malo), school: E });
    assert.deepStrictEqual(r.agregados, ['Válido']);
    assert.strictEqual(r.rechazados.length, 1);
    assert.strictEqual(r.rechazados[0].id, 'm1');
  });

  test('RN-22.5: un jefe actual que NO vino en headIds se quita, queda en quitados', () => {
    const actual = { _id: 'q1', name: 'El Que Sacan', role: 'jefe', school: E, active: true };
    const r = resolverHeads({ pedidos: [], actuales: ['q1'], usuarios: mapa(actual), school: E });
    assert.deepStrictEqual(r.heads, []);
    assert.deepStrictEqual(r.quitados, ['El Que Sacan']);
    assert.deepStrictEqual(r.descartados, []);
  });

  test('RN-22.6: un jefe actual que ya no existe se quita, haya venido o no en headIds', () => {
    // Sembrado a mano: 'fantasma' está en `actuales` pero NO en el Map de usuarios (no existe).
    const rSinPedirlo = resolverHeads({ pedidos: [], actuales: ['fantasma'], usuarios: mapa(), school: E });
    assert.deepStrictEqual(rSinPedirlo.heads, []);
    assert.strictEqual(rSinPedirlo.descartados.length, 1);
    assert.deepStrictEqual(rSinPedirlo.quitados, [], 'un inexistente es descartado, no "quitado"');

    // Aunque el formulario lo reenvíe tildado (viene en headIds), sigue afuera.
    const rPidiendolo = resolverHeads({ pedidos: ['fantasma'], actuales: ['fantasma'], usuarios: mapa(), school: E });
    assert.deepStrictEqual(rPidiendolo.heads, []);
    assert.strictEqual(rPidiendolo.descartados.length, 1);
    assert.deepStrictEqual(rPidiendolo.rechazados, [], 'no es un id "nuevo": es un jefe actual descartado');
  });

  test('RN-22.6: un jefe actual de otra escuela se quita igual (CA-42)', () => {
    const deOtraEscuela = { _id: 'oe1', name: 'Mudado', role: 'jefe', school: OTRA, active: true };
    const r = resolverHeads({ pedidos: ['oe1'], actuales: ['oe1'], usuarios: mapa(deOtraEscuela), school: E });
    assert.deepStrictEqual(r.heads, []);
    assert.strictEqual(r.descartados.length, 1);
  });

  test('RN-22.6 (CA-42): dos ids sembrados —otra escuela e inexistente— dan descartados = 2', () => {
    const deOtraEscuela = { _id: 'oe2', name: 'Mudado 2', role: 'jefe', school: OTRA, active: true };
    const r = resolverHeads({
      pedidos: ['oe2', 'fantasma2'],
      actuales: ['oe2', 'fantasma2'],
      usuarios: mapa(deOtraEscuela),
      school: E,
    });
    assert.deepStrictEqual(r.heads, []);
    assert.strictEqual(r.descartados.length, 2);
  });

  test('RN-22.7: el orden de heads es el de headIds, no el de actuales', () => {
    const j1 = { _id: 'p1', name: 'Primero', role: 'jefe', school: E, active: true };
    const j2 = { _id: 'p2', name: 'Segundo', role: 'jefe', school: E, active: true };
    // actuales trae p1 antes que p2; headIds pide p2 primero.
    const r = resolverHeads({ pedidos: ['p2', 'p1'], actuales: ['p1', 'p2'], usuarios: mapa(j1, j2), school: E });
    assert.deepStrictEqual(r.heads.map(String), ['p2', 'p1']);
  });

  test('CA-39 (la trampa): reenviar el formulario tal cual no mueve nada', () => {
    // S con heads: [jefe, docenteJefe]. El admin abre, no toca los checkboxes (los dos
    // vienen tildados) y cambia solo el contenido. headIds llega igual a como estaba.
    const jefe = { _id: 'jf1', name: 'Jefe Titular', role: 'jefe', school: E, active: true };
    const docenteJefe = { _id: 'dj1', name: 'María Angélica', role: 'teacher', school: E, active: true };
    const r = resolverHeads({
      pedidos: ['jf1', 'dj1'], actuales: ['jf1', 'dj1'],
      usuarios: mapa(jefe, docenteJefe), school: E,
    });
    assert.deepStrictEqual(r.heads.map(String), ['jf1', 'dj1']);
    assert.deepStrictEqual(r.quitados, []);
    assert.deepStrictEqual(r.descartados, []);
    assert.deepStrictEqual(r.agregados, [], 'ninguno es nuevo: los dos ya estaban');
  });

  test('CA-43: destildar a uno de dos jefes actuales lo manda a quitados y conserva al otro', () => {
    const jefe = { _id: 'jf2', name: 'Se Queda', role: 'jefe', school: E, active: true };
    const docenteJefe = { _id: 'dj2', name: 'Se Va', role: 'teacher', school: E, active: true };
    const r = resolverHeads({
      pedidos: ['jf2'], // dj2 quedó destildado
      actuales: ['jf2', 'dj2'],
      usuarios: mapa(jefe, docenteJefe), school: E,
    });
    assert.deepStrictEqual(r.heads.map(String), ['jf2']);
    assert.deepStrictEqual(r.quitados, ['Se Va']);
  });

  test('escenario combinado: conservado + agregado + quitado + descartado + rechazado a la vez', () => {
    const conservado = { _id: 'c1', name: 'Conservado', role: 'jefe', school: E, active: true };
    const nuevo      = { _id: 'n1', name: 'Nuevo', role: 'teacher', school: E, active: true };
    const seVa       = { _id: 'v1', name: 'Se Va', role: 'jefe', school: E, active: true };
    const inelegible = { _id: 'i1', name: 'Inelegible', role: 'student', school: E, active: true };
    // 'fantasma' está en actuales pero no en el Map: no existe más.
    const usuarios = mapa(conservado, nuevo, seVa, inelegible);

    const r = resolverHeads({
      pedidos: ['c1', 'n1', 'i1'],
      actuales: ['c1', 'v1', 'fantasma'],
      usuarios, school: E,
    });

    assert.deepStrictEqual(r.heads.map(String).sort(), ['c1', 'n1'].sort());
    assert.deepStrictEqual(r.agregados, ['Nuevo']);
    assert.deepStrictEqual(r.quitados, ['Se Va']);
    assert.strictEqual(r.descartados.length, 1); // fantasma
    assert.strictEqual(r.rechazados.length, 1);  // i1, rol no elegible
    assert.strictEqual(r.rechazados[0].id, 'i1');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. El costo: marcarDocenteJefe / pertenenciaJefatura — RN-14 a RN-17, CA-25 a CA-29
// ═════════════════════════════════════════════════════════════════════════
//
// Se importan DESPUÉS de las secciones de arriba porque requieren middleware/jefatura.js,
// que a su vez importa models/Section y models/Course (mongoose). Requerirlos no abre
// conexión — mongoose.model() no dial a la base — así que no hace falta Mongo levantado
// para este bloque.

describe('marcarDocenteJefe / pertenenciaJefatura (el costo, RN-14 a RN-17)', () => {
  const { marcarDocenteJefe, pertenenciaJefatura } = require('../../middleware/jefatura');

  // Un Section falso que solo implementa `.exists()`, que es lo único que usa
  // pertenenciaJefatura según la spec. Cuenta llamadas y guarda el último filtro.
  function fakeSection({ resultado = true, falla = false, demoraMs = 0 } = {}) {
    const llamadas = [];
    return {
      llamadas,
      async exists(filtro) {
        llamadas.push(filtro);
        if (demoraMs) await new Promise(r => setTimeout(r, demoraMs));
        if (falla) throw new Error('Mongo caído (simulado para CA-29)');
        return resultado;
      },
    };
  }

  function fakeReqRes(user) {
    const req = {};
    const renders = [];
    const res = {
      locals: { user },
      render(view, locals) { renders.push({ view, locals }); },
      json(body)     { renders.push({ json: body }); },
      redirect(url)  { renders.push({ redirect: url }); },
      send(body)     { renders.push({ send: body }); },
    };
    return { req, res, renders };
  }

  // Espera lo que haga falta a que `res.render` (posiblemente async por dentro) termine de
  // invocar al render original, tolerando las dos formas válidas de implementarlo: que la
  // función envuelta devuelva la promesa, o que no la devuelva (fire-and-forget).
  async function esperarRender(posibleFn) {
    const ret = typeof posibleFn === 'function' ? posibleFn() : posibleFn;
    if (ret && typeof ret.then === 'function') await ret;
    else await new Promise(r => setTimeout(r, 30));
  }

  const ROLES_SIN_COSTO = ['student', 'admin', 'jefe', 'preceptor', 'directivo', 'soe'];

  test('CA-25: para roles que no son teacher, 0 llamadas al modelo, tanto con render como con json', async () => {
    for (const role of ROLES_SIN_COSTO) {
      const modelo = fakeSection();
      const mw = marcarDocenteJefe(modelo);
      const { req, res } = fakeReqRes({ _id: 'u1', role, school: 'E' });
      let calledNext = false;
      mw(req, res, () => { calledNext = true; });
      assert.strictEqual(calledNext, true, `${role}: next() debería llamarse enseguida`);
      assert.strictEqual(res.locals.esJefeDeSeccion, false, `${role}: esJefeDeSeccion arranca en false`);

      await esperarRender(() => res.render('cualquier-vista', {}));
      res.json({ ok: true });
      assert.strictEqual(modelo.llamadas.length, 0, `${role}: no debería consultar el modelo`);
    }
  });

  test('CA-26: teacher con escuela, pero la ruta responde JSON/redirect/send → 0 llamadas', async () => {
    const modelo = fakeSection();
    const mw = marcarDocenteJefe(modelo);
    const { req, res } = fakeReqRes({ _id: 'u2', role: 'teacher', school: 'E' });
    mw(req, res, () => {});

    res.json({ ok: true });
    res.redirect('/courses');
    res.send('hola');
    assert.strictEqual(modelo.llamadas.length, 0, 'el poll de la sala y cualquier JSON no deberían pagar la consulta');
  });

  test('CA-27: teacher con escuela y res.render → exactamente 1 llamada, con el filtro correcto, y la vista recibe esJefeDeSeccion', async () => {
    const modelo = fakeSection({ resultado: true });
    const mw = marcarDocenteJefe(modelo);
    const user = { _id: 'u3', role: 'teacher', school: 'E' };
    const { req, res, renders } = fakeReqRes(user);
    mw(req, res, () => {});

    await esperarRender(() => res.render('jefatura/vista', { otraCosa: 1 }));

    assert.strictEqual(modelo.llamadas.length, 1);
    assert.deepStrictEqual(modelo.llamadas[0], { school: 'E', heads: 'u3' });
    const vista = renders.find(r => r.view === 'jefatura/vista');
    assert.ok(vista, 'el render original debería haberse llamado');
    assert.strictEqual(vista.locals.esJefeDeSeccion, true);
    assert.strictEqual(vista.locals.otraCosa, 1, 'los argumentos originales llegan intactos');
  });

  test('CA-27b: cuando el modelo dice que NO está a cargo de nada, la vista recibe esJefeDeSeccion=false', async () => {
    const modelo = fakeSection({ resultado: false });
    const mw = marcarDocenteJefe(modelo);
    const { req, res, renders } = fakeReqRes({ _id: 'u4', role: 'teacher', school: 'E' });
    mw(req, res, () => {});
    await esperarRender(() => res.render('vista', {}));
    assert.strictEqual(renders[0].locals.esJefeDeSeccion, false);
  });

  test('CA-28: si un guard ya llamó a pertenenciaJefatura en el mismo request, el total sigue siendo 1', async () => {
    const modelo = fakeSection({ resultado: true });
    const user = { _id: 'u5', role: 'teacher', school: 'E' };
    const { req, res, renders } = fakeReqRes(user);

    // El guard (p.ej. requireAccesoSecciones) resuelve el memo primero.
    const yaEsJefe = await pertenenciaJefatura(req, res, modelo);
    assert.strictEqual(yaEsJefe, true);
    assert.strictEqual(modelo.llamadas.length, 1);

    // Después el middleware global envuelve el render. No debería volver a consultar.
    const mw = marcarDocenteJefe(modelo);
    mw(req, res, () => {});
    await esperarRender(() => res.render('vista', {}));

    assert.strictEqual(modelo.llamadas.length, 1, 'el memo por request se comparte entre el guard y el menú');
    assert.strictEqual(renders.find(r => r.view === 'vista').locals.esJefeDeSeccion, true);
  });

  test('CA-29: si la consulta del modelo falla, la vista igual se renderiza con esJefeDeSeccion=false y no hay error', async () => {
    const modelo = fakeSection({ falla: true });
    const mw = marcarDocenteJefe(modelo);
    const { req, res, renders } = fakeReqRes({ _id: 'u6', role: 'teacher', school: 'E' });
    // El middleware llama a next() UNA vez, de entrada, para dejar pasar a la ruta —eso es
    // lo normal y se espera exactamente una vez, sin error—. Lo que CA-29 prohíbe es que la
    // falla POSTERIOR del render dispare una SEGUNDA llamada a next(), esta vez con un error.
    const llamadasANext = [];
    mw(req, res, (err) => { llamadasANext.push(err); });

    await assert.doesNotReject(async () => {
      await esperarRender(() => res.render('vista', { y: 2 }));
    }, 'una falla del modelo no debería propagarse como excepción (RN-16, falla cerrada)');

    const vista = renders.find(r => r.view === 'vista');
    assert.ok(vista, 'el render original tiene que llamarse UNA vez igual');
    assert.strictEqual(vista.locals.esJefeDeSeccion, false);
    assert.strictEqual(vista.locals.y, 2);
    assert.strictEqual(llamadasANext.length, 1, 'next() no debería volver a llamarse cuando falla el render (ya se pasó a la ruta)');
    assert.strictEqual(llamadasANext[0], undefined, 'la única llamada a next() no debería traer un error');
  });

  test('el render original se llama UNA sola vez, nunca dos', async () => {
    const modelo = fakeSection({ resultado: true });
    const mw = marcarDocenteJefe(modelo);
    const { req, res, renders } = fakeReqRes({ _id: 'u7', role: 'teacher', school: 'E' });
    mw(req, res, () => {});
    await esperarRender(() => res.render('vista-unica', {}));
    assert.strictEqual(renders.filter(r => r.view === 'vista-unica').length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. loadJefaturaScope con un teacher sin secciones — CA-11
// ═════════════════════════════════════════════════════════════════════════
//
// A diferencia del bloque de arriba, loadJefaturaScope (según § Entidades/Schemas) NO
// declara un parámetro inyectable para el modelo: usa el Section real de
// middleware/jefatura.js. Se lo reemplaza acá monkey-patcheando `Section.find`, sin abrir
// conexión a Mongo — es lo mismo que ya prueba este archivo para exists() en el bloque D,
// aplicado a la otra query. `logRechazo` se espía reemplazando la función exportada por
// middleware/route-log ANTES del primer require de middleware/jefatura.js: como éste hace
// `const { logRechazo } = require('../middleware/route-log')`, la sustitución tiene que
// pasar antes de esa desestructuración para que la referencia capturada sea la espiada.

describe('loadJefaturaScope — CA-11', () => {
  test('un teacher sin ninguna sección a cargo responde 403 y queda logueado como "docente sin secciones a cargo"', async () => {
    // Se limpia cualquier caché previa de estos dos módulos para garantizar que el patch de
    // logRechazo se aplique ANTES de que middleware/jefatura.js la desestructure.
    const routeLogPath = require.resolve('../../middleware/route-log');
    const jefaturaPath = require.resolve('../../middleware/jefatura');
    delete require.cache[routeLogPath];
    delete require.cache[jefaturaPath];

    const routeLog = require('../../middleware/route-log');
    const llamadas = [];
    const logRechazoOriginal = routeLog.logRechazo;
    routeLog.logRechazo = (res, status, motivo, contexto) => llamadas.push({ status, motivo, contexto });

    let jefatura;
    try {
      jefatura = require('../../middleware/jefatura');

      const SectionReal = require('../../models/Section');
      const findOriginal = SectionReal.find;
      // Mismo encadenado que usa el middleware hoy: find().select().sort().lean()
      SectionReal.find = () => ({
        select: () => ({ sort: () => ({ lean: async () => [] }) }),
      });

      try {
        const req = {};
        const respuestas = [];
        const res = {
          locals: { user: { _id: 'docenteSolo', role: 'teacher', school: 'E' } },
          status(code) { respuestas.push({ status: code }); return this; },
          send(body)   { respuestas.push({ send: body }); return this; },
        };
        let nextLlamado = false;
        await jefatura.loadJefaturaScope(req, res, () => { nextLlamado = true; });

        assert.strictEqual(nextLlamado, false, 'un teacher sin secciones NO debería dejar pasar a la ruta (RN-05)');
        assert.strictEqual(respuestas[0]?.status, 403);
        assert.strictEqual(llamadas.length, 1, 'logRechazo debería llamarse una vez');
        assert.strictEqual(llamadas[0].status, 403);
        assert.strictEqual(llamadas[0].motivo, 'docente sin secciones a cargo');
      } finally {
        SectionReal.find = findOriginal;
      }
    } finally {
      routeLog.logRechazo = logRechazoOriginal;
      delete require.cache[jefaturaPath];
    }
  });

  test('un jefe (rol) sin secciones SIGUE dejando pasar a next() — no es la misma regla (CA-12)', async () => {
    const jefaturaPath = require.resolve('../../middleware/jefatura');
    delete require.cache[jefaturaPath];
    const jefatura = require('../../middleware/jefatura');

    const SectionReal = require('../../models/Section');
    const findOriginal = SectionReal.find;
    SectionReal.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });

    try {
      const req = {};
      const res = { locals: { user: { _id: 'jefeSinNada', role: 'jefe', school: 'E' } } };
      let nextLlamado = false;
      await jefatura.loadJefaturaScope(req, res, () => { nextLlamado = true; });
      assert.strictEqual(nextLlamado, true, 'el jefe sin sección sigue viendo la pantalla "Todavía no tenés secciones a cargo", no un 403');
    } finally {
      SectionReal.find = findOriginal;
      delete require.cache[jefaturaPath];
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F. La guarda del catálogo — CA-52
// ═════════════════════════════════════════════════════════════════════════

describe('CA-52: config/sections.js y el servicio no pueden desincronizarse', () => {
  test('teacher está en roles de jefe_dashboard, jefe_teachers y admin_sections', () => {
    for (const key of ['jefe_dashboard', 'jefe_teachers', 'admin_sections']) {
      const sec = SECTIONS.find(s => s.key === key);
      assert.ok(sec, `${key} debería existir en config/sections.js`);
      assert.ok(sec.roles.includes('teacher'), `${key}.roles debería incluir 'teacher' — hoy tiene [${sec.roles}]`);
    }
  });

  test('ROLES_JEFATURA_POR_SECCION es exactamente ["teacher"]: si alguien cambia uno sin el otro, esto falla', () => {
    assert.deepStrictEqual(ROLES_JEFATURA_POR_SECCION, ['teacher']);
  });

  test('jefe_dashboard sigue locked (no se puede denegar desde /superadmin/roles)', () => {
    const sec = SECTIONS.find(s => s.key === 'jefe_dashboard');
    assert.strictEqual(sec.locked, true);
  });

  test('ROLES_ELEGIBLES_JEFE es exactamente ["jefe", "teacher"] (DA-3, RN-19)', () => {
    assert.deepStrictEqual([...ROLES_ELEGIBLES_JEFE].sort(), ['jefe', 'teacher']);
  });
});
