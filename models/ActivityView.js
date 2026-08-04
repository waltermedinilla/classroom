const mongoose = require('mongoose');

// Acuse de lectura de una actividad: registra que un ALUMNO abrió el detalle.
//
// Por qué una colección aparte y no un array embebido en Activity:
//   - Espeja a Submission (mismo par {activity, student} + índice único + upsert), así que el
//     código del docente cruza ambos con el mismo patrón.
//   - Un array dentro de Activity crecería un elemento por alumno y por actividad, sin techo.
//
// La ausencia de documento significa "sin abrir": no hace falta backfill de las actividades
// que ya existían cuando se agregó esta feature.
const activityViewSchema = new mongoose.Schema({
  // Actividad abierta (FK para el aggregate del contador y para el listado del docente)
  activity: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', required: true },
  // Alumno que la abrió. Solo se registran alumnos: las aperturas del docente/admin se ignoran
  // en la ruta, para que el contador "N vieron" signifique lo que el docente espera.
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },
  // Primera apertura. Se setea una sola vez con $setOnInsert para que no la pise una relectura
  // (mismo criterio que Submission.firstSubmittedAt).
  firstViewedAt: { type: Date, default: null },
  // Última apertura; se pisa en cada visita. Sirve para el "Últ: ..." de la tabla del docente.
  lastViewedAt:  { type: Date, default: null },
  // Cantidad de aperturas. Distingue al que entró una vez y se fue del que volvió varias veces.
  viewCount:     { type: Number, default: 0 },
}, { timestamps: true });

// Índice único: un solo registro por alumno y actividad. Es la clave del upsert
// (findOneAndUpdate con { upsert: true }) que hace POST /activities/:id/view.
activityViewSchema.index({ activity: 1, student: 1 }, { unique: true });

module.exports = mongoose.model('ActivityView', activityViewSchema);
