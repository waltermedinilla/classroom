// El cartel "Dar presente": public/js/asistenciaBanda.js.
// Correr con: npm run test:unit
//
// ⭐ LO QUE IMPORTA ACÁ ES `pintado()`: la regla de CUÁNDO se repinta la banda. El 2026-09-11 el
// cartel pasó de "render del servidor y nada más" a refrescarse solo cada minuto, y esa regla es
// la que tiene que impedir las dos formas de romperlo:
//
//   · no repintar cuando preceptoría abre la asistencia con la página ya cargada → es el bug que
//     hizo esperar media hora a un alumno el 09/09;
//   · repintar de más y borrarle al alumno el estado de una banda que ya usó.
//
// Ver specs/asistencia-preceptoria.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const AB = require('../../public/js/asistenciaBanda.js');

const toma = (o) => Object.assign({
  id: 'aaaaaaaaaaaaaaaaaaaaaaa1', curso: '3° B', abiertaDesde: '08:05', cierraA: null,
  yaDi: false, estado: 'ausente',
}, o);

// ── La regla del repintado ──────────────────────────────────────────────────

test('⭐ la primera pintada SIEMPRE se aplica, incluso sin ninguna toma', () => {
  // Con firma en null nada se pintó todavía. Aplicar el vacío es lo que deja el cartel en su
  // estado correcto en vez de dejarlo sin inicializar.
  const r = AB.pintado(null, []);
  assert.equal(r.repintar, true);
  assert.equal(r.html, '');
  assert.equal(r.firma, '');
});

test('⭐⭐ una toma que APARECE con la página ya cargada se pinta: es el bug del 09/09', () => {
  // El alumno cargó el Inicio (o la sala) sin ninguna asistencia abierta. Preceptoría la abre
  // media hora después. Antes el botón no aparecía nunca sin recargar.
  const vacio = AB.pintado(null, []);
  const luego = AB.pintado(vacio.firma, [toma()]);

  assert.equal(luego.repintar, true, 'tiene que repintar: apareció una toma');
  assert.match(luego.html, /Dar presente/);
  assert.match(luego.html, /3° B/);
});

test('⭐ el mismo conjunto NO repinta: no se toca el DOM al vacío', () => {
  const primera = AB.pintado(null, [toma()]);
  const igual   = AB.pintado(primera.firma, [toma()]);

  assert.equal(igual.repintar, false);
  assert.equal(igual.html, null);
});

test('⭐⭐ un cambio de `yaDi` NO repinta: borraría lo que el alumno acaba de ver', () => {
  // Cuando el alumno aprieta el botón, el handler deja la banda en su estado final, y a veces
  // con un texto que el servidor NO manda ("Preceptoría ya te había tomado la asistencia"). Si
  // `yaDi` entrara en la firma, el sondeo del minuto siguiente lo borraría.
  const antes = AB.pintado(null, [toma({ yaDi: false })]);
  const despues = AB.pintado(antes.firma, [toma({ yaDi: true })]);

  assert.equal(despues.repintar, false, 'la misma toma no se repinta por cambiar de estado');
});

test('una toma que se CIERRA saca su banda', () => {
  const conDos = AB.pintado(null, [toma(), toma({ id: 'b2', curso: '4° A' })]);
  const conUna = AB.pintado(conDos.firma, [toma()]);

  assert.equal(conUna.repintar, true);
  assert.ok(!/4° A/.test(conUna.html), 'la banda de la toma cerrada ya no está');
  assert.match(conUna.html, /3° B/);
});

test('la firma no depende del ORDEN en que vengan las tomas', () => {
  // El servidor no promete un orden, y un reordenamiento no es un cambio.
  const a = AB.pintado(null, [toma({ id: 'x1' }), toma({ id: 'x2' })]);
  const b = AB.pintado(a.firma, [toma({ id: 'x2' }), toma({ id: 'x1' })]);

  assert.equal(b.repintar, false);
});

test('lo que no es un array se trata como vacío y no rompe', () => {
  // Una respuesta rara del servidor no puede tirar el cartel abajo.
  for (const basura of [null, undefined, {}, 'nada', 7]) {
    const r = AB.pintado(null, basura);
    assert.equal(r.repintar, true);
    assert.equal(r.html, '');
  }
});

// ── El marcado ──────────────────────────────────────────────────────────────

