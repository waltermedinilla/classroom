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
const { planDeVideo } = require('./aforo');

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

    // Hablar (specs/sala-hablar.spec.md).
    // `soloVoz`: el docente la abrió desde "Hablar" (su ticket no trae video). Sus oyentes NO se
    // cuentan como espectadores de video para el gobernador: 450 chicos escuchando a 40 kbps no
    // pueden bajarle la calidad a una clase con pantalla como si fueran 450 mirando en 360p.
    soloVoz:      false,
    // ws → contexto de la conexión, de los ALUMNOS que tienen una voz (productor de audio). Es
    // lo que cuenta el tope de voces y lo que cierra /cerrar-voces.
    vocesAlumnos: new Map(),
    // Para el registro histórico (H9): cuántos distintos hablaron y cuántas veces el tope dijo
    // que no. Nunca QUÉ dijeron.
    alumnosQueHablaron: new Set(),
    rechazadasPorTope:  0,
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

  // La fuente ('camara', 'pantalla', ...) viaja pegada al consumidor: es lo que decide si una
  // cámara es la grande o la chica (C3 de specs/transmision-camara-primero.spec.md).
  const fuente = sala.productores.get(producerId)?.appData?.fuente || '';
  const c = await transporte.consume({
    producerId,
    rtpCapabilities,
    paused: true,
    appData: { fuente },
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
//
// La decisión por consumidor la toma planDeVideo (media/aforo.js, pura y testeada): acá solo se
// ejecuta. Una cámara con pantalla al lado es la cámara CHICA y va en la capa baja.
async function aplicarCapaA(sala, c, capa) {
  if (c.kind !== 'video' || c.closed) return;
  const plan = planDeVideo({
    fuente: c.appData?.fuente || '',
    hayPantalla: hayFuente(sala, 'pantalla'),
    capa: capa || sala.capaVigente || '360p',
  });
  try {
    if (plan.pausar) { await c.pause(); return; }
    await c.resume();
    await c.setPreferredLayers({ spatialLayer: plan.capa });
  } catch (e) { /* un consumidor que se cerró en el medio no es un error */ }
}

async function aplicarCapa(sala, capa) {
  for (const c of sala.consumidores.values()) await aplicarCapaA(sala, c, capa);
}

// Los productores al aire como los ve el navegador, CON su fuente: es lo que viaja en el
// 'bienvenido'. Sin la fuente, quien entra tarde no sabe cuál pista es la pantalla y cuál la
// cámara (C2 de specs/transmision-camara-primero.spec.md).
function describirProductores(sala) {
  return [...sala.productores.values()]
    .filter(p => !p.closed)
    .map(p => ({ id: p.id, kind: p.kind, fuente: p.appData?.fuente || '' }));
}

// ¿Hay al aire un productor de esta fuente en la sala?
function hayFuente(sala, fuente) {
  for (const p of sala.productores.values()) {
    if (!p.closed && p.appData?.fuente === fuente) return true;
  }
  return false;
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

  let oyentesVoz = 0;
  let clasesVideo = 0;
  // Espectadores que reciben además la cámara chica (pantalla + cámara al aire). El gobernador
  // la suma a su cuenta: ver CAMARA_CHICA_MBPS en config/transmision.js.
  let conPantallaYCamara = 0;

  for (const [id, s] of salas) {
    const n = s.espectadores.size;
    // Los oyentes de "Hablar" van en su propio contador: el gobernador raciona VIDEO, y la voz
    // no entra en su escalera (ver MBPS_VOZ en config/transmision.js).
    if (s.soloVoz) oyentesVoz += n;
    else {
      espectadores += n; clasesVideo += 1;
      if (hayFuente(s, 'pantalla') && hayFuente(s, 'camara')) conPantallaYCamara += n;
    }
    porSala[id] = {
      espectadores: n,
      pico:         s.picoEspectadores,
      emisor:       !!s.emisor,
      desdeMs:      Date.now() - s.creadaAt,
      soloVoz:      s.soloVoz,
      alumnosQueHablaron: s.alumnosQueHablaron.size,
      rechazadasPorTope:  s.rechazadasPorTope,
    };
  }

  return {
    espectadores,
    conPantallaYCamara,
    oyentesVoz,
    clasesVideo,
    clases:  salas.size,
    workers: workers.length,
    salas:   porSala,
  };
}

module.exports = {
  iniciar, salaDe, crearTransporte, crearConsumidor, aplicarCapa, aplicarCapaA, hayFuente, describirProductores,
  cerrarSala, estado, salas, workers,
};
