// El túnel del WebSocket de señalización (middleware/rtc-proxy.js).
//
// Es la pieza que hace que la transmisión se pueda probar en la máquina de desarrollo, donde no
// hay Caddy. Y es de las que fallan en SILENCIO: si se pierde el primer mensaje —que es siempre
// el 'hola' con el ticket— el síntoma no es un error, es "a veces no conecta".
//
// No levanta Express entero: monta el proxy sobre un servidor http pelado y del otro lado pone
// un WebSocket de juguete. Así se prueba el túnel y nada más que el túnel.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const { WS_PATH } = require('../../config/transmision');
const { montarProxyRtc } = require('../../middleware/rtc-proxy');

// Puertos PROPIOS, no los reales.
//
// El destino de prueba escuchaba en MEDIA_PORT (4100) y el test explotaba con EADDRINUSE cada
// vez que había un proceso de medios de verdad corriendo en la máquina — o sea, justo cuando
// uno está trabajando en esta feature. Por eso montarProxyRtc acepta el puerto por parámetro.
const PUERTO_FRENTE  = 4199;
const PUERTO_DESTINO = 4198;

let destino, frente, recibidosPorElDestino;

const silencio = { warn: () => {} };

before(async () => {
  // ── El "proceso de medios" de juguete ──────────────────────────────────────
  recibidosPorElDestino = [];
  destino = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server: destino, path: WS_PATH });
  wss.on('connection', (ws, req) => {
    ws.on('message', (d) => {
      recibidosPorElDestino.push(String(d));
      ws.send(JSON.stringify({ eco: String(d) }));
    });
    // Se devuelve una cabecera propia para comprobar que la respuesta 101 se reconstruye
    // entera y no solo el código de estado.
    ws.send(JSON.stringify({ hola: true, urlQueLlego: req.url }));
  });
  await new Promise(r => destino.listen(PUERTO_DESTINO, '127.0.0.1', r));

  // ── El "Express" que hace de frente ────────────────────────────────────────
  frente = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  montarProxyRtc(frente, silencio, { puerto: PUERTO_DESTINO });
  await new Promise(r => frente.listen(PUERTO_FRENTE, '127.0.0.1', r));
});

after(async () => {
  await new Promise(r => frente.close(r));
  await new Promise(r => destino.close(r));
});

function abrir(ruta = WS_PATH) {
  return new WebSocket(`ws://127.0.0.1:${PUERTO_FRENTE}${ruta}`);
}

test('⭐ el WebSocket atraviesa el proxy y llega al proceso de medios', async () => {
  const ws = abrir();
  const primero = await new Promise((res, rej) => {
    ws.on('message', (d) => res(JSON.parse(d)));
    ws.on('error', rej);
    setTimeout(() => rej(new Error('timeout')), 5000);
  });
  assert.strictEqual(primero.hola, true);
  assert.strictEqual(primero.urlQueLlego, WS_PATH, 'la ruta tiene que llegar tal cual');
  ws.close();
});

test('⭐ el PRIMER mensaje no se pierde', async () => {
  // Es el que importa: el primero es siempre el 'hola' con el ticket. Si se perdiera, la
  // sesión no arrancaría nunca y el síntoma sería "a veces no conecta" — sin ningún error.
  const ws = abrir();
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send('{"t":"hola","ticket":"xxx"}');

  const eco = await new Promise((res, rej) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.eco) res(m.eco);
    });
    setTimeout(() => rej(new Error('el mensaje no volvió')), 5000);
  });
  assert.strictEqual(eco, '{"t":"hola","ticket":"xxx"}');
  ws.close();
});

test('los mensajes van y vuelven en orden', async () => {
  const ws = abrir();
  await new Promise(r => ws.on('open', r));
  const antes = recibidosPorElDestino.length;
  for (const m of ['uno', 'dos', 'tres']) ws.send(m);

  await new Promise((res, rej) => {
    const reloj = setInterval(() => {
      if (recibidosPorElDestino.length >= antes + 3) { clearInterval(reloj); res(); }
    }, 50);
    setTimeout(() => { clearInterval(reloj); rej(new Error('no llegaron los tres')); }, 5000);
  });
  assert.deepStrictEqual(recibidosPorElDestino.slice(antes, antes + 3), ['uno', 'dos', 'tres']);
  ws.close();
});

test('una ruta que no es /rtc se corta y no llega a ningún lado', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PUERTO_FRENTE}/otra-cosa`);
  await new Promise((res) => { ws.on('error', res); ws.on('close', res); });
  assert.ok(true, 'no tiene que quedar colgado');
});

test('el HTTP normal sigue funcionando: el proxy solo toca el upgrade', async () => {
  const r = await fetch(`http://127.0.0.1:${PUERTO_FRENTE}/cualquier-cosa`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'ok');
});

test('⭐ con el proceso de medios CAÍDO, el frente no se cae (RN-10)', async () => {
  // Es la mitad del diseño: si el SFU no está, la sala tiene que seguir andando entera y el
  // navegador limitarse a decir que no hay transmisión.
  await new Promise(r => destino.close(r));

  const ws = abrir();
  await new Promise((res) => { ws.on('error', res); ws.on('close', res); });

  // Y lo que de verdad se prueba acá: el servidor de adelante sigue contestando.
  const r = await fetch(`http://127.0.0.1:${PUERTO_FRENTE}/sigo-vivo`);
  assert.strictEqual(r.status, 200);

  // Se vuelve a levantar para no dejar el estado sucio si se agregan tests después.
  destino = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(r2 => destino.listen(PUERTO_DESTINO, '127.0.0.1', r2));
});

test('la respuesta 101 conserva los headers repetidos', () => {
  const { respuesta101 } = require('../../middleware/rtc-proxy');
  const texto = respuesta101({
    statusCode: 101, statusMessage: 'Switching Protocols',
    headers: { upgrade: 'websocket', 'set-cookie': ['a=1', 'b=2'] },
  });
  // Aplanar un header repetido con join lo rompe: tienen que salir en dos líneas.
  assert.match(texto, /set-cookie: a=1/);
  assert.match(texto, /set-cookie: b=2/);
  assert.ok(texto.endsWith('\r\n\r\n'), 'la respuesta termina en la línea en blanco');
});
