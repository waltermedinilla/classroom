// `logDeRuta(err, req, contexto)` — lo que va dentro de un `catch` de ruta.
//
// ── El agujero que tapa ───────────────────────────────────────────────────────
// El patrón dominante del proyecto es:
//
//     } catch (err) { res.status(500).json({ error: 'Error del servidor' }); }
//
// Hay 82 así en routes/ y, hasta el 2026-08-11, NINGUNO logueaba nada. El `catch` atrapa la
// excepción, responde 500 y el stack se pierde para siempre: el manejador global de
// server.js nunca lo ve, porque la ruta ya respondió. El 11/08 esto tuvo consecuencias
// concretas — no se pudo ni confirmar ni descartar que el panel de superadmin estuviera
// fallando, porque su `catch` (routes/superadmin.js:61) se tragaba el error sin dejar rastro.
//
// El access log (middleware/request-log.js) ya registra que hubo un 500 y en qué ruta. Lo que
// SOLO se puede capturar acá adentro es la causa: el mensaje y el stack.
//
// ── Cómo usarlo ───────────────────────────────────────────────────────────────
//     } catch (err) {
//       logDeRuta(err, res);
//       res.status(500).json({ error: 'Error del servidor' });
//     }
//
// El tercer argumento es opcional y agrega lo que la ruta sepa y el log no pueda deducir
// (un id de curso, de sesión, el paso en el que estaba). No meter ahí datos personales ni
// contenido subido: el log se lee entero cuando algo falla.
//
// ── Por qué recibe `res` y no `req` ───────────────────────────────────────────
// Parece al revés (lo que se loguea es la REQUEST), y es deliberado. Estos 82 `catch` se
// migraron con un script, y `req` NO está garantizado en el alcance de todos: hay handlers
// y helpers que solo reciben `res`. Una llamada a un `req` inexistente sería un
// ReferenceError latente que recién explotaría el día que esa ruta falle — es decir, el
// logging rompería justo el caso que vino a diagnosticar.
//
// `res` sí está garantizado: la línea siguiente de cada uno de esos catch es `res.status(...)`.
// Y Express expone `res.req` en TODA request (express/lib/middleware/init.js:32), así que
// desde `res` se llega a la request sin depender de cómo se llamen los parámetros.
const logger = require('../config/logger');

function logDeRuta(err, res, contexto = {}) {
  const req = (res && res.req) || {};
  logger.error(`${req.method || '?'} ${req.path || '?'}`, {
    requestId: req.id || null,
    error:     err && err.message,
    stack:     err && err.stack,
    usuario:   res?.locals?.user?._id || null,
    ip:        req.ip,
    ...contexto,
  });
}

// Igual que el anterior pero para rechazos DELIBERADOS (400/403/409): no hay excepción ni
// stack, hay una decisión nuestra de no dejar pasar algo. Va en `warn` porque el servidor
// está sano — lo que importa es poder responder "¿por qué no me deja subir la foto?".
//
// El caso que lo motivó: la sala rechazaba los .heic de iPhone por extensión y respondía un
// 400 con `res.json(...)`. Al no lanzar excepción, no llegaba al manejador global y el log
// quedaba MUDO. El docente veía "no funcionó" y del lado del servidor no había nada que
// mirar. Un log vacío parecía "no pasó nada" cuando en realidad pasaba todo el tiempo.
function logRechazo(res, status, motivo, contexto = {}) {
  const req = (res && res.req) || {};
  logger.warn(`${req.method || '?'} ${req.path || '?'} ${status} — ${motivo}`, {
    requestId: req.id || null,
    status,
    motivo,
    usuario:   res?.locals?.user?._id || null,
    ip:        req.ip,
    ...contexto,
  });
}

module.exports = { logDeRuta, logRechazo };
