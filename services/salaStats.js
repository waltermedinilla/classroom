// Telemetría de la sala en vivo: qué cuesta un poll, qué palanca lo está sosteniendo, y —sobre
// todo— si los mensajes están llegando. Alimenta la sección "Sala en vivo" de
// /superadmin/monitor. Ver specs/monitor-sala-escala.spec.md.
//
// ⚠️ REGLA DE ORO, HEREDADA DE services/rateLimitStats.js: esto es telemetría. Si algo falla
// acá (Mongo caído, un campo inesperado), se descarta la muestra y la aplicación sigue. Nada de
// lo que pasa en este módulo puede tumbar un request.
//
// ⚠️⚠️ Y UNA SEGUNDA, PROPIA DE ESTE MÓDULO: se instrumenta LA RUTA MÁS CALIENTE DE LA APP. El
// riesgo obvio de medir el poll es que la medición se vuelva la carga. Por eso `registrarPoll`
// solo incrementa enteros en un Map: sin I/O, sin await, sin JSON, sin objetos nuevos por
// request. Lo que toca la base es el volcado, UNA VEZ POR MINUTO Y POR WORKER.
//
// A 868 personas en 28 salas —el pico medido— la sala hace ~52.000 operaciones de Mongo por
// minuto y esto agrega 6. Es el 0,01%.
const SalaSample = require('../models/SalaSample');

// Los rangos y el truncado son los mismos de rate limit: se importan en vez de copiarse, para
// que los dos gráficos del monitor no puedan divergir en los buckets.
const { truncarAlMinuto, rangoValido, configDeRango, RANGOS } = require('./rateLimitStats');

// La ventana de "conectado ahora". Se importa en vez de copiarse: es la misma constante que
// define, en toda la app, si alguien estaba o no en la sala.
const { ONLINE_WINDOW_MS } = require('./liveRoom');

// ── Los dos umbrales que separan un problema de una reconexión ───────────────
//
// Nacieron de los primeros datos reales (2026-09-08): sin ellos, una sola persona que se
// reconecta y se baja 101 mensajes atrasados hacía que el panel dijera "los mensajes tardan 24
// minutos" y "hay navegadores 101 mensajes atrás". La sala estaba perfecta.

// Un mensaje más viejo que esto, al entregarse, NO mide la sala: mide cuánto estuvo afuera esa
// persona. Es la definición que ya usa toda la app para "estaba conectado".
const ENTREGA_MAX_MS = ONLINE_WINDOW_MS;

// A partir de cuántos mensajes de diferencia un poll cuenta como "muy atrasado". Lo que importa
// no es este número sino CUÁNTOS polls lo cruzan: una reconexión aporta uno, un cursor
// congelado aporta decenas por minuto.
const ATRASO_GRAVE = 10;

const VOLCADO_MS = 60 * 1000;

// ── Costos unitarios medidos, para estimar lo que ahorró cada palanca ────────
//
// ⚠️ SON CONSTANTES MEDIDAS UN DÍA, NO ALGO QUE LA APP REMIDA EN VIVO. Se guardan los CONTEOS,
// que son exactos; la multiplicación es una estimación y se hace acá, al mostrar, con la fecha
// al lado. Guardar el producto en la base sería congelar una estimación como si fuera un dato.
//
// Medidos el 2026-09-08 sobre un curso real de 36 alumnos (ver la spec de escala).
const COSTOS = {
  medidoEl:            '2026-09-08',
  cargarSalaMs:        11.4,    // lo que cuesta resolver el curso sin cache
  cargarSalaQueries:   4,
  presenciaBytes:      3506,    // lo que pesan las dos listas de presencia
  presenciaEscrituras: 2,       // la presencia + el lastActivityAt de la sesión
};

/* ─── Parte pura (testeable sin Mongo ni HTTP) ─────────────────────────────── */

// Los cortes del histograma de entrega, en ms. El de 8 s no es arbitrario: es el ritmo lento
// de RN-4, o sea el techo de lo NORMAL. Que el p95 caiga ahí no es un problema; que lo pase, sí.
const CORTES_ENTREGA = [
  ['ent2s',   2000],
  ['ent4s',   4000],
  ['ent8s',   8000],
  ['ent20s', 20000],
  ['entMas', Infinity],
];

// A qué casillero del histograma va una demora.
function casilleroDeEntrega(ms) {
  for (const [campo, tope] of CORTES_ENTREGA) if (ms <= tope) return campo;
  return 'entMas';
}

