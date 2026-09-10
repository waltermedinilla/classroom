const mongoose = require('mongoose');

// Una muestra por MINUTO y por WORKER del comportamiento de la sala en vivo.
// Ver specs/monitor-sala-escala.spec.md.
//
// ── Por qué lleva `pid`, igual que RateLimitSample ───────────────────────────
// ecosystem.config.js levanta 2 workers en cluster y cada uno acumula sus propios contadores
// en memoria. Sin el pid en la clave, los dos se pisarían el documento del minuto y el número
// quedaría a merced de cuál escribió último. Con el pid, cada uno escribe el suyo y el
// endpoint los SUMA al leer (ver services/salaStats.js).
//
// ⚠️ EXCEPCIÓN: los dos campos de CONTEXTO (`salasAbiertas`, `personasEnSalas`) los escribe un
// solo worker, porque son un estado global de la escuela y no un contador de tráfico. Sumarlos
// entre workers daría el doble de salas de las que hay. Ver el muestreo en server.js.
const salaSampleSchema = new mongoose.Schema({
  minuto: { type: Date,   required: true },
  pid:    { type: Number, required: true },

  // ── Contexto: cuántas salas y cuánta gente había (lo escribe UN worker) ────

  // Salas CON GENTE ADENTRO: sesiones distintas entre las presencias frescas.
  //
  // ⚠️ NO es `RoomSession.countDocuments({ closedAt: null })`, y la diferencia importa. Eso
  // cuenta "sesiones que nadie cerró", que no es lo mismo: el autocierre (`closeStaleSessions`)
  // solo corre adentro de `getOpenSessions()`, o sea cuando alguien abre el panel de dirección
  // o de preceptoría. Una sala que terminó y a la que nadie volvió queda contada para siempre.
  //
  // Medido en producción el 2026-09-08: el panel decía 6 salas con 22 personas —3,7 por sala,
  // poquísimo para una clase— y al rato pasó a 3 salas con 36 personas. Las salas bajaron
  // mientras la gente subía: había sesiones muertas infladas en el número.
  //
  // ⭐ Este campo es el EJE X del gráfico de "¿escala?". Con el eje inflado, esa curva compara
  // peras con manzanas y no sirve para decidir un rediseño, que es justo para lo que existe.
  salasAbiertas:   { type: Number, default: null },

  // El crudo: sesiones con `closedAt: null`, barra las que sean.
  //
  // Se guarda A PROPÓSITO además del de arriba, porque LA DIFERENCIA ENTRE LOS DOS ES EL DATO:
  // "3 salas con gente, 6 sin cerrar" avisa que hay 3 salas colgadas y que el autocierre no
  // está barriendo. Es la misma familia de las salas fantasma, por otra puerta.
  sesionesSinCerrar: { type: Number, default: null },

  personasEnSalas: { type: Number, default: null },

  // ── Retraso del event loop (lo escribe UN worker, igual que el resto del contexto) ──
  //
  // Es el juez que separa las dos hipótesis: mide cuánto tarda el proceso en atender un timer
  // que debía dispararse YA. Si está en el piso, el proceso no está saturado y el tiempo del
  // poll es Mongo. Si sube, el poll espera su turno y el problema es CPU.
  //
  // ⚠️ Es POR WORKER. El que muestrea es uno solo, así que dice cómo está ESE proceso, no la
  // máquina. Alcanza igual: los dos workers hacen el mismo trabajo y PM2 reparte parejo.
  loopMs:    { type: Number, default: null },   // media del minuto
  loopP99Ms: { type: Number, default: null },   // el peor 1%

  // ── Costo del poll ─────────────────────────────────────────────────────────
  polls:      { type: Number, default: 0 },
  msTotal:    { type: Number, default: 0 },   // suma; el promedio se saca al leer
  bytesTotal: { type: Number, default: 0 },

  // ── El desglose del poll (2026-09-10) ──────────────────────────────────────
  //
  // El panel decía "78 ms por poll" y no había forma de saber a dónde se iban. Sin esto había
  // que ADIVINAR entre "es Mongo" y "es el event loop", y llevan a arreglos OPUESTOS: uno se
  // ataca con índices o menos queries, el otro con CPU o con menos trabajo por request.
  //
  // ⭐ LA SUMA DE LOS CUATRO NO DA EL TOTAL, Y ESA DIFERENCIA ES EL DATO. Lo que falta es el
  // tiempo que el handler pasó ESPERANDO para volver de un await con el proceso ocupado. Resto
  // alto con Mongo bajo = contención, no base lenta.
  msSesionTotal:    { type: Number, default: 0 },   // sesionAbierta + aplicarModo
  msPresenciaTotal: { type: Number, default: 0 },   // touchPresence
  msEstadoTotal:    { type: Number, default: 0 },   // estadoDeSala (mensajes + presencia)
  msCuerpoTotal:    { type: Number, default: 0 },   // JSON.stringify de la respuesta

  // ── Las cuatro palancas: cuántas veces evitó trabajo cada una ──────────────
  //
  // No se guarda "lo que ahorró" en queries o bytes: se guarda EL CONTEO, que es exacto. La
  // multiplicación por el costo unitario medido es una estimación y se hace al mostrar, con
  // la fecha de la medición al lado. Guardar el producto sería congelar una estimación como
  // si fuera un dato.
  cacheAciertos:      { type: Number, default: 0 },   // RN-1
  cacheFallos:        { type: Number, default: 0 },
  presenciaOmitida:   { type: Number, default: 0 },   // RN-2: no viajaron las listas
  presenciaEnviada:   { type: Number, default: 0 },
  presenciaNoEscrita: { type: Number, default: 0 },   // RN-3: no se escribió el ping
  presenciaEscrita:   { type: Number, default: 0 },

  // ── Síntomas: no si la sala es barata, sino si ANDA ────────────────────────
  //
  // La mañana del 2026-09-08 la sala estaba baratísima —no pintaba nada, así que no gastaba
  // nada— y estaba rota. Un panel que solo mire el costo habría dado todo verde.

  // Cuánto esperó cada mensaje entregado desde que se escribió. Histograma en vez de una
  // lista: el p95 hay que poder sacarlo sin guardar una muestra por mensaje.
  mensajesEntregados: { type: Number, default: 0 },
  entregaMsTotal:     { type: Number, default: 0 },
  entregaMsMax:       { type: Number, default: 0 },

  // ⚠️ Mensajes de REENGANCHE: los que le llegan a alguien que estuvo desconectado y se baja
  // el atrasado de golpe. NO cuentan como demora de entrega, y separarlos es una corrección
  // del 2026-09-08 que salió de los primeros datos reales.
  //
  // Sin esta separación, una sola reconexión con 101 mensajes viejos ponía el promedio de
  // entrega en 24 MINUTOS y el p95 en "> 20 s", cuando la sala estaba entregando en segundos.
  // La edad de un mensaje atrasado no mide la sala: mide cuánto estuvo afuera esa persona.
  mensajesDeReenganche: { type: Number, default: 0 },
  ent2s:   { type: Number, default: 0 },   // ≤ 2 s
  ent4s:   { type: Number, default: 0 },   // ≤ 4 s
  ent8s:   { type: Number, default: 0 },   // ≤ 8 s  ← lo normal con RN-4 aflojando
  ent20s:  { type: Number, default: 0 },   // ≤ 20 s
  entMas:  { type: Number, default: 0 },   // > 20 s ← acá empieza el problema

  // ⭐ EL NÚMERO QUE HAY QUE MIRAR ANTE UN "NO ME LLEGAN LOS MENSAJES".
  //
  // `atraso` es `lastSeq − since`: cuántos mensajes de diferencia hay entre lo que el
  // navegador dice tener y lo que la sala tiene. En una sala sana es 0 casi siempre, y salta a
  // 1 o 2 por un instante entre que alguien escribe y el poll siguiente lo trae.
  //
  // Un atraso que CRECE Y NO BAJA significa que los navegadores no están avanzando el cursor:
  // reciben y no pintan, o descartan. Es exactamente el congelamiento del 08/09, y es la señal
  // que lo habría cazado el mismo día.
  pollsAtrasados: { type: Number, default: 0 },
  atrasoMax:      { type: Number, default: 0 },

  // ⭐ EL QUE DE VERDAD DISTINGUE UN CURSOR TRABADO DE UNA RECONEXIÓN, y es la otra corrección
  // del 2026-09-08 que trajeron los datos reales.
  //
  // `atrasoMax` es el peor caso del minuto, y ahí las dos cosas se ven IGUAL: una reconexión
  // con 101 mensajes atrasados y un navegador congelado dan el mismo número. Lo que las separa
  // es CUÁNTOS polls llegan muy atrasados:
  //
  //   · una reconexión aporta UNO y se acabó (el poll siguiente ya está al día);
  //   · un navegador congelado sigue polleando cada 4-8 s con el mismo `since` viejo, así que
  //     aporta decenas por minuto, minuto tras minuto.
  //
  // Medido en producción el 08/09: el pico de 101 fue UN poll en UN minuto y bajó solo a 6, 4
  // y 1 en los siguientes. Era una reconexión, y con `atrasoMax` solo no se podía saber.
  pollsMuyAtrasados: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

// La clave de agregación. Único: cada worker escribe una sola muestra por minuto y la va
// incrementando con $inc en cada volcado.
salaSampleSchema.index({ minuto: 1, pid: 1 }, { unique: true });

// Retención de 30 días, como el resto de la telemetría. Al minuto y con 2 workers son
// ~86.400 documentos por mes: chico, pero no infinito.
salaSampleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('SalaSample', salaSampleSchema);
