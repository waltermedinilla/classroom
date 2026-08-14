// Access log: una línea por request, con qué respondió y cuánto tardó.
//
// ── Por qué existe ────────────────────────────────────────────────────────────
// Hasta el 2026-08-11 el ÚNICO logging del proyecto era el manejador global de errores de
// server.js. Consecuencia: de una request que no lanzaba excepción no quedaba absolutamente
// nada. Ese día, con un docente reportando "el login se queda cargando", no había forma de
// contestar la pregunta más básica —¿el servidor respondió, con qué código y en cuánto
// tiempo?— y se fueron dos horas descartando red, DNS, Funnel, workers y base de datos a
// mano. Esta línea sola lo habría contestado en cinco segundos.
//
// Cubre además los 82 `catch (err) { res.status(500) }` de routes/ que no loguean nada: el
// nivel se decide por el status de la RESPUESTA, así que un 500 que la ruta se tragó en
// silencio igual queda registrado acá. Lo que no se puede recuperar desde afuera es el
// stack — para eso está `logDeRuta()` en middleware/route-log.js.
const crypto = require('crypto');
const logger = require('../config/logger');

// Rutas de alta frecuencia. Se registran SOLO si fallan: en régimen normal inundarían el
// archivo y lo volverían inútil, que es la forma más común de matar un log.
//
// El poll de la sala en vivo es el caso extremo: cada alumno pregunta cada POLL_MS
// (4 segundos), así que un aula de 30 chicos genera ~450 requests por minuto de una sola
// clase. `/health` lo consulta el propio script de deploy 20 veces por deploy.
// Los estáticos entran acá y no en un `return` temprano a propósito: un 404 de un .js o un
// 403 de un archivo subido SÍ interesan (fue el modo de falla del deploy a medias, donde el
// navegador pedía assets que el servidor viejo no tenía). Lo que no interesa es el 200.
const RUIDOSAS = [
  /^\/health$/,
  /\/sala\/poll$/,
  /^\/(css|js|img|fonts|archivos)\//,
  // Por EXTENSIÓN además de por carpeta: hay estáticos sueltos en la raíz de public/ que no
  // caen en ninguna de esas carpetas (`/Logo.jpg`, `/favicon.ico`) y se colaban al log.
  /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/i,
];

// Umbral de "esto tardó demasiado". Se registra en `warn` aunque haya respondido 200: una
// pantalla que tarda 8 segundos está rota para quien la usa, y hoy no dejaría ninguna
// huella. Es exactamente el escenario que no pudimos ni confirmar ni descartar el 11/08
// con el panel de superadmin.
const UMBRAL_LENTO_MS = 2000;

const esRuidosa = (path) => RUIDOSAS.some((re) => re.test(path));

function requestLog(req, res, next) {
  const inicio = process.hrtime.bigint();

  // Identificador para correlacionar TODAS las líneas de una misma request. Se devuelve en
  // el header para que un usuario pueda copiarlo de la pestaña Red de DevTools y con eso
  // solo se encuentre el problema, sin tener que reconstruir qué hizo y a qué hora.
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const ms     = Number(process.hrtime.bigint() - inicio) / 1e6;
    const status = res.statusCode;

    // HEAD es casi siempre una sonda (monitores, chequeos de disponibilidad, el preview de
    // desarrollo) y nunca una acción de una persona. Se detectó verificando esto mismo: el
    // preview local pegaba un `HEAD /` cada 200 ms y en un minuto el log no mostraba otra
    // cosa. Los HEAD que fallan sí se registran — ahí sí hay algo que mirar.
    if ((req.method === 'HEAD' || esRuidosa(req.path)) && status < 400) return;

    const lenta = ms >= UMBRAL_LENTO_MS;

    // 5xx es culpa nuestra; 4xx es una request que rebotó (validación, permiso, formato) y
    // sirve para responder "¿por qué no me deja?"; el resto es tráfico normal.
    //
    // Excepción: el 503 del modo mantenimiento es una decisión deliberada, no una falla.
    // Durante una ventana rebota TODA la plataforma, así que contarlo como error llenaría
    // error.log de alarmas falsas — se detectó en la corrida de smoke del 2026-08-11, donde
    // los tests de mantenimiento dejaron cuatro ERROR que no lo eran.
    let nivel = 'info';
    if (status >= 500 && !res.locals.mantenimiento) nivel = 'error';
    else if (status >= 400 || lenta) nivel = 'warn';

    logger.log(nivel, `${req.method} ${req.path} ${status}`, {
      requestId: req.id,
      metodo:    req.method,
      // `req.path` y NO `req.originalUrl` a propósito: la query string lleva secretos en
      // varias rutas (el token de /register/invite/:token, por ejemplo) y un log no es
      // lugar para eso. Si hiciera falta el detalle, va en la línea de la ruta, elegido.
      ruta:      req.path,
      status,
      ms:        Math.round(ms),
      usuario:   res.locals.user?._id || null,
      ip:        req.ip,
      ...(lenta ? { lenta: true } : {}),
    });
  });

  next();
}

module.exports = { requestLog, UMBRAL_LENTO_MS };
