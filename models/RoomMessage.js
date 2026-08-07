const mongoose = require('mongoose');

// Reacción con emoji a un mensaje. `users` guarda quiénes reaccionaron para poder mostrar
// "vos reaccionaste" y para que la segunda pulsada del mismo usuario saque su reacción
// en vez de duplicarla.
const reactionSchema = new mongoose.Schema({
  emoji: { type: String, required: true },
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { _id: false });

// Un mensaje dentro de una sesión de sala en vivo.
const roomMessageSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'RoomSession', required: true },
  // Denormalizada: la purga (cleanup-rooms.js) y el export trabajan por materia sin tener
  // que resolver la sesión primero.
  course:  { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },

  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Snapshot del autor, mismo criterio que models/AuditLog.js: si mañana se elimina al
  // usuario, la transcripción de una clase de hace ocho meses tiene que seguir siendo
  // legible. Con solo el ref, populate devuelve null y la conversación queda anónima.
  authorName: { type: String, default: '' },
  authorRole: { type: String, default: '' },

  // 'system' = avisos automáticos de la propia sala (se abrió, se cerró, entró preceptoría).
  // Se guardan como mensajes y no como eventos aparte para que la transcripción se lea en
  // orden, con un solo cursor.
  kind: { type: String, enum: ['text', 'system'], default: 'text' },

  text: { type: String, trim: true, required: true, maxlength: 500 },

  // Posición dentro de la sesión (1..N). Es el cursor del polling: el cliente manda el
  // último `seq` que tiene y recibe solo lo posterior. Se asigna con un $inc atómico sobre
  // RoomSession.lastSeq — ver services/liveRoom.js. NO usar createdAt como cursor: dos
  // mensajes en el mismo milisegundo son indistinguibles y uno se pierde, que es justo lo
  // que pasa cuando media clase contesta a la vez.
  seq: { type: Number, required: true },

  reactions: { type: [reactionSchema], default: [] },

  // Soft delete. El texto original NO se borra: es lo que permite reconstruir qué pasó si
  // hubo un problema de convivencia, que es exactamente cuando un mensaje se borra. La vista
  // muestra "Mensaje eliminado" y conserva el `seq` — si el mensaje desapareciera de la
  // secuencia, los clientes que ya lo tienen quedarían desincronizados.
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// EL índice caliente: el poll de cada persona en la sala, cada 4 segundos.
roomMessageSchema.index({ session: 1, seq: 1 });

// Purga por antigüedad (cleanup-rooms.js): borra los mensajes de las sesiones ya cerradas.
roomMessageSchema.index({ course: 1, createdAt: 1 });

module.exports = mongoose.model('RoomMessage', roomMessageSchema);
