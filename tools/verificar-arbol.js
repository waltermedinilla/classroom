#!/usr/bin/env node
// Verifica un árbol de código antes de que se despliegue.
//
// Se corre con:  npm run verificar:arbol           (sobre la carpeta de trabajo)
//                npm run verificar:arbol -- <ruta> (sobre un árbol extraído)
//
// Cuándo hay que correrlo: ANTES de pushear, sobre el árbol COMMITEADO, no sobre tu carpeta.
// La receta entera, que es de lo que este comando es la mitad rápida:
//
//   git archive HEAD | tar -x -C <temporal>
//   cmd //c mklink //J <temporal>\node_modules <proyecto>\node_modules
//   cp .env <temporal>/.env   # con otro PORT
//   npm run verificar:arbol -- <temporal>
//   cd <temporal> && node server.js   →   curl http://localhost:<puerto>/health
//
// ⚠️ Al limpiar, el junction se borra con `cmd //c rmdir <temporal>\node_modules`. Con
// `rm -rf` seguís el enlace y te llevás puesto el node_modules del proyecto.
//
// Por qué no alcanza con arrancarlo: arrancar prueba solo los `require` del arranque. El 502
// del 2026-08-29 fue un `require` que vivía adentro de un handler, a un archivo que nunca se
// había commiteado. Los tests en verde no probaron nada: el archivo estaba en la carpeta.

const path = require('path');
const { revisarReferencias, revisarDependencias } = require('./arbol');

const raiz = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let hayFallas = false;

console.log(`\nÁrbol: ${raiz}\n`);

// ── 1. Referencias a archivos propios ────────────────────────────────────────
const ref = revisarReferencias(raiz);
console.log('1) Referencias a archivos propios');
console.log(`   ${ref.jsVistos} .js (${ref.refsJs} require) · ${ref.ejsVistos} .ejs (${ref.refsEjs} include)`);

if (!ref.faltantes.length) {
  console.log('   ✓ todas resuelven dentro del árbol\n');
} else {
  hayFallas = true;
  console.log(`\n   ✗ ${ref.faltantes.length} NO RESUELVEN — esto tumba producción al arrancar:\n`);
  for (const f of ref.faltantes) console.log(`     ${f.tipo}  ${f.archivo}  →  ${f.ref}`);
  console.log('\n   Suele ser un archivo que existe solo en tu carpeta. Revisá:  git status --porcelain | grep "^??"\n');
}

// ── 2. Paquetes declarados en package.json ───────────────────────────────────
const dep = revisarDependencias(raiz);
console.log('2) Paquetes requeridos vs package.json');
console.log(`   ${dep.vistos} .js (${dep.refs} require de paquetes) · package.json declara ${dep.declaradas}`);

const rompen = dep.sinDeclarar.filter(d => d.seDespliega && !d.resuelveHoy);
const fragiles = dep.sinDeclarar.filter(d => d.seDespliega && d.resuelveHoy);

if (rompen.length) {
  hayFallas = true;
  console.log(`\n   ✗ ${rompen.length} sin declarar y sin instalar — el npm install del VPS no los trae:\n`);
  for (const d of rompen) {
    console.log(`     ${d.nombre}`);
    for (const u of d.usos.slice(0, 4)) console.log(`         ${u.archivo}`);
  }
}
if (fragiles.length) {
  console.log(`\n   ⚠ ${fragiles.length} sin declarar, pero hoy llegan como dependencia transitiva:\n`);
  for (const d of fragiles) {
    console.log(`     ${d.nombre}  ·  ${d.usos.map(u => u.archivo).slice(0, 3).join(', ')}`);
  }
  console.log('\n     Anda, pero se rompe el día que la dependencia intermedia lo suelte.');
}
if (!rompen.length && !fragiles.length) console.log('   ✓ todo lo que se despliega está declarado');

console.log(hayFallas
  ? '\n────────────────────────────────────────────\nCON HALLAZGOS: no pushear sin mirar lo de arriba.\n'
  : '\n────────────────────────────────────────────\nSIN HALLAZGOS: el árbol se sostiene solo. Falta arrancarlo y pegarle a /health.\n');

process.exit(hayFallas ? 1 : 0);
