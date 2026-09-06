// Envío por WhatsApp Cloud API (Meta). Proveedor OPCIONAL del canal `celular`.
//
// Está escrito y probado, pero llega APAGADO (VERIF_CELULAR_PROVEEDOR=off): encenderlo es una
// decisión de gasto del dueño, no una decisión técnica. Hasta que la tome, el canal del celular
// se cubre entero por el otro camino — la verificación asistida, donde el preceptor confirma el
// número que ya conoce (ver D6 de la spec).
//
// Se habla con `fetch` nativo de Node 22 y no con el SDK de Meta, por lo mismo que Twilio: es un
// POST con un JSON y un bearer token, y una dependencia menos es una dependencia menos que puede
// romper el arranque en un VPS que despliega por webhook.
//
// ⚠️ LO QUE HAY QUE SABER ANTES DE PRENDERLO: WhatsApp NO deja mandar texto libre a alguien que
// no escribió primero. Un código de verificación tiene que salir por una PLANTILLA de tipo
// «autenticación», aprobada de antemano por Meta, y esa plantilla tiene un formato fijo: un
// único parámetro, que es el código. Por eso este adaptador NO manda `texto` — manda el código
// solo, y el resto de la frase la pone la plantilla. El `texto` que arma config/verificacion.js
// se usa igual en el proveedor de SMS, donde sí es texto libre.

const logger = require('../../config/logger');

const VERSION_API = 'v21.0';

// De `texto` solo se necesita el código: es lo único que la plantilla acepta como parámetro.
// Se extrae en vez de recibirlo aparte para que la interfaz de todos los adaptadores siga
// siendo la misma (`enviar({ destino, texto })`) y el despachador no tenga que saber de esto.
function extraerCodigo(texto) {
  const m = String(texto || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

async function enviar({ destino, texto }) {
  const phoneId  = process.env.WA_PHONE_ID;
  const token    = process.env.WA_TOKEN;
  const plantilla = process.env.WA_PLANTILLA || 'codigo_verificacion';

  if (!phoneId || !token) {
    return { ok: false, id: null, error: 'faltan WA_PHONE_ID y/o WA_TOKEN en el .env' };
  }

  const codigo = extraerCodigo(texto);
  if (!codigo) {
    return { ok: false, id: null, error: 'no se encontró el código de 6 dígitos en el mensaje' };
  }

  // Meta quiere el número SIN el «+». El resto ya viene normalizado a E.164 por
  // services/telefonoAR.js, que es el que se ocupa del 15 y del 9 argentinos.
  const numero = String(destino).replace(/^\+/, '');

  const cuerpo = {
    messaging_product: 'whatsapp',
    to:   numero,
    type: 'template',
    template: {
      name:     plantilla,
      language: { code: 'es_AR' },
      components: [
        { type: 'body',   parameters: [{ type: 'text', text: codigo }] },
        // Las plantillas de autenticación llevan un botón de "copiar código", y Meta exige
        // repetir el parámetro también acá. Sin este bloque la API contesta 131008.
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: codigo }] },
      ],
    },
  };

  // AbortSignal.timeout: sin esto, una API que no contesta deja colgada la request del usuario
  // hasta el timeout del sistema operativo.
  const res = await fetch(`https://graph.facebook.com/${VERSION_API}/${phoneId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(cuerpo),
    signal:  AbortSignal.timeout(15000),
  });

  const datos = await res.json().catch(() => ({}));

  if (!res.ok) {
    // El mensaje de Meta es específico y sirve ("plantilla no aprobada", "número no registrado"),
    // así que se guarda tal cual en ContactVerification.envioError en vez de resumirlo.
    const detalle = datos?.error?.message || `HTTP ${res.status}`;
    return { ok: false, id: null, error: detalle };
  }

  const id = datos?.messages?.[0]?.id || null;
  logger.info(`[verificacion] WhatsApp aceptó el mensaje (${id})`);
  return { ok: true, id, error: null };
}

// Para tools/probar-canal.js: valida credenciales sin mandarle nada a nadie.
async function verificar() {
  const phoneId = process.env.WA_PHONE_ID;
  const token   = process.env.WA_TOKEN;
  if (!phoneId || !token) return { ok: false, error: 'faltan WA_PHONE_ID y/o WA_TOKEN' };

  const res = await fetch(`https://graph.facebook.com/${VERSION_API}/${phoneId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const datos = await res.json().catch(() => ({}));
    return { ok: false, error: datos?.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true };
}

module.exports = { enviar, verificar };
