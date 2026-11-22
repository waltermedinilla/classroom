// Los diseños de la sala en vivo que elige el docente (specs/sala-disenos.spec.md).
//
// Lo que más importa probar acá no es que los diseños nuevos se vean lindos —eso se mira contra
// las maquetas en el navegador— sino que la sala Clásica, la que usan todas las clases, siga
// EXACTAMENTE como estaba (CA-7) y que el JavaScript siga encontrando cada elemento (CA-9).

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');
const crypto   = require('node:crypto');
const ejs      = require('ejs');

const raiz  = path.join(__dirname, '..', '..');
const live  = require(path.join(raiz, 'services', 'liveRoom'));
const SD    = require(path.join(raiz, 'config', 'salaDisenos'));
const datos = require('./salaDisenos.datos');
const antes = require(path.join(raiz, 'tests', 'fixtures', 'sala-clasico-antes.json'));

const PARCIAL = path.join(raiz, 'views', 'partials', 'live-room.ejs');
const ESTILOS = path.join(raiz, 'views', 'partials', 'sala-disenos-estilos.ejs');

const render = (rol, diseno, salaDisenos = SD.paraVista()) =>
  ejs.render(fs.readFileSync(PARCIAL, 'utf8'), datos.locals(rol, diseno, salaDisenos), { filename: PARCIAL });
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);

// Los id que agregaron los diseños. Todo lo demás tiene que estar como estaba, en el mismo orden.
const IDS_NUEVOS = new Set([
  'lrACab', 'lrAPill', 'lrAPillTxt', 'lrATitulo', 'lrASub', 'lrACabAcc', 'lrACabAviso',
  'lrAClase', 'lrAClaseFila', 'lrATogEscribir', 'lrATogFotos', 'lrAClaseSonido', 'lrAClaseBtns',
  'lrAChips', 'lrAChatEstado', 'lrDiseno', 'lrDisenoMenu',
  // B
  'lrBDisenoSlot', 'lrBSolapas', 'lrBNPresentes', 'lrBNManos', 'lrBPanel', 'lrBSlotClase', 'lrBManos',
  'lrBManosN', 'lrBManosSlot', 'lrBManosVacio', 'lrBSlotQuien', 'lrBQuienN', 'lrBQuien', 'lrChatAcc',
  'txBajoCuadro',
  // C
  'lrCReloj', 'lrCCuenta', 'lrCCuentaTxt', 'lrCBarra', 'lrCBarraTx', 'lrCBarraClase', 'lrCEscribir',
  'lrCFotos', 'lrCBarraFin',
  // D
  'lrDBarraChat', 'lrDChat', 'lrDChatTxt', 'txSonido', 'lrDCabTx', 'lrDLadoCaja', 'lrDLado', 'lrDLadoIco', 'lrDLadoTxt', 'lrDLadoN', 'lrDPuntos',
  // id agregados a elementos que YA existían (para poder mudarlos o ubicarlos en la grilla)
  'lrAviso', 'lrClasesAnt', 'lrPresencia', 'txBarra', 'txManoCaja', 'txTurnosTit',
]);

// ── CA-1 · disenoEfectivo ────────────────────────────────────────────────────

test('CA-1 · un diseño listo pasa; lo desconocido o vacío es Clásico', () => {
  assert.strictEqual(live.disenoEfectivo({ guardado: 'panel' }), 'panel');
  assert.strictEqual(live.disenoEfectivo({ guardado: 'aula' }), 'aula');
  for (const malo of [undefined, null, '', 'A', 'otro', 'Ordenada']) {
    assert.strictEqual(live.disenoEfectivo({ guardado: malo }), 'clasico', String(malo));
  }
});

test('CA-1 · un diseño que todavía no está listo se pinta en Clásico', () => {
  const disenos = [{ id: 'clasico', listo: true }, { id: 'panel', listo: false }];
  assert.strictEqual(live.disenoEfectivo({ guardado: 'panel', visibles: true, disenos }), 'clasico');
});

test('CA-1 · con el freno de mano puesto, siempre Clásico', () => {
  assert.strictEqual(live.disenoEfectivo({ guardado: 'panel', visibles: false }), 'clasico');
});

