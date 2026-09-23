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

// Un mensaje del hilo privado entre el docente y ESTE alumno sobre ESTA entrega
// (specs/correccion-de-entregas.spec.md, RN-29). Embebido y no en colección propia:
// `submissions` ya está en COLLECTIONS, así que el hilo viaja en el backup sin tocar la lista.
//
// La forma está copiada de models/MessageRecipient.js (threadMessageSchema), que ya hace
// exactamente esto en producción: hilo 1 a 1 + no-leído por cada punta.
const privateCommentSchema = new mongoose.Schema({
  // 'teacher' | 'student'. Es el ROL EN ESTE HILO, no el rol del usuario: quien gestiona la
  // materia escribe como 'teacher' aunque sea admin o directivo, y así el hilo se lee igual
  // aunque la persona cambie de rol después (mismo criterio que roleAtSend).
  from:   { type: String, enum: ['teacher', 'student'], required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text:   { type: String, required: true, trim: true, maxlength: 2000 },
  at:     { type: Date, default: Date.now },
});

// Versión anterior de la entrega, guardada al reenviar (RN-33). Los archivos NO se borran
// más: se MUEVEN a `_versiones/` dentro de la misma carpeta del alumno, que ya está
// respaldada (CARPETAS, id `entregas`) — cero superficie nueva de backup.
const submissionVersionSchema = new mongoose.Schema({
  at:    { type: Date, required: true },
  text:  { type: String, default: '' },
  files: [submissionFileSchema],   // con storagePath apuntando a .../_versiones/
}, { _id: true });                 // CON _id: es la clave del enlace del historial

const submissionSchema = new mongoose.Schema({
  // Actividad a la que corresponde esta entrega (FK para filtrar con Submission.find({ activity }))
  activity: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true },
  // Alumno que entregó (FK; se usa para verificar propiedad en descarga protegida)
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  // Archivos adjuntos; al reenviar se reemplazan todos (los anteriores ya NO se borran del
  // disco: se mueven a `_versiones/` y quedan en `versions[]`, ver RN-33)
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
  // El hilo privado docente ↔ alumno sobre esta entrega (RN-29) y las versiones anteriores
  // (RN-33, tope 5: se cae la más vieja y sus archivos se borran de verdad).
  privateComments: [privateCommentSchema],
  versions:        [submissionVersionSchema],
  // ¿Hay algo en el hilo que la otra punta todavía no vio? DOS booleanos y no un `readAt`
  // por comentario, por el mismo motivo que MessageRecipient lo hace así: el badge se pinta
  // con una query indexada en vez de recorrer el hilo de las 30 entregas de cada actividad.
  //
  // Los defaults acá SÍ corresponden, al revés que `returnedAt` (RN-22): un backup anterior
  // a la feature vuelve sin estos campos, y "false / sin comentarios" es exactamente lo que
  // pasaba antes de la feature. La regla no es "no uses defaults": es "el default tiene que
  // decir la verdad sobre los datos que ya existen" (RN-32b).
  unreadForTeacher: { type: Boolean, default: false },
  unreadForStudent: { type: Boolean, default: false },
}, { timestamps: true }); // updatedAt se usa para mostrar cuándo fue el último reenvío

// Índice único: un alumno solo puede tener una entrega por actividad
// Si reenvía, se hace upsert (findOneAndUpdate con { upsert: true }) sobre este índice
submissionSchema.index({ activity: 1, student: 1 }, { unique: true });

// Panel directivo: "alumnos silenciosos" (sin entregas en los últimos 30 días)
submissionSchema.index({ student: 1, createdAt: -1 });

// Chip "N sin leer" de la tarjeta de actividad: cuántas entregas de esta actividad tienen
// algo sin leer para el docente. Espeja a messageRecipientSchema.index({ user, unreadForUser }).
// La punta del alumno se resuelve por el índice único { activity, student } de arriba.
submissionSchema.index({ activity: 1, unreadForTeacher: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
