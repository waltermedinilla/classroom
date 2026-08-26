const mongoose = require('mongoose');
const { Schema } = mongoose;

// "Este docente puede reservar este recurso sin que yo tenga que aprobarle cada vez."
//
// La otorga el ADMINISTRATIVO, y el camino normal para otorgarla no es una pantalla de
// permisos sino el botón "Aceptar y autorizar" de la bandeja de pedidos: la primera vez que
// un docente pide la sala, el administrativo decide de una sola vez si le confirma ese
// pedido y además lo habilita para los próximos.
//
// Es lo que hace que el calendario se "autocomplete": el primer pedido de cada docente pasa
// por una persona y después el docente carga solo. Aprobar reserva por reserva convertiría
// al administrativo en un cuello de botella diario.
//
// Es POR RECURSO y no un permiso global a propósito: entrar al laboratorio de química y
// pedir el proyector del pasillo no son la misma decisión.
const recursoAutorizacionSchema = new Schema({
  school:  { type: Schema.Types.ObjectId, ref: 'School',  required: true },
  recurso: { type: Schema.Types.ObjectId, ref: 'Recurso', required: true },
  docente: { type: Schema.Types.ObjectId, ref: 'User',    required: true },

  otorgadaPor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  otorgadaEl:  { type: Date, default: Date.now },
  // null = vigente. Se REVOCA en vez de borrarse para que quede el rastro de que existió: si
  // mañana alguien pregunta por qué un docente entró al laboratorio en agosto, la respuesta
  // tiene que estar.
  revocadaEl:  { type: Date, default: null },
  revocadaPor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Una sola fila por par docente × recurso: revocar y volver a otorgar reusa la misma,
// limpiando revocadaEl. Sin esto, un docente autorizado y revocado tres veces tendría tres
// filas y habría que mirar cuál manda.
recursoAutorizacionSchema.index({ recurso: 1, docente: 1 }, { unique: true });
recursoAutorizacionSchema.index({ school: 1, docente: 1 });

module.exports = mongoose.model('RecursoAutorizacion', recursoAutorizacionSchema);
