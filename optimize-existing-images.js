// Recomprime las imágenes que YA estaban subidas antes de que existiera el optimizador.
//
// Uso:
//   node optimize-existing-images.js --dry-run      ← empezá SIEMPRE por acá
//   node optimize-existing-images.js
//   node optimize-existing-images.js --only=avatars
//
// Desde la v1.0.7 toda imagen nueva se guarda ya optimizada (ver middleware/image-upload.js),
// pero lo viejo sigue en disco tal como se subió: 78 archivos / 74,7 MB en el mirror local,
// con avatares de hasta 3 MB. Este script los pasa por el mismo optimizador.
//
// ⚠️ TOCA LA BASE DE DATOS. No alcanza con reescribir el archivo: al cambiar la extensión
// a .webp cambia el nombre, y las URLs viven en User.avatar, Course.header.image y
// Announcement.image. Si se reescribieran los archivos sin actualizar la BD, TODAS las
// imágenes de la escuela quedarían rotas.
//
// Procedimiento en producción:
//   1. Backup desde /superadmin/backup (Nivel 1)
//   2. Activar modo mantenimiento
//   3. --dry-run y leer el informe
//   4. Correr en serio
//   5. Verificar avatares/portadas en la app y salir de mantenimiento

require('dotenv').config();
const mongoose = require('mongoose');
const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs/promises');
const crypto   = require('crypto');

const User         = require('./models/User');
const Course       = require('./models/Course');
const Announcement = require('./models/Announcement');
const { optimizar, sharpDisponible } = require('./services/imageOptimizer');

// El cache de operaciones de libvips no sirve en un proceso batch: acá cada imagen se ve
// UNA sola vez, así que no acelera nada y solo acumula presión de memoria (con las 78
// imágenes locales llegó a tirar "out of memory" armando buffers grandes).
require('sharp').cache(false);

const DRY_RUN     = process.argv.includes('--dry-run');
const soloArg     = process.argv.find(a => a.startsWith('--only='));
const SOLO        = soloArg ? soloArg.split('=')[1] : null;
const PUBLIC_BASE = path.join(__dirname, 'public', 'archivos');

// Cada grupo dice: qué carpeta recorrer, con qué preset comprimir, y cómo encontrar y
// actualizar el documento que referencia esa URL.
//
// `segmento` es el nombre de carpeta dentro de public/archivos/{schoolId}/ — la estructura
// es {schoolId}/{segmento}/{ownerId}/{archivo}, la misma que arman las rutas.
const GRUPOS = [
  {
    id:       'avatars',
    label:    'Avatares de perfil',
    segmento: 'avatars',
    preset:   'avatar',
    modelo:   User,
    campo:    'avatar',
  },
  {
    id:       'headers',
    label:    'Portadas de materias',
    segmento: 'headers',
    preset:   'header',
    modelo:   Course,
    campo:    'header.image',
  },
  {
    id:       'novedades',
    label:    'Imágenes de novedades',
    segmento: 'novedades',
    preset:   'novedad',
    modelo:   Announcement,
    campo:    'image',
  },
];

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function mb(bytes) { return (bytes / 1048576).toFixed(2) + ' MB'; }

// Recorre public/archivos/*/{segmento}/**/ y devuelve los archivos de imagen encontrados,
// con la URL pública que les correspondería (que es como están guardados en la BD).
function listarImagenes(segmento) {
  const encontrados = [];
  if (!fs.existsSync(PUBLIC_BASE)) return encontrados;

  for (const escuela of fs.readdirSync(PUBLIC_BASE, { withFileTypes: true })) {
    if (!escuela.isDirectory()) continue;
    const dirSegmento = path.join(PUBLIC_BASE, escuela.name, segmento);
    if (!fs.existsSync(dirSegmento)) continue;

    for (const dueno of fs.readdirSync(dirSegmento, { withFileTypes: true })) {
      if (!dueno.isDirectory()) continue;
      const dirDueno = path.join(dirSegmento, dueno.name);
      for (const archivo of fs.readdirSync(dirDueno, { withFileTypes: true })) {
        if (!archivo.isFile()) continue;
        if (!EXT_IMAGEN.includes(path.extname(archivo.name).toLowerCase())) continue;
        encontrados.push({
          rutaAbs:   path.join(dirDueno, archivo.name),
          urlPublica: `/archivos/${escuela.name}/${segmento}/${dueno.name}/${archivo.name}`,
          dir:        dirDueno,
          nombre:     archivo.name,
        });
      }
    }
  }
  return encontrados;
}

// Mismo criterio de nombres que middleware/image-upload.js: sufijo único para que la URL
// cambie y el navegador no siga sirviendo la versión vieja desde su cache.
function nombreNuevo(nombreViejo, ext) {
  const base   = path.basename(nombreViejo, path.extname(nombreViejo));
  // El nombre viejo puede ya traer un sufijo (avatar-abc123): se lo saca para no encadenar.
  const limpio = base.replace(/-[0-9a-z]{9,}$/i, '');
  const sufijo = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  return `${limpio}-${sufijo}${ext}`;
}

