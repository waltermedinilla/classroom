// Enciende la edición de la entrega en las actividades que ya estaban cargadas.
//
// Uso:
//   node migrate-permitir-edicion.js --dry-run    ← empezá SIEMPRE por acá
//   node migrate-permitir-edicion.js
//
// ── Qué pasó ────────────────────────────────────────────────────────────────────────────
// Hasta el 2026-09-04, `allowResubmission` nacía en `false`: la entrega quedaba fija con el
// primer envío salvo que el docente tildara un checkbox apagado por defecto y escondido
// abajo de la barra lateral de la pantalla de crear actividad. Medido sobre el espejo local
// ese día: de 697 actividades, solo 102 lo tenían encendido, y eso dejaba 1350 de las 1852
// entregas (73%) congeladas — el alumno que subía el archivo equivocado se quedaba con eso
// puesto y no tenía ninguna salida por pantalla.
//
// El default del modelo ya cambió a `true` (ver models/Activity.js), pero eso solo alcanza
// para las actividades NUEVAS. Este script arregla las que ya estaban.
//
// ── Qué toca, y qué NO ──────────────────────────────────────────────────────────────────
// Solo las actividades cuya ENTREGA SIGUE ABIERTA: sin fecha límite, con fecha por delante,
// o vencidas pero con las tardías habilitadas.
//
// A las vencidas con las tardías cerradas no hace falta tocarlas: la regla nueva
// (public/js/edicionEntrega.js) les cierra la edición igual, por `vencida`, mirando la fecha
// y no el flag. Escribirles el flag no cambiaría ningún comportamiento y les movería el
// `updatedAt` a todas el mismo día — la clase de rastro falso que después nadie sabe
// interpretar. Por el mismo motivo la escritura va con `timestamps: false`.
//
// Tampoco toca las que YA tienen el flag encendido (esas sí fueron una decisión del
// docente), ni le devuelve la edición a nadie a quien ya le corrigieron: la corrección se
// evalúa por alumno en el momento de entregar, no acá.
//
// Medido sobre el espejo local el 2026-09-04:
//   595 actividades sin el flag → 133 con la entrega todavía abierta (las que toca)
//   221 entregas bajo esas 133 → 41 ya corregidas (siguen cerradas) → 180 pasan a editables

require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// El filtro es la mitad del script: dice exactamente qué es "la entrega sigue abierta".
// `$ne: true` y no `false` a propósito — también entran los documentos que nunca tuvieron
// el campo.
const filtro = (ahora) => ({
  allowResubmission: { $ne: true },
  $or: [
    { dueDate: null },
    { dueDate: { $exists: false } },
    { dueDate: { $gt: ahora } },
    { allowLateSubmissions: true },
  ],
});

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const activities  = mongoose.connection.db.collection('activities');
  const submissions = mongoose.connection.db.collection('submissions');

  const ahora = new Date();
  const sinFlag  = await activities.countDocuments({ allowResubmission: { $ne: true } });
  const objetivo = await activities.find(filtro(ahora)).toArray();
  const ids      = objetivo.map(a => a._id);

  // Cuántas entregas quedan efectivamente editables: las que además no están corregidas.
  // Es el número que le importa a quien pregunta "¿qué cambia mañana?".
  const subs = await submissions.find({ activity: { $in: ids } }).toArray();
  const porId = new Map(objetivo.map(a => [String(a._id), a]));
  const corregidas = subs.filter(s => {
    const a = porId.get(String(s.activity));
    const g = (a?.grades || []).find(x => String(x.student) === String(s.student));
    if (!g || g.manual === false) return false;
    return g.points != null || String(g.feedback || '').trim() !== '';
  }).length;

  console.log(`Actividades sin el flag:                    ${sinFlag}`);
  console.log(`De esas, con la entrega todavía abierta:    ${objetivo.length}  ← las que se tocan`);
  console.log(`Entregas bajo esas actividades:             ${subs.length}`);
  console.log(`  de esas, ya corregidas (siguen cerradas): ${corregidas}`);
  console.log(`  pasan a ser EDITABLES:                    ${subs.length - corregidas}`);
  console.log(`Vencidas con tardías cerradas (sin tocar):  ${sinFlag - objetivo.length}`);

  if (!objetivo.length) {
    console.log('\nNo hay nada que migrar.');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no se escribió nada.');
    console.log('Primeras 10 actividades que se tocarían:');
    objetivo.slice(0, 10).forEach(a => {
      const plazo = a.dueDate ? new Date(a.dueDate).toISOString().slice(0, 10) : 'sin fecha';
      console.log(`  · ${String(a._id)}  ${plazo}  ${String(a.title || '').slice(0, 50)}`);
    });
    await mongoose.disconnect();
    return;
  }

  // timestamps: false → no le mueve el updatedAt a 133 actividades por un cambio que no
  // hizo ningún docente. El driver nativo no toca timestamps por su cuenta; se deja escrito
  // igual para que quede dicho, y porque si alguna vez esto pasa por el modelo de Mongoose
  // la opción hace falta de verdad.
  const r = await activities.updateMany(
    filtro(ahora),
    { $set: { allowResubmission: true } },
    { timestamps: false },
  );

  console.log(`\nListo: ${r.modifiedCount} actividades quedaron con la edición habilitada.`);
  console.log('La regla sigue cerrando la entrega corregida y la vencida — el flag solo abre la puerta.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
