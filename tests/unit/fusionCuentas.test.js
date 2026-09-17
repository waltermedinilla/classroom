// Quién se conserva, quién se deshabilita y qué puede resolver el botón masivo.
// Correr con: npm run test:unit
//
// Esta es la decisión de la fusión de cuentas duplicadas, sacada de services/dbFixes.js para
// poder probarla sin base de datos. Ahí adentro estaba enterrada entre dos barridos de Mongo
// y 419 materias, así que la única forma de probarla era un smoke test con fixtures.
//
// Los casos de abajo NO son inventados: son las cuatro formas que aparecen en producción,
// medidas el 2026-09-12 sobre una copia real (59 grupos con el mismo DNI en la misma escuela).
// Ver specs/fusion-de-cuentas.spec.md.
//
//   41 de 52 pares de alumnos → una cuenta con todo, la otra SIN NADA y sin materias
//   14 de esas 41 sobrantes   → alguien las usó (tienen lastSeen): no se tocan sin avisar
//    3 de 52                  → las dos con trabajo propio: las mira una persona
//
// Criterios de aceptación cubiertos: CA-04, CA-04b (el motivo), CA-05 y CA-05b.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  normalizarDni, claveDeGrupo, clasificarGrupo, MOTIVOS,
} = require('../../services/fusionCuentas');

// Atajo para no repetir la forma completa en cada caso.
function cuenta(id, extra = {}) {
  const { entregas = 0, notas = 0, aperturas = 0, asistencias = 0, sala = 0, comentarios = 0 } = extra;
  return {
    id,
    activa: extra.activa !== false,
    lastSeen: extra.lastSeen || null,
    createdAt: extra.createdAt || new Date('2026-03-01'),
    materias: extra.materias || 0,
    divisiones: extra.divisiones || [],
    trabajo: { entregas, notas, aperturas, asistencias, sala, comentarios },
  };
}

describe('normalizarDni — comparar dos DNI escritos distinto', () => {
  test('los puntos y los ceros a la izquierda no cuentan', () => {
    // Es el motivo por el que el índice único { school, dni } NUNCA frenó estos duplicados:
    // compara el string crudo, así que "12.345.678" y "12345678" conviven sin que Mongo chille.
    assert.strictEqual(normalizarDni('12.345.678'), '12345678');
    assert.strictEqual(normalizarDni('012345678'), '12345678');
    assert.strictEqual(normalizarDni(' 12 345 678 '), '12345678');
    assert.strictEqual(normalizarDni(12345678), '12345678');
  });

  test('sin DNI no hay con qué comparar', () => {
    // No es lo mismo que "DNI 0": son las cuentas del arreglo 'usuarios-sin-dni', y meterlas
    // en un grupo las fusionaría entre desconocidos.
    for (const v of [null, undefined, '', '   ', 'sin datos', '0', '000']) {
      assert.strictEqual(normalizarDni(v), '', `"${v}" no debería dar un DNI comparable`);
    }
  });
});

describe('claveDeGrupo — agrupar por escuela + DNI, no por división (RN-01, CA-01)', () => {
  test('la misma persona en la misma escuela da la misma clave, cursen donde cursen', () => {
    // ESTE es el cambio de la Fase 1. Antes la clave llevaba la división y las dos cuentas
    // tenían que estar en materias de la MISMA, así que los 41 casos donde la sobrante no
    // tiene ninguna materia no se veían.
    const a = claveDeGrupo({ schoolId: 'esc1', dni: '12.345.678' });
    const b = claveDeGrupo({ schoolId: 'esc1', dni: '12345678' });
    assert.strictEqual(a, b);
  });

  test('la misma persona en DOS escuelas no se agrupa', () => {
    // Un docente puede trabajar legítimamente en dos escuelas.
    assert.notStrictEqual(
      claveDeGrupo({ schoolId: 'esc1', dni: '12345678' }),
      claveDeGrupo({ schoolId: 'esc2', dni: '12345678' }),
    );
  });
});

