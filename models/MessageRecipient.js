const mongoose = require('mongoose');
const { Schema } = mongoose;

// Un mensaje del hilo posterior al envío original.
//
// A diferencia de models/Suggestion.js, acá el hilo arranca limpio: el mensaje inicial vive en
// Message.body (uno solo, compartido por todos los destinatarios) y TODO lo que viene después
// vive en `thread`, sin campos especiales para el primero.
//
// Aquel modelo guarda sus dos primeros mensajes en `text` y `response`, fuera de `messages[]`,
// porque cuando el hilo se agregó ya había sugerencias en producción y migrarlas habría
// significado tocar datos reales. Es deuda heredada, no un diseño: un modelo nuevo no tiene
// por qué copiarla.
const threadMessageSchema = new Schema({
  // 'staff' = el superadmin (el que envió). 'user' = el destinatario.
  from:     { type: String, enum: ['user', 'staff'], required: true },
  author:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text:     { type: String, required: true, trim: true, maxlength: 2000 },
  at:       { type: Date, default: Date.now },
  editedAt: { type: Date, default: null },
});

// EL ESTADO Y LA CONVERSACIÓN DE UNA PERSONA sobre un envío. Un documento por
// (mensaje × destinatario): es la fila que hace de bandeja, de acuse de lectura y de hilo
// privado 1 a 1.
const messageRecipientSchema = new Schema({
  message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
  user:    { type: Schema.Types.ObjectId, ref: 'User',    required: true },

  // Congelados al enviar. Se guardan A PROPÓSITO aunque se puedan sacar del User: el panel de
  // seguimiento tiene que poder decir "se lo mandaste a Juan como Docente" aunque hoy Juan sea
  // Preceptor. Es el rol que TENÍA cuando se le mandó — sin esto, un cambio de rol reescribe
  // la historia del envío.
  roleAtSend:   { type: String, default: null },
  schoolAtSend: { type: Schema.Types.ObjectId, ref: 'School', default: null },

  // null = no leído. Es la mitad de lo que cuenta el badge del sobre.
  readAt: { type: Date, default: null },

  // La conversación 1 a 1. Vacío en los mensajes que nadie contestó, que van a ser la mayoría.
  thread: { type: [threadMessageSchema], default: [] },

  // ¿Hay algo en el hilo que el DESTINATARIO todavía no vio? Va aparte de readAt porque readAt
  // es del mensaje original: sin este campo, una respuesta del superadmin sobre un mensaje ya
  // leído no encendería el badge nunca.
  unreadForUser: { type: Boolean, default: false },

  // Espejo del anterior, del lado del panel: ¿el destinatario escribió algo que el superadmin
  // todavía no vio? Evita recorrer todos los hilos para pintar "3 respuestas nuevas".
  unreadForStaff: { type: Boolean, default: false },
}, { timestamps: true });

// ÍNDICES CRÍTICOS: los dos primeros los usa el contador del badge, que corre en CADA request.
messageRecipientSchema.index({ user: 1, readAt: 1 });
messageRecipientSchema.index({ user: 1, unreadForUser: 1 });
// Bandeja del usuario, ordenada por actividad reciente.
messageRecipientSchema.index({ user: 1, updatedAt: -1 });
// Panel de seguimiento: los destinatarios de UN envío, su filtro por leídos y su borrado.
messageRecipientSchema.index({ message: 1, readAt: 1 });
// Una persona no puede tener dos filas del mismo envío. Es lo que hace idempotente al alta
// masiva: si el insertMany se corta por la mitad y se reintenta, no duplica.
messageRecipientSchema.index({ message: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('MessageRecipient', messageRecipientSchema);
