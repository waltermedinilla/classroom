const mongoose = require('mongoose');
const { Schema } = mongoose;

const suggestionSchema = new Schema({
  text:   { type: String, required: true, trim: true, maxlength: 1000 },
  user:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  school: { type: Schema.Types.ObjectId, ref: 'School', default: null },
  status: { type: String, enum: ['pending', 'reviewed'], default: 'pending' },
}, { timestamps: true });

// Cubre el filtro por estado + orden por fecha del panel de superadmin (GET /superadmin/suggestions)
suggestionSchema.index({ status: 1, createdAt: -1 });
// Para un futuro filtro/reporte por escuela
suggestionSchema.index({ school: 1, createdAt: -1 });

module.exports = mongoose.model('Suggestion', suggestionSchema);
