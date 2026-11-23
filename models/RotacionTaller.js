// Una rotación de grupos por las estaciones de taller — F4 de specs/jefe-de-taller.spec.md.
//
// Los períodos se arman al crearla (services/tallerRotacion.js, armarPeriodos) y el calendario
// sale de "Generar" (rotación circular) y de las correcciones a mano. Los MEP de cada estación
// NO se copian: son los docentes de su materia (course), así un cambio de docente se ve solo.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const estacionSchema = new Schema({
  nombre:       { type: String, required: true, trim: true, maxlength: 80 },
  course:       { type: Schema.Types.ObjectId, ref: 'Course', required: true },
  admiteVarios: { type: Boolean, default: false },   // RN-F4-2
});

const asignacionSchema = new Schema({
  grupo:    { type: Schema.Types.ObjectId, required: true },   // GruposTaller.grupos._id
  estacion: { type: Schema.Types.ObjectId, default: null },    // null = ese período no tiene estación
}, { _id: false });

const periodoSchema = new Schema({
  desde:      { type: String, required: true },   // 'YYYY-MM-DD'
  hasta:      { type: String, required: true },   // inclusive
  asignacion: { type: [asignacionSchema], default: [] },
}, { _id: false });

const rotacionTallerSchema = new Schema({
  school:     { type: Schema.Types.ObjectId, ref: 'School', required: true },
  division:   { type: Schema.Types.ObjectId, ref: 'Division', required: true },
  nombre:     { type: String, required: true, trim: true, maxlength: 80 },
  desde:      { type: String, required: true },
  hasta:      { type: String, required: true },
  cambiaCada: { type: String, enum: ['semana', 'quincena', 'mes', 'manual'], required: true },
  estaciones: { type: [estacionSchema], default: [] },
  periodos:   { type: [periodoSchema], default: [] },
  creadoPor:      { type: Schema.Types.ObjectId, ref: 'User', default: null },
  actualizadoPor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

rotacionTallerSchema.index({ school: 1, division: 1, desde: -1 });
// La franja de la materia (RN-F4-4) busca por estación.
rotacionTallerSchema.index({ 'estaciones.course': 1, hasta: 1 });

module.exports = mongoose.model('RotacionTaller', rotacionTallerSchema);
