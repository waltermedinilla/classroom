// Completa User.phoneE164 para todos los usuarios que ya tienen un celular cargado.
//
// Uso:
//   node migrate-phone-e164.js --dry-run    ← empezá SIEMPRE por acá
//   node migrate-phone-e164.js
//
// POR QUÉ HACE FALTA
// ─────────────────────────────────────────────────────────────────────────────────────────
// `phoneE164` nació con la verificación de contacto (specs/verificacion-de-contacto.spec.md).
// De ahí en adelante lo mantienen solos User.setPhone() y User.camposDeContacto(), pero los
// celulares que YA estaban cargados nunca pasaron por ahí: sin este backfill, toda esa gente
// vería el cartel de "revisá el número" aunque el suyo esté perfecto, porque el campo del que
// sale el botón de verificar estaría vacío.
//
// NO TOCA `phone`, a propósito. `phone` es lo que la persona escribió y lo que leen las fichas
// y el link de wa.me; este script solo agrega, al lado, la forma normalizada.
//
// TAMPOCO TOCA phoneVerifiedAt. Correrlo no verifica a nadie ni desverifica a nadie: al momento
// de correrlo por primera vez nadie está verificado todavía, y si se volviera a correr más
// adelante (es idempotente) sería un desastre silencioso borrar marcas legítimas.
//
// Los números que no se pueden interpretar quedan con phoneE164 en null y se listan al final:
// son los que hay que corregir a mano desde /admin o los que la persona va a tener que arreglar
// en su perfil. No se inventa ninguno.

require('dotenv').config();
const mongoose = require('mongoose');

const { normalizar } = require('./services/telefonoAR');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  // Colección cruda: no hace falta el modelo para dos campos, y evita disparar hooks de save()
  // sobre 600 documentos.
  const users = mongoose.connection.db.collection('users');

  const conCelular = await users
    .find({ phone: { $nin: [null, ''] } })
    .project({ _id: 1, name: 1, email: 1, phone: 1, phoneE164: 1 })
    .toArray();

  console.log(`${conCelular.length} usuarios con celular cargado.`);
  if (DRY_RUN) console.log('— MODO DRY-RUN: no se escribe nada —\n');

  let actualizados = 0;
  let yaEstaban    = 0;
  const ilegibles  = [];

  for (const u of conCelular) {
    const { e164 } = normalizar(u.phone);

    if (!e164) {
      ilegibles.push(u);
      continue;
    }
    if (u.phoneE164 === e164) {
      yaEstaban++;
      continue;
    }

    if (!DRY_RUN) {
      await users.updateOne({ _id: u._id }, { $set: { phoneE164: e164 } });
    }
    actualizados++;
    if (actualizados <= 10) console.log(`  ${u.phone.padEnd(22)} → ${e164}`);
  }
  if (actualizados > 10) console.log(`  … y ${actualizados - 10} más`);

  console.log(`\nNormalizados: ${actualizados}`);
  console.log(`Ya estaban:   ${yaEstaban}`);
  console.log(`Ilegibles:    ${ilegibles.length}`);

  if (ilegibles.length) {
    console.log('\nEstos números no se pudieron interpretar como celular argentino.');
    console.log('No se tocan: quedan sin phoneE164 y sin botón de verificar, hasta que alguien');
    console.log('los corrija desde el perfil o desde /admin.\n');
    for (const u of ilegibles) {
      console.log(`  ${String(u.phone).padEnd(22)}  ${u.name} <${u.email}>`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
