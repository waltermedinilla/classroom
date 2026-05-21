const mongoose = require('mongoose');
const { Schema } = mongoose;

const COLORS = ['#1a73e8','#34a853','#ea4335','#fbbc04','#9334e6','#0d7377','#e91e63','#ff5722','#795548','#607d8b'];

const subjectSchema = new Schema({
  name: { type: String, required: [true, 'El nombre es requerido'], trim: true, unique: true },
  description: { type: String, default: '', trim: true },
  color: { type: String, default: '#1a73e8', enum: { values: COLORS, message: 'Color no válido' } },
}, { timestamps: true });

module.exports = mongoose.model('Subject', subjectSchema);
