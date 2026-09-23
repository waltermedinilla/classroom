// Office → PDF con LibreOffice — specs/correccion-de-entregas.spec.md, RN-16.
//
// Es el paso 2 de la cadena de previsualización (RN-13): Microsoft primero, LibreOffice si
// Microsoft no llegó, botón Descargar si tampoco hay LibreOffice. Cada caída es automática y
// hacia adelante: ningún paso puede dejar la pantalla en blanco esperando.
//
// ⭐ LO QUE CAMBIÓ LA MEDICIÓN (2026-09-21): no hay calentamiento. La segunda conversión
// seguida del mismo .docx NO fue más rápida que la primera (3.696 ms contra 3.525), porque
// cada `--convert-to` levanta un proceso nuevo y el arranque de LibreOffice se paga ENTERO
// cada vez. De ahí salen las dos decisiones de este archivo:
//
//   · la cache no es una optimización, es la pieza central — y no se invalida nunca, porque
//     el `filename` de una entrega es único por subida: cada archivo se convierte UNA sola
//     vez en su vida;
//   · la conversión arranca cuando el docente ABRE al alumno, no cuando hace clic en el
//     archivo. Los segundos transcurren mientras lee el panel.
//
// La cola es de a UNO, y es solo para Office: el CAD no la usa (RN-18, services/conversionCad.js).
// ⚠️ El techo real son 2 conversiones simultáneas y no 1, porque PM2 corre en cluster con 2
// workers y esta cola vive en la memoria de cada uno. Es la misma corrección que ya estaba
// anotada para el rate limit.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const logger = require('../config/logger');

// Tope de archivo y de tiempo. Los 45 s no son "mucho": son el arranque de LibreOffice más
// un documento grande.
const MAX_BYTES  = 15 * 1024 * 1024;
const TIMEOUT_MS = 45 * 1000;

// Cuántos pedidos REALES pueden estar esperando a que se libere la cola. El que no entra
// recibe 409 CONVERSION_EN_CURSO y su pantalla muestra "Estamos preparando la vista previa…".
const MAX_EN_ESPERA = 5;

// El binario es del SISTEMA, no una dependencia de npm: se detecta una sola vez y se cachea
// en una promesa, exactamente como backupCompressor.js hace con Ghostscript. Si no está, el
// paso 2 no existe y la cadena cae al 3 sin un solo error.
//
// En Windows `soffice` casi nunca está en el PATH (el instalador no lo agrega), así que las
// rutas conocidas van como candidatas más. En Linux alcanza con el nombre.
// ⚠️ EN WINDOWS VA `soffice.com`, NO `soffice.exe`. Los dos existen, uno al lado del otro, y
// el `.exe` es el lanzador GRÁFICO: `soffice.exe --version` **no imprime nada y se cuelga
// hasta el timeout** (medido: 15 s y stdout vacío). Con el `.exe` la detección concluía
// siempre "LibreOffice no está instalado" y TODA la cadena de Office caía al botón Descargar,
// en una máquina donde LibreOffice estaba instalado y convertía perfecto.
//
// El `.com` es el binario de consola: imprime la versión y termina (medido: 355 ms). También
// sirve para convertir, y de hecho es preferible porque espera a que la conversión termine
// en vez de soltar el proceso.
//
// El modo de falla era de los caros: en Linux `soffice --version` anda bien, así que esto
// fallaba SOLO en la máquina de desarrollo. Se veía roto donde se verifica y andaba en
// producción — el orden exacto para no enterarse nunca de por qué.
//
// `soffice.com` a secas queda primero por si alguna vez está en el PATH (el instalador no lo
// agrega, pero no cuesta nada intentarlo).
const CANDIDATOS = process.env.LIBREOFFICE_BIN
  ? [process.env.LIBREOFFICE_BIN]
  : (process.platform === 'win32'
    ? ['soffice.com',
       'C:\\Program Files\\LibreOffice\\program\\soffice.com',
       'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com']
    : ['soffice']);

let promesaSoffice = null;

function detectarSoffice() {
  return new Promise((resolve) => {
    let pendientes = CANDIDATOS.length;
    let encontrado = null;
    for (const bin of CANDIDATOS) {
      execFile(bin, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (!err && !encontrado) encontrado = { bin, version: String(stdout).trim() };
        if (--pendientes === 0) {
          if (encontrado) {
            logger.info('LibreOffice disponible para previsualizar documentos', encontrado);
          } else {
            logger.info('LibreOffice no está instalado: los Office solo se van a poder descargar', {
              accion: 'sudo apt install -y libreoffice-writer libreoffice-calc libreoffice-impress',
            });
          }
          resolve(encontrado);
        }
      });
    }
  });
}

function soffice() {
  if (!promesaSoffice) promesaSoffice = detectarSoffice();
  return promesaSoffice;
}

