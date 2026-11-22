// Tests del horario del curso (fase 3 del panel de la Secretaria).
// Correr con: npm run test:unit
//
// Cubren CH-01 a CH-13 de specs/secretaria-horario-del-curso.spec.md. La grilla es la de la
// Escuela 4118 (PRESET_4118): mañana 1ª 08:00–08:40, 2ª 08:40–09:20, 3ª 09:30–10:10 …

const { test, describe } = require('node:test');
const assert = require('node:assert');

const H = require('../../services/secretariaHorarioCurso');
const { PRESET_4118 } = require('../../services/recursos/horario');

const GRILLA = PRESET_4118();
const MIERCOLES = '2026-11-11';
const ar = (hhmm, dia = '11') => new Date(`2026-11-${dia}T${hhmm}:00-03:00`);
const e = (dia, orden, turno = 'manana') => ({ dia, turno, orden });

const naturales = { id: 'c1', name: 'Ciencias Naturales', horarioClases: [e(1, 1), e(1, 2)], docentes: [{ id: 'u1', name: 'Pérez Silvia' }] };
const lengua    = { id: 'c2', name: 'Lengua', horarioClases: [e(5, 1), e(1, 99)], docentes: [{ id: 'u2', name: 'Carrizo Sandra' }] };

describe('la grilla (CH-01 a CH-03)', () => {
  test('CH-01 · cada materia va a su día y módulo, con sus docentes en mayúsculas', () => {
    const g = H.grillaDelCurso({ grilla: GRILLA, materias: [naturales, lengua] });
    const man = g.turnos.find(t => t.id === 'manana');
    const c = man.modulos.find(m => m.orden === 1).celdas[1];
    assert.strictEqual(c.materias.length, 1);
    assert.strictEqual(c.materias[0].materia, 'Ciencias Naturales');
    assert.deepStrictEqual(c.materias[0].docentes.map(d => d.name), ['PÉREZ SILVIA']);
    assert.strictEqual(man.modulos.find(m => m.orden === 1).celdas[5].materias[0].materia, 'Lengua');
    assert.deepStrictEqual(g.dias, [1, 2, 3, 4, 5]);
  });

  test('CH-02 · dos materias en la misma celda → las dos, marcada doble', () => {
    const otra = { id: 'c3', name: 'Taller', horarioClases: [e(1, 1)], docentes: [] };
    const g = H.grillaDelCurso({ grilla: GRILLA, materias: [naturales, otra] });
    const c = g.turnos[0].modulos.find(m => m.orden === 1).celdas[1];
    assert.strictEqual(c.materias.length, 2);
    assert.strictEqual(c.doble, true);
  });

  test('CH-03 · un módulo que ya no existe no aparece en ninguna celda', () => {
    const g = H.grillaDelCurso({ grilla: GRILLA, materias: [lengua] });
    const total = g.turnos.flatMap(t => t.modulos).flatMap(m => Object.values(m.celdas)).reduce((n, c) => n + c.materias.length, 0);
    assert.strictEqual(total, 1);
  });

  test('sin grilla de la escuela → null', () => {
    assert.strictEqual(H.grillaDelCurso({ grilla: null, materias: [naturales] }), null);
  });

  test('los recreos no son filas (RH-01)', () => {
    const g = H.grillaDelCurso({ grilla: GRILLA, materias: [] });
    assert.ok(g.turnos.every(t => t.modulos.every(m => !/recreo/i.test(m.label))));
  });
});

describe('choques (CH-04, CH-05)', () => {
  const g = () => H.grillaDelCurso({ grilla: GRILLA, materias: [naturales] });

  test('CH-04 · el mismo docente en otra materia, mismo día y módulo → choque', () => {
    const r = H.choques({ grillaCurso: g(), otras: [
      { docenteId: 'u1', materiaId: 'c9', materia: 'Biología', curso: '2° 1°', enAlcance: true, horarioClases: [e(1, 2)] },
    ] });
    assert.deepStrictEqual(r.get('1|manana|2'), ['PÉREZ SILVIA tiene clase en Biología en 2° 1° a esta hora']);
    assert.strictEqual(r.has('1|manana|1'), false);
  });

  test('CH-04 · en otro módulo no hay choque', () => {
    const r = H.choques({ grillaCurso: g(), otras: [
      { docenteId: 'u1', materiaId: 'c9', materia: 'Biología', curso: '2° 1°', enAlcance: true, horarioClases: [e(1, 4)] },
    ] });
    assert.strictEqual(r.size, 0);
  });

  test('la misma materia no choca consigo misma', () => {
    const r = H.choques({ grillaCurso: g(), otras: [
      { docenteId: 'u1', materiaId: 'c1', materia: 'Ciencias Naturales', curso: '1° 1°', enAlcance: true, horarioClases: [e(1, 1)] },
    ] });
    assert.strictEqual(r.size, 0);
  });

  test('CH-05 · un curso fuera del alcance no se nombra', () => {
    const r = H.choques({ grillaCurso: g(), otras: [
      { docenteId: 'u1', materiaId: 'c9', materia: 'SECRETA', curso: 'CURSO AJENO', enAlcance: false, horarioClases: [e(1, 1)] },
    ] });
    const txt = r.get('1|manana|1')[0];
    assert.ok(!txt.includes('SECRETA') && !txt.includes('CURSO AJENO'), txt);
    assert.match(txt, /otro curso/);
  });
});

