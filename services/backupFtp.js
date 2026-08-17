const { Client } = require('basic-ftp');
const { Readable } = require('stream');
const logger = require('../config/logger');

// Empuje del backup por FTP/FTPS desde este servidor hacia una PC del dueño.
//
// LA DIRECCIÓN DE LA FLECHA ES LO PRIMERO QUE HAY QUE ENTENDER: FTP no tiene forma de
// "mandarle" un archivo a alguien que no esté escuchando. Acá el servidor de la escuela
// abre una conexión SALIENTE como cliente FTP contra un servidor FTP que tiene que estar
// corriendo en la PC de destino (IIS FTP Server, FileZilla Server, lo que sea). Si esa PC
// no tiene nada escuchando, no hay nada que este módulo pueda hacer: el error correcto es
// ECONNREFUSED y hay que decírselo al dueño con esas palabras, no con "error de red".
//
// Ese es también el motivo por el que traducimos los errores uno por uno más abajo. Un
// FTP contra una PC hogareña falla de maneras muy específicas y muy repetidas (firewall de
// Windows sobre los puertos de modo pasivo, MagicDNS apagado, credenciales del usuario de
// Windows en vez del usuario FTP), y el error crudo de la librería no orienta a nadie.

// Conexión de prueba: corta, porque el dueño está mirando la pantalla esperando. 15 s
// alcanzan de sobra por Tailscale y ya distinguen "no hay nadie" de "tarda".
const TIMEOUT_PRUEBA_MS = 15_000;

// Transferencia: generoso. No es el tiempo total del envío (que puede ser de una hora),
// es cuánto se tolera que el enlace quede COMPLETAMENTE quieto antes de darlo por muerto.
// basic-ftp reinicia el reloj con cada bloque que se mueve.
const TIMEOUT_TRANSFERENCIA_MS = 120_000;

// Nombre del archivo de prueba que deja y borra "Probar conexión". Empieza con punto para
// que no moleste a la vista en el explorador de la PC de destino si algo falla justo entre
// la subida y el borrado.
const ARCHIVO_PRUEBA = '.classroom-prueba-de-escritura';

