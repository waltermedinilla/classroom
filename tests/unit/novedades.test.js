// Novedades guiadas — specs/recorrido-novedades.spec.md.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const N = require('../../config/novedades');
const { cuentasDeNovedad } = require('../../services/novedadesCuentas');
const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

const escuelaCon = (personas, { alcance = 'lista', enabled = true } = {}) =>
  ({ _id: 's1', name: 'Escuela', modules: { transmision: { enabled, alcance, personas } } });
const U = (id, role, extra = {}) => ({ _id: id, name: 'U' + id, role, school: 's1', ...extra });
const RUTA = '/courses/6a2229fce256f3bb84930a9d';
const HOY = '2026-11-27';

test('NV-01/02 · transmitir: al docente habilitado sí; al no habilitado y con el módulo apagado, no', () => {
  const tx = N.POR_ID.transmitir;
  const esc = escuelaCon(['d1']);
  assert.ok(N.corresponde(tx, { user: U('d1', 'teacher'), school: esc, hoy: HOY }));
  assert.ok(!N.corresponde(tx, { user: U('d2', 'teacher'), school: esc, hoy: HOY }), 'no está en "¿Quiénes pueden transmitir?"');
  assert.ok(!N.corresponde(tx, { user: U('d1', 'teacher'), school: escuelaCon(['d1'], { enabled: false }), hoy: HOY }), 'módulo apagado');
  assert.ok(N.corresponde(tx, { user: U('d9', 'teacher'), school: escuelaCon([], { alcance: 'todos' }), hoy: HOY }), 'alcance "todos"');
  assert.ok(!N.corresponde(tx, { user: U('d1', 'teacher'), school: esc, hoy: '2026-11-25' }), 'antes de "desde"');
  const lista = N.novedadesPara({ user: U('d1', 'teacher'), school: esc, ruta: RUTA, hoy: HOY });
  assert.deepStrictEqual(lista.map(n => n.id), ['transmitir']);
  assert.strictEqual(lista[0].pasos[0].donde, '#txAbrir');
  assert.ok(!('roles' in lista[0]) && !('pantalla' in lista[0]), 'al navegador va solo lo visual');
  assert.deepStrictEqual(N.novedadesPara({ user: U('d1', 'teacher'), school: esc, ruta: '/dashboard', hoy: HOY }), [], 'otra pantalla');
});

test('NV-03 · por rol: alumno, preceptor y secretaria nunca', () => {
  const esc = escuelaCon(['a1', 'p1', 's1'], { alcance: 'todos' });
  for (const role of ['student', 'preceptor', 'secretaria']) {
    assert.deepStrictEqual(N.novedadesPara({ user: U('x', role), school: esc, ruta: RUTA, hoy: HOY }), [], role);
  }
});

test('NV-01 · una vez por persona; "volver a ver" la deja pendiente otra vez; suplantando, nada', () => {
  const esc = escuelaCon(['d1']);
  const vista = U('d1', 'teacher', { novedadesVistas: [{ id: 'transmitir', como: 'entendido', repetidaEn: null }] });
  assert.deepStrictEqual(N.novedadesPara({ user: vista, school: esc, ruta: RUTA, hoy: HOY }), []);
  const repetir = U('d1', 'teacher', { novedadesVistas: [{ id: 'transmitir', como: 'entendido', repetidaEn: new Date() }] });
  assert.strictEqual(N.novedadesPara({ user: repetir, school: esc, ruta: RUTA, hoy: HOY }).length, 1);
  assert.deepStrictEqual(N.novedadesPara({ user: U('d1', 'teacher'), school: esc, ruta: RUTA, hoy: HOY, impersonando: true }), []);
});

test('NV-05/06/07 · varias novedades, centradas y de varios pasos, de la más vieja a la más nueva', () => {
  const extra = [
    { id: 'b-nueva', desde: '2026-11-20', roles: ['teacher'], pantalla: /^\/x$/, pasos: [{ donde: null, titulo: 'T', texto: 'x' }] },
    { id: 'a-vieja', desde: '2026-11-01', roles: ['teacher'], pantalla: /^\/x$/,
      pasos: [{ donde: '#a', titulo: '1', texto: 'x' }, { donde: '#b', titulo: '2', texto: 'x' }, { donde: '#c', titulo: '3', texto: 'x' }] },
  ];
  assert.ok(N.validarNovedades(extra));
  const r = N.novedadesPara({ user: U('d', 'teacher'), school: null, ruta: '/x', hoy: HOY, lista: extra });
  assert.deepStrictEqual(r.map(n => n.id), ['a-vieja', 'b-nueva']);
  assert.strictEqual(r[1].pasos[0].donde, null);
  assert.strictEqual(r[0].pasos.length, 3);
  // RN-5: vencida no se muestra.
  const vencida = [{ ...extra[0], id: 'vencida', hasta: '2026-11-21' }];
  assert.deepStrictEqual(N.novedadesPara({ user: U('d', 'teacher'), school: null, ruta: '/x', hoy: HOY, lista: vencida }), []);
});

