// El botón flotante de sugerencias se puede apagar sin romper la bandeja.
// Ver specs/sugerencias-boton-oculto.spec.md. Correr con: npm run test:unit

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { BOTON_SUGERENCIAS_VISIBLE } = require('../../config/sugerencias');

const ARCHIVO = path.join(__dirname, '../../views/partials/footer.ejs');
const footer = (locals) => ejs.render(fs.readFileSync(ARCHIVO, 'utf8'),
  { user: { _id: 'u1', name: 'Docente', role: 'teacher' }, appVersion: '1.0.0', ...locals },
  { filename: ARCHIVO });

test('CS-01 · por ahora el botón está apagado', () => {
  assert.strictEqual(BOTON_SUGERENCIAS_VISIBLE, false);
});

test('CS-02 · apagado: no se pinta el botón, pero el modal y la bandeja siguen', () => {
  const html = footer({ botonSugerencias: false });
  assert.ok(!html.includes('id="fabSuggest"'), 'el botón no debería estar');
  assert.ok(html.includes('id="suggestionModal"'), 'el modal lo usa "Nueva sugerencia" de la bandeja');
  assert.ok(html.includes('openSuggestFromInbox'), 'la bandeja sigue ofreciendo "Nueva sugerencia"');
});

test('CS-03 · prendido: el botón vuelve', () => {
  assert.ok(footer({ botonSugerencias: true }).includes('id="fabSuggest"'));
});

test('CS-04 · sin la variable (vista que no pasó por server.js) queda oculto', () => {
  assert.ok(!footer({}).includes('id="fabSuggest"'));
});

test('CS-05 · sin sesión no hay nada de sugerencias', () => {
  const html = footer({ user: null, botonSugerencias: true });
  assert.ok(!html.includes('fabSuggest') && !html.includes('suggestionModal'));
});
