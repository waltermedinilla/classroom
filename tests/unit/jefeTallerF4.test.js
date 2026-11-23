// Jefe de Taller — F4: rotación de grupos (specs/jefe-de-taller.spec.md).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../../services/tallerRotacion');
const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');
const rangos = (r) => r.periodos.map(p => `${p.desde}>${p.hasta}`);

test('JT-20 · períodos: semana, quincena, mes y manual', () => {
  // 2027-03-03 es miércoles.
  assert.deepStrictEqual(rangos(R.armarPeriodos({ desde: '2027-03-03', hasta: '2027-03-18', cambiaCada: 'semana' })),
    ['2027-03-03>2027-03-07', '2027-03-08>2027-03-14', '2027-03-15>2027-03-18']);
  assert.deepStrictEqual(rangos(R.armarPeriodos({ desde: '2027-03-03', hasta: '2027-04-10', cambiaCada: 'quincena' })),
    ['2027-03-03>2027-03-14', '2027-03-15>2027-03-28', '2027-03-29>2027-04-10']);
  assert.deepStrictEqual(rangos(R.armarPeriodos({ desde: '2026-11-20', hasta: '2027-01-15', cambiaCada: 'mes' })),
    ['2026-11-20>2026-11-30', '2026-12-01>2026-12-31', '2027-01-01>2027-01-15']);
  assert.deepStrictEqual(rangos(R.armarPeriodos({ desde: '2027-03-01', hasta: '2027-06-30', cambiaCada: 'manual',
    cortes: ['2027-05-03', '2027-04-05', '2027-04-05', '2027-03-01', '2027-08-01', 'basura'] })),
    ['2027-03-01>2027-04-04', '2027-04-05>2027-05-02', '2027-05-03>2027-06-30']);
  assert.deepStrictEqual(rangos(R.armarPeriodos({ desde: '2027-03-07', hasta: '2027-03-07', cambiaCada: 'semana' })), ['2027-03-07>2027-03-07']);
  assert.ok(R.armarPeriodos({ desde: '2027-03-10', hasta: '2027-03-01', cambiaCada: 'semana' }).error);
  assert.ok(R.armarPeriodos({ desde: '2027-02-30', hasta: '2027-03-01', cambiaCada: 'semana' }).error, 'fecha inexistente');
  assert.ok(R.armarPeriodos({ desde: '2027-01-01', hasta: '2028-06-01', cambiaCada: 'semana' }).error, 'más de 400 días');
  assert.ok(R.armarPeriodos({ desde: '2027-01-01', hasta: '2027-02-01', cambiaCada: 'x' }).error);
});

const est = (id, admiteVarios = false) => ({ _id: id, nombre: id.toUpperCase(), admiteVarios });
const per = (n) => Array.from({ length: n }, (_, i) => ({ desde: `2027-03-0${i + 1}`, hasta: `2027-03-0${i + 1}` }));

test('JT-21 · calendario circular: el grupo i va a la estación (i + p) mod m', () => {
  const r = R.generarCalendario({ periodos: per(3), grupos: ['g1', 'g2', 'g3'], estaciones: [est('e1'), est('e2'), est('e3')] });
  assert.deepStrictEqual(r.periodos.map(p => p.asignacion.map(a => a.estacion)), [['e1', 'e2', 'e3'], ['e2', 'e3', 'e1'], ['e3', 'e1', 'e2']]);
  assert.strictEqual(r.periodos[1].desde, '2027-03-02');
  const dos = R.generarCalendario({ periodos: per(2), grupos: ['g1', 'g2'], estaciones: [est('e1'), est('e2'), est('e3')] });
  assert.deepStrictEqual(dos.periodos.map(p => p.asignacion.map(a => a.estacion)), [['e1', 'e2'], ['e2', 'e3']], 'sobra una estación');
  assert.match(R.generarCalendario({ periodos: per(2), grupos: ['g1', 'g2', 'g3'], estaciones: [est('e1'), est('e2')] }).error, /más grupos/);
  assert.ok(R.generarCalendario({ periodos: per(2), grupos: ['g1', 'g2', 'g3'], estaciones: [est('e1', true), est('e2', true)] }).periodos,
    'si admiten varios, se puede');
  assert.ok(R.generarCalendario({ periodos: per(1), grupos: [], estaciones: [est('e1')] }).error);
  assert.ok(R.generarCalendario({ periodos: per(1), grupos: ['g1'], estaciones: [] }).error);
});

