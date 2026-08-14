// Diagnóstico del watchdog: convierte una medición cruda de tools/watchdog.sh en un
// VEREDICTO — qué capa falló y qué hacer al respecto.
//
// Vive acá y no adentro del .sh a propósito: es la única parte con criterio, y el criterio
// hay que poder testearlo. Si el veredicto se calculara también en bash, tarde o temprano
// las dos versiones dirían cosas distintas y no habría forma de saber cuál miente.
// Tests: tests/unit/watchdog.test.js
//
// El orden en que se evalúan las capas NO es arbitrario: va de adentro hacia afuera, porque
// una capa rota explica todas las de afuera. Si la app está caída, que el Funnel no enrute
// es una consecuencia, no la causa — y decir "es el Funnel" mandaría a mirar Tailscale
// cuando el problema está en el código.

// Umbral de "esto tardó demasiado". Igual criterio que UMBRAL_LENTO_MS de
// middleware/request-log.js: una pantalla de 2 segundos ya está rota para quien la usa.
const UMBRAL_LENTO_S = 2;

// Cupo restante por debajo del cual se avisa. No es "se rompió": es "queda poco y falta
// para que la ventana se reinicie".
const CUPO_ALERTA = 0.1; // 10% del límite

/**
 * Parsea una línea del watchdog: "2026-08-14T07:32:01-0300 app=200 t=0.04 db=ok ..."
 * Devuelve null si la línea está corrupta o incompleta — un log truncado a mitad de
 * escritura no puede tumbar el informe entero.
 */
function parsearLinea(linea) {
  if (!linea || typeof linea !== 'string') return null;
  const partes = linea.trim().split(/\s+/);
  if (partes.length < 2) return null;

  const fecha = new Date(partes[0]);
  if (isNaN(fecha.getTime())) return null;

  const campos = {};
  partes.slice(1).forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) campos[p.slice(0, i)] = p.slice(i + 1);
  });
  if (!campos.app) return null; // sin la medición de control la línea no sirve

  return { fecha, ...campos };
}

/** "3450/12000" → { restante: 3450, limite: 12000, fraccion: 0.2875 } */
function parsearCupo(valor) {
  if (!valor || !valor.includes('/')) return null;
  const [r, l] = valor.split('/');
  const restante = Number(r), limite = Number(l);
  if (!Number.isFinite(restante) || !Number.isFinite(limite) || limite <= 0) return null;
  return { restante, limite, fraccion: restante / limite };
}

/**
 * El veredicto. Devuelve { estado, capa, resumen, accion }.
 *
 * `estado`: 'ok' | 'aviso' | 'falla'
 * `capa`:   dónde está el problema, de adentro hacia afuera
 */
