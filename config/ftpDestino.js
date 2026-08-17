const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Destino FTP al que el servidor EMPUJA el backup (ver services/backupFtp.js).
//
// Ojo con la dirección de la flecha, que es al revés de lo que suena: acá el servidor de
// la escuela es el CLIENTE FTP y la PC del dueño es la que tiene que estar corriendo un
// SERVIDOR FTP escuchando. Por eso lo que se guarda son las credenciales de una máquina
// ajena a este proyecto (típicamente la PC de casa, alcanzable por su IP o su nombre de
// Tailscale), y no las de este servidor.
//
// Persistido en disco y NO en memoria, por la misma razón que maintenance.json: en PM2
// cluster (2 workers) el disco se comparte entre procesos, la memoria no. Sin esto, guardar
// el destino en el worker que atendió el POST dejaría al otro worker sin saber a dónde mandar.
//
// La ruta se puede pisar con FTP_DESTINO_FILE. Es SOLO para los tests: sin eso, probar el
// guardado obligaría a escribir en la raíz del repo y le pisaría el destino real al dueño.
const DESTINO_FILE = process.env.FTP_DESTINO_FILE || path.join(__dirname, '../ftp-destino.json');

// Los tres modos que soporta basic-ftp, con el puerto que usa cada uno por convención.
//   plano           → FTP sin cifrar. Es lo que trae IIS FTP Server recién instalado.
//   ftps            → FTPS explícito: conecta en claro al 21 y sube a TLS con AUTH TLS.
//   ftps-implicito  → TLS desde el primer byte, puerto 990. Menos común, pero FileZilla
//                     Server lo ofrece y algunos NAS solo hablan esto.
const MODOS = ['plano', 'ftps', 'ftps-implicito'];
const PUERTO_POR_MODO = { plano: 21, ftps: 21, 'ftps-implicito': 990 };

const DIRECTORIO_DEFAULT = '/';

// ─────────────────────────────────────────────────────────────────────────────
// Cifrado de la contraseña guardada
// ─────────────────────────────────────────────────────────────────────────────

// La clave sale de JWT_SECRET, que ya existe y ya es el secreto del que depende toda la
// autenticación del sistema. Esto NO convierte el archivo en una bóveda: quien tenga
// acceso de root al servidor tiene las dos mitades. Lo que sí evita es el accidente
// probable — que la contraseña del FTP de casa termine en texto plano dentro de un
// backup, de un `cat` pegado en un chat o de un archivo copiado sin pensar. El repo ya
// tuvo un leak de credenciales por esa vía.
//
// Salt fijo a propósito: la clave tiene que poder re-derivarse en el otro worker de PM2 y
// después de cada reinicio. Lo que protege es el secreto, no el salt.
function claveDerivada() {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) return null;
  return crypto.scryptSync(secreto, 'classroom-ftp-destino', 32);
}

// Devuelve si este servidor está en condiciones de guardar contraseñas. Sin JWT_SECRET no
// se guarda ninguna: preferimos que el dueño la tipee cada vez antes que dejarla en claro.
function puedeGuardarPassword() {
  return !!process.env.JWT_SECRET;
}

function cifrar(texto) {
  const clave = claveDerivada();
  if (!clave) return null;
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const datos  = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), datos.toString('base64')].join(':');
}

