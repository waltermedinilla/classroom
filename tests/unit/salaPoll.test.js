// Sala en vivo: el cursor del poll, o "escribo y se me borra lo que escribí".
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sala-poll-carrera.spec.md (bloques 1 a 6) y specs/sala-en-vivo-escala.spec.md
// (bloque 7). Siete bloques:
//
//   1. LA CARRERA — el reclamo del 2026-09-07, reproducido paso a paso: dos pedidos en
//      vuelo y el viejo llegando último. Es EL test de este arreglo: con la lógica anterior
//      (reiniciar cuando el servidor anuncia un seq menor) el chat se vacía acá mismo.
//   2. EL REINICIO — qué vacía la pantalla y qué no. Spoiler: solo el sessionId.
//   3. EL CURSOR Y EL HUECO — que no avance por lo que el servidor ANUNCIA, que no saltee
//      un mensaje que está por aparecer, y que igual no se cuelgue esperándolo para siempre.
//   4. EL CABLEADO — que el partial cargue el módulo y ya no lleve las dos reglas viejas.
//      Sin esto, las tres reglas de arriba pueden estar perfectas y no aplicarse a nadie.
//   5. LA INANICIÓN — el bug del 2026-09-08: con el viaje más lento que el intervalo, TODA
//      respuesta llegaba tarde y se tiraba. La sala no se degradaba, se congelaba.
//   6. EL CABLEADO DEL CICLO — que el poll se encadene en vez de salir por intervalo fijo,
//      que tenga plazo, y que la cadena no se pueda cortar.
//   7. EL RITMO (RN-4) — 4 s con la sala viva, 8 s en silencio, y de vuelta a 4 en el acto.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { crearCursor, crearRitmo, HUECO_MS } = require('../../public/js/salaPoll');

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

// ── 5. La inanición ─────────────────────────────────────────────────────────
//
// EL BUG DEL 2026-09-08, que es el precio que se pagó por el arreglo del 07/09.
//
// RN-1 comparaba contra el último pedido EMITIDO (`gen`), no contra la última respuesta
// PINTADA. Con el poll saliendo cada 4 s pase lo que pase, alcanzaba con que el viaje
// tardara más que el intervalo para que toda respuesta llegara con `gen` ya cambiado y se
// tirara. No es una degradación: es un acantilado en los 4000 ms exactos. Por debajo, la
// sala anda perfecto; por arriba, no pinta NADA, NUNCA, hasta que la red afloje.
//
// Reportado como las dos mitades del mismo síntoma: "entra pero la sala no carga" (se
// descarta la primera respuesta y queda vacía) y "escribe pero no le llega al alumno" (se
// descartan los polls del alumno y el mensaje no aparece jamás).
//
// Contexto medido ese día desde la escuela: 5% de pérdida, RTT 247-695 ms y TTFB de
// 1,75-2,90 s contra /health, que es la ruta más barata que hay. Cruzar los 4 s en los malos
// momentos no es un caso de laboratorio.

test('EL BUG: la respuesta lenta NO se tira por el pedido que salió después', () => {
  const cursor = enSala(10);

  // 1. El ciclo pide "desde el 10". El viaje va a tardar más de 4 segundos.
  const lento = cursor.pedir();

  // 2. A los 4 s el intervalo dispara otro, sin que el primero haya vuelto todavía.
  cursor.pedir();

  // 3. Vuelve el primero, con el mensaje que el docente escribió. Es la ÚNICA respuesta
  //    que llegó: no hay nada más nuevo pintado que pueda pisar.
  const d = cursor.recibir(resp(SESION, 11, [11]), lento);

  assert.equal(d.descartar, false, 'la única respuesta que llegó tiene que pintarse');
  assert.deepEqual(seqs(d.mensajes), [11]);
  assert.equal(cursor.seq, 11, 'y el cursor tiene que avanzar');
});

test('el criterio es lo ya PINTADO, no lo ya PEDIDO', () => {
  // Las dos caras juntas, para que no se pueda arreglar una rompiendo la otra.
  const cursor = enSala(10);
  const a = cursor.pedir();
  const b = cursor.pedir();
  const c = cursor.pedir();

  // `b` llega primero: no hay nada más nuevo pintado, se acepta.
  assert.equal(cursor.recibir(resp(SESION, 11, [11]), b).descartar, false);
  // `a` es ANTERIOR a lo que ya se pintó: se tira (el arreglo del 07/09 sigue en pie).
  assert.equal(cursor.recibir(resp(SESION, 10, []), a).descartar, true,
    'la vieja que llega tarde se sigue descartando');
  // `c` es POSTERIOR: se acepta, aunque `b` haya vuelto antes.
  //
  // Contesta desde el 11 y no desde el 12: `c` salió con `since = 10` —el cursor todavía no
  // había avanzado cuando se emitió—, así que el servidor le manda los dos. El 11 repetido no
  // molesta: el Set `vistos` del partial no lo pinta dos veces. Pedirle [12] a secas sería una
  // respuesta que el servidor nunca da, y ahí el cursor frena por hueco, con toda la razón.
  const dc = cursor.recibir(resp(SESION, 12, [11, 12]), c);
  assert.equal(dc.descartar, false);
  assert.equal(cursor.seq, 12);
});