describe('clasificarGrupo — el caso limpio, que son 41 de 52 (CA-04)', () => {
  // La forma real: MAYÚSCULAS con el correo de la familia, del padrón, nunca se matriculó;
  // minúsculas con el gmail del chico, que es la que se usa.
  const llena = cuenta('real', { materias: 15, divisiones: ['d1'], entregas: 17, notas: 6, aperturas: 40, asistencias: 11, sala: 720 });
  const vacia = cuenta('padron');

  test('se conserva la que tiene el trabajo hecho', () => {
    const r = clasificarGrupo([vacia, llena]);
    assert.strictEqual(r.sugeridaId, 'real');
    assert.strictEqual(r.ambigua, false);
  });

  test('el orden no cambia la decisión', () => {
    // Si el resultado dependiera del orden en que Mongo devolvió los documentos, la pantalla
    // sugeriría una cuenta distinta en cada recarga.
    assert.strictEqual(clasificarGrupo([llena, vacia]).sugeridaId, 'real');
    assert.strictEqual(clasificarGrupo([vacia, llena]).sugeridaId, 'real');
  });

  test('el botón masivo puede resolverlo, y deshabilita la vacía', () => {
    const r = clasificarGrupo([vacia, llena]);
    assert.strictEqual(r.masiva.elegible, true, `debería ser resoluble — motivo: ${r.masiva.motivo}`);
    assert.strictEqual(r.masiva.keepId, 'real');
    assert.deepStrictEqual(r.masiva.deshabilitar, ['padron']);
  });

  test('la acción es deshabilitar y NUNCA eliminar (RN-12)', () => {
    // Decisión del usuario del 2026-09-12. El campo se llama `deshabilitar` justamente para
    // que no exista la pregunta: no hay ninguna rama que borre una cuenta.
    const r = clasificarGrupo([vacia, llena]);
    assert.ok(!('eliminar' in r.masiva), 'la resolución automática no puede ofrecer eliminar');
  });

  test('una cuenta ya deshabilitada no vuelve a contarse como trabajo pendiente', () => {
    // 4 de las 41 sobrantes ya están deshabilitadas: el grupo está resuelto y no tiene que
    // seguir apareciendo para siempre, igual que hace el arreglo de docentes.
    const r = clasificarGrupo([cuenta('padron', { activa: false }), llena]);
    assert.strictEqual(r.masiva.elegible, false);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.YA_RESUELTO);
  });
});

describe('clasificarGrupo — las 14 que alguien usó (RN-13, CA-04b)', () => {
  const llena = cuenta('real', { materias: 14, divisiones: ['d1'], entregas: 13, asistencias: 15, sala: 197 });
  // Vacía pero con conexión: entró, y no vio nada, porque no tiene materias.
  const usada = cuenta('padron', { lastSeen: new Date('2026-08-31') });

  test('sin aviso disponible, el botón masivo NO las toca', () => {
    const r = clasificarGrupo([usada, llena]);
    assert.strictEqual(r.masiva.elegible, false);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.NECESITA_AVISO);
  });

  test('con el aviso disponible sí entran (Fase 1b)', () => {
    const r = clasificarGrupo([usada, llena], { avisoDisponible: true });
    assert.strictEqual(r.masiva.elegible, true, `motivo: ${r.masiva.motivo}`);
    assert.deepStrictEqual(r.masiva.deshabilitar, ['padron']);
  });

  test('el aviso hay que mandarlo a la cuenta que se conserva, y el grupo lo dice', () => {
    const r = clasificarGrupo([usada, llena], { avisoDisponible: true });
    assert.deepStrictEqual(r.masiva.avisar, [{ paraId: 'real', porqueSeDeshabilito: 'padron' }],
      'el aviso va a la cuenta buena: es la única a la que la persona va a poder entrar');
  });

  test('una sobrante sin conexión no genera aviso', () => {
    // Son 27 de las 41: nadie las usó nunca, no hay a quién avisarle nada.
    const r = clasificarGrupo([cuenta('padron'), llena], { avisoDisponible: true });
    assert.deepStrictEqual(r.masiva.avisar, []);
  });

  // Hallado por la revisión de la Fase 1b (2026-09-17), en un grupo de TRES cuentas: la real, una
  // que alguien usó pero que ya estaba apagada de antes, y una del padrón que nadie usó. El botón
  // apaga solo la del padrón, pero el aviso salía por la otra: un mensaje que decía "quedó
  // deshabilitada" nombrando una cuenta que este botón no tocó, y ningún aviso sobre la que sí.
  // El aviso es por la cuenta que se VA A APAGAR, no por cualquier sobrante que se haya usado.
  const yaApagadaUsada = cuenta('apagada-antes', { activa: false, lastSeen: new Date('2026-07-01') });

  test('grupo de 3: una sobrante usada que YA estaba apagada no genera aviso', () => {
    const r = clasificarGrupo([yaApagadaUsada, cuenta('padron'), llena], { avisoDisponible: true });
    assert.strictEqual(r.masiva.elegible, true, `motivo: ${r.masiva.motivo}`);
    assert.deepStrictEqual(r.masiva.deshabilitar, ['padron']);
    assert.deepStrictEqual(r.masiva.avisar, [],
      'el aviso nombraría una cuenta que este botón no apaga');
  });

  test('grupo de 3: si la que se apaga es la usada, el aviso es por ESA', () => {
    const r = clasificarGrupo([yaApagadaUsada, usada, llena], { avisoDisponible: true });
    assert.deepStrictEqual(r.masiva.deshabilitar, ['padron']);
    assert.deepStrictEqual(r.masiva.avisar, [{ paraId: 'real', porqueSeDeshabilito: 'padron' }]);
  });

  test('sin aviso disponible, una sobrante usada pero YA apagada no frena el botón', () => {
    // Lo que se apaga ahora nadie lo usó: no hay a quién dejar afuera sin avisar.
    const r = clasificarGrupo([yaApagadaUsada, cuenta('padron'), llena]);
    assert.strictEqual(r.masiva.elegible, true, `motivo: ${r.masiva.motivo}`);
  });
});

