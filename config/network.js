const fs = require('fs');

// Lee /proc/net/dev (Linux) y calcula la tasa de transferencia de red de TODO el servidor
// (todas las interfaces menos loopback) comparando contra la muestra anterior en memoria.
// No disponible en Windows (dev): getNetworkStats() devuelve { available: false }.
//
// Nota PM2 cluster: la "muestra anterior" queda en memoria de CADA worker por separado,
// así que la ventana de tiempo entre dos muestras puede variar según qué worker atendió
// la petición previa. Esto no afecta la exactitud de la tasa (los bytes de /proc/net/dev
// son totales del sistema operativo, no del proceso), solo el tamaño de la ventana que
// se está promediando — igual de válido, solo con un intervalo variable.
let prevSample = null;

function readTotals() {
  const raw   = fs.readFileSync('/proc/net/dev', 'utf8');
  const lines = raw.trim().split('\n').slice(2); // salta las 2 líneas de encabezado
  let rxBytes = 0, txBytes = 0;
  for (const line of lines) {
    const [iface, rest] = line.split(':');
    if (!rest || iface.trim() === 'lo') continue; // excluye loopback
    const fields = rest.trim().split(/\s+/).map(Number);
    rxBytes += fields[0]; // bytes recibidos
    txBytes += fields[8]; // bytes enviados
  }
  return { rxBytes, txBytes };
}

function getNetworkStats() {
  try {
    const now    = Date.now();
    const totals = readTotals();

    if (!prevSample) {
      prevSample = { ...totals, timestamp: now };
      return { available: true, rxRate: 0, txRate: 0, rxTotal: totals.rxBytes, txTotal: totals.txBytes };
    }

    const elapsedSec = (now - prevSample.timestamp) / 1000;
    // Math.max(0, ...) por si un contador se reinicia (ej. interfaz reiniciada)
    const rxRate = elapsedSec > 0 ? Math.max(0, (totals.rxBytes - prevSample.rxBytes) / elapsedSec) : 0;
    const txRate = elapsedSec > 0 ? Math.max(0, (totals.txBytes - prevSample.txBytes) / elapsedSec) : 0;

    prevSample = { ...totals, timestamp: now };
    return {
      available: true,
      rxRate: Math.round(rxRate),
      txRate: Math.round(txRate),
      rxTotal: totals.rxBytes,
      txTotal: totals.txBytes,
    };
  } catch {
    // No es Linux, o /proc/net/dev no existe (ej. desarrollo en Windows)
    return { available: false };
  }
}

module.exports = { getNetworkStats };
