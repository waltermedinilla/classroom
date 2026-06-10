/**
 * Migración de datos: BD local (dev) → BD producción (via túnel SSH)
 *
 * Requisito previo: túnel SSH activo en otra terminal
 *   ssh -L 27018:127.0.0.1:27017 walter@100.114.77.83 -N
 *
 * Uso: node migrate-to-prod.js
 */

const { MongoClient } = require('mongodb');

const SOURCE_URI = 'mongodb://localhost:27017/classroom-escuela';
const TARGET_URI = 'mongodb://localhost:27018/classroom-escuela';

// Colecciones a migrar (en orden para respetar dependencias)
const COLLECTIONS = [
  'schools',
  'divisions',
  'subjects',
  'users',
  'courses',
  'activities',
  'announcements',
  'submissions',
];

async function migrate() {
  const source = new MongoClient(SOURCE_URI);
  const target = new MongoClient(TARGET_URI);

  try {
    console.log('Conectando a BD origen (local dev)...');
    await source.connect();
    console.log('Conectando a BD destino (producción via túnel)...');
    await target.connect();
    console.log('');

    const srcDb = source.db('classroom-escuela');
    const tgtDb = target.db('classroom-escuela');

    // Verificar que destino está vacío antes de proceder
    const targetCounts = await Promise.all(
      COLLECTIONS.map(async (col) => {
        const count = await tgtDb.collection(col).countDocuments();
        return { col, count };
      })
    );
    const nonEmpty = targetCounts.filter((c) => c.count > 0);
    if (nonEmpty.length > 0) {
      console.error('ERROR: La BD destino ya tiene datos en:');
      nonEmpty.forEach((c) => console.error(`  ${c.col}: ${c.count} documentos`));
      console.error('Abortando para no pisar datos existentes.');
      process.exit(1);
    }

    let totalDocs = 0;

    for (const colName of COLLECTIONS) {
      const srcCol = srcDb.collection(colName);
      const tgtCol = tgtDb.collection(colName);

      const docs = await srcCol.find({}).toArray();

      if (docs.length === 0) {
        console.log(`  ${colName}: vacía, omitida`);
        continue;
      }

      await tgtCol.insertMany(docs, { ordered: false });
      console.log(`  ${colName}: ${docs.length} documentos migrados`);
      totalDocs += docs.length;
    }

    console.log('');
    console.log(`Migración completa. Total: ${totalDocs} documentos.`);
  } catch (err) {
    console.error('Error durante la migración:', err.message);
    process.exit(1);
  } finally {
    await source.close();
    await target.close();
  }
}

migrate();