// basic-ftp habla en su propio vocabulario ('implicit'); acá adentro los modos tienen los
// nombres que muestra la pantalla (ver config/ftpDestino.js).
function modoSeguro(modo) {
  if (modo === 'ftps')           return true;        // explícito: AUTH TLS sobre el 21
  if (modo === 'ftps-implicito') return 'implicit';  // TLS desde el primer byte, 990
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Traducción de errores
// ─────────────────────────────────────────────────────────────────────────────

// Los errores de FTP contra una PC de escritorio se repiten muchísimo y casi siempre se
// arreglan del lado de la PC, no del servidor. Devolver el mensaje crudo de la librería
// ("Error: connect ECONNREFUSED 100.64.1.5:21") obliga al dueño a buscarlo en internet
// cada vez; devolver qué revisar concretamente lo resuelve en el momento.
function mensajeDeError(err, destino = {}) {
  const donde  = `${destino.host || 'el host'}:${destino.puerto || 21}`;
  const codigo = err && err.code;
  const texto  = String((err && err.message) || err || '');

  if (codigo === 'ECONNREFUSED') {
    return `No hay ningún servidor FTP escuchando en ${donde}. La PC está prendida y accesible, `
         + 'pero nadie atiende ese puerto: revisá que el servidor FTP esté instalado y arrancado '
         + '(en Windows, que el servicio "Servicio de publicación FTP de Microsoft" esté iniciado).';
  }
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    return `No se pudo resolver el nombre "${destino.host}". Si es un nombre de Tailscale, `
         + 'revisá que MagicDNS esté activo en el tailnet; si no, probá directo con la IP '
         + '100.x.y.z que muestra Tailscale para esa PC.';
  }
  if (codigo === 'EHOSTUNREACH' || codigo === 'ENETUNREACH') {
    return `No hay ruta hasta ${donde}. Probablemente Tailscale esté caído en este servidor `
         + 'o en la PC de destino: verificá que las dos aparezcan conectadas en el panel de Tailscale.';
  }
  if (codigo === 'ETIMEDOUT' || /timeout/i.test(texto)) {
    return `${donde} no respondió a tiempo. El caso típico es el Firewall de Windows bloqueando `
         + 'la conexión entrante: hay que habilitar la regla "Servidor FTP (tráfico entrante)" '
         + 'o abrir el puerto a mano.';
  }
  if (codigo === 'ECONNRESET' || codigo === 'EPIPE') {
    return `La PC de destino cortó la conexión a mitad de camino (${donde}). Si venía transfiriendo, `
         + 'suele ser que se suspendió, se cerró Tailscale o se quedó sin espacio en disco.';
  }

  // Códigos de respuesta del propio protocolo FTP: acá ya hubo diálogo con el servidor.
  const ftp = typeof codigo === 'number' ? codigo : null;
  if (ftp === 530) {
    return 'El servidor FTP rechazó el usuario o la contraseña. Ojo: en IIS FTP el usuario no es '
         + 'necesariamente tu cuenta de Windows — si configuraste "Aislamiento de usuario" o un '
         + 'usuario FTP propio, va ese. Si es una cuenta de dominio, suele escribirse DOMINIO\\usuario.';
  }
  if (ftp === 550 || ftp === 553) {
    return `El servidor aceptó la sesión pero rechazó la carpeta "${destino.directorio || '/'}" o el `
         + 'archivo. Revisá que la carpeta exista, que el usuario FTP tenga permiso de ESCRITURA '
         + '(en IIS: Reglas de autorización → Leer y Escribir) y que no sea de solo lectura en Windows.';
  }
  if (ftp === 425 || ftp === 426 || /data connection/i.test(texto)) {
    return 'La sesión se abrió bien pero no se pudo abrir el canal de datos. Es el problema clásico del '
         + 'MODO PASIVO: además del puerto 21 hay que abrir en el firewall el rango de puertos pasivos '
         + 'y declararlo en el servidor FTP (en IIS: Compatibilidad con firewall FTP → rango de puertos '
         + 'del canal de datos, y la misma regla en el Firewall de Windows).';
  }
  if (ftp === 421) {
    return 'El servidor FTP cerró la sesión (421). Suele ser un límite de conexiones simultáneas o un '
         + 'timeout de inactividad configurado muy corto en el servidor de destino.';
  }
  if (ftp === 500 || ftp === 502 || /AUTH/i.test(texto)) {
    return 'El servidor no aceptó cifrar la conexión (AUTH TLS). Ese servidor FTP no tiene FTPS '
         + 'habilitado: elegí el modo "Sin cifrar" (el tráfico igual viaja cifrado dentro del túnel '
         + 'de Tailscale) o habilitá FTPS del lado del servidor.';
  }
  if (/wrong version number|SSL|certificate/i.test(texto)) {
    return 'Falló el handshake TLS. Si elegiste "FTPS implícito", probá con "FTPS explícito" (o al revés): '
         + 'implícito espera TLS desde el primer byte y explícito empieza en claro, y elegir el que no es '
         + 'da exactamente este error.';
  }

  return texto || 'Error desconocido al hablar con el servidor FTP';
}

// ─────────────────────────────────────────────────────────────────────────────
// Conexión
// ─────────────────────────────────────────────────────────────────────────────

