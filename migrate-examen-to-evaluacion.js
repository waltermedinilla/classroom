// Convierte las actividades con type:'examen' en type:'evaluacion'.
//
// Uso:
//   node migrate-examen-to-evaluacion.js --dry-run    ← empezá SIEMPRE por acá
//   node migrate-examen-to-evaluacion.js
//
// El tipo 'examen' se retiró el 2026-07-29 porque era indistinguible de 'evaluacion' para el
// docente. Al momento del cambio producción tenía CERO actividades de ese tipo (82 'tarea' y
// 2 'tp'), así que en el caso normal este script no toca nada y termina en un segundo.
//
// Entonces, ¿para qué existe? Por dos motivos:
//
//   1. Entre el momento en que se verificó el conteo y el momento en que el deploy llega a
//      producción, un docente todavía puede crear un "Examen" con la UI vieja. Esa ventana
//      es chica pero real, y el resultado sería un documento huérfano.
//
//   2. Un documento huérfano NO es inofensivo. Se lee bien (Mongoose no valida en lectura),
//      pero cualquier activity.save() falla con ValidationError porque 'examen' ya no está
//      en el enum. Eso rompe calificar (routes/activities.js POST /:id/grade), editar la
//      actividad (PUT /:id) y recibir entregas (POST /:id/submit). O sea: la actividad
//      quedaría de solo lectura y el docente no podría ponerle nota. Además la tarjeta se
//      vería como "Tarea", porque typeConfig() cae al fallback cuando el tipo es desconocido.
//
// Es idempotente: correrlo dos veces no hace daño. Conviene correrlo DESPUÉS de desplegar
// el código nuevo, que es cuando la UI ya no puede generar más exámenes.

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  // Se usa la colección cruda a propósito: el modelo Activity ya tiene el enum SIN 'examen',
  // así que buscar por ese valor a través de Mongoose sería contradictorio (y en algunas
  // versiones el casteo del query lo rechaza). Acá queremos justamente los documentos que
  // el esquema nuevo considera inválidos.
  const activities = mongoose.connection.db.collection('activities');

  const total = await activities.countDocuments({ type: 'examen' });
  console.log(`Actividades con type:'examen' encontradas: ${total}`);

  if (total === 0) {
    console.log('Nada para migrar. La base ya está limpia.');
    await mongoose.disconnect();
    return;
  }

  const muestra = await activities.find({ type: 'examen' })
    .project({ title: 1, course: 1 })
    .limit(20)
    .toArray();
  console.log('\nActividades afectadas (hasta 20):');
  muestra.forEach(a => console.log(`  - ${a.title} (curso ${a.course})`));

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Se convertirían ${total} actividades a type:'evaluacion'. No se escribió nada.`);
    await mongoose.disconnect();
    return;
  }

  const r = await activities.updateMany({ type: 'examen' }, { $set: { type: 'evaluacion' } });
  console.log(`\nListo: ${r.modifiedCount} actividades convertidas a 'evaluacion'.`);

  const quedan = await activities.countDocuments({ type: 'examen' });
  console.log(quedan === 0
    ? 'Verificación OK: no queda ninguna actividad con type:\'examen\'.'
    : `⚠️ Todavía quedan ${quedan} actividades con type:'examen' — revisar a mano.`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error en la migración:', err);
  process.exit(1);
});
