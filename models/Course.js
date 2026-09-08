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
  // solo contra `owner` directamente en código nuevo. Para PERMISOS de ruta o de UI
  // usar course.canManage(user), que además incluye a los admins de la escuela.
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
// ── Permisos: quién puede qué sobre esta materia ─────────────────────────────
//
// ⭐ LAS REGLAS NO VIVEN ACÁ: viven en services/cursoPermisos.js, como funciones puras, con
// todos sus comentarios. Estos métodos son delegaciones de una línea, y existen para que las
// ~60 llamadas que ya había (`course.canManage(user)`, `course.canView(user)`, …) sigan
// funcionando sin tocarse.
//
// El motivo de la mudanza está escrito largo en ese archivo, y se resume así: un método de
// schema obliga a tener un DOCUMENTO hidratado, y eso es lo que hacía que el poll de la sala
// resolviera el curso entero con tres populate cada 4 segundos por persona (11,4 ms medidos).
// Las funciones puras andan igual sobre el objeto plano de un `lean()`, que es lo que sí se
// puede cachear sin compartir estado mutable.
//
// ⚠️ Al escribir código nuevo sobre una query `.lean()`, llamar a las funciones puras en vez
// de copiar la regla a mano. Ya pasó una vez: routes/activities.js:333 tiene una copia
// artesanal de canManage, con el comentario "porque esta query es .lean()".
const permisos = require('../services/cursoPermisos');

courseSchema.methods.isTeacher    = function (userId) { return permisos.esDocente(this, userId); };
courseSchema.methods.canManage    = function (user)   { return permisos.puedeGestionar(this, user); };
courseSchema.methods.canView      = function (user)   { return permisos.puedeVer(this, user); };
courseSchema.methods.canWatchLive = function (user, scopeDivisionIds = []) {
  return permisos.puedeMirarEnVivo(this, user, scopeDivisionIds);
};

// ── Invalidación del cache de cursos ─────────────────────────────────────────
//
// El poll de la sala lee el curso de un cache por-worker (middleware/cache.js, RN-1 de
// specs/sala-en-vivo-escala.spec.md). Esto lo borra cuando el curso cambia.
//
// ⭐ VA EN EL SCHEMA Y NO EN CADA RUTA. Hay ~20 lugares que modifican un curso —routes/admin.js,
// routes/courses.js, services/dbFixes.js, services/enrollment.js, services/joinByCode.js—, y
// engancharlos uno por uno es más código y, sobre todo, es la clase de lista que nadie se
// acuerda de actualizar cuando aparece el lugar 21. Acá pasan todos, incluidos los scripts de
// mantenimiento y los que se escriban mañana.
//
// Y si alguno igual se escapara, no queda un dato incorrecto para siempre: el TTL de 45 s lo
// corrige solo. Es el mismo trato que userCache le da a los cambios de rol.
const { invalidateCourse, courseCache } = require('../middleware/cache');

courseSchema.post('save', function (doc) {
  if (doc && doc._id) invalidateCourse(doc._id);
});

// Las queries de actualización. Un filtro por `_id` suelto invalida esa entrada; cualquier
// otra cosa (`{ _id: { $in: [...] } }`, un filtro por escuela, un updateMany) vacía el cache
// entero. Son operaciones de administración —importar, fusionar, reasignar docentes—, raras y
// en lote: repoblar el cache ahí es más barato que arriesgarse a servir un curso viejo.
function invalidarPorFiltro() {
  const filtro = typeof this.getFilter === 'function' ? this.getFilter() : null;
  const id = filtro && filtro._id;
  if (id && (typeof id === 'string' || id instanceof mongoose.Types.ObjectId)) invalidateCourse(id);
  else courseCache.clear();
}

courseSchema.post(['findOneAndUpdate', 'updateOne', 'findOneAndDelete', 'deleteOne'], invalidarPorFiltro);
courseSchema.post(['updateMany', 'deleteMany'], function () { courseCache.clear(); });

module.exports = mongoose.model('Course', courseSchema);
