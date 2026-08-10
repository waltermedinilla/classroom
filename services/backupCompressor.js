// Compresión de los archivos que van DENTRO del backup.
//
// ── Qué problema resuelve ────────────────────────────────────────────────────
// El .tar.gz del backup pesa ~795 MB y crece con cada entrega. Medido hoy: 581 MB en
// 346 imágenes jpg/png (fotos de celular guardadas byte por byte, hay 8 de más de 4,4 MB)
// y 315 MB en 247 PDFs. gzip no achica nada de eso — jpg y pdf ya vienen comprimidos, lo
// que sobra son PÍXELES, no bytes redundantes. Reencodear baja ~94% en imágenes.
//
// ── Dónde se aplica (y dónde NO) ─────────────────────────────────────────────
// SOLO sobre la copia que routes/backup.js dejó en el directorio de staging temporal.
// Los archivos vivos del servidor no se tocan NUNCA. Eso es lo que hace a esta feature
// segura: el "original" siempre sigue en public/archivos y archivos/entregas, no hace
// falta una carpeta de respaldo ni un botón de revertir.
//
// ── La invariante que gobierna todo el módulo ────────────────────────────────
// EL NOMBRE Y LA EXTENSIÓN DEL ARCHIVO NO CAMBIAN NUNCA. jpg→jpg, png→png, pdf→pdf.
//
// Mongo guarda las rutas de los archivos como strings (Activity.url, Submission.storagePath,
// User.avatar, Course.header.image, Announcement.image). Si acá convirtiéramos a WebP —que
// comprime más— cambiaría el nombre del archivo y habría que reescribir esos strings dentro
// de los JSON de db/ del tarball para que el restore no dejara la mitad de las imágenes
// rotas. Conservando la extensión, POST /restore funciona exactamente igual que siempre y
// ni un documento de Mongo se toca. Los ~4 puntos extra de compresión de WebP no valen ese
// acoplamiento. Es por esto que este módulo NO reusa services/imageOptimizer.js, que sí
// convierte a WebP a propósito.
//
// Todos los tamaños se manejan en BYTES; el formateo es cosa de la vista.

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const { execFile } = require('child_process');
const logger = require('../config/logger');

