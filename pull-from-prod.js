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

require('dotenv').config();
const { MongoClient } = require('mongodb');

// Prod se alcanza SIEMPRE por el túnel SSH en :27018 — el 27017 del Docker de producción
// está ligado a 127.0.0.1 y no se expone a la red. Overrideable por si algún día el túnel
// se abre en otro puerto.
const PROD_URI  = process.env.PROD_MONGODB_URI || 'mongodb://localhost:27018/classroom-escuela';

// El destino sale del .env, NO de una constante: el nombre de la base local ya cambió una
// vez (classroom-clone → classroom-escuela) y con la constante vieja este script escribía
// prolijamente en una base que la app no lee. Sincronizabas, no fallaba nada, y la app
// seguía mostrando los datos de antes.
const LOCAL_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/classroom-escuela';

function dbNameOf(uri) {
  const name = new URL(uri.replace(/^mongodb:/, 'http:')).pathname.replace(/^\//, '');
  if (!name) throw new Error(`La URI no incluye el nombre de la base: ${uri}`);
  return name;
}

// Colecciones internas de Mongo y restos de migraciones viejas: no son datos de la app.
function esSincronizable(name) {
  return !name.startsWith('system.');
}

async function pull() {
  const prodDbName  = dbNameOf(PROD_URI);
  const localDbName = dbNameOf(LOCAL_URI);

  // Guarda de seguridad. Este script hace deleteMany() en el destino: si por un error de
  // configuración prod y local apuntaran al mismo lado, vaciaría producción entera.
  if (PROD_URI === LOCAL_URI) {
    console.error('ERROR: origen y destino son la misma URI. Abortado para no vaciar producción.');
    process.exit(1);
  }

  const prod  = new MongoClient(PROD_URI,  { serverSelectionTimeoutMS: 8000 });
  const local = new MongoClient(LOCAL_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    console.log(`Conectando a producción (${prodDbName} via túnel SSH :27018)...`);
    await prod.connect();
    console.log(`Conectando a BD local (${localDbName})...`);
    await local.connect();
    console.log('');

    const prodDb  = prod.db(prodDbName);
    const localDb = local.db(localDbName);

    // La lista de colecciones se LEE de producción, no se hardcodea. La lista fija se quedó
    // atrás dos veces (sala en vivo, plantillas, secciones, acuses de lectura): el espejo
    // parecía completo y las colecciones nuevas nunca llegaban. Lo que exista en prod, viene.
    const nombres = (await prodDb.listCollections().toArray())
      .map(c => c.name)
      .filter(esSincronizable)
      .sort();

    let totalDocs = 0;

    for (const colName of nombres) {
      const srcCol = prodDb.collection(colName);
      const tgtCol = localDb.collection(colName);

      // Se borra el destino ANTES de leer el origen para que una colección vacía en prod
      // también quede vacía acá: el espejo tiene que poder achicarse, no solo crecer.
      await tgtCol.deleteMany({});

      // Se copia por lotes en vez de un toArray() completo. Hoy la base son ~3 MB y daría
      // igual, pero submissions y roommessages crecen sin techo y un día el toArray() se
      // come toda la RAM del proceso.
      const cursor = srcCol.find({});
      let lote = [];
      let copiados = 0;

      const vaciarLote = async () => {
        if (!lote.length) return;
        await tgtCol.insertMany(lote, { ordered: false });
        copiados += lote.length;
        lote = [];
      };

      for await (const doc of cursor) {
        lote.push(doc);
        if (lote.length >= 1000) await vaciarLote();
      }
      await vaciarLote();

      console.log(copiados === 0
        ? `  ${colName.padEnd(20)} vacía en prod, colección local limpiada`
        : `  ${colName.padEnd(20)} ${copiados} documentos copiados`);
      totalDocs += copiados;
    }

    // Una colección que existe en local pero YA NO en prod queda con datos viejos y el
    // espejo miente. No se borra sola (podría ser algo de desarrollo local a propósito),
    // pero se avisa para que la diferencia no pase inadvertida.
    const sobrantes = (await localDb.listCollections().toArray())
      .map(c => c.name)
      .filter(n => esSincronizable(n) && !nombres.includes(n));

    console.log('');
    console.log(`Sincronización completa. ${nombres.length} colecciones, ${totalDocs} documentos.`);
    if (sobrantes.length) {
      console.log('');
      console.log(`AVISO: estas colecciones existen en local pero no en prod: ${sobrantes.join(', ')}`);
      console.log('Quedaron intactas. Si son restos viejos, borralas a mano.');
    }
    console.log(`La BD local (${localDbName}) ahora es un espejo de producción.`);
  } catch (err) {
    if (err.message.includes('ECONNREFUSED') && err.message.includes('27018')) {
      console.error('ERROR: No hay túnel SSH activo en el puerto 27018.');
      console.error('Usá .\\sync-prod.ps1 para abrir el túnel automáticamente.');
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
