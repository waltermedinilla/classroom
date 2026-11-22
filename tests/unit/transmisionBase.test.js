// La transmisión arma sus rutas con window.LR_BASE (public/js/transmision.js), y nadie la
// definía: el ticket se pedía a POST /transmision/ticket, Express devolvía 404 y el docente
// veía "no se pudo entrar a la transmisión". Se descubrió en la primera prueba real en
// producción (2026-11-22). Estos tests fijan el contrato entre la vista y el script.

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');
const ejs      = require('ejs');

const raiz    = path.join(__dirname, '..', '..');
const parcial = path.join(raiz, 'views', 'partials', 'transmision.ejs');
const script  = fs.readFileSync(path.join(raiz, 'public', 'js', 'transmision.js'), 'utf8');

test('el script sigue armando sus rutas con window.LR_BASE', () => {
  assert.match(script, /window\.LR_BASE/);
});

test('la vista define LR_BASE con la sala de la materia ANTES de cargar el script', () => {
  const html = ejs.render(fs.readFileSync(parcial, 'utf8'), {
    course: { _id: 'abc123' }, sala: null, esGestor: true, esAlumno: false,
  }, { filename: parcial });

  const def = html.indexOf("window.LR_BASE = '/courses/abc123/sala'");
  const src = html.indexOf('/js/transmision.js"');
  assert.ok(def > -1, 'falta window.LR_BASE en la vista');
  assert.ok(src > -1, 'falta el <script src> de transmision.js');
  assert.ok(def < src, 'LR_BASE tiene que estar definida antes de que el script la lea');
});
