// Criterio del guardián del Funnel: decide CUÁNDO hay que reparar el Tailscale Funnel y
// resume el historial para /superadmin/monitor.
//
// Vive acá y no adentro de tools/funnel-guard.js por la misma razón que
// services/watchdogDiagnostico.js: es la única parte con criterio, y el criterio hay que
// poder testearlo. El runner mide y ejecuta; acá se decide.
// Tests: tests/unit/funnelGuard.test.js
//
// ── Por qué el reset NO se dispara a ciegas en cada corrida ──────────────────
// `tailscale funnel reset` da de baja el registro público y `--bg 3000` lo vuelve a
// publicar. Esa republicación tardó 10-15 minutos el 2026-07-20 (y menos de 1 minuto el
// 2026-08-10). Un reset repetido a ciegas cada pocos minutos nunca dejaría terminar un
// ciclo de propagación lento: el nombre quedaría permanentemente sin publicar y el sitio
// caído para siempre — exactamente lo contrario de lo que el guardián viene a evitar.
// Además cada reset corta las conexiones TLS en curso.
//
// Por eso: se mide cada minuto, se repara SOLO cuando el camino público está roto, y
// después se espera el enfriamiento para dejar propagar.

const CONFIG_DEFAULT = {
  modo:              'condicional', // 'condicional' | 'siempre' (ver advertencia de arriba)
  cooldownMin:       10,            // minutos mínimos entre dos reparaciones
  // Con un chequeo por minuto, UNA medición fallada puede ser ruido: un paquete UDP perdido
  // camino a 8.8.8.8 o un timeout de 4 s en un minuto cargado. Un reset por un falso
  // positivo cuesta un corte real, así que se piden dos mediciones seguidas: cuesta 1 minuto
  // más de espera y descarta casi todo el ruido. Con FUNNEL_FALLAS=1 reacciona a la primera.
  fallasParaReparar: 2,
};

// Capas que un reset del Funnel puede arreglar. Si el problema está en otra, resetear no
// solo no sirve: agrega un corte encima de un sitio que ya está mal.
const CAPAS_REPARABLES = ['dns-funnel', 'funnel'];

/**
 * Parsea una línea del log del guardián:
 *   "2026-08-23T10:03:01-0300 app=200 dns=ok dnsip=1.2.3.4 ext=200 tls=0.21 funnel=on
 *    estado=ok capa=- accion=ninguna resultado=- fallas=0"
 *
 * Devuelve null si la línea está corrupta: un log truncado a mitad de escritura no puede
 * tumbar el panel entero (mismo criterio que services/watchdogDiagnostico.js).
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
  if (!campos.estado) return null; // sin veredicto la línea no aporta nada

  return {
    fecha,
    ...campos,
    fallas: Number(campos.fallas) || 0,
  };
}

/** Un código HTTP que significa "llegué y me contestaron bien". */
function codigoSano(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 200 && n < 400;
}

/**
 * El veredicto de UNA medición. Devuelve { estado, capa, resumen }.
 *
 * `estado`: 'ok' | 'falla' | 'indeterminado'
 * `capa`:   dónde está el problema, de adentro hacia afuera. El orden importa: si la app
 *           está caída, que el camino público no responda es CONSECUENCIA, no causa —
 *           y resetear el Funnel ahí sería tapar el síntoma equivocado.
 */
