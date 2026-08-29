// El bloque "Lo que cargó el alumno en su perfil" de la ficha del SOE, y el botón Analizar
// que todavía no hace nada.
//
// Correr con: npm run test:unit
//
// Son tests de MARCADO, como tests/unit/movil.test.js: lo que cubren no se rompe por lógica
// sino por una edición razonable de la vista. Los cuatro riesgos, en orden:
//
//   1. Que alguien saque `instagram`/`facebook` del .select() de alumnoEnScope "porque no se
//      usan". El bloque dejaría de dibujarse sin un solo error: `alumno.instagram` sería
//      undefined y el `if` simplemente no entraría.
//   2. Que el bloque de redes se saque de adentro del `nivel === 'completo'`. El usuario de
//      Instagram de un menor pasaría a verlo cualquier docente con acceso al resumen, que es
//      exactamente lo que ese nivel existe para evitar.
//   3. Que la pista se mude al <button>. Un control deshabilitado no recibe eventos de mouse:
//      ni el `title` ni un `:hover` propio se disparan, y el aviso no aparecería nunca.
//   4. Que el color del ánimo vuelva a `style=` inline. Un color en línea le gana a la
//      variante de modo oscuro, y estos verdes y rojos sobre fondo oscuro no se leen — es el
//      bug que ya salió una vez en la sala (1,10:1 de contraste).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const raiz    = path.join(__dirname, '..', '..');
const legajo  = fs.readFileSync(path.join(raiz, 'views/soe/legajo.ejs'), 'utf8');
const estilos = fs.readFileSync(path.join(raiz, 'views/partials/soe-styles.ejs'), 'utf8');
const mw      = fs.readFileSync(path.join(raiz, 'middleware/soe.js'), 'utf8');

const AVISO = 'La implementación de la IA todavía no se encuentra disponible.';

// Espacios colapsados: estos tests no tienen por qué romperse si alguien alinea las reglas
// de CSS de otra manera.
const legajoPlano = legajo.replace(/\s+/g, ' ');

// El bloque de redes: desde el `if` que lo abre hasta la nota de móvil que lo cierra.
function bloqueRedes() {
  const desde = legajo.indexOf('if (_verRedes)');
  assert.notEqual(desde, -1, 'no se encontró el bloque de redes en la ficha');
  return legajo.slice(desde, legajo.indexOf('</div>', legajo.indexOf('pista-nota')));
}

// ── 1. El dato tiene que llegar a la vista ───────────────────────────────────

test('alumnoEnScope trae las redes del alumno', () => {
  // Acotado a esa función: el archivo tiene otros .select() (el de las divisiones) que no
  // tienen por qué traer nada del perfil.
  const fn = mw.slice(mw.indexOf('async function alumnoEnScope'));
  const select = fn.match(/\.select\('([^']+)'\)/);
  assert.ok(select, 'no se encontró el .select() de alumnoEnScope');
  for (const campo of ['instagram', 'facebook']) {
    assert.ok(select[1].includes(campo),
      `sin ${campo} en el select, el bloque de redes no se dibuja nunca y no avisa`);
  }
});

// ── 2. Confidencialidad ──────────────────────────────────────────────────────

test('las redes solo se dibujan en nivel completo', () => {
  assert.ok(legajoPlano.includes("const _verRedes = nivel === 'completo' && _redes.length"),
    'el bloque de redes tiene que colgar de nivel completo');

  // Y el resto del perfil (bio, intereses, proyecto) NO: eso el nivel resumen sí lo ve.
  assert.ok(legajoPlano.includes('const _hayPerfil = alumno.futureGoal || alumno.bio'),
    'bio, intereses y proyecto no deberían haber quedado atados a las redes');
});

test('el enlace a la red sale con rel de seguridad y no arrastra la sesión', () => {
  const bloque = bloqueRedes();
  assert.ok(bloque.includes('target="_blank"'), 'la red se abre en otra pestaña');
  assert.ok(bloque.includes('rel="noopener noreferrer"'),
    'sin noopener, el sitio de destino queda con handle a la ventana del legajo');
});

// ── 3. El botón que todavía no hace nada ─────────────────────────────────────

