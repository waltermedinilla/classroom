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

  // Cantidad de pings recibidos. El tiempo de permanencia se estima como pings × POLL_MS y
  // NO como lastPingAt − firstSeenAt: un alumno que entra al principio, se va, y vuelve al
  // final daría "toda la clase" con la resta, cuando estuvo dos minutos.
  pings: { type: Number, default: 1 },
}, { timestamps: true });

// Un solo documento por persona y sesión. Es la clave del upsert de touchPresence().
roomPresenceSchema.index({ session: 1, user: 1 }, { unique: true });

// Listado de conectados de una sala, ordenado por actividad reciente.
roomPresenceSchema.index({ session: 1, lastPingAt: -1 });

module.exports = mongoose.model('RoomPresence', roomPresenceSchema);