// sharp va en require protegido por el mismo motivo que en services/imageOptimizer.js: el
// webhook de deploy hace git pull + pm2 reload, NO npm install. Si el binario nativo no
// está en el servidor, un require en el tope tiraría la app entera al arrancar. Acá adentro,
// sin sharp simplemente no se ofrece comprimir imágenes.
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  logger.warn('sharp no está disponible: el backup no va a poder comprimir imágenes', {
    detalle: err.message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación de archivos
// ─────────────────────────────────────────────────────────────────────────────

// El catálogo de tipos es el ÚNICO lugar que decide qué se puede comprimir. Alimenta
// tanto el desglose que ve el superadmin como el recorrido que comprime.
//
// `.webp` va aparte de las imágenes justamente porque YA está optimizada (la subieron
// avatares/portadas/novedades por services/imageOptimizer.js): reencodearla no ahorra
// nada y solo agregaría una pérdida de calidad más.
const TIPOS = {
  imagenes: {
    label:       'Imágenes',
    ext:         ['.jpg', '.jpeg', '.png'],
    comprimible: true,
    detalle:     'Fotos de celular sin optimizar. Se achican a 1600 px y se reencodean.',
  },
  pdf: {
    label:       'PDFs',
    ext:         ['.pdf'],
    comprimible: true,
    detalle:     'Apuntes y escaneos. Se rebajan a 150 dpi con Ghostscript.',
  },
  webp: {
    label:       'WebP',
    ext:         ['.webp'],
    comprimible: false,
    detalle:     'Avatares y portadas ya optimizados al subirse.',
  },
  documentos: {
    label:       'Documentos',
    ext:         ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods'],
    comprimible: false,
    detalle:     'Ya son ZIP internamente; recomprimir no ahorra.',
  },
  otros: {
    label:       'Otros',
    ext:         [],
    comprimible: false,
    detalle:     'Se copian tal cual.',
  },
};

// Índice extensión → tipo, armado una vez al cargar el módulo.
const POR_EXTENSION = {};
for (const [id, tipo] of Object.entries(TIPOS)) {
  for (const ext of tipo.ext) POR_EXTENSION[ext] = id;
}

// Cuánto queda DESPUÉS de comprimir, por extensión. Son los ratios medidos sobre los
// archivos reales de este proyecto (ver el bloque "Backup comprimido" en agente.md):
// jpg ~94% de ahorro, png ~70%. El de PDF es una estimación conservadora porque depende
// muchísimo de si el PDF es un escaneo (baja muchísimo) o texto vectorial (casi no baja).
//
// Solo se usan para el "ahorro estimado" que muestra la pantalla ANTES de comprimir. El
// resumen que se devuelve después de comprimir son bytes reales, no estimaciones.
const RATIO_RESTANTE = {
  '.jpg':  0.10,
  '.jpeg': 0.10,
  '.png':  0.30,
  '.pdf':  0.55,
};

// Extensión → id de tipo. `.JPG` y `.jpg` son lo mismo.
function clasificar(nombreArchivo) {
  const ext = path.extname(nombreArchivo || '').toLowerCase();
  return POR_EXTENSION[ext] || 'otros';
}

// ─────────────────────────────────────────────────────────────────────────────
// Ghostscript
// ─────────────────────────────────────────────────────────────────────────────

// Ghostscript es un binario del sistema, no una dependencia de npm: en producción hay que
// instalarlo a mano (`sudo apt install ghostscript`) y en Windows de desarrollo puede no
// estar. Se detecta una sola vez y el resultado se cachea en una promesa, así el chequeo
// no se repite en cada request ni corre en paralelo consigo mismo.
//
// El binario se llama distinto según el sistema: `gs` en Linux/macOS, `gswin64c` (la
// variante de consola) en Windows.
const CANDIDATOS_GS = process.platform === 'win32' ? ['gswin64c', 'gswin32c'] : ['gs'];

let promesaGs = null;

function detectarGs() {
  return new Promise((resolve) => {
    let pendientes = CANDIDATOS_GS.length;
    let encontrado = null;
    for (const bin of CANDIDATOS_GS) {
      execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (!err && !encontrado) encontrado = { bin, version: String(stdout).trim() };
        if (--pendientes === 0) {
          if (encontrado) {
            logger.info('Ghostscript disponible para comprimir PDFs del backup', encontrado);
          } else {
            logger.info('Ghostscript no está instalado: el backup no va a poder comprimir PDFs', {
              accion: 'sudo apt install ghostscript',
            });
          }
          resolve(encontrado);
        }
      });
    }
  });
}

// Devuelve { bin, version } o null. Cacheado de por vida del proceso.
function ghostscript() {
  if (!promesaGs) promesaGs = detectarGs();
  return promesaGs;
}

async function gsDisponible() {
  return (await ghostscript()) !== null;
}

function sharpDisponible() {
  return sharp !== null;
}

// Solo para tests: obliga a re-detectar Ghostscript en la próxima llamada.
function _resetGs() { promesaGs = null; }

// ─────────────────────────────────────────────────────────────────────────────
// Análisis: qué hay guardado y cuánto se podría ahorrar
// ─────────────────────────────────────────────────────────────────────────────

const TTL_MS = 60 * 1000;
let cache = { at: 0, clave: '', data: null };

const TOP_PESADOS = 10;

