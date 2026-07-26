const mongoose = require('mongoose');

// Sub-schemas por tipo de pregunta. Solo el bloque correspondiente a question.type
// se llena; los demás quedan vacíos. Se mantienen como subdocs con _id: false para
// que su identidad viva en el _id de la propia pregunta contenedora.

const mcOptionSchema = new mongoose.Schema({
  text:      { type: String, required: true, trim: true },
  isCorrect: { type: Boolean, default: false },
}, { _id: true });

const mcSchema = new mongoose.Schema({
  options:          [mcOptionSchema],
  multipleAllowed:  { type: Boolean, default: false }, // true = permite marcar >1 correcta
}, { _id: false });

const tfSchema = new mongoose.Schema({
  correctAnswer: { type: Boolean, required: true },
}, { _id: false });

const matchItemSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true },
}, { _id: true });

const matchPairSchema = new mongoose.Schema({
  leftId:  { type: mongoose.Schema.Types.ObjectId, required: true },
  rightId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, { _id: false });

const matchSchema = new mongoose.Schema({
  leftItems:    [matchItemSchema],
  rightItems:   [matchItemSchema],
  correctPairs: [matchPairSchema],
}, { _id: false });

const fillSchema = new mongoose.Schema({
  // Texto con "{{blank}}" donde va la palabra a completar. Ej: "La capital de Argentina es {{blank}}."
  template:        { type: String, required: true, trim: true },
  // Respuestas aceptadas (comparación case-insensitive, trim). Ej: ['buenos aires', 'bs as']
  acceptedAnswers: [{ type: String, trim: true }],
}, { _id: false });

const commonSchema = new mongoose.Schema({
  // Enunciado/consignas para actividad "común" (entrega libre, sin autocalificación)
  instructions: { type: String, default: '' },
}, { _id: false });

// Pregunta discriminada por type. Cada pregunta tiene su _id (para vincular con
// las respuestas del alumno en Submission.answers[]) y solo el sub-schema
// correspondiente al type se debe llenar.
const questionSchema = new mongoose.Schema({
  type:   { type: String, enum: ['common', 'mc', 'tf', 'match', 'fill'], required: true },
  prompt: { type: String, required: true, trim: true },
  points: { type: Number, default: 1, min: 0 }, // Peso relativo dentro de la actividad
  mc:     { type: mcSchema,     default: undefined },
  tf:     { type: tfSchema,     default: undefined },
  match:  { type: matchSchema,  default: undefined },
  fill:   { type: fillSchema,   default: undefined },
  common: { type: commonSchema, default: undefined },
}, { _id: true });

const activityTemplateSchema = new mongoose.Schema({
  title:         { type: String, required: [true, 'El título es requerido'], trim: true },
  description:   { type: String, default: '', trim: true },
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // draft = solo visible en el gestor del superadmin (no se puede asignar aún)
  // published = disponible para asignar a escuelas
  // archived = oculto de listados por defecto; las instancias vivas no se tocan
  status:        { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
  questions:     [questionSchema],
  // Puntaje total sugerido para la actividad al instanciarla. Se puede sobrescribir en Activity.points.
  defaultPoints: { type: Number, default: 100, min: 0 },
}, { timestamps: true });

activityTemplateSchema.index({ status: 1, updatedAt: -1 });
activityTemplateSchema.index({ createdBy: 1 });

module.exports = mongoose.model('ActivityTemplate', activityTemplateSchema);