async function procesarGrupo(grupo, resumen) {
  const imagenes = listarImagenes(grupo.segmento);
  console.log(`\n── ${grupo.label} (${imagenes.length} archivos) ──`);

  for (const img of imagenes) {
    const buffer  = await fsp.readFile(img.rutaAbs);
    const antes   = buffer.length;
    resumen.bytesAntes += antes;
    resumen.total      += 1;

    let resultado, recuperada = false;
    try {
      resultado = await optimizar(buffer, grupo.preset, img.nombre);
    } catch (err) {
      // Segundo intento en modo tolerante. Estos archivos YA están publicados y el
      // navegador los muestra (parciales, pero se muestran): rechazarlos no le devuelve
      // la imagen a nadie y deja el peso completo en disco. Convertir lo que se pueda
      // decodificar preserva exactamente lo que hoy ve el usuario y libera el espacio.
      try {
        resultado  = await optimizar(buffer, grupo.preset, img.nombre, { tolerante: true });
        recuperada = true;
      } catch (err2) {
        // Ni en modo tolerante: no es una imagen. Se deja intacto y se reporta.
        console.log(`  ✗ ${img.nombre} — ${err.message}${err.causa ? ` [${err.causa}]` : ''}`);
        resumen.errores      += 1;
        resumen.bytesDespues += antes;
        continue;
      }
    }

    if (!resultado.optimizada) {
      console.log(`  · ${img.nombre} — sin cambios (${resultado.motivo || 'sin sharp'})`);
      resumen.omitidos     += 1;
      resumen.bytesDespues += antes;
      continue;
    }

    const nombre = nombreNuevo(img.nombre, resultado.ext);
    const ahorro = Math.round((1 - resultado.bytes / antes) * 100);
    const marca  = recuperada ? ' ⚠ recuperada (original dañado)' : '';
    console.log(`  ✓ ${img.nombre} → ${nombre}  ${mb(antes)} → ${mb(resultado.bytes)}  (-${ahorro}%)${marca}`);

    if (recuperada) resumen.recuperados += 1;
    resumen.optimizados  += 1;
    resumen.bytesDespues += resultado.bytes;

    if (DRY_RUN) continue;

    // Orden deliberado: escribir la nueva → actualizar la BD → recién ahí borrar la vieja.
    // Si el proceso muere en el medio, lo peor que queda es un archivo huérfano (lo levanta
    // cleanup-files.js). Nunca una URL en la BD apuntando a un archivo que ya no existe.
    const urlNueva = img.urlPublica.replace(/[^/]+$/, nombre);
    await fsp.writeFile(path.join(img.dir, nombre), resultado.buffer);

    const res = await grupo.modelo.updateMany(
      { [grupo.campo]: img.urlPublica },
      { $set: { [grupo.campo]: urlNueva } },
    );

    if (res.matchedCount === 0) {
      // Archivo en disco que ningún documento referencia. Es basura previa (la limpia
      // cleanup-files.js); se borra la copia nueva para no duplicar el huérfano.
      console.log('      (huérfano: ningún documento lo referencia — se deja como estaba)');
      await fsp.unlink(path.join(img.dir, nombre)).catch(() => {});
      resumen.huerfanos += 1;
      continue;
    }

    await fsp.unlink(img.rutaAbs).catch(() => {});
  }
}

(async () => {
  if (!sharpDisponible()) {
    console.error('sharp no está disponible — corré `npm install` antes de usar este script.');
    process.exit(1);
  }

  const grupos = SOLO ? GRUPOS.filter(g => g.id === SOLO) : GRUPOS;
  if (grupos.length === 0) {
    console.error(`--only=${SOLO} no existe. Opciones: ${GRUPOS.map(g => g.id).join(', ')}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(DRY_RUN
    ? '=== SIMULACIÓN (--dry-run): no se escribe nada ==='
    : '=== EJECUCIÓN REAL: se reescriben archivos y URLs en la base ===');
  console.log(`Base: ${process.env.MONGODB_URI}`);

  const resumen = {
    total: 0, optimizados: 0, omitidos: 0, errores: 0, huerfanos: 0, recuperados: 0,
    bytesAntes: 0, bytesDespues: 0,
  };

  for (const grupo of grupos) await procesarGrupo(grupo, resumen);

  const ahorro = resumen.bytesAntes > 0
    ? Math.round((1 - resumen.bytesDespues / resumen.bytesAntes) * 100)
    : 0;

  console.log('\n═══ Resumen ═══');
  console.log(`  Archivos revisados : ${resumen.total}`);
  console.log(`  Optimizados        : ${resumen.optimizados}`);
  console.log(`  Sin cambios        : ${resumen.omitidos}`);
  if (resumen.recuperados) console.log(`  Recuperados dañados: ${resumen.recuperados}`);
  console.log(`  Errores            : ${resumen.errores}`);
  if (!DRY_RUN) console.log(`  Huérfanos salteados: ${resumen.huerfanos}`);
  console.log(`  Antes              : ${mb(resumen.bytesAntes)}`);
  console.log(`  Después            : ${mb(resumen.bytesDespues)}`);
  console.log(`  Ahorro             : ${mb(resumen.bytesAntes - resumen.bytesDespues)} (${ahorro}%)`);
  if (DRY_RUN) console.log('\nNada de esto se aplicó. Corré sin --dry-run para hacerlo efectivo.');

  await mongoose.disconnect();
})().catch(err => {
  console.error('Falló la optimización:', err);
  process.exit(1);
});