test('el botón Analizar está deshabilitado', () => {
  const bloque = bloqueRedes();
  assert.match(bloque, /<button[^>]*class="btn-ia"[^>]*disabled/,
    'mientras la IA no exista, el botón va apagado');
  assert.ok(bloque.includes('aria-disabled="true"'),
    'que un lector de pantalla lo anuncie apagado, no solo que se vea gris');
  assert.ok(bloque.includes('Analizar'), 'el rótulo del botón es "Analizar"');
});

test('la pista cuelga del envoltorio y no del botón deshabilitado', () => {
  const bloque = bloqueRedes();
  const spanPista = bloque.match(/<span class="pista"[^>]*>/);
  assert.ok(spanPista, 'falta el <span class="pista"> que envuelve al botón');
  assert.ok(spanPista[0].includes(`data-pista="${AVISO}"`), 'la pista lleva el aviso');
  assert.ok(spanPista[0].includes(`title="${AVISO}"`),
    'el title es el respaldo nativo si el CSS no carga');
  assert.ok(spanPista[0].includes('tabindex="0"'),
    'sin tabindex el aviso es inalcanzable con el teclado');

  // Lo que NO puede pasar: que el aviso viva en el propio botón.
  const boton = bloque.match(/<button[^>]*>/)[0];
  assert.ok(!boton.includes('title=') && !boton.includes('data-pista='),
    'un <button disabled> no dispara eventos de mouse: ahí el aviso no se vería nunca');
});

test('en el teléfono el aviso se lee como nota, no como burbuja flotante', () => {
  assert.ok(bloqueRedes().includes(`<div class="pista-nota">${AVISO}`),
    'falta la nota estática, que es la única forma de leer el aviso sin mouse');

  const movil = estilos.slice(estilos.indexOf('.pista-nota { display: none; }')).replace(/\s+/g, ' ');
  assert.ok(movil.includes('@media (max-width: 700px)'), 'la nota necesita su bloque de móvil');
  assert.ok(movil.includes('.pista::after, .pista::before { display: none;'),
    'la burbuja tiene que apagarse en móvil: cerca del borde queda recortada por overflow-x');
  assert.ok(movil.includes('.pista-nota { display: block;'),
    'y la nota tiene que aparecer en su lugar');
});

// ── 4. Modo oscuro ───────────────────────────────────────────────────────────

test('el color del ánimo va por clase y no en línea', () => {
  // Desde el 2026-08-27 el círculo lo dibuja la línea de tiempo unificada, así que la
  // variable es el HITO (`h`) y ya no la entrada (`e`). La regla que este test protege no
  // cambió: el tinte va por clase.
  assert.ok(legajo.includes(`class="icono<%= h.animo ? ' animo-' + h.animo : '' %>"`),
    'el tinte del círculo va por clase');

  // El círculo NO puede llevar style=: un color inline le gana a la variante oscura.
  const circulo = legajo.match(/<div class="icono[^>]*>/)[0];
  assert.ok(!circulo.includes('style='),
    'el color del círculo volvió a estar en línea y en modo oscuro no se lee');

  // Y cada tono claro tiene su par oscuro.
  for (const animo of ['bien', 'altibajos', 'preocupante']) {
    assert.ok(estilos.includes(`.linea .icono.animo-${animo}`),
      `falta la regla del ánimo ${animo}`);
    assert.ok(estilos.includes(`[data-theme="dark"] .linea .icono.animo-${animo}`),
      `el ánimo ${animo} no tiene variante de modo oscuro`);
  }
});

test('los indicadores de colores tienen su variante oscura', () => {
  for (const estado of ['bien', 'aviso', 'alerta']) {
    assert.ok(legajoPlano.includes(`.ind.${estado} .n { color: #`),
      `falta el color del indicador ${estado}`);
    assert.ok(legajoPlano.includes(`[data-theme="dark"] .ind.${estado} .n { color: #`),
      `el indicador ${estado} se pinta con un hex fijo y no tiene variante oscura`);
    assert.ok(legajoPlano.includes(`[data-theme="dark"] .ind.${estado} .barra > i`),
      `la barra del indicador ${estado} tampoco tiene variante oscura`);
  }
});

test('la burbuja de la pista declara su color de texto junto al fondo', () => {
  const regla = estilos.slice(estilos.indexOf('.pista::after'), estilos.indexOf('.pista::before'));
  assert.ok(regla.includes('background: #202124; color: #ffffff'),
    'un fondo en hex obliga a declarar el color del texto en hex, o el tema lo pisa');
});
