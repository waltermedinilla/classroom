const mongoose = require('mongoose');

// Sub-schema para una calificación individual de un alumno en esta actividad
const gradeSchema = new mongoose.Schema({
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  points:   { type: Number, required: true, min: 0 }, // Nota asignada por el docente
  feedback: { type: String, default: '' },             // Comentario escrito del docente al alumno
  gradedAt: { type: Date, default: Date.now },         // Fecha en que se calificó
  // true = el docente la puso (o editó) manualmente vía POST /:id/grade
  // false = la puso el autocalificador (actividades con templateSnapshot)
  // Se usa en el reenvío del alumno para NO pisar overrides manuales del docente.
  // Default true: los grades históricos existentes se leen como "manuales", que
  // es exactamente lo que eran (no había autocalificador antes).
  manual:   { type: Boolean, default: true },
});

// Sub-schema para un adjunto (archivo o enlace) agregado por el docente al crear la actividad
const attachmentSchema = new mongoose.Schema({
  type: { type: String, enum: ['file', 'link'], required: true },
  name: { type: String, required: true },  // Nombre visible (nombre original del archivo o label del link)
  url:  { type: String, required: true },  // Ruta pública (/archivos/...) o URL externa
  mime: { type: String, default: '' },
}, { _id: false }); // Sin _id propio; los adjuntos se identifican por su url

// Snapshot inmutable de la plantilla al momento de instanciar la actividad.
// Copiamos las preguntas COMPLETAS (con respuestas correctas) acá para que si el
// superadmin edita la plantilla después, las entregas de los alumnos sigan siendo
// evaluadas contra el enunciado que efectivamente vieron.
const templateSnapshotSchema = new mongoose.Schema({
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ActivityTemplate' },
  // Timestamp de la plantilla al momento del snapshot (para trazabilidad de "qué versión estás viendo")
  templateUpdatedAt: { type: Date },
  questions: [{ type: mongoose.Schema.Types.Mixed }],
}, { _id: false });

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
  // Clasificación de la actividad; afecta el ícono y color de la tarjeta.
  //
  // 'examen' se retiró el 2026-07-29: era indistinguible de 'evaluacion' para el docente y
  // no lo había usado nadie (0 registros en producción, verificado antes del cambio). Los
  // tipos quedan en tres HASTA NUEVO AVISO. Si alguna vez quedara un documento histórico con
  // type:'examen', se LEE sin problema (Mongoose no valida en lectura) pero cualquier
  // activity.save() falla con ValidationError — y eso rompe calificar, editar y recibir
  // entregas. Para eso está migrate-examen-to-evaluacion.js.
  type: { type: String, enum: ['tarea', 'evaluacion', 'tp'], default: 'tarea' },
  // Flag que habilita entregas fuera de término (lo activa/desactiva el docente con toggle-late)
  allowLateSubmissions: { type: Boolean, default: false },
  // Flag que permite al alumno editar/reenviar su entrega después de la primera vez
  // (lo activa/desactiva el docente). Default false: una vez entregada, queda fija
  // y el alumno solo puede visualizarla (no editarla).
  allowResubmission: { type: Boolean, default: false },
  // Presente solo si la actividad fue instanciada desde una plantilla del gestor
  // (ver services/autoGrader.js para la evaluación). Actividades "clásicas" no lo llevan.
  templateSnapshot: { type: templateSnapshotSchema, default: undefined },
}, { timestamps: true });

// Índices usados por el panel directivo (tasa de entrega, actividades vencidas sin calificar)
// y por las queries frecuentes de listado en /activities/course/:id
activitySchema.index({ course: 1, availableFrom: 1 });
activitySchema.index({ course: 1, dueDate: 1 });

// Producción por AUTOR (no por dueño del curso): lo usan la serie temporal de actividad
// docente del panel directivo (routes/directivo.js, GET /teachers) y getUserActivityStats
// (services/userActivityStats.js) para las columnas Nov/Act/Msg de admin y superadmin.
// Sin este índice, ambos hacen collscan sobre `activities`.
activitySchema.index({ author: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);
