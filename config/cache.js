// Cache genérico en memoria con expiración por TTL.
// Es por-worker (no se comparte entre procesos de PM2 cluster); aceptable para datos
// de lectura muy frecuente y baja tasa de cambio, como el usuario y la escuela del
// middleware global checkUser (ver middleware/cache.js).
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }

  // Vacía todo el cache. Se usa después de un restore de backup: los _id de usuarios/
  // escuelas cacheados pueden ya no corresponder a la BD reemplazada.
  clear() {
    this.store.clear();
  }
}

module.exports = TTLCache;
