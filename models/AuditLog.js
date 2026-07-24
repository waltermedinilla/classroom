const mongoose = require('mongoose');
const { Schema } = mongoose;

// Snapshot del actor en el momento del evento.
// Guardar name/email/role además del ref preserva la legibilidad del historial
// aunque después se borre al usuario o se le cambie el nombre/rol.
const actorSnapshotSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  name:   { type: String, default: '' },
  role:   { type: String, default: '' },
  email:  { type: String, default: '' },
}, { _id: false });

// Snapshot de un recurso afectado (curso, actividad, entrega, etc.).
// type es un slug (course/activity/submission/announcement/user/...).
// name captura el nombre visible en el momento — sobrevive renombrados y borrados.
const targetSchema = new Schema({
  type: { type: String, required: true },
  id:   { type: Schema.Types.ObjectId, required: true },
  name: { type: String, default: '' },
}, { _id: false });

const auditLogSchema = new Schema({
  action:  { type: String, required: true },
  actor:   { type: actorSnapshotSchema, required: true },
  targets: { type: [targetSchema], default: [] },
  // Escuela del evento. En rutas de superadmin platform-wide (crear escuela,
  // backup, mantenimiento) el helper deja null explícito — así el panel del
  // admin (scoped por escuela) las excluye y solo el superadmin las ve.
  school:  { type: Schema.Types.ObjectId, ref: 'School', default: null },
  // Timestamp explícito además de createdAt para que el índice compuesto
  // { school, timestamp:-1 } cubra directamente la query natural del panel.
  timestamp: { type: Date, default: Date.now },
  // Metadata específica por acción. Ej: submission.grade → { points, maxPoints }.
  meta:      { type: Schema.Types.Mixed, default: {} },
  ip:        { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: true });

// Panel principal: por escuela, orden descendente por fecha.
auditLogSchema.index({ school: 1, timestamp: -1 });
// "¿Qué hizo este usuario?": perfil de actor.
auditLogSchema.index({ 'actor.userId': 1, timestamp: -1 });
// Filtro por tipo de acción (dropdown del panel).
auditLogSchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
