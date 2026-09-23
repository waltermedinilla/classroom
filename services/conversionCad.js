// DWG → DXF con ODA File Converter — specs/correccion-de-entregas.spec.md, § I.
//
// No hay visor de DWG: hay un conversor. El plano se DIBUJA en el navegador del docente
// (dxf-viewer), y lo único que hace el servidor es producir un `.dxf` a partir del `.dwg`.
//
// ⚠️⚠️ DOS COSAS QUE HAY QUE SABER ANTES DE TOCAR ESTE ARCHIVO, porque las dos fallan de una
// manera que no se parece en nada al problema real:
//
//   1. En Linux, ODA se invoca SIEMPRE con `xvfb-run -a`. Llamarlo directo falla con
//      `libGL.so.1: cannot open shared object file`, que manda la investigación a buscar
//      drivers de video en un servidor que no tiene monitor. Es un error de "falta una
//      pantalla", no de OpenGL. (Y sin las librerías xcb da `Could not load the Qt platform
//      plugin "xcb"`: son ONCE paquetes más un symlink, ver § Dependencias de la spec.)
//
//   2. El CLI de ODA trabaja sobre CARPETAS, no sobre archivos sueltos: convierte TODO lo que
//      matchee el filtro en la carpeta de origen. Nunca se lo apunta a `archivos/entregas`
//      —con el recursivo en 1 o un filtro amplio se llevaría medio árbol de entregas a la
//      carpeta de destino—: la entrada es SIEMPRE una carpeta temporal recién creada, con
//      una copia del único archivo.
//
// El CAD NO usa la cola de Office, y no es un olvido (RN-18): una conversión cuesta 524 ms en
// el VPS contra los 1.080-3.696 ms de LibreOffice. Medio segundo se puede esperar mirando la
// pantalla; poner el plano detrás de una conversión de cuatro segundos que no tiene nada que
// ver con él, no. Lo que acota el CAD es el tope de entrada (RN-41), no una cola.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('../config/logger');

// En Linux el .deb deja DOS cosas: el binario estable y un directorio CON LA VERSIÓN ADENTRO
// que convive al lado (`/usr/bin/ODAFileConverter_27.1.0.0/`). Se usa el estable: apuntar al
// versionado funciona hoy y se rompe en silencio con la próxima actualización.
const RUTA_LINUX = '/usr/bin/ODAFileConverter';

// Versión de salida del DXF. ACAD2018 es el formato que leen las dos puntas del parque
// medido (12 archivos `AC1032` y uno `AC1024`: ODA leyó los dos sin chistar).
const VERSION_SALIDA = 'ACAD2018';

// 10 s: ~9× el PEOR caso medido (1.066 ms en el Windows de desarrollo, que es el doble de
// lento que el VPS). Se calibra contra la máquina lenta, no contra el número optimista.
const TIMEOUT_MS = 10 * 1000;

/**
 * Busca el .exe en Windows POR PATRÓN, nunca por la ruta con la versión adentro (RN-42c).
 *
 * `%LOCALAPPDATA%\Programs\ODA\ODAFileConverter <version>\ODAFileConverter.exe`. Se instala
 * bajo AppData y no bajo Program Files porque el MSI para toda la máquina falla con el error
 * 1925 (privilegios insuficientes) — o sea que la ruta versionada no es una rareza local:
 * es la única forma en que se puede instalar.
 *
 * `listarCarpetas` y `existeArchivo` son inyectables para poder fijar esto con un test sin
 * tocar el filesystem real.
 */
function buscarEnWindows({ localAppData, listarCarpetas, existeArchivo } = {}) {
  const base = localAppData && path.join(localAppData, 'Programs', 'ODA');
  if (!base) return null;
  const listar = listarCarpetas || ((dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
    catch { return []; }
  });
  const existe = existeArchivo || (p => fs.existsSync(p));

  // Con espacio en el patrón: `ODAFileConverter 27.1.0` sí, `ODAFileConverterOtraCosa` no.
  // El orden inverso hace que, con dos versiones instaladas, gane la más nueva por nombre.
  const candidatas = (listar(base) || [])
    .filter(nombre => /^ODAFileConverter /.test(nombre))
    .sort()
    .reverse();

  for (const nombre of candidatas) {
    const exe = path.join(base, nombre, 'ODAFileConverter.exe');
    if (existe(exe)) return exe;
  }
  return null;
}

/**
 * Dónde está ODA, o null. `ODA_FILE_CONVERTER_BIN` le gana a todo (mismo criterio que
 * BACKUP_*_BASE): es la salida para una instalación en un lugar raro sin tocar el código.
 */
async function detectarOda({ env, platform, localAppData, listarCarpetas, existeArchivo } = {}) {
  const e  = env || process.env;
  const so = platform || process.platform;
  const existe = existeArchivo || (p => fs.existsSync(p));

  if (e.ODA_FILE_CONVERTER_BIN) return e.ODA_FILE_CONVERTER_BIN;
  if (so === 'win32') {
    return buscarEnWindows({
      localAppData: localAppData || e.LOCALAPPDATA,
      listarCarpetas,
      existeArchivo,
    });
  }
  return existe(RUTA_LINUX) ? RUTA_LINUX : null;
}

// Detección cacheada de por vida del proceso, igual que detectarGs para Ghostscript
// (services/backupCompressor.js). El logger.info del arranque es el ÚNICO aviso de que un
// servidor nuevo se quedó sin conversor de planos: el deploy va a decir OK igual, va a
// contestar /health perfecto, y los planos van a caer al botón Descargar sin que nadie se
// entere hasta que alguien abra uno.
let promesaOda = null;
function oda() {
  if (!promesaOda) {
    promesaOda = detectarOda().then((bin) => {
      if (bin) {
        logger.info('ODA File Converter disponible para previsualizar planos', { bin });
      } else {
        logger.info('ODA File Converter no está instalado: los .dwg solo se van a poder descargar', {
          accion: 'ver § Dependencias de specs/correccion-de-entregas.spec.md (son 11 paquetes, un symlink y una descarga manual)',
        });
      }
      return bin;
    });
  }
  return promesaOda;
}

