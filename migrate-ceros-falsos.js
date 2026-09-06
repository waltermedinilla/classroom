// Repara las notas que valen 0 sin que ningún docente haya puesto un 0.
//
// Uso:
//   node migrate-ceros-falsos.js --dry-run                  ← empezá SIEMPRE por acá
//   node migrate-ceros-falsos.js
//   node migrate-ceros-falsos.js --con-devolucion [--dry-run]
//
// ── Qué pasó ────────────────────────────────────────────────────────────────────────────
// Hasta v1.0.41 (2026-08-14 00:02, commit b176868), el docente que escribía una DEVOLUCIÓN
// y dejaba el campo de la nota VACÍO terminaba con un `points: 0` guardado en la base: el
// servidor hacía `Number(points)` sobre un string vacío, y `Number('')` es 0. El fix de ese
// día cortó el problema para las notas NUEVAS (ahora un campo vacío guarda `points: null`,
// que es "devolución sin nota"), pero nunca reparó las que ya estaban escritas.
//
// El resultado es una mentira en las dos direcciones:
//   - Al ALUMNO le figura "0 / 10" abajo de una devolución que dice "Muy bien. APROBADO.".
//   - Al DOCENTE le figura un "Promedio de notas: 0" en /directivo/teachers, en rojo.
//   - Los promedios por alumno, división y escuela están arrastrados a cero.
//
// ── Cómo se distingue un cero falso de uno de verdad ────────────────────────────────────
// Con TRES condiciones a la vez, y las tres hacen falta:
//
//   1. points === 0
//   2. la devolución escrita NO está vacía — el cero del bug nace siempre acompañado de
//      feedback, porque la ruta rechaza el pedido que no trae ni nota ni devolución
//      (ver routes/activities.js, POST /:id/grade: "No hay nota ni devolución para guardar").
//   3. el subdocumento se CREÓ antes del fix. La fecha no sale de `gradedAt` —ese campo se
//      reescribe cada vez que el docente vuelve a guardar, y de hecho hay ceros del bug con
//      gradedAt posterior al fix, de una edición de la devolución— sino del timestamp que
//      lleva adentro el ObjectId del propio subdocumento, que no se puede reescribir.
//
// Medido contra la base real antes de escribir esto: 130 notas en 0, de las cuales 128
// cumplen las tres (todas con devolución, todas creadas antes del fix) y 2 no cumplen
// ninguna de las dos últimas (creadas después del fix y SIN devolución) — esas dos son
// ceros que un docente puso a propósito y el script no las toca.
//
// Es idempotente: después de correrlo, los registros reparados tienen points null y ya no
// entran en el filtro. Correrlo dos veces no hace nada la segunda vez.

// ── El segundo modo: --con-devolucion (agregado el 2026-09-06) ──────────────────────────
// Al reparar los 128 quedaron 47 ceros afuera, y al mirarlos apareció algo que el diagnóstico
// original no podía ver: NINGUNO es anterior al fix, o sea que los tipeó gente. Y 29 de ellos
// son de UNA sola actividad, los 29 con devolución escrita, de la misma docente que encabezaba
// los 128.
//
// La conclusión es que el 0 nunca fue solo un accidente de programación: es lo que se escribe
// para decir "corregí pero no le pongo nota". Con la regla de la escuela ya explícita —la nota
// más baja es 1, ver public/js/devoluciones.js— un 0 CON devolución escrita es reparable
// independientemente de su fecha, porque la devolución es la prueba de que hubo corrección.
//
// Un 0 SIN devolución queda afuera igual: ahí no hay ninguna señal de qué se quiso decir, y
// convertirlo en "sin nota" sería inventar una intención. Esos se preguntan, no se migran.
require('dotenv').config();
const mongoose = require('mongoose');

const DRY_RUN        = process.argv.includes('--dry-run');
const CON_DEVOLUCION = process.argv.includes('--con-devolucion');

// v1.0.41 salió el 2026-08-14 00:02 hora de Argentina (UTC-3).
const FIX = new Date('2026-08-14T03:02:00Z');

const tieneDevolucion = (g) => String(g.feedback || '').trim() !== '';

// Modo por defecto: solo los del bug de `Number('')`, con el corte por fecha.
// Con --con-devolucion: todo cero que venga acompañado de una devolución, sin mirar la fecha.
// El segundo incluye al primero, así que correr el default después no encuentra nada.
const esCeroFalso = (g) =>
  g.points === 0 &&
  tieneDevolucion(g) &&
  !!g._id &&
  (CON_DEVOLUCION || g._id.getTimestamp() < FIX);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Falta MONGODB_URI en el .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const activities = mongoose.connection.db.collection('activities');
  const users      = mongoose.connection.db.collection('users');

  const docs = await activities.find({ 'grades.points': 0 }).toArray();

  const afectadas = [];
  let totalCeros = 0, totalFalsos = 0;

  for (const a of docs) {
    const ceros  = (a.grades || []).filter(g => g.points === 0);
    const falsos = ceros.filter(esCeroFalso);
    totalCeros  += ceros.length;
    totalFalsos += falsos.length;
    if (falsos.length) afectadas.push({ doc: a, falsos, legitimos: ceros.length - falsos.length });
  }

  console.log(CON_DEVOLUCION
    ? 'Modo --con-devolucion: repara TODO cero acompañado de una devolución escrita.\n'
    : 'Modo por defecto: solo los ceros del bug de Number(\'\'), anteriores al fix.\n');
  console.log(`Notas en 0 encontradas:        ${totalCeros}`);
  console.log(`De esas, reparables:           ${totalFalsos}`);
  console.log(`Quedan como están:             ${totalCeros - totalFalsos}`
    + (CON_DEVOLUCION ? ' (sin devolución: no hay señal de qué se quiso decir)' : ' (no cumplen las tres condiciones)'));

  if (!totalFalsos) {
    console.log('\nNada para reparar. La base ya está limpia.');
    await mongoose.disconnect();
    return;
  }

  const nombres = Object.fromEntries(
    (await users.find({ _id: { $in: afectadas.map(x => x.doc.author).filter(Boolean) } })
      .project({ name: 1 }).toArray()).map(u => [u._id.toString(), u.name]),
  );

  console.log('\nActividades afectadas:');
  for (const { doc, falsos, legitimos } of afectadas) {
    console.log(`  - ${falsos.length.toString().padStart(3)} notas · ${doc.title.slice(0, 50)}`
      + `  [${nombres[doc.author?.toString()] || 'sin autor'}]`
      + (legitimos ? `  (+${legitimos} cero/s legítimo/s que quedan como están)` : ''));
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no se escribió nada.');
    await mongoose.disconnect();
    return;
  }

  // Se escribe subdocumento por subdocumento con el _id del grade como ancla: es lo único
  // que garantiza que no se toque un cero legítimo de la misma actividad.
  let escritas = 0;
  for (const { doc, falsos } of afectadas) {
    for (const g of falsos) {
      const r = await activities.updateOne(
        { _id: doc._id, 'grades._id': g._id },
        { $set: { 'grades.$.points': null } },
      );
      escritas += r.modifiedCount;
    }
  }

  console.log(`\nListo: ${escritas} notas pasaron de 0 a "devolución sin nota".`);
  console.log('La devolución escrita, el gradedAt y el autor quedaron intactos.');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
