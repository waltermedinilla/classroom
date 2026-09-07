// Sala en vivo: el cursor del poll, o "escribo y se me borra lo que escribí".
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sala-poll-carrera.spec.md. Cuatro bloques:
//
//   1. LA CARRERA — el reclamo del 2026-09-07, reproducido paso a paso: dos pedidos en
//      vuelo y el viejo llegando último. Es EL test de este arreglo: con la lógica anterior
//      (reiniciar cuando el servidor anuncia un seq menor) el chat se vacía acá mismo.
//   2. EL REINICIO — qué vacía la pantalla y qué no. Spoiler: solo el sessionId.
//   3. EL CURSOR Y EL HUECO — que no avance por lo que el servidor ANUNCIA, que no saltee
//      un mensaje que está por aparecer, y que igual no se cuelgue esperándolo para siempre.
//   4. EL CABLEADO — que el partial cargue el módulo y ya no lleve las dos reglas viejas.
//      Sin esto, las tres reglas de arriba pueden estar perfectas y no aplicarse a nadie.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { crearCursor, HUECO_MS } = require('../../public/js/salaPoll');

const raiz  = path.join(__dirname, '..', '..');
const leer  = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const sala  = leer('views/partials/live-room.ejs');
const curso = leer('views/course.ejs');
const suelta= leer('views/rooms/standalone.ejs');

// ── Andamios ────────────────────────────────────────────────────────────────

const SESION = 'sesion-de-hoy';
const OTRA   = 'sesion-nueva';

// La respuesta del servidor, con lo único que mira el cursor.
const resp = (sessionId, seq, mensajes) => ({
  sessionId,
  seq,
  mensajes: (mensajes || []).map(n => (typeof n === 'number' ? { id: 'm' + n, seq: n } : n)),
});

const seqs = (msgs) => msgs.map(m => m.seq);

const enSala = (seq) => crearCursor({ seq, sessionId: SESION });

// ── 1. La carrera ───────────────────────────────────────────────────────────

test('EL BUG: la respuesta atrasada NO vacía el chat (reclamo del 2026-09-07)', () => {
  const cursor = enSala(10);

  // 1. El intervalo de 4 s pide "desde el 10". Queda viajando.
  const lento = cursor.pedir();
  assert.equal(lento.since, 10);

  // 2. La persona escribe: enviar() dispara un segundo pedido, también desde el 10.
  const rapido = cursor.pedir();
  assert.equal(rapido.since, 10, 'el segundo pedido sale con el mismo cursor');

  // 3. El segundo vuelve primero y trae el mensaje recién escrito. Se ve en pantalla.
  const d1 = cursor.recibir(resp(SESION, 11, [11]), rapido);
  assert.equal(d1.descartar, false);
  assert.equal(d1.reinicio,  false);
  assert.deepEqual(seqs(d1.mensajes), [11], 'el mensaje se pinta');
  assert.equal(cursor.seq, 11);

  // 4. Vuelve el primero, más lento, con la foto vieja: "el último es el 10, no hay nada".
  //    ACÁ se borraba el chat: 10 < 11 se leía como "la sala se reinició".
  const d2 = cursor.recibir(resp(SESION, 10, []), lento);
  assert.equal(d2.descartar, true, 'la respuesta atrasada se tira entera');
  assert.equal(d2.reinicio,  false, 'y sobre todo NO manda a vaciar el chat');
  assert.deepEqual(d2.mensajes, []);
  assert.equal(cursor.seq, 11, 'el cursor tampoco retrocede');
});

test('la respuesta atrasada se descarta aunque traiga mensajes', () => {
  // El mismo cruce, con la lenta trayendo una tanda parcial. Procesarla la habría pintado
  // como si fuera lo último, que es la otra cara del mismo desorden.
  const cursor = enSala(10);
  const lento  = cursor.pedir();
  const nuevo  = cursor.pedir();

  cursor.recibir(resp(SESION, 12, [11, 12]), nuevo);
  assert.equal(cursor.seq, 12);

  const d = cursor.recibir(resp(SESION, 11, [11]), lento);
  assert.equal(d.descartar, true);
  assert.equal(cursor.seq, 12, 'la tanda vieja no toca el cursor');
});

