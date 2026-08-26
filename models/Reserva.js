const mongoose = require('mongoose');
const { Schema } = mongoose;

// Un docente usando un recurso en un módulo de un día. Ver specs/recursos-reservas.spec.md.
//
// ── EL `date` ES UN STRING 'YYYY-MM-DD', Y ESO NO ES ESTILO ─────────────────────────────
// Es la misma decisión que models/AttendanceSession.js:29, tomada por los mismos tres
// motivos y todos vigentes acá:
//   1. Producción corre en UTC. Un `new Date()` a la medianoche local fecha la reserva del
//      día siguiente, y el índice único de abajo dejaría entrar una SEGUNDA reserva "del
//      mismo módulo".
//   2. Hace el índice único trivial: no hay que normalizar horas ni rangos.
//   3. Las comparaciones de rango del calendario semanal son exactas y ordenan solas.
// El día lo calcula SIEMPRE el servidor con diaEscolar() de services/liveRoom.js, que es el
// único dueño de la hora en todo el proyecto. Nunca se toma el string que manda el navegador
// sin validarlo antes contra la grilla.
const reservaSchema = new Schema({
  // DENORMALIZADA a propósito, igual que en AttendanceSession y RoomSession: todo $match del
  // proyecto arranca por la escuela del usuario.
  school:  { type: Schema.Types.ObjectId, ref: 'School',  required: true },
  recurso: { type: Schema.Types.ObjectId, ref: 'Recurso', required: true },

  date:   { type: String, required: true },   // 'YYYY-MM-DD', día escolar
  turno:  { type: String, required: true },   // Horario.turnos[].id
  modulo: { type: Number, required: true },   // la franja de tipo 'clase', por su `orden`

  docente:  { type: Schema.Types.ObjectId, ref: 'User',     required: true },
  course:   { type: Schema.Types.ObjectId, ref: 'Course',   default: null },
  division: { type: Schema.Types.ObjectId, ref: 'Division', default: null },
  motivo:   { type: String, trim: true, default: '', maxlength: 300 },

  status: {
    type: String,
    enum: ['pendiente', 'confirmada', 'rechazada', 'cancelada'],
    default: 'pendiente',
  },

  // ── El cupo ────────────────────────────────────────────────────────────────
  // Se guardan LAS DOS cifras, y no es redundancia: si el docente pidió 15 y el
  // administrativo le dio 8, el docente tiene que verlo y el administrativo tiene que poder
  // responder por qué. Una sola columna borra la pregunta.
  // En un recurso no divisible ambas valen 1.
  unidadesPedidas: { type: Number, default: 1, min: 1 },
  unidades:        { type: Number, default: 1, min: 1 },

  // DENORMALIZADO de Recurso.divisible (invertido) al crear la reserva.
  //
  // ⚠️ No es una comodidad: es lo que hace POSIBLE el índice de abajo. Un índice parcial de
  // Mongo puede condicionar por un campo del propio documento, pero no puede ir a mirar otra
  // colección para averiguar si el recurso es divisible. Sin este campo habría que elegir
  // entre no tener índice (y perder la única guarda que no se desincroniza) o tenerlo para
  // todos (y que la segunda reserva legítima de netbooks choque contra la primera).
  //
  // Corolario: cambiar Recurso.divisible NO reescribe las reservas ya hechas, y está bien —
  // cada reserva se rige por la regla que tenía el recurso cuando se hizo. Pero la pantalla
  // de edición del recurso tiene que avisarlo en vez de dejar que se descubra después.
  exclusiva: { type: Boolean, required: true },

  // ── La serie ───────────────────────────────────────────────────────────────
  // Las repeticiones (semanal, cada 15 días) se MATERIALIZAN: una Reserva por fecha, todas
  // con el mismo `serie`. Guardar una regla recurrente y resolverla al vuelo rompería las
  // dos cosas que sostienen este modelo — el índice único no puede vigilar una regla, y
  // cancelar un solo martes obligaría a inventar una lista de excepciones.
  serie: { type: String, default: null },

  pedidaEl:      { type: Date, default: Date.now },
  resueltaPor:   { type: Schema.Types.ObjectId, ref: 'User', default: null },
  resueltaEl:    { type: Date, default: null },
  motivoRechazo: { type: String, trim: true, default: '', maxlength: 300 },
}, { timestamps: true });

// ── La guarda de los recursos EXCLUSIVOS ───────────────────────────────────────────────
// Dos reservas confirmadas no pueden compartir casillero.
//
// Las dos condiciones del filtro parcial son necesarias, y por motivos distintos:
//   status: 'confirmada'  → sin esto, una reserva CANCELADA seguiría ocupando el casillero
//                           para siempre y el módulo quedaría muerto.
//   exclusiva: true       → sin esto, la segunda reserva legítima de netbooks sobre el mismo
//                           módulo chocaría contra la primera. Los divisibles se guardan con
//                           models/SlotOcupacion.js, no con este índice.
//
// ⚠️ partialFilterExpression y NUNCA sparse. `sparse` saltea el documento donde el campo está
// AUSENTE, no el que vale null o false — es exactamente el bug que en models/School.js:22
// impedía crear una segunda escuela, y que costó descubrir porque el error salía con el
// nombre de la escuela de rehén.
reservaSchema.index(
  { recurso: 1, date: 1, turno: 1, modulo: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmada', exclusiva: true } },
);

// Pintar la semana de un recurso, y la bandeja de pendientes de la escuela.
reservaSchema.index({ recurso: 1, date: 1, status: 1 });
reservaSchema.index({ school: 1, status: 1, date: 1 });
// "Mis reservas" del docente.
reservaSchema.index({ docente: 1, date: -1 });

module.exports = mongoose.model('Reserva', reservaSchema);
