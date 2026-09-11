// Recomprime las fotos históricas de las ENTREGAS, sin tocar la base de datos.
//
// Uso:
//   node tools/comprimir-historico.js --dry-run           ← empezá SIEMPRE por acá
//   node tools/comprimir-historico.js --dry-run --limit=200
//   node tools/comprimir-historico.js --limit=50          ← tanda de prueba, y mirala en la app
//   node tools/comprimir-historico.js                     ← el resto
//   node tools/comprimir-historico.js --hasta=2026-09-01  ← solo lo subido antes de esa fecha
//   node tools/comprimir-historico.js --calidad=85        ← por defecto 82
//
// ── Por qué existe, teniendo optimize-existing-images.js ─────────────────────────────────
// Aquel cubre avatares, portadas y novedades, y para eso CONVIERTE a .webp — lo que cambia el
// nombre del archivo y lo obliga a reescribir URLs en la base. Este cubre lo que aquel no mira:
// `archivos/entregas`, que en producción pesa 13,29 GB en 5.661 fotos de celular de 4096×3072
// subidas tal cual (medido el 2026-09-11).
//
// ⭐ Y la diferencia que lo hace seguro: acá NO se convierte a WebP. Se recomprime JPEG → JPEG
// conservando nombre, extensión, ruta y dimensiones, así que **la base de datos no se toca en
// absoluto**. Ningún documento apunta a un archivo que dejó de existir, porque ninguno cambia
// de nombre.
//
// ── Por qué alcanza con recomprimir, sin achicar ────────────────────────────────────────
// Medido sobre 20 archivos reales de producción: recomprimir a calidad 82 SIN tocar los
// 4096×3072 ahorra **75,7%**. Reducir además a 2560px llevaría el ahorro a 88%, pero sobre el
// total son 1,66 GB más — no vale perder resolución por eso: si un docente quiere hacer zoom
// para leer la letra de un ejercicio, la tiene. Las fotos vienen del celular con calidad ~95,
// que es desperdicio de codificación, no información visible.
//
// ⚠️ Esto MODIFICA las entregas de los alumnos. Quedan visualmente equivalentes, pero ya no son
// el archivo bit a bit que subió el chico. Backup antes, siempre.

'use strict';

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Solo las carpetas donde hay fotos subidas por usuarios. `public/archivos` queda afuera a
// propósito: ahí viven las imágenes que YA pasan por el optimizador (son .webp) y los 64 JPG
// que quedan pesan 60 MB, ruido frente a los 13 GB de entregas.
const CARPETAS = ['archivos/entregas'];

const EXTENSIONES = new Set(['.jpg', '.jpeg']);

// ⭐ Si no gana al menos esto, se deja el original intacto. Es el "mientras se pueda": una foto
// que ya venía optimizada no tiene nada que entregar, y reescribirla solo suma una generación
// de pérdida a cambio de nada. También hace el script naturalmente IDEMPOTENTE: correrlo dos
// veces no vuelve a comprimir lo ya comprimido, porque en la segunda pasada no alcanza el
// umbral y lo saltea.
const AHORRO_MINIMO = 0.15;

const args    = process.argv.slice(2);
const flag    = n => args.some(a => a === `--${n}`);
const valor   = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : null; };

const SIMULACION = flag('dry-run');
const CALIDAD    = Number(valor('calidad')) || 82;
const LIMITE     = Number(valor('limit')) || Infinity;
const HASTA      = valor('hasta') ? new Date(valor('hasta') + 'T00:00:00Z').getTime() : null;

// sharp se carga dentro del main, no al importar el módulo: así los tests pueden probar las
// funciones puras de abajo sin depender del binario nativo.
let sharp;

