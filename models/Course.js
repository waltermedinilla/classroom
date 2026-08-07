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
// Tolera null/undefined: `owner` puede quedar colgado si se elimina al usuario docente
// (populate('owner') devuelve null). Sin esto, isTeacher() tiraba un TypeError y con él
// toda ruta que use canManage() — la materia se volvía inaccesible para todo el mundo.
// Devuelve '' en ese caso: nunca coincide con un id real, así que no concede nada.
function idToString(val) {
  if (val === null || val === undefined) return '';
  return (val._id ? val._id : val).toString();
}
courseSchema.methods.isTeacher = function (userId) {
  if (!userId) return false;
  const uid = userId.toString();
  if (idToString(this.owner) === uid) return true;
  return (this.coTeachers || []).some(t => idToString(t) === uid);
};

// "¿Puede gestionar esta materia?" — es isTeacher() MÁS los admins de la escuela y el
// superadmin, con los mismos permisos que un docente (crear/editar actividades, calificar,
// publicar novedades, gestionar alumnos). Decisión del usuario 2026-07-31: el admin entraba
// a /courses/:id y le daba "Acceso denegado"; podía mirar solo suplantando a un docente.
//
// A diferencia de isTeacher() recibe el USUARIO COMPLETO, no el id: necesita el `role` y
// la `school`. Pasarle un id suelto devuelve false para el caso admin (no rompe, pero no
// concede nada) — usar siempre res.locals.user.
//
// Ojo con el `select` de la query: además de `owner coTeachers` tiene que traer `school`,
// o el admin de la escuela cae en el `idToString(undefined)` y se lo rechaza por error.
//
// NO usar esto para armar listados de "mis materias" (dashboard, perfil): ahí sigue valiendo
// la pertenencia real por owner/coTeachers, si no el admin vería las 419 materias como propias.
courseSchema.methods.canManage = function (user) {
  if (!user) return false;
  if (this.isTeacher(user._id)) return true;
  // El superadmin no tiene escuela asignada: llega a todas.
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin') {
    if (!user.school || !this.school) return false;
    return idToString(this.school) === idToString(user.school);
  }
  return false;
};

// "¿Puede ENTRAR a la sala en vivo de esta materia?" — es canManage() MÁS el equipo directivo
// de la escuela, MÁS el preceptor que tiene esta división en su alcance.
//
// Va SEPARADO de canManage() a propósito, y esa separación es el punto: canManage concede
// crear actividades, calificar, borrar y publicar novedades. Sumar 'directivo' o 'preceptor'
// allá para que puedan mirar una clase les abriría de golpe la gestión completa de las 419
// materias de la escuela. Acá solo se concede entrar y leer: abrir la sala, cerrarla, moderar,
// silenciar y configurarla siguen pidiendo canManage() en routes/rooms.js.
//
// El segundo argumento es el alcance del preceptor YA RESUELTO por loadPreceptorScope
// (middleware/preceptor.js). No se resuelve acá adentro porque necesita una query a Division
// y un método de instancia sincrónico no puede hacerla.
//
// FAIL-CLOSED: sin alcance no hay acceso. Nunca existe la convención "vacío = todas" — es la
// misma regla que sostiene assignedDivisions en models/User.js, y por el mismo motivo: el rol
// 'preceptor' se puede asignar por caminos que no preguntan por divisiones, y en todos ellos
// el usuario queda sin alcance. Si "vacío" significara "todas", esos caminos entregarían las
// salas de la escuela entera por omisión.
courseSchema.methods.canWatchLive = function (user, scopeDivisionIds = []) {
  if (!user) return false;
  if (this.canManage(user)) return true;

  // Dirección ve toda su escuela. Sin escuela cargada de un lado o del otro no se concede
  // nada (mismo cuidado con el `select` que documenta canManage: la query tiene que traer
  // `school` o el chequeo falla por omisión, no por permiso).
  if (user.role === 'directivo') {
    if (!user.school || !this.school) return false;
    return idToString(this.school) === idToString(user.school);
  }

  if (user.role === 'preceptor') {
    if (!Array.isArray(scopeDivisionIds) || scopeDivisionIds.length === 0) return false;
    if (!this.division) return false;
    return scopeDivisionIds.map(String).includes(idToString(this.division));
  }

  return false;
};

module.exports = mongoose.model('Course', courseSchema);