test('A "Ordenada" está retirado: no se ofrece, no se elige y lo guardado se ve en Clásico', () => {
  assert.strictEqual(live.disenoValido('ordenada'), false);
  assert.strictEqual(live.disenoEfectivo({ guardado: 'ordenada' }), 'clasico');
  assert.match(render('docente', 'ordenada'), /<div class="lr-wrap" data-diseno="clasico">/);
  assert.ok(!render('docente', 'clasico').includes('data-diseno="ordenada"'), 'el menú no lo ofrece');
});

test('disenoValido: solo los listos se pueden elegir', () => {
  assert.strictEqual(live.disenoValido('panel'), true);
  assert.strictEqual(live.disenoValido('clasico'), true);
  for (const d of SD.DISENOS.filter(x => !x.listo)) assert.strictEqual(live.disenoValido(d.id), false, d.id);
  assert.strictEqual(live.disenoValido('cualquiera'), false);
});

test('los enums de los modelos tienen los mismos ids que config/salaDisenos.js', () => {
  const User = require(path.join(raiz, 'models', 'User'));
  const RoomSession = require(path.join(raiz, 'models', 'RoomSession'));
  const lista = SD.DISENOS.map(d => d.id).sort();
  assert.deepStrictEqual([...User.schema.path('salaDiseno').enumValues].sort(), lista);
  assert.deepStrictEqual([...RoomSession.schema.path('settings.diseno').enumValues].sort(), lista);
  assert.strictEqual(User.schema.path('salaDiseno').defaultValue, 'clasico');
  assert.strictEqual(RoomSession.schema.path('settings.diseno').defaultValue, 'clasico');
});

test('leerPreferenciaDiseno: si la lectura falla, la sala abre en Clásico', async () => {
  const roto = { findById: () => { throw new Error('sin base'); } };
  assert.strictEqual(await live.leerPreferenciaDiseno(roto, 'u1'), 'clasico');
  const ok = { findById: () => ({ select: () => ({ lean: async () => ({ salaDiseno: 'aula' }) }) }) };
  assert.strictEqual(await live.leerPreferenciaDiseno(ok, 'u1'), 'aula');
});

// ── CA-7 · Clásico como estaba ───────────────────────────────────────────────

for (const rol of ['docente', 'alumno']) {
  test(`CA-7 · ⭐ Clásico (${rol}): los mismos elementos, en el mismo orden, que antes de los diseños`, () => {
    const ahora = ids(render(rol, 'clasico')).filter(id => !IDS_NUEVOS.has(id));
    assert.deepStrictEqual(ahora, antes[rol]);
  });

  test(`CA-7 · ⭐ Clásico (${rol}): el <style> propio de la sala no cambió ni un byte`, () => {
    const html = render(rol, 'clasico');
    // El primer <style> es el de la sala; el de los diseños va incluido después, pegado al
    // contenedor.
    const i = html.indexOf('<style>');
    const st = html.slice(i, html.indexOf('</style>', i) + 8);
    assert.strictEqual(crypto.createHash('sha256').update(st).digest('hex'), antes[rol + 'Estilo']);
  });
}

// ── CA-8 / CA-9 / CA-10 · la vista ───────────────────────────────────────────

test('CA-8 · el contenedor sale del servidor con la clase del diseño', () => {
  assert.match(render('docente', 'panel'), /<div class="lr-wrap lr-diseno-b" data-diseno="panel">/);
  // C NO fuerza el tema: sigue el botón claro/oscuro del sitio (pedido del 2026-11-22).
  assert.match(render('alumno', 'aula'), /<div class="lr-wrap lr-diseno-c" data-diseno="aula">/);
  assert.doesNotMatch(render('alumno', 'aula'), /class="lr-wrap[^"]*"[^>]*data-theme=/);

  assert.match(render('docente', 'clasico'), /<div class="lr-wrap" data-diseno="clasico">/);
  // Un valor desconocido, o el freno de mano, dan Clásico también en el render.
  assert.match(render('docente', 'inventado'), /<div class="lr-wrap" data-diseno="clasico">/);
  assert.match(render('docente', 'panel', { visibles: false, lista: [] }), /<div class="lr-wrap" data-diseno="clasico">/);
});

