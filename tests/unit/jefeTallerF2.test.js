// Jefe de Taller — F2: control de los MEP (specs/jefe-de-taller.spec.md).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../../services/tallerControl');
const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

test('JT-11 · días hábiles: los de la grilla, dentro del período y nunca después de hoy', () => {
  const semana = { inicio: '2026-11-16', fin: '2026-11-23' };
  assert.deepStrictEqual(C.diasHabiles(semana, null, '2026-11-30'),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'], 'sin grilla: lunes a viernes');
  assert.deepStrictEqual(C.diasHabiles(semana, [1, 3, 6], '2026-11-30'), ['2026-11-16', '2026-11-18', '2026-11-21']);
  assert.deepStrictEqual(C.diasHabiles(semana, [1, 2, 3, 4, 5], '2026-11-18'), ['2026-11-16', '2026-11-17', '2026-11-18'], 'nada futuro');
  const mes = C.diasHabiles({ inicio: '2026-02-01', fin: '2026-03-01' }, [], '2026-12-31');
  assert.strictEqual(mes.length, 20);
  assert.strictEqual(mes[0], '2026-02-02');
});

test('JT-12 · la matriz: una celda por día, totales solo de los días con clase', () => {
  const fila = (id, estado, p, nota = null) => ({ id, estado, puntualidad: { estado: p }, nota, textoPuntualidad: '' });
  const porDia = new Map([
    ['2026-11-16', [fila('m1', 'actividad', 'aTiempo'), fila('m2', 'sinRegistro', 'sinRegistro')]],
    ['2026-11-17', [fila('m1', 'ingreso', 'tarde', { texto: 'x' }), fila('m2', 'sinRegistro', 'sinClase')]],
    ['2026-11-18', [fila('m1', 'sinRegistro', 'sinClase')]],
  ]);
  const meps = [{ id: 'm2', name: 'Zapata' }, { id: 'm1', name: 'Alvarez', materias: [{ name: 'Taller' }] }];
  const r = C.matrizControl({ meps, fechas: ['2026-11-16', '2026-11-17', '2026-11-18'], porDia });
  assert.deepStrictEqual(r.map(x => x.name), ['Alvarez', 'Zapata']);
  const a = r[0];
  assert.deepStrictEqual(a.totales, { conClase: 2, actividad: 1, ingreso: 1, sinRegistro: 0, tarde: 1 });
  assert.strictEqual(a.celdas['2026-11-17'].nota, true);
  assert.strictEqual(a.celdas['2026-11-18'].conClase, false);
  const z = r[1];
  assert.deepStrictEqual(z.totales, { conClase: 1, actividad: 0, ingreso: 0, sinRegistro: 1, tarde: 0 }, 'un día sin clase no suma "sin registro"');
  assert.strictEqual(z.celdas['2026-11-18'], null, 'sin fila ese día: celda vacía, no "sin registro"');
});

test('JT-13 · renglones de taller del horario oficial', () => {
  const talleres = ['Prácticas de Taller de Electricidad II'];
  assert.ok(C.esRenglonDeTaller({ materia: 'PRACTICAS DE TALLER DE ELECTRICIDAD II' }, talleres));
  assert.ok(C.esRenglonDeTaller({ materia: 'Taller de Soldadura' }, talleres), 'por el nombre');
  for (const m of ['Lengua', 'Matemática', '', null]) assert.ok(!C.esRenglonDeTaller({ materia: m }, talleres), String(m));
  const oficial = { curso: 2, division: 5, entradas: [{ materia: 'Lengua' }, { materia: 'Taller de Soldadura' }] };
  const f = C.filtrarOficialTaller(oficial, talleres);
  assert.deepStrictEqual(f.entradas, [{ materia: 'Taller de Soldadura' }]);
  assert.strictEqual(oficial.entradas.length, 2, 'no toca el original');
  assert.strictEqual(C.filtrarOficialTaller(null, talleres), null);
});

test('JT-14 · la nota del día: solo el Jefe de Taller, mismo legajo, auditada y validada', () => {
  const { ROLES_ANOTAN_TALLER } = require('../../routes/taller');
  assert.deepStrictEqual(ROLES_ANOTAN_TALLER, ['jefetaller']);
  const rutas = leer('routes', 'taller.js');
  assert.match(rutas, /const clave = \{ school, docente: oid\(id\), fecha \};/);
  assert.match(rutas, /NotaDocenteDia\.findOneAndUpdate\(\s*clave/);
  assert.match(rutas, /logAudit\(req, 'taller\.nota_guardar'/);
  assert.match(rutas, /logAudit\(req, 'taller\.nota_borrar'/);
  assert.match(rutas, /S\.esFutura\(fecha, new Date\(\)\)/);
  assert.match(rutas, /S\.textoDeNota\(req\.body\.texto\)/);
  const acciones = leer('config', 'audit-actions.js');
  for (const a of ['taller.nota_guardar', 'taller.nota_borrar']) assert.match(acciones, new RegExp(`'${a.replace('.', '\\.')}'`));
});

test('JT-15 · ficha, nota y control: solo MEP de talleres de la escuela, y lo demás es 404', () => {
  const rutas = leer('routes', 'taller.js');
  assert.match(rutas, /async function mepsDeLaEscuela\(school\)/);
  assert.match(rutas, /S\.docentesDelAlcance\(talleres, divisionIds\)/);
  const usos = rutas.match(/await mepsDeLaEscuela\(school\)/g) || [];
  assert.ok(usos.length >= 3, 'control, ficha y nota');
  assert.match(rutas, /if \(!docentes\.has\(id\)\) return res\.status\(404\)\.send/);
  assert.match(rutas, /if \(!docentes\.has\(id\)\) return res\.status\(404\)\.json/);
  // Las secciones nuevas existen en el panel.
  const { SECTIONS } = require('../../config/sections');
  const lista = Array.isArray(SECTIONS) ? SECTIONS : Object.values(SECTIONS);
  for (const k of ['taller_docentes', 'taller_horario', 'taller_rotacion']) assert.ok(lista.some(s => s.key === k), k);
});

test('JT-16 · horarios: compararCurso y la misma tabla de Secretaría, sin enlazar a /secretaria/oficial', () => {
  const rutas = leer('routes', 'taller.js');
  assert.match(rutas, /O\.compararCurso\(\{ oficial, grilla, materias \}\)/);
  assert.match(rutas, /C\.filtrarOficialTaller\(/);
  const vista = leer('views', 'taller', 'horario.ejs');
  assert.match(vista, /include\('\.\.\/secretaria\/_comparacion', \{[^}]*enlaceOficial: null/);
  const ejs = require('ejs');
  const src = leer('views', 'secretaria', '_comparacion.ejs');
  const html = ejs.render(src, { comparacion: { oficial: null, hayImportado: false }, NOMBRE_DIA: {}, ETIQUETA_ESTADO: {}, enlaceOficial: null });
  assert.doesNotMatch(html, /secretaria\/oficial/);
  const html2 = ejs.render(src, { comparacion: { oficial: null, hayImportado: false }, NOMBRE_DIA: {}, ETIQUETA_ESTADO: {} });
  assert.match(html2, /\/secretaria\/oficial/, 'la Secretaría sigue igual');
});