test('un solo pedido en vuelo sigue funcionando como siempre', () => {
  const cursor = enSala(10);
  const p = cursor.pedir();
  const d = cursor.recibir(resp(SESION, 12, [11, 12]), p);

  assert.equal(d.descartar, false);
  assert.equal(d.reinicio,  false);
  assert.deepEqual(seqs(d.mensajes), [11, 12]);
  assert.equal(cursor.seq, 12);
});

// ── 2. El reinicio ──────────────────────────────────────────────────────────

test('RN-2: un lastSeq menor con la MISMA sesión ya no reinicia nada', () => {
  const cursor = enSala(11);
  const p = cursor.pedir();

  const d = cursor.recibir(resp(SESION, 10, []), p);
  assert.equal(d.reinicio, false, 'el seq del servidor no es señal de sala nueva');
  assert.equal(cursor.seq, 11, 'y el cursor no retrocede');
});

test('RN-2: una sesión nueva vacía, NO pinta la tanda parcial y vuelve a pedir', () => {
  const cursor = enSala(50);
  const p = cursor.pedir();

  // La sala se reabrió: el servidor contesta con otra sesión, y la tanda que vino se pidió
  // con el cursor de la sesión anterior — un recorte arbitrario de la nueva.
  const d = cursor.recibir(resp(OTRA, 3, [51, 52]), p);

  assert.equal(d.reinicio, true);
  assert.deepEqual(d.mensajes, [], 'no se pinta un recorte de la sesión nueva');
  assert.equal(d.repedir, true, 'se vuelve a preguntar ya, sin esperar 4 segundos');
  assert.equal(cursor.seq, 0);
  assert.equal(cursor.sessionId, OTRA);
});

test('RN-2: la sala cerrada vacía la pantalla y se queda ahí', () => {
  const cursor = enSala(20);
  const p = cursor.pedir();

  const d = cursor.recibir(resp(null, 0, []), p);
  assert.equal(d.reinicio, true);
  assert.equal(d.repedir,  false, 'no hay nada que volver a pedir con la sala cerrada');
  assert.equal(cursor.seq, 0);
});

test('un repedido NO puede encadenar otro: la avalancha de pedidos', () => {
  // Encontrado verificando en el navegador el 2026-09-07: con el servidor contestando
  // sesiones distintas en respuestas seguidas (ahí fue la ventana de mantenimiento del smoke
  // entrando y saliendo), cada repedir disparaba el siguiente y salieron diez pedidos en el
  // mismo milisegundo. En producción son dos workers atendiendo a treinta personas.
  const cursor = enSala(10);

  const d1 = cursor.recibir(resp(OTRA, 1, []), cursor.pedir());
  assert.equal(d1.repedir, true, 'el primer cambio de sesión sí vuelve a preguntar');

  // Ese repedido se contesta con OTRA sesión más. No puede volver a encadenar.
  const d2 = cursor.recibir(resp(SESION, 1, []), cursor.pedir({ repedido: true }));
  assert.equal(d2.reinicio, true, 'se sigue repintando');
  assert.equal(d2.repedir,  false, 'pero se espera al intervalo, no se encadena otro pedido');
});

test('la sala que se abre después de estar cerrada entra por el mismo camino', () => {
  const cursor = crearCursor({ seq: 0, sessionId: null });
  const p = cursor.pedir();

  const d = cursor.recibir(resp(SESION, 2, [1, 2]), p);
  assert.equal(d.reinicio, true);
  assert.equal(d.repedir,  true);
  assert.equal(cursor.sessionId, SESION);
});

// ── 3. El cursor y el hueco ─────────────────────────────────────────────────

test('RN-3: el cursor NO avanza por lo que el servidor anuncia', () => {
  // El servidor reserva el número con un $inc y guarda el mensaje después. Un poll que caiga
  // en ese hueco ve el 11 anunciado y no lo recibe: adoptarlo era perderlo para siempre.
  const cursor = enSala(10);

  const p1 = cursor.pedir();
  const d1 = cursor.recibir(resp(SESION, 11, []), p1);
  assert.deepEqual(d1.mensajes, []);
  assert.equal(cursor.seq, 10, 'el cursor se queda esperando el mensaje 11');

  const p2 = cursor.pedir();
  assert.equal(p2.since, 10, 'y lo vuelve a pedir');
  const d2 = cursor.recibir(resp(SESION, 11, [11]), p2);
  assert.deepEqual(seqs(d2.mensajes), [11], 'cuando existe, llega');
  assert.equal(cursor.seq, 11);
});

