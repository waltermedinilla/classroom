const mongoose = require('mongoose');

// Sub-schema para una calificación individual de un alumno en esta actividad
const gradeSchema = new mongoose.Schema({
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  points:   { type: Number, required: true, min: 0 }, // Nota asignada por el docente
  feedback: { type: String, default: '' },             // Comentario escrito del docente al alumno
  gradedAt: { type: Date, default: Date.now },         // Fecha en que se calificó
});

// Sub-schema para un adjunto (archivo o enlace) agregado por el docente al crear la actividad
const attachmentSchema = new mongoose.Schema({
  type: { type: String, enum: ['file', 'link'], required: true },
  name: { type: String, required: true },  // Nombre visible (nombre original del archivo o label del link)
  url:  { type: String, required: true },  // Ruta pública (/archivos/...) o URL externa
  mime: { type: String, default: '' },
}, { _id: false }); // Sin _id propio; los adjuntos se identifican por su url

const activitySchema = new mongoose.Schema({
  // Curso al que pertenece esta actividad (requerido para filtrar por curso)
  course:  { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  // Docente que creó la actividad (siempre el owner del curso)
  author:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  title:   { type: String, required: [true, 'El título es requerido'], trim: true },
  description: { type: String, default: '', trim: true },
  // Fecha límite de entrega; null = sin fecha límite
  dueDate: { type: Date, default: null },
  // Fecha desde la que la actividad es visible para los alumnos; por defecto ahora mismo
  availableFrom: { type: Date, default: Date.now },
  // Puntaje máximo; null = sin calificación numérica
  points:  { type: Number, default: null, min: 0 },
  // Array de calificaciones; cada alumno tiene como máximo una entrada (upsert en la ruta /grade)
  grades:  [gradeSchema],
  // Array de adjuntos del docente (archivos + links)
  attachments: [attachmentSchema],
  // Clasificación de la actividad; afecta el ícono y color de la tarjeta
  type: { type: String, enum: ['tarea', 'evaluacion', 'tp', 'examen'], default: 'tarea' },
  // Flag que habilita entregas fuera de término (lo activa/desactiva el docente con toggle-late)
  allowLateSubmissions: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Activity', activitySchema);