// Recorre un directorio acumulando por tipo. Mismo criterio que services/diskStats.js:
// `withFileTypes` para no pagar un stat extra por entrada, los symlinks NO se siguen
// (isFile() los excluye solo, y un link hacia arriba haría un loop infinito), y cualquier
// error por entrada se saltea — es un panel informativo, no vale abortar todo por un
// archivo con permisos raros o borrado entre el readdir y el stat.
async function recorrer(dir, base, etiquetaCarpeta, acumulador) {
  let entradas;
  try {
    entradas = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // la carpeta puede no existir todavía (escuela nueva, entregas vacías)
  }

  for (const entrada of entradas) {
    const completa = path.join(dir, entrada.name);
    try {
      if (entrada.isDirectory()) {
        await recorrer(completa, base, etiquetaCarpeta, acumulador);
      } else if (entrada.isFile()) {
        const st   = await fsp.stat(completa);
        const tipo = clasificar(entrada.name);
        const ext  = path.extname(entrada.name).toLowerCase();

        const acu = acumulador.porTipo[tipo];
        acu.count += 1;
        acu.bytes += st.size;
        // El estimado se acumula por extensión, no por tipo: dentro de "imágenes" conviven
        // jpg (ahorra 90%) y png (ahorra 70%), y promediarlos daría un número inventado.
        acu.bytesEstimados += st.size * (RATIO_RESTANTE[ext] ?? 1);

        acumulador.total.count += 1;
        acumulador.total.bytes += st.size;

        acumulador.pesados.push({
          carpeta: etiquetaCarpeta,
          zona:    zonaDe(path.relative(base, completa), etiquetaCarpeta),
          archivo: entrada.name,
          bytes:   st.size,
          tipo,
        });
      }
    } catch {
      // entrada ilegible o borrada mientras recorríamos: se saltea
    }
  }
}

// De qué parte de la app viene el archivo, para mostrarlo sin exponer identificadores.
//
// Las rutas reales son {schoolId}/actividades/{courseId}/archivo dentro de public/archivos
// y {schoolId}/{activityId}/{studentId}/archivo dentro de archivos/entregas. Los ids no le
// dicen nada a nadie y en el caso de las entregas identifican al alumno, así que a la vista
// va solo la zona lógica.
const ZONAS = {
  actividades: 'Adjuntos de actividades',
  avatars:     'Avatares',
  headers:     'Portadas de materias',
  novedades:   'Imágenes de novedades',
};

function zonaDe(rutaRelativa, etiquetaCarpeta) {
  const partes = rutaRelativa.split(/[\\/]/);
  // public/archivos/{schoolId}/{zona}/... — la zona es el segundo segmento
  return ZONAS[partes[1]] || etiquetaCarpeta;
}

function tipoVacio(id) {
  return {
    label:       TIPOS[id].label,
    detalle:     TIPOS[id].detalle,
    comprimible: TIPOS[id].comprimible,
    count:       0,
    bytes:       0,
    bytesEstimados: 0,
  };
}

// Desglose de todo lo que entraría al backup. `carpetas` es [{ dir, label }].
//
// Va cacheado 60 s: la card del monitor que consume esto refresca cada 5 segundos y el
// recorrido es O(cantidad de archivos) — hoy ~700 archivos / 911 MB. Mismo esquema que
// services/diskStats.js, por el mismo motivo.
async function analizarCarpetas(carpetas) {
  const clave = carpetas.map(c => c.dir).join('|');
  const ahora = Date.now();
  if (cache.data && cache.clave === clave && (ahora - cache.at) <= TTL_MS) {
    return { ...cache.data, calculadoHace: Math.round((ahora - cache.at) / 1000) };
  }

  const acumulador = {
    porTipo: Object.fromEntries(Object.keys(TIPOS).map(id => [id, tipoVacio(id)])),
    total:   { count: 0, bytes: 0 },
    pesados: [],
  };

  for (const { dir, label } of carpetas) {
    await recorrer(dir, dir, label, acumulador);
  }

  // El ahorro estimado solo tiene sentido sobre lo que efectivamente se puede comprimir.
  for (const [id, acu] of Object.entries(acumulador.porTipo)) {
    acu.ahorroEstimado = TIPOS[id].comprimible ? Math.max(0, acu.bytes - Math.round(acu.bytesEstimados)) : 0;
    delete acu.bytesEstimados;
  }

  const data = {
    porTipo: acumulador.porTipo,
    total:   acumulador.total,
    topPesados: acumulador.pesados
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_PESADOS),
  };

  cache = { at: ahora, clave, data };
  return { ...data, calculadoHace: 0 };
}

