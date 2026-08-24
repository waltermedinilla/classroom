#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// GUARDIÁN DEL FUNNEL — mide el camino público UNA vez y, si está roto, lo repara solo.
//
// Pensado para correr por cron CADA MINUTO. Reemplaza al ritual manual de entrar por SSH y
// tipear a mano:
//     sudo tailscale funnel status
//     sudo tailscale funnel reset && sudo tailscale funnel --bg 3000
//     sudo tailscale funnel status
//
// Esos tres comandos son EXACTAMENTE los que corre `reparar()`, y su salida cruda queda en
// logs/funnel-guard-detalle.log para poder leerla después como si uno hubiera estado ahí.
//
// ── Lo que este script NO hace: resetear a ciegas ────────────────────────────
// El reset republica el registro DNS público, y esa propagación tardó 10-15 minutos el
// 2026-07-20. Resetear encima de una propagación en curso la reinicia desde cero: el nombre
// no se publicaría nunca y el sitio quedaría caído para siempre. Por eso se mide primero y
// se repara solo ante una falla confirmada, con enfriamiento. El criterio completo (y el
// modo `siempre`, que sí resetea en cada corrida) vive en services/funnelGuard.js.
//
// ── Regla de diseño ─────────────────────────────────────────────────────────
// Acá se MIDE y se EJECUTA. El criterio está en el servicio, que tiene tests. Si la decisión
// se calculara también acá, tarde o temprano las dos versiones se contradirían.
//
// ── Instalación (en el servidor, como root) ─────────────────────────────────
//   ( crontab -l 2>/dev/null; echo "* * * * * $(command -v node) /home/walter/classroom/tools/funnel-guard.js >/dev/null 2>&1" ) | crontab -
//
// ── Uso manual ──────────────────────────────────────────────────────────────
//   node tools/funnel-guard.js              → un chequeo (y repara si corresponde)
//   node tools/funnel-guard.js --simular    → mide y dice qué haría, sin tocar nada
//   node tools/funnel-guard.js --forzar     → repara ahora, sin preguntar
//   node tools/funnel-guard.js --estado     → resumen de las últimas horas
//
// ── Variables de entorno ────────────────────────────────────────────────────
//   FUNNEL_MODO=condicional|siempre   FUNNEL_COOLDOWN=10   FUNNEL_FALLAS=2
//   HOST_PUBLICO=...   PUERTO=3000   FUNNEL_GUARD_LOG=...
// ─────────────────────────────────────────────────────────────────────────────

const fs       = require('fs');
const path     = require('path');
const http     = require('http');
const https    = require('https');
const dns      = require('dns');
const { execFileSync } = require('child_process');

const {
  parsearLinea, evaluar, decidirAccion, resumir, CONFIG_DEFAULT,
} = require('../services/funnelGuard');

const APP_DIR      = process.env.APP_DIR      || path.join(__dirname, '..');
const PUERTO       = process.env.PUERTO       || '3000';
const HOST_PUBLICO = process.env.HOST_PUBLICO || 'classroom-4118.tailc1c538.ts.net';
const LOG          = process.env.FUNNEL_GUARD_LOG || path.join(APP_DIR, 'logs', 'funnel-guard.log');
const LOG_DETALLE  = LOG.replace(/\.log$/, '-detalle.log');

const CONFIG = {
  modo:              process.env.FUNNEL_MODO || CONFIG_DEFAULT.modo,
  cooldownMin:       Number(process.env.FUNNEL_COOLDOWN) || CONFIG_DEFAULT.cooldownMin,
  fallasParaReparar: Number(process.env.FUNNEL_FALLAS)   || CONFIG_DEFAULT.fallasParaReparar,
};

// Todo con timeout: esto corre cada minuto y NO puede quedarse colgado esperando a una capa
// rota — que es justo cuando más importa que deje su línea escrita.
const T_CORTO = 4000;
const T_LARGO = 8000;

const args    = process.argv.slice(2);
const flag    = (n) => args.includes(n);
const SIMULAR = flag('--simular');
const FORZAR  = flag('--forzar');
const ESTADO  = flag('--estado');

// ── Utilidades ───────────────────────────────────────────────────────────────

