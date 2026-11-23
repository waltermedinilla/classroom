// Jefe de Taller — F1 (specs/jefe-de-taller.spec.md).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const T = require('../../services/tallerAlcance');
const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

// ── JT-01 ────────────────────────────────────────────────────────────────────

test('JT-01 · el rol existe, aterriza en /taller y figura en todas las listas de roles', () => {
  const User = require('../../models/User');
  assert.ok(User.schema.path('role').enumValues.includes('jefetaller'));
  assert.match(leer('server.js'), /role === 'jefetaller'\) return res\.redirect\('\/taller'\)/);
  assert.match(leer('server.js'), /jefetaller: 'Jefe de Taller'/);
  // Cada lista que nombra a la secretaria también tiene que nombrar al jefe de taller.
  const archivos = [
    'routes/superadmin.js', 'routes/admin.js', 'views/admin/users.ejs', 'views/admin/user-form.ejs',
    'views/admin/user-profile.ejs', 'views/profile.ejs', 'views/superadmin/users.ejs',
    'views/superadmin/school-profile.ejs', 'views/superadmin/import.ejs', 'views/superadmin/monitor.ejs',
    'tests/roles/check-roles.js', 'config/sections.js',
  ];
  for (const a of archivos) assert.match(leer(...a.split('/')), /jefetaller/, a);
});

// ── JT-02 ────────────────────────────────────────────────────────────────────

test('JT-02 · sugerirTaller marca los talleres por el nombre y no las materias comunes', () => {
  for (const n of ['Prácticas de Taller de Electricidad II', 'Talleres pre-profesionaliz.', 'Prácticas Profesionalizantes (*)',
    'Prácticas Mecánicas II', 'Operaciones Mecánicas I', 'Operaciones Constructivas II', 'Taller de Soldadura',
    'Prácticas de Taller en Construcción II']) {
    assert.ok(T.sugerirTaller(n), n);
  }
  for (const n of ['Lengua', 'Matemática', 'Educación Tecnológica', 'Lengua y Literatura', 'Física', 'Taller de Lengua', '', null]) {
    assert.ok(!T.sugerirTaller(n), String(n));
  }
});

// ── JT-03 ────────────────────────────────────────────────────────────────────

test('JT-03 · la jefatura tiene el modo por-taller: alcance = materias con esTaller de la escuela', () => {
  const A = require('../../services/jefaturaAcceso');
  assert.strictEqual(A.modoJefatura('jefetaller'), 'por-taller');
  assert.deepStrictEqual(A.decidirAccesoJefatura({ role: 'jefetaller', school: 'x' }, 0), { entra: true, scopeAll: false });
  const mw = leer('middleware', 'jefatura.js');
  assert.match(mw, /Course\.find\(\{ school: user\.school, esTaller: true \}\)/);
  const Course = require('../../models/Course');
  assert.strictEqual(Course.schema.path('esTaller').defaultValue, false);
  assert.ok(Course.schema.indexes().some(([k]) => k.school === 1 && k.esTaller === 1));
});

// ── JT-04 ────────────────────────────────────────────────────────────────────

