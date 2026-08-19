// Reportes de falla que el SERVIDOR no puede ver por su cuenta.
//
// ── Por qué existe ────────────────────────────────────────────────────────────
// El access log (middleware/request-log.js) contesta "qué respondió el servidor". Sirve para
// casi todo, y no sirve para nada cuando el problema es que la request **nunca llegó**: un
// intermediario que corta el cuerpo por tamaño, la conexión del aula que se cae a mitad de
// una subida de 3 MB, un timeout de proxy. En esos casos el docente ve un error, el log del
// servidor está impecable, y no hay forma de cruzar las dos cosas.
//
// Esta ruta es el otro extremo del cable: la cuenta lo que vio EL NAVEGADOR. El dato que más
// pesa es `enviados` vs `bytes` — cuántos bytes logró empujar el navegador antes de morir:
//
//   enviados < bytes  → se cortó EN CAMINO. Red del aula, Funnel, proxy, límite de cuerpo.
//                       No lo va a explicar ningún log de la app, porque nunca le llegó.
//   enviados = bytes  → subió entero y algo del lado del servidor lo rechazó. Ahí sí hay
//                       línea en combined.log, y `requestId` la encuentra directo.
//
// ── Cómo se usa cuando alguien reporta el problema ────────────────────────────
// El cartel de error muestra un código corto (SUB-XXXXXX). Con ese código:
//
//     node tools/ver-subida.js SUB-7F3A2C
//
// Si el código NO aparece, eso también dice algo: el navegador no pudo ni avisar.
//
// ── Sobre confiar en esto ─────────────────────────────────────────────────────
// Todo lo que entra acá lo escribe el cliente y por lo tanto es MENTIRA POSIBLE: se recorta,
// se castea y se encierra en una lista de valores conocidos antes de tocar el log. Un log
// que acepta strings sin límite desde el navegador es un log que cualquiera puede inundar
// para tapar otra cosa. Lo único que no viene del cliente —y es lo que hace útil el
// registro— es quién lo mandó: eso sale de la sesión.
const express   = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Motivos que el cliente puede declarar. Cualquier otra cosa se guarda como 'desconocido':
// no se confía en el string, pero tampoco se descarta el reporte por eso.
const MOTIVOS = ['red', 'timeout', 'http', 'abortada'];

const CODIGO_RE  = /^SUB-[0-9A-Z]{6}$/;
const MAX_TEXTO  = 300;   // recorte del cuerpo de la respuesta
const MAX_NOMBRE = 200;
const MAX_BYTES  = 5 * 1024 * 1024 * 1024; // techo absurdo a propósito: solo evita NaN/Infinity

const texto  = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const entero = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : undefined;
};

// Por USUARIO y no por IP: la escuela entera sale por una sola IP pública NAT, y si un aula
// se queda sin internet los 30 chicos reportan a la vez — que es JUSTO cuando más se quiere
// el dato. 30 por hora por persona alcanza de sobra para el uso real (nadie sube 30 archivos
// fallidos en una hora) y acota el daño de un bucle de reintentos en el cliente.
const diagLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  // Silencioso: el que reporta es el navegador, no una persona. Un 429 acá no tiene que
  // pintar nada en pantalla.
  message:         { ok: false },
});

// POST /diagnostico/subida — el navegador cuenta una subida que falló.
// Body: { codigo, ruta, motivo, status, statusText, requestId, respuesta,
//         archivo: { nombre, bytes, mime }, enviados, ms, intentos, conexion, pantalla }
router.post('/subida', requireAuth, diagLimiter, (req, res) => {
  const b = req.body || {};
  const codigo = texto(b.codigo, 20);
  if (!codigo || !CODIGO_RE.test(codigo)) {
    return res.status(400).json({ ok: false, error: 'Código inválido' });
  }

  const archivo  = b.archivo || {};
  const bytes    = entero(archivo.bytes, MAX_BYTES);
  const enviados = entero(b.enviados, MAX_BYTES);

  // El porcentaje se calcula acá y no en el cliente: es el primer número que se mira y no
  // puede depender de que el navegador lo haya hecho bien.
  const porcentaje = (bytes && enviados !== undefined)
    ? Math.round((enviados / bytes) * 100)
    : undefined;

  logger.warn('Subida fallida', {
    evento:     'subida_fallida',       // ← la marca para grepear
    codigo,
    // De la sesión, no del cliente.
    usuario:    res.locals.user?.email || req.userId,
    rol:        res.locals.user?.role,
    escuela:    res.locals.user?.school ? String(res.locals.user.school) : null,
    // Lo que dice el navegador.
    ruta:       texto(b.ruta, MAX_TEXTO),
    motivo:     MOTIVOS.includes(b.motivo) ? b.motivo : 'desconocido',
    status:     entero(b.status, 599),
    statusText: texto(b.statusText, 100),
    // Si vino, une este reporte con la línea del access log de la MISMA request.
    requestId:  texto(b.requestId, 60),
    respuesta:  texto(b.respuesta, MAX_TEXTO),
    archivo:    { nombre: texto(archivo.nombre, MAX_NOMBRE), bytes, mime: texto(archivo.mime, 100) },
    enviados,
    porcentaje,
    ms:         entero(b.ms, 24 * 60 * 60 * 1000),
    // Cuántos envíos se hicieron antes de rendirse (ver el reintento automático en
    // public/js/subida-diagnostico.js). Solo viene cuando hubo más de uno. El tope de 20 es
    // el mismo criterio que el de `status`: acota lo que puede escribir un cliente mentiroso
    // sin descartar el reporte por eso.
    //
    // ⚠️ Al leerlo: `ms` y `enviados` son del ÚLTIMO intento, no de los cuatro sumados.
    intentos:   entero(b.intentos, 20),
    conexion:   texto(b.conexion, 40),
    pantalla:   texto(b.pantalla, MAX_TEXTO),
    userAgent:  texto(req.get('user-agent'), MAX_TEXTO),
  });

  res.json({ ok: true });
});

module.exports = router;