test('JT-22 · correcciones a mano: sin choques, sin grupos ni estaciones de más', () => {
  const guardados = per(2);
  const estaciones = [est('e1'), est('e2', true)];
  const ok = R.validarCalendario({ entrada: [{ asignacion: [{ grupo: 'g1', estacion: 'e2' }, { grupo: 'g2', estacion: 'e2' }] }, { asignacion: [{ grupo: 'g1', estacion: null }, { grupo: 'g2', estacion: '' }] }],
    periodosGuardados: guardados, grupos: ['g1', 'g2'], estaciones });
  assert.ok(ok.periodos, ok.error);
  assert.strictEqual(ok.periodos[0].desde, '2027-03-01', 'las fechas son las guardadas');
  assert.strictEqual(ok.periodos[1].asignacion[1].estacion, null);
  const v = (entrada) => R.validarCalendario({ entrada, periodosGuardados: guardados, grupos: ['g1', 'g2'], estaciones }).error;
  assert.match(v([{ asignacion: [{ grupo: 'g1', estacion: 'e1' }, { grupo: 'g2', estacion: 'e1' }] }, { asignacion: [] }]), /dos grupos en E1/);
  assert.ok(v([{ asignacion: [{ grupo: 'gX', estacion: 'e1' }] }, { asignacion: [] }]));
  assert.ok(v([{ asignacion: [{ grupo: 'g1', estacion: 'eX' }] }, { asignacion: [] }]));
  assert.ok(v([{ asignacion: [{ grupo: 'g1', estacion: 'e1' }, { grupo: 'g1', estacion: 'e2' }] }, { asignacion: [] }]));
  assert.ok(v([{ asignacion: [] }]), 'otra cantidad de períodos');
});

test('JT-23 · grupos: un alumno en uno solo, de la división, 1 a 12, nombres sin repetir', () => {
  const div = ['a1', 'a2', 'a3'];
  const ok = R.validarGrupos([{ id: 'x', nombre: ' Grupo A ', alumnos: ['a1'] }, { nombre: 'Grupo B', alumnos: ['a2', 'a3'] }], div);
  assert.deepStrictEqual(ok.grupos, [{ id: 'x', nombre: 'Grupo A', alumnos: ['a1'] }, { id: null, nombre: 'Grupo B', alumnos: ['a2', 'a3'] }]);
  assert.match(R.validarGrupos([{ nombre: 'A', alumnos: ['a1'] }, { nombre: 'B', alumnos: ['a1'] }], div).error, /dos grupos/);
  assert.ok(R.validarGrupos([{ nombre: 'A', alumnos: ['zz'] }], div).error);
  assert.ok(R.validarGrupos([{ nombre: 'A' }, { nombre: 'a' }], div).error, 'nombre repetido sin importar mayúsculas');
  assert.ok(R.validarGrupos([{ nombre: '' }], div).error);
  assert.ok(R.validarGrupos([], div).error);
  assert.ok(R.validarGrupos(Array.from({ length: 13 }, (_, i) => ({ nombre: `G${i}` })), div).error);
});

