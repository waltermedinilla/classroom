#!/usr/bin/env node
// Borra muestras de la telemetría de la sala en vivo (colección `salasamples`) anteriores a una
// fecha. Ver specs/monitor-sala-escala.spec.md.
//
// ── PARA QUÉ EXISTE ─────────────────────────────────────────────────────────────────────────
// El 2026-09-08 el panel salió con tres métricas mal medidas (el tiempo por poll medía la red,
// y una reconexión contaminaba la demora de entrega). Se arreglaron en v1.0.91, pero las
// muestras ya escritas quedaron con números falsos adentro y ensucian los rangos de 6h, 24h y
// 7d hasta que envejecen.
//
// Es telemetría: se regenera sola, tiene TTL de 30 días y no describe a nadie. Borrar un tramo
// mal medido es preferible a mirar un gráfico que miente.
//
// ── CÓMO SE CORRE CONTRA PRODUCCIÓN ─────────────────────────────────────────────────────────
// El Mongo de producción NO se expone a la red: está ligado a 127.0.0.1. Se llega por el mismo
// túnel SSH que usa pull-from-prod.js, en el puerto 27018.
//
//   1. En una terminal, abrir el túnel y dejarlo abierto:
//        ssh -i ~/.ssh/contabo_classroom -N -L 27018:127.0.0.1:27017 root@169.58.248.255
//
//   2. En otra, desde la carpeta del proyecto:
//        node tools/purgar-telemetria-sala.js --antes 2026-09-08T19:35:00Z --dry-run
//        node tools/purgar-telemetria-sala.js --antes 2026-09-08T19:35:00Z
//
// ⚠️ El puerto 22 NO sale de la red de la escuela: esto hay que correrlo desde casa.
//
// ⚠️ SIN `--antes` no hace nada. No hay un "borrar todo" por accidente.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const valorDe = (bandera) => {
  const i = args.indexOf(bandera);
  return i >= 0 ? args[i + 1] : null;
};

const antes  = valorDe('--antes');
const dryRun = args.includes('--dry-run');

// Por defecto apunta al TÚNEL, no a la base local: este script existe para producción. Para
// correrlo contra el espejo hay que pedirlo explícitamente con --uri.
const URI = valorDe('--uri')
  || process.env.PROD_MONGODB_URI
  || 'mongodb://localhost:27018/classroom-escuela';

if (!antes) {
  console.error('\nFalta --antes con una fecha ISO. Ejemplo:\n');
  console.error('  node tools/purgar-telemetria-sala.js --antes 2026-09-08T19:35:00Z --dry-run\n');
  process.exit(1);
}

const corte = new Date(antes);
if (Number.isNaN(corte.getTime())) {
  console.error(`\n"${antes}" no es una fecha válida. Usá formato ISO, ej: 2026-09-08T19:35:00Z\n`);
  process.exit(1);
}

(async () => {
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });

  const SalaSample = require('../models/SalaSample');
  const total    = await SalaSample.countDocuments({});
  const aBorrar  = await SalaSample.countDocuments({ minuto: { $lt: corte } });
  const masVieja = await SalaSample.findOne({}).sort({ minuto: 1 }).select('minuto').lean();
  const masNueva = await SalaSample.findOne({}).sort({ minuto: -1 }).select('minuto').lean();

  console.log(`\nBase   : ${URI.replace(/\/\/[^@]*@/, '//<credenciales>@')}`);
  console.log(`Corte  : ${corte.toISOString()}  (se borra lo ANTERIOR)`);
  console.log(`\nMuestras totales : ${total}`);
  console.log(`  rango actual   : ${masVieja ? masVieja.minuto.toISOString() : '—'}  →  ${masNueva ? masNueva.minuto.toISOString() : '—'}`);
  console.log(`  a borrar       : ${aBorrar}`);
  console.log(`  quedan         : ${total - aBorrar}`);

  if (dryRun) {
    console.log('\n--dry-run: no se borró nada.\n');
  } else if (aBorrar === 0) {
    console.log('\nNo hay nada anterior a esa fecha.\n');
  } else {
    const r = await SalaSample.deleteMany({ minuto: { $lt: corte } });
    const quedan = await SalaSample.countDocuments({});
    console.log(`\nBorradas: ${r.deletedCount}   ·   quedan: ${quedan}\n`);
  }

  await mongoose.disconnect();
})().catch(err => {
  // El error más probable es que el túnel no esté abierto. Decirlo, en vez de un stack.
  if (/ECONNREFUSED|serverSelection/i.test(err.message)) {
    console.error('\nNo se pudo conectar. ¿Está abierto el túnel?\n');
    console.error('  ssh -i ~/.ssh/contabo_classroom -N -L 27018:127.0.0.1:27017 root@169.58.248.255\n');
  } else {
    console.error('\nERROR:', err.message, '\n');
  }
  process.exit(1);
});