test('JT-04 · el Jefe de Taller no escribe en lo ajeno', () => {
  // Las únicas escrituras del panel son la marca esTaller y la nota del día (D3, F2).
  const rutas = leer('routes', 'taller.js');
  const escrituras = rutas.match(/\.(updateMany|updateOne|create|insertMany|deleteMany|deleteOne|findOneAndUpdate|findOneAndDelete|save)\(/g) || [];
  assert.deepStrictEqual([...new Set(escrituras)].sort(), ['.findOneAndDelete(', '.findOneAndUpdate(', '.updateMany(']);
  assert.match(rutas, /\{ \$set: \{ esTaller: true \} \}/);
  for (const m of rutas.matchAll(/(\w+)\.(findOneAndUpdate|findOneAndDelete)\(/g)) assert.strictEqual(m[1], 'NotaDocenteDia', m[0]);
  for (const m of rutas.matchAll(/(\w+)\.updateMany\(/g)) assert.strictEqual(m[1], 'Course', m[0]);
  // No es docente, preceptor ni secretaria para el resto del sistema.
  for (const [archivo, patron] of [
    ['middleware/secretaria.js', /jefetaller/],
    ['middleware/preceptor.js', /jefetaller/],
  ]) assert.doesNotMatch(leer(...archivo.split('/')), patron, archivo);
});

// ── JT-05 ────────────────────────────────────────────────────────────────────

test('JT-05 · marcar materias: jefe de taller, admin y superadmin; con auditoría y por escuela', () => {
  const { ROLES_MARCAN_TALLER, ROLES_PANEL_TALLER } = require('../../routes/taller');
  assert.deepStrictEqual(ROLES_MARCAN_TALLER, ['jefetaller', 'admin', 'superadmin']);
  assert.ok(ROLES_PANEL_TALLER.includes('directivo') && !ROLES_MARCAN_TALLER.includes('directivo'));
  for (const r of ['teacher', 'preceptor', 'student', 'secretaria', 'jefe']) assert.ok(!ROLES_PANEL_TALLER.includes(r), r);
  const rutas = leer('routes', 'taller.js');
  assert.match(rutas, /Course\.updateMany\(\{ _id: \{ \$in: marcar\.map\(oid\) \}, school \}/);
  assert.match(rutas, /logAudit\(req, 'taller\.materias'/);
  assert.ok(require('../../config/audit-actions').ACTIONS?.['taller.materias'] || /'taller\.materias'/.test(leer('config', 'audit-actions.js')));
});

// ── JT-06 ────────────────────────────────────────────────────────────────────

test('JT-06 · el resumen del día usa el mismo "Docentes del día" de la Secretaria', () => {
  const rutas = leer('routes', 'taller.js');
  assert.match(rutas, /const \{ filasDelDia \} = require\('\.\/secretaria'\);/);
  assert.match(rutas, /S\.docentesDelAlcance\(talleres, divisionIds\)/);
  assert.strictEqual(typeof require('../../routes/secretaria').filasDelDia, 'function');
});

// ── JT-07 ────────────────────────────────────────────────────────────────────

test('JT-07 · jefes y sus MEP: por sección, sin repetir, y un MEP en dos secciones sale en las dos', () => {
  const secciones = [
    { _id: 's1', name: 'ELECTRICIDAD', heads: ['j1'], divisions: ['d1'], courses: [] },
    { _id: 's2', name: 'MECÁNICA', heads: ['j2'], divisions: [], courses: ['c3'] },
    { _id: 's3', name: 'VACÍA', heads: ['j3'], divisions: ['d9'], courses: [] },
  ];
  const talleres = [
    { _id: 'c1', name: 'Prácticas Eléctricas', division: 'd1', owner: 'm1', coTeachers: ['m2'] },
    { _id: 'c2', name: 'Taller de Bobinado', division: 'd1', owner: 'm1', coTeachers: ['j1'] },
    { _id: 'c3', name: 'Operaciones Mecánicas', division: 'd5', owner: 'm2', coTeachers: [] },
  ];
  const nombres = new Map([['j1', 'Jefe Uno'], ['j2', 'Jefe Dos'], ['j3', 'Jefe Tres'], ['m1', 'Mep Uno'], ['m2', 'Mep Dos']]);
  const subidas = new Map([['m1', { actividades: 3, novedades: 1, ultima: new Date('2026-11-20') }]]);
  const r = T.jefesYMeps({ secciones, talleres, nombres, subidas });
  assert.deepStrictEqual(r.map(j => j.name), ['Jefe Dos', 'Jefe Tres', 'Jefe Uno']);
  const uno = r.find(j => j.id === 'j1');
  assert.deepStrictEqual(uno.meps.map(m => m.name), ['Mep Dos', 'Mep Uno'], 'el jefe que da un taller no es su propio MEP');
  assert.deepStrictEqual(uno.meps.find(m => m.id === 'm1').materias, ['Prácticas Eléctricas', 'Taller de Bobinado']);
  assert.strictEqual(uno.meps.find(m => m.id === 'm1').actividades, 3);
  assert.deepStrictEqual(r.find(j => j.id === 'j2').meps.map(m => m.id), ['m2'], 'Mep Dos también está en Mecánica');
  assert.deepStrictEqual(r.find(j => j.id === 'j3').meps, []);
});

test('el panel y las vistas: montado en /taller, con pie y sin nada sin escapar', () => {
  assert.match(leer('server.js'), /app\.use\('\/taller',\s+tallerRoutes\)/);
  for (const f of fs.readdirSync(path.join(raiz, 'views', 'taller'))) {
    const src = leer('views', 'taller', f);
    assert.doesNotMatch(src, /<%-(?!\s*include)/, f);
    if (!f.startsWith('_')) assert.match(src, /include\('\.\.\/partials\/footer'\)/, f);
  }
});

test('JT-08 · período: día, semana (lunes a domingo) o mes, sin futuro y en hora de Argentina', () => {
  const ahora = new Date('2026-11-23T02:30:00Z');   // domingo 22, 23:30 en Argentina
  const d = T.ventanaDelPeriodo('dia', '2026-11-20', ahora);
  assert.deepStrictEqual([d.inicio, d.fin, d.anterior, d.siguiente], ['2026-11-20', '2026-11-21', '2026-11-19', '2026-11-21']);
  assert.strictEqual(d.desde.toISOString(), '2026-11-20T03:00:00.000Z');
  const s = T.ventanaDelPeriodo('semana', '2026-11-20', ahora);
  assert.deepStrictEqual([s.inicio, s.fin, s.siguiente, s.esActual], ['2026-11-16', '2026-11-23', null, true]);
  assert.strictEqual(s.titulo, 'Semana del 16 nov al 22 nov');
  const m = T.ventanaDelPeriodo('mes', '2026-11-20', ahora);
  assert.deepStrictEqual([m.inicio, m.fin, m.anterior, m.titulo], ['2026-11-01', '2026-12-01', '2026-10-01', 'Noviembre de 2026']);
  assert.strictEqual(T.ventanaDelPeriodo('x', '2027-01-01', ahora).fecha, '2026-11-22', 'el futuro cae en hoy');
  assert.strictEqual(T.ventanaDelPeriodo('x', 'mal', ahora).periodo, 'semana');
  // Un mes de 31 días y el cambio de año.
  const dic = T.ventanaDelPeriodo('mes', '2025-12-31', ahora);
  assert.deepStrictEqual([dic.inicio, dic.fin, dic.siguiente], ['2025-12-01', '2026-01-01', '2026-01-01']);
});

test('JT-09 · qué hizo cada Sección: suma sus talleres y junta los que no tienen sección', () => {
  const secciones = [
    { _id: 's1', name: 'ELECTRICIDAD', heads: ['j1'], divisions: ['d1'], courses: [] },
    { _id: 's2', name: 'MECÁNICA', heads: [], divisions: [], courses: ['c3'] },
  ];
  const talleres = [
    { _id: 'c1', name: 'Prácticas Eléctricas', division: 'd1', owner: 'm1' },
    { _id: 'c2', name: 'Bobinado', division: 'd1', owner: 'm2' },
    { _id: 'c3', name: 'Operaciones Mecánicas', division: 'd5', owner: 'm1' },
    { _id: 'c4', name: 'Taller suelto', division: 'd8', owner: 'm3' },
  ];
  const porMateria = new Map([['c1', { actividades: 2, novedades: 1, clasesEnVivo: 3 }], ['c2', { actividades: 1, novedades: 0, clasesEnVivo: 0 }]]);
  const items = [{ tipo: 'actividad', titulo: 'A', course: 'c1', fecha: new Date('2026-11-20') }, { tipo: 'novedad', titulo: 'N', course: 'c2', fecha: new Date('2026-11-21') }];
  const r = T.resumenPorSeccion({ secciones, talleres, porMateria, items, nombres: new Map([['j1', 'Jefe Uno']]) });
  assert.deepStrictEqual(r.map(t => t.name), ['ELECTRICIDAD', 'MECÁNICA', 'Talleres sin sección']);
  const e = r[0];
  assert.deepStrictEqual([e.actividades, e.novedades, e.clasesEnVivo, e.cantidadMeps, e.jefes], [3, 1, 3, 2, ['Jefe Uno']]);
  assert.deepStrictEqual(e.ultimos.map(i => i.titulo), ['N', 'A'], 'lo último primero');
  assert.deepStrictEqual([r[1].actividades, r[1].jefes], [0, []]);
  assert.deepStrictEqual(r[2].materias.map(m => m.name), ['Taller suelto']);
});

test('JT-10 · el Jefe de Taller va al lado del directivo en las listas de roles', () => {
  const User = require('../../models/User');
  const roles = User.schema.path('role').enumValues;
  assert.strictEqual(roles.indexOf('jefetaller'), roles.indexOf('directivo') + 1);
  // Cada selector de rol que ofrece "Directivo" ofrece también "Jefe de Taller", justo después.
  for (const f of ['views/admin/users.ejs', 'views/admin/user-form.ejs', 'views/admin/user-profile.ejs', 'views/superadmin/users.ejs']) {
    const lineas = leer(...f.split('/')).split('\n');
    lineas.forEach((l, i) => {
      if (/<option value="directivo"/.test(l)) assert.match(lineas[i + 1], /<option value="jefetaller"/, `${f}:${i + 2}`);
    });
  }
  assert.match(leer('views', 'partials', 'directivo-nav.ejs'), /href="\/taller"/);
});
