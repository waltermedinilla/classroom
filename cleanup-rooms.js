// Purga de conversaciones viejas de las salas en vivo.
// Uso normal:   node cleanup-rooms.js
// Solo preview: node cleanup-rooms.js --dry-run
// Sin preguntar (para automatizar): node cleanup-rooms.js --si
//
// QUÉ BORRA: los MENSAJES de las sesiones cerradas hace más de 3 meses (PURGE_AFTER_MS en
// services/liveRoom.js).
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

const RoomSession = require('./models/RoomSession');
const RoomMessage = require('./models/RoomMessage');
const Course      = require('./models/Course');
const { PURGE_AFTER_MS } = require('./services/liveRoom');

const DRY_RUN  = process.argv.includes('--dry-run');
const SIN_PREGUNTAR = process.argv.includes('--si');

const fecha = (d) => new Date(d).toLocaleDateString('es-AR');

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
  console.log(`\nListo: ${res.deletedCount} mensajes borrados. ${sesiones.length} clases conservan su asistencia.\n`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error en la purga:', err.message);
  process.exit(1);
});
