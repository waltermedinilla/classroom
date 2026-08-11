// Purga de conversaciones viejas de las salas en vivo.
// Uso normal:   node cleanup-rooms.js
// Solo preview: node cleanup-rooms.js --dry-run
// Sin preguntar (para automatizar): node cleanup-rooms.js --si
//
// QUÉ BORRA: los MENSAJES de las sesiones cerradas hace más de 3 meses (PURGE_AFTER_MS en
// services/liveRoom.js), y los ARCHIVOS ADJUNTOS que esos mensajes tenían.
//
// Los adjuntos se borran del disco además de la base, y no es un detalle: son lo único de
// esta feature que ocupa espacio de verdad. Si se purgaran solo los documentos, las fotos
// quedarían en archivos/salas/ para siempre, sin ningún mensaje que las nombre — invisibles
// para la app y creciendo sin techo. Cada sesión tiene su propio directorio justamente para
// que esto sea un borrado de carpeta y no un recorrido documento por documento.
// QUÉ NO BORRA, NUNCA: las sesiones ni la presencia. Ese es el registro de asistencia —quién
// estuvo en cada clase—, ocupa muy poco y es lo que se consulta meses después. Después de la
// purga, la clase sigue existiendo y su lista de presentes sigue completa: lo único que
// desaparece es la transcripción.
//
// Por qué a mano y no con un cron: borrar conversaciones de menores es una operación de una
// sola dirección. Este script lista lo que va a borrar y pide confirmación antes de tocar
// nada. Si la docente necesita conservar una clase puntual, la exporta en CSV desde la propia
// sala antes de que se corra esto.
//
// Las sesiones ABIERTAS no se tocan aunque sean viejísimas: el criterio es closedAt, nunca
// openedAt. Una sala olvidada la cierra el autocierre por inactividad, no la purga.

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');
const path     = require('path');
const fsp      = require('fs/promises');

const RoomSession = require('./models/RoomSession');
const RoomMessage = require('./models/RoomMessage');
const Course      = require('./models/Course');
const { PURGE_AFTER_MS, SALAS_BASE, pesoLegible, fechaCorta: fecha } = require('./services/liveRoom');

const DRY_RUN  = process.argv.includes('--dry-run');
const SIN_PREGUNTAR = process.argv.includes('--si');

