// Comparar con el horario oficial (specs/secretaria-horario-oficial.spec.md).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../../services/secretariaHorarioOficial');
const grillaSvc = require('../../services/recursos/horario');
const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

// Un documento chico con la forma del transcripto (los nombres son inventados).
const DOC = {
  tipo: 'horario-oficial', version: 1,
  cursos: [{
    curso: 1, division: 1, turno: 'Mañana', carrera: 'Ciclo Básico',
    entradas: [
      { hora: 1, dia: 1, desde: '07:45', hasta: '08:25', materia: 'Ciencias Sociales: Geografía', docente: 'PEREZ ANA LUCIA' },
      { hora: 2, dia: 1, desde: '08:25', hasta: '09:05', materia: 'Matemática', docente: 'Gomez Rosa' },
      { hora: 3, dia: 1, desde: '09:10', hasta: '09:50', materia: 'Lengua', docente: 'TORRES JUAN' },
      { hora: 4, dia: 1, desde: '09:50', hasta: '10:30', materia: 'Lengua Extranjera - Inglés', docente: 'DIAZ MARTA' },
      { hora: 5, dia: 1, desde: '10:40', hasta: '11:20', materia: 'Historia', docente: 'LOPEZ EVA' },
      { hora: 6, dia: 2, desde: '07:45', hasta: '09:05', materia: 'Matemática', docente: 'GOMEZ ROSA MARIA' },
      { hora: 7, dia: 2, desde: '13:45', hasta: '17:45', materia: '', docente: '', nota: '6.0 oblig.' },
      { hora: 8, dia: 3, desde: '15:00', hasta: '17:00', materia: 'Educación Física', docente: 'RUIZ LEO' },
    ],
  }],
};

// Grilla de la escuela con los horarios del oficial (mañana).
const GRILLA = {
  dias: [1, 2, 3, 4, 5],
  turnos: [{
    id: 'manana', label: 'Mañana', desde: '07:45', hasta: '11:20',
    franjas: [
      { tipo: 'clase', orden: 1, label: '1ª', desde: '07:45', hasta: '08:25' },
      { tipo: 'clase', orden: 2, label: '2ª', desde: '08:25', hasta: '09:05' },
      { tipo: 'recreo', orden: null, label: 'Recreo', desde: '09:05', hasta: '09:10' },
      { tipo: 'clase', orden: 3, label: '3ª', desde: '09:10', hasta: '09:50' },
      { tipo: 'clase', orden: 4, label: '4ª', desde: '09:50', hasta: '10:30' },
      { tipo: 'recreo', orden: null, label: 'Recreo', desde: '10:30', hasta: '10:40' },
      { tipo: 'clase', orden: 5, label: '5ª', desde: '10:40', hasta: '11:20' },
    ],
  }],
};

// ── HO-01 ────────────────────────────────────────────────────────────────────

test('HO-01 · acepta un documento bien formado y rechaza los errores de transcripción', () => {
  assert.deepStrictEqual(H.validarDocumento(DOC).errores, []);
  assert.match(H.validarDocumento({ ...DOC, tipo: 'otro' }).errores[0], /no es un horario oficial/);
  const malo = (e) => H.validarDocumento({ ...DOC, cursos: [{ ...DOC.cursos[0], entradas: [e] }] }).errores;
  assert.match(malo({ dia: 7, desde: '08:00', hasta: '09:00' })[0], /Curso 1° 01°, renglón 1: el día/);
  assert.match(malo({ dia: 1, desde: '8:00', hasta: '09:00' })[0], /mal escrito/);
  assert.match(malo({ dia: 1, desde: '09:00', hasta: '08:00' })[0], /termina antes de empezar/);
  const repetido = H.validarDocumento({ ...DOC, cursos: [DOC.cursos[0], DOC.cursos[0]] }).errores;
  assert.ok(repetido.some(e => /repetido/.test(e)));
});

// ── HO-02 ────────────────────────────────────────────────────────────────────

