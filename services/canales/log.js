// Proveedor de DESARROLLO: no manda nada, escribe el mensaje completo en un archivo.
//
// No es un mock de test. Es el modo en el que se desarrolla la feature de verdad: sin él, probar
// el flujo entero en local exigiría una cuenta de SMTP y un proveedor de SMS pago. Con él, se
// pide el código, se abre logs/verificacion-dev.log y se termina el flujo.
//
// ⚠️ POR ESO MISMO ESCRIBE SECRETOS EN CLARO AL DISCO, y por eso config/verificacion.js REVIENTA
// AL ARRANCAR si alguien deja este proveedor con NODE_ENV=production. La validación está allá y
// no acá a propósito: el error tiene que aparecer en el `pm2 reload`, no en el primer mail.
//
// Segunda guarda, redundante a propósito: este archivo también se niega a escribir en
// producción. Si alguna vez alguien saltea la validación de arranque (un require directo, un
// test mal armado), el peor caso es un envío fallido y no un archivo con códigos en claro.

const fs   = require('fs');
const path = require('path');

const logger  = require('../../config/logger');
const ARCHIVO = path.join(__dirname, '../../logs/verificacion-dev.log');

async function enviar({ destino, asunto, texto, canal }) {
  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false, id: null,
      error: 'el proveedor "log" escribe los códigos en claro y no puede usarse en producción',
    };
  }

  const bloque = [
    '─'.repeat(78),
    `${new Date().toISOString()}  canal=${canal}  →  ${destino}`,
    asunto ? `asunto: ${asunto}` : null,
    '',
    texto,
    '',
  ].filter((l) => l !== null).join('\n');

  try {
    fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
    fs.appendFileSync(ARCHIVO, bloque + '\n');
  } catch (err) {
    return { ok: false, id: null, error: `no se pudo escribir ${ARCHIVO}: ${err.message}` };
  }

  // También al log normal, sin el código: sirve para ver en la consola de nodemon que el envío
  // pasó, sin dejar el secreto en combined.log (que sí se conserva y se copia).
  logger.info(`[verificacion] (dev) mensaje de ${canal} para ${destino} escrito en logs/verificacion-dev.log`);

  return { ok: true, id: `dev-${Date.now()}`, error: null };
}

async function verificar() {
  return { ok: process.env.NODE_ENV !== 'production' };
}

module.exports = { enviar, verificar, ARCHIVO };
