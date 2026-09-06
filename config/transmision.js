// Constantes de la transmisión en vivo, TODAS acá y con su fundamento al lado.
//
// Mismo criterio que services/liveRoom.js: si algún día hay que aflojar el techo de calidad o
// cambiar el rango de puertos, se toca este archivo y nada más.
//
// ⚠️ Este archivo lo leen DOS procesos distintos: los workers de Express y el proceso de medios
// (media/servidor.js). No puede requerir mongoose ni ningún modelo — el proceso de medios no
// tiene conexión a la base y no debe tenerla (ver D4 de specs/transmision-en-vivo.spec.md).

// ── Presupuesto de ancho de banda ────────────────────────────────────────────

// Subida reservada a la transmisión, en Mbit/s.
//
// El VPS de Contabo tiene un puerto de entre 200 Mbit/s y 1 Gbit/s según el plan; 160 es el
// 80 % del PEOR caso, y el 20 % restante queda para el resto de la plataforma: las páginas, las
// entregas (15 GB en disco) y los backups.
//
// ⚠️ Es el número más importante del archivo y todavía NO está medido — sale de la hoja de
// datos de Contabo, no del cable. La Fase 0 de la spec existe para confirmarlo. Si el puerto
// resulta ser de 1 Gbit/s, acá se pone 800 y todo lo demás se acomoda solo.
const PRESUPUESTO_MBPS = 160;

// Consumo por espectador de cada capa, en Mbit/s, ya con el audio adentro.
//
// Los números de video son las capas estándar de simulcast (125 / 400 kbps a 180p / 360p) y el
// audio es Opus mono con DTX (~32 kbps). Se guardan SUMADOS y no por separado a propósito: la
// pregunta que se hace todo el tiempo es "cuánto me cuesta un alumno más", y esa pregunta no
// tiene sentido partida en dos.
const CAPAS = [
  { id: '360p',  mbps: 0.432, umbral: 0.60, etiqueta: 'Calidad media',  alto: 360 },
  { id: '180p',  mbps: 0.157, umbral: 0.80, etiqueta: 'Calidad baja',   alto: 180 },
  { id: 'audio', mbps: 0.032, umbral: 0.95, etiqueta: 'Solo audio',     alto: 0   },
];

// 720p NO está en la lista, y no es un olvido: un aula de 30 alumnos en 720p son 76 Mbit/s, el
// 47 % del presupuesto entero. Tres clases saturan el puerto y lo que se cae no es el video,
// es la plataforma para todos. Agregarlo acá sería deshacer la feature.
const CAPA_MAXIMA_EMISOR = '360p';

// Red de seguridad, NO el gobernador. El gobernador raciona ancho de banda (ver media/aforo.js);
// esto solo ataja un desborde raro —un bucle que abre salas, un script suelto— antes de que se
// coma el puerto. Con la escuela entera transmitiendo no se llega ni cerca.
const MAX_CLASES = 20;

// ── Ticket de acceso al proceso de medios ────────────────────────────────────

// Vida del ticket JWT que Express le firma al navegador (D4). 60 segundos alcanza de sobra para
// abrir el WebSocket y es lo que hace que revocarle la transmisión a alguien surta efecto
// enseguida: el ticket no se renueva desde el proceso de medios, hay que volver a Express.
const TICKET_TTL_S = 60;

// ── La palabra del alumno ────────────────────────────────────────────────────

// Sin audio durante este rato, la palabra se corta sola. Evita el micrófono abierto y olvidado
// en la casa de un chico, que es lo peor que puede pasar en una sala de menores.
const PALABRA_INACTIVA_MS = 5 * 60 * 1000;

// ── Red ──────────────────────────────────────────────────────────────────────

// Puerto local del proceso de medios. Solo escucha en 127.0.0.1: quien entra de afuera pasa
// por Caddy, que además es quien termina el TLS.
const MEDIA_PORT = Number(process.env.MEDIA_PORT || 4100);

// Ruta del WebSocket de señalización, tal como la publica Caddy.
const WS_PATH = '/rtc';

// Rango de puertos UDP por donde viaja el media. Son 200: cada transporte de WebRTC toma uno,
// así que alcanza para 200 conexiones simultáneas por worker de mediasoup.
//
// ⚠️ Hay que abrirlos en ufw, que hoy permite 22, 80 y 443 y nada más. Sin esto la señalización
// anda perfecto, el estado dice "transmitiendo" y NO HAY AUDIO — el síntoma más difícil de
// diagnosticar de todos, porque parece un problema de WebRTC y es el firewall.
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 40199);

// IP pública que el SFU anuncia en sus candidatos ICE.
//
// ⭐⭐ ACÁ ESTÁ EL ERROR QUE MÁS CARO SALE DE TODA LA FEATURE, Y NO DA NINGÚN SÍNTOMA ÚTIL.
//
// Escuchar en `0.0.0.0` es lo natural y es lo que estaba escrito acá al principio. El problema
// es que mediasoup entonces ANUNCIA `0.0.0.0` como dirección del candidato ICE — y ninguna
// máquina del mundo puede conectarse a 0.0.0.0.
//
// Lo brutal es cómo se ve: la señalización anda perfecto, el transporte se crea, el productor
// se crea, el simulcast reporta sus dos capas, la aplicación dice "transmitiendo"… y no viaja
// un solo byte. `packetsSent: 0`, para siempre, sin un error en ningún log. Se descubrió el
// 2026-08-31 probándolo en el navegador; ningún test de señalización lo habría visto, porque
// la señalización está bien.
//
// La regla de mediasoup es: si escuchás en 0.0.0.0, TENÉS que anunciar una IP alcanzable.
// Así que si nadie la fijó, se detecta sola — y si no se puede detectar, el proceso se niega
// a arrancar en vez de quedar transmitiendo al vacío (ver media/servidor.js).
//
// En el VPS de Contabo la IP pública está DIRECTAMENTE sobre eth0 (169.58.248.255/17, sin NAT),
// así que la detección encuentra la correcta sin configurar nada. En una máquina detrás de NAT
// —o si algún día hay un proveedor que sí NATea— hay que fijar `RTC_ANNOUNCED_IP` a mano con
// la IP pública, porque eso no se puede adivinar desde adentro.
const RTC_LISTEN_IP = process.env.RTC_LISTEN_IP || '0.0.0.0';

