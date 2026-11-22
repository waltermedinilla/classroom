// Dibujar sobre la pantalla compartida y archivos de la clase en miniatura
// (specs/sala-dibujo-y-archivos.spec.md).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const raiz = path.join(__dirname, '..', '..');
const D = require('../../public/js/transmision-dibujo');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

// ── DB-1 · coordenadas ───────────────────────────────────────────────────────

test('DB-1 · franjas a los costados: la imagen 4:3 en un recuadro 16:9', () => {
  // recuadro 1600×900, imagen 1200×900 escalada a 1200×900 → franjas de 200 a cada lado
  assert.deepStrictEqual(D.areaDeImagen(1600, 900, 1200, 900), { x: 200, y: 0, w: 1200, h: 900 });
  assert.deepStrictEqual(D.aNormal(1600, 900, 1200, 900, 800, 450), { x: 0.5, y: 0.5 });
  assert.deepStrictEqual(D.aNormal(1600, 900, 1200, 900, 200, 0), { x: 0, y: 0 });
  assert.strictEqual(D.aNormal(1600, 900, 1200, 900, 100, 450), null, 'en la franja negra no cuenta');
});

test('DB-1 · franjas arriba y abajo: una pantalla ancha en un recuadro más alto', () => {
  // recuadro 800×600, imagen 1920×1080 → 800×450, franjas de 75 arriba y abajo
  const a = D.areaDeImagen(800, 600, 1920, 1080);
  assert.deepStrictEqual(a, { x: 0, y: 75, w: 800, h: 450 });
  assert.deepStrictEqual(D.aNormal(800, 600, 1920, 1080, 400, 75), { x: 0.5, y: 0 });
  assert.strictEqual(D.aNormal(800, 600, 1920, 1080, 400, 20), null);
  assert.strictEqual(D.aNormal(800, 600, 0, 0, 10, 10), null, 'sin video todavía, nada');
});

test('DB4.6 · el lienzo no pasa de 1920 de ancho y respeta la proporción', () => {
  assert.deepStrictEqual(D.medidaLienzo(1366, 768), { w: 1366, h: 768 });
  assert.deepStrictEqual(D.medidaLienzo(3840, 2160), { w: 1920, h: 1080 });
  assert.deepStrictEqual(D.medidaLienzo(0, 0), { w: 1280, h: 720 });
});

// ── DB-2 · la lista de marcas ────────────────────────────────────────────────

test('DB-2 · lápiz, texto, deshacer y borrar', () => {
  const p = D.crearPizarra();
  p.empezar('lapiz', '#f00', { x: 0.1, y: 0.1 }, 0);
  p.seguir({ x: 0.2, y: 0.2 }, 10);
  p.seguir({ x: 0.2001, y: 0.2001 }, 11);   // casi pegado: no suma
  p.terminar(20);
  assert.strictEqual(p.marcas().length, 1);
  assert.strictEqual(p.marcas()[0].puntos.length, 2);

  p.texto({ x: 0.5, y: 0.5 }, '  mirá acá  ', '#ff0');
  p.texto({ x: 0.5, y: 0.5 }, '   ', '#ff0');   // vacío: no se agrega
  assert.strictEqual(p.marcas().length, 2);
  assert.strictEqual(p.marcas()[1].texto, 'mirá acá');

  p.deshacer();
  assert.deepStrictEqual(p.marcas().map(m => m.tipo), ['lapiz']);
  p.borrar();
  assert.strictEqual(p.marcas().length, 0);
});

test('DB-2 · el láser se desvanece solo y deshacer no lo cuenta', () => {
  const p = D.crearPizarra();
  p.empezar('lapiz', '#f00', { x: 0.1, y: 0.1 }, 0); p.terminar(0);
  p.empezar('laser', '#f00', { x: 0.3, y: 0.3 }, 100);
  p.seguir({ x: 0.4, y: 0.4 }, 150);
  assert.ok(p.vencer(5000), 'mientras se está trazando no vence');
  p.terminar(200);
  assert.ok(p.vencer(200 + D.LASER_MS - 1), 'todavía se ve');
  p.deshacer();   // saca el lápiz, no el láser
  assert.deepStrictEqual(p.marcas().map(m => m.tipo), ['laser']);
  assert.strictEqual(p.vencer(200 + D.LASER_MS + 1), false, 'ya se fue');
  assert.strictEqual(p.marcas().length, 0);
});

