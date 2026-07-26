const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const courseSchema = new mongoose.Schema({
  // Nombre de la materia (ej: "Matemática", "Historia")
  name: {
    type: String,
    required: [true, 'El nombre de la materia es requerido'],
    trim: true,
  },
  room: {
    type: String,
    trim: true,
    default: '',
  },
  // Código único de 6 caracteres que los alumnos usan para unirse al curso
  code: {
    type: String,
    unique: true,
    default: () => uuidv4().slice(0, 6).toUpperCase(),
  },
  // División a la que pertenece (ej: "1°1°", "2°3°"); no puede ser null
  division: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Division',
    required: [true, 'La división es requerida'],
  },
  // Escuela a la que pertenece; requerida — sin escuela no puede existir una materia
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    required: [true, 'La escuela es requerida'],
  },
  // Docente principal (dueño) del curso. Se mantiene como "el" docente mostrado en
  // tarjetas/listados — no se toca al consolidar materias duplicadas.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Docentes adicionales con los mismos permisos que el owner sobre esta materia
  // (crear/editar/eliminar actividades, calificar, publicar novedades, gestionar alumnos,
  // ver el gradebook). Se pobló por primera vez al consolidar materias duplicadas: cuando
  // dos o más Course del mismo nombre en la misma división se fusionan en una sola, los
  // owners de las eliminadas pasan acá en vez de perderse (ver scripts/merge-courses.js).
  // Siempre chequear pertenencia con course.isTeacher(userId) — nunca comparar
  // solo contra `owner` directamente en código nuevo.
  coTeachers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: [],
  }],
  // Lista de alumnos inscriptos
  students: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // Fecha en que cada alumno se inscribió a esta materia. Map<studentId, Date>.
  // Solo se popula desde POST /admin/users/create cuando el admin da de alta un alumno
  // seleccionando un Curso (Division) — se lo inscribe en todas las materias de ese Curso
  // con joinedAt = ahora. Los alumnos existentes al momento de agregar este campo, y los
  // que agrega el docente manualmente desde su curso, NO tienen entrada acá — se interpretan
  // como "siempre estuvo" y ven todas las actividades sin filtro (backward compat).
  // Consultado por routes/activities.js para ocultar tareas ya vencidas cuando el alumno
  // se inscribió después del dueDate.
  enrollmentDates: {
    type: Map,
    of: Date,
    default: {},
  },
  // Personalización visual del encabezado
  header: {
    color:  { type: String, default: null },
    color2: { type: String, default: null },
    image:  { type: String, default: null },
  },
}, { timestamps: true });

// Único punto de verdad para "¿es docente de esta materia?" — owner O cualquiera de
// coTeachers. Usar esto en vez de comparar contra `owner` a mano en rutas nuevas.
// Seguro tanto si owner/coTeachers vienen sin popular (ObjectId crudo) como si vienen
// populados (.populate('owner', 'name')) — en ese caso hay que comparar por ._id,
// porque el .toString() de un documento completo NO es el mismo que el del ObjectId.
function idToString(val) {
  return (val && val._id ? val._id : val).toString();
}
courseSchema.methods.isTeacher = function (userId) {
  if (!userId) return false;
  const uid = userId.toString();
  if (idToString(this.owner) === uid) return true;
  return (this.coTeachers || []).some(t => idToString(t) === uid);
};

module.exports = mongoose.model('Course', courseSchema);
