#!/usr/bin/env node
// Informe del watchdog: lee logs/watchdog.log y dice QUÉ pasó y CUÁNDO.
//
// Uso:
//   npm run watchdog:informe              → últimas 6 horas
//   npm run watchdog:informe -- --horas 24
//   npm run watchdog:informe -- --manana  → solo la franja de entrada (6 a 11) de cada día
//   npm run watchdog:informe -- --ahora   → solo el último chequeo, con su veredicto
//
// El diagnóstico vive en services/watchdogDiagnostico.js (testeado). Acá solo se lee el
// archivo y se imprime: si esto se rompe, no se pierde ningún criterio.
const fs   = require('fs');
const path = require('path');
const {
  parsearLinea, diagnosticar, tramos, resumirIncidentes,
} = require('../services/watchdogDiagnostico');

const LOG = process.env.WATCHDOG_LOG || path.join(__dirname, '..', 'logs', 'watchdog.log');

const args    = process.argv.slice(2);
const flag    = (n) => args.includes(n);
const valor   = (n, def) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const HORAS   = Number(valor('--horas', flag('--manana') ? 24 * 7 : 6));
const SOLO_AM = flag('--manana');
const AHORA   = flag('--ahora');

// Colores solo si la salida va a una terminal: redirigido a un archivo, los códigos ANSI
// lo vuelven ilegible (y este informe se pega en un chat o un ticket bastante seguido).
const tty = process.stdout.isTTY;
const c = {
  rojo:  (s) => tty ? `\x1b[31m${s}\x1b[0m` : s,
  verde: (s) => tty ? `\x1b[32m${s}\x1b[0m` : s,
  ama:   (s) => tty ? `\x1b[33m${s}\x1b[0m` : s,
  gris:  (s) => tty ? `\x1b[90m${s}\x1b[0m` : s,
  neg:   (s) => tty ? `\x1b[1m${s}\x1b[0m`  : s,
};
const ICONO = { ok: c.verde('✓'), aviso: c.ama('▲'), falla: c.rojo('✗') };
const hora  = (d) => d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dia   = (d) => d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });

if (!fs.existsSync(LOG)) {
  console.error(`\nNo existe ${LOG}\n`);
  console.error('¿Está instalado el cron?  crontab -l | grep watchdog');
  console.error('Prueba manual:            bash tools/watchdog.sh && tail -1 logs/watchdog.log\n');
  process.exit(1);
}

const desde = new Date(Date.now() - HORAS * 60 * 60 * 1000);
const mediciones = fs.readFileSync(LOG, 'utf8')
  .split('\n')
  .map(parsearLinea)
  .filter(m => m && m.fecha >= desde)
  // --manana: la franja de entrada de la escuela. El resto del día es ruido cuando lo que
  // se investiga es por qué a las 7 no se puede entrar.
  .filter(m => !SOLO_AM || (m.fecha.getHours() >= 6 && m.fecha.getHours() <= 11));

if (mediciones.length === 0) {
  console.log(`\nNo hay mediciones en el período pedido (${HORAS}h${SOLO_AM ? ', franja 6-11' : ''}).`);
  console.log(c.gris('Si el cron recién se instaló, esperá un minuto y volvé a probar.\n'));
  process.exit(0);
}

// ── --ahora: el último chequeo y nada más ───────────────────────────────────
if (AHORA) {
  const m = mediciones[mediciones.length - 1];
  const d = diagnosticar(m);
  console.log(`\n${ICONO[d.estado]} ${c.neg(d.resumen)}`);
  console.log(c.gris(`   ${dia(m.fecha)} ${hora(m.fecha)} · app=${m.app} (${m.t}s) · db=${m.db} · dns=${m.dns} · ext=${m.ext} · funnel=${m.funnel} · cupo=${m.cupo}`));
  if (d.accion) console.log(`   → ${d.accion}`);
  console.log();
  process.exit(d.estado === 'falla' ? 1 : 0);
}

// ── Informe completo ────────────────────────────────────────────────────────
const r = resumirIncidentes(mediciones);
const periodo = SOLO_AM ? `franja 6-11 h de los últimos ${Math.round(HORAS / 24)} días` : `últimas ${HORAS} h`;

console.log(`\n${c.neg('WATCHDOG')} — ${periodo}`);
console.log(c.gris(`${r.total} mediciones · desde ${dia(mediciones[0].fecha)} ${hora(mediciones[0].fecha)} hasta ${dia(mediciones[r.total - 1].fecha)} ${hora(mediciones[r.total - 1].fecha)}`));

const disp = r.disponibilidad;
const colorDisp = disp === 100 ? c.verde : (disp >= 99 ? c.ama : c.rojo);
console.log(`\nDisponibilidad: ${colorDisp(disp + '%')}   (${r.conFalla} mediciones con falla de ${r.total})`);

if (Object.keys(r.porCapa).length > 0) {
  console.log(`\n${c.neg('Dónde estuvo el problema')}`);
  Object.entries(r.porCapa).sort((a, b) => b[1] - a[1]).forEach(([capa, n]) => {
    // Un chequeo por minuto ⇒ cada medición fallada es aproximadamente un minuto caído.
    console.log(`  ${c.rojo(capa.padEnd(12))} ${String(n).padStart(4)} min`);
  });
}

// Los tramos son lo que se lee de verdad: un incidente es un rango de tiempo, no una línea.
const t = tramos(mediciones).filter(x => x.estado !== 'ok');
if (t.length === 0) {
  console.log(`\n${c.verde('Sin incidentes en el período.')}`);
  console.log(c.gris('Si alguien reportó que no andaba en esta franja, el problema NO está'));
  console.log(c.gris('ni en el servidor ni en el camino público: mirar la red de la escuela.\n'));
} else {
  console.log(`\n${c.neg('Incidentes')}`);
  t.forEach(x => {
    const rango = x.muestras === 1
      ? `${dia(x.desde)} ${hora(x.desde)}`
      : `${dia(x.desde)} ${hora(x.desde)}–${hora(x.hasta)} (${x.muestras} min)`;
    console.log(`\n${ICONO[x.estado]} ${c.neg(rango)}  ${c.gris('[' + x.capa + ']')}`);
    console.log(`  ${x.resumen}`);
    if (x.accion) console.log(`  → ${x.accion}`);
  });
  console.log();
}

// Cuando el problema es "a la mañana", esta tabla es la que lo demuestra o lo desmiente.
if (SOLO_AM || HORAS >= 24) {
  const porHora = {};
  mediciones.forEach(m => {
    const h = m.fecha.getHours();
    if (!porHora[h]) porHora[h] = { total: 0, falla: 0 };
    porHora[h].total++;
    if (diagnosticar(m).estado === 'falla') porHora[h].falla++;
  });
  console.log(`${c.neg('Fallas por hora del día')}`);
  Object.keys(porHora).map(Number).sort((a, b) => a - b).forEach(h => {
    const { total, falla } = porHora[h];
    const pct   = total > 0 ? falla / total : 0;
    const barra = '█'.repeat(Math.round(pct * 30));
    const etiq  = `${String(h).padStart(2, '0')}:00`;
    console.log(`  ${etiq} ${(falla ? c.rojo(barra) : c.gris('·'))} ${falla ? falla + '/' + total : c.gris('ok')}`);
  });
  console.log();
}