async function conectar(destino, timeout) {
  const client = new Client(timeout);
  client.ftp.verbose = false;

  await client.access({
    host:     destino.host,
    port:     destino.puerto,
    user:     destino.usuario,
    password: destino.password || '',
    secure:   modoSeguro(destino.modo),
    // Los servidores FTP caseros usan casi siempre un certificado autofirmado, y validarlo
    // haría fallar el 100% de los casos reales de esta feature. Es una concesión aceptable
    // acá y solo acá: el camino entre las dos máquinas es el túnel de Tailscale, que ya
    // está cifrado y autenticado a nivel de red (WireGuard). El TLS del FTPS es una segunda
    // capa arriba de eso, no la única defensa.
    secureOptions: { rejectUnauthorized: false },
  });

  // '/' no necesita crearse y ensureDir sobre la raíz es un caso borde que no vale la pena
  // ejercitar: un cd directo es lo mismo y no puede fallar por permisos de creación.
  if (destino.directorio && destino.directorio !== '/') {
    await client.ensureDir(destino.directorio);
  } else {
    await client.cd('/');
  }

  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probar conexión
// ─────────────────────────────────────────────────────────────────────────────

// Prueba de verdad que se puede ESCRIBIR, no solo que se puede entrar. Poder loguearse y
// no poder escribir es un caso frecuentísimo (IIS crea el sitio FTP con permiso de solo
// lectura por defecto), y descubrirlo recién a los 800 MB de transferencia sería cruel.
async function probarConexion(destino) {
  const client = await conectar(destino, TIMEOUT_PRUEBA_MS);
  try {
    const carpeta = await client.pwd();

    await client.uploadFrom(Readable.from([Buffer.from('classroom backup test\n')]), ARCHIVO_PRUEBA);

    // Si el borrado falla, la escritura igual funcionó: eso es lo que se estaba probando.
    // Se avisa para que el dueño sepa que quedó un archivito suelto y no se asuste.
    let limpio = true;
    try {
      await client.remove(ARCHIVO_PRUEBA);
    } catch {
      limpio = false;
    }

    return { carpeta, escritura: true, limpio };
  } finally {
    client.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Envío del backup
// ─────────────────────────────────────────────────────────────────────────────

// Sube `origen` (un Readable: el .tar.gz saliendo del empaquetador, sin pasar por disco).
//
// Se sube con el nombre terminado en `.part` y se renombra al final. Es la misma idea que
// la respuesta chunked de GET /download: un envío cortado tiene que VERSE cortado. Sin
// esto, en la carpeta de destino quedaría un `.tar.gz` de tamaño plausible que solo se
// descubre incompleto el día que hace falta restaurarlo, que es el peor día posible.
async function enviarBackup({ destino, nombre, origen, onProgress, senal }) {
  const parcial = `${nombre}.part`;

  // Antes de conectar: armar el backup tarda, y en ese rato el dueño pudo haber cerrado la
  // pestaña. Abrir igual la sesión FTP sería molestar a la PC de destino para nada.
  if (senal && senal.aborted) throw new Error('Envío cancelado');

  const client = await conectar(destino, TIMEOUT_TRANSFERENCIA_MS);

  // Cerrar el cliente destruye los sockets, y eso hace que el uploadFrom en curso rechace.
  // Es la forma de cortar de verdad cuando el dueño cierra la pestaña: sin esto el servidor
  // seguiría empaquetando y subiendo 800 MB que ya nadie está esperando.
  const abortar = () => { try { client.close(); } catch { /* ya estaba cerrado */ } };
  if (senal) {
    if (senal.aborted) { abortar(); throw new Error('Envío cancelado'); }
    senal.addEventListener('abort', abortar, { once: true });
  }

  try {
    const carpeta = await client.pwd();

    if (onProgress) client.trackProgress(info => onProgress(info.bytes));
    await client.uploadFrom(origen, parcial);
    client.trackProgress(); // corta el seguimiento antes del rename

    await client.rename(parcial, nombre);

    return { carpeta, remoto: `${carpeta === '/' ? '' : carpeta}/${nombre}` };
  } finally {
    if (senal) senal.removeEventListener('abort', abortar);
    client.close();
  }
}

// Borra un `.part` que quedó de un envío fallido. Se hace en una conexión nueva a
// propósito: la anterior está rota (por eso falló), y si esto también falla no importa —
// el archivo parcial es visible y el dueño puede borrarlo a mano.
async function limpiarParcial(destino, nombre) {
  let client;
  try {
    client = await conectar(destino, TIMEOUT_PRUEBA_MS);
    await client.remove(`${nombre}.part`);
    return true;
  } catch (err) {
    logger.warn('backup FTP: no se pudo borrar el archivo parcial', { archivo: `${nombre}.part`, error: err.message });
    return false;
  } finally {
    if (client) client.close();
  }
}

module.exports = {
  probarConexion,
  enviarBackup,
  limpiarParcial,
  mensajeDeError,
  modoSeguro,
  TIMEOUT_PRUEBA_MS,
  TIMEOUT_TRANSFERENCIA_MS,
  ARCHIVO_PRUEBA,
};
