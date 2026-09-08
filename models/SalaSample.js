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
  salasAbiertas:   { type: Number, default: null },
  personasEnSalas: { type: Number, default: null },

  // ── Costo del poll ─────────────────────────────────────────────────────────
  polls:      { type: Number, default: 0 },
  msTotal:    { type: Number, default: 0 },   // suma; el promedio se saca al leer
  bytesTotal: { type: Number, default: 0 },

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

  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

// La clave de agregación. Único: cada worker escribe una sola muestra por minuto y la va
// incrementando con $inc en cada volcado.
salaSampleSchema.index({ minuto: 1, pid: 1 }, { unique: true });

// Retención de 30 días, como el resto de la telemetría. Al minuto y con 2 workers son
// ~86.400 documentos por mes: chico, pero no infinito.
salaSampleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('SalaSample', salaSampleSchema);