const ts = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
         `${signo}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
};

// Las últimas N líneas del log ya parseadas. De acá salen la racha de fallas y cuándo fue la
// última reparación: no hace falta un archivo de estado aparte que se pueda desincronizar.
function ultimosRegistros(n = 200) {
  if (!fs.existsSync(LOG)) return [];
  return fs.readFileSync(LOG, 'utf8').split('\n').slice(-n).map(parsearLinea).filter(Boolean);
}

// `tailscale` puede no estar en el PATH mínimo de cron, y si el guardián no corre como root
// necesita sudo. `sudo -n` no pregunta nunca: si no hay permiso falla al toque en vez de
// dejar el cron colgado esperando una contraseña que nadie va a tipear.
function comandoTailscale(argumentos) {
  const bin = ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']
    .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'tailscale';
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  return root ? [bin, argumentos] : ['sudo', ['-n', bin, ...argumentos]];
}

function correrTailscale(argumentos, timeout = T_CORTO) {
  const [cmd, listaArgs] = comandoTailscale(argumentos);
  try {
    const salida = execFileSync(cmd, listaArgs, {
      timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/bin:/usr/local/bin:/bin` },
    });
    return { ok: true, salida: (salida || '').trim() };
  } catch (err) {
    const detalle = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
    return { ok: false, salida: detalle || 'sin salida' };
  }
}

// ── Mediciones ───────────────────────────────────────────────────────────────