// Solo para tests: fuerza el próximo análisis a ignorar el cache.
function invalidarCache() { cache = { at: 0, clave: '', data: null }; }

// ─────────────────────────────────────────────────────────────────────────────
// Compresión de un archivo
// ─────────────────────────────────────────────────────────────────────────────

// Techo de resolución. 1600 px cubre una pantalla full HD en retina; nadie mira el
// escaneo de una carpeta a más que eso. Es el mismo valor que usan los presets de
// portada y novedad en config/imagePresets.js.
const MAX_LADO = 1600;
const CALIDAD_JPEG = 78;

// Reencodea una imagen conservando su formato. Devuelve { ok, antes, despues, motivo }.
//
// `failOn: 'none'` (tolerante) y no el 'error' de las subidas: acá el archivo YA está
// publicado y mostrándose. Si está truncado, rechazarlo no arregla nada — convertir lo que
// se pueda decodificar salva el espacio igual. Es el mismo criterio que usa el backfill
// optimize-existing-images.js.
async function comprimirImagen(rutaArchivo) {
  const antes = (await fsp.stat(rutaArchivo)).size;
  if (!sharp) return { ok: false, antes, despues: antes, motivo: 'sin-sharp' };

  // Se lee a buffer en vez de dejar que sharp lea del path porque el destino es EL MISMO
  // archivo: no se puede escribir encima de lo que sharp todavía está leyendo.
  const original = await fsp.readFile(rutaArchivo);

  let meta;
  try {
    meta = await sharp(original, { failOn: 'none' }).metadata();
  } catch (err) {
    // Ni la cabecera se pudo leer: esto no es una imagen, por más que la extensión lo diga.
    return { ok: false, antes, despues: antes, motivo: 'ilegible', error: err.message };
  }

  // El encoder se elige por el formato REAL, no por la extensión: en este proyecto ya hay
  // avatares que son JPEG (y uno WebP) con nombre .png. Elegir por extensión los mandaba al
  // encoder PNG, el resultado salía más grande y la regla de "gana el original" los dejaba
  // sin comprimir — ahorro perdido en silencio. El NOMBRE del archivo sigue sin tocarse:
  // lo que se preserva es el formato que el archivo ya tenía, no lo que dice llamarse.
  const salidaFormato = { jpeg: 'jpeg', png: 'png', webp: 'webp' }[meta.format];
  if (!salidaFormato) {
    return { ok: false, antes, despues: antes, motivo: 'formato-no-soportado' };
  }

  // Un GIF/WebP animado (pages > 1) reencodeado pierde los cuadros o crece. Pasa intacto,
  // igual que en services/imageOptimizer.js.
  if (meta.pages && meta.pages > 1) {
    return { ok: false, antes, despues: antes, motivo: 'animada' };
  }

  let salida;
  try {
    // .rotate() sin argumentos aplica la orientación del EXIF y la descarta. Va ANTES del
    // resize (que razona sobre el alto/ancho ya rotados) y además borra el EXIF entero,
    // donde viaja el GPS de las fotos de celular de los alumnos.
    const pipeline = sharp(original, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_LADO, height: MAX_LADO, fit: 'inside', withoutEnlargement: true });

    if (salidaFormato === 'png') {
      // PNG sin paleta a propósito: cuantizar a 256 colores ahorraba apenas 2 puntos más
      // (71% vs 69% medido) y le mete banding a las fotos guardadas como PNG. Acá el
      // ahorro grande lo hace el resize, no el reencodeo.
      salida = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else if (salidaFormato === 'webp') {
      salida = await pipeline.webp({ quality: CALIDAD_JPEG }).toBuffer();
    } else {
      salida = await pipeline.jpeg({ quality: CALIDAD_JPEG, mozjpeg: true }).toBuffer();
    }
  } catch (err) {
    // Leyó la cabecera pero falló al decodificar el cuerpo: imagen truncada o corrupta.
    return { ok: false, antes, despues: antes, motivo: 'ilegible', error: err.message };
  }

  // Si el "comprimido" pesa más, gana el original. Pasa con imágenes chicas ya optimizadas
  // al máximo. Mismo criterio que services/imageOptimizer.js.
  if (salida.length >= antes) {
    return { ok: false, antes, despues: antes, motivo: 'ya-optimizada' };
  }

  await fsp.writeFile(rutaArchivo, salida);
  return { ok: true, antes, despues: salida.length };
}