function evaluar(m) {
  if (!m) {
    return { estado: 'indeterminado', capa: 'medicion', resumen: 'Medición ilegible.' };
  }

  // ── Capa 1: la app, desde adentro. Es la medición de control ───────────────
  if (!codigoSano(m.app)) {
    return {
      estado: 'falla', capa: 'app',
      resumen: `La aplicación no responde en localhost (app=${m.app}). El Funnel no tiene la culpa.`,
    };
  }

  // ── Capa 2: el DNS público ────────────────────────────────────────────────
  // El modo de falla documentado del Funnel (20/07, 22/07, 10/08): el nombre deja de
  // resolver desde internet con el servidor perfectamente sano.
  if (m.dns === 'local') {
    // Respondió MagicDNS: la consulta no salió a internet, así que no prueba nada. No es
    // una falla del Funnel y NO habilita a resetear.
    return {
      estado: 'indeterminado', capa: 'medicion',
      resumen: 'El DNS respondió con una IP interna de Tailscale: la consulta no salió a internet.',
    };
  }
  if (m.dns === 'error') {
    return {
      estado: 'indeterminado', capa: 'medicion',
      resumen: 'No se pudo consultar el DNS público (¿el servidor se quedó sin salida a internet?).',
    };
  }
  if (m.dns !== 'ok') {
    return {
      estado: 'falla', capa: 'dns-funnel',
      resumen: 'La aplicación está sana, pero el nombre público NO RESUELVE desde internet.',
    };
  }

  // ── Capa 3: el camino público completo (DNS + edge de Tailscale + TLS) ────
  if (!codigoSano(m.ext)) {
    return {
      estado: 'falla', capa: 'funnel',
      resumen: `El nombre resuelve pero la conexión pública no completa (ext=${m.ext}).`,
    };
  }

  return { estado: 'ok', capa: '-', resumen: 'El camino público responde.' };
}

/**
 * La decisión. Devuelve { accion, motivo }.
 *
 * `accion`: 'ninguna'  → todo bien, no se toca nada
 *           'reparar'  → correr el reset del Funnel
 *           'esperar'  → hay falla pero todavía no corresponde tocar (racha o enfriamiento)
 *           'omitida'  → hay falla pero un reset no la arregla (la app, o medición inválida)
 *
 * ctx: { fallasConsecutivas, minutosDesdeReparacion (null si nunca), config }
 */
function decidirAccion(evaluacion, ctx = {}) {
  const cfg   = { ...CONFIG_DEFAULT, ...(ctx.config || {}) };
  const racha = Number(ctx.fallasConsecutivas) || 0;
  const desde = ctx.minutosDesdeReparacion;

  // Modo literal: resetear en cada corrida, pase lo que pase. Existe porque fue el pedido
  // original; la advertencia de la cabecera de este archivo explica por qué no es el default.
  if (cfg.modo === 'siempre') {
    return { accion: 'reparar', motivo: 'modo=siempre: se resetea en cada corrida' };
  }

  if (!evaluacion || evaluacion.estado === 'ok') {
    return { accion: 'ninguna', motivo: 'el camino público responde' };
  }

  if (evaluacion.estado === 'indeterminado') {
    return { accion: 'omitida', motivo: 'la medición no prueba que el Funnel esté roto' };
  }

  if (!CAPAS_REPARABLES.includes(evaluacion.capa)) {
    return { accion: 'omitida', motivo: `la falla es de la capa "${evaluacion.capa}": un reset no la arregla` };
  }

  if (racha < cfg.fallasParaReparar) {
    return { accion: 'esperar', motivo: `${racha} de ${cfg.fallasParaReparar} chequeos fallados seguidos` };
  }

  // Enfriamiento: republicar el nombre puede tardar hasta 15 minutos. Resetear encima de
  // una propagación en curso la reinicia desde cero y el nombre no se publica nunca.
  if (desde !== null && desde !== undefined && desde < cfg.cooldownMin) {
    return {
      accion: 'esperar',
      motivo: `se reparó hace ${Math.round(desde)} min: faltan ${Math.max(1, Math.ceil(cfg.cooldownMin - desde))} min de propagación`,
    };
  }

  return { accion: 'reparar', motivo: evaluacion.resumen };
}

