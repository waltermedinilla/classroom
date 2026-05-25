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
}, { timestamps: true }); // updatedAt se usa para mostrar cuándo fue el último reenvío

// Índice único: un alumno solo puede tener una entrega por actividad
// Si reenvía, se hace upsert (findOneAndUpdate con { upsert: true }) sobre este índice
submissionSchema.index({ activity: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('Submission', submissionSchema);