// Rebaja la resolución interna de un PDF con Ghostscript, conservando el .pdf.
//
// `-dPDFSETTINGS=/ebook` = imágenes internas a 150 dpi, que es lo que hace la diferencia en
// los escaneos (el grueso de los PDFs del proyecto). El texto vectorial no se toca, así que
// un PDF nativo de Word casi no baja — y ahí la regla de "gana el original" lo deja intacto.
//
// spawn con array de argumentos, nunca shell: la ruta viene de recorrer el staging, pero
// pasar por un shell abriría la puerta a que un nombre de archivo con comillas o `;` se
// interprete como comando.
async function comprimirPdf(rutaArchivo) {
  const antes = (await fsp.stat(rutaArchivo)).size;
  const gs = await ghostscript();
  if (!gs) return { ok: false, antes, despues: antes, motivo: 'sin-ghostscript' };

  // Ghostscript no puede escribir sobre el archivo que está leyendo.
  const salidaTmp = path.join(os.tmpdir(), `gs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);

  try {
    await new Promise((resolve, reject) => {
      execFile(gs.bin, [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dPDFSETTINGS=/ebook',
        '-dNOPAUSE', '-dBATCH', '-dQUIET',
        // Sin esto, un PDF con JavaScript embebido o rutas raras podría hacer que gs toque
        // el filesystem. -dSAFER es el default desde gs 9.50, se pone explícito igual.
        '-dSAFER',
        `-sOutputFile=${salidaTmp}`,
        rutaArchivo,
      ], { timeout: 120000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
    });

    const despues = (await fsp.stat(salidaTmp)).size;

    // Un PDF que ya era chico o puro texto puede crecer al reescribirse. Y un resultado de
    // 0 bytes significa que gs falló en silencio: en los dos casos gana el original.
    if (despues === 0 || despues >= antes) {
      return { ok: false, antes, despues: antes, motivo: 'ya-optimizado' };
    }

    await fsp.copyFile(salidaTmp, rutaArchivo);
    return { ok: true, antes, despues };
  } catch (err) {
    return { ok: false, antes, despues: antes, motivo: 'ilegible', error: err.message };
  } finally {
    fs.unlink(salidaTmp, () => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recorrido completo del staging
// ─────────────────────────────────────────────────────────────────────────────

// Corre `tarea` sobre `items` con como mucho `limite` en vuelo. Sin esto, 346 imágenes
// secuenciales tardan más de un minuto de reloj mientras el CPU está ocioso.
async function conPool(items, limite, tarea) {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      await tarea(items[siguiente++]);
    }
  });
  await Promise.all(trabajadores);
}

// sharp corre fuera del event loop, en el threadpool de libuv: 4 en paralelo aprovechan el
// CPU sin frenar a los usuarios que están navegando. Ghostscript es un proceso aparte por
// archivo y cada uno puede comerse cientos de MB de RAM con un escaneo grande, así que va
// más apretado — el servidor de producción tiene que seguir sirviendo la app mientras tanto.
const POOL_IMAGENES = 4;
const POOL_PDF      = 2;

function listarArchivos(dir, acumulador = []) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acumulador;
  }
  for (const entrada of entradas) {
    const completa = path.join(dir, entrada.name);
    if (entrada.isDirectory()) listarArchivos(completa, acumulador);
    else if (entrada.isFile()) acumulador.push(completa);
  }
  return acumulador;
}

function resumenVacio() {
  return { count: 0, antes: 0, despues: 0, omitidos: 0, fallidos: 0 };
}

// Comprime EN EL LUGAR todos los archivos de `dir` según `opciones`. `dir` tiene que ser
// el staging temporal del backup, nunca public/archivos ni archivos/entregas.
//
// Devuelve { imagenes, pdf, duracionMs } con bytes reales (no estimaciones). Un archivo que
// falla se cuenta y se deja como estaba: un escaneo dañado no puede hacer fracasar el
// backup entero, que es justamente lo que uno quiere tener cuando algo anda mal.
async function comprimirArbol(dir, { imagenes = false, pdf = false } = {}) {
  const arranque = Date.now();
  const resumen = { imagenes: resumenVacio(), pdf: resumenVacio() };
  if (!imagenes && !pdf) return { ...resumen, duracionMs: 0 };

  const todos = listarArchivos(dir);
  const deTipo = (id) => todos.filter(f => clasificar(f) === id);

  // El caché de libvips ayuda cuando se procesa la MISMA imagen varias veces (el caso de
  // una subida), pero en un batch de cientos de archivos distintos no acierta nunca y solo
  // acumula presión de memoria hasta el "vips_tracked: out of memory". Mismo motivo por el
  // que optimize-existing-images.js lo apaga. Se restaura al terminar porque es estado
  // global del proceso y las subidas de los usuarios lo siguen usando.
  if (sharp && imagenes) sharp.cache(false);

  const aplicar = async (rutaArchivo, comprimir, acu) => {
    let r;
    try {
      r = await comprimir(rutaArchivo);
    } catch (err) {
      acu.fallidos += 1;
      logger.warn('No se pudo comprimir un archivo del backup', { archivo: path.basename(rutaArchivo), error: err.message });
      return;
    }
    acu.antes   += r.antes;
    acu.despues += r.despues;
    if (r.ok) {
      acu.count += 1;
    } else if (r.motivo === 'ilegible') {
      acu.fallidos += 1;
    } else {
      acu.omitidos += 1;
    }
  };

  try {
    if (imagenes) {
      const lista = deTipo('imagenes');
      await conPool(lista, POOL_IMAGENES, f => aplicar(f, comprimirImagen, resumen.imagenes));
    }
    if (pdf) {
      const lista = deTipo('pdf');
      await conPool(lista, POOL_PDF, f => aplicar(f, comprimirPdf, resumen.pdf));
    }
  } finally {
    if (sharp && imagenes) sharp.cache(true);
  }

  const duracionMs = Date.now() - arranque;
  logger.info('Archivos del backup comprimidos', {
    imagenes: `${resumen.imagenes.count}/${resumen.imagenes.count + resumen.imagenes.omitidos + resumen.imagenes.fallidos}`,
    pdf:      `${resumen.pdf.count}/${resumen.pdf.count + resumen.pdf.omitidos + resumen.pdf.fallidos}`,
    ahorro:   (resumen.imagenes.antes + resumen.pdf.antes) - (resumen.imagenes.despues + resumen.pdf.despues),
    duracionMs,
  });

  return { ...resumen, duracionMs };
}

// Ids de tipo que se pueden comprimir. Es la lista blanca contra la que routes/backup.js
// valida el ?comprimir= de la query — nunca se confía en el string crudo.
const TIPOS_COMPRIMIBLES = Object.entries(TIPOS)
  .filter(([, t]) => t.comprimible)
  .map(([id]) => id);

module.exports = {
  TIPOS, TIPOS_COMPRIMIBLES, TTL_MS,
  clasificar, analizarCarpetas, invalidarCache,
  comprimirImagen, comprimirPdf, comprimirArbol,
  gsDisponible, sharpDisponible, _resetGs,
};