test('HO-02 · curso y división se emparejan por los números del nombre', () => {
  for (const n of ['1° 1°', '1°1', '1ro 1ra', '1° 01°']) assert.deepStrictEqual(H.numerosDeDivision(n), [1, 1], n);
  assert.strictEqual(H.numerosDeDivision('Primero A'), null);
  const divs = [{ id: 'a', name: '1° 2°' }, { id: 'b', name: '1° 1°' }, { id: 'c', name: '2° 1°' }];
  assert.strictEqual(H.divisionDe({ curso: 1, division: 1 }, divs), 'b');
  assert.strictEqual(H.divisionDe({ curso: 3, division: 1 }, divs), null);
});

// ── HO-03 ────────────────────────────────────────────────────────────────────

test('HO-03 · docentes: exacto, parecido y nunca solo por el nombre de pila', () => {
  assert.strictEqual(H.comparaNombres('SALDAÑA MARCELA CAROLINA', 'Saldana Marcela Carolina'), 'exacto');
  assert.strictEqual(H.comparaNombres('Muñoz Cintia', 'Cintia Muñoz'), 'exacto');
  assert.strictEqual(H.comparaNombres('Muñoz Cintia', 'MUÑOZ CINTIA BEATRIZ'), 'parecido');
  assert.strictEqual(H.comparaNombres('LUNA MICAELA SOLEDAD', 'Luna Micaela'), 'parecido');
  assert.strictEqual(H.comparaNombres('NAVARRO MARIA LAURA', 'VASQUEZ MARIA LAURA'), null);
  assert.strictEqual(H.comparaNombres('LUNA MICAELA SOLEDAD', 'LUNA PEDRO'), null);
  const usuarios = [{ id: 1, name: 'Muñoz Cintia Beatriz' }, { id: 2, name: 'Muñoz Cintia' }];
  assert.strictEqual(H.coincideDocente('MUÑOZ CINTIA', usuarios).usuario.id, 2, 'gana el exacto');
  assert.strictEqual(H.coincideDocente('NADIE NUNCA', usuarios).estado, 'no');
});

// ── HO-04 ────────────────────────────────────────────────────────────────────

test('HO-04 · materias: normalizadas y por contención, pero "Lengua" no es "Lengua Extranjera"', () => {
  assert.ok(H.coincideMateria('Ciencias Sociales: Geografía', 'Geografía'));
  assert.ok(H.coincideMateria('Lengua Extranjera - Inglés', 'Lengua Extranjera'));
  assert.ok(H.coincideMateria('Matemática', 'MATEMATICA'));
  assert.ok(H.coincideMateria('Educación Artística (A) Teatro', 'Educación Artística Teatro'));
  assert.ok(!H.coincideMateria('Lengua', 'Lengua Extranjera'));
  assert.ok(!H.coincideMateria('Física', 'Química'));
});

// ── HO-05 ────────────────────────────────────────────────────────────────────

test('HO-05 · un renglón cae en los módulos que cubre, por hora', () => {
  const ordenes = (d, h) => H.modulosQueCubre(GRILLA, d, h).map(m => m.orden);
  assert.deepStrictEqual(ordenes('08:25', '09:10'), [2], 'cinco minutos de más no lo pasan al siguiente');
  assert.deepStrictEqual(ordenes('07:45', '09:05'), [1, 2], 'un bloque de dos módulos');
  assert.deepStrictEqual(ordenes('15:00', '17:00'), [], 'a esa hora la grilla no tiene módulos');
  assert.deepStrictEqual(H.modulosQueCubre(null, '08:00', '09:00'), []);
});

// ── HO-06 ────────────────────────────────────────────────────────────────────