test('sin dar el presente la banda trae el botón habilitado', () => {
  const h = AB.bandaHTML(toma());
  assert.match(h, /class="as-band"/, 'sin la clase `dada`');
  assert.match(h, /front_hand/);
  assert.ok(!/disabled/.test(h), 'el botón tiene que poder apretarse');
  assert.match(h, /Abierta desde las 08:05/);
});

test('con el presente ya dado la banda queda apagada y el botón deshabilitado', () => {
  const h = AB.bandaHTML(toma({ yaDi: true }));
  assert.match(h, /class="as-band dada"/);
  assert.match(h, /disabled/);
  assert.match(h, /Presente dado/);
  assert.match(h, /Ya diste el presente/);
});

test('la hora de cierre aparece solo si existe', () => {
  assert.match(AB.bandaHTML(toma({ cierraA: '08:45' })), /cierra 08:45/);
  assert.ok(!/cierra/.test(AB.bandaHTML(toma({ cierraA: null }))));
});

test('⭐ el nombre del curso se escapa: viene de la base y se inserta como HTML', () => {
  // `innerHTML` con un nombre de división sin escapar es una inyección. El nombre lo escribe
  // un admin, pero eso no lo vuelve seguro.
  const h = AB.bandaHTML(toma({ curso: '<img src=x onerror=alert(1)>' }));
  assert.ok(!/<img/.test(h), `no puede quedar una etiqueta viva: ${h}`);
  assert.match(h, /&lt;img/);
});

test('el id de la toma también se escapa, porque va a un atributo', () => {
  const h = AB.bandaHTML(toma({ id: 'a" onmouseover="x' }));
  assert.ok(!/onmouseover="x"/.test(h));
  assert.match(h, /&quot;/);
});

test('esc cubre los cinco caracteres, y el nulo no imprime "null"', () => {
  assert.equal(AB.esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(AB.esc(null), '');
  assert.equal(AB.esc(undefined), '');
});

// ── El literal que no puede vivir en el partial ─────────────────────────────

test('⭐⭐ el partial NO puede traer "Dar presente" escrito a mano', () => {
  // ⚠️ ESTE TEST EXISTE POR UN SMOKE EN ROJO (2026-09-11). El partial tenía el texto del botón
  // escrito a mano en la recuperación de error del click, así que el inicio de CUALQUIER alumno
  // lo contenía aunque no hubiera ninguna asistencia abierta.
  //
  // Lo grave no era el fallo sino lo otro: `student-attendance-banner` afirma que con la toma
  // abierta el texto SÍ está en el inicio, y con el literal suelto habría pasado siempre, sin
  // probar nada. Un test que no puede fallar es peor que no tenerlo.
  //
  // El texto tiene que venir de ETIQUETAS, que viaja en /js/asistenciaBanda.js.
  const fs = require('node:fs');
  const path = require('node:path');
  const ejs = fs.readFileSync(
    path.join(__dirname, '../../views/partials/asistencia-banner.ejs'), 'utf8');

  // Los comentarios EJS (<%# … %>) no se emiten: ahí el texto puede nombrarse sin problema.
  const emitido = ejs.replace(/<%#[\s\S]*?%>/g, '');

  assert.ok(!emitido.includes(AB.ETIQUETAS.dar.texto),
    'el texto del botón tiene que salir de ETIQUETAS, no estar escrito en el partial');
  assert.match(emitido, /ETIQUETAS/, 'y el partial tiene que usarlas');
});

test('bandasHTML arma la lista entera, y es lo que usan los dos lados', () => {
  // El servidor (routes/courses.js) y el navegador llaman a ESTA función: si alguien agrega un
  // segundo camino, vuelven los dos marcados que este módulo vino a evitar.
  const html = AB.bandasHTML([toma({ id: 'u1' }), toma({ id: 'u2', yaDi: true })]);
  // Se cuenta `data-toma`, que va UNA vez por banda: `class="as-band` también pica en
  // `as-band-txt` y `as-band-btn`.
  assert.equal((html.match(/data-toma=/g) || []).length, 2);
  assert.match(html, /data-toma="u1"/);
  assert.match(html, /data-toma="u2"/);
  assert.equal(AB.bandasHTML([]), '');
  assert.equal(AB.bandasHTML(null), '');
});
