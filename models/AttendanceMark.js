const mongoose = require('mongoose');

// La asistencia de UNA persona en UNA toma: un documento por alumno y por toma.
// ES el registro de asistencia — no hay otra colección para eso.
//
// Se crean todas juntas al abrir la toma (abrirToma en services/attendance.js), con
// status: null. Esa nómina queda CONGELADA: un alumno que se matricula a las 10 de la
// mañana no aparece en la toma de las 7:30, y uno que se va de la escuela sigue figurando
// en las tomas de cuando estaba. La asistencia de un día es la de los que estaban ese día.
//
// Mismo patrón que RoomPresence y ActivityView: par único + upsert desde el servicio.
const attendanceMarkSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSession', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // DENORMALIZADAS: el reporte mensual filtra por curso y rango de fechas. Sin estos campos
  // habría que traer todas las tomas del período y hacer un $lookup por cada marca. `date`
  // es inmutable (el día de una toma no cambia nunca), así que no puede desincronizarse.
  division: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true },
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School',   required: true },
  date:     { type: String, required: true },

  // Snapshot, igual que en RoomPresence: la asistencia de hace un año tiene que seguir
  // siendo legible aunque la cuenta ya no exista. El DNI porque es lo que pide el CSV.
  studentName: { type: String, default: '' },
  studentDni:  { type: String, default: '' },

  // null = SIN MARCAR. No es un estado: es la ausencia de decisión, y solo existe mientras
  // la toma está abierta. Al cerrar, todo null pasa a 'ausente' — una toma cerrada no tiene
  // ningún null.
  status: {
    type: String,
    enum: ['presente', 'tarde', 'ausente', 'justificado', null],
    default: null,
  },

  // Quién puso el valor ACTUAL. 'sala' queda reservado y hoy no lo escribe nadie: la sala
  // en vivo sugiere, nunca marca (decisión del usuario, RN-09 de la spec). Cuando el
  // preceptor acepta una sugerencia, la marca queda como 'preceptor', porque la puso él.
  source: {
    type: String,
    enum: ['preceptor', 'alumno', 'sala', null],
    default: null,
  },
  markedAt: { type: Date, default: null },
  // null cuando se marcó el alumno solo.
  markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Cuándo se marcó el ALUMNO a sí mismo. Se conserva aunque después el preceptor cambie el
  // estado: es el dato que permite ver "el chico dijo estar a las 7:42 y a las 8:10 lo
  // pasaron a ausente". Sin este campo, corregir una marca borraría que el alumno la había
  // dado — que es justo lo que se discute cuando alguien reclama.
  selfMarkedAt: { type: Date, default: null },

  // Motivo del justificado u observación. Texto, no archivo: adjuntar documentación es otra
  // feature (y otra spec).
  note: { type: String, trim: true, default: '', maxlength: 200 },
}, { timestamps: true });

// Una sola marca por alumno y toma. Es la clave del upsert y lo que hace idempotente al
// botón del alumno: doble click, F5 o dos pestañas producen una marca, no tres.
attendanceMarkSchema.index({ session: 1, student: 1 }, { unique: true });

// Grilla del día y reporte mensual del curso.
attendanceMarkSchema.index({ division: 1, date: 1 });

// "La asistencia de este alumno", para cuando el preceptor mira un legajo.
attendanceMarkSchema.index({ student: 1, date: -1 });

module.exports = mongoose.model('AttendanceMark', attendanceMarkSchema);