/** Texto humano de un registro ya escrito en el log. Lo usan el CLI y el monitor. */
function describir(r) {
  if (!r) return 'Sin datos.';
  if (r.resultado === 'error') return 'Se intentó reparar el Funnel y el comando falló (¿permisos de sudo?).';
  if (r.accion === 'reparar')  return 'Se reparó el Funnel automáticamente.';
  if (r.accion === 'esperar')  return 'Falla detectada, esperando (racha o propagación en curso).';
  if (r.accion === 'omitida')  return 'Falla que un reset del Funnel no arregla.';
  return evaluar(r).resumen;
}

/**
 * Resumen del historial para el monitor.
 * `registros` son líneas ya parseadas, ordenadas por fecha ascendente.
 */
function resumir(registros) {
  const lista = (registros || []).filter(Boolean);
  const total = lista.length;

  if (total === 0) {
    return {
      total: 0, conFalla: 0, disponibilidad: null, reparaciones: 0,
      ultimaReparacion: null, ultimo: null, fallasSeguidas: 0, errores: 0,
    };
  }

  let conFalla = 0, reparaciones = 0, errores = 0, ultimaReparacion = null;
  lista.forEach(r => {
    if (r.estado === 'falla') conFalla++;
    if (r.accion === 'reparar') {
      reparaciones++;
      ultimaReparacion = r.fecha;
    }
    if (r.resultado === 'error') errores++;
  });

  // Racha actual: cuántos chequeos seguidos vienen fallando contando desde el final.
  let fallasSeguidas = 0;
  for (let i = lista.length - 1; i >= 0 && lista[i].estado === 'falla'; i--) fallasSeguidas++;

  const ultimo = lista[lista.length - 1];

  return {
    total,
    conFalla,
    // Un chequeo por minuto ⇒ cada medición fallada es aproximadamente un minuto caído.
    // Las mediciones indeterminadas NO cuentan como falla: no se puede afirmar que el sitio
    // estuviera caído si la medición misma no probó nada.
    disponibilidad: Math.round(((total - conFalla) / total) * 1000) / 10,
    reparaciones,
    ultimaReparacion,
    errores,
    fallasSeguidas,
    ultimo: {
      fecha:     ultimo.fecha,
      estado:    ultimo.estado,
      capa:      ultimo.capa,
      accion:    ultimo.accion,
      resultado: ultimo.resultado,
      dns:       ultimo.dns,
      ext:       ultimo.ext,
      funnel:    ultimo.funnel,
      app:       ultimo.app,
      texto:     describir(ultimo),
    },
  };
}

/**
 * Serie temporal para la franja del monitor: buckets CONTINUOS entre `desde` y `hasta`.
 *
 * Se rellenan acá y no en el navegador a propósito: un hueco de tres horas sin chequeos
 * (el cron caído, por ejemplo) tiene que verse como un hueco y no pegado al dato anterior.
 * Es la trampa que ya mordió en el gráfico del rate limit.
 */
function agregarSerie(registros, desde, hasta, bucketMin) {
  const ms      = Math.max(1, bucketMin) * 60 * 1000;
  const ini     = Math.floor(new Date(desde).getTime() / ms) * ms;
  const fin     = new Date(hasta).getTime();
  const buckets = new Map();

  for (let t = ini; t <= fin; t += ms) {
    buckets.set(t, { t: new Date(t), total: 0, fallas: 0, reparaciones: 0, estado: 'vacio' });
  }

  (registros || []).filter(Boolean).forEach(r => {
    const k = Math.floor(r.fecha.getTime() / ms) * ms;
    const b = buckets.get(k);
    if (!b) return;
    b.total++;
    if (r.estado === 'falla')   b.fallas++;
    if (r.accion === 'reparar') b.reparaciones++;
  });

  return [...buckets.values()].map(b => ({
    ...b,
    estado: b.total === 0 ? 'vacio'
      : b.fallas === 0 ? 'ok'
        : b.fallas === b.total ? 'falla' : 'parcial',
  }));
}

module.exports = {
  CONFIG_DEFAULT, CAPAS_REPARABLES,
  parsearLinea, evaluar, decidirAccion, describir, resumir, agregarSerie,
};