test('JT-24 · qué le toca hoy al alumno y al MEP', () => {
  const rot = {
    nombre: 'Primer cuatri',
    estaciones: [{ _id: 'e1', nombre: 'Electricidad', course: 'c1' }, { _id: 'e2', nombre: 'Herrería', course: 'c2' }],
    periodos: [
      { desde: '2027-03-01', hasta: '2027-03-07', asignacion: [{ grupo: 'g1', estacion: 'e1' }, { grupo: 'g2', estacion: 'e2' }] },
      { desde: '2027-03-08', hasta: '2027-03-14', asignacion: [{ grupo: 'g1', estacion: 'e2' }, { grupo: 'g2', estacion: null }] },
    ],
  };
  const grupos = { grupos: [{ _id: 'g1', nombre: 'Grupo A', alumnos: ['a1', 'a2'] }, { _id: 'g2', nombre: 'Grupo B', alumnos: ['a3'] }] };
  const q = (o) => R.queLeToca({ rotaciones: [rot], grupos, ...o });
  assert.deepStrictEqual(q({ courseId: 'c1', userId: 'a1', esAlumno: true, hoy: '2027-03-03' }),
    { rotacion: 'Primer cuatri', desde: '2027-03-01', hasta: '2027-03-07', grupo: 'Grupo A', estacion: { nombre: 'Electricidad', course: 'c1' } });
  assert.strictEqual(q({ courseId: 'c1', userId: 'a3', esAlumno: true, hoy: '2027-03-10' }).estacion, null, 'su grupo no tiene estación');
  assert.strictEqual(q({ courseId: 'c1', userId: 'zz', esAlumno: true, hoy: '2027-03-03' }), null, 'no está en un grupo');
  assert.strictEqual(q({ courseId: 'c1', userId: 'a1', esAlumno: true, hoy: '2027-04-01' }), null, 'fuera de la rotación');
  assert.deepStrictEqual(q({ courseId: 'c2', userId: 'm', esAlumno: false, hoy: '2027-03-10' }).grupos, [{ nombre: 'Grupo A', alumnos: 2 }]);
  assert.deepStrictEqual(q({ courseId: 'c1', userId: 'm', esAlumno: false, hoy: '2027-03-10' }).grupos, []);
  assert.strictEqual(q({ courseId: 'c9', userId: 'm', esAlumno: false, hoy: '2027-03-10' }), null, 'materia que no es estación');
});

test('JT-25 · rutas de F4: escriben solo sus colecciones, editan los permitidos, auditan y filtran por escuela', () => {
  const { ROLES_EDITAN_ROTACION } = require('../../routes/tallerRotacion');
  assert.deepStrictEqual(ROLES_EDITAN_ROTACION, ['jefetaller', 'admin', 'superadmin']);
  const rutas = leer('routes', 'tallerRotacion.js');
  for (const m of rutas.matchAll(/(\w+)\.(updateMany|updateOne|create|insertMany|deleteMany|deleteOne|findOneAndUpdate|findOneAndDelete)\(/g)) {
    assert.ok(['GruposTaller', 'RotacionTaller'].includes(m[1]), m[0]);
  }
  for (const a of ['taller.grupos', 'taller.rotacion_crear', 'taller.rotacion_editar', 'taller.rotacion_borrar']) {
    assert.match(rutas, new RegExp(`logAudit\\(req, '${a.replace('.', '\\.')}'`), a);
    assert.match(leer('config', 'audit-actions.js'), new RegExp(`'${a.replace('.', '\\.')}'`), a);
  }
  // Cada POST pasa por soloEditores, y la rotación se busca siempre con su escuela.
  const posts = rutas.match(/router\.post\(/g).length;
  assert.strictEqual((rutas.match(/if \(soloEditores\(req, res\)\) return;/g) || []).length, posts);
  assert.match(rutas, /RotacionTaller\.findOne\(\{ _id: oid\(req\.params\.id\), school \}\)/);
  assert.match(rutas, /Course\.find\(\{ school, esTaller: true, division: oid\(divisionId\) \}\)/);
  assert.match(leer('routes', 'taller.js'), /router\.use\('\/rotacion', require\('\.\/tallerRotacion'\)\)/);
  // Backup.
  const { COLLECTIONS } = require('../../routes/backup');
  for (const n of ['grupostallers', 'rotaciontallers']) assert.ok(COLLECTIONS.some(c => c.name === n && c.optional), n);
  // La franja de la materia.
  assert.match(leer('routes', 'courses.js'), /course\.esTaller \? await franjaDeRotacion\(course, res\.locals\.user\) : null/);
  assert.match(leer('views', 'course.ejs'), /include\('partials\/rotacion-taller', \{ r: rotacionTaller \}\)/);
});
