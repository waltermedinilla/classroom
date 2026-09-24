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

// ── RN-22: el aviso fijo cuando el cartel quedó fuera de la vista (2026-09-24) ──────────────
//
// El reclamo: "a algunos alumnos se les demora en aparecer el botón". No se demoraba —el
// primero de cada toma lo da a los 36 s—: en la sala el cartel va ARRIBA de todo y el alumno
// está en el chat, 1.000 a 1.450 px más abajo en el celular. El aviso fijo lo trae a la vista.

const estado = (o) => Object.assign({
  pendientes: 1, enPantalla: true, visible: false, firma: 'a1', firmaCerrada: null,
}, o);

test('⭐⭐ CA-54: cartel pendiente y fuera de la vista → aparece el aviso (el caso del chat)', () => {
  assert.equal(AB.mostrarAviso(estado()), true);
});

test('CA-54: con el cartel a la vista, el aviso sobra', () => {
  assert.equal(AB.mostrarAviso(estado({ visible: true })), false);
});

test('CA-55: sin nada pendiente no hay aviso, aunque el cartel esté lejos', () => {
  assert.equal(AB.mostrarAviso(estado({ pendientes: 0 })), false);
  assert.equal(AB.mostrarAviso(estado({ pendientes: 0, firma: '' })), false);
});

test('CA-56: en una solapa oculta de la materia NO aparece (el arreglo B no se aprobó)', () => {
  assert.equal(AB.mostrarAviso(estado({ enPantalla: false })), false);
});

test('⭐ CA-57: cerrado con una firma, no vuelve con esa firma; vuelve si se abre otra toma', () => {
  assert.equal(AB.mostrarAviso(estado({ firmaCerrada: 'a1' })), false);
  assert.equal(AB.mostrarAviso(estado({ firmaCerrada: 'a1', firma: 'a1,b2' })), true);
});

test('mostrarAviso sin datos no revienta: da false', () => {
  assert.equal(AB.mostrarAviso(), false);
  assert.equal(AB.mostrarAviso({}), false);
});

test('CA-58: el aviso trae el botón de ETIQUETAS y un cerrar con nombre accesible', () => {
  const html = AB.avisoHTML('dar');
  assert.ok(html.includes(AB.ETIQUETAS.dar.texto));
  assert.match(html, /as-aviso-btn/);
  assert.match(html, /as-aviso-x[^>]*aria-label="[^"]+"/);
  assert.match(html, /role="status"/);
});

test('CA-58: el aviso muestra enviando, dado y el error (escapado)', () => {
  assert.ok(AB.avisoHTML('enviando').includes(AB.ETIQUETAS.enviando.texto));
  assert.match(AB.avisoHTML('dada'), /Listo/);
  const err = AB.avisoHTML('error', '<b>La asistencia está cerrada</b>');
  assert.ok(err.includes('&lt;b&gt;La asistencia está cerrada'), 'el mensaje del servidor va escapado');
  assert.ok(err.includes(AB.ETIQUETAS.dar.texto), 'tras un error se puede volver a intentar');
});

test('⭐⭐ CA-58/59: el partial no trae el texto del aviso escrito a mano, ni un POST propio del aviso', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const emitido = fs.readFileSync(
    path.join(__dirname, '../../views/partials/asistencia-banner.ejs'), 'utf8')
    .replace(/<%#[\s\S]*?%>/g, '');
  assert.ok(!emitido.includes('tomando asistencia'),
    'el texto del aviso sale de avisoHTML(), como el del botón sale de ETIQUETAS');
  assert.match(emitido, /id="asAviso"/, 'el contenedor del aviso existe');
  assert.match(emitido, /avisoHTML\(/, 'y se pinta con el módulo');
  // UN solo camino para dar el presente: el del botón de la banda.
  assert.equal((emitido.match(/fetch\('\/asistencia\/' \+/g) || []).length, 1,
    'el aviso no puede tener su propio POST: dispara el botón de la banda');
  assert.match(emitido, /IntersectionObserver/);
});

// ── RN-23: el sondeo se corta a los 15 s ────────────────────────────────────

test('⭐⭐ CA-60: un /asistencia/abierta que no contesta NUNCA se corta y da null', async () => {
  // El caso de la red de celular que cuelga el pedido: antes, `enVuelo` quedaba en true y ningún
  // ciclo volvía a preguntar hasta que ese fetch terminara de fallar.
  let abortado = false;
  const colgado = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      abortado = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  const t0 = Date.now();
  const r = await AB.pedirTomas(colgado, 40);
  assert.equal(r, null);
  assert.equal(abortado, true, 'el pedido se cancela, no queda colgado de fondo');
  assert.ok(Date.now() - t0 < 1000);
});

test('CA-60: el tope por defecto es 15 s', () => {
  assert.equal(AB.TOPE_MS, 15000);
});

test('CA-61: con 200 devuelve las tomas; con error, no-OK o JSON raro, null', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ tomas: [toma()] }) });
  assert.deepEqual((await AB.pedirTomas(ok, 1000)).map((t) => t.id), [toma().id]);

  assert.equal(await AB.pedirTomas(async () => ({ ok: false, json: async () => ({}) }), 1000), null);
  assert.equal(await AB.pedirTomas(async () => ({ ok: true, json: async () => ({}) }), 1000), null);
  assert.equal(await AB.pedirTomas(async () => { throw new Error('sin red'); }, 1000), null);
});