test('CA-9 · ⭐ todos los id de Clásico existen en cada diseño listo', () => {
  for (const rol of ['docente', 'alumno']) {
    const base = new Set(ids(render(rol, 'clasico')));
    for (const d of SD.DISENOS.filter(x => x.listo)) {
      const otro = new Set(ids(render(rol, d.id)));
      const faltan = [...base].filter(id => !otro.has(id));
      assert.deepStrictEqual(faltan, [], `${rol} en ${d.id}`);
    }
  }
});

test('CA-9 · ningún id se repite en ningún diseño', () => {
  for (const rol of ['docente', 'alumno']) {
    for (const d of SD.DISENOS.filter(x => x.listo)) {
      const lista = ids(render(rol, d.id));
      const repetidos = lista.filter((id, i) => lista.indexOf(id) !== i);
      assert.deepStrictEqual(repetidos, [], `${rol} en ${d.id}`);
    }
  }
});

test('CA-10 · el selector es del docente; el alumno no lo tiene; con el freno, nadie', () => {
  assert.ok(render('docente', 'clasico').includes('id="lrDiseno"'));
  assert.ok(!render('alumno', 'clasico').includes('id="lrDiseno"'));
  assert.ok(!render('docente', 'clasico', { visibles: false, lista: [] }).includes('id="lrDiseno"'));
});

