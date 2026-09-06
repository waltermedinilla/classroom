// Catálogo ÚNICO de la verificación de contacto: los dos canales, sus límites, sus mensajes y
// qué proveedor los manda. Hermano de config/modulos.js y config/sections.js, y con la misma
// filosofía — una sola lista que leen la pantalla, la ruta y el envío.
//
// Ver specs/verificacion-de-contacto.spec.md.

const logger = require('./logger');

// ── Proveedores ──────────────────────────────────────────────────────────────
// Se eligen por variable de entorno y NO por escuela: son infraestructura del servidor. Qué
// escuela usa la feature lo decide el módulo `verificacion` de config/modulos.js.
//
// 'off' no es un error de configuración: es el estado normal del celular hasta que el dueño
// decida pagar un proveedor. Con el celular en off la feature igual funciona entera por el otro
// camino — la verificación asistida, donde el preceptor confirma el número que ya conoce
// (ver D6 de la spec). Por eso el default del celular es 'off' y el del correo no.
const PROVEEDOR_EMAIL   = (process.env.VERIF_EMAIL_PROVEEDOR   || 'off').toLowerCase();
const PROVEEDOR_CELULAR = (process.env.VERIF_CELULAR_PROVEEDOR || 'off').toLowerCase();

const PROVEEDORES_VALIDOS = {
  email:   ['smtp', 'log', 'off'],
  celular: ['whatsapp', 'twilio', 'log', 'off'],
};

// ── Límites ──────────────────────────────────────────────────────────────────
// Todos POR USUARIO, nunca por IP. Es la regla de la casa repetida en cada limiter de
// middleware/rate-limits.js: la escuela entera sale por una sola IP pública NAT (~300 personas),
// así que un límite por IP haría que los primeros 20 alumnos de la mañana dejaran a los otros
// 580 sin poder verificar.
//
// ⚠️ Con 2 workers de PM2 el techo REAL es el doble: express-rate-limit cuenta en memoria por
// proceso. Estos números son los de la config, no los efectivos.
const LIMITES = {
  // Reintentos legítimos (no llegó, fue a spam, se equivocó de número) sin financiarle a nadie
  // una campaña de SMS.
  enviosPorHora: 5,
  // Lo que corta el doble click, que es el 90% del "abuso" real. El botón se deshabilita con
  // cuenta regresiva.
  segundosEntreEnvios: 60,
  // Al sexto intento la verificación se quema y hay que pedir una nueva.
  intentosPorCodigo: 5,
  // Suficiente para ir a buscar el teléfono.
  minutosDeCodigo: 15,
  // El mail se lee a la noche.
  horasDeEnlace: 24,
  // La única red que evita que un error de código o un script suelto se convierta en una
  // factura. Al llegar al tope los envíos se rechazan y queda un warn en el log.
  topeDiarioPorEscuela: Number(process.env.VERIF_TOPE_DIARIO_ESCUELA || 300),
};

// ── Canales ──────────────────────────────────────────────────────────────────
// `usaEnlace` es la diferencia real entre los dos: el correo lleva enlace Y código en el mismo
// mail porque cada uno falla en un lugar distinto (ver D3); el celular lleva solo código,
// porque un enlace en un SMS es exactamente lo que se le enseña a la gente a no tocar.
const CANALES = {
  email: {
    id:        'email',
    label:     'Correo electrónico',
    campoDato: 'email',
    usaEnlace: true,
    proveedor: PROVEEDOR_EMAIL,
    vidaMinutos: LIMITES.horasDeEnlace * 60,
  },
  celular: {
    id:        'celular',
    label:     'Celular',
    campoDato: 'phoneE164',
    usaEnlace: false,
    proveedor: PROVEEDOR_CELULAR,
    vidaMinutos: LIMITES.minutosDeCodigo,
  },
};

// ¿Este canal puede mandar algo ahora mismo? Lo consultan la vista (para no dibujar un botón que
// no hace nada, que es peor que no tener el botón) y la ruta (para contestar 503 en vez de
// fingir que mandó).
const canalActivo = (canal) => Boolean(CANALES[canal]) && CANALES[canal].proveedor !== 'off';

// ── La URL pública ───────────────────────────────────────────────────────────
// El enlace del mail necesita una dirección absoluta, y hasta esta feature el proyecto NO tenía
// ninguna configuración con su propia URL (config/network.js son estadísticas de red, no
// direcciones): todo lo que la app genera son rutas relativas, que en un mail no sirven.
//
// ⚠️ NO se deriva de req.headers.host. Ese header lo controla el cliente, y un
// `Host: sitio-del-atacante` convertiría el mail de verificación en un phishing firmado por la
// escuela — el usuario recibe un correo legítimo, de la dirección de siempre, con un enlace que
// no es nuestro.
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

// Recibe el `user` aunque hoy lo ignore, a propósito: cuando exista la feature de dominios por
// escuela (specs/dominios-por-escuela.spec.md), el enlace tiene que salir con el hostname de la
// escuela de esa persona y APP_URL pasa a ser el respaldo. Escrito así, ese cambio es de una
// línea acá adentro y no una búsqueda por todo el proyecto.
function urlDeVerificacion(user, token) {
  // El prefijo es `/enlace/` y no `/email/`: con `/email/:token`, el path
  // `/verificacion/email/enviar` (pedir un código) matcheaba la ruta del enlace y devolvía HTML
  // donde el navegador esperaba JSON. Ver el comentario largo en routes/verificacion.js.
  return `${APP_URL}/verificacion/enlace/${token}`;
}

