// Tests de las reglas puras del panel de la Secretaria ("Docentes del día").
// Correr con: npm run test:unit
//
// Cubren CA-01 a CA-11 de specs/secretaria-docentes-del-dia.spec.md. La regla que más importa
// proteger es D2: la falta de registro nunca se convierte en "faltó". Si algún día alguien suma
// un cuarto estado, que lo haga leyendo esto.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const S = require('../../services/secretariaDia');

// 11/11/2026 a las 15:00 en Argentina (UTC-3) = 18:00 UTC.
const AHORA = new Date('2026-11-11T18:00:00Z');
const HOY = '2026-11-11';

// Un instante del 11/11 en hora argentina, escrito como UTC.
const ar = (hhmm, dia = '11') => new Date(`2026-11-${dia}T${hhmm}:00-03:00`);

describe('fechas (CA-01 a CA-03)', () => {
  test('CA-01 · la ventana del día es holgada: cubre el día argentino entero', () => {
    const v = S.ventanaDelDia(HOY);
    // Las 00:00 y las 23:59 de Argentina tienen que quedar adentro. La holgura la recorta esDelDia.
    assert.ok(ar('00:00') >= v.$gte && ar('00:00') < v.$lt);
    assert.ok(ar('23:59') >= v.$gte && ar('23:59') < v.$lt);
  });

  test('CA-01 · esDelDia recorta con la zona de la escuela, no con UTC', () => {
    assert.strictEqual(S.esDelDia(ar('00:05'), HOY), true);
    assert.strictEqual(S.esDelDia(ar('23:55'), HOY), true);
    assert.strictEqual(S.esDelDia(ar('23:55', '10'), HOY), false);
    assert.strictEqual(S.esDelDia(ar('00:05', '12'), HOY), false);
  });

  test('CA-02 · las 23:30 de Argentina del 11 son el 11, aunque en UTC ya sea el 12', () => {
    const d = ar('23:30');
    assert.strictEqual(d.toISOString().slice(0, 10), '2026-11-12');   // en UTC, el 12
    assert.strictEqual(S.fechaDe(d), HOY);
  });

  test('CA-03 · fechaValida: futura → hoy, basura → hoy, válida → igual', () => {
    assert.strictEqual(S.fechaValida('2026-11-12', AHORA), HOY);
    assert.strictEqual(S.fechaValida('2099-01-01', AHORA), HOY);
    assert.strictEqual(S.fechaValida('cualquier cosa', AHORA), HOY);
    assert.strictEqual(S.fechaValida(undefined, AHORA), HOY);
    assert.strictEqual(S.fechaValida('2026-02-31', AHORA), HOY);   // el regex lo pasa, el calendario no
    assert.strictEqual(S.fechaValida('2026-11-10', AHORA), '2026-11-10');
    assert.strictEqual(S.fechaValida('2025-03-01', AHORA), '2025-03-01');   // sin tope hacia atrás
  });

  test('esFutura (para la nota, RN-12)', () => {
    assert.strictEqual(S.esFutura('2026-11-12', AHORA), true);
    assert.strictEqual(S.esFutura(HOY, AHORA), false);
    assert.strictEqual(S.esFutura('2026-11-01', AHORA), false);
  });

  test('día anterior y siguiente cruzan meses y años', () => {
    assert.strictEqual(S.diaAnterior('2026-03-01'), '2026-02-28');
    assert.strictEqual(S.diaSiguiente('2026-12-31'), '2027-01-01');
  });
});

describe('alcance (CA-04, CA-05)', () => {
  const courses = [
    { _id: 'c1', name: 'Matemática', division: 'd1', owner: 'u1', coTeachers: ['u2'] },
    { _id: 'c2', name: 'Física',     division: 'd1', owner: { _id: 'u1', name: 'Ana' }, coTeachers: [] },
    { _id: 'c3', name: 'Química',    division: 'd2', owner: 'u3', coTeachers: [] },
    // owner repetido como co-docente: no tiene que duplicar la materia
    { _id: 'c4', name: 'Taller',     division: 'd1', owner: 'u4', coTeachers: ['u4'] },
  ];

  test('CA-04 · titular y co-docentes, sin repetir, solo de divisiones del alcance', () => {
    const m = S.docentesDelAlcance(courses, ['d1']);
    assert.deepStrictEqual([...m.keys()].sort(), ['u1', 'u2', 'u4']);
    assert.deepStrictEqual(m.get('u1').map(x => x.id).sort(), ['c1', 'c2']);
    assert.deepStrictEqual(m.get('u4').map(x => x.id), ['c4']);
    assert.strictEqual(m.has('u3'), false, 'u3 da en d2, que no está en el alcance');
  });

  test('CA-05 · alcance vacío → nadie (fail-closed)', () => {
    assert.strictEqual(S.docentesDelAlcance(courses, []).size, 0);
    assert.strictEqual(S.docentesDelAlcance(courses, undefined).size, 0);
  });
});