test('NV-09 · la lista rechaza al arrancar ids repetidos, roles o módulos inexistentes', () => {
  const base = { id: 'ok', desde: '2026-11-01', roles: ['teacher'], pantalla: /x/, pasos: [{ donde: null, titulo: 't', texto: 'x' }] };
  assert.throws(() => N.validarNovedades([base, { ...base }]), /repetido/);
  assert.throws(() => N.validarNovedades([{ ...base, roles: ['rey'] }]), /rol que no existe/);
  assert.throws(() => N.validarNovedades([{ ...base, modulo: 'teletransporte' }]), /módulo que no existe/);
  assert.throws(() => N.validarNovedades([{ ...base, id: 'Con Espacios' }]), /id/);
  assert.throws(() => N.validarNovedades([{ ...base, pasos: [] }]), /paso/);
  assert.throws(() => N.validarNovedades([{ ...base, pantalla: '/x' }]), /expresión regular/);
});

test('NV-08 · rutas: id inventado → 400, con sesión, sin duplicar, y "repetir" sin borrar', () => {
  const r = leer('routes', 'novedades.js');
  assert.match(r, /if \(!POR_ID\[id\]\) return res\.status\(400\)/);
  assert.match(r, /router\.post\('\/novedades\/:id\/vista', requireAuth/);
  assert.match(r, /router\.post\('\/novedades\/repetir', requireAuth/);
  assert.match(r, /'novedadesVistas\.id': \{ \$ne: id \}/, 'el $push no duplica');
  assert.match(r, /'novedadesVistas\.\$\[e\]\.repetidaEn': new Date\(\)/, 'repetir marca, no borra');
  assert.doesNotMatch(r, /\$pull/);
  assert.match(r, /res\.locals\.impersonating/);
  assert.match(leer('server.js'), /app\.use\('\/',\s+novedadesRoutes\)/);
});

test('NV-10 · el navegador arma los textos con nodos, nunca con innerHTML; el footer escapa', () => {
  const js = leer('public', 'js', 'novedades.js');
  assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /textContent = paso\.titulo/);
  assert.match(js, /document\.createTextNode\(trozo\)/);
  const footer = leer('views', 'partials', 'footer.ejs');
  assert.match(footer, /data-lista="<%= JSON\.stringify\(locals\.novedades\) %>"/);
  assert.match(footer, /<% if \(locals\.novedades && locals\.novedades\.length\) \{ %>/, 'sin novedades no baja el script');
  const ejs = require('ejs');
  const html = ejs.render('<div data-lista="<%= JSON.stringify(n) %>"></div>', { n: [{ id: 'x', pasos: [{ titulo: '<b>"', texto: '</div><script>' }] }] });
  assert.doesNotMatch(html, /<script>/);
});

test('NV-12 · la cuenta del superadmin: 3 habilitados, 1 no habilitado, 2 la vieron', () => {
  const tx = N.POR_ID.transmitir;
  const escuelas = new Map([['s1', escuelaCon(['d1', 'd2', 'd3'])]]);
  const usuarios = [
    U('d1', 'teacher', { novedadesVistas: [{ id: 'transmitir', como: 'entendido', fecha: new Date() }] }),
    U('d2', 'teacher', { novedadesVistas: [{ id: 'transmitir', como: 'omitir', fecha: new Date(), repetidaEn: new Date() }] }),
    U('d3', 'teacher'),
    U('d4', 'teacher', { novedadesVistas: [{ id: 'transmitir', como: 'entendido' }] }),   // no habilitado: no cuenta
    U('a1', 'student'),
    U('d5', 'teacher', { active: false }),
  ];
  const c = cuentasDeNovedad(tx, { usuarios, escuelas });
  assert.deepStrictEqual([c.corresponden, c.vieron, c.entendido, c.omitir, c.pct], [3, 2, 1, 1, 67]);
  assert.deepStrictEqual(c.listaFaltan.map(u => u.id), ['d3']);
  const sa = leer('routes', 'superadmin.js');
  assert.match(sa, /router\.get\('\/novedades'/);
  assert.match(sa, /router\.use\(requireAuth, requireSuperAdmin\)/, 'todo /superadmin es solo del superadmin');
  assert.match(leer('views', 'partials', 'superadmin-nav.ejs'), /href="\/superadmin\/novedades"/);
});

test('NV-13 · Mi perfil: "Volver a ver las novedades" para cualquier rol que tenga alguna', () => {
  const perfil = leer('views', 'profile.ejs');
  assert.match(perfil, /typeof novedadesPerfil !== 'undefined' && novedadesPerfil > 0/);
  assert.match(perfil, /fetch\('\/novedades\/repetir'/);
  assert.match(leer('server.js'), /res\.locals\.novedadesPerfil = res\.locals\.impersonating \? 0 : queLeCorresponden\(ctx\)\.length/);
  const esc = escuelaCon(['d1']);
  assert.strictEqual(N.queLeCorresponden({ user: U('d1', 'teacher'), school: esc, hoy: HOY }).length, 1);
  assert.strictEqual(N.queLeCorresponden({ user: U('a1', 'student'), school: esc, hoy: HOY }).length, 0);
});

test('D6 · la regla de trabajo quedó escrita en agente.md', () => {
  assert.match(leer('agente.md'), /¿lleva novedad guiada\?/i);
});
