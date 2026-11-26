// Mediciones REALES del proceso de medios — D1 de specs/transmision-cupo-automatico.spec.md.
//
// Cada 5 segundos: la salida de red de la interfaz principal, el procesador de los workers de
// mediasoup, la memoria libre y la pérdida de paquetes que reportan los navegadores de los que
// miran. Es lo que usa el cupo para decidir si entra otra clase, y lo que se ve en el Monitor.
//
// Nunca lanza: una medición que falla devuelve null en ese dato y el cupo decide con la cuenta
// de espectadores (RN-6). Leer /proc no existe fuera de Linux: en Windows (desarrollo local) la
// red queda en null y no pasa nada.

const fs = require('fs');
const os = require('os');

function interfazPrincipal() {
  try {
    const filas = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
    for (const f of filas) {
      const [iface, destino] = f.trim().split(/\s+/);
      if (destino === '00000000') return iface;
    }
  } catch (e) { /* no es Linux */ }
  return null;
}

function bytesSalida(iface) {
  if (!iface) return null;
  try {
    for (const f of fs.readFileSync('/proc/net/dev', 'utf8').split('\n')) {
      const [nombre, resto] = f.split(':');
      if (!resto || nombre.trim() !== iface) continue;
      const campos = resto.trim().split(/\s+/).map(Number);
      return campos[8];   // bytes transmitidos
    }
  } catch (e) { /* idem */ }
  return null;
}

// `fractionLost` de RTCP viene como 0..255 (fracción en 1/256); algunos navegadores lo mandan
// ya como 0..1. Se lleva siempre a 0..1.
const aFraccion = (x) => { const n = Number(x); if (!Number.isFinite(n) || n < 0) return null; return n > 1 ? n / 256 : n; };

function crear({ sfu, log = console, cadaMs = 5000, guardar = 60 }) {
  const iface = interfazPrincipal();
  let anterior = { t: Date.now(), tx: bytesSalida(iface), cpuMs: null };
  const historial = [];   // las últimas `guardar` mediciones (5 min a 5 s)
  let ultima = null;

  async function cpuDeWorkers() {
    let total = 0;
    for (const w of sfu.workers || []) {
      try {
        const u = await w.getResourceUsage();
        total += (Number(u.ru_utime) || 0) + (Number(u.ru_stime) || 0);
      } catch (e) { return null; }
    }
    return total;
  }

  // Pérdida promedio de hasta 40 consumidores de video (los que reciben): alcanza para saber si
  // la red no da abasto, sin pedirle estadísticas a 600 consumidores cada 5 segundos.
  async function perdidaPromedio() {
    const valores = [];
    for (const sala of sfu.salas.values()) {
      for (const c of sala.consumidores.values()) {
        if (valores.length >= 40) break;
        if (c.kind !== 'video' || c.closed || c.paused) continue;
        try {
          const st = await c.getStats();
          for (const r of st || []) {
            const f = aFraccion(r.fractionLost);
            if (f != null && r.type === 'outbound-rtp') { valores.push(f); break; }
          }
        } catch (e) { /* cerrado en el medio */ }
      }
    }
    return valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : 0;
  }

  async function tomar() {
    const t = Date.now();
    const seg = Math.max(0.001, (t - anterior.t) / 1000);
    const tx = bytesSalida(iface);
    const salidaMbps = tx != null && anterior.tx != null && tx >= anterior.tx ? ((tx - anterior.tx) * 8) / seg / 1e6 : null;
    const cpuMs = await cpuDeWorkers();
    const nucleos = Math.max(1, (sfu.workers || []).length || 1);
    const cpu = cpuMs != null && anterior.cpuMs != null ? Math.min(100, ((cpuMs - anterior.cpuMs) / (seg * 1000 * nucleos)) * 100) : null;
    const perdida = await perdidaPromedio().catch(() => null);
    anterior = { t, tx, cpuMs };
    ultima = {
      t,
      salidaMbps: salidaMbps != null ? Math.round(salidaMbps * 10) / 10 : null,
      cpu: cpu != null ? Math.round(cpu) : null,
      perdida: perdida != null ? Math.round(perdida * 1000) / 1000 : null,
      memoriaLibreMB: Math.round(os.freemem() / 1048576),
      carga: os.loadavg()[0],
    };
    historial.push(ultima);
    if (historial.length > guardar) historial.shift();
    return ultima;
  }

  let reloj = null;
  function arrancar(alMedir) {
    if (reloj) return;
    reloj = setInterval(() => {
      tomar().then(m => alMedir && alMedir(m)).catch(e => log.error('[medicion]', e.message));
    }, cadaMs);
    if (reloj.unref) reloj.unref();
  }

  return { tomar, arrancar, ultima: () => ultima, historial: () => historial.slice(), iface };
}

module.exports = { crear, interfazPrincipal, bytesSalida, aFraccion };
