#!/usr/bin/env node
// Mapa de cobertura: qué rutas de routes/*.js NO ejercita ningún test.
//
//   node tools/cobertura-rutas.js              # todas las rutas sin tocar
//   node tools/cobertura-rutas.js --con-objectid   # medición laxa (ver abajo)
//
// No necesita el server levantado ni la base: es análisis estático. Lee los montajes de
// server.js, saca las rutas de cada router, y las cruza contra las URLs que aparecen en
// tests/smoke/specs.js y tests/roles/check-roles.js.
//
// ⚠️ POR QUÉ SE EXCLUYE `objectid-invalido-da-404` POR DEFECTO
// Ese spec NOMBRA 384 rutas para pegarles con un id mal formado. Contarlas como cubiertas
// da 45 rutas sin tocar donde en realidad hay 45 + las 100 y pico que solo se probaron
// contra un id inválido. La medición laxa daba 9 y era mentira. Que una ruta figure ahí
// significa "se verificó que no se cuelga", no "está probada".
//
// ⚠️ Lo que este script NO sabe
// Matchea por texto. Una ruta cuya URL el test arma por pedazos (`base + '/' + tipo`) le
// va a figurar como sin tocar aunque esté probada — pasa hoy con los adjuntos de la sala.
// Sirve para encontrar huecos, no para dar una nota.
const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── 1) Montajes desde server.js ─────────────────────────────────────────────
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const requires = {};
for (const m of server.matchAll(/const\s+(\w+)\s*=\s*require\(['"]\.\/routes\/([\w-]+)['"]\)/g)) {
  requires[m[1]] = m[2];
}
const mounts = [];
for (const m of server.matchAll(/app\.use\(\s*'([^']*)'\s*,([^)]*)\)/g)) {
  const [, prefix, args] = m;
  for (const [v, file] of Object.entries(requires)) {
    const hit = args.match(new RegExp(`\\b${v}\\b(\\.(\\w+))?`));
    if (hit) mounts.push({ prefix, file, sub: hit[2] || null });
  }
}

// ── 2) Rutas de cada router ─────────────────────────────────────────────────
// Ojo con los routers múltiples en un mismo archivo (attendance.js declara dos): sin el
// filtro por variable, las rutas del segundo se cuelgan del prefijo del primero.
const rutas = [];
const vistas = new Set();
for (const { prefix, file, sub } of mounts) {
  const p = path.join(ROOT, 'routes', file + '.js');
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  const routerVars = [...src.matchAll(/(?:const|let|var)\s+(\w*[Rr]outer\w*)\s*=\s*express\.Router\(/g)].map(m => m[1]);
  const target = sub || (routerVars.length === 1 ? routerVars[0] : 'router');
  for (const m of src.matchAll(/^\s*(\w+)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gm)) {
    const [, v, method, rp] = m;
    if (!routerVars.includes(v)) continue;
    if (routerVars.length > 1 && v !== target) continue;
    const full = ((prefix === '/' ? '' : prefix) + (rp === '/' ? '' : rp)) || '/';
    const key = `${method.toUpperCase()} ${full}`;
    if (vistas.has(key)) continue;
    vistas.add(key);
    rutas.push({ key, method: method.toUpperCase(), full, file });
  }
}

// ── 3) URLs que nombran los tests ───────────────────────────────────────────
let testSrc = ['tests/smoke/specs.js', 'tests/roles/check-roles.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

if (!process.argv.includes('--con-objectid')) {
  const desde = testSrc.indexOf("id: 'objectid-invalido-da-404'");
  const hasta = testSrc.indexOf("id: 'cleanup-jefatura'");
  if (desde !== -1 && hasta > desde) testSrc = testSrc.slice(0, desde) + testSrc.slice(hasta);
}

const tocadas = new Set();
for (const m of testSrc.matchAll(/['"`](\/[A-Za-z0-9_\-\/$\{\}.:?=&]*)['"`]/g)) {
  const u = m[1].split('?')[0].replace(/\$\{[^}]*\}/g, '*');
  tocadas.add(u.replace(/\/+$/, '') || '/');
}
// check-roles hace un GET a cada path del catálogo de secciones.
for (const s of require(path.join(ROOT, 'config/sections')).SECTIONS) tocadas.add(s.path);

const matchea = (full) => {
  const re = new RegExp('^' + full
    .replace(/[.+?^$()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '(\\*|[^/]+)')
    .replace(/\*/g, '[^/]*') + '$');
  for (const u of tocadas) if (re.test(u)) return true;
  return false;
};

// ── 4) Informe ──────────────────────────────────────────────────────────────
const sinTocar = rutas.filter(r => !matchea(r.full));
const total = {};
for (const r of rutas) total[r.file] = (total[r.file] || 0) + 1;
const porArchivo = {};
for (const r of sinTocar) (porArchivo[r.file] ||= []).push(r);

console.log(`\nRUTAS: ${rutas.length}   ejercitadas: ${rutas.length - sinTocar.length}   SIN TOCAR: ${sinTocar.length}`);
if (process.argv.includes('--con-objectid')) {
  console.log('(medición laxa: cuenta objectid-invalido-da-404, así que el número miente para bien)');
}
for (const f of Object.keys(porArchivo).sort((a, b) => porArchivo[b].length - porArchivo[a].length)) {
  console.log(`\n── ${f}.js  (${porArchivo[f].length} sin tocar de ${total[f]})`);
  for (const r of porArchivo[f]) console.log(`   ${r.method.padEnd(6)} ${r.full}`);
}
console.log('');
