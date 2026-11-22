// Cerrar la SALA corta la transmisión; cerrar la TRANSMISIÓN no cierra la sala
// (RN-1 de specs/transmision-en-vivo.spec.md, recordado por el usuario el 2026-11-22).
//
// Hasta acá, cerrar la sala marcaba la transmisión como terminada en la base pero no le avisaba
// al proceso de video, y los navegadores seguían transmitiendo o mirando hasta enterarse solos.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const raiz = path.join(__dirname, '..', '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

test('cerrar la sala corta la transmisión y le avisa al proceso de video', () => {
  const src = leer('services', 'liveRoom.js');
  const i = src.indexOf("await tx.cerrar(cerrada, { cerradaPor: 'cierre-sala' });");
  assert.ok(i > -1, 'cerrar la sala tiene que cerrar la transmisión');
  const despues = src.slice(i, i + 900);
  assert.match(despues, /require\('\.\/mediaClient'\)\.cerrarSala\(cerrada\._id\)/,
    'y avisarle al proceso de video, como hace "Terminar"');
  // Mejor esfuerzo: si el proceso de video no contesta, la sala se cierra igual.
  assert.match(despues, /try \{ await require\('\.\/mediaClient'\)\.cerrarSala\(cerrada\._id\); \} catch/);
});

test('terminar la transmisión NO cierra la sala', () => {
  const src = leer('routes', 'rooms.js');
  const i = src.indexOf("router.post('/:id/sala/transmision/cerrar'");
  assert.ok(i > -1);
  const cuerpo = src.slice(i, src.indexOf('\n});', i));
  assert.doesNotMatch(cuerpo, /closeSession|live\.cerrar|status:\s*'closed'/,
    'la ruta de la transmisión no toca el estado de la sala');
});

test('el navegador suelta cámara, micrófono y video cuando la transmisión terminó', () => {
  const src = leer('views', 'partials', 'live-room.ejs');
  const i = src.indexOf('  function pintarTransmision(tx) {');
  const inicio = src.slice(i, i + 1200);
  assert.match(inicio, /if \(!tx\.activa && window\.Transmision\) \{/);
  assert.match(inicio, /estoyEmitiendo\(\)\) window\.Transmision\.dejarDeEmitir\(\)/);
  assert.match(inicio, /estoyMirando\(\)\)\s+window\.Transmision\.dejarDeMirar\(\)/);
});
