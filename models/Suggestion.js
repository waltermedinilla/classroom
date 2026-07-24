const mongoose = require('mongoose');
const { Schema } = mongoose;

const suggestionSchema = new Schema({
  text:   { type: String, required: true, trim: true, maxlength: 1000 },
  user:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  school: { type: Schema.Types.ObjectId, ref: 'School', default: null },
  status: { type: String, enum: ['pending', 'reviewed', 'answered'], default: 'pending' },

  // ── Respuesta del superadmin ────────────────────────────────────────────
  response:     { type: String, trim: true, maxlength: 1000, default: '' },
  respondedAt:  { type: Date, default: null },
  respondedBy:  { type: Schema.Types.ObjectId, ref: 'User', default: null },
  // false = el usuario todavía no abrió/leyó la respuesta (dispara el badge del sobre).
  // Se resetea a false cada vez que el superadmin edita una respuesta ya existente,
  // así el usuario nota la actualización aunque ya hubiera leído la versión anterior.
  readByUser:   { type: Boolean, default: false },
}, { timestamps: true });

// Cubre el filtro por estado + orden por fecha del panel de superadmin (GET /superadmin/suggestions)
suggestionSchema.index({ status: 1, createdAt: -1 });
// Para un futuro filtro/reporte por escuela
suggestionSchema.index({ school: 1, createdAt: -1 });
// Bandeja del usuario: "¿tengo respuestas sin leer?" (badge del sobre) + listado propio
suggestionSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('Suggestion', suggestionSchema);
