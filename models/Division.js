const mongoose = require('mongoose');
const { Schema } = mongoose;

const divisionSchema = new Schema({
  name:   { type: String, required: [true, 'El nombre del curso es requerido'], trim: true },
  school: { type: Schema.Types.ObjectId, ref: 'School', required: [true, 'La escuela es requerida'] },
}, { timestamps: true });

// No puede haber dos divisiones con el mismo nombre en la misma escuela
divisionSchema.index({ name: 1, school: 1 }, { unique: true });

module.exports = mongoose.model('Division', divisionSchema);