async function odaDisponible() {
  return (await oda()) !== null;
}

/** Solo para tests: obliga a re-detectar en la próxima llamada. */
function _resetOda() { promesaOda = null; }

/**
 * El comando, con `xvfb-run -a` en Linux SIEMPRE (RN-42e).
 * Orden de los argumentos de ODA: origen, destino, versión, formato, recursivo, auditar, filtro.
 */
function armarComandoOda({ platform, binario, argumentos }) {
  const args = argumentos || [];
  if (platform === 'linux') return { cmd: 'xvfb-run', args: ['-a', binario, ...args] };
  return { cmd: binario, args };
}

/**
 * Una carpeta nueva POR TRABAJO, bajo os.tmpdir(). No es cinturón y tiradores: el CAD no
 * tiene cola y PM2 corre 2 workers, así que dos conversiones simultáneas son el caso normal.
 * Con carpeta compartida, la segunda le levantaría el `out/` a la primera.
 */
function nuevaCarpetaDeTrabajo() {
  const dir = path.join(os.tmpdir(), 'classroom-cad-' + crypto.randomUUID());
  const dirIn  = path.join(dir, 'in');
  const dirOut = path.join(dir, 'out');
  fs.mkdirSync(dirIn,  { recursive: true });
  fs.mkdirSync(dirOut, { recursive: true });
  return { dir, dirIn, dirOut };
}

function errorCad(codigo, mensaje) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  return e;
}

/**
 * Convierte UN `.dwg` y deja el `.dxf` en `destino`.
 *
 * @param {string} rutaDwg   el archivo del alumno. NUNCA se lo toca: ODA trabaja sobre la
 *                           copia de la carpeta temporal (por eso auditar=1 es seguro).
 * @param {object} opts
 *   destino                 dónde queda el .dxf (normalmente la cache de archivos/derivados)
 *   binario                 saltea la detección
 *   ejecutar(cmd,args,cb)   inyectable; por defecto execFile con el timeout de RN-41
 *   nuevaCarpetaDeTrabajo   inyectable
 * @returns {Promise<{dxfPath: string}>}
 */
async function convertirDwgADxf(rutaDwg, opts = {}) {
  const ejecutar = opts.ejecutar || ((cmd, args, cb) =>
    execFile(cmd, args, { timeout: opts.timeoutMs || TIMEOUT_MS, windowsHide: true }, cb));

  // Quien inyecta su propio ejecutor no necesita que ODA esté instalado en esta máquina: lo
  // que se está corriendo entonces no es ODA. Sin binario y sin ejecutor no hay nada que
  // correr, y eso es `sin_conversor_cad`, no un error.
  const binario = opts.binario || (await detectarOda()) || (opts.ejecutar ? 'ODAFileConverter' : null);
  if (!binario) throw errorCad('SIN_CONVERSOR_CAD', 'No hay conversor de planos instalado');

  const armar = opts.nuevaCarpetaDeTrabajo || nuevaCarpetaDeTrabajo;
  const trabajo = armar();
  const destino = opts.destino
    || path.join(os.tmpdir(), path.basename(rutaDwg, path.extname(rutaDwg)) + '-' + crypto.randomUUID() + '.dxf');

  try {
    fs.copyFileSync(rutaDwg, path.join(trabajo.dirIn, path.basename(rutaDwg)));

    const { cmd, args } = armarComandoOda({
      platform: opts.platform || process.platform,
      binario,
      // recursivo=0 SIEMPRE y filtro acotado a la extensión exacta: los dos son lo que
      // impide que una carpeta de entrada equivocada se lleve puesto medio árbol.
      // auditar=1 repara al vuelo un DWG corrupto, que es un caso real de un alumno.
      argumentos: [trabajo.dirIn, trabajo.dirOut, VERSION_SALIDA, 'DXF', '0', '1', '*.DWG'],
    });

    await new Promise((resolve, reject) => {
      ejecutar(cmd, args, (err) => (err ? reject(err) : resolve()));
    });

    // Se busca CUALQUIER .dxf en out/ en vez de asumir el nombre: ODA lo deriva del archivo
    // de entrada y no hace falta atarse a cómo lo escribe.
    const salida = fs.readdirSync(trabajo.dirOut).find(n => /\.dxf$/i.test(n));
    if (!salida) throw errorCad('CONVERSION_FALLIDA', 'ODA no dejó ningún .dxf');

    fs.mkdirSync(path.dirname(destino), { recursive: true });
    // A un temporal y después rename: con 2 workers, dos conversiones del mismo archivo son
    // posibles, y un lector no puede encontrarse medio .dxf escrito.
    const parcial = destino + '.' + crypto.randomUUID() + '.parcial';
    fs.copyFileSync(path.join(trabajo.dirOut, salida), parcial);
    fs.renameSync(parcial, destino);
    return { dxfPath: destino };
  } finally {
    // También si la conversión falló o tiró timeout: la carpeta temporal tiene una copia del
    // trabajo de un alumno y no puede quedar tirada en /tmp.
    try { fs.rmSync(trabajo.dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  RUTA_LINUX,
  VERSION_SALIDA,
  TIMEOUT_MS,
  buscarEnWindows,
  detectarOda,
  odaDisponible,
  armarComandoOda,
  nuevaCarpetaDeTrabajo,
  convertirDwgADxf,
  _resetOda,
};
