const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const courseSchema = new mongoose.Schema({
  // Nombre de la materia (ej: "Matemática", "Historia")
  name: {
    type: String,
    required: [true, 'El nombre de la materia es requerido'],
    trim: true,
  },
  room: {
    type: String,
    trim: true,
    default: '',
  },
  // Código único de 6 caracteres que los alumnos usan para unirse al curso
  code: {
    type: String,
    unique: true,
    default: () => uuidv4().slice(0, 6).toUpperCase(),
  },
  // División a la que pertenece (ej: "1°1°", "2°3°"); no puede ser null
  division: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Division',
    required: [true, 'La división es requerida'],
  },
  // Escuela a la que pertenece; requerida — sin escuela no puede existir una materia
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: [true, 'La escuela es requerida'],
  },
  // Docente dueño del curso
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Lista de alumnos inscriptos
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // Personalización visual del encabezado
  header: {
    color:  { type: String, default: null },
    color2: { type: String, default: null },
    image:  { type: String, default: null },
  },
}, { timestamps: true });

module.exports = mongoose.model('Course', courseSchema);