function diagnosticar(m) {
  if (!m) return { estado: 'falla', capa: 'medicion', resumen: 'Medición ilegible', accion: 'Revisar que tools/watchdog.sh esté corriendo y pueda escribir su log.' };

  const appCode = Number(m.app);
  const appTime = Number(m.t);

  // ── Capa 1: la app ────────────────────────────────────────────────────────
  // Es la medición de control. Si esto falla, todo lo de afuera es consecuencia.
  if (!Number.isFinite(appCode) || appCode === 0 || appCode >= 500) {
    // Con la app caída, saber si además NO hay procesos afina el diagnóstico y la acción:
    // "los workers se murieron" y "los workers están pero la app devuelve 500" se arreglan
    // distinto.
    if (m.workers !== undefined && Number(m.workers) === 0) {
      return {
        estado: 'falla', capa: 'workers',
        resumen: 'No hay ningún worker de Node corriendo y la aplicación no responde.',
        accion: 'sudo -u walter -H pm2 list  (si sale vacío como root, es que mira /root/.pm2: usar siempre `sudo -u walter`)',
      };
    }
    return {
      estado: 'falla', capa: 'app',
      resumen: `La aplicación no responde en localhost (código ${m.app}).`,
      accion: 'Mirar logs/error.log y `pm2 list`. Esto SÍ es un problema del servidor o del código.',
    };
  }

  // Ojo: NO se evalúa `workers` cuando la app respondió. Si /health devolvió 200, hay
  // workers por definición — un `workers=0` en esa situación significa que falló la
  // MEDICIÓN (falta pgrep, o el proceso corre con otra línea de comandos), no que el
  // servidor esté caído. Reportarlo como falla convertiría a la herramienta en una fuente
  // de alarmas falsas, que es la forma más rápida de que se la deje de mirar.

  // ── Capa 2: la base ───────────────────────────────────────────────────────
  if (m.db && m.db !== 'ok' && m.db !== '?') {
    return {
      estado: 'falla', capa: 'mongo',
      resumen: `La aplicación responde pero la base está "${m.db}".`,
      accion: 'sudo docker ps | grep mongodb; sudo docker start mongodb',
    };
  }
  // El contenedor solo se juzga si la app NO confirmó la base. Misma regla que con los
  // workers: `db:"ok"` sale de una consulta real a Mongo, así que gana sobre un `docker ps`
  // que puede fallar por permisos, por un nombre de contenedor distinto o porque Mongo no
  // corre en Docker. La medición directa manda sobre la indirecta.
  if (m.mongo === 'down' && m.db !== 'ok') {
    return {
      estado: 'falla', capa: 'mongo',
      resumen: 'El contenedor de MongoDB no está arriba.',
      accion: 'sudo docker start mongodb',
    };
  }

  // ── Capa 3: el DNS público ────────────────────────────────────────────────
  // La app está sana y aun así nadie llega: acá empieza lo que es invisible desde adentro.
  // Es el modo de falla que ya se repitió tres veces (20/07, 22/07, 10/08).
  if (m.dns === 'nxdomain') {
    return {
      estado: 'falla', capa: 'dns-funnel',
      resumen: 'La aplicación está sana, pero el nombre público NO RESUELVE desde internet. Nadie puede llegar al sitio.',
      accion: 'tailscale funnel reset && tailscale funnel --bg 3000  (ya pasó el 20/07, 22/07 y 10/08; propaga en 1-15 min)',
    };
  }

  // ── Capa 4: el camino público (TLS / edge de Tailscale) ───────────────────
  // El nombre resuelve pero la conexión no completa: es el incidente 2 (22/07), donde el
  // DNS estaba perfecto y el handshake TLS se caía. Mismo arreglo.
  if (m.ext && m.ext !== 'skip') {
    const extCode = Number(m.ext);
    if (!Number.isFinite(extCode) || extCode === 0) {
      return {
        estado: 'falla', capa: 'funnel',
        resumen: 'El nombre resuelve, pero la conexión por el camino público no completa. La aplicación está sana adentro.',
        accion: 'tailscale funnel reset && tailscale funnel --bg 3000',
      };
    }
    if (extCode >= 500) {
      return {
        estado: 'falla', capa: 'funnel',
        resumen: `El camino público devuelve ${extCode} mientras la aplicación responde bien en localhost.`,
        accion: 'Revisar el proxy del Funnel: tailscale funnel status',
      };
    }
  }

  if (m.funnel === 'off') {
    return {
      estado: 'falla', capa: 'funnel',
      resumen: 'El Funnel está apagado: el sitio no se publica hacia internet.',
      accion: 'tailscale funnel --bg 3000',
    };
  }

  // ── Capa 5: el cupo ───────────────────────────────────────────────────────
  // No deja el sitio en blanco (eso sería DNS/Funnel): devuelve "Demasiadas peticiones".
  // Por eso va después, y es aviso y no falla hasta que efectivamente llega a cero.
  const cupo = parsearCupo(m.cupo);
  if (cupo && cupo.restante === 0) {
    return {
      estado: 'falla', capa: 'cupo',
      resumen: 'El cupo del rate limit está AGOTADO: todos reciben "Demasiadas peticiones".',
      accion: 'Subir `max` del generalLimiter en server.js. Ver la sección Rate limit de /superadmin/monitor.',
    };
  }
  if (cupo && cupo.fraccion < CUPO_ALERTA) {
    return {
      estado: 'aviso', capa: 'cupo',
      resumen: `Queda ${Math.round(cupo.fraccion * 100)}% del cupo (${cupo.restante} de ${cupo.limite}).`,
      accion: 'Vigilar: si llega a cero, el sitio empieza a rebotar peticiones.',
    };
  }

  // ── Capa 6: lentitud ──────────────────────────────────────────────────────
  if (Number.isFinite(appTime) && appTime >= UMBRAL_LENTO_S) {
    return {
      estado: 'aviso', capa: 'rendimiento',
      resumen: `La aplicación responde pero tarda ${appTime}s.`,
      accion: 'Ver carga y memoria en la misma línea; cruzar con las requests lentas de logs/combined.log.',
    };
  }

  // ── Todo bien ─────────────────────────────────────────────────────────────
  // Vale la pena leer este caso con cuidado: si el usuario reporta que no anda y el
  // watchdog dice OK en ese minuto, el problema NO está ni en el servidor ni en el camino
  // público. Queda la red de la escuela o el dispositivo — y eso también es un diagnóstico.
  const notas = [];
  if (m.dns === 'local') notas.push('el DNS respondió por MagicDNS: no se pudo verificar de cara a internet (falta `apt install dnsutils`)');
  if (m.dns === 'n/d')   notas.push('sin dig/nslookup instalado: no se está verificando el DNS público');

  return {
    estado: 'ok', capa: null,
    resumen: 'Todas las capas responden.',
    accion: notas.length ? notas.join('; ') : null,
  };
}

/**
 * Agrupa una tanda de mediciones en TRAMOS de estado continuo.
 *
 * Es lo que convierte 1440 líneas por día en algo legible: "de 07:31 a 08:07 el DNS público
 * estuvo caído mientras la app respondía". Un incidente es un tramo, no una línea suelta.
 */
function tramos(mediciones) {
  const salida = [];
  (mediciones || []).forEach(m => {
    const d = diagnosticar(m);
    const ultimo = salida[salida.length - 1];
    if (ultimo && ultimo.estado === d.estado && ultimo.capa === d.capa) {
      ultimo.hasta = m.fecha;
      ultimo.muestras++;
    } else {
      salida.push({
        estado: d.estado, capa: d.capa, resumen: d.resumen, accion: d.accion,
        desde: m.fecha, hasta: m.fecha, muestras: 1,
      });
    }
  });
  return salida;
}

/** Resumen del período: cuánto tiempo estuvo cada capa fallando. */
function resumirIncidentes(mediciones) {
  const lista = (mediciones || []);
  const total = lista.length;
  const porCapa = {};
  let conFalla = 0;

  lista.forEach(m => {
    const d = diagnosticar(m);
    if (d.estado === 'falla') {
      conFalla++;
      porCapa[d.capa] = (porCapa[d.capa] || 0) + 1;
    }
  });

  return {
    total,
    conFalla,
    disponibilidad: total > 0 ? Math.round(((total - conFalla) / total) * 1000) / 10 : null,
    porCapa,
  };
}

module.exports = {
  parsearLinea, parsearCupo, diagnosticar, tramos, resumirIncidentes,
  UMBRAL_LENTO_S, CUPO_ALERTA,
};