// ── Fecha de subida ──────────────────────────────────────────────────────────────────────
// ⭐ El nombre del archivo trae su fecha adentro: `1785463964709-y2i5z32ryd.jpg` arranca con un
// timestamp en milisegundos puesto al guardarlo. Es MÁS confiable que la fecha del sistema de
// archivos, que ya sobrevivió a dos mudanzas de servidor y pudo haberse alterado en el camino.
// Si el nombre no la trae, se cae a mtime.
function fechaDeSubida(archivo, stat) {
  const m = path.basename(archivo).match(/^(\d{13})-/);
  if (m) {
    const t = Number(m[1]);
    // Sanidad: entre 2020 y 2100. Un número de 13 dígitos que no sea una fecha razonable
    // es una coincidencia, no un timestamp.
    if (t > 1577836800000 && t < 4102444800000) return t;
  }
  return stat.mtimeMs;
}

// ⭐ Vale la pena reemplazar solo si el ahorro llega al umbral. Se mide con el tamaño NUEVO
// contra el viejo, no al revés: un archivo que engorda (pasa con los que ya venían optimizados)
// da un ahorro negativo y queda descartado por la misma comparación, sin un caso aparte.
function valeLaPena(original, comprimido) {
  if (!original) return false;
  return (1 - comprimido / original) >= AHORRO_MINIMO;
}

async function listar(dir) {
  const salida = [];
  let entradas;
  try { entradas = await fsp.readdir(dir, { withFileTypes: true }); } catch { return salida; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) salida.push(...await listar(p));
    else if (e.isFile() && EXTENSIONES.has(path.extname(e.name).toLowerCase())) salida.push(p);
  }
  return salida;
}

const mb = b => (b / 1048576).toFixed(1);