function preguntar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(pregunta, (r) => { rl.close(); resolve(r); }));
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('Falta MONGODB_URI en el .env'); process.exit(1); }
  await mongoose.connect(uri);

  const corte = new Date(Date.now() - PURGE_AFTER_MS);
  const meses = Math.round(PURGE_AFTER_MS / (30 * 24 * 60 * 60 * 1000));

  console.log(`\nPurga de conversaciones de salas en vivo`);
  console.log(`Retención: ${meses} meses — se borran los mensajes de clases cerradas antes del ${fecha(corte)}\n`);

  // Solo sesiones CERRADAS y viejas. closedAt: { $ne: null, $lt: corte } excluye de plano las
  // que siguen abiertas.
  const sesiones = await RoomSession.find({ closedAt: { $ne: null, $lt: corte } })
    .select('_id course openedAt closedAt').lean();

  if (!sesiones.length) {
    console.log('No hay ninguna clase lo bastante vieja. No se borra nada.\n');
    return mongoose.disconnect();
  }

  const ids      = sesiones.map(s => s._id);
  const aBorrar  = await RoomMessage.countDocuments({ session: { $in: ids } });

  // Adjuntos de esas clases: cuántos son, cuánto pesan y en qué directorios están. Se calcula
  // ANTES de borrar los documentos, porque después ya no hay de dónde sacar las rutas.
  const adjuntos = await RoomMessage.find({
    session: { $in: ids },
    kind:    { $in: ['image', 'file'] },
    'attachment.path': { $ne: '' },
  }).select('attachment.path attachment.bytes deletedAt').lean();

  // El peso lo suman solo los que TODAVÍA están en disco: los que la docente ya borró en su
  // momento se llevaron el archivo con ellos (ver el DELETE de routes/rooms.js), así que
  // contarlos haría que el script prometa liberar un espacio que ya estaba libre.
  const enDisco = adjuntos.filter(m => !m.deletedAt);
  const bytesAdjuntos = enDisco.reduce((t, m) => t + (m.attachment?.bytes || 0), 0);
  // Un directorio por sesión: se borra la carpeta entera y de paso se lleva cualquier archivo
  // huérfano que hubiera quedado ahí (una subida cuyo documento nunca se creó, por ejemplo).
  const dirsAdjuntos = [...new Set(adjuntos.map(m => path.dirname(m.attachment.path)))];

  if (aBorrar === 0) {
    console.log(`Hay ${sesiones.length} clases viejas, pero ya no tienen mensajes. No se borra nada.\n`);
    return mongoose.disconnect();
  }

  // Resumen por materia: qué se va a borrar, de dónde y de qué fechas.
  const cursos = await Course.find({ _id: { $in: [...new Set(sesiones.map(s => String(s.course)))] } })
    .select('name').lean();
  const nombre = new Map(cursos.map(c => [String(c._id), c.name]));

  const porCurso = new Map();
  for (const s of sesiones) {
    const k = String(s.course);
    const e = porCurso.get(k) || { n: 0, desde: s.openedAt, hasta: s.openedAt };
    e.n += 1;
    if (new Date(s.openedAt) < new Date(e.desde)) e.desde = s.openedAt;
    if (new Date(s.openedAt) > new Date(e.hasta)) e.hasta = s.openedAt;
    porCurso.set(k, e);
  }

  console.log('Se van a borrar los mensajes de estas clases:\n');
  for (const [cursoId, e] of porCurso) {
    console.log(`  ${nombre.get(cursoId) || '(materia eliminada)'} — ${e.n} clases, del ${fecha(e.desde)} al ${fecha(e.hasta)}`);
  }
  console.log(`\n  TOTAL: ${aBorrar} mensajes de ${sesiones.length} clases.`);
  if (enDisco.length) {
    console.log(`  Incluye ${enDisco.length} archivos compartidos (${pesoLegible(bytesAdjuntos)}), que se borran del disco.`);
  }
  console.log('  Las clases y su asistencia NO se borran: solo desaparece la conversación.\n');

  if (DRY_RUN) {
    console.log('--dry-run: no se borró nada.\n');
    return mongoose.disconnect();
  }

  if (!SIN_PREGUNTAR) {
    const r = await preguntar('¿Confirmás la purga? Esto no se puede deshacer. Escribí "BORRAR" para continuar: ');
    if (r.trim() !== 'BORRAR') {
      console.log('\nCancelado. No se borró nada.\n');
      return mongoose.disconnect();
    }
  }

  const res = await RoomMessage.deleteMany({ session: { $in: ids } });

  // Los archivos van DESPUÉS de los documentos: si el proceso se corta en el medio, lo que
  // queda son archivos sin mensaje (basura silenciosa, recuperable a mano) y no mensajes que
  // muestran una card apuntando a un archivo que ya no existe.
  let dirsBorrados = 0;
  for (const rel of dirsAdjuntos) {
    // Chequeo de contención, igual que al servirlos: la ruta la escribimos nosotros, pero un
    // `rm -rf` calculado a partir de un campo de la base se verifica siempre.
    const abs = path.resolve(SALAS_BASE, rel);
    if (!abs.startsWith(path.resolve(SALAS_BASE) + path.sep)) {
      console.warn(`  ! Se omitió una ruta fuera de ${SALAS_BASE}: ${rel}`);
      continue;
    }
    try {
      await fsp.rm(abs, { recursive: true, force: true });
      dirsBorrados += 1;
    } catch (err) {
      console.warn(`  ! No se pudo borrar ${rel}: ${err.message}`);
    }
  }

  console.log(`\nListo: ${res.deletedCount} mensajes borrados. ${sesiones.length} clases conservan su asistencia.`);
  if (dirsAdjuntos.length) {
    console.log(`Archivos: ${dirsBorrados} de ${dirsAdjuntos.length} carpetas de clase eliminadas (${pesoLegible(bytesAdjuntos)} liberados).`);
  }
  console.log('');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error en la purga:', err.message);
  process.exit(1);
});
