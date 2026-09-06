// Envío de SMS por Twilio. Proveedor OPCIONAL del canal `celular`, y el respaldo universal:
// a diferencia de WhatsApp, un SMS llega a cualquier teléfono sin que la persona tenga la app
// ni haya escrito primero, y no necesita plantillas aprobadas.
//
// Llega APAGADO (VERIF_CELULAR_PROVEEDOR=off). En Argentina cada SMS ronda los USD 0,05: para
// 600 alumnos con reintentos es un gasto real para una escuela pública, y sostenerlo cada año
// con los ingresantes, más. Encenderlo es una decisión del dueño.
//
// Se habla con `fetch` nativo y no con el SDK de Twilio: es un POST con Basic Auth y un cuerpo
// de formulario. El SDK son 40 dependencias transitivas para eso.

const logger = require('../../config/logger');

const VERSION_API = '2010-04-01';

async function enviar({ destino, texto }) {
  const sid   = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const desde = process.env.TWILIO_FROM;

  if (!sid || !token || !desde) {
    return { ok: false, id: null, error: 'faltan TWILIO_SID, TWILIO_TOKEN y/o TWILIO_FROM en el .env' };
  }

  // Twilio SÍ quiere el «+» (a diferencia de Meta). `destino` ya viene en E.164 desde
  // services/telefonoAR.js.
  const cuerpo = new URLSearchParams({ To: destino, From: desde, Body: texto });

  const res = await fetch(`https://api.twilio.com/${VERSION_API}/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization:  'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body:   cuerpo,
    signal: AbortSignal.timeout(15000),
  });

  const datos = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Los mensajes de Twilio son específicos y accionables ("The 'To' number is not a valid
    // mobile number", "Permission to send an SMS has not been enabled for the region"), así que
    // se guardan tal cual en ContactVerification.envioError.
    return { ok: false, id: null, error: datos?.message || `HTTP ${res.status}` };
  }

  // ⚠️ Un 201 significa que Twilio ACEPTÓ el mensaje, no que llegó. `status` acá vale 'queued'
  // casi siempre; saber si se entregó de verdad exige un webhook de estado, que es otra feature
  // (y que no cambiaría nada para el usuario: el que verifica es él, poniendo el código).
  const id = datos?.sid || null;
  logger.info(`[verificacion] Twilio aceptó el SMS (${id}, estado ${datos?.status || '?'})`);
  return { ok: true, id, error: null };
}

// Para tools/probar-canal.js: pide la cuenta, que valida credenciales sin mandar nada.
async function verificar() {
  const sid   = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if (!sid || !token) return { ok: false, error: 'faltan TWILIO_SID y/o TWILIO_TOKEN' };

  const res = await fetch(`https://api.twilio.com/${VERSION_API}/Accounts/${sid}.json`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const datos = await res.json().catch(() => ({}));
    return { ok: false, error: datos?.message || `HTTP ${res.status}` };
  }
  return { ok: true };
}

module.exports = { enviar, verificar };