describe('control por clase (CH-06 a CH-11)', () => {
  const clase1 = { materiaId: 'c1', desde: '08:00', hasta: '08:40' };
  const clase5 = { materiaId: 'c1', desde: '11:00', hasta: '11:40' };
  const base = { fecha: MIERCOLES };

  test('CH-06 · la primera clase usa la llegada del día', () => {
    const llegada = H.llegadaDelDia({ fecha: MIERCOLES, ingreso: { primeraVez: ar('08:05') } });
    const r = H.puntualidadDeClase({ ...base, clase: clase1, esPrimera: true, llegada });
    assert.strictEqual(r.estado, 'aTiempo');
    assert.strictEqual(r.texto, 'Llegó 08:05');
    const tarde = H.puntualidadDeClase({ ...base, clase: clase1, esPrimera: true, llegada: 8 * 60 + 25 });
    assert.strictEqual(tarde.texto, 'Llegó 08:25 · 25 min tarde');
  });

  test('CH-07 · clase siguiente con sala de esa materia: 5 min → a tiempo, 15 → tarde', () => {
    const ok = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false, llegada: 480,
      presencias: [{ course: 'c1', firstSeenAt: ar('11:05') }] });
    assert.strictEqual(ok.estado, 'aTiempo');
    assert.strictEqual(ok.texto, 'Sala 11:05');
    const t = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false, llegada: 480,
      presencias: [{ course: 'c1', firstSeenAt: ar('11:15') }] });
    assert.strictEqual(t.estado, 'tarde');
  });

  test('CH-08 · clase siguiente sin sala, aunque haya entrado a la plataforma → sinDato', () => {
    const r = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false, llegada: 7 * 60 + 50, presencias: [] });
    assert.strictEqual(r.estado, 'sinDato');
  });

  test('CH-09 · la sala de OTRA materia no cuenta', () => {
    const r = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false,
      presencias: [{ course: 'c7', firstSeenAt: ar('11:01') }] });
    assert.strictEqual(r.estado, 'sinDato');
  });

  test('CH-10 · ventana: 40 min antes no cuenta, 25 min antes sí (a tiempo)', () => {
    const lejos = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false,
      presencias: [{ course: 'c1', firstSeenAt: ar('10:20') }] });
    assert.strictEqual(lejos.estado, 'sinDato');
    const cerca = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false,
      presencias: [{ course: 'c1', firstSeenAt: ar('10:35') }] });
    assert.strictEqual(cerca.estado, 'aTiempo');
  });

  test('CH-10 · la sala de otro día no cuenta', () => {
    const r = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false,
      presencias: [{ course: 'c1', firstSeenAt: ar('11:05', '10') }] });
    assert.strictEqual(r.estado, 'sinDato');
  });

  test('CH-11 · un módulo que todavía no empezó → futura', () => {
    const r = H.puntualidadDeClase({ ...base, clase: clase5, esPrimera: false, esHoy: true, ahoraMin: 10 * 60 });
    assert.strictEqual(r.estado, 'futura');
  });

  test('primer inicio del día entre todas las materias del docente', () => {
    const ini = H.primerInicioDelDia({ fecha: MIERCOLES, grilla: GRILLA,
      materiasDelDocente: [{ horarioClases: [e(3, 5)] }, { horarioClases: [e(3, 3), e(1, 1)] }] });
    assert.strictEqual(ini, 9 * 60 + 30);   // 3ª hora del miércoles; la del lunes no cuenta
  });

  test('llegada del día: lo primero entre plataforma y sala; sin dato de ingreso, solo la sala', () => {
    const args = { fecha: MIERCOLES, ingreso: { primeraVez: ar('07:40') }, presencias: [{ firstSeenAt: ar('07:55') }] };
    assert.strictEqual(H.llegadaDelDia(args), 7 * 60 + 40);
    assert.strictEqual(H.llegadaDelDia({ ...args, hayDatoIngreso: false }), 7 * 60 + 55);
    assert.strictEqual(H.llegadaDelDia({ fecha: MIERCOLES }), null);
  });

  test('el mejor estado gana cuando hay dos docentes', () => {
    assert.strictEqual(H.mejorEstado(['sinDato', 'tarde']), 'tarde');
    assert.strictEqual(H.mejorEstado(['tarde', 'aTiempo']), 'aTiempo');
  });
});

describe('carga desde la grilla (CH-12)', () => {
  const mats = () => [
    { id: 'c1', horarioClases: [e(1, 1), e(1, 2)] },
    { id: 'c2', horarioClases: [e(5, 1)] },
  ];

  test('reemplaza: saca la celda de la anterior y la pone en la nueva', () => {
    const r = H.aplicarCelda(mats(), e(1, 1), 'c2');
    assert.deepStrictEqual(r, [
      { id: 'c1', horarioClases: [e(1, 2)] },
      { id: 'c2', horarioClases: [e(1, 1), e(5, 1)] },
    ]);
  });

  test('null vacía la celda', () => {
    assert.deepStrictEqual(H.aplicarCelda(mats(), e(1, 2), null), [{ id: 'c1', horarioClases: [e(1, 1)] }]);
  });

  test('poner lo que ya está no cambia nada', () => {
    assert.deepStrictEqual(H.aplicarCelda(mats(), e(1, 1), 'c1'), []);
  });

  test('una celda vacía nueva solo toca la materia elegida', () => {
    assert.deepStrictEqual(H.aplicarCelda(mats(), e(2, 3), 'c2'), [{ id: 'c2', horarioClases: [e(2, 3), e(5, 1)] }]);
  });
});

describe('textos (CH-13)', () => {
  test('ningún texto dice "faltó"', () => {
    const clase = { materiaId: 'c1', desde: '11:00', hasta: '11:40' };
    for (const r of [
      H.puntualidadDeClase({ fecha: MIERCOLES, clase, esPrimera: false }),
      H.puntualidadDeClase({ fecha: MIERCOLES, clase, esPrimera: false, esHoy: true, ahoraMin: 0 }),
    ]) assert.ok(!/falt|ausen/i.test(r.texto), r.texto);
  });
});