// El percentil, leído del histograma. Devuelve la ETIQUETA del casillero donde cae, no un
// número: con cinco casilleros, inventar un valor exacto sería fingir una precisión que no hay.
function percentilEntrega(m, p = 0.95) {
  const total = CORTES_ENTREGA.reduce((s, [c]) => s + (m[c] || 0), 0);
  if (!total) return null;
  let acumulado = 0;
  for (const [campo, tope] of CORTES_ENTREGA) {
    acumulado += m[campo] || 0;
    if (acumulado / total >= p) {
      return tope === Infinity ? { etiqueta: '> 20 s', ms: null } : { etiqueta: `≤ ${tope / 1000} s`, ms: tope };
    }
  }
  return { etiqueta: '> 20 s', ms: null };
}

// Suma dos muestras campo a campo. Es donde se resuelve el cluster: las muestras de los DOS
// workers para el mismo minuto se SUMAN.
//
// ⚠️ Los campos de CONTEXTO no se suman: se toma el máximo. `salasAbiertas` es un estado global
// de la escuela, no un contador de tráfico — sumarlo entre workers daría el doble de salas de
// las que hay. Lo escribe un solo worker, así que el otro trae null y el máximo lo ignora.
const SUMABLES = [
  'polls', 'msTotal', 'bytesTotal',
  'cacheAciertos', 'cacheFallos',
  'presenciaOmitida', 'presenciaEnviada',
  'presenciaNoEscrita', 'presenciaEscrita',
  'mensajesEntregados', 'entregaMsTotal', 'mensajesDeReenganche',
  'ent2s', 'ent4s', 'ent8s', 'ent20s', 'entMas',
  'pollsAtrasados', 'pollsMuyAtrasados',
];
const MAXIMOS  = ['entregaMsMax', 'atrasoMax'];
const CONTEXTO = ['salasAbiertas', 'sesionesSinCerrar', 'personasEnSalas'];

function puntoVacio(t) {
  const p = { t };
  for (const c of SUMABLES) p[c] = 0;
  for (const c of MAXIMOS)  p[c] = 0;
  for (const c of CONTEXTO) p[c] = null;
  return p;
}

function acumularEn(punto, m) {
  for (const c of SUMABLES) punto[c] += m[c] || 0;
  for (const c of MAXIMOS)  if ((m[c] || 0) > punto[c]) punto[c] = m[c] || 0;
  for (const c of CONTEXTO) {
    if (m[c] == null) continue;
    if (punto[c] == null || m[c] > punto[c]) punto[c] = m[c];
  }
  return punto;
}

// Agrupa las muestras crudas (una por minuto y por worker) en los puntos que se dibujan.
function agregarSerie(muestras, bucketMin) {
  const bucketMs = bucketMin * 60 * 1000;
  const porBucket = new Map();

  (muestras || []).forEach(m => {
    const clave = Math.floor(new Date(m.minuto).getTime() / bucketMs) * bucketMs;
    const punto = porBucket.get(clave) || puntoVacio(new Date(clave));
    porBucket.set(clave, acumularEn(punto, m));
  });

  return [...porBucket.values()]
    .sort((a, b) => a.t - b.t)
    .map(p => ({
      ...p,
      // Derivados, calculados al leer y no guardados: son promedios, y un promedio de
      // promedios no es el promedio.
      msPorPoll:    p.polls ? +(p.msTotal / p.polls).toFixed(2) : 0,
      bytesPorPoll: p.polls ? Math.round(p.bytesTotal / p.polls) : 0,
      entregaMsProm: p.mensajesEntregados
        ? Math.round(p.entregaMsTotal / p.mensajesEntregados) : null,
    }));
}

// El porcentaje de efectividad de una palanca: de las veces que pudo actuar, cuántas actuó.
// Devuelve null cuando no hubo ocasiones, que es distinto de 0% — sin salas abiertas la
// palanca no falló, simplemente no tuvo nada que hacer.
function efectividad(actuo, noActuo) {
  const total = (actuo || 0) + (noActuo || 0);
  return total ? Math.round(actuo * 100 / total) : null;
}

