const mongoose = require('mongoose');
const { Schema } = mongoose;

// El horario escolar: en qué turnos se divide el día y qué franjas tiene cada turno.
// Uno por escuela. Lo carga el ADMINISTRATIVO desde /admin/recursos/horario.
//
// Es la grilla contra la que se reservan los recursos (models/Reserva.js). No tiene nada que
// ver con el horario de clases de cada materia —eso no existe en el sistema— ni con la
// asistencia: es solo el almanaque del día, para que "3ª hora del martes" signifique algo.
//
// ── POR QUÉ LAS HORAS SON STRINGS 'HH:MM' Y NO Date ────────────────────────────────────
// Un módulo es una ETIQUETA de la grilla ("2ª hora, de 8:40 a 9:20"), no un instante. Con
// Date habría que inventarle un día a cada franja, y ese día inventado se corre solo:
// producción corre en UTC y un `new Date('1970-01-01T08:00')` no significa las 8 de la
// mañana en Argentina. Es la misma decisión, por el mismo motivo, que el `date` string de
// models/AttendanceSession.js:29.
// Bonus: 'HH:MM' compara y ordena como string sin ninguna conversión, que es la mitad de
// las validaciones de services/recursos/horario.js.
const franjaSchema = new Schema({
  // 'clase'  → se puede reservar. Tiene `orden` (1, 2, 3…), que es lo que el docente dice
  //            en voz alta ("me toca 3ª hora") y lo único que guarda models/Reserva.js.
  // 'recreo' → NO se reserva, y aun así está en la grilla. Dos motivos, los dos reales:
  //            sin la franja el calendario salta de 2ª (termina 9:20) a 3ª (arranca 9:30) y
  //            las dos filas se leen contiguas; y la validación "las franjas cubren el turno
  //            entero, sin huecos" sería falsa justo donde sirve.
  tipo:  { type: String, enum: ['clase', 'recreo'], default: 'clase' },
  // null en los recreos. En las clases es correlativo y único dentro del turno.
  orden: { type: Number, default: null },
  label: { type: String, required: true, trim: true },
  desde: { type: String, required: true },  // 'HH:MM'
  hasta: { type: String, required: true },  // 'HH:MM'
}, { _id: false });

const turnoSchema = new Schema({
  // Estable: es lo que guarda Reserva.turno. NO cambia aunque el administrativo renombre
  // el turno de "Turno Mañana" a "Mañana".
  id:      { type: String, required: true, trim: true },
  label:   { type: String, required: true, trim: true },
  desde:   { type: String, required: true },  // 'HH:MM' — el rango del turno
  hasta:   { type: String, required: true },
  franjas: { type: [franjaSchema], default: [] },
}, { _id: false });

const horarioSchema = new Schema({
  // unique: una escuela tiene UN horario. Si algún día hace falta uno por ciclo lectivo,
  // esto se convierte en {school, ciclo} — pero hoy inventar el ciclo sería inventar un
  // concepto que el resto del sistema no tiene.
  school: { type: Schema.Types.ObjectId, ref: 'School', required: true, unique: true },
  turnos: { type: [turnoSchema], default: [] },
  // 1 = lunes … 6 = sábado. Default de lunes a viernes; la Escuela 4118 no tiene sábado.
  // Domingo no está contemplado a propósito: si alguna vez hace falta, es 0 y hay que
  // revisar el orden de la grilla, no solo agregar el número.
  dias:   { type: [Number], default: [1, 2, 3, 4, 5] },
}, { timestamps: true });

module.exports = mongoose.model('Horario', horarioSchema);
