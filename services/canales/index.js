// Despachador de los canales de salida. Es el ÚNICO lugar del proyecto que manda algo hacia
// afuera de la plataforma — hasta esta feature no había ninguno (no había nodemailer, ni SMTP,
// ni proveedor de SMS o WhatsApp en package.json).
//
// LA INTERFAZ ES UNA SOLA FUNCIÓN, y todos los adaptadores la cumplen:
//
//     async enviar({ destino, asunto, texto, html }) → { ok, id, error }
//
// Nunca THROWEA: un proveedor caído no puede hacer explotar la ruta que lo llamó. El
// `{ ok:false, error }` se guarda en la ContactVerification (campo `envioError`) para poder
// diagnosticar después una queja real —"no me llegó"— sin adivinar.
//
// Ver specs/verificacion-de-contacto.spec.md, D8.

const { CANALES } = require('../../config/verificacion');
const logger      = require('../../config/logger');

const smtp     = require('./smtp');
const whatsapp = require('./whatsapp');
const twilio   = require('./twilio');
const registro = require('./log');

// Qué adaptador atiende cada combinación. Un canal apagado ('off') ni siquiera figura acá: la
// ruta lo corta antes con un 503, y la vista no dibuja el botón.
const ADAPTADORES = {
  email:   { smtp, log: registro },
  celular: { whatsapp, twilio, log: registro },
};

/**
 * Manda un mensaje por el canal indicado.
 *
 * @param {'email'|'celular'} canal
 * @param {{destino:string, asunto?:string, texto:string, html?:string}} mensaje
 * @returns {Promise<{ok:boolean, id:string|null, error:string|null, proveedor:string}>}
 */
async function enviar(canal, mensaje) {
  const def = CANALES[canal];
  if (!def) {
    return { ok: false, id: null, error: `canal desconocido: ${canal}`, proveedor: 'ninguno' };
  }

  const proveedor = def.proveedor;
  const adaptador = ADAPTADORES[canal]?.[proveedor];

  if (!adaptador) {
    // Incluye el caso 'off'. Que llegue hasta acá es un bug de la ruta (tendría que haber
    // contestado 503 antes), así que se registra: es un botón que le prometió algo a alguien.
    logger.warn(`[verificacion] envío por ${canal} con proveedor "${proveedor}": no hay a quién pedírselo`);
    return { ok: false, id: null, error: `el canal ${canal} está apagado`, proveedor };
  }

  try {
    const r = await adaptador.enviar({ ...mensaje, canal });
    if (!r.ok) {
      logger.warn(`[verificacion] ${proveedor} rechazó un envío por ${canal}: ${r.error}`);
    }
    return { ok: r.ok, id: r.id || null, error: r.error || null, proveedor };
  } catch (err) {
    // Red caída, credencial vencida, DNS. No puede tumbar la request.
    logger.error(`[verificacion] ${proveedor} falló al mandar por ${canal}`, { error: err.message });
    return { ok: false, id: null, error: err.message, proveedor };
  }
}

module.exports = { enviar };
