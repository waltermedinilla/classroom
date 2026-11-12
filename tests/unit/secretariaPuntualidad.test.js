// Tests de la puntualidad del docente (fase 2 del panel de la Secretaria).
// Correr con: npm run test:unit
//
// Cubren CP-01 a CP-11 de specs/secretaria-puntualidad.spec.md. La grilla es la de la Escuela
// 4118 (PRESET_4118): turno mañana desde 08:00, 1ª hora 08:00, 2ª 08:40, 3ª 09:30, 4ª 10:10.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const P = require('../../services/secretariaPuntualidad');
const S = require('../../services/secretariaDia');
const { PRESET_4118 } = require('../../services/recursos/horario');

const GRILLA = PRESET_4118();
const MIERCOLES = '2026-11-11';   // día 3
const ar = (hhmm, dia = '11') => new Date(`2026-11-${dia}T${hhmm}:00-03:00`);

// Materia con clase el miércoles en la mañana, en el módulo `orden`.
const materia = (orden, dia = 3, nombre = 'Matemática') =>
  ({ id: `c${orden}`, name: nombre, horarioClases: [{ dia, turno: 'manana', orden }] });

// Las señales como las arma secretariaDia, a partir de un ingreso y/o una sala.
const senales = ({ ingreso = null, sala = null, fecha = MIERCOLES } = {}) => S.senalesDelDocente({
  fecha, cursosAlcance: ['c1'],
  ingreso: ingreso ? { fecha, primeraVez: ingreso, ultimaVez: ingreso } : null,
  presencias: sala ? [{ course: 'c1', firstSeenAt: sala, lastPingAt: sala, msPresente: 60000 }] : [],
});

const evaluar = (opts) => P.puntualidad({ fecha: MIERCOLES, grilla: GRILLA, ...opts });

describe('días y validación de la carga', () => {
  test('diaSemana: 11/11/2026 es miércoles (3); un domingo es 7', () => {
    assert.strictEqual(P.diaSemana('2026-11-11'), 3);
    assert.strictEqual(P.diaSemana('2026-11-15'), 7);
    assert.strictEqual(P.diaSemana('2026-11-16'), 1);
  });

  test('RP-01 · un módulo que no existe en la grilla da error', () => {
    const r = P.validarHorarioClases([{ dia: 1, turno: 'manana', orden: 99 }], GRILLA);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /módulo no existe/);
  });

  test('RP-01 · un día fuera de la grilla (sábado) da error', () => {
    const r = P.validarHorarioClases([{ dia: 6, turno: 'manana', orden: 1 }], GRILLA);
    assert.strictEqual(r.ok, false);
  });

  test('RP-01 · un turno inventado da error', () => {
    assert.strictEqual(P.validarHorarioClases([{ dia: 1, turno: 'noche', orden: 1 }], GRILLA).ok, false);
  });

  test('RP-02 · los duplicados se descartan y el resultado sale ordenado', () => {
    const r = P.validarHorarioClases([
      { dia: 4, turno: 'manana', orden: 3 },
      { dia: 1, turno: 'manana', orden: 2 },
      { dia: 1, turno: 'manana', orden: 2 },
    ], GRILLA);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.entradas, [
      { dia: 1, turno: 'manana', orden: 2 },
      { dia: 4, turno: 'manana', orden: 3 },
    ]);
  });

  test('sin grilla cargada no se puede guardar horario', () => {
    assert.strictEqual(P.validarHorarioClases([], { turnos: [] }).ok, false);
  });

  test('una lista vacía es válida: borra el horario de la materia', () => {
    assert.deepStrictEqual(P.validarHorarioClases([], GRILLA), { ok: true, entradas: [] });
  });
});

