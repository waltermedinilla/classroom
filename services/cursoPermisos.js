// Quién puede qué sobre una materia. Reglas PURAS: reciben datos y no consultan nada.
//
// ── POR QUÉ ESTÁN ACÁ Y NO COMO MÉTODOS DEL SCHEMA (2026-09-08) ──────────────────────────────
//
// Vivían en models/Course.js como `courseSchema.methods.*`, y eso las ataba a tener un
// DOCUMENTO de Mongoose hidratado. El poll de la sala corre cada 4 s por persona y resolvía el
// curso entero —con tres populate— solo para poder llamarlas: 11,4 ms medidos por poll, que a
// 30 salas de 30 son ~2,6 núcleos saturados en volver a averiguar lo mismo.
//
// Para cachear el curso hay que guardarlo como objeto plano (`lean()`): un documento de
// Mongoose es MUTABLE, y compartir uno entre requests concurrentes es la trampa que
// middleware/auth.js ya evita con `.lean()` + copia. Pero un objeto plano no tiene métodos.
//
// ⚠️ `Course.hydrate()` PARECE la salida y NO lo es. Medido el 2026-09-08:
//
//     Course.hydrate(plano, undefined, { hydratedPopulatedDocs: true })
//       → canManage existe:   true       ← los métodos vuelven
//       → students:           undefined  ← los populados NO
//       → canManage(docente): FALSE      ← y no lanza ningún error
//
//   O sea que la docente perdería su propia sala, en silencio, de forma intermitente según
//   qué worker la atienda. Por eso la separación es real y no cosmética.
//
// Estas funciones leen campos y nada más, así que andan igual sobre un documento hidratado y
// sobre un objeto plano. Eso es lo que permite que los métodos del schema sigan existiendo
// —delegando acá— y que las ~60 llamadas que ya había no se toquen.
//
// Ver specs/sala-en-vivo-escala.spec.md, RN-1.

// Tolera null/undefined: `owner` puede quedar colgado si se elimina al usuario docente
// (populate('owner') devuelve null). Sin esto, esDocente() tiraba un TypeError y con él
// toda ruta que use puedeGestionar() — la materia se volvía inaccesible para todo el mundo.
// Devuelve '' en ese caso: nunca coincide con un id real, así que no concede nada.
function idToString(val) {
  if (val === null || val === undefined) return '';
  return (val._id ? val._id : val).toString();
}

// ¿Es docente de esta materia? El owner o cualquiera de los coTeachers.
function esDocente(curso, userId) {
  if (!curso || !userId) return false;
  const uid = userId.toString();
  if (idToString(curso.owner) === uid) return true;
  return (curso.coTeachers || []).some(t => idToString(t) === uid);
}

// "¿Puede gestionar esta materia?" — es esDocente() MÁS los admins de la escuela y el
// superadmin, con los mismos permisos que un docente (crear/editar actividades, calificar,
// publicar novedades, gestionar alumnos). Decisión del usuario 2026-07-31: el admin entraba
// a /courses/:id y le daba "Acceso denegado"; podía mirar solo suplantando a un docente.
//
// A diferencia de esDocente() recibe el USUARIO COMPLETO, no el id: necesita el `role` y
// la `school`. Pasarle un id suelto devuelve false para el caso admin (no rompe, pero no
// concede nada) — usar siempre res.locals.user.
//
// Ojo con el `select` de la query: además de `owner coTeachers` tiene que traer `school`,
// o el admin de la escuela cae en el `idToString(undefined)` y se lo rechaza por error.
//
// NO usar esto para armar listados de "mis materias" (dashboard, perfil): ahí sigue valiendo
// la pertenencia real por owner/coTeachers, si no el admin vería las 419 materias como propias.
function puedeGestionar(curso, user) {
  if (!curso || !user) return false;
  if (esDocente(curso, user._id)) return true;
  // El superadmin no tiene escuela asignada: llega a todas.
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin') {
    if (!user.school || !curso.school) return false;
    return idToString(curso.school) === idToString(user.school);
  }
  return false;
}

