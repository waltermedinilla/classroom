// Envío de correo por SMTP, con nodemailer. Es el proveedor de producción del canal `email`.
//
// Sirve para cualquier servidor SMTP: Gmail con contraseña de aplicación (500 mails/día, que
// alcanza de sobra para 600 usuarios verificando de a tandas), Brevo (300/día gratis), Resend,
// el correo institucional de la escuela. Se cambia con 5 variables de entorno y sin tocar código
// — que es justamente el motivo por el que este archivo no sabe nada del proveedor concreto.

const nodemailer = require('nodemailer');
const logger     = require('../../config/logger');

// El transporte se crea UNA vez y se reusa: nodemailer mantiene un pool de conexiones y armarlo
// en cada mail agregaría el handshake TLS a cada envío. Perezoso (no al require) para que
// levantar el proceso sin SMTP configurado no falle acá — de eso se encarga la validación de
// arranque de config/verificacion.js, que da un error entendible.
let transporte = null;

function obtenerTransporte() {
  if (transporte) return transporte;

  transporte = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    // `secure: true` = TLS directo desde el saludo (puerto 465). `false` = STARTTLS (587), que
    // es lo normal hoy y lo que usan Gmail y Brevo. No significa "sin cifrar".
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth:   process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    // Un servidor SMTP lento no puede dejar colgada la request del usuario. 10s es holgado para
    // un handshake y corto comparado con el tiempo que alguien mira una pantalla en blanco.
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     20000,
  });

  return transporte;
}

async function enviar({ destino, asunto, texto, html }) {
  const info = await obtenerTransporte().sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to:      destino,
    subject: asunto,
    // Las dos versiones, siempre. Hay clientes que no muestran HTML, y el código de respaldo
    // tiene que estar en las dos o se pierde la mitad del sentido de mandarlo (ver D3).
    text:    texto,
    html,
  });

  // `accepted` vacío = el servidor tomó el mensaje pero no aceptó ningún destinatario. No es un
  // error de protocolo, así que nodemailer no tira: hay que mirarlo a mano o el usuario ve
  // "listo, te mandamos un mail" por algo que no salió.
  if (Array.isArray(info.accepted) && info.accepted.length === 0) {
    return { ok: false, id: info.messageId || null, error: 'el servidor SMTP no aceptó el destinatario' };
  }

  logger.info(`[verificacion] mail entregado al SMTP (${info.messageId})`);
  return { ok: true, id: info.messageId || null, error: null };
}

// Para tools/probar-canal.js: verifica credenciales y conectividad SIN mandarle un mail a nadie.
async function verificar() {
  await obtenerTransporte().verify();
  return { ok: true };
}

module.exports = { enviar, verificar };
