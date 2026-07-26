const mongoose = require('mongoose');

// Vínculo plantilla ↔ escuela. Sigue el patrón de la solapa "Temas":
//
//   1. Superadmin OFRECE una plantilla a una escuela desde /superadmin/tasks
//      → se crea (o actualiza) un TemplateAssignment con status='offered'.
//   2. Admin de la escuela ACEPTA o RECHAZA desde /admin/task-templates
//      → status pasa a 'accepted' o 'rejected'. Solo con 'accepted' los
//      docentes de la escuela van a poder instanciar la plantilla (Fase 5).
//   3. Superadmin puede REVOCAR (borra el doc) en cualquier momento.
//
// Igual que en Temas, no hay selección fina por docente: si el admin acepta,
// TODOS los docentes de la escuela pueden usar la plantilla. Si algún día se
// necesita restricción por docente, es un campo más — no un refactor.
const templateAssignmentSchema = new mongoose.Schema({
  template: { type: mongoose.Schema.Types.ObjectId, ref: 'ActivityTemplate', required: true },
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School',           required: true },
  status:   { type: String, enum: ['offered', 'accepted', 'rejected'], default: 'offered' },
  offeredBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // superadmin
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },                  // admin que aceptó/rechazó
  respondedAt: { type: Date },
}, { timestamps: true });

// Un solo vínculo por par (plantilla, escuela). Re-ofrecer es upsert sobre este índice.
templateAssignmentSchema.index({ template: 1, school: 1 }, { unique: true });
// Panel del admin: listar todas las plantillas ofrecidas/aceptadas de su escuela.
templateAssignmentSchema.index({ school: 1, status: 1 });

module.exports = mongoose.model('TemplateAssignment', templateAssignmentSchema);