describe('clasificarGrupo — los grupos que mira una persona (RN-14, CA-05b)', () => {
  test('las dos con trabajo propio: disputada, y fuera del botón masivo', () => {
    // El caso real del DNI 52297641: 14 materias cada una, 6 entregas contra 9. No hay forma
    // de deducir cuál se conserva sin mirar el contenido.
    const a = cuenta('a', { materias: 14, divisiones: ['d1'], entregas: 6, aperturas: 22, sala: 83 });
    const b = cuenta('b', { materias: 14, divisiones: ['d1'], entregas: 9, notas: 4, aperturas: 21, sala: 47 });
    const r = clasificarGrupo([a, b]);
    assert.strictEqual(r.ambigua, true);
    assert.strictEqual(r.masiva.elegible, false);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.DISPUTADA);
  });

  test('una sola apertura suelta NO convierte el caso limpio en disputado', () => {
    // 8 de los 11 grupos "con trabajo en las dos" tienen 1 o 2 registros sueltos en la
    // segunda cuenta: abrió una tarea una vez. Tratarlos como disputados mandaría a revisión
    // manual 8 casos que no tienen nada que decidir.
    const llena = cuenta('real', { materias: 15, divisiones: ['d1'], entregas: 1, aperturas: 23, asistencias: 10, sala: 12 });
    const casiVacia = cuenta('padron', { aperturas: 2, asistencias: 1, sala: 1 });
    const r = clasificarGrupo([llena, casiVacia]);
    assert.strictEqual(r.ambigua, false, 'dos aperturas y una falta no son "trabajo propio"');
    assert.strictEqual(r.masiva.elegible, true, `motivo: ${r.masiva.motivo}`);
    assert.strictEqual(r.masiva.keepId, 'real');
  });

  test('una entrega o una nota SÍ lo vuelven disputado, siempre', () => {
    // Acá no hay umbral: una entrega es trabajo de una persona y no se decide sola.
    const llena = cuenta('real', { materias: 15, divisiones: ['d1'], entregas: 9, aperturas: 30 });
    const conUna = cuenta('otra', { materias: 15, divisiones: ['d1'], entregas: 1 });
    const r = clasificarGrupo([llena, conUna]);
    assert.strictEqual(r.ambigua, true);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.DISPUTADA);
  });
});

describe('clasificarGrupo — la sobrante que cursa en otro lado (CA-05)', () => {
  test('si la sobrante tiene materias, no la toca el botón masivo', () => {
    // Deshabilitarla le saca el acceso a un curso donde sí está cursando, y eso no se ve
    // mirando solo el duplicado.
    const llena = cuenta('real', { materias: 15, divisiones: ['d1'], entregas: 10, asistencias: 12 });
    const otraDiv = cuenta('otra', { materias: 13, divisiones: ['d2'] });
    const r = clasificarGrupo([llena, otraDiv]);
    assert.strictEqual(r.masiva.elegible, false);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.SOBRANTE_CURSA);
  });

  test('la conservada puede cursar en dos divisiones sin bloquear nada', () => {
    // Es al revés: que la cuenta BUENA figure en dos divisiones es un problema aparte
    // ('alumnos-en-varios-cursos'), no un impedimento para sacar de encima al duplicado.
    const llena = cuenta('real', { materias: 28, divisiones: ['d1', 'd2'], entregas: 10 });
    const r = clasificarGrupo([llena, cuenta('padron')]);
    assert.strictEqual(r.masiva.elegible, true, `motivo: ${r.masiva.motivo}`);
  });
});

describe('clasificarGrupo — bordes', () => {
  test('ninguna con datos: no hay nada que deducir', () => {
    const r = clasificarGrupo([cuenta('a', { materias: 3 }), cuenta('b', { materias: 3 })]);
    assert.strictEqual(r.masiva.elegible, false);
    assert.strictEqual(r.masiva.motivo, MOTIVOS.SIN_DATOS);
  });

  test('tres cuentas con el mismo DNI: se conserva una y se deshabilitan las otras dos', () => {
    const llena = cuenta('real', { materias: 15, divisiones: ['d1'], entregas: 8 });
    const r = clasificarGrupo([cuenta('x'), llena, cuenta('y')]);
    assert.strictEqual(r.masiva.keepId, 'real');
    assert.deepStrictEqual(r.masiva.deshabilitar.slice().sort(), ['x', 'y']);
  });

  test('una sola cuenta no es un grupo', () => {
    assert.throws(() => clasificarGrupo([cuenta('sola')]), /dos/i,
      'clasificar un grupo de una sola cuenta es un error de programación, no un caso');
  });

  test('el orden devuelto pone primero a la que se conserva', () => {
    // Es el orden con el que la pantalla pinta las opciones, y la primera va preseleccionada.
    const llena = cuenta('real', { materias: 15, entregas: 8 });
    const r = clasificarGrupo([cuenta('padron'), llena]);
    assert.strictEqual(r.orden[0], 'real');
  });
});