test('con el viaje más largo que el intervalo, la sala igual se llena', () => {
  // La reproducción completa, con el reloj: 60 s de clase, 12 mensajes escritos, y el poll
  // saliendo cada 4 s. Con la regla vieja esto pintaba CERO mensajes y descartaba 14
  // respuestas seguidas, con el cursor clavado donde arrancó.
  const POLL = 4000;

  const corrida = (latencia) => {
    const cursor  = enSala(10);
    const enVuelo = [];
    let pintados = 0, servidor = 10;

    for (let t = 0; t <= 60000; t += 100) {
      if (t % POLL === 0) enVuelo.push({ pedido: cursor.pedir(), llega: t + latencia });
      if (t % 5000 === 0 && t > 0) servidor += 1;   // alguien escribe cada 5 s

      for (let i = enVuelo.length - 1; i >= 0; i--) {
        if (enVuelo[i].llega > t) continue;
        const { pedido } = enVuelo.splice(i, 1)[0];
        const msgs = [];
        for (let s = pedido.since + 1; s <= servidor; s++) msgs.push(s);
        const d = cursor.recibir(resp(SESION, servidor, msgs), pedido, t);
        if (!d.descartar) pintados += d.mensajes.length;
      }
    }
    return { pintados, cursor: cursor.seq, servidor };
  };

  // Por debajo del intervalo siempre anduvo, y tiene que seguir andando.
  const buena = corrida(1200);
  assert.equal(buena.pintados, 11, 'red buena: se pintan los 11 mensajes de la clase');

  // Por arriba es donde se caía a cero.
  for (const latencia of [4200, 6000, 9000]) {
    const r = corrida(latencia);
    assert.ok(r.pintados >= 11,
      `con ${latencia} ms de viaje se pintaron ${r.pintados} mensajes de 11`);
    assert.ok(r.cursor >= r.servidor - 1,
      `con ${latencia} ms de viaje el cursor quedó en ${r.cursor} y el servidor en ${r.servidor}`);
  }
});

// ── 6. El cableado del ciclo ────────────────────────────────────────────────

