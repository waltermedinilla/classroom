const mongoose = require('mongoose');

// Presencia de una persona en una sesión de sala en vivo: un documento por persona y sesión.
// ES el registro de asistencia — no hay otra colección para eso.
//
// La ausencia de documento significa "nunca entró". Un documento con lastPingAt viejo
// significa "estuvo y ya no está", que NO es lo mismo y es la distinción que hace útil a
// esta colección meses después.
//
// Mismo patrón que models/ActivityView.js: par único + upsert desde la ruta.
const roomPresenceSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'RoomSession', required: true },
  course:  { type: mongoose.Schema.Types.ObjectId, ref: 'Course',      required: true },
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',        required: true },

  // Snapshot, igual que en RoomMessage: la asistencia de una clase de hace un año tiene que
  // seguir siendo legible aunque el usuario ya no exista.
  userName: { type: String, default: '' },
  // Distingue al alumno del docente y del preceptor. Los conteos de "N presentes" cuentan
  // SOLO alumnos: si el docente sumara, "18 de 25" pasaría a decir 19 sin que haya un chico
  // más en la clase.
  userRole: { type: String, default: '' },

  // Primer ingreso a ESTA sesión. Se setea una sola vez con $setOnInsert para que una
  // reconexión no lo pise (mismo criterio que ActivityView.firstViewedAt).
  firstSeenAt: { type: Date, default: Date.now },
  // Último ping recibido. "Conectado ahora" = este valor dentro de la ventana de 45 s.
  lastPingAt:  { type: Date, default: Date.now },

  // Cantidad de escrituras de presencia. ⚠️ NO es "cuántas veces polleó": desde RN-3
  // (2026-09-08) solo se escribe si pasaron 15 s del ping anterior. Quedó como respaldo del
  // cálculo viejo para los documentos anteriores a `msPresente`; para todo lo nuevo, el dato
  // de permanencia es el de abajo.
  pings: { type: Number, default: 1 },

  // Tiempo de permanencia acumulado, en milisegundos. Es el dato del que salen los "minutos
  // estimados" del CSV de asistencia y de la pantalla de historial de clase.
  //
  // ⭐ SE ACUMULA POR TRAMOS Y NO SE CALCULA COMO `lastPingAt − firstSeenAt`: un alumno que
  // entra al principio, se va, y vuelve al final daría "toda la clase" con la resta, cuando
  // estuvo dos minutos. Cada escritura acredita el tiempo real transcurrido desde la anterior,
  // topeado con la ventana de "conectado" — un hueco más grande que eso es una ausencia, y no
  // se acredita (ver touchPresence en services/liveRoom.js).
  //
  // ⚠️ REEMPLAZA A `pings × POLL_MS`, que se rompió el 2026-09-08 con la cadencia adaptativa de
  // RN-4: esa cuenta suponía que un ping vale siempre 4 segundos, y desde entonces puede valer
  // 4 u 8. Una clase silenciosa de 40 minutos reportaba 20, en un documento que la escuela usa.
  //
  // Los documentos anteriores a este campo no lo tienen y siguen con la cuenta vieja: no hace
  // falta migrarlos, y migrarlos sería inventar un dato que no se midió.
  msPresente: { type: Number, default: 0 },

  // ── Transmisión en vivo ────────────────────────────────────────────────────
  //
  // Estos tres campos son de DIAGNÓSTICO, no de asistencia. La distinción es deliberada y es
  // la decisión D8 de specs/transmision-en-vivo.spec.md: este documento SIGUE SIENDO el único
  // registro de asistencia. Si "miró la transmisión" fuera un registro aparte, la escuela
  // tendría dos números distintos de presentes en la misma clase, y el día que difieran nadie
  // va a saber cuál mirar.
  //
  // Lo que contestan es otra pregunta, la que aparece cuando la familia reclama: "a este chico
  // se le cortó nueve veces".
  txSegundos: { type: Number, default: 0 },   // cuánto tiempo estuvo recibiendo
  txCapaMax:  { type: String, default: '' },  // la mejor calidad que llegó a recibir
  txCortes:   { type: Number, default: 0 },   // cuántas veces se le cayó la conexión
}, { timestamps: true });

// Un solo documento por persona y sesión. Es la clave del upsert de touchPresence().
roomPresenceSchema.index({ session: 1, user: 1 }, { unique: true });

// Listado de conectados de una sala, ordenado por actividad reciente.
roomPresenceSchema.index({ session: 1, lastPingAt: -1 });

module.exports = mongoose.model('RoomPresence', roomPresenceSchema);