// ── Validación de arranque ───────────────────────────────────────────────────
// Se llama desde server.js. La idea es que un error de configuración se descubra en el
// `pm2 reload`, que es cuando se puede arreglar, y no con el primer mail que alguien pida.
function validarConfiguracion() {
  for (const [canal, def] of Object.entries(CANALES)) {
    if (!PROVEEDORES_VALIDOS[canal].includes(def.proveedor)) {
      throw new Error(
        `config/verificacion: proveedor "${def.proveedor}" desconocido para el canal ${canal}. ` +
        `Válidos: ${PROVEEDORES_VALIDOS[canal].join(', ')}`,
      );
    }
    // 'log' escribe el mensaje COMPLETO —código incluido— en logs/verificacion-dev.log. Es el
    // modo de desarrollo real (permite terminar el flujo entero en local sin cuenta de SMTP),
    // y por eso mismo en producción sería escribir secretos en claro al disco del servidor.
    if (def.proveedor === 'log' && process.env.NODE_ENV === 'production') {
      throw new Error(
        `config/verificacion: el proveedor "log" del canal ${canal} escribe los códigos en claro ` +
        'en logs/verificacion-dev.log y no puede usarse con NODE_ENV=production.',
      );
    }
  }

  // El enlace del correo es inservible sin URL absoluta, y peor que inservible: se mandaría un
  // mail con un enlace roto.
  if (canalActivo('email') && !APP_URL) {
    throw new Error(
      'config/verificacion: falta APP_URL en el .env y el canal de correo está activo. ' +
      'Es la URL pública de la plataforma, ej: https://169-58-248-255.sslip.io',
    );
  }
  if (APP_URL && !/^https?:\/\//.test(APP_URL)) {
    throw new Error(`config/verificacion: APP_URL tiene que empezar con http:// o https:// (es "${APP_URL}")`);
  }

  if (canalActivo('email') && CANALES.email.proveedor === 'smtp' && !process.env.SMTP_HOST) {
    throw new Error('config/verificacion: el proveedor de correo es "smtp" pero falta SMTP_HOST');
  }

  logger.info('[verificacion] canales: ' +
    Object.values(CANALES).map((c) => `${c.id}=${c.proveedor}`).join(' · '));
}

// ── Mensajes ─────────────────────────────────────────────────────────────────
// El texto vive acá y no en las rutas para poder cambiarlo sin tocar lógica. El mail va en HTML
// y en TEXTO PLANO, las dos: hay clientes que no muestran HTML, y el código de respaldo tiene
// que estar en las dos versiones o la mitad del sentido de mandarlo se pierde.
function mensajeEmail({ nombre, codigo, url, escuela }) {
  const firma  = escuela ? escuela.name : 'la plataforma de la escuela';
  const saludo = nombre ? `Hola ${nombre},` : 'Hola,';

  const texto = [
    saludo,
    '',
    `Para confirmar que este correo es tuyo, entrá a esta dirección:`,
    url,
    '',
    `O, si te resulta más cómodo, escribí este código en la pantalla donde lo pediste:`,
    `    ${codigo}`,
    '',
    `El enlace vale por ${LIMITES.horasDeEnlace} horas y el código por ${LIMITES.minutosDeCodigo} minutos.`,
    '',
    'Si no pediste esto, podés ignorar el mensaje: no se cambia nada en tu cuenta.',
    '',
    firma,
  ].join('\n');

  // Estilos inline y tabla-menos: los clientes de correo no soportan hojas de estilo externas ni
  // buena parte de flex/grid. Se mantiene simple a propósito.
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#202124;max-width:520px">
      <p>${saludo}</p>
      <p>Para confirmar que este correo es tuyo, tocá el botón:</p>
      <p style="margin:24px 0">
        <a href="${url}" style="background:#1a73e8;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:bold">Confirmar mi correo</a>
      </p>
      <p style="color:#5f6368;font-size:13px">Si el botón no funciona, copiá y pegá esta dirección:<br>
        <span style="word-break:break-all">${url}</span>
      </p>
      <p>O escribí este código en la pantalla donde lo pediste:</p>
      <p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace;margin:8px 0">${codigo}</p>
      <p style="color:#5f6368;font-size:13px">
        El enlace vale por ${LIMITES.horasDeEnlace} horas y el código por ${LIMITES.minutosDeCodigo} minutos.
      </p>
      <hr style="border:none;border-top:1px solid #dadce0;margin:24px 0">
      <p style="color:#5f6368;font-size:13px">
        Si no pediste esto, podés ignorar el mensaje: no se cambia nada en tu cuenta.
      </p>
      <p style="color:#5f6368;font-size:13px">${firma}</p>
    </div>`;

  return { asunto: `Confirmá tu correo — ${firma}`, texto, html };
}

function mensajeCelular({ codigo, escuela }) {
  const firma = escuela ? escuela.name : 'la escuela';
  return {
    // Sin enlace, a propósito. Y corto: un SMS se corta a los 160 caracteres.
    texto: `${firma}: tu código de verificación es ${codigo}. Vale por ${LIMITES.minutosDeCodigo} minutos.`,
  };
}

module.exports = {
  CANALES, LIMITES, APP_URL,
  canalActivo, urlDeVerificacion, validarConfiguracion,
  mensajeEmail, mensajeCelular,
};