describe('puntualidad (CP-01 a CP-11)', () => {
  test('CP-01 · sin clase ese día → sinClase', () => {
    const r = evaluar({ materias: [materia(1, 2)], senales: senales({ ingreso: ar('07:50') }) });
    assert.strictEqual(r.estado, 'sinClase');
  });

  test('CP-02 · con clase y sin ningún registro → sinRegistro', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales() });
    assert.strictEqual(r.estado, 'sinRegistro');
    assert.strictEqual(r.primera.desde, '08:00');
  });

  test('CP-03 · llegó 10 minutos antes → aTiempo, con minutos negativos', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('07:50') }) });
    assert.strictEqual(r.estado, 'aTiempo');
    assert.strictEqual(r.minutos, -10);
    assert.strictEqual(r.llegoHHMM, '07:50');
  });

  test('CP-04 · llegó justo 10 minutos después → aTiempo (el límite es inclusivo)', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('08:10') }) });
    assert.strictEqual(r.estado, 'aTiempo');
    assert.strictEqual(r.minutos, 10);
  });

  test('CP-05 · llegó 11 minutos después → tarde', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('08:11') }) });
    assert.strictEqual(r.estado, 'tarde');
    assert.strictEqual(r.minutos, 11);
  });

  test('CP-06 · cuenta lo primero que pasó: la sala 07:58 antes que la plataforma 08:20', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('08:20'), sala: ar('07:58') }) });
    assert.strictEqual(r.estado, 'aTiempo');
    assert.strictEqual(r.llegoHHMM, '07:58');
  });

  test('CP-07 · dos materias el mismo día: se compara contra la primera clase (1ª hora)', () => {
    const r = evaluar({
      materias: [materia(4, 3, 'Física'), materia(1, 3, 'Matemática')],
      senales: senales({ ingreso: ar('08:30') }),
    });
    assert.strictEqual(r.primera.desde, '08:00');
    assert.strictEqual(r.primera.materia, 'Matemática');
    assert.strictEqual(r.estado, 'tarde');
    assert.strictEqual(r.clases.length, 2);
  });

  test('CP-08 · una entrada que apunta a una franja borrada se ignora', () => {
    const m = { id: 'c1', name: 'X', horarioClases: [{ dia: 3, turno: 'manana', orden: 99 }] };
    assert.strictEqual(evaluar({ materias: [m], senales: senales({ ingreso: ar('09:00') }) }).estado, 'sinClase');
  });

  test('CP-09 · algo de la noche anterior no es la llegada de hoy', () => {
    // 23:30 del 10 en Argentina. Llega como señal "colada": no puede contar para el 11.
    const s = senales();
    s.sala.items.push({ desde: ar('23:30', '10') });
    assert.strictEqual(evaluar({ materias: [materia(1)], senales: s }).estado, 'sinRegistro');
  });

  test('CP-10 · si ese día no se registraban ingresos, solo cuenta la sala', () => {
    const s = senales({ ingreso: ar('07:40'), sala: ar('08:30') });
    const r = evaluar({ materias: [materia(1)], senales: s, hayDatoIngreso: false });
    assert.strictEqual(r.llegoHHMM, '08:30');
    assert.strictEqual(r.estado, 'tarde');
  });

  test('CP-11 · sin horario cargado en ninguna materia → sinClase, nunca sinRegistro', () => {
    const r = evaluar({ materias: [{ id: 'c1', name: 'X', horarioClases: [] }], senales: senales() });
    assert.strictEqual(r.estado, 'sinClase');
  });

  test('la zona horaria es la de la escuela: 11:00 UTC son las 08:00 de Argentina', () => {
    const r = evaluar({ materias: [materia(1)], senales: senales({ ingreso: new Date('2026-11-11T11:00:00Z') }) });
    assert.strictEqual(r.llegoHHMM, '08:00');
    assert.strictEqual(r.minutos, 0);
  });

  test('sin grilla cargada → sinClase (sin color, sin romper)', () => {
    const r = P.puntualidad({ fecha: MIERCOLES, grilla: null, materias: [materia(1)], senales: senales() });
    assert.strictEqual(r.estado, 'sinClase');
  });
});

describe('texto (D3): el color nunca va solo', () => {
  test('a tiempo y tarde dicen la hora de llegada y la clase', () => {
    const ok = P.textoPuntualidad(evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('07:50') }) }));
    assert.strictEqual(ok, 'Llegó 07:50 · a tiempo · Le tocaba 1ª hora, 08:00');
    const tarde = P.textoPuntualidad(evaluar({ materias: [materia(1)], senales: senales({ ingreso: ar('08:15') }) }));
    assert.strictEqual(tarde, 'Llegó 08:15 · 15 min tarde · Le tocaba 1ª hora, 08:00');
  });

  test('sin clase no hay texto', () => {
    assert.strictEqual(P.textoPuntualidad({ estado: 'sinClase' }), '');
  });

  test('ningún texto dice "faltó"', () => {
    const t = P.textoPuntualidad(evaluar({ materias: [materia(1)], senales: senales() }));
    assert.ok(!/falt|ausen/i.test(t), t);
  });
});
