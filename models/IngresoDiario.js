const mongoose = require('mongoose');

// "Entró a la plataforma ese día": un documento por persona del personal y por día.
// Lo escribe middleware/auth.js, en el mismo lugar y con el mismo throttle que User.lastSeen
// (D3 de specs/secretaria-docentes-del-dia.spec.md). Lo lee el panel de la Secretaria.
//
// ⭐ POR QUÉ HACE FALTA, si ya existe lastSeen: lastSeen se PISA. Dice cuándo se vio a alguien
// por última vez, nunca si estuvo el martes. Y el login no sirve para eso: la sesión dura días,
// así que un docente que trabaja todos los días puede iniciar sesión una vez por semana.
//
// Los alumnos NO se registran: no hacen falta para nada y son menores (ver el filtro en
// middleware/auth.js).
//
// `fecha` es string 'YYYY-MM-DD' en la zona de la escuela, por el mismo motivo que
// AttendanceSession.date: producción corre en UTC y un Date sin hora se corre de día.
const ingresoDiarioSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  fecha:      { type: String, required: true },
  // $setOnInsert: la primera vez del día no se pisa nunca.
  primeraVez: { type: Date, required: true },
  // $set en cada escritura (como mucho una por minuto, el throttle de lastSeen).
  ultimaVez:  { type: Date, required: true },
});

// Único: el upsert es idempotente. Si el caché del usuario está viejo y dos workers escriben a
// la vez, uno gana el insert y el otro choca con E11000, que se descarta en silencio.
ingresoDiarioSchema.index({ user: 1, fecha: 1 }, { unique: true });
// La pantalla pide "los ingresos de esta escuela este día", y "desde cuándo hay datos" (RN-07).
ingresoDiarioSchema.index({ school: 1, fecha: 1 });

module.exports = mongoose.model('IngresoDiario', ingresoDiarioSchema);
