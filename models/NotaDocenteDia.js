const mongoose = require('mongoose');

// La anotación de la secretaria sobre el día de un docente ("avisó que llega tarde",
// "clase presencial en el taller"). Una por docente, día y escuela: editarla la reemplaza, y el
// historial de ediciones queda en AuditLog (secretaria.nota_guardar / secretaria.nota_borrar).
// Ver RN-12 y RN-13 de specs/secretaria-docentes-del-dia.spec.md.
// Desde la F2 de specs/jefe-de-taller.spec.md también la escribe el Jefe de Taller sobre un MEP
// (taller.nota_guardar / taller.nota_borrar): es el MISMO legajo del día, no uno aparte.
//
// ⚠️ El DOCENTE NO LA VE (RN-13, decisión de Walter del 2026-11-11). La leen la secretaria con
// ese docente en su alcance, el directivo y el admin. Ninguna ruta del docente la consulta.
const notaDocenteDiaSchema = new mongoose.Schema({
  school:  { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  docente: { type: mongoose.Schema.Types.ObjectId, ref: 'User',   required: true },
  fecha:   { type: String, required: true },   // 'YYYY-MM-DD', zona de la escuela
  texto:   { type: String, required: true, trim: true, maxlength: 500 },
  // La última persona que la escribió. El nombre va como snapshot, igual que en AuditLog: la
  // nota de hace un año tiene que seguir diciendo quién la puso aunque la cuenta ya no exista.
  autor:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  autorNombre: { type: String, default: '' },
}, { timestamps: true });

notaDocenteDiaSchema.index({ school: 1, docente: 1, fecha: 1 }, { unique: true });
notaDocenteDiaSchema.index({ school: 1, fecha: 1 });

module.exports = mongoose.model('NotaDocenteDia', notaDocenteDiaSchema);
