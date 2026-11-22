// El horario de la plataforma oficial, importado para COMPARAR (specs/secretaria-horario-oficial.spec.md).
//
// Un documento por curso y división de la escuela. Importar de nuevo reemplaza todo el de la
// escuela (D1): es una foto del otro sistema, no una historia. Tiene nombres reales de
// docentes: por eso vive en la base y no en el repositorio.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const entradaSchema = new Schema({
  hora:    { type: Number, default: null },        // la "Hora" de la captura (solo para mostrar)
  dia:     { type: Number, min: 1, max: 6, required: true },
  desde:   { type: String, required: true },       // 'HH:MM'
  hasta:   { type: String, required: true },
  materia: { type: String, default: '', trim: true, maxlength: 160 },
  docente: { type: String, default: '', trim: true, maxlength: 160 },
  nota:    { type: String, default: '', trim: true, maxlength: 40 },
}, { _id: false });

const horarioOficialSchema = new Schema({
  school:   { type: Schema.Types.ObjectId, ref: 'School', required: true },
  curso:    { type: Number, required: true, min: 1, max: 9 },
  division: { type: Number, required: true, min: 1, max: 99 },
  turno:    { type: String, default: '', trim: true, maxlength: 40 },
  carrera:  { type: String, default: '', trim: true, maxlength: 160 },
  notas:    { type: [String], default: [] },
  entradas: { type: [entradaSchema], default: [] },
  fuente:   { type: String, default: '', trim: true, maxlength: 300 },
  importadoPor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

horarioOficialSchema.index({ school: 1, curso: 1, division: 1 }, { unique: true });

module.exports = mongoose.model('HorarioOficial', horarioOficialSchema);
