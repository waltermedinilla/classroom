// Tests de los dos barridos que verifican el árbol antes de pushear (tools/arbol.js).
// Correr con: npm run test:unit
//
// Qué se protege acá. El 2026-08-29 producción se cayó con 502 por un `require` a un archivo
// que existía SOLO en la carpeta de trabajo: nunca se había commiteado. Los 686 tests, el
// smoke y los roles pasaron en la máquina de desarrollo justamente porque el archivo estaba
// ahí. En el VPS, que hace `git reset --hard origin/main`, Node moría al arrancar y PM2
// reintentaba en loop.
//
// `npm run verificar:arbol` es la red para eso, y esta suite es la red de la red: si los
// barridos dejan de ver los faltantes, el comando pasa a dar un OK que no verificó nada, que
// es peor que no tenerlo. Por eso cada caso arma un árbol de mentira con el problema adentro
// y exige que lo encuentre.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { revisarReferencias, revisarDependencias, nombreDePaquete } = require('../../tools/arbol');

// Arma un árbol temporal: { 'ruta/archivo.js': 'contenido' }. Se borra al terminar el test.
function arbolDeMentira(archivos) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'arbol-test-'));
  for (const [rel, contenido] of Object.entries(archivos)) {
    const destino = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  }
  return raiz;
}
const borrar = (raiz) => fs.rmSync(raiz, { recursive: true, force: true });

test('revisarReferencias', async (t) => {
  await t.test('⭐ encuentra el require a un archivo que no está en el árbol', () => {
    const raiz = arbolDeMentira({
      'routes/backup.js': "const S = require('../models/SoeRequest');\n",
      'models/User.js': 'module.exports = {};\n',
    });
    try {
      const { faltantes } = revisarReferencias(raiz);
      assert.strictEqual(faltantes.length, 1, 'tiene que ver el único require roto');
      assert.strictEqual(faltantes[0].ref, '../models/SoeRequest');
      assert.strictEqual(faltantes[0].tipo, 'require');
      assert.strictEqual(faltantes[0].archivo, 'routes/backup.js');
    } finally { borrar(raiz); }
  });

  await t.test('⭐ ve el require perezoso, el que vive adentro de un handler', () => {
    // Este es el caso exacto del 502: arrancar el server NO ejecuta esta línea.
    const raiz = arbolDeMentira({
      'routes/soe.js': [
        "router.post('/pedido', async (req, res) => {",
        "  const Pedido = require('../models/SoePedido');",
        '  res.json({ ok: true });',
        '});',
      ].join('\n'),
    });
    try {
      const { faltantes } = revisarReferencias(raiz);
      assert.deepStrictEqual(faltantes.map(f => f.ref), ['../models/SoePedido']);
    } finally { borrar(raiz); }
  });

  await t.test('resuelve las cuatro formas que resuelve Node', () => {
    const raiz = arbolDeMentira({
      'a.js': [
        "require('./exacto.js');",
        "require('./sin-extension');",
        "require('./datos.json');",
        "require('./carpeta');",
      ].join('\n'),
      'exacto.js': '', 'sin-extension.js': '', 'datos.json': '{}',
      'carpeta/index.js': '',
    });
    try {
      assert.deepStrictEqual(revisarReferencias(raiz).faltantes, []);
    } finally { borrar(raiz); }
  });

  await t.test('el include de EJS: relativo y desde la raíz de views/', () => {
    const raiz = arbolDeMentira({
      'views/profile.ejs': "<%- include('partials/chip-verificado') %>",
      'views/partials/chip-verificado.ejs': '<span></span>',
      'views/admin/users.ejs': "<%- include('../partials/contact-info') %>",
      'views/partials/contact-info.ejs': '<span></span>',
    });
    try {
      assert.deepStrictEqual(revisarReferencias(raiz).faltantes, []);
    } finally { borrar(raiz); }
  });

  await t.test('un include a un partial inexistente no pasa', () => {
    const raiz = arbolDeMentira({ 'views/sala.ejs': "<%- include('partials/transmision') %>" });
    try {
      const { faltantes } = revisarReferencias(raiz);
      assert.strictEqual(faltantes.length, 1);
      assert.strictEqual(faltantes[0].tipo, 'include');
    } finally { borrar(raiz); }
  });

  await t.test('no mira adentro de node_modules', () => {
    const raiz = arbolDeMentira({
      'node_modules/loquesea/index.js': "require('./esto-no-existe');",
      'server.js': '',
    });
    try {
      assert.deepStrictEqual(revisarReferencias(raiz).faltantes, []);
    } finally { borrar(raiz); }
  });

  await t.test('⭐ no entra a las carpetas con punto: .claude/worktrees son copias del repo', () => {
    // Sin este corte, cada hallazgo se informa una vez por worktree, con rutas que no existen
    // en el deploy, y el barrido pasa de 181 archivos a 786.
    const raiz = arbolDeMentira({
      '.claude/worktrees/otra/routes/x.js': "require('./no-existe');",
      'server.js': '',
    });
    try {
      assert.deepStrictEqual(revisarReferencias(raiz).faltantes, []);
    } finally { borrar(raiz); }
  });

  await t.test('⭐ los tests quedan afuera: sus árboles de mentira son texto, no require', () => {
    // Un test que arma un fixture escribe require('../models/X') como string literal. El
    // barrido no puede distinguirlo de uno real, y ese falso positivo dejaría el comando en
    // rojo permanente, que es la forma de que nadie lo mire más.
    const raiz = arbolDeMentira({
      'tests/unit/algo.test.js': "const fixture = \"require('../models/Inventado')\";",
      'server.js': '',
    });
    try {
      assert.deepStrictEqual(revisarReferencias(raiz).faltantes, []);
    } finally { borrar(raiz); }
  });
});