test('DB-2 · pintar dibuja sobre el área de la imagen, corrida', () => {
  const llamadas = [];
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...a) => { llamadas.push([k, ...a]); return { width: 50 }; }),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  D.pintar(ctx, [{ tipo: 'lapiz', color: '#f00', puntos: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], 800, 450, 0, 0, 75);
  assert.deepStrictEqual(llamadas.find(l => l[0] === 'moveTo'), ['moveTo', 0, 75]);
  assert.deepStrictEqual(llamadas.find(l => l[0] === 'lineTo'), ['lineTo', 800, 525]);
  assert.strictEqual(ctx.strokeStyle, '#f00');
});

// ── DB-3 · lo que viaja ──────────────────────────────────────────────────────

test('DB-3 · la pantalla se publica con stopTracks:false y despublicar suelta la captura', () => {
  const src = leer('public', 'js', 'transmision.js');
  const pub = src.slice(src.indexOf('async function publicarPantalla'), src.indexOf('async function publicarCamara'));
  assert.match(pub, /appData: \{ fuente: 'pantalla' \},[\s\S]*stopTracks: false,/);
  const desp = src.slice(src.indexOf('function despublicar'), src.indexOf('// ── Mirar'));
  assert.match(desp, /S\.locales\.get\(cual\)\?\.stop\(\)/);
  assert.match(src, /reemplazarPantalla: \(track\) =>/);
  assert.match(src, /pistaPantalla: \(\) => S\.locales\.get\('pantalla'\)/);
  assert.match(src, /window\.Transmision\?\.alPintar/);
});

test('DB-3 · el script del dibujo carga después de transmision.js', () => {
  const t = leer('views', 'partials', 'transmision.ejs');
  const a = t.indexOf('/js/transmision.js"'), b = t.indexOf('/js/transmision-dibujo.js"');
  assert.ok(a > 0 && b > a);
});

test('DB-4 · el dibujo no agrega id al HTML (Clásico queda igual)', () => {
  const t = leer('views', 'partials', 'transmision.ejs');
  assert.doesNotMatch(t, /id="txd/);
});

test('DB · los iconos de las herramientas están en la fuente recortada', () => {
  const head = leer('views', 'partials', 'head-iconos.ejs');
  for (const i of ['draw', 'edit', 'ink_highlighter', 'flare', 'title', 'undo', 'delete_sweep', 'perm_media', 'photo_library']) {
    assert.match(head, new RegExp('[,=]' + i + '[,&"]'), i);
  }
});

// ── AR · archivos de la clase ────────────────────────────────────────────────

const datos = require('./salaDisenos.datos');
const SD = require('../../config/salaDisenos');
const PARCIAL = path.join(raiz, 'views', 'partials', 'live-room.ejs');
const render = (rol, diseno) =>
  ejs.render(fs.readFileSync(PARCIAL, 'utf8'), datos.locals(rol, diseno, SD.paraVista()), { filename: PARCIAL });

test('AR-1 · la tira existe, arranca vacía y es un bloque de los diseños nuevos', () => {
  for (const rol of ['docente', 'alumno']) {
    const html = render(rol, 'mixto');
    assert.match(html, /<div class="lr-dis lrB-archivos" id="lrArchivos" data-n="0">/);
    assert.match(html, /id="lrArchSolDoc" data-grupo="docente"[^>]*>[\s\S]*?Archivos - Docente/);
    assert.match(html, /id="lrArchSolAlu" data-grupo="alumnos"[^>]*>[\s\S]*?Archivos - Alumnos/);
    // Va entre la conversación y el cuadro de escribir.
    assert.ok(html.indexOf('id="lrChat"') < html.indexOf('id="lrArchivos"'));
    assert.ok(html.indexOf('id="lrArchivos"') < html.indexOf('id="lrComposerBox"'));
  }
  const css = leer('views', 'partials', 'sala-disenos-estilos.ejs');
  assert.match(css, /\.lrB-archivos\[data-n="0"\] \{ display:none; \}/);
});

test('AR-2 · las miniaturas escapan lo que escribió una persona', () => {
  const src = leer('views', 'partials', 'live-room.ejs');
  const f = src.slice(src.indexOf('function pintarArchivos'), src.indexOf('// ── Mensajes'));
  assert.match(f, /esc\(\(a\.nombre \|\| ''\) \+ \(m\.autor/);
  assert.match(f, /alt="' \+ esc\(a\.nombre\)/);
  assert.match(f, /esc\(a\.ext\)/);
  assert.doesNotMatch(f, /\+ a\.(nombre|url|ext) \+/, 'nada crudo');
  // AR4: dos solapas, docente y alumnos; "alumnos" es solo el rol student.
  assert.match(src, /const grupoDe = \(m\) => \(m\.rol === 'student' \? 'alumnos' : 'docente'\);/);
  // Se anota con los mismos mensajes que se pintan.
  assert.match(src, /function pintarMensajes\(msgs, reemplazar\) \{\n    anotarArchivos\(msgs, reemplazar\);/);
});