describe('señales (CA-06 a CA-08)', () => {
  const auditoria = (action, hhmm, curso, extra = []) => ({
    action, timestamp: ar(hhmm),
    targets: [...extra, { type: 'course', id: curso, name: '' }],
  });

  test('CA-06 · lo publicado en una materia fuera del alcance no cuenta', () => {
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'],
      auditorias: [
        auditoria('activity.create', '10:00', 'c1', [{ type: 'activity', id: 'a1', name: 'TP 1' }]),
        auditoria('activity.create', '11:00', 'c9', [{ type: 'activity', id: 'a2', name: 'Ajena' }]),
      ],
    });
    assert.strictEqual(s.publico.cantidad, 1);
    assert.strictEqual(s.publico.items[0].texto, 'TP 1');
  });

  test('CA-06 · lo de otro día tampoco cuenta (la ventana holgada trae de más)', () => {
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'],
      auditorias: [{ action: 'announcement.create', timestamp: ar('23:50', '10'),
        targets: [{ type: 'course', id: 'c1' }] }],
    });
    assert.strictEqual(s.publico.cantidad, 0);
  });

  test('CA-07 · calificar y devolver la misma entrega cuenta una; otra entrega suma', () => {
    const ent = (alumno) => [{ type: 'activity', id: 'a1' }, { type: 'user', id: alumno, name: 'Alumno' }];
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'],
      auditorias: [
        auditoria('submission.grade',  '14:00', 'c1', ent('al1')),
        auditoria('submission.return', '14:05', 'c1', ent('al1')),
        auditoria('submission.grade',  '14:10', 'c1', ent('al2')),
      ],
    });
    assert.strictEqual(s.corrigio.cantidad, 2);
  });

  test('RN-10 · lo corregido no expone datos del alumno', () => {
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'],
      auditorias: [auditoria('submission.grade', '14:00', 'c1',
        [{ type: 'activity', id: 'a1' }, { type: 'user', id: 'al1', name: 'NOMBRE DEL ALUMNO' }])],
    });
    assert.ok(!JSON.stringify(s).includes('NOMBRE DEL ALUMNO'));
    assert.ok(!JSON.stringify(s).includes('al1'));
  });

  test('RN-10 · el texto de lo publicado se corta a 60 caracteres', () => {
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'],
      auditorias: [auditoria('announcement.create', '09:00', 'c1',
        [{ type: 'announcement', id: 'n1', name: 'x'.repeat(200) }])],
    });
    assert.strictEqual(s.publico.items[0].texto.length, S.TEXTO_MAX);
  });

  test('CA-08 · una sesión de sala que cruza la medianoche cuenta en el día en que empezó', () => {
    const p = { course: 'c1', firstSeenAt: ar('23:50', '10'), lastPingAt: ar('00:20'), msPresente: 30 * 60000 };
    const ayer = S.senalesDelDocente({ fecha: '2026-11-10', cursosAlcance: ['c1'], presencias: [p] });
    const hoy  = S.senalesDelDocente({ fecha: HOY,          cursosAlcance: ['c1'], presencias: [p] });
    assert.strictEqual(ayer.sala.sesiones, 1);
    assert.strictEqual(ayer.sala.minutos, 30);
    assert.strictEqual(hoy.sala.sesiones, 0);
  });

  test('S2 · sala de una materia fuera del alcance no cuenta', () => {
    const s = S.senalesDelDocente({ fecha: HOY, cursosAlcance: ['c1'],
      presencias: [{ course: 'c9', firstSeenAt: ar('10:00'), lastPingAt: ar('11:00'), msPresente: 3600000 }] });
    assert.strictEqual(s.sala.sesiones, 0);
  });

  test('S1 · el ingreso no se limita a materias, pero sí a la fecha', () => {
    const ing = { fecha: HOY, primeraVez: ar('07:40'), ultimaVez: ar('12:10') };
    assert.ok(S.senalesDelDocente({ fecha: HOY, ingreso: ing, cursosAlcance: [] }).ingreso);
    assert.strictEqual(S.senalesDelDocente({ fecha: '2026-11-10', ingreso: ing }).ingreso, null);
  });
});

