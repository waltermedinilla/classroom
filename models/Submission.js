const mongoose = require('mongoose');

// Sub-schema para un archivo adjunto dentro de una entrega de alumno
const submissionFileSchema = new mongoose.Schema({
  name:        { type: String, required: true }, // Nombre original del archivo (para mostrar al usuario)
  filename:    { type: String, required: true }, // Nombre único en disco (timestamp + random + ext)
  // Ruta relativa desde ENTREGAS_BASE (archivos/entregas/)
  // Formato: {schoolId}/{activityId}/{studentId}/{filename}
  // Se usa para construir la ruta absoluta al servir o eliminar el archivo
  storagePath: { type: String, required: true },
  mime:        { type: String, default: '' },
  size:        { type: Number, default: 0 },   // Tamaño en bytes
}, { _id: false }); // Sin _id: los archivos se identifican por filename

const submissionSchema = new mongoose.Schema({
  // Actividad a la que corresponde esta entrega (FK para filtrar con Submission.find({ activity }))
  activity: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true },
  // Alumno que entregó (FK; se usa para verificar propiedad en descarga protegida)
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  // Archivos adjuntos; al reenviar se reemplazan todos (los anteriores se borran del disco)
  files:    [submissionFileSchema],
  // Comentario/texto opcional del alumno al entregar
  text:     { type: String, default: '', trim: true },
  // Fecha de la primera entrega (se setea una sola vez en el upsert via $setOnInsert)
  firstSubmittedAt: { type: Date, default: null },
  // El docente habilitó a ESTE alumno a rehacer su entrega ("Permitir que lo rehaga").
  // Es una autorización explícita y puntual, y por eso le gana a todo lo que normalmente
  // cerraría la edición: la nota ya puesta, el plazo vencido y el check destildado. Ver
  // public/js/edicionEntrega.js y specs/edicion-de-la-entrega.spec.md.
  //
  // Se apaga sola cuando el docente le vuelve a poner NOTA (POST /:id/grade): rehizo, lo
  // corregí de nuevo, se cierra. Si no se apagara, la primera reapertura le dejaría la
  // puerta abierta para siempre.
  reopenedAt: { type: Date, default: null },
  reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Respuestas estructuradas cuando la actividad viene de una plantilla interactiva.
  // Array libre indexado por questionId; el formato lo entiende services/autoGrader.
  // Ej: [{ questionId, mc: {selected: [optId,...]}, tf: {answer: true}, ... }]
  answers: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  // Resultado de la autocalificación al submitear. Se sobrescribe en cada reenvío
  // EXCEPTO si el docente ya puso un override manual (ver activity.grades[]).
  autoGraded: {
    points:    { type: Number },
    maxPoints: { type: Number },
    breakdown: [{ type: mongoose.Schema.Types.Mixed }], // [{questionId, awarded, max, correct}]
    gradedAt:  { type: Date },
  },
}, { timestamps: true }); // updatedAt se usa para mostrar cuándo fue el último reenvío

// Índice único: un alumno solo puede tener una entrega por actividad
// Si reenvía, se hace upsert (findOneAndUpdate con { upsert: true }) sobre este índice
submissionSchema.index({ activity: 1, student: 1 }, { unique: true });

// Panel directivo: "alumnos silenciosos" (sin entregas en los últimos 30 días)
submissionSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model('Submission', submissionSchema);