async function procesar(archivo, r) {
  const stat = await fsp.stat(archivo);
  const original = stat.size;

  if (HASTA && fechaDeSubida(archivo, stat) >= HASTA) { r.fuera_de_fecha++; return; }

  let buf;
  try {
    // .rotate() SIN argumentos va PRIMERO: aplica la orientación del EXIF y la descarta, igual
    // que services/imageOptimizer.js. Sin esto, al recomprimir se pierde el tag de orientación
    // y las fotos verticales del celular aparecerían giradas — el error clásico, y silencioso:
    // el script diría "listo" y la escuela vería las entregas de costado.
    buf = await sharp(archivo, { failOn: 'error' })
      .rotate()
      .jpeg({ quality: CALIDAD, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    // Un archivo corrupto o truncado se saltea y se registra. NO se toca: dejarlo como está es
    // siempre mejor que reemplazarlo por algo que quizás abra peor.
    r.ilegibles.push({ archivo, motivo: (e.message || '').slice(0, 80) });
    return;
  }

  if (!valeLaPena(original, buf.length)) {
    r.sin_ganancia++; r.bytes_sin_ganancia += original;
    return;
  }

  r.comprimibles++;
  r.bytes_antes += original;
  r.bytes_despues += buf.length;

  if (SIMULACION) return;

  // ── Reemplazo seguro ───────────────────────────────────────────────────────────────────
  // Nunca se escribe sobre el original. Se escribe un temporal EN LA MISMA CARPETA (para que
  // el rename sea atómico: cruzar sistemas de archivos no lo es), se verifica que el resultado
  // abra de verdad, y recién ahí se reemplaza. Si el proceso se corta en cualquier punto, el
  // original sigue entero.
  const tmp = archivo + '.comprimiendo';
  try {
    await fsp.writeFile(tmp, buf);

    // Verificación real: que el archivo escrito EN DISCO sea una imagen legible con dimensiones.
    // Comprobar solo el buffer en memoria no dice nada sobre lo que quedó grabado.
    const meta = await sharp(tmp).metadata();
    if (!meta.width || !meta.height) throw new Error('el archivo nuevo no tiene dimensiones');

    // Dueño, permisos y fecha del original. El dueño importa de verdad: si estos archivos
    // quedaran de root, la app (que corre como walter) no podría volver a escribirlos.
    await fsp.chmod(tmp, stat.mode);
    try { await fsp.chown(tmp, stat.uid, stat.gid); } catch { /* sin privilegios: ya es de walter */ }
    await fsp.utimes(tmp, stat.atime, stat.mtime);

    await fsp.rename(tmp, archivo);
    r.reemplazados++;
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    r.fallidos.push({ archivo, motivo: (e.message || '').slice(0, 80) });
  }
}

async function main() {
  try {
    sharp = require('sharp');
  } catch {
    console.error('✗ falta sharp. En el servidor: npm install --omit=dev');
    process.exit(1);
  }

  console.log(SIMULACION ? '\n=== SIMULACIÓN: no se escribe un solo byte ===\n'
                         : '\n=== COMPRESIÓN REAL: se reemplazan archivos ===\n');
  console.log(`  calidad JPEG: ${CALIDAD}   ahorro mínimo para reemplazar: ${AHORRO_MINIMO * 100}%`);
  if (HASTA)             console.log(`  solo lo subido antes de: ${valor('hasta')}`);
  if (LIMITE !== Infinity) console.log(`  limitado a: ${LIMITE} archivos`);

  let archivos = [];
  for (const c of CARPETAS) archivos.push(...await listar(path.join(RAIZ, c)));
  archivos.sort();
  console.log(`  encontrados: ${archivos.length} archivos .jpg/.jpeg\n`);

  const r = {
    comprimibles: 0, reemplazados: 0, sin_ganancia: 0, fuera_de_fecha: 0,
    bytes_antes: 0, bytes_despues: 0, bytes_sin_ganancia: 0,
    ilegibles: [], fallidos: [],
  };

  let n = 0;
  const t0 = Date.now();
  for (const a of archivos) {
    if (n >= LIMITE) break;
    await procesar(a, r);
    n++;
    if (n % 250 === 0) {
      const seg = (Date.now() - t0) / 1000;
      process.stdout.write(`  ... ${n}/${Math.min(archivos.length, LIMITE)}  ` +
        `(${(n / seg).toFixed(1)}/s, ahorro acumulado ${mb(r.bytes_antes - r.bytes_despues)} MB)\n`);
    }
  }

  const ahorroTotal = r.bytes_antes - r.bytes_despues;
  const pct = r.bytes_antes ? (100 * ahorroTotal / r.bytes_antes).toFixed(1) : '0';

  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  revisados            : ${n}`);
  console.log(`  ${SIMULACION ? 'se comprimirían      ' : 'reemplazados         '}: ${SIMULACION ? r.comprimibles : r.reemplazados}`);
  console.log(`     antes             : ${mb(r.bytes_antes)} MB`);
  console.log(`     después           : ${mb(r.bytes_despues)} MB`);
  console.log(`     AHORRO            : ${mb(ahorroTotal)} MB  (${pct}%)`);
  console.log(`  sin ganancia (se dejan como están): ${r.sin_ganancia}  [${mb(r.bytes_sin_ganancia)} MB]`);
  if (HASTA)              console.log(`  fuera del filtro de fecha        : ${r.fuera_de_fecha}`);
  if (r.ilegibles.length) console.log(`  ⚠️ ilegibles (NO se tocaron)      : ${r.ilegibles.length}`);
  if (r.fallidos.length)  console.log(`  ✗ fallidos al reemplazar         : ${r.fallidos.length}`);
  console.log('─'.repeat(62));

  for (const x of r.ilegibles.slice(0, 10)) console.log(`  ⚠️ ${path.relative(RAIZ, x.archivo)} → ${x.motivo}`);
  for (const x of r.fallidos.slice(0, 10))  console.log(`  ✗ ${path.relative(RAIZ, x.archivo)} → ${x.motivo}`);

  if (SIMULACION) console.log('\n  Para hacerlo de verdad, primero una tanda chica:  --limit=50\n');
}

// Solo corre si lo invocan como programa. Importado, expone las funciones puras para los tests.
if (require.main === module) main();

module.exports = { fechaDeSubida, valeLaPena, AHORRO_MINIMO };
