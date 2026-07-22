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

module.exports = {
  userCache,
  schoolCache,
  invalidateUser:   (id) => id && userCache.delete(id.toString()),
  invalidateSchool: (id) => id && schoolCache.delete(id.toString()),
  // Después de restaurar un backup completo, los _id cacheados pueden ya no existir
  // (o corresponder a datos completamente distintos) en la BD reemplazada. Solo limpia
  // el worker que atendió la restauración — mismo caveat de siempre en cluster.
  invalidateAll: () => { userCache.clear(); schoolCache.clear(); },
};
