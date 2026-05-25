const mongoose = require('mongoose');
const { Schema } = mongoose;

// Paleta de colores permitida para identificar visualmente cada materia en el panel
const COLORS = ['#1a73e8','#34a853','#ea4335','#fbbc04','#9334e6','#0d7377','#e91e63','#ff5722','#795548','#607d8b'];

const subjectSchema = new Schema({
  name:        { type: String, required: [true, 'El nombre es requerido'], trim: true },
  description: { type: String, default: '', trim: true },
  // Color de la materia para distinguirla visualmente en el panel del administrador
  color:       { type: String, default: '#1a73e8', enum: { values: COLORS, message: 'Color no válido' } },
  // Escuela a la que pertenece; null = sin asignar (badge "Sin Matricular" en la vista)
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
}, { timestamps: true });

// Nota: la relación Materia ↔ Curso es lógica, no un campo FK.
// Course.subject almacena el NOMBRE de la materia como texto libre.
// Para contar cursos de una materia: Course.countDocuments({ subject: subject.name, school })

module.exports = mongoose.model('Subject', subjectSchema);