test('HO-06 · compararCurso da cada estado, el peor de un bloque y lo que sobra', () => {
  const materias = [
    { id: 'geo', name: 'Geografía', horarioClases: [{ dia: 1, turno: 'manana', orden: 1 }], docentes: [{ id: 'u1', name: 'Pérez Ana Lucía' }] },
    { id: 'mat', name: 'Matemática', horarioClases: [{ dia: 1, turno: 'manana', orden: 2 }, { dia: 2, turno: 'manana', orden: 1 }], docentes: [{ id: 'u2', name: 'Gómez Rosa María' }] },
    { id: 'len', name: 'Lengua', horarioClases: [{ dia: 1, turno: 'manana', orden: 3 }], docentes: [{ id: 'u3', name: 'Ramos Pía' }] },
    { id: 'his', name: 'Historia', horarioClases: [{ dia: 1, turno: 'manana', orden: 4 }, { dia: 4, turno: 'manana', orden: 2 }], docentes: [{ id: 'u4', name: 'López Eva' }] },
  ];
  const { filas, sobran, resumen } = H.compararCurso({ oficial: H.validarDocumento(DOC).cursos[0], grilla: GRILLA, materias });
  const estado = (h) => filas.find(f => f.hora === h).estado;
  assert.strictEqual(estado(1), 'coincide');
  assert.strictEqual(estado(2), 'docenteParecido', '"Gomez Rosa" ↔ "Gómez Rosa María"');
  assert.strictEqual(filas.find(f => f.hora === 2).docenteEn, 'Gómez Rosa María');
  assert.strictEqual(estado(3), 'otroDocente');
  assert.strictEqual(estado(4), 'otraMateria', 'en la 4ª del lunes está Historia');
  assert.strictEqual(estado(5), 'falta');
  assert.strictEqual(estado(6), 'falta', 'bloque de dos módulos: uno está y el otro no → el peor');
  assert.strictEqual(estado(7), 'sinMateria');
  assert.strictEqual(estado(8), 'sinModulo');
  assert.deepStrictEqual(sobran.map(s => `${s.dia}|${s.orden}|${s.materia}`), ['4|2|Historia']);
  assert.deepStrictEqual(resumen, { renglones: 8, coincide: 1, diferencias: 5, parecidos: 1, informativos: 2, sobran: 1 });
});

test('docentesDelOficial: los que faltan y los parecidos, sin repetir', () => {
  const r = H.docentesDelOficial(H.validarDocumento(DOC).cursos, [
    { id: 1, name: 'Pérez Ana Lucía' }, { id: 2, name: 'Gómez Rosa María' }, { id: 3, name: 'López Eva' },
  ]);
  assert.deepStrictEqual(r.faltan, ['DIAZ MARTA', 'RUIZ LEO', 'TORRES JUAN']);
  assert.deepStrictEqual(r.parecidos, [{ oficial: 'Gomez Rosa', plataforma: 'Gómez Rosa María' }]);
});

// ── HO-07 / HO-08 ────────────────────────────────────────────────────────────

test('HO-07 · las vistas escapan lo que sale del JSON', () => {
  for (const v of ['views/secretaria/oficial.ejs', 'views/secretaria/_comparacion.ejs']) {
    const src = leer(...v.split('/'));
    assert.doesNotMatch(src, /<%-(?!\s*include)/, v + ': nada sin escapar salvo los include');
  }
});

test('HO-08 · solo quien carga horarios puede importar', () => {
  const src = leer('routes', 'secretaria.js');
  const post = src.slice(src.indexOf("router.post('/oficial'"), src.indexOf('});', src.indexOf("router.post('/oficial'")));
  assert.match(post, /if \(!puedeCargarHorario\(res\.locals\.user\)\)/);
  const { ROLES_QUE_CARGAN_HORARIO } = require('../../middleware/secretaria');
  assert.ok(!ROLES_QUE_CARGAN_HORARIO.includes('directivo'));
});

test('el modelo tiene índice único por escuela, curso y división', () => {
  const M = require('../../models/HorarioOficial');
  const idx = M.schema.indexes().find(([k]) => k.school === 1 && k.curso === 1 && k.division === 1);
  assert.ok(idx && idx[1].unique);
});
