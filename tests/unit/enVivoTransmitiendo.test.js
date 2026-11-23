// Las tarjetas de "Clases en vivo" (dirección y preceptoría) dicen cuándo la clase está
// transmitiendo video: "Transmitiendo · en vivo" (pedido del 2026-11-23).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('getOpenSessions entrega si se transmite, desde cuándo y qué fuentes', () => {
  const src = leer('services', 'liveRoom.js');
  const f = src.slice(src.indexOf('async function getOpenSessions'), src.indexOf('async function getTodayClosed'));
  assert.match(f, /transmitiendo: !!\(r\.transmision && r\.transmision\.activa\)/);
  assert.match(f, /transmisionMin:/);
  assert.match(f, /\['camara', 'pantalla', 'micro'\]\.filter\(f => r\.transmision\[f\]\)/);
});

test('la tarjeta dice "Transmitiendo · en vivo", y no lo anuncia si la docente no está conectada', () => {
  const v = leer('views', 'partials', 'live-cards.ejs');
  assert.match(v, /Transmitiendo · en vivo/);
  assert.match(v, /s\.docenteEnLinea === false\s*\n?\s*\? '<div class="lc-tx"><span class="lc-tx-chip sindoc">/);
  assert.match(v, /Transmisión sin docente conectado/);
  assert.match(v, /'\s*\+\s*\n?\s*tx \+|\n\s*tx \+/, 'la línea va dentro de la tarjeta');
  assert.match(v, /prefers-reduced-motion/, 'el punto que late respeta "reducir movimiento"');
});
