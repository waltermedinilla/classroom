// Catálogo canónico de acciones auditables. Cada entrada define:
//   label:    verbo en español, se usa para armar la frase del evento en la UI
//   icon:     material symbol del panel
//   color:    color del ícono (para lectura rápida por categoría)
//   category: agrupador para el dropdown de filtros
//
// Agregar una acción nueva = agregar una línea acá + una llamada logAudit(...)
// donde ocurra. El helper middleware/audit.js valida contra este catálogo en dev
// (loguea un warning si la acción no está registrada) pero igual la guarda en prod,
// así un typo no rompe operaciones reales.

const ACTIONS = {
  // ── Actividades ───────────────────────────────────────────────────────────
  'activity.create':      { label: 'creó una actividad',       icon: 'assignment_add',       color: '#1a73e8', category: 'activity' },
  'activity.edit':        { label: 'editó una actividad',      icon: 'edit_note',            color: '#1a73e8', category: 'activity' },
  'activity.delete':      { label: 'eliminó una actividad',    icon: 'delete',               color: '#ea4335', category: 'activity' },
  'activity.toggle_late': { label: 'cambió entregas tardías',  icon: 'update',               color: '#ea8600', category: 'activity' },

  // ── Entregas ──────────────────────────────────────────────────────────────
  'submission.create':    { label: 'entregó',                  icon: 'assignment_turned_in', color: '#137333', category: 'submission' },
  'submission.update':    { label: 'reenvió su entrega',       icon: 'refresh',              color: '#137333', category: 'submission' },
  'submission.grade':     { label: 'calificó una entrega',     icon: 'grade',                color: '#9334e6', category: 'submission' },

  // ── Novedades ─────────────────────────────────────────────────────────────
  'announcement.create':  { label: 'publicó una novedad',      icon: 'campaign',             color: '#0d7377', category: 'announcement' },
  'announcement.comment': { label: 'comentó una novedad',      icon: 'chat_bubble',          color: '#0d7377', category: 'announcement' },

  // ── Cursos (Course = Materia dictada en una división) ─────────────────────
  'course.create':         { label: 'creó un curso',            icon: 'add_circle',           color: '#1a73e8', category: 'course' },
  'course.edit':           { label: 'editó un curso',           icon: 'edit',                 color: '#1a73e8', category: 'course' },
  'course.delete':         { label: 'eliminó un curso',         icon: 'delete_forever',       color: '#ea4335', category: 'course' },
  'course.join':           { label: 'se unió a un curso',       icon: 'group_add',            color: '#137333', category: 'course' },
  'course.add_student':    { label: 'agregó un alumno',         icon: 'person_add',           color: '#137333', category: 'course' },
  'course.remove_student': { label: 'quitó un alumno',          icon: 'person_remove',        color: '#ea8600', category: 'course' },
  'course.assign_teacher': { label: 'asignó docente',           icon: 'assignment_ind',       color: '#1a73e8', category: 'course' },

  // ── Divisiones (Division = "1°1°", "2°A", etc.) ───────────────────────────
  'division.create':      { label: 'creó una división',        icon: 'add_box',              color: '#1a73e8', category: 'division' },
  'division.edit':        { label: 'editó una división',       icon: 'edit',                 color: '#1a73e8', category: 'division' },
  'division.delete':      { label: 'eliminó una división',     icon: 'delete',               color: '#ea4335', category: 'division' },

  // ── Usuarios ──────────────────────────────────────────────────────────────
  'user.create':          { label: 'creó un usuario',          icon: 'person_add',           color: '#137333', category: 'user' },
  'user.delete':          { label: 'eliminó un usuario',       icon: 'person_remove',        color: '#ea4335', category: 'user' },
  'user.role_change':     { label: 'cambió el rol de',         icon: 'admin_panel_settings', color: '#9334e6', category: 'user' },
  'user.toggle_active':   { label: 'cambió el estado de',      icon: 'toggle_on',            color: '#ea8600', category: 'user' },
  'user.reset_password':  { label: 'reseteó la contraseña de', icon: 'lock_reset',           color: '#ea8600', category: 'user' },
  'user.password_change': { label: 'cambió su contraseña',     icon: 'password',             color: '#5f6368', category: 'user' },
  'user.impersonate':     { label: 'inició suplantación de',   icon: 'visibility',           color: '#9334e6', category: 'user' },
  'user.bulk_role':       { label: 'cambió el rol en masa',    icon: 'group',                color: '#9334e6', category: 'user' },
  'user.bulk_school':     { label: 'asignó escuela en masa',   icon: 'group',                color: '#1a73e8', category: 'user' },
  'user.school_change':   { label: 'cambió la escuela de',     icon: 'swap_horiz',           color: '#1a73e8', category: 'user' },

  // ── Materias (Subject = catálogo institucional de materias) ───────────────
  'subject.create':       { label: 'creó una materia',         icon: 'menu_book',            color: '#1a73e8', category: 'subject' },
  'subject.edit':         { label: 'editó una materia',        icon: 'edit',                 color: '#1a73e8', category: 'subject' },
  'subject.delete':       { label: 'eliminó una materia',      icon: 'delete',               color: '#ea4335', category: 'subject' },

  // ── Escuelas (solo superadmin) ────────────────────────────────────────────
  'school.create':          { label: 'creó una escuela',         icon: 'domain_add',         color: '#1a73e8', category: 'school' },
  'school.edit':            { label: 'editó una escuela',        icon: 'edit',               color: '#1a73e8', category: 'school' },
  'school.delete':          { label: 'eliminó una escuela',      icon: 'domain_disabled',    color: '#ea4335', category: 'school' },
  'school.invite_generate': { label: 'generó enlace de invitación', icon: 'link',            color: '#137333', category: 'school' },
  'school.invite_revoke':   { label: 'revocó enlace de invitación', icon: 'link_off',        color: '#ea8600', category: 'school' },

  // ── Sugerencias ───────────────────────────────────────────────────────────
  'suggestion.create':        { label: 'envió una sugerencia',     icon: 'lightbulb',        color: '#fbbc04', category: 'suggestion' },
  'suggestion.status_change': { label: 'marcó una sugerencia',     icon: 'check_circle',     color: '#137333', category: 'suggestion' },
  'suggestion.respond':       { label: 'respondió una sugerencia', icon: 'reply',            color: '#1a73e8', category: 'suggestion' },
  'suggestion.delete':        { label: 'eliminó una sugerencia',   icon: 'delete',           color: '#ea4335', category: 'suggestion' },

  // ── Importación desde Excel ──────────────────────────────────────────────
  'import.execute':       { label: 'ejecutó una importación',   icon: 'upload_file',        color: '#9334e6', category: 'import' },

  // ── Sistema (backup / restore / mantenimiento — solo dueño del sistema) ──
  'system.backup_create':    { label: 'generó un backup',           icon: 'cloud_download', color: '#137333', category: 'system' },
  'system.restore':          { label: 'restauró un backup',         icon: 'restore',        color: '#ea4335', category: 'system' },
  'system.maintenance_on':   { label: 'activó modo mantenimiento',  icon: 'engineering',    color: '#ea8600', category: 'system' },
  'system.maintenance_off':  { label: 'desactivó modo mantenimiento', icon: 'engineering',  color: '#137333', category: 'system' },
};

const CATEGORIES = {
  activity:     'Actividades',
  submission:   'Entregas',
  announcement: 'Novedades',
  course:       'Cursos',
  division:     'Divisiones',
  user:         'Usuarios',
  subject:      'Materias',
  school:       'Escuelas',
  suggestion:   'Sugerencias',
  import:       'Importación',
  system:       'Sistema',
  auth:         'Sesiones',
};

module.exports = { ACTIONS, CATEGORIES };
