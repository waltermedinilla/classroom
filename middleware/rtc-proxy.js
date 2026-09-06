// Túnel del WebSocket de señalización: Express reenvía el `upgrade` de /rtc al proceso de
// medios (media/servidor.js, en 127.0.0.1:4100).
//
// ── POR QUÉ ESTO EXISTE, Y POR QUÉ ES MEJOR QUE HACERLO EN CADDY ────────────────────────────
//
// El plan original era un bloque en el Caddyfile. Funciona, pero deja DOS problemas:
//
//   1. En desarrollo no hay Caddy. El navegador abre `localhost:3000/rtc`, Express no atiende
//      esa ruta y no se puede probar la transmisión sin desplegarla. Probar una feature de
//      video por primera vez EN PRODUCCIÓN es exactamente lo que no hay que hacer.
//   2. Es un paso de despliegue más que hay que acordarse de hacer, en un proyecto donde los
//      pasos manuales del deploy ya tienen su propio historial de olvidos.
//
// Haciéndolo acá, el mismo código funciona en las dos partes y no hay nada que configurar.
//
// ⚠️ ESTO NO REINTRODUCE EL PROBLEMA DEL CLUSTER (D2). Los dos workers de PM2 hacen de proxy
// al MISMO proceso único de medios, así que el router de mediasoup sigue viviendo en un solo
// lugar. Da igual qué worker atienda el upgrade: el otro extremo siempre es el mismo.
//
// Y por acá pasa SOLO señalización —SDP, candidatos ICE, avisos—, unos pocos KB por persona al
// entrar. **El audio y el video NUNCA tocan Node**: viajan por UDP directo del navegador al
// SFU. Si esto llevara el media, sería una idea terrible.

const http = require('http');
const { MEDIA_PORT, WS_PATH } = require('../config/transmision');

// Reconstruye la respuesta 101 tal como la mandó el proceso de medios. Hay que escribirla a
// mano sobre el socket: en un upgrade ya no hay objeto `res` que sepa serializarla.
function respuesta101(proxyRes) {
  const lineas = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
  for (const [k, v] of Object.entries(proxyRes.headers)) {
    // Un header puede venir repetido (array). Aplanarlo con join lo rompería.
    for (const uno of Array.isArray(v) ? v : [v]) lineas.push(`${k}: ${uno}`);
  }
  return lineas.join('\r\n') + '\r\n\r\n';
}

// Se engancha al servidor http que devuelve app.listen().
//
// `puerto` existe para los tests: sin él, tests/unit/rtcProxy.test.js tendría que levantar su
// proceso de medios de mentira en el MEDIA_PORT real, y explotaba con EADDRINUSE cada vez que
// había uno de verdad corriendo en la máquina de desarrollo. Un test que solo pasa cuando no
// estás trabajando no sirve para nada.
function montarProxyRtc(server, logger = console, { puerto = MEDIA_PORT } = {}) {
  server.on('upgrade', (req, socket, head) => {
    // Cualquier otro upgrade no es asunto nuestro. Se corta y listo: hoy la app no tiene
    // ningún otro WebSocket, así que un upgrade a otra ruta solo puede ser un sondeo.
    if (!req.url || !req.url.startsWith(WS_PATH)) return socket.destroy();

    socket.on('error', () => socket.destroy());

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: puerto,
      path: req.url,
      method: 'GET',
      headers: req.headers,
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', () => proxySocket.destroy());

      socket.write(respuesta101(proxyRes));

      // Los bytes que ya vinieron pegados al handshake. Sin devolverlos a la cola, el primer
      // mensaje de la conversación se pierde — y como el primero es siempre el 'hola' con el
      // ticket, la sesión no arrancaría nunca y el síntoma sería "a veces no conecta".
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      if (head && head.length) proxySocket.write(head);

      socket.setNoDelay(true);
      proxySocket.setNoDelay(true);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      const cerrarLosDos = () => { socket.destroy(); proxySocket.destroy(); };
      socket.on('close', cerrarLosDos);
      proxySocket.on('close', cerrarLosDos);
    });

    // El proceso de medios caído, o el puerto cerrado. NO es un error de la aplicación: el
    // navegador ve que el WebSocket no abrió, reintenta, y termina mostrando "se cortó la
    // transmisión, podés seguir con el chat" (RN-10). La sala no se entera.
    proxyReq.on('error', (err) => {
      logger.warn?.('rtc-proxy: no se pudo hablar con el proceso de medios', { error: err.message });
      socket.destroy();
    });

    proxyReq.end();
  });
}

module.exports = { montarProxyRtc, respuesta101 };