test('CA-10 · el menú ofrece solo los diseños listos', () => {
  const html = render('docente', 'clasico');
  const ofrecidos = [...html.matchAll(/role="menuitemradio" data-diseno="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ofrecidos, SD.DISENOS.filter(d => d.listo).map(d => d.id));
});

// ── CA-11 · los controles nuevos delegan ─────────────────────────────────────

test('CA-11 · cada control nuevo delega en un id que existe y no trae lógica propia', () => {
  const html = render('docente', 'panel');
  const todos = new Set(ids(html));
  const delegados = [...html.matchAll(/data-delega="([^"]+)"/g)].map(m => m[1]);
  // Los dos interruptores de A/B y los dos botones redondos de C.
  assert.deepStrictEqual(delegados.sort(), ['lrFotos', 'lrFotos', 'lrModo', 'lrModo']);
  for (const d of delegados) assert.ok(todos.has(d), `data-delega="${d}" no existe`);
  // Ningún onclick inline en los bloques del diseño.
  assert.doesNotMatch(html, /class="[^"]*lrA-[^"]*"[^>]*onclick=/);
});

test('las mudanzas del script apuntan a id que existen (en el render del docente o del alumno)', () => {
  const todos = new Set([...ids(render('docente', 'clasico')), ...ids(render('alumno', 'clasico'))]);
  const bloque = fs.readFileSync(PARCIAL, 'utf8').match(/const MUDANZAS = \{([\s\S]*?)\n  \};/)[1];
  const disenos = [...bloque.matchAll(/^\s{4}(\w+): \[/gm)].map(m => m[1]);
  assert.deepStrictEqual(disenos, ['panel', 'aula', 'mixto'], 'una lista de mudanzas por diseño en uso');
  const pares = [...bloque.matchAll(/\['(\w+)',\s*'(\w+)'\]/g)];
  assert.ok(pares.length > 30);
  // Un nodo puede faltar en un render (el de otro rol, o un módulo apagado: acomodarDiseno lo
  // saltea), pero tiene que existir en ALGUNO. Si no, es un error de tipeo y nunca se mudaría.
  for (const [, nodo, lugar] of pares) {
    assert.ok(todos.has(lugar), `el lugar ${lugar} no existe`);
    assert.ok(todos.has(nodo), `el nodo ${nodo} no existe`);
  }
});

// ── CA-14 · el CSS nuevo no toca Clásico ─────────────────────────────────────

test('CA-14 · ⭐ ninguna regla del CSS de los diseños sin prefijo de diseño', () => {
  const fuente = fs.readFileSync(ESTILOS, 'utf8').replace(/<%#[\s\S]*?%>/g, '');
  const estilo = fuente.slice(fuente.indexOf('<style>') + 7, fuente.indexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Se aplanan los @media: lo que importa son los selectores de adentro.
  const selectores = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  // Separa por las comas de primer nivel: las de adentro de :is(...) son del mismo selector.
  const partir = (txt) => {
    const out = []; let nivel = 0, actual = '';
    for (const c of txt) {
      if (c === '(') nivel++;
      if (c === ')') nivel--;
      if (c === ',' && nivel === 0) { out.push(actual); actual = ''; } else actual += c;
    }
    return out.concat(actual);
  };
  let m;
  while ((m = re.exec(estilo.replace(/@media[^{]+\{/g, ''))) !== null) {
    for (const sel of partir(m[1])) selectores.push(sel.replace(/\s+/g, ' ').trim());
  }
  assert.ok(selectores.length > 20);
  const permitido = (sel) =>
    /^(\[data-theme="dark"\]\s*)?(:is\(\.lr-diseno-[abcd][^)]*\)|\.lr-diseno-[abcd]\b)/.test(sel) ||
    /^\.lr-wrap:not\(\.lr-diseno-[abcd]\)/.test(sel) ||
    /^\.lr-wrap\.lr-diseno-[abcd]\b/.test(sel);
  assert.deepStrictEqual(selectores.filter(s => s && !permitido(s)), []);
});

test('CA-14 · cada fondo fijo del CSS de los diseños declara su color de texto o no lleva texto', () => {
  const fuente = fs.readFileSync(ESTILOS, 'utf8').replace(/<%#[\s\S]*?%>/g, '');
  const estilo = fuente.slice(fuente.indexOf('<style>') + 7, fuente.indexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '');
  const SIN_TEXTO = /(lrA-switch|lrA-pill(\.off)? i|\.c-(on|act|est|off)|lrA-chip, \.lrB-g-tit\) i|lrB-n-rojo|button\.nuevo::after|lrC-volver)/;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const culpables = [];
  let m;
  while ((m = re.exec(estilo)) !== null) {
    const sel = m[1].trim(), decl = m[2];
    const fondoHex = /background(?:-color)?\s*:\s*#[0-9a-f]{3,8}/i.test(decl);
    const colorHex = /(^|;)\s*color\s*:\s*#[0-9a-f]{3,8}/i.test(decl);
    if (fondoHex && !colorHex && !SIN_TEXTO.test(sel)) culpables.push(sel);
  }
  assert.deepStrictEqual(culpables, []);
});

// ── La ruta y el poll ────────────────────────────────────────────────────────

test('con la sala cerrada, el docente ve su diseño preferido y el resto Clásico', () => {
  const src = fs.readFileSync(path.join(raiz, 'routes', 'rooms.js'), 'utf8');
  const i = src.indexOf("estado: 'cerrada'");
  const rama = src.slice(i, src.indexOf('apertura: null', i));
  assert.match(rama, /diseno: req\.esGestor\s*\?\s*live\.disenoEfectivo\(\{ guardado: req\.res && req\.res\.locals\.user && req\.res\.locals\.user\.salaDiseno \}\)\s*:\s*'clasico'/);
});

test('la ruta del selector existe, exige gestor y valida contra la lista', () => {
  const src = fs.readFileSync(path.join(raiz, 'routes', 'rooms.js'), 'utf8');
  const i = src.indexOf("router.post('/:id/sala/diseno'");
  assert.ok(i > -1);
  const cuerpo = src.slice(i, src.indexOf('\n});', i));
  assert.match(cuerpo, /if \(!req\.esGestor\) return fallar\(req, res, 403/);
  assert.match(cuerpo, /live\.disenoValido\(diseno\)/);
  // Con la sala cerrada no hay 409: se guarda como preferencia (la próxima clase abre así).
  assert.doesNotMatch(cuerpo, /fallar\(req, res, 409/);
  assert.match(cuerpo, /if \(session\) \{\s*await RoomSession\.updateOne/);
  assert.match(cuerpo, /User\.updateOne\(\{ _id: req\.userId \}, \{ \$set: \{ salaDiseno: diseno \} \}\)/);
  assert.match(cuerpo, /logAudit\(req, 'room\.diseno'/);
});

test('room.diseno está en el catálogo de auditoría', () => {
  const acciones = require(path.join(raiz, 'config', 'audit-actions'));
  const catalogo = acciones.AUDIT_ACTIONS || acciones.ACTIONS || acciones;
  assert.ok(catalogo['room.diseno'], 'falta room.diseno');
});