test('RN-3: un hueco no se pinta ni mueve el cursor', () => {
  const cursor = enSala(10);
  const p = cursor.pedir();

  // Llega el 12; el 11 tiene el número reservado y todavía se está guardando.
  const d = cursor.recibir(resp(SESION, 12, [12]), p, 1000);
  assert.deepEqual(d.mensajes, [], 'pintarlo ya sería leer la conversación al revés');
  assert.equal(cursor.seq, 10);
});

test('RN-3: el poll siguiente trae los dos y se pintan en orden', () => {
  const cursor = enSala(10);
  const d1 = cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 1000);
  assert.deepEqual(d1.mensajes, []);

  const p2 = cursor.pedir();
  assert.equal(p2.since, 10);
  const d2 = cursor.recibir(resp(SESION, 12, [11, 12]), p2, 2000);
  assert.deepEqual(seqs(d2.mensajes), [11, 12], 'en orden');
  assert.equal(cursor.seq, 12);
});

test('RN-3: el hueco tiene plazo — no cuelga la sala para siempre', () => {
  // Un número reservado cuyo `create` falló no va a existir nunca. Sin plazo, el cursor se
  // quedaría esperándolo y la sala se volvería muda hasta recargar.
  const cursor = enSala(10);

  cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 1000);
  assert.equal(cursor.seq, 10, 'primero espera');

  const d = cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 1000 + HUECO_MS);
  assert.deepEqual(seqs(d.mensajes), [12], 'pasado el plazo, la conversación sigue');
  assert.equal(cursor.seq, 12);
});

test('RN-3: el plazo se cuenta desde el primer poll que vio el hueco', () => {
  const cursor = enSala(10);
  cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 1000);
  cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 5000);
  assert.equal(cursor.seq, 10, 'a los 4 segundos sigue esperando');

  cursor.recibir(resp(SESION, 12, [12]), cursor.pedir(), 1000 + HUECO_MS);
  assert.equal(cursor.seq, 12, 'y no se reinicia el reloj en cada intento');
});

test('RN-3: una tanda consecutiva no es un hueco', () => {
  const cursor = enSala(10);
  const d = cursor.recibir(resp(SESION, 13, [11, 12, 13]), cursor.pedir());
  assert.deepEqual(seqs(d.mensajes), [11, 12, 13]);
  assert.equal(cursor.seq, 13);
});

test('RN-3: con since 0 no se evalúan huecos', () => {
  // El servidor manda los últimos 100 mensajes, que no tienen por qué empezar en 1.
  const cursor = crearCursor({ seq: 0, sessionId: SESION });
  const d = cursor.recibir(resp(SESION, 240, [180, 181, 182]), cursor.pedir());
  assert.deepEqual(seqs(d.mensajes), [180, 181, 182]);
  assert.equal(cursor.seq, 182, 'y el cursor es el último RECIBIDO, no el anunciado');
});

// ── 4. desdeCero: borrar y reaccionar ───────────────────────────────────────

test('desdeCero pide la conversación entera y manda a repintarla', () => {
  const cursor = enSala(30);
  const p = cursor.pedir({ desdeCero: true });
  assert.equal(p.since, 0);

  const d = cursor.recibir(resp(SESION, 31, [29, 30, 31]), p);
  assert.equal(d.reinicio, true, 'se vacía el chat antes de pintar');
  assert.deepEqual(seqs(d.mensajes), [29, 30, 31]);
  assert.equal(cursor.seq, 31);
});

test('desdeCero se aplica al RECIBIR: una respuesta perdida no deja el cursor en 0', () => {
  const cursor = enSala(30);
  cursor.pedir({ desdeCero: true });          // ese pedido falla (500, o la red del aula)
  assert.equal(cursor.seq, 30, 'el cursor no se bajó al pedir');

  const p = cursor.pedir();
  assert.equal(p.since, 30, 'el poll siguiente sigue pidiendo desde donde iba');
});

// ── 5. El cableado ──────────────────────────────────────────────────────────

test('las dos vistas de la sala cargan el módulo', () => {
  // El partial es el mismo en la solapa de la materia y en la página suelta de dirección y
  // preceptoría. El <script> va ADENTRO del partial justamente para que no se pueda olvidar
  // en una de las dos.
  assert.match(sala, /<script src="\/js\/salaPoll\.js"><\/script>/,
    'views/partials/live-room.ejs tiene que cargar /js/salaPoll.js');
  assert.ok(curso.includes("include('partials/live-room'"), 'course.ejs incluye el partial');
  assert.ok(suelta.includes("include('../partials/live-room')"), 'standalone.ejs también');

  const antes = sala.indexOf('/js/salaPoll.js');
  const usa   = sala.indexOf('SalaPoll.crearCursor');
  assert.ok(antes >= 0 && usa > antes, 'el módulo se carga ANTES de usarse');
});

