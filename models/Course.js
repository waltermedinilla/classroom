const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const courseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Course name is required'],
    trim: true,
  },
  section: {
    type: String,
    trim: true,
    default: '', // p.ej. "1A", "2B"
  },
  subject: {
    type: String,
    trim: true,
    default: '', // Nombre de la materia (texto libre, referencia lógica a Subject.name)
  },
  room: {
    type: String,
    trim: true,
    default: '', // Aula o salón
  },
  // Código único de 6 caracteres que los alumnos usan para unirse al curso
  code: {
    type: String,
    unique: true,
    default: () => uuidv4().slice(0, 6).toUpperCase(), // Generado automáticamente al crear
  },
  // Docente dueño del curso — solo él puede crear actividades, calificar y personalizar
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Lista de alumnos inscriptos; se agregan con código o por el docente desde el panel
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // Escuela a la que pertenece el curso; null si no está asignado (no debería ocurrir en prod)
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    default: null,
  },
  // Personalización visual del encabezado del curso (configurada por el docente)
  header: {
    color:  { type: String, default: null },  // Color primario (hex)
    color2: { type: String, default: null },  // Color secundario para degradado
    image:  { type: String, default: null },  // Ruta pública: /archivos/{school}/headers/{id}/header.ext
  },
}, { timestamps: true });

courseSchema.methods.toJSON = function () {
  const obj = this.toObject();
  return obj;
};

module.exports = mongoose.model('Course', courseSchema);