test('el poll se encadena y no sale cada 4 s pase lo que pase', () => {
  // La otra mitad del arreglo. Con `setInterval` los pedidos se apilan sin límite cuando la
  // red se pone lenta: son requests que el servidor atiende enteras (7 queries cada una) para
  // que el navegador tire casi todas. El ciclo encadenado saca UN pedido por vez.
  // Sin los comentarios: el bloque del ciclo NOMBRA el `setInterval(pollear, POLL)` viejo para
  // explicar por qué se fue, y buscar la cadena a secas da un falso positivo. Misma trampa que
  // en RN-4.
  const codigo = sala.replace(/\/\/.*$/gm, '');

  assert.ok(!/setInterval\(\s*pollear/.test(codigo),
    'el poll no puede volver a salir por intervalo fijo');
  assert.ok(!/setInterval\(\s*ciclo/.test(codigo),
    'tampoco encadenado por intervalo: la próxima vuelta se programa al terminar la anterior');
  assert.match(codigo, /setTimeout\(\s*ciclo/,
    'la vuelta siguiente se programa con setTimeout cuando la anterior terminó');
});

test('el pedido tiene plazo: un poll colgado no puede frenar el ciclo', () => {
  // Con el ciclo encadenado, una request que nunca vuelve dejaría la sala muda para siempre
  // — que es peor que el bug que este arreglo cierra. El corte lo pone un AbortController.
  const desde = sala.indexOf('async function pollear');
  const hasta = sala.indexOf('function programar', desde);
  assert.ok(desde > 0 && hasta > desde, 'no se encontró el bloque del poll');

  const bloque = sala.slice(desde, hasta);
  assert.match(bloque, /AbortController/, 'el fetch del poll necesita su corte por tiempo');
  assert.match(bloque, /signal/,          'y el signal tiene que llegar al fetch');
});

test('la cadena no se puede cortar: la próxima vuelta se programa en un finally', () => {
  // Con el ciclo encadenado, la cadena es LO ÚNICO que mantiene viva la sala. Si `programar()`
  // fuera después del `await`, cualquier excepción que se escapara de `pollear()` la saltearía
  // y la sala quedaría muda hasta que alguien recargue — que es el mismo síntoma que este
  // arreglo cierra, entrando por otra puerta.
  //
  // Hoy `pollear()` tiene su propio try/catch y no debería tirar nada. Pero eso lo garantiza el
  // código de al lado, no la estructura: alcanza con que alguien mueva una línea fuera de ese
  // try para reintroducir el congelamiento. Con el `setInterval` viejo no importaba, porque el
  // intervalo disparaba igual.
  const desde = sala.indexOf('async function ciclo');
  const hasta = sala.indexOf('function arrancar', desde);
  assert.ok(desde > 0 && hasta > desde, 'no se encontró el bloque del ciclo');

  const bloque = sala.slice(desde, hasta).replace(/\/\/.*$/gm, '');
  assert.match(bloque, /finally\s*\{[^}]*programar\(\)/,
    'programar() va DENTRO del finally, no después del await');
});

// ── 7. El ritmo del ciclo (RN-4) ────────────────────────────────────────────
//
// 4 s con la sala viva, 8 s en silencio. Una clase de 40 minutos son ráfagas con silencio en el
// medio, y preguntar cada 4 s durante el silencio es la mitad de los requests tirada.
//
// La regla vive en salaPoll.js y no en el partial por el mismo motivo que el cursor: dos
// estados y un contador es exactamente lo que "a ojo parece obvio" y después resulta que se
// queda pegado en lento, o que nunca afloja.

const RAPIDO = 4000, LENTO = 8000, VUELTAS = 3;
const ritmoDePrueba = () => crearRitmo({ rapido: RAPIDO, lento: LENTO, vueltas: VUELTAS });

test('el ritmo arranca rápido', () => {
  assert.equal(ritmoDePrueba().ms(), RAPIDO);
});

test('afloja recién a la N-ésima vuelta vacía, no antes', () => {
  const r = ritmoDePrueba();
  for (let i = 1; i < VUELTAS; i++) {
    assert.equal(r.registrar(false), RAPIDO, `en la vuelta vacía ${i} todavía tiene que ir rápido`);
  }
  assert.equal(r.registrar(false), LENTO, `en la vuelta ${VUELTAS} afloja`);
  assert.equal(r.registrar(false), LENTO, 'y se queda lento mientras siga el silencio');
});

test('⭐ vuelve a rápido EN EL ACTO, no de a poco', () => {
  // El reseteo es a cero y de golpe. Si fuera un decremento, la sala tardaría varias vueltas en
  // despertarse justo cuando arranca la conversación, que es el peor momento posible.
  const r = ritmoDePrueba();
  for (let i = 0; i < 10; i++) r.registrar(false);
  assert.equal(r.ms(), LENTO, 'precondición: está lento');

  assert.equal(r.registrar(true), RAPIDO, 'una sola novedad lo devuelve a rápido');
  assert.equal(r.vueltasSinNovedad, 0);
});

test('despertar() lo devuelve a rápido sin gastar una vuelta', () => {
  // Lo usa el regreso a la pestaña: quien vuelve a mirar quiere la sala al día ya.
  const r = ritmoDePrueba();
  for (let i = 0; i < 5; i++) r.registrar(false);
  assert.equal(r.ms(), LENTO);
  r.despertar();
  assert.equal(r.ms(), RAPIDO);
});

test('ms() no registra nada: se puede consultar sin mover el contador', () => {
  const r = ritmoDePrueba();
  r.registrar(false);
  const antes = r.vueltasSinNovedad;
  r.ms(); r.ms(); r.ms();
  assert.equal(r.vueltasSinNovedad, antes);
});

test('⭐ el ritmo lento tiene que quedar MUY por debajo de la ventana de presencia', () => {
  // Si el poll se espaciara más que ONLINE_WINDOW_MS (45 s), la gente empezaría a parpadear
  // dentro y fuera de la lista de conectados: dejaría de pinguear dentro de su propia ventana.
  // Este test es la guarda de ese invariante, y va contra las CONSTANTES, no contra los números.
  const { POLL_MS, ONLINE_WINDOW_MS } = require('../../services/liveRoom');

  const m = sala.match(/lento:\s*POLL\s*\*\s*(\d+)/);
  assert.ok(m, 'el ritmo lento tiene que derivarse de POLL, no escribirse a mano');
  const lento = POLL_MS * Number(m[1]);

  assert.ok(lento < ONLINE_WINDOW_MS / 3,
    `el ritmo lento (${lento} ms) tiene que dejar al menos 3 vueltas dentro de la ventana de ${ONLINE_WINDOW_MS} ms`);
});

test('RN-4: el partial usa el ritmo para programar, y la presencia cuenta como novedad', () => {
  const codigo = sala.replace(/\/\/.*$/gm, '');

  assert.match(codigo, /SalaPoll\.crearRitmo\(/, 'el partial tiene que crear el ritmo');
  assert.match(codigo, /setTimeout\(ciclo,\s*ms === undefined \? ritmo\.ms\(\) : ms\)/,
    'programar() sin argumento tiene que preguntarle al ritmo');
  assert.match(codigo, /ritmo\.registrar\(hubo\)/, 'cada vuelta tiene que registrarse');
  assert.match(codigo, /ritmo\.despertar\(\)/, 'volver a la pestaña despierta el ritmo');

  // La fila de presencia cuenta como novedad. Sale gratis: desde RN-2 las listas solo viajan
  // cuando cambiaron, así que su sola presencia ya es la señal.
  assert.match(codigo, /const hubo = d\.mensajes\.length > 0 \|\| d\.reinicio \|\| !!\(s\.presencia && s\.presencia\.conectados\)/,
    'la novedad tiene que mirar mensajes, repintado y presencia');
});