test('el <script> del módulo no se mete entre la sala y su script inline', () => {
  // El script inline se ubica en la página con `document.currentScript.previousElementSibling`
  // y espera encontrar ahí el <div class="lr-wrap"> (ver aLaVista(), que es lo que evita
  // contar presente a quien tiene la materia abierta en otra solapa). Puesto al lado, el
  // hermano anterior pasaba a ser la etiqueta del módulo. Encontrado verificando en el
  // navegador el 2026-09-07.
  // Sin los comentarios EJS: los de este partial citan el marcado que se busca acá.
  const marcado = sala.replace(/<%#[\s\S]*?%>/g, '');

  const modulo = marcado.indexOf('<script src="/js/salaPoll.js">');
  const wrap   = marcado.indexOf('<div class="lr-wrap">');
  const inline = marcado.search(/<script>\s*\(function \(\)/);
  assert.ok(modulo >= 0 && wrap > modulo, 'el módulo se carga ANTES del contenedor de la sala');
  assert.ok(inline > wrap, 'y el script inline va después de la sala');

  const cierre = marcado.lastIndexOf('</div>', inline);
  assert.equal(marcado.slice(cierre + '</div>'.length, inline).trim(), '',
    'entre el cierre del .lr-wrap y el <script> inline no puede haber NINGUNA otra etiqueta');
});

test('el partial ya no lleva las dos reglas que causaban el bug', () => {
  assert.ok(!/s\.seq\s*<\s*seq/.test(sala),
    'un lastSeq menor no puede volver a ser señal de reinicio');
  assert.ok(!/if\s*\(s\.seq\s*>\s*seq\)/.test(sala),
    'el cursor no puede volver a avanzar por lo que el servidor anuncia');
});

test('el cartel de "no hay mensajes" no queda de encabezado', () => {
  // Con el reinicio, el chat se vacía —y aparece el cartel— y enseguida el repedido lo llena.
  // Sin sacar el cartel antes de agregar, queda ARRIBA de la conversación. Visto en el
  // navegador al abrir una sala el 2026-09-07.
  const cuerpo = sala.slice(sala.indexOf('function pintarMensajes('));
  const hasta  = cuerpo.indexOf('\n  }');
  const fn     = cuerpo.slice(0, hasta);

  assert.match(fn, /querySelector\('\.lr-vacio'\)/, 'pintarMensajes tiene que sacar el cartel');
  const quita  = fn.indexOf('.lr-vacio');
  const agrega = fn.indexOf('chat.appendChild');
  assert.ok(quita < agrega, 'y sacarlo ANTES de agregar los mensajes');
});

test('el poll pasa por el cursor y respeta el descarte', () => {
  assert.match(sala, /cursor\.pedir\(/,  'el pedido sale del cursor');
  assert.match(sala, /cursor\.recibir\(/, 'y la respuesta se decide con el cursor');
  assert.match(sala, /if\s*\(d\.descartar\)\s*return/,
    'una respuesta atrasada tiene que cortar ANTES de tocar el DOM');
});

test('RN-4: el latido no consume una generación de pedido', () => {
  // latir() manda el mismo GET y tira la respuesta. Si numerara un pedido, invalidaría el
  // poll de verdad que estuviera en vuelo: la sala se congelaría cada 20 segundos para quien
  // la gestiona, que es el único que late.
  const desde = sala.indexOf('async function latir');
  const hasta = sala.indexOf('── Acciones', desde);
  assert.ok(desde > 0 && hasta > desde, 'no se encontró el bloque del latido');

  // Sin los comentarios: el de este mismo bloque nombra `cursor.pedir()` para explicar por
  // qué NO se lo llama, y buscar la cadena a secas daba un falso positivo.
  const bloque = sala.slice(desde, hasta).replace(/\/\/.*$/gm, '');
  assert.ok(!bloque.includes('cursor.pedir('), 'el latido NO pide por el cursor');
  assert.ok(bloque.includes('cursor.seq'),     'lee el cursor y nada más');
});
