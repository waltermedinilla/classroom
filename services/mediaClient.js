// El puente entre los workers de Express y el proceso de medios (media/servidor.js).
//
// Existe por la decisión D2: el SFU vive en UN proceso aparte (PM2 fork, instancia única)
// porque los routers de mediasoup viven en memoria y el cluster de Express tiene dos workers.
// Express necesita preguntarle dos cosas —cuánta gente está mirando y cuánto se está
// consumiendo— y avisarle una: "cerrá esta transmisión".
//
// ⭐ LO MÁS IMPORTANTE DE ESTE ARCHIVO ES QUE NUNCA PUEDE ROMPER LA SALA.
//
// El poll de la sala corre cada 4 segundos por cada persona conectada; es el camino más
// caliente de la app. Si el proceso de medios está caído, o tarda, la sala tiene que seguir
// funcionando entera —chat, presencia, adjuntos— y limitarse a decir que no hay transmisión
// (RN-10). Por eso todo acá adentro tiene timeout corto y falla hacia un valor seguro, nunca
// hacia una excepción.

const { MEDIA_PORT } = require('../config/transmision');

const BASE = `http://127.0.0.1:${MEDIA_PORT}`;

// Cuánto vale un estado antes de volver a preguntarlo.
//
// El número sale de una cuenta, no del gusto: con 30 personas en una sala polleando cada 4 s
// serían ~7 preguntas por segundo al proceso de medios para un dato que cambia despacio. Con
// 3 segundos de cache, es 1 cada 3 segundos para toda la escuela.
const CACHE_MS = 3000;

// Timeout de cada pedido. Corto a propósito: esto está en el camino del poll, y es preferible
// contestar "no sé" al instante que hacer esperar a treinta navegadores.
const TIMEOUT_MS = 800;

// El valor con el que se contesta cuando el proceso de medios no está. NO es un error: es
// "no hay transmisión", que es exactamente lo que el usuario tiene que ver.
const SIN_MEDIOS = { arriba: false, espectadores: 0, clases: 0, mbps: 0, ocupacion: 0, salas: {} };

let cache = { at: 0, datos: SIN_MEDIOS };
let enVuelo = null;

async function pedir(ruta, opciones = {}) {
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE + ruta, { ...opciones, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    // Proceso caído, timeout, puerto cerrado: todo es lo mismo desde acá.
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

// El estado global del SFU. Cacheado y COMPARTIDO entre los pedidos concurrentes: sin
// `enVuelo`, treinta polls que llegan en el mismo tick abrirían treinta conexiones.
async function estado() {
  if (Date.now() - cache.at < CACHE_MS) return cache.datos;
  if (enVuelo) return enVuelo;

  enVuelo = (async () => {
    const datos = await pedir('/estado');
    cache = { at: Date.now(), datos: datos ? { arriba: true, ...datos } : SIN_MEDIOS };
    enVuelo = null;
    return cache.datos;
  })();

  return enVuelo;
}

// Cuánta gente está mirando en TODA la escuela. Es la entrada del gobernador: la calidad no se
// decide por aula, se decide por el total, porque el puerto es uno solo.
async function espectadoresTotales() {
  return (await estado()).espectadores || 0;
}

// Los espectadores de UNA sala. Sale del mismo estado cacheado, así que no cuesta un pedido más.
async function espectadoresDeSala(sessionId) {
  const e = await estado();
  return e.salas?.[String(sessionId)]?.espectadores || 0;
}

// Le avisa al SFU que esta transmisión se terminó, para que largue los transportes en vez de
// esperar a que se caigan solos. Es "mejor esfuerzo": si no llega, el SFU los recolecta igual
// cuando los WebSocket se cierran.
async function cerrarSala(sessionId) {
  await pedir('/cerrar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: String(sessionId) }),
  });
}

// Solo para los tests y para el panel: vacía el cache.
const olvidar = () => { cache = { at: 0, datos: SIN_MEDIOS }; };

module.exports = {
  estado, espectadoresTotales, espectadoresDeSala, cerrarSala, olvidar,
  SIN_MEDIOS, CACHE_MS,
};
