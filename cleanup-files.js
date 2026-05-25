// Limpieza de archivos huérfanos en disco
// Uso normal:   node cleanup-files.js
// Solo preview: node cleanup-files.js --dry-run
//
// Cruza todos los archivos en disco contra los referenciados en la BD.
// Elimina los que ningún documento menciona y borra carpetas vacías resultantes.
// Cubre: avatars, portadas de cursos, adjuntos de novedades,
//        adjuntos de actividades (docente) y entregas de alumnos.

require('dotenv').config();
const mongoose     = require('mongoose');
const path         = require('path');
const fs           = require('fs');

const User         = require('./models/User');
const Course       = require('./models/Course');
const Announcement = require('./models/Announcement');
const Activity     = require('./models/Activity');
const Submission   = require('./models/Submission');

const DRY_RUN        = process.argv.includes('--dry-run');
const PUBLIC_BASE    = path.join(__dirname, 'public', 'archivos');
const ENTREGAS_BASE  = path.join(__dirname, 'archivos', 'entregas');

// ── Utilidades ────────────────────────────────────────────────────────────────

// Devuelve todos los archivos bajo un directorio de forma recursiva
function walkDir(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    entry.isDirectory() ? out.push(...walkDir(full)) : out.push(full);
  }
  return out;
}

// Elimina directorios vacíos de abajo hacia arriba (después de borrar archivos)
function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const full = path.join(dir, e);
    if (fs.statSync(full).isDirectory()) removeEmptyDirs(full);
  }
  if (fs.readdirSync(dir).length === 0) {
    if (!DRY_RUN) fs.rmdirSync(dir);
    console.log(`  [DIR vacío] ${dir}`);
  }
}

function fmtBytes(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (DRY_RUN) console.log('══ MODO DRY-RUN — no se eliminará nada ══\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB conectado\n');

  // ── 1. Recolectar rutas referenciadas en la BD ──────────────────────────────

  const refPublic   = new Set(); // rutas absolutas en public/archivos/
  const refEntregas = new Set(); // rutas absolutas en archivos/entregas/

  // Avatars de usuarios: user.avatar = '/archivos/{school}/avatars/{userId}/avatar.ext'
  const users = await User.find({ avatar: { $ne: null } }).select('avatar').lean();
  for (const u of users) {
    if (u.avatar?.startsWith('/archivos/')) {
      refPublic.add(path.join(PUBLIC_BASE, u.avatar.replace(/^\/archivos\//, '')));
    }
  }
  console.log(`Avatars referenciados:          ${refPublic.size}`);

  const prevSize = refPublic.size;

  // Portadas de cursos: course.header.image = '/archivos/{school}/headers/{courseId}/header.ext'
  const courses = await Course.find({ 'header.image': { $ne: null } }).select('header').lean();
  for (const c of courses) {
    if (c.header?.image?.startsWith('/archivos/')) {
      refPublic.add(path.join(PUBLIC_BASE, c.header.image.replace(/^\/archivos\//, '')));
    }
  }
  console.log(`Portadas de cursos referenciadas: ${refPublic.size - prevSize}`);

  const prev2 = refPublic.size;

  // Imágenes de anuncios: announcement.image = '/archivos/{school}/novedades/{courseId}/{filename}'
  const announcements = await Announcement.find({ image: { $ne: null } }).select('image').lean();
  for (const a of announcements) {
    if (a.image?.startsWith('/archivos/')) {
      refPublic.add(path.join(PUBLIC_BASE, a.image.replace(/^\/archivos\//, '')));
    }
  }
  console.log(`Adjuntos de novedades referenciados: ${refPublic.size - prev2}`);

  const prev3 = refPublic.size;

  // Adjuntos de actividades (docente): att.url = '/archivos/{school}/actividades/{courseId}/{filename}'
  const activities = await Activity.find({ 'attachments.0': { $exists: true } }).select('attachments').lean();
  for (const act of activities) {
    for (const att of (act.attachments || [])) {
      if (att.type === 'file' && att.url?.startsWith('/archivos/')) {
        refPublic.add(path.join(PUBLIC_BASE, att.url.replace(/^\/archivos\//, '')));
      }
    }
  }
  console.log(`Adjuntos de actividades referenciados: ${refPublic.size - prev3}`);

  // Entregas de alumnos: sub.files[].storagePath = '{school}/{actId}/{studentId}/{filename}'
  const submissions = await Submission.find({ 'files.0': { $exists: true } }).select('files').lean();
  for (const sub of submissions) {
    for (const f of (sub.files || [])) {
      if (f.storagePath) {
        refEntregas.add(path.join(ENTREGAS_BASE, f.storagePath));
      }
    }
  }
  console.log(`Entregas de alumnos referenciadas: ${refEntregas.size}`);

  console.log(`\nTotal archivos referenciados en BD: ${refPublic.size + refEntregas.size}\n`);

  // ── 2. Escanear disco ───────────────────────────────────────────────────────

  const diskPublic   = walkDir(PUBLIC_BASE);
  const diskEntregas = walkDir(ENTREGAS_BASE);

  console.log(`Archivos en disco (public/archivos):    ${diskPublic.length}`);
  console.log(`Archivos en disco (archivos/entregas):  ${diskEntregas.length}`);
  console.log(`Total en disco: ${diskPublic.length + diskEntregas.length}\n`);

  // ── 3. Eliminar huérfanos ───────────────────────────────────────────────────

  let deletedCount = 0;
  let deletedBytes = 0;

  const processFiles = (diskFiles, refSet, label) => {
    for (const fp of diskFiles) {
      if (!refSet.has(fp)) {
        const size = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
        if (!DRY_RUN) fs.unlinkSync(fp);
        console.log(`  [${DRY_RUN ? 'BORRARÍA' : 'Eliminado'}][${label}] ${path.relative(__dirname, fp)} (${fmtBytes(size)})`);
        deletedCount++;
        deletedBytes += size;
      }
    }
  };

  processFiles(diskPublic,   refPublic,   'public');
  processFiles(diskEntregas, refEntregas, 'entregas');

  if (deletedCount === 0) {
    console.log('No se encontraron archivos huérfanos. Todo en orden.');
  } else {
    console.log(`\n── Carpetas vacías ──`);
    removeEmptyDirs(PUBLIC_BASE);
    removeEmptyDirs(ENTREGAS_BASE);
  }

  // ── 4. Resumen ──────────────────────────────────────────────────────────────

  console.log('\n══ Resumen ══');
  if (DRY_RUN) {
    console.log(`Se eliminarían: ${deletedCount} archivo(s) — ${fmtBytes(deletedBytes)} liberados`);
    console.log('Ejecutá sin --dry-run para aplicar los cambios.');
  } else {
    console.log(`Eliminados: ${deletedCount} archivo(s) — ${fmtBytes(deletedBytes)} liberados`);
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
