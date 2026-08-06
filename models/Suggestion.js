const mongoose = require('mongoose');
const { Schema } = mongoose;

// Un mensaje del hilo, DESPUÉS del primer ida y vuelta.
//
// Por qué el hilo no arranca acá y guarda los dos primeros aparte: el mensaje inicial vive
// en `text` y la primera respuesta en `response` desde que existe la feature, y las
// sugerencias que ya están en producción se leen desde ahí. Meterlos dentro de `messages`
// habría exigido migrar la base para no perder el historial. `messages` es la continuación:
// vacío en todas las sugerencias históricas, que siguen viéndose igual.
//
// Ver services/suggestionThread.js: ahí se arma el hilo completo a partir de los tres campos,
// y es lo único que miran las vistas.
const messageSchema = new Schema({
  // 'user'  = quien abrió la sugerencia, respondiendo a la respuesta del equipo
  // 'staff' = el superadmin, contestando de nuevo
  from:   { type: String, enum: ['user', 'staff'], required: true },
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text:   { type: String, required: true, trim: true, maxlength: 1000 },
  at:     { type: Date, default: Date.now },
  // Queda registro de que se editó, igual que se puede editar la primera respuesta.
  editedAt: { type: Date, default: null },
});

const suggestionSchema = new Schema({
  text:   { type: String, required: true, trim: true, maxlength: 1000 },
  user:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  school: { type: Schema.Types.ObjectId, ref: 'School', default: null },
  status: { type: String, enum: ['pending', 'reviewed', 'answered'], default: 'pending' },

  // ── Respuesta del superadmin ────────────────────────────────────────────
  response:     { type: String, trim: true, maxlength: 1000, default: '' },
  respondedAt:  { type: Date, default: null },
  respondedBy:  { type: Schema.Types.ObjectId, ref: 'User', default: null },
  // Continuación de la conversación. Cuando el usuario contesta una respuesta, la sugerencia
  // vuelve a `status: 'pending'` para que reaparezca en la bandeja del superadmin, que es
  // donde él mira. Ver routes/suggestions.js (POST /mine/:id/reply).
  messages:     { type: [messageSchema], default: [] },
  // false = el usuario todavía no abrió/leyó la respuesta (dispara el badge del sobre).
  // Se resetea a false cada vez que el superadmin edita una respuesta ya existente,
  // así el usuario nota la actualización aunque ya hubiera leído la versión anterior.
  readByUser:   { type: Boolean, default: false },
}, { timestamps: true });

// Cubre el filtro por estado + orden por fecha del panel de superadmin (GET /superadmin/suggestions)
suggestionSchema.index({ status: 1, createdAt: -1 });
// Para un futuro filtro/reporte por escuela
suggestionSchema.index({ school: 1, createdAt: -1 });
// Bandeja del usuario: "¿tengo respuestas sin leer?" (badge del sobre) + listado propio
suggestionSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('Suggestion', suggestionSchema);