// Números de cabecera: lo que se lee de un vistazo sin mirar el gráfico.
function resumir(muestras) {
  const lista = muestras || [];
  const t = puntoVacio(null);
  lista.forEach(m => acumularEn(t, m));

  const palancas = {
    // RN-1: cada acierto se ahorró resolver el curso entero.
    cache: {
      pct: efectividad(t.cacheAciertos, t.cacheFallos),
      queriesAhorradas: t.cacheAciertos * COSTOS.cargarSalaQueries,
      msAhorrados:      Math.round(t.cacheAciertos * COSTOS.cargarSalaMs),
    },
    // RN-2: cada omisión se ahorró mandar las dos listas.
    presencia: {
      pct: efectividad(t.presenciaOmitida, t.presenciaEnviada),
      bytesAhorrados: t.presenciaOmitida * COSTOS.presenciaBytes,
    },
    // RN-3: cada ping no escrito se ahorró las dos escrituras.
    escrituras: {
      pct: efectividad(t.presenciaNoEscrita, t.presenciaEscrita),
      escriturasAhorradas: t.presenciaNoEscrita * COSTOS.presenciaEscrituras,
    },
  };

  return {
    polls: t.polls,
    msPorPoll:    t.polls ? +(t.msTotal / t.polls).toFixed(2) : 0,
    bytesPorPoll: t.polls ? Math.round(t.bytesTotal / t.polls) : 0,
    salasAbiertas:     t.salasAbiertas,
    personasEnSalas:   t.personasEnSalas,
    // El crudo, y la diferencia contra el de arriba: salas que quedaron sin cerrar y a las
    // que no vuelve nadie. Ver el comentario de models/SalaSample.js.
    sesionesSinCerrar: t.sesionesSinCerrar,
    salasColgadas: (t.sesionesSinCerrar != null && t.salasAbiertas != null)
      ? Math.max(0, t.sesionesSinCerrar - t.salasAbiertas)
      : null,
    palancas,
    // ── Los síntomas ──
    entrega: {
      mensajes: t.mensajesEntregados,
      // Los que llegaron a alguien que había estado desconectado. Es un dato aparte y útil:
      // muchos reenganches significan gente entrando y saliendo, no una sala lenta.
      reenganches: t.mensajesDeReenganche,
      promMs:   t.mensajesEntregados ? Math.round(t.entregaMsTotal / t.mensajesEntregados) : null,
      maxMs:    t.entregaMsMax || null,
      p95:      percentilEntrega(t),
    },
    atraso: {
      max: t.atrasoMax || 0,
      pctPollsAtrasados: t.polls ? Math.round(t.pollsAtrasados * 100 / t.polls) : 0,
      // ⭐ Los dos que separan el cursor trabado de la reconexión.
      muyAtrasados: t.pollsMuyAtrasados || 0,
      pctMuyAtrasados: t.polls ? +(t.pollsMuyAtrasados * 100 / t.polls).toFixed(2) : 0,
      umbral: ATRASO_GRAVE,
    },
    costos: COSTOS,
  };
}

// El eje 2 de la spec: el costo por poll CONTRA la cantidad de salas abiertas, en vez de contra
// el tiempo. Es el gráfico que contesta "¿esto escala?" — plano escala, curvado hacia arriba no.
//
// ⚠️ Filtra los puntos con menos de `minSalas` salas: con la escuela vacía el costo por poll no
// significa nada y ensucia la curva (decisión 3 de la spec).
function porCantidadDeSalas(muestras, minSalas = 3) {
  const porSalas = new Map();

  (muestras || []).forEach(m => {
    if (m.salasAbiertas == null || m.salasAbiertas < minSalas) return;
    if (!m.polls) return;
    const p = porSalas.get(m.salasAbiertas) || { salas: m.salasAbiertas, polls: 0, msTotal: 0, bytesTotal: 0, minutos: 0 };
    p.polls      += m.polls      || 0;
    p.msTotal    += m.msTotal    || 0;
    p.bytesTotal += m.bytesTotal || 0;
    p.minutos    += 1;
    porSalas.set(m.salasAbiertas, p);
  });

  return [...porSalas.values()]
    .map(p => ({
      salas: p.salas,
      minutos: p.minutos,
      pollsPorMin:  Math.round(p.polls / p.minutos),
      msPorPoll:    +(p.msTotal / p.polls).toFixed(2),
      bytesPorPoll: Math.round(p.bytesTotal / p.polls),
    }))
    .sort((a, b) => a.salas - b.salas);
}

/* ─── Parte con estado (contadores del worker) ─────────────────────────────── */

const buffer = new Map();
let timer = null;

function baldeDe(fecha) {
  const clave = truncarAlMinuto(fecha).toISOString();
  if (!buffer.has(clave)) {
    const b = {};
    for (const c of SUMABLES) b[c] = 0;
    for (const c of MAXIMOS)  b[c] = 0;
    for (const c of CONTEXTO) b[c] = null;
    buffer.set(clave, b);
  }
  return buffer.get(clave);
}

/**
 * Un poll atendido. ⚠️ ESTO CORRE EN LA RUTA MÁS CALIENTE DE LA APP: solo incrementos sobre
 * enteros. Cualquier cosa que se agregue acá se multiplica por ~8.700 por minuto.
 *
 * @param datos.ms                cuánto tardó el handler
 * @param datos.bytes            peso de la respuesta
 * @param datos.cacheAcierto     RN-1: ¿el curso salió del cache?
 * @param datos.presenciaEnviada RN-2: ¿viajaron las listas?
 * @param datos.presenciaEscrita RN-3: ¿se escribió el ping?
 * @param datos.atraso           lastSeq − since: cuántos mensajes atrás está el navegador
 * @param datos.entregasMs       demora de cada mensaje entregado en esta respuesta
 */