// "¿Puede VER esta materia?" — quien la administra (puedeGestionar) o el alumno matriculado.
//
// Existe porque esta misma pregunta estaba respondida por separado en tres lugares y dos de
// ellos se la habían olvidado. La pantalla del curso (GET /courses/:id) sí la hacía y devolvía
// 403; pero `GET /courses/:id/data` y `GET /announcements/course/:id` solo pedían estar
// logueado. Resultado, verificado el 2026-08-30 contra la base real: **cualquiera de las 1.448
// cuentas —incluido un alumno de primer año— podía leer el listado completo de las 578
// materias, con el nombre y el CORREO de cada alumno y del docente**, pidiendo la URL a mano.
// La pantalla decía que no; la API decía que sí.
//
// Por eso la regla vive en un solo lugar y no repetida en cada ruta: es la única forma de que
// no se vuelva a olvidar en la cuarta. Mismo criterio en puedeMirarEnVivo() acá abajo.
//
// Ojo con el `select` de la query, igual que en puedeGestionar: hace falta traer `students` (y
// `owner`/`coTeachers`/`school`), o esto rechaza por omisión a quien sí pertenece. Y `students`
// puede venir populado (documentos) o crudo (ids): por eso el `s._id || s`.
function puedeVer(curso, user) {
  if (!curso || !user) return false;
  if (puedeGestionar(curso, user)) return true;
  const uid = idToString(user._id);
  return (curso.students || []).some(s => idToString(s && s._id ? s._id : s) === uid);
}

// "¿Puede ENTRAR a la sala en vivo de esta materia?" — es puedeGestionar() MÁS el equipo
// directivo de la escuela, MÁS el preceptor que tiene esta división en su alcance.
//
// Va SEPARADO de puedeGestionar() a propósito, y esa separación es el punto: gestionar concede
// crear actividades, calificar, borrar y publicar novedades. Sumar 'directivo' o 'preceptor'
// allá para que puedan mirar una clase les abriría de golpe la gestión completa de las 419
// materias de la escuela. Acá solo se concede entrar y leer: abrir la sala, cerrarla, moderar,
// silenciar y configurarla siguen pidiendo puedeGestionar() en routes/rooms.js.
//
// El segundo argumento es el alcance del preceptor YA RESUELTO por loadPreceptorScope
// (middleware/preceptor.js). No se resuelve acá adentro porque necesita una query a Division
// y esto es una función pura.
//
// FAIL-CLOSED: sin alcance no hay acceso. Nunca existe la convención "vacío = todas" — es la
// misma regla que sostiene assignedDivisions en models/User.js, y por el mismo motivo: el rol
// 'preceptor' se puede asignar por caminos que no preguntan por divisiones, y en todos ellos
// el usuario queda sin alcance. Si "vacío" significara "todas", esos caminos entregarían las
// salas de la escuela entera por omisión.
function puedeMirarEnVivo(curso, user, scopeDivisionIds = []) {
  if (!curso || !user) return false;
  if (puedeGestionar(curso, user)) return true;

  // Dirección ve toda su escuela. Sin escuela cargada de un lado o del otro no se concede
  // nada (mismo cuidado con el `select` que documenta puedeGestionar: la query tiene que
  // traer `school` o el chequeo falla por omisión, no por permiso).
  if (user.role === 'directivo') {
    if (!user.school || !curso.school) return false;
    return idToString(curso.school) === idToString(user.school);
  }

  if (user.role === 'preceptor') {
    if (!Array.isArray(scopeDivisionIds) || scopeDivisionIds.length === 0) return false;
    if (!curso.division) return false;
    return scopeDivisionIds.map(String).includes(idToString(curso.division));
  }

  return false;
}

module.exports = {
  idToString,
  esDocente,
  puedeGestionar,
  puedeVer,
  puedeMirarEnVivo,
};
