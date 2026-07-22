/**
 * Sincronización: BD producción → BD local (espejo completo)
 *
 * Requisito previo: túnel SSH activo (lo abre sync-prod.ps1 automáticamente)
 *   ssh -L 27018:127.0.0.1:27017 walter@100.114.77.83 -N
 *
 * Uso directo: node pull-from-prod.js
 * Uso recomendado: .\sync-prod.ps1  (abre túnel y corre este script solo)
 *
 * ADVERTENCIA: reemplaza COMPLETAMENTE la BD local con los datos de producción.
 */

const { MongoClient } = require('mongodb');

const PROD_URI  = 'mongodb://localhost:27018/classroom-escuela'; // prod via túnel SSH
const LOCAL_URI = 'mongodb://localhost:27017/classroom-clone';   // local dev

const COLLECTIONS = [
  'schools',
  'divisions',
  'subjects',
  'users',
  'courses',
  'activities',
  'announcements',
  'submissions',
  'suggestions',
];

async function pull() {
  const prod  = new MongoClient(PROD_URI,  { serverSelectionTimeoutMS: 8000 });
  const local = new MongoClient(LOCAL_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    console.log('Conectando a producción (via túnel SSH :27018)...');
    await prod.connect();
    console.log('Conectando a BD local (:27017)...');
    await local.connect();
    console.log('');

    const prodDb  = prod.db('classroom-escuela');
    const localDb = local.db('classroom-clone');

    let totalDocs = 0;

    for (const colName of COLLECTIONS) {
      const srcCol = prodDb.collection(colName);
      const tgtCol = localDb.collection(colName);

      const docs = await srcCol.find({}).toArray();

      // Reemplaza la colección local completa
      await tgtCol.deleteMany({});

      if (docs.length === 0) {
        console.log(`  ${colName}: vacía en prod, colección local limpiada`);
        continue;
      }

      await tgtCol.insertMany(docs, { ordered: false });
      console.log(`  ${colName}: ${docs.length} documentos copiados`);
      totalDocs += docs.length;
    }

    console.log('');
    console.log(`Sincronización completa. Total: ${totalDocs} documentos.`);
    console.log('La BD local ahora es un espejo de producción.');
  } catch (err) {
    if (err.message.includes('ECONNREFUSED') && err.message.includes('27018')) {
      console.error('ERROR: No hay túnel SSH activo en el puerto 27018.');
      console.error('Usá .\\ sync-prod.ps1 para abrir el túnel automáticamente.');
    } else {
      console.error('Error durante la sincronización:', err.message);
    }
    process.exit(1);
  } finally {
    await prod.close();
    await local.close();
  }
}

pull();
