// Envoltorio de mediasoup: workers, routers y transportes. Nada de reglas de negocio acá
// adentro —esas están en media/aforo.js y en services/transmision.js— y nada de Mongo.
//
// ⭐ POR QUÉ ESTE ARCHIVO NO PUEDE VIVIR DENTRO DE LOS WORKERS DE EXPRESS (D2):
//
// Un `router` de mediasoup vive en la MEMORIA de un proceso. `ecosystem.config.js` corre la app
// en modo cluster con 2 instancias, así que la señalización de un alumno puede caer en el
// worker A mientras el router de su clase está en el B. No sería un bug intermitente raro:
// fallaría LA MITAD DE LAS VECES, al azar. Por eso todo esto corre en un proceso propio
// (media/servidor.js, PM2 en modo fork con instancia única).

const mediasoup = require('mediasoup');

const {
  CODECS, MEDIA_WORKERS, RTC_MIN_PORT, RTC_MAX_PORT,
  RTC_LISTEN_IP, RTC_ANNOUNCED_IP,
} = require('../config/transmision');

// Los workers C++. Se reparten las salas por turno rotativo (round robin): un SFU no
// transcodifica, así que la carga de una sala es casi lineal en la cantidad de consumidores y
// repartirlas parejo alcanza.
const workers = [];
let proximoWorker = 0;

// sessionId → { router, transportes:Map, productores:Map, espectadores:Set, ... }
const salas = new Map();

async function iniciar(log = console) {
  const puertosPorWorker = Math.floor((RTC_MAX_PORT - RTC_MIN_PORT + 1) / MEDIA_WORKERS);

  for (let i = 0; i < MEDIA_WORKERS; i++) {
    const min = RTC_MIN_PORT + i * puertosPorWorker;
    const max = min + puertosPorWorker - 1;

    const w = await mediasoup.createWorker({
      rtcMinPort: min,
      rtcMaxPort: max,
      logLevel: 'warn',
    });

    // Un worker que muere se lleva puestas todas las clases que tenía. No se puede recuperar
    // desde acá —los navegadores tienen que renegociar— así que lo único honesto es dejarlo
    // escrito bien fuerte en el log y que PM2 reinicie el proceso entero.
    w.on('died', () => {
      log.error(`[sfu] el worker ${w.pid} MURIÓ: se cortaron las clases que atendía`);
      setTimeout(() => process.exit(1), 1000);
    });

    workers.push(w);
    log.info?.(`[sfu] worker ${w.pid} listo, puertos UDP ${min}-${max}`);
  }
  return workers.length;
}

function siguienteWorker() {
  const w = workers[proximoWorker];
  proximoWorker = (proximoWorker + 1) % workers.length;
  return w;
}

// La sala de una sesión, creándola si hace falta.
async function salaDe(sessionId) {
  const id = String(sessionId);
  if (salas.has(id)) return salas.get(id);

  const router = await siguienteWorker().createRouter({ mediaCodecs: CODECS });
  const sala = {
    id,
    router,
    transportes:  new Map(),   // transportId → transport
    productores:  new Map(),   // productorId → producer
    consumidores: new Map(),   // consumidorId → consumer
    // Quiénes están MIRANDO. Es lo que alimenta al gobernador, así que cuenta a todos los que
    // reciben bytes — incluido el directivo en modo observación, que no aparece en la lista de
    // la sala pero sí consume puerto. Los bytes son bytes.
    espectadores: new Set(),
    emisor:       null,
    creadaAt:     Date.now(),
    bytes:        0,
    picoEspectadores: 0,
  };
  salas.set(id, sala);
  return sala;
}

// Transporte WebRTC para un navegador.
//
// `enableTcp` es la red de D11: cubre las conexiones que no pueden hacer UDP saliente. Con
// `preferUdp` se intenta UDP primero y TCP solo si aquel no prospera, que es lo correcto —
// el TCP para media agrega retraso y reintentos.
async function crearTransporte(sala) {
  const t = await sala.router.createWebRtcTransport({
    listenIps: [{ ip: RTC_LISTEN_IP, announcedIp: RTC_ANNOUNCED_IP || undefined }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 600000,
  });

  t.on('dtlsstatechange', (s) => { if (s === 'closed') t.close(); });
  sala.transportes.set(t.id, t);

  return {
    transporte: t,
    parametros: {
      id: t.id,
      iceParameters:  t.iceParameters,
      iceCandidates:  t.iceCandidates,
      dtlsParameters: t.dtlsParameters,
    },
  };
}

// Un consumidor: el flujo que el SFU le manda a UN espectador de UN productor.
//
// Arranca PAUSADO a propósito y lo reanuda el cliente después de crearlo. Es la receta que
// recomienda mediasoup: si arranca corriendo, los primeros paquetes llegan antes de que el
// navegador haya terminado de preparar el <video> y se pierden — lo que se ve como un video
// que tarda varios segundos en aparecer, o que aparece en negro.
async function crearConsumidor(sala, transporte, producerId, rtpCapabilities) {
  if (!sala.router.canConsume({ producerId, rtpCapabilities })) return null;

  const c = await transporte.consume({
    producerId,
    rtpCapabilities,
    paused: true,
  });
  sala.consumidores.set(c.id, c);
  c.on('transportclose', () => sala.consumidores.delete(c.id));
  c.on('producerclose',  () => sala.consumidores.delete(c.id));

  return {
    consumidor: c,
    parametros: {
      id: c.id, producerId, kind: c.kind, rtpParameters: c.rtpParameters,
    },
  };
}

// Le baja (o sube) la capa a un espectador. Es lo que ejecuta la decisión del gobernador sobre
// una transmisión YA en curso.
//
// `spatialLayer` es el índice de la capa de simulcast: 0 = la más chica (180p), 1 = 360p.
// Un consumidor de audio no tiene capas y se ignora en silencio.
async function aplicarCapa(sala, capa) {
  const spatial = capa === '360p' ? 1 : 0;
  for (const c of sala.consumidores.values()) {
    if (c.kind !== 'video') continue;
    try {
      if (capa === 'audio') await c.pause();
      else { await c.resume(); await c.setPreferredLayers({ spatialLayer: spatial }); }
    } catch (e) { /* un consumidor que se cerró en el medio no es un error */ }
  }
}

// Cierra una sala entera y libera sus puertos.
function cerrarSala(sessionId) {
  const sala = salas.get(String(sessionId));
  if (!sala) return false;
  // Cerrar el router cierra en cascada transportes, productores y consumidores.
  try { sala.router.close(); } catch (e) { /* ya estaba cerrado */ }
  salas.delete(String(sessionId));
  return true;
}

// El estado agregado que consume Express (services/mediaClient.js) para alimentar al gobernador.
function estado() {
  const porSala = {};
  let espectadores = 0;

  for (const [id, s] of salas) {
    const n = s.espectadores.size;
    espectadores += n;
    porSala[id] = {
      espectadores: n,
      pico:         s.picoEspectadores,
      emisor:       !!s.emisor,
      desdeMs:      Date.now() - s.creadaAt,
    };
  }

  return {
    espectadores,
    clases:  salas.size,
    workers: workers.length,
    salas:   porSala,
  };
}

module.exports = {
  iniciar, salaDe, crearTransporte, crearConsumidor, aplicarCapa,
  cerrarSala, estado, salas,
};