test('revisarDependencias', async (t) => {
  const pkg = (deps = {}, dev = {}) => JSON.stringify({ dependencies: deps, devDependencies: dev });

  await t.test('⭐ el paquete sin declarar que usa código que se despliega', () => {
    const raiz = arbolDeMentira({
      'package.json': pkg({ express: '^4.0.0' }),
      'services/x.js': "const { MongoClient } = require('mongodb');\nrequire('express');\n",
    });
    try {
      const { sinDeclarar } = revisarDependencias(raiz);
      assert.deepStrictEqual(sinDeclarar.map(d => d.nombre), ['mongodb']);
      assert.strictEqual(sinDeclarar[0].seDespliega, true);
    } finally { borrar(raiz); }
  });

  await t.test('⭐ NO pica la interpolación del deployCmd: es texto de shell, no un require', () => {
    // server.js arma el comando de deploy como string y adentro va un `node -p "require(...)"`
    // que corre en el VPS. Sin este descarte, el comando nace en rojo y se ignora.
    const raiz = arbolDeMentira({
      'package.json': pkg(),
      'server.js': 'const cmd = `DISK=$(node -p "require(\'${APP_DIR}/package.json\').version")`;\n',
    });
    try {
      assert.deepStrictEqual(revisarDependencias(raiz).sinDeclarar, []);
    } finally { borrar(raiz); }
  });

  await t.test('los builtin y los node: no cuentan', () => {
    const raiz = arbolDeMentira({
      'package.json': pkg(),
      'a.js': "require('fs');require('path');require('node:test');require('crypto');\n",
    });
    try {
      assert.deepStrictEqual(revisarDependencias(raiz).sinDeclarar, []);
    } finally { borrar(raiz); }
  });

  await t.test('tests/ y tools/ pueden usar devDependencies sin que sea grave', () => {
    const raiz = arbolDeMentira({
      'package.json': pkg(),
      'tests/unit/a.test.js': "require('paquete-de-dev');\n",
    });
    try {
      const { sinDeclarar } = revisarDependencias(raiz);
      assert.strictEqual(sinDeclarar.length, 1);
      assert.strictEqual(sinDeclarar[0].seDespliega, false, 'tests/ no se despliega');
    } finally { borrar(raiz); }
  });

  await t.test('el subpath declara el paquete, y el @scope se toma entero', () => {
    assert.strictEqual(nombreDePaquete('mongoose/lib/x'), 'mongoose');
    assert.strictEqual(nombreDePaquete('@scope/pkg/sub'), '@scope/pkg');
    assert.strictEqual(nombreDePaquete('express'), 'express');
  });

  await t.test('public/ es JS de navegador: no se le miran los require', () => {
    const raiz = arbolDeMentira({
      'package.json': pkg(),
      'public/js/course.js': "require('esto-es-del-navegador');\n",
    });
    try {
      assert.deepStrictEqual(revisarDependencias(raiz).sinDeclarar, []);
    } finally { borrar(raiz); }
  });
});

// ── El árbol de verdad, el de este repositorio ───────────────────────────────
// Los de arriba prueban que los barridos VEN. Este prueba que hoy no hay nada que ver.
test('⭐ este repositorio no tiene ninguna referencia colgada', () => {
  const raiz = path.join(__dirname, '..', '..');
  const { faltantes } = revisarReferencias(raiz);

  assert.deepStrictEqual(faltantes, [],
    'Estas referencias no resuelven, y cada una tumba producción al desplegar:\n' +
    faltantes.map(f => `  · ${f.tipo}  ${f.archivo}  →  ${f.ref}`).join('\n') +
    '\n\nSe mira con:  npm run verificar:arbol\n');
});

test('todo paquete que se despliega está instalado, aunque no esté declarado', () => {
  const raiz = path.join(__dirname, '..', '..');
  const { sinDeclarar } = revisarDependencias(raiz);
  const rompen = sinDeclarar.filter(d => d.seDespliega && !d.resuelveHoy);

  assert.deepStrictEqual(rompen.map(d => d.nombre), [],
    'Estos paquetes no están en package.json NI instalados: el npm install del VPS no los va\n' +
    'a traer y el server no arranca.\n');
});