/** Capa 1: la app desde adentro. Es la medición de control. */
function medirApp() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PUERTO}/health`, { timeout: T_CORTO }, (res) => {
      res.resume();
      res.on('end', () => resolve(String(res.statusCode)));
    });
    req.on('timeout', () => { req.destroy(); resolve('000'); });
    req.on('error',   () => resolve('000'));
  });
}

/**
 * Capa 2: el DNS PÚBLICO. La medición que la aplicación no puede hacer sola.
 *
 * Se pregunta a 8.8.8.8 con un resolver propio y NO con el del sistema: el resolver del
 * sistema tiene MagicDNS de Tailscale enganchado y devuelve la IP interna 100.x, que daría
 * un falso OK (la trampa documentada del 2026-08-10). Si igual llega una respuesta en el
 * rango CGNAT se marca `local` y NO cuenta como prueba externa.
 */
function medirDns() {
  const resolver = new dns.promises.Resolver({ timeout: T_CORTO, tries: 1 });
  resolver.setServers(['8.8.8.8']);
  return resolver.resolve4(HOST_PUBLICO)
    .then((ips) => {
      const ip = (ips || [])[0];
      if (!ip) return { dns: 'nxdomain', ip: '' };
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return { dns: 'local', ip };
      return { dns: 'ok', ip };
    })
    .catch((err) => {
      // NXDOMAIN / NOTFOUND es EL síntoma del bug del Funnel. Cualquier otro error (timeout,
      // sin red) es una medición que no probó nada: se marca aparte para no resetear por él.
      const cod = err && err.code;
      if (cod === 'ENOTFOUND' || cod === 'ENODATA' || cod === 'NXDOMAIN') return { dns: 'nxdomain', ip: '' };
      return { dns: 'error', ip: '' };
    });
}

/**
 * Capa 3: el camino público completo. Se conecta a la IP que devolvió el DNS público, pero
 * presentando el nombre en SNI y en el Host — el equivalente del `curl --resolve`.
 *
 * Sin forzar la IP, una consulta al nombre desde el propio server sale por el túnel de
 * Tailscale y responde 200 aunque el Funnel esté roto para todo el mundo (la trampa del
 * incidente del 22/07). Así se recorre DNS público + edge de Tailscale + TLS de verdad.
 */
function medirExterno(ip) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tls = 0;
    const req = https.request({
      host: ip, port: 443, path: '/health', method: 'GET',
      servername: HOST_PUBLICO,               // SNI: sin esto el edge no sabe a quién sirve
      headers: { Host: HOST_PUBLICO, Connection: 'close' },
      timeout: T_LARGO,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ext: String(res.statusCode), tls: (tls / 1000).toFixed(2) }));
    });
    req.on('socket', (s) => s.on('secureConnect', () => { tls = Date.now() - t0; }));
    req.on('timeout', () => { req.destroy(); resolve({ ext: '000', tls: '0' }); });
    req.on('error',   () => resolve({ ext: '000', tls: '0' }));
    req.end();
  });
}

/**
 * Capa 4: qué dice el propio Funnel. Vale poco solo — en los tres incidentes decía
 * "Funnel on" con el proxy bien apuntado mientras el sitio estaba caído — pero un "off" SÍ
 * es concluyente, y distingue "se apagó" de "está prendido pero no enruta".
 */
function medirFunnel() {
  const r = correrTailscale(['funnel', 'status']);
  if (!r.ok && !r.salida) return 'n/d';
  if (/funnel on|https:\/\//i.test(r.salida)) return 'on';
  if (!r.ok) return 'n/d';
  return 'off';
}

// ── La reparación: los tres comandos, tal cual se hacían a mano ──────────────

function reparar(motivo) {
  const bloque = [];
  const anotar = (titulo, r) => bloque.push(`$ tailscale ${titulo}\n${r.salida || '(sin salida)'}`);

  const antes = correrTailscale(['funnel', 'status']);
  anotar('funnel status', antes);

  const reset = correrTailscale(['funnel', 'reset'], T_LARGO);
  anotar('funnel reset', reset);

  // Encadenado como el `&&` del comando manual: si el reset falló, republicar encima puede
  // dejar la configuración a medias.
  let bg = { ok: false, salida: 'no se ejecutó: el reset falló' };
  if (reset.ok) {
    bg = correrTailscale(['funnel', '--bg', PUERTO], T_LARGO);
    anotar(`funnel --bg ${PUERTO}`, bg);
  } else {
    bloque.push(`$ tailscale funnel --bg ${PUERTO}\n${bg.salida}`);
  }

  const despues = correrTailscale(['funnel', 'status']);
  anotar('funnel status', despues);

  const ok = reset.ok && bg.ok;

  // El detalle crudo va aparte del log de una línea por minuto: acá interesa poder leer la
  // salida completa de los comandos, como si uno hubiera estado en la sesión SSH.
  try {
    fs.appendFileSync(LOG_DETALLE,
      `\n════ ${ts()} — REPARACIÓN (${ok ? 'ok' : 'ERROR'}) ════\nMotivo: ${motivo}\n${bloque.join('\n\n')}\n`);
    const lineas = fs.readFileSync(LOG_DETALLE, 'utf8').split('\n');
    if (lineas.length > 4000) fs.writeFileSync(LOG_DETALLE, lineas.slice(-3000).join('\n'));
  } catch { /* si no se puede escribir el detalle, el chequeo igual tiene que seguir */ }

  return { ok, estadoDespues: despues.salida };
}

// ── Modo --estado: el informe de consola ─────────────────────────────────────

if (ESTADO) {
  // `fmt` y no toLocaleString: es la regla de la casa para cualquier fecha nueva, y acá no
  // es teórica — `toLocaleString('es-AR')` imprimía las 20:23 como "08:23" (es-AR devuelve
  // reloj de 12 h y el marcador a. m./p. m. se pierde). Se requiere adentro del `if` a
  // propósito: cargar el servicio cuesta ~0,7 s y el camino del cron no lo necesita.
  const { fmt } = require('../services/liveRoom');
  const horas = Number(args[args.indexOf('--horas') + 1]) || 6;
  const desde = new Date(Date.now() - horas * 3600 * 1000);
  const regs  = ultimosRegistros(20000).filter(r => r.fecha >= desde);
  const tty   = process.stdout.isTTY;
  const c     = { rojo: s => tty ? `\x1b[31m${s}\x1b[0m` : s, verde: s => tty ? `\x1b[32m${s}\x1b[0m` : s,
    gris: s => tty ? `\x1b[90m${s}\x1b[0m` : s, neg: s => tty ? `\x1b[1m${s}\x1b[0m` : s };

  if (regs.length === 0) {
    console.log(`\nNo hay chequeos en las últimas ${horas} h.`);
    console.log(c.gris(`Log: ${LOG}`));
    console.log(c.gris('¿Está el cron?  crontab -l | grep funnel-guard\n'));
    process.exit(0);
  }

  const r = resumir(regs);
  console.log(`\n${c.neg('GUARDIÁN DEL FUNNEL')} — últimas ${horas} h · ${r.total} chequeos`);
  console.log(`Disponibilidad del camino público: ${(r.disponibilidad === 100 ? c.verde : c.rojo)(r.disponibilidad + '%')}` +
              c.gris(`  (${r.conFalla} chequeos con falla ≈ ${r.conFalla} min)`));
  console.log(`Reparaciones automáticas: ${r.reparaciones}` +
              (r.ultimaReparacion ? c.gris(`  · última: ${fmt.fechaHora(r.ultimaReparacion)}`) : ''));
  if (r.errores) console.log(c.rojo(`⚠ ${r.errores} reparaciones fallaron al ejecutarse (ver ${LOG_DETALLE})`));

  const u = r.ultimo;
  console.log(`\nÚltimo chequeo: ${fmt.fechaHora(u.fecha)}`);
  console.log(`  ${u.estado === 'ok' ? c.verde('✓') : c.rojo('✗')} ${u.texto}`);
  console.log(c.gris(`  app=${u.app} dns=${u.dns} ext=${u.ext} funnel=${u.funnel}\n`));
  process.exit(u.estado === 'falla' ? 1 : 0);
}

// ── Chequeo (el camino normal del cron) ──────────────────────────────────────

(async () => {
  const app = await medirApp();
  const { dns: dnsEstado, ip } = await medirDns();
  const externo = dnsEstado === 'ok' ? await medirExterno(ip) : { ext: 'skip', tls: '0' };
  const funnel  = medirFunnel();

  const medicion = { app, dns: dnsEstado, dnsip: ip || 'none', ext: externo.ext, tls: externo.tls, funnel };
  const veredicto = evaluar(medicion);

  const previos = ultimosRegistros();
  let racha = veredicto.estado === 'falla' ? 1 : 0;
  if (veredicto.estado === 'falla') {
    for (let i = previos.length - 1; i >= 0 && previos[i].estado === 'falla'; i--) racha++;
  }
  const ultimaRep = [...previos].reverse().find(r => r.accion === 'reparar');
  const minutosDesdeReparacion = ultimaRep ? (Date.now() - ultimaRep.fecha.getTime()) / 60000 : null;

  const decision = FORZAR
    ? { accion: 'reparar', motivo: 'pedido manual (--forzar)' }
    : decidirAccion(veredicto, { fallasConsecutivas: racha, minutosDesdeReparacion, config: CONFIG });

  let resultado = '-';
  if (decision.accion === 'reparar') {
    if (SIMULAR) {
      resultado = 'simulado';
    } else {
      resultado = reparar(decision.motivo).ok ? 'ok' : 'error';
    }
  }

  const linea = `${ts()} app=${app} dns=${dnsEstado} dnsip=${ip || 'none'} ext=${externo.ext} ` +
                `tls=${externo.tls} funnel=${funnel} estado=${veredicto.estado} capa=${veredicto.capa} ` +
                `accion=${decision.accion} resultado=${resultado} fallas=${racha}`;

  if (SIMULAR) {
    console.log(linea);
    console.log(`→ ${veredicto.resumen}`);
    console.log(`→ acción: ${decision.accion} (${decision.motivo})`);
    process.exit(0);
  }

  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, linea + '\n');
    // Rotación simple: sin esto el archivo crece para siempre. Con un chequeo por minuto,
    // 20000 líneas son ~14 días. Mismo criterio que tools/watchdog.sh.
    const lineas = fs.readFileSync(LOG, 'utf8').split('\n');
    if (lineas.length > 20000) fs.writeFileSync(LOG, lineas.slice(-15000).join('\n'));
  } catch (err) {
    console.error(`funnel-guard: no se pudo escribir ${LOG}: ${err.message}`);
    process.exit(1);
  }

  // Código de salida útil dentro de otro script: 1 = el camino público está roto.
  process.exit(veredicto.estado === 'falla' ? 1 : 0);
})().catch((err) => {
  console.error(`funnel-guard: ${err.message}`);
  process.exit(1);
});