// La IPv4 más "anunciable" de la máquina.
//
// No alcanza con tomar la primera no interna: en la máquina de desarrollo la primera que
// aparece es la de **Tailscale** (rango 100.64.0.0/10), que no sirve para probar con dos
// navegadores en la red de casa. Así que se ordenan por preferencia:
//
//   1. Pública          → es lo que tiene el VPS de Contabo en eth0. La correcta en producción.
//   2. LAN privada      → 192.168.x, 10.x, 172.16-31.x. La correcta para probar en casa.
//   3. CGNAT / Tailscale→ 100.64-127.x. Último recurso: funciona, pero solo dentro de esa red.
//
// Se descartan del todo las link-local (169.254.x), que nunca sirven para esto.
function detectarIp() {
  const nets = require('os').networkInterfaces();
  const candidatas = [];

  for (const nombre of Object.keys(nets)) {
    for (const n of nets[nombre] || []) {
      const esV4 = n.family === 'IPv4' || n.family === 4;
      if (!esV4 || n.internal) continue;
      candidatas.push(n.address);
    }
  }

  const rango = (ip) => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 169 && b === 254) return 9;                       // link-local: inservible
    if (a === 100 && b >= 64 && b <= 127) return 3;             // CGNAT / Tailscale
    if (a === 10) return 2;
    if (a === 192 && b === 168) return 2;
    if (a === 172 && b >= 16 && b <= 31) return 2;
    return 1;                                                    // pública
  };

  const ordenadas = candidatas.filter(ip => rango(ip) < 9).sort((x, y) => rango(x) - rango(y));
  return ordenadas[0] || null;
}

// Las otras que había, para poder escribirlas en el log del arranque.
//
// ⚠️ En el VPS no hay ambigüedad: hay una sola interfaz y su IP es pública, así que gana por
// rango. En una máquina de desarrollo con Wi-Fi + VirtualBox + Tailscale hay tres candidatas
// del mismo rango y la elección es un empate resuelto por el orden en que las lista el sistema.
// Por eso el proceso las IMPRIME TODAS al arrancar: si eligió mal, se ve en el acto en vez de
// descubrirse como "no se escucha nada". Se arregla con RTC_ANNOUNCED_IP en el .env.
function ipsCandidatas() {
  const nets = require('os').networkInterfaces();
  const out = [];
  for (const nombre of Object.keys(nets)) {
    for (const n of nets[nombre] || []) {
      const esV4 = n.family === 'IPv4' || n.family === 4;
      if (esV4 && !n.internal) out.push(`${nombre}=${n.address}`);
    }
  }
  return out;
}

// `null` es un valor legítimo solo cuando se escucha en una IP concreta: ahí mediasoup anuncia
// esa misma, que ya es alcanzable.
const RTC_ANNOUNCED_IP = process.env.RTC_ANNOUNCED_IP
  || (RTC_LISTEN_IP === '0.0.0.0' || RTC_LISTEN_IP === '::' ? detectarIp() : null);

// Cuántos workers de mediasoup levantar. Cada uno es un proceso C++ que usa un núcleo; el VPS
// tiene 8 y la app se lleva 2. Con 4 sobra para toda la escuela: un SFU no transcodifica, solo
// reenvía paquetes.
const MEDIA_WORKERS = Number(process.env.MEDIA_WORKERS || 4);

// ── Códecs ───────────────────────────────────────────────────────────────────

// VP8 y no VP9/AV1: es el que TODOS los navegadores encodean por hardware, incluidas las
// netbooks del aula. VP9 comprime mejor y le cuesta la CPU al docente, que es justo la máquina
// más débil de la cadena.
const CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2,
    parameters: { useinbandfec: 1, usedtx: 1 } },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 400 } },
];

const CAPAS_BY_ID = Object.fromEntries(CAPAS.map(c => [c.id, c]));

// Cuánto consume un espectador en esta capa. Una capa desconocida devuelve 0 y NO revienta:
// esto se llama en el camino caliente y un dato viejo no puede tumbar la sala.
const mbpsDeCapa = (capa) => CAPAS_BY_ID[capa]?.mbps || 0;

module.exports = {
  detectarIp, ipsCandidatas,
  PRESUPUESTO_MBPS, CAPAS, CAPAS_BY_ID, CAPA_MAXIMA_EMISOR, MAX_CLASES,
  TICKET_TTL_S, PALABRA_INACTIVA_MS,
  MEDIA_PORT, WS_PATH, RTC_MIN_PORT, RTC_MAX_PORT,
  RTC_LISTEN_IP, RTC_ANNOUNCED_IP, MEDIA_WORKERS, CODECS,
  mbpsDeCapa,
};
