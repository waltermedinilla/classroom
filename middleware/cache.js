const TTLCache = require('../config/cache');

// TTL corto (45s) a propósito, NO 5 minutos: este cache es por-worker (cada proceso de
// PM2 cluster tiene su propio Map en memoria, no se comparte entre workers). invalidateUser/
// invalidateSchool solo limpian la entrada en el worker que atendió la mutación — en
// producción (2 workers, PM2 reparte round-robin en Linux) el usuario deshabilitado o con
// el rol cambiado puede seguir sirviéndose desde OTRO worker hasta que ese TTL expire.
// Verificado en cluster local (Windows): con TTL de 5 min esa ventana de inconsistencia
// era real. 45s reduce las queries a Mongo ~45x igual, y acota el peor caso a menos de 1
// minuto en vez de 5. Si en el futuro se suman más workers o el caso de uso lo exige,
// la solución correcta es invalidación cross-worker (IPC de PM2 o Redis), no bajar más esto.
const userCache   = new TTLCache(45 * 1000);
const schoolCache = new TTLCache(45 * 1000);

// El curso de la sala en vivo, con sus alumnos, su división y su docente ya resueltos.
//
// Lo agrega RN-1 de specs/sala-en-vivo-escala.spec.md. El poll de la sala corre cada 4 s por
// persona y resolvía ese curso entero —cuatro queries, 11,4 ms medidos— en cada vuelta: a 30
// salas de 30 son ~2,6 núcleos gastados en volver a averiguar una lista de alumnos que no
// cambia en toda la hora.
//
// El MISMO TTL de 45 s que los de arriba, y por el mismo razonamiento: lo que se desactualiza
// es la matrícula y el plantel de la materia, que cambian unas pocas veces por semana. El peor
// caso es que un alumno recién inscripto tarde menos de un minuto en aparecer en la sala.
// La invalidación explícita vive en models/Course.js, enganchada al schema para que la cubran
// TODOS los caminos de escritura y no una lista que haya que mantener.
//
// ⚠️ Se guarda el objeto PLANO (`lean()`), nunca un documento de Mongoose: un documento es
// mutable y esto se comparte entre requests concurrentes. Por eso las reglas de permiso son
// funciones puras en services/cursoPermisos.js — ahí está escrito largo.
const courseCache = new TTLCache(45 * 1000);

module.exports = {
  userCache,
  schoolCache,
  courseCache,
  invalidateUser:   (id) => id && userCache.delete(id.toString()),
  invalidateSchool: (id) => id && schoolCache.delete(id.toString()),
  invalidateCourse: (id) => id && courseCache.delete(id.toString()),
  // Después de restaurar un backup completo, los _id cacheados pueden ya no existir
  // (o corresponder a datos completamente distintos) en la BD reemplazada. Solo limpia
  // el worker que atendió la restauración — mismo caveat de siempre en cluster.
  invalidateAll: () => { userCache.clear(); schoolCache.clear(); courseCache.clear(); },
};
