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
  'announcement.edit':    { label: 'editó una novedad',        icon: 'edit',                 color: '#0d7377', category: 'announcement' },
  'announcement.delete':  { label: 'eliminó una novedad',      icon: 'delete',               color: '#ea4335', category: 'announcement' },

  // ── Cursos (Course = Materia dictada en una división) ─────────────────────
  'course.create':         { label: 'creó un curso',            icon: 'add_circle',           color: '#1a73e8', category: 'course' },
  'course.edit':           { label: 'editó un curso',           icon: 'edit',                 color: '#1a73e8', category: 'course' },
  'course.delete':         { label: 'eliminó un curso',         icon: 'delete_forever',       color: '#ea4335', category: 'course' },
  'course.join':           { label: 'se unió a un curso',       icon: 'group_add',            color: '#137333', category: 'course' },
  'course.add_student':    { label: 'agregó un alumno',         icon: 'person_add',           color: '#137333', category: 'course' },
  'course.remove_student': { label: 'quitó un alumno',          icon: 'person_remove',        color: '#ea8600', category: 'course' },
  'course.assign_teacher': { label: 'asignó docente',           icon: 'assignment_ind',       color: '#1a73e8', category: 'course' },
  'course.add_coteacher':  { label: 'agregó un suplente',       icon: 'group_add',            color: '#1a73e8', category: 'course' },
  'course.remove_coteacher': { label: 'quitó un suplente',      icon: 'group_remove',         color: '#ea8600', category: 'course' },
  'course.merge':           { label: 'fusionó materias duplicadas', icon: 'merge_type',       color: '#9334e6', category: 'course' },

  // ── Sala en vivo (models/RoomSession.js) ──────────────────────────────────
  // 'room.observe' es el ingreso SILENCIOSO del equipo directivo: no deja rastro dentro de la
  // sala (no aparece su círculo ni hay aviso), así que este registro es el único lugar donde
  // queda constancia. Silencioso para la clase, visible para la institución.
  'room.open':           { label: 'abrió la sala en vivo',           icon: 'sensors',     color: '#137333', category: 'course' },
  'room.close':          { label: 'cerró la sala en vivo',           icon: 'sensors_off', color: '#ea8600', category: 'course' },
  'room.observe':        { label: 'observó una sala en vivo',        icon: 'visibility',  color: '#9334e6', category: 'course' },
  'room.join_staff':     { label: 'ingresó a una sala en vivo',      icon: 'login',       color: '#0d7377', category: 'course' },
  // Compartir un archivo se audita aunque solo lo pueda hacer quien da la clase: es la única
  // forma de contenido que la plataforma reparte a un curso entero y que no es texto, y el
  // registro (qué archivo, en qué clase) es lo que permite responder una consulta después.
  'room.share_file':     { label: 'compartió un archivo en la sala', icon: 'attach_file', color: '#1a73e8', category: 'course' },
  'room.delete_message': { label: 'borró un mensaje de la sala',     icon: 'delete',      color: '#ea4335', category: 'course' },
  'room.mute':           { label: 'silenció a un alumno en la sala', icon: 'volume_off',  color: '#ea8600', category: 'course' },

  // Asistencia de preceptoría. Categoría 'division' y no 'course' porque la asistencia es
  // del CURSO (3°2°), no de una materia.
  // 'attendance.change' se registra SOLO cuando se pisa una marca que ya tenía estado: el
  // pase de lista normal son 30 marcas por curso y por día, y auditarlas todas dejaría la
  // pantalla de auditoría inservible. Quién marcó y cuándo ya vive en la marca misma.
  'attendance.open':   { label: 'abrió la toma de asistencia', icon: 'fact_check', color: '#137333', category: 'division' },
  'attendance.close':  { label: 'cerró la toma de asistencia', icon: 'task_alt',   color: '#ea8600', category: 'division' },
  'attendance.change': { label: 'corrigió una asistencia',     icon: 'edit_note',  color: '#9334e6', category: 'division' },
  'attendance.reopen': { label: 'reabrió la toma de asistencia', icon: 'lock_open', color: '#ea8600', category: 'division' },

  // ── Divisiones (Division = "1°1°", "2°A", etc.) ───────────────────────────
  'division.create':      { label: 'creó una división',        icon: 'add_box',              color: '#1a73e8', category: 'division' },
  'division.edit':        { label: 'editó una división',       icon: 'edit',                 color: '#1a73e8', category: 'division' },
  'division.delete':      { label: 'eliminó una división',     icon: 'delete',               color: '#ea4335', category: 'division' },

  // ── Secciones (Section = recorte con nombre a cargo de un Jefe de Sección) ─
  // OJO: no son las "secciones" de config/sections.js (esas son las solapas del panel).
  'section.create':       { label: 'creó una sección',         icon: 'groups',               color: '#1a73e8', category: 'section' },
  'section.edit':         { label: 'editó una sección',        icon: 'edit',                 color: '#1a73e8', category: 'section' },
  'section.delete':       { label: 'eliminó una sección',      icon: 'delete',               color: '#ea4335', category: 'section' },

  // ── Usuarios ──────────────────────────────────────────────────────────────
  'user.create':          { label: 'creó un usuario',          icon: 'person_add',           color: '#137333', category: 'user' },
  'user.edit':            { label: 'editó los datos de',       icon: 'edit',                 color: '#1a73e8', category: 'user' },
  'user.delete':          { label: 'eliminó un usuario',       icon: 'person_remove',        color: '#ea4335', category: 'user' },
  // Alcance del preceptor: qué divisiones puede ver y administrar (ver models/User.js)
  'user.assign_divisions': { label: 'asignó cursos a',          icon: 'checklist',           color: '#1a73e8', category: 'user' },
  // Matrícula del docente en varias materias desde su perfil (POST /admin/users/:id/courses)
  'user.assign_courses':  { label: 'asignó materias a',         icon: 'library_add',          color: '#1a73e8', category: 'user' },
  'user.role_change':     { label: 'cambió el rol de',         icon: 'admin_panel_settings', color: '#9334e6', category: 'user' },
  'user.toggle_active':   { label: 'cambió el estado de',      icon: 'toggle_on',            color: '#ea8600', category: 'user' },
  'user.reset_password':  { label: 'reseteó la contraseña de', icon: 'lock_reset',           color: '#ea8600', category: 'user' },
  'user.password_change': { label: 'cambió su contraseña',     icon: 'password',             color: '#5f6368', category: 'user' },
  'user.email_change':    { label: 'cambió su correo',         icon: 'alternate_email',      color: '#5f6368', category: 'user' },
  'user.contact_change':  { label: 'actualizó su contacto',    icon: 'contact_phone',        color: '#5f6368', category: 'user' },
  'user.impersonate':     { label: 'inició suplantación de',   icon: 'visibility',           color: '#9334e6', category: 'user' },
  'user.bulk_role':       { label: 'cambió el rol en masa',    icon: 'group',                color: '#9334e6', category: 'user' },
  'user.bulk_school':     { label: 'asignó escuela en masa',   icon: 'group',                color: '#1a73e8', category: 'user' },
  'user.school_change':   { label: 'cambió la escuela de',     icon: 'swap_horiz',           color: '#1a73e8', category: 'user' },
  // Fusión de dos cuentas de la misma persona desde /superadmin/otros (docentes con el
  // mismo DNI). El primer target es la cuenta que se conserva; los siguientes, las sobrantes.
  'user.merge':           { label: 'fusionó cuentas de',       icon: 'merge_type',           color: '#9334e6', category: 'user' },

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
  // Ajustes de la escuela que edita el ADMIN desde /admin/tasks (a diferencia del resto
  // de school.*, que son del superadmin). El meta guarda qué ajuste cambió y a qué valor.
  'school.settings_update': { label: 'cambió un ajuste de la escuela', icon: 'tune',         color: '#1a73e8', category: 'school' },
  // Permisos de solapas por rol que el SUPERADMIN configura en /superadmin/roles. El meta
  // guarda qué rol, qué sección y si quedó habilitada (seccion:'todas' = se restablecieron
  // los valores por defecto de ese rol).
  'school.role_permissions_update': { label: 'cambió los permisos de un rol', icon: 'admin_panel_settings', color: '#9334e6', category: 'school' },

  // ── Sugerencias ───────────────────────────────────────────────────────────
  'suggestion.create':        { label: 'envió una sugerencia',     icon: 'lightbulb',        color: '#fbbc04', category: 'suggestion' },
  'suggestion.status_change': { label: 'marcó una sugerencia',     icon: 'check_circle',     color: '#137333', category: 'suggestion' },
  'suggestion.respond':       { label: 'respondió una sugerencia', icon: 'reply',            color: '#1a73e8', category: 'suggestion' },
  // El usuario contesta la respuesta del equipo y sigue el hilo (POST /suggestions/mine/:id/reply)
  'suggestion.reply':         { label: 'siguió el hilo de',        icon: 'forum',            color: '#fbbc04', category: 'suggestion' },
  'suggestion.delete':        { label: 'eliminó una sugerencia',   icon: 'delete',           color: '#ea4335', category: 'suggestion' },

  // ── Mensajes del superadministrador (models/Message.js) ──────────────────
  // 'message.send' es el único que puede tocar cientos de documentos de una: su meta guarda
  // la cantidad de destinatarios y la audiencia en español, que es lo que hace falta para
  // reconstruir "¿a quién le llegó esto?" sin abrir el panel.
  'message.send':           { label: 'envió un mensaje',                    icon: 'send',      color: '#1a73e8', category: 'message' },
  'message.reply':          { label: 'respondió un mensaje',                icon: 'reply',     color: '#137333', category: 'message' },
  'message.staff_reply':    { label: 'siguió el hilo de un mensaje',        icon: 'forum',     color: '#1a73e8', category: 'message' },
  'message.toggle_replies': { label: 'cambió las respuestas de un mensaje', icon: 'lock_open', color: '#ea8600', category: 'message' },
  'message.delete':         { label: 'eliminó un mensaje enviado',          icon: 'delete',    color: '#ea4335', category: 'message' },

  // ── Importación desde Excel ──────────────────────────────────────────────
  'import.execute':       { label: 'ejecutó una importación',   icon: 'upload_file',        color: '#9334e6', category: 'import' },

  // ── Sistema (backup / restore / mantenimiento — solo dueño del sistema) ──
  'system.backup_create':    { label: 'generó un backup',           icon: 'cloud_download', color: '#137333', category: 'system' },
  'system.restore':          { label: 'restauró un backup',         icon: 'restore',        color: '#ea4335', category: 'system' },
  'system.maintenance_on':   { label: 'activó modo mantenimiento',  icon: 'engineering',    color: '#ea8600', category: 'system' },
  'system.maintenance_off':  { label: 'desactivó modo mantenimiento', icon: 'engineering',  color: '#137333', category: 'system' },
  // Ventana de mantenimiento: se pide y el sistema espera a que la plataforma se vacíe.
  // Cuando finalmente se activa (sola o por vencimiento del tope) el evento que queda es
  // 'system.maintenance_on' con meta.automatico — así el filtro por "mantenimiento
  // activado" encuentra los tres orígenes (manual, restore y automático) juntos.
  'system.maintenance_scheduled': { label: 'programó un mantenimiento en espera', icon: 'schedule',    color: '#ea8600', category: 'system' },
  'system.maintenance_cancelled': { label: 'canceló el mantenimiento en espera',  icon: 'event_busy',  color: '#5f6368', category: 'system' },
  // Arreglos directos a la base desde /superadmin/otros (ver services/dbFixes.js)
  'system.db_fix':           { label: 'aplicó un arreglo a la base', icon: 'healing',       color: '#9334e6', category: 'system' },
};

const CATEGORIES = {
  activity:     'Actividades',
  submission:   'Entregas',
  announcement: 'Novedades',
  course:       'Cursos',
  division:     'Divisiones',
  section:      'Secciones',
  user:         'Usuarios',
  subject:      'Materias',
  school:       'Escuelas',
  suggestion:   'Sugerencias',
  message:      'Mensajes',
  import:       'Importación',
  system:       'Sistema',
  auth:         'Sesiones',
};

module.exports = { ACTIONS, CATEGORIES };