async function conversorDisponible() {
  return (await soffice()) !== null;
}

/** Solo para tests: obliga a re-detectar en la próxima llamada. */
function _resetSoffice() { promesaSoffice = null; }

function errorOffice(codigo, mensaje) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  return e;
}

// ── La cola de a uno ─────────────────────────────────────────────────────────
//
// Un solo `soffice` por worker. Lo que la hace barata es que la cache es permanente: una
// clase de 30 con un .docx cada uno son ~120 s de CPU repartidos en la hora que dura
// corregir, y se pagan UNA sola vez por archivo.
let enCurso = null;
let enEspera = 0;

async function enCola(trabajo, { especulativa = false } = {}) {
  // El prefetch NUNCA le gana la cola a un pedido real: si hay algo en curso, se descarta en
  // vez de encolarse. Es especulativo — que no se haga no rompe nada, lo hará el clic.
  if (especulativa && (enCurso || enEspera > 0)) return null;
  if (enEspera >= MAX_EN_ESPERA) {
    throw errorOffice('CONVERSION_EN_CURSO', 'Estamos preparando la vista previa…');
  }
  enEspera++;
  const anterior = enCurso || Promise.resolve();
  const mio = anterior.catch(() => {}).then(() => { enEspera--; return trabajo(); });
  enCurso = mio.catch(() => {});
  return mio;
}

/**
 * Convierte un Office a PDF y lo deja en `destino`. Devuelve `destino` si ya estaba cacheado,
 * sin lanzar nada.
 *
 * @param {string} rutaArchivo  el archivo del alumno (no se toca)
 * @param {string} destino      ruta absoluta del PDF derivado
 * @param {object} opts         { especulativa } para el prefetch
 * @returns {Promise<string|null>}  la ruta del PDF, o null si era especulativa y se descartó
 */
async function convertirAPdf(rutaArchivo, destino, opts = {}) {
  if (fs.existsSync(destino)) return destino;

  const bin = await soffice();
  if (!bin) throw errorOffice('SIN_CONVERSOR', 'No hay conversor de documentos instalado');

  const stat = fs.statSync(rutaArchivo);
  if (stat.size > MAX_BYTES) {
    throw errorOffice('ARCHIVO_DEMASIADO_GRANDE', 'El archivo pasa el tope del conversor');
  }

  return enCola(async () => {
    // Pudo haberla hecho otro mientras esperaba el turno.
    if (fs.existsSync(destino)) return destino;

    // Carpeta de salida propia por trabajo: `--outdir` escribe con el nombre del original, y
    // dos conversiones a la vez (2 workers) no pueden compartir directorio.
    const dirTrabajo = path.join(path.dirname(destino), '.tmp-' + crypto.randomUUID());
    fs.mkdirSync(dirTrabajo, { recursive: true });
    try {
      // El filtro de impress hace falta para el .pptx (§ J); para el resto alcanza con `pdf`.
      const filtro = /\.pptx?$/i.test(rutaArchivo) ? 'pdf:impress_pdf_Export' : 'pdf';
      await new Promise((resolve, reject) => {
        execFile(bin.bin, ['--headless', '--norestore', '--convert-to', filtro,
          '--outdir', dirTrabajo, rutaArchivo],
        { timeout: TIMEOUT_MS, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });

      const salida = fs.readdirSync(dirTrabajo).find(n => /\.pdf$/i.test(n));
      if (!salida) throw errorOffice('CONVERSION_FALLIDA', 'LibreOffice no dejó ningún PDF');

      fs.mkdirSync(path.dirname(destino), { recursive: true });
      // A un nombre temporal y `rename` al final (atómico): con 2 workers, nadie puede leer
      // medio PDF escrito.
      const parcial = destino + '.' + crypto.randomUUID() + '.parcial';
      fs.copyFileSync(path.join(dirTrabajo, salida), parcial);
      fs.renameSync(parcial, destino);
      return destino;
    } finally {
      try { fs.rmSync(dirTrabajo, { recursive: true, force: true }); } catch {}
    }
  }, opts);
}

/**
 * Encola la conversión de los Office de una entrega SIN esperarla (RN-16b). Se dispara al
 * abrir al alumno: los segundos de LibreOffice transcurren mientras el docente lee el panel.
 * Fire-and-forget a propósito — un prefetch que falla no puede romper la apertura del panel.
 */
function prefetch(pares) {
  for (const { origen, destino } of pares || []) {
    if (fs.existsSync(destino)) continue;
    convertirAPdf(origen, destino, { especulativa: true }).catch((err) => {
      logger.info('Prefetch de conversión Office descartado', { error: err.message });
    });
  }
}

module.exports = {
  MAX_BYTES,
  TIMEOUT_MS,
  conversorDisponible,
  convertirAPdf,
  prefetch,
  _resetSoffice,
};
