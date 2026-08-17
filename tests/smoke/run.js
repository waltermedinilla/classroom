#!/usr/bin/env node
// Corredor del smoke test (Opción 1: HTTP directo, sin dependencias nuevas).
// Uso: node tests/smoke/run.js   (ver tests/smoke/README.md para las env vars opcionales)
require('dotenv').config();
try { require('dotenv').config({ path: '.env.test', override: true }); } catch {}

const { SmokeClient, assert } = require('./lib');
const { specs, RUN_ID } = require('./specs');

const BASE_URL = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

function isLocal(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Este smoke test crea y borra datos reales (curso, usuarios, sugerencias) a través
// de la API. Correrlo contra producción por error sería destructivo, así que se niega
// a arrancar salvo que BASE_URL sea local o se fuerce explícitamente.
if (!isLocal(BASE_URL) && process.env.SMOKE_ALLOW_REMOTE !== 'true') {
  console.error(`\nBASE_URL "${BASE_URL}" no parece local (localhost/127.0.0.1).`);
  console.error('Este smoke test crea y borra datos reales via la API. Corré el server');
  console.error('local contra tu Mongo local (ver sync-prod.ps1) antes de usarlo.');
  console.error('Si de verdad querés apuntar a otro host: SMOKE_ALLOW_REMOTE=true\n');
  process.exit(1);
}

// --only=<regex>: corre solo los specs cuyo id matchee. Es SOLO para desarrollo — la suite
// entera tarda unos diez minutos y esperar eso para ver si un spec nuevo quedó en verde no
// escala. Es una expresión regular y no un substring para poder pedir un grupo que no
// comparte prefijo: --only='bulk|de-a-uno'.
//
// ⚠️ Cada spec puede depender del `state` que dejaron los anteriores (ids de curso, de
// usuario, códigos). Un filtro que corte esa cadena hace fallar specs que en la corrida
// completa pasan: eso NO es una regresión, es el filtro. Antes de dar algo por bueno, la
// corrida que vale es la de siempre, sin flags.
const soloArg = process.argv.find(a => a.startsWith('--only='));
let SOLO = null;
if (soloArg) {
  const patron = soloArg.slice('--only='.length);
  try { SOLO = new RegExp(patron); }
  catch (e) { console.error(`\n--only=${patron} no es una expresión regular válida: ${e.message}\n`); process.exit(1); }
}

// Los dos logins que casi todo spec da por hechos. Se cuelan siempre en una corrida
// filtrada: sin ellos los actores 'admin' y 'superadmin' no tienen cookie y absolutamente
// todo devuelve 302 al login, que es un modo de fallar que no le enseña nada a nadie.
const BOOTSTRAP = ['admin-login', 'superadmin-login'];

async function main() {
  console.log(`\nSmoke test (run ${RUN_ID}) → ${BASE_URL}\n`);
  if (SOLO) {
    console.log(`⚠️  --only=${SOLO}: corrida PARCIAL, los specs dependen entre sí.`);
    console.log('   Para validar de verdad, corré la suite completa sin el flag.\n');
  }
  const client = new SmokeClient(BASE_URL);
  const state = {};
  const results = [];

  for (const spec of specs) {
    if (SOLO && !SOLO.test(spec.id) && !BOOTSTRAP.includes(spec.id)) continue;
    const missingEnv = (spec.requiresEnv || []).filter(k => !process.env[k]);
    if (missingEnv.length) {
      results.push({ ...spec, status: 'SKIP', detail: `falta ${missingEnv.join(', ')}` });
      console.log(`○ SKIP  ${spec.id.padEnd(32)} falta ${missingEnv.join(', ')}`);
      continue;
    }
    try {
      await spec.run({ client, assert, state, env: process.env });
      results.push({ ...spec, status: 'PASS' });
      console.log(`✓ PASS  ${spec.id.padEnd(32)} ${spec.title}`);
    } catch (err) {
      results.push({ ...spec, status: 'FAIL', detail: err.message });
      console.log(`✗ FAIL  ${spec.id.padEnd(32)} ${err.message}`);
    }
  }

  const passed  = results.filter(r => r.status === 'PASS').length;
  const failed  = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log(`\n${passed} pasaron, ${failed} fallaron, ${skipped} se saltearon (de ${results.length})`);
  if (skipped > 0 && !process.env.SMOKE_ADMIN_EMAIL) {
    console.log('Tip: seteá SMOKE_ADMIN_EMAIL/SMOKE_ADMIN_PASSWORD para correr el flujo completo (curso, actividades, sugerencias).');
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Error inesperado corriendo el smoke test:', err);
  process.exit(1);
});