// null si no se puede descifrar. El caso realista no es un ataque sino una rotación de
// JWT_SECRET: ahí el authTag de GCM no valida y hay que volver a tipear la contraseña.
// El caller tiene que distinguir ese null de "no había contraseña guardada".
function descifrar(guardado) {
  const clave = claveDerivada();
  if (!clave || typeof guardado !== 'string') return null;
  const [version, iv, tag, datos] = guardado.split(':');
  if (version !== 'v1' || !iv || !tag || !datos) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(datos, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización y validación de lo que tipea el dueño
// ─────────────────────────────────────────────────────────────────────────────

class DestinoInvalido extends Error {}

// Separa "host", "host:puerto", "[ipv6]:puerto" y también una URL pegada del explorador
// ("ftp://mi-pc.tailnet.ts.net/backups"). Pegar la URL entera es lo que uno hace sin
// pensar, así que conviene aceptarla en vez de devolver un error de formato.
function partirHostPuerto(crudo) {
  let s = String(crudo || '').trim();
  s = s.replace(/^ftps?:\/\//i, '');  // esquema pegado de la barra de direcciones
  s = s.replace(/\/.*$/, '');         // la carpeta tiene su propio campo, acá sobra

  // IPv6 entre corchetes, con o sin puerto: [fd7a:115c:a1e0::1]:21
  const conCorchetes = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (conCorchetes) return { host: conCorchetes[1], puerto: conCorchetes[2] || null };

  // IPv6 pelado (Tailscale reparte direcciones así): más de un ':' significa que no se le
  // puede separar el puerto sin ambigüedad, así que se toma entero como host.
  if ((s.match(/:/g) || []).length > 1) return { host: s, puerto: null };

  const [host, puerto] = s.split(':');
  return { host, puerto: puerto || null };
}

// Acepta IPv4, IPv6, nombres DNS comunes y los nombres de MagicDNS de Tailscale (tanto el
// corto "mi-pc" como el largo "mi-pc.tailc1c538.ts.net"). Rechaza lo que claramente no es
// un host para que el error salga acá y no como un ENOTFOUND críptico 15 segundos después.
function validarHost(host) {
  if (!host) throw new DestinoInvalido('Ingresá la IP o el nombre de la PC que va a recibir el backup');
  if (host.length > 253) throw new DestinoInvalido('El host es demasiado largo');
  if (!/^[a-zA-Z0-9._:-]+$/.test(host)) {
    throw new DestinoInvalido(`"${host}" no parece una IP ni un nombre de host válido`);
  }
  return host;
}

function validarPuerto(crudo, modo) {
  if (crudo === null || crudo === undefined || crudo === '') return PUERTO_POR_MODO[modo];
  const n = Number(crudo);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new DestinoInvalido(`Puerto inválido: "${crudo}" (tiene que ser un número entre 1 y 65535)`);
  }
  return n;
}

// La carpeta remota se normaliza a estilo Unix aunque del otro lado haya un Windows: el
// protocolo FTP habla con '/' sin importar el sistema de archivos que tenga el servidor.
// Un dueño que copia "C:\Backups" de su explorador tiene que poder pegarlo igual.
function normalizarDirectorio(crudo) {
  let d = String(crudo === undefined || crudo === null ? '' : crudo).trim();
  if (!d) return DIRECTORIO_DEFAULT;
  d = d.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  d = d.replace(/\/+$/, '');                 // sin barra final: ensureDir la agrega sola
  return d || DIRECTORIO_DEFAULT;
}

function validarModo(crudo) {
  const modo = String(crudo || 'plano').trim();
  if (!MODOS.includes(modo)) throw new DestinoInvalido(`Modo de conexión desconocido: "${crudo}"`);
  return modo;
}

// Convierte lo que llegó del formulario en un destino usable. NO incluye la contraseña:
// esa viaja aparte porque tiene otro ciclo de vida (se puede tipear sin guardar, o
// guardarse una vez y reusarse). Lanza DestinoInvalido con un mensaje en castellano.
function normalizarDestino(crudo = {}) {
  const modo = validarModo(crudo.modo);
  const { host, puerto: puertoEnHost } = partirHostPuerto(crudo.host);

  // El puerto pegado en el host ("mi-pc:2121") gana sobre el campo puerto solo si el campo
  // vino vacío: si el dueño llenó los dos, mandar el del campo sería ignorar lo que tipeó
  // más específicamente.
  const puertoCrudo = (crudo.puerto === '' || crudo.puerto === null || crudo.puerto === undefined)
    ? puertoEnHost
    : crudo.puerto;

  const usuario = String(crudo.usuario || '').trim();
  if (!usuario) throw new DestinoInvalido('Ingresá el usuario del servidor FTP');

  return {
    host:        validarHost(host),
    puerto:      validarPuerto(puertoCrudo, modo),
    usuario,
    modo,
    directorio:  normalizarDirectorio(crudo.directorio),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura y escritura del archivo
// ─────────────────────────────────────────────────────────────────────────────

function leerCrudo() {
  if (!fs.existsSync(DESTINO_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DESTINO_FILE, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null; // archivo corrupto o a medio escribir: se trata como "no hay destino"
  }
}

// El destino guardado SIN la contraseña. Es lo único que ve la pantalla: la contraseña no
// vuelve nunca al navegador, ni siquiera cifrada.
function leerDestino() {
  const crudo = leerCrudo();
  if (!crudo) return null;
  try {
    return { ...normalizarDestino(crudo), guardadoEn: crudo.guardadoEn || null };
  } catch {
    // Un archivo escrito a mano con algo inválido no puede dejar la pantalla rota.
    return null;
  }
}

// Tres respuestas distintas y las tres importan:
//   { hay: false }                  → nunca se guardó ninguna
//   { hay: true, password: '...' }  → guardada y descifrable
//   { hay: true, password: null }   → guardada pero ilegible (cambió JWT_SECRET)
function leerPassword() {
  const crudo = leerCrudo();
  if (!crudo || !crudo.passwordCifrada) return { hay: false, password: null };
  return { hay: true, password: descifrar(crudo.passwordCifrada) };
}

function tienePasswordGuardada() {
  return !!leerCrudo()?.passwordCifrada;
}

// `password` undefined = no tocar la que ya estaba. null o '' = borrarla.
function guardarDestino(crudo, { password } = {}) {
  const destino  = normalizarDestino(crudo);
  const anterior = leerCrudo();

  let passwordCifrada = anterior?.passwordCifrada || null;
  if (password !== undefined) {
    if (!password) {
      passwordCifrada = null;
    } else {
      passwordCifrada = cifrar(password);
      if (!passwordCifrada) {
        throw new DestinoInvalido(
          'No se puede guardar la contraseña porque falta JWT_SECRET en el servidor. ' +
          'Guardá el destino sin contraseña y tipeala cada vez.',
        );
      }
    }
  }

  const estado = { ...destino, passwordCifrada, guardadoEn: new Date().toISOString() };
  fs.writeFileSync(DESTINO_FILE, JSON.stringify(estado, null, 2));
  // Solo el dueño del proceso. En Windows es prácticamente un no-op y en algunos
  // filesystems montados puede fallar: que no se pueda endurecer no es motivo para
  // perder el destino que el dueño acaba de guardar.
  try { fs.chmodSync(DESTINO_FILE, 0o600); } catch { /* no crítico */ }

  return destino;
}

function olvidarDestino() {
  fs.rmSync(DESTINO_FILE, { force: true });
}

module.exports = {
  normalizarDestino,
  normalizarDirectorio,
  partirHostPuerto,
  leerDestino,
  leerPassword,
  tienePasswordGuardada,
  puedeGuardarPassword,
  guardarDestino,
  olvidarDestino,
  DestinoInvalido,
  MODOS,
  PUERTO_POR_MODO,
  DESTINO_FILE,
};
