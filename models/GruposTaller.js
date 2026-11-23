// Los grupos de taller de una división — F4 de specs/jefe-de-taller.spec.md.
//
// UN documento por división: guardar reemplaza la lista entera de una vez, así "un alumno en un
// solo grupo" (RN-F4-1) se valida completa antes de escribir (services/tallerRotacion.js,
// validarGrupos). El _id de cada grupo es fijo: las rotaciones lo usan en su calendario.

const mongoose = require('mongoose');
const { Schema } = mongoose;

const grupoSchema = new Schema({
  nombre:  { type: String, required: true, trim: true, maxlength: 40 },
  alumnos: [{ type: Schema.Types.ObjectId, ref: 'User' }],
});

const gruposTallerSchema = new Schema({
  school:   { type: Schema.Types.ObjectId, ref: 'School', required: true },
  division: { type: Schema.Types.ObjectId, ref: 'Division', required: true },
  grupos:   { type: [grupoSchema], default: [] },
  actualizadoPor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

gruposTallerSchema.index({ school: 1, division: 1 }, { unique: true });

module.exports = mongoose.model('GruposTaller', gruposTallerSchema);