function registrarPoll(datos) {
  try {
    const b = baldeDe(new Date());
    b.polls++;
    b.msTotal    += datos.ms    || 0;
    b.bytesTotal += datos.bytes || 0;

    if (datos.cacheAcierto) b.cacheAciertos++;      else b.cacheFallos++;
    if (datos.presenciaEnviada) b.presenciaEnviada++; else b.presenciaOmitida++;
    if (datos.presenciaEscrita) b.presenciaEscrita++; else b.presenciaNoEscrita++;

    const atraso = datos.atraso || 0;
    if (atraso > 0) {
      b.pollsAtrasados++;
      if (atraso > b.atrasoMax) b.atrasoMax = atraso;
      // ⭐ El contador que distingue el cursor trabado de la reconexión. Ver el comentario de
      // ATRASO_GRAVE y el de models/SalaSample.js.
      if (atraso >= ATRASO_GRAVE) b.pollsMuyAtrasados++;
    }

    const entregas = datos.entregasMs;
    if (entregas && entregas.length) {
      for (let i = 0; i < entregas.length; i++) {
        const ms = entregas[i];
        // ⚠️ Un mensaje viejo NO es una entrega lenta: es alguien que estuvo desconectado y se
        // baja el atrasado. Contarlo arruinaba el promedio y el p95 — medido el 08/09, un solo
        // reenganche puso el promedio en 24 minutos.
        if (ms > ENTREGA_MAX_MS) { b.mensajesDeReenganche++; continue; }
        b.mensajesEntregados++;
        b.entregaMsTotal += ms;
        if (ms > b.entregaMsMax) b.entregaMsMax = ms;
        b[casilleroDeEntrega(ms)]++;
      }
    }
  } catch { /* telemetría: nunca romper un poll */ }
}

// El contexto: cuántas salas y cuánta gente hay. Lo llama UN SOLO worker desde server.js —
// es un estado global de la escuela, no un contador de tráfico.
function registrarContexto({ salasAbiertas, sesionesSinCerrar, personasEnSalas }) {
  try {
    const b = baldeDe(new Date());
    if (salasAbiertas     != null) b.salasAbiertas     = salasAbiertas;
    if (sesionesSinCerrar != null) b.sesionesSinCerrar = sesionesSinCerrar;
    if (personasEnSalas   != null) b.personasEnSalas   = personasEnSalas;
  } catch { /* idem */ }
}

async function volcar() {
  if (buffer.size === 0) return 0;

  // Se vacía ANTES de escribir: si Mongo falla, se pierde un minuto de telemetría y no se
  // acumula un buffer que crece sin techo mientras la base está caída.
  const pendientes = [...buffer.entries()];
  buffer.clear();

  let escritas = 0;
  for (const [minutoISO, b] of pendientes) {
    try {
      const inc = {};
      for (const c of SUMABLES) if (b[c]) inc[c] = b[c];

      const max = {};
      for (const c of MAXIMOS) if (b[c]) max[c] = b[c];
      // $max y no $set: si este minuto ya se volcó antes, el máximo que vale es el mayor de
      // los dos, no el del último flush.
      for (const c of CONTEXTO) if (b[c] != null) max[c] = b[c];

      await SalaSample.updateOne(
        { minuto: new Date(minutoISO), pid: process.pid },
        {
          ...(Object.keys(inc).length ? { $inc: inc } : {}),
          ...(Object.keys(max).length ? { $max: max } : {}),
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      escritas++;
    } catch { /* Mongo caído: se descarta la muestra y se sigue */ }
  }
  return escritas;
}

function iniciarVolcado(ms = VOLCADO_MS) {
  if (timer) return timer;
  timer = setInterval(() => { volcar(); }, ms);
  // unref: un intervalo de telemetría no puede ser el motivo de que el proceso no cierre.
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function detenerVolcado() {
  if (timer) clearInterval(timer);
  timer = null;
}

function _buffer() { return buffer; }
function _reset()  { buffer.clear(); detenerVolcado(); }

module.exports = {
  // puras
  casilleroDeEntrega, percentilEntrega, agregarSerie, resumir, porCantidadDeSalas, efectividad,
  rangoValido, configDeRango, RANGOS, COSTOS, CORTES_ENTREGA, ENTREGA_MAX_MS, ATRASO_GRAVE,
  // con estado
  registrarPoll, registrarContexto, volcar, iniciarVolcado, detenerVolcado,
  VOLCADO_MS, _buffer, _reset,
};