describe('estado del día (CA-09, CA-10) — D2: nunca "faltó"', () => {
  const vacio = () => S.senalesDelDocente({ fecha: HOY });
  const conIngreso = () => S.senalesDelDocente({ fecha: HOY,
    ingreso: { fecha: HOY, primeraVez: ar('08:00'), ultimaVez: ar('08:30') } });
  const conPublico = (ingreso) => S.senalesDelDocente({ fecha: HOY, cursosAlcance: ['c1'], ingreso,
    auditorias: [{ action: 'activity.create', timestamp: ar('10:00'), targets: [{ type: 'course', id: 'c1' }] }] });

  test('CA-09 · solo ingreso → "ingreso"', () => {
    assert.strictEqual(S.estadoDelDia(conIngreso()), 'ingreso');
  });

  test('CA-09 · ingreso + publicó → "actividad"', () => {
    assert.strictEqual(S.estadoDelDia(conPublico({ fecha: HOY, primeraVez: ar('08:00') })), 'actividad');
  });

  test('CA-09 · nada → "sinRegistro"', () => {
    assert.strictEqual(S.estadoDelDia(vacio()), 'sinRegistro');
  });

  test('CA-10 · sin dato de ingreso (día anterior al deploy) y con S3 → "actividad"', () => {
    assert.strictEqual(S.estadoDelDia(conPublico(null), { hayDatoIngreso: false }), 'actividad');
  });

  test('CA-10 · si ese día no se registraban ingresos, un ingreso no cambia el estado', () => {
    assert.strictEqual(S.estadoDelDia(conIngreso(), { hayDatoIngreso: false }), 'sinRegistro');
  });

  test('CA-10 · sin dato de ingreso y sin S2–S4 → "sinRegistro"', () => {
    assert.strictEqual(S.estadoDelDia(vacio(), { hayDatoIngreso: false }), 'sinRegistro');
  });

  test('⭐ ningún texto de estado habla de faltar o de ausencia', () => {
    for (const t of Object.values(S.ESTADOS)) {
      assert.ok(!/falt|ausen/i.test(t), `"${t}" sugiere que el docente faltó`);
    }
  });

  test('resumen cuenta cada estado', () => {
    assert.deepStrictEqual(S.resumen(['actividad', 'ingreso', 'actividad', 'sinRegistro']),
      { actividad: 2, ingreso: 1, sinRegistro: 1 });
  });
});

describe('línea del día (CA-11)', () => {
  test('CA-11 · eventos ordenados, la sala con duración y lo demás como puntos', () => {
    const s = S.senalesDelDocente({
      fecha: HOY, cursosAlcance: ['c1'], nombres: { c1: 'Matemática' },
      presencias: [{ course: 'c1', firstSeenAt: ar('10:00'), lastPingAt: ar('10:40'), msPresente: 40 * 60000 }],
      auditorias: [
        { action: 'submission.grade', timestamp: ar('15:00'),
          targets: [{ type: 'activity', id: 'a1' }, { type: 'user', id: 'x' }, { type: 'course', id: 'c1' }] },
        { action: 'activity.create', timestamp: ar('08:00'),
          targets: [{ type: 'activity', id: 'a2', name: 'Guía 3' }, { type: 'course', id: 'c1' }] },
      ],
    });
    const ev = S.eventosDeLaLinea(s);
    assert.deepStrictEqual(ev.map(e => e.tipo), ['publico', 'sala', 'corrigio']);
    assert.ok(ev[1].hasta, 'la sala tiene que tener hasta');
    assert.strictEqual(ev[0].hasta, null);
    assert.strictEqual(ev[1].materia, 'Matemática');
  });
});

describe('texto de la nota (RN-12)', () => {
  test('vacío o solo espacios = borrar', () => {
    assert.deepStrictEqual(S.textoDeNota('   '), { borrar: true, texto: '' });
    assert.deepStrictEqual(S.textoDeNota(undefined), { borrar: true, texto: '' });
  });
  test('500 entra, 501 no', () => {
    assert.strictEqual(S.textoDeNota('a'.repeat(500)).texto.length, 500);
    assert.ok(S.textoDeNota('a'.repeat(501)).error);
  });
  test('se recortan los espacios de las puntas', () => {
    assert.strictEqual(S.textoDeNota('  avisó que llega tarde  ').texto, 'avisó que llega tarde');
  });
});
