// Catálogo ÚNICO de las solapas cuyo acceso se puede habilitar/deshabilitar por rol
// desde /superadmin/roles. Lo leen tres lugares y tienen que coincidir, o la solapa se
// ve pero la ruta tira 403 (o peor, al revés: se oculta y sigue accesible):
//   - views/partials/*-nav.ejs y el drawer de header.ejs  → qué se pinta   (vía res.locals.can)
//   - middleware/sections.js                              → qué se deja pasar
//   - views/superadmin/roles.ejs                          → qué se puede configurar
//
// El sistema es RESTRICTIVO: solo puede QUITAR lo que los middlewares de rol que ya
// existen (middleware/admin.js, directivo.js, preceptor.js) conceden — nunca agregar.
// Esos middlewares no se tocaron: este catálogo corre DESPUÉS de ellos. Así una
// configuración mal hecha jamás puede escalar privilegios, y si algo falla acá el
// comportamiento que queda es el de siempre.
//
// Campos de cada sección:
//   key       lo que se guarda en School.rolePermissions. NO cambiarlo nunca aunque
//             cambie el label. Sin puntos, para no pelear con las rutas de Mongo.
//   panel     agrupa la sección con el router/nav que la sirve. sectionGuard(panel) usa
//             esto para saber qué paths tiene que vigilar.
//   label     nombre visible (el mismo que muestra el nav).
//   icon      material symbol, para que la pantalla de Roles se lea igual que el nav.
//   path      prefijo de URL que cubre la sección, incluidos sus sub-paths y sus POST.
//   roles     acceso BASE, espejo de los middlewares de rol. Un rol que no está acá no
//             ve la sección aunque la escuela la habilite.
//   locked    no se puede deshabilitar nunca (ver más abajo el porqué de cada una).
//   flag      nombre del feature flag global de res.locals que además tiene que estar
//             prendido (hoy solo 'taskTemplatesEnabled').
//   ownerOnly la sección ya está atada al email del dueño (config/maintenance.js). El
//             flag acá es SOLO para que la pantalla explique el candado; la guarda real
//             sigue viviendo en routes/backup.js y routes/dbFixes.js.
//   needsSchool la pantalla administra datos de UNA escuela y necesita que el usuario tenga
//             la suya. El superadmin NO tiene (school: null), así que estas solapas no se
//             le pintan: antes se las ofrecía el nav de /admin y morían en "Escuela no
//             encontrada". Lo resuelve res.locals.can en server.js, que es el único lugar
//             por donde pasan todos los navs. No es una restricción de permisos —el acceso
//             base sigue igual y la ruta sigue contestando lo mismo si se escribe la URL a
//             mano—: es no ofrecer una puerta que da a una pared.
//
// INVARIANTE: los `*_dashboard` y `app_courses` van locked porque son los destinos del
// redirect de "/" (server.js). Si alguna vez se desbloquean, ese redirect necesita una
// cadena de fallback o el usuario cae en su propio 403 apenas entra a la app.
const SECTIONS = [
  // ── Panel Administración (base: middleware/admin.js requireAdmin) ──────────
  { key: 'admin_dashboard',      panel: 'admin', label: 'Resumen',    icon: 'dashboard',    path: '/admin',                roles: ['admin', 'superadmin'], locked: true },
  { key: 'admin_users',          panel: 'admin', label: 'Usuarios',   icon: 'people',       path: '/admin/users',          roles: ['admin', 'superadmin'] },
  { key: 'admin_divisions',      panel: 'admin', label: 'Cursos',     icon: 'class',        path: '/admin/divisions',      roles: ['admin', 'superadmin'] },
  { key: 'admin_courses',        panel: 'admin', label: 'Materias',   icon: 'menu_book',    path: '/admin/courses',        roles: ['admin', 'superadmin'] },
  { key: 'admin_subjects',       panel: 'admin', label: 'Catálogo',   icon: 'auto_stories', path: '/admin/subjects',       roles: ['admin', 'superadmin'] },
  // Secciones = el alcance del rol Jefe de Sección (models/Section.js). Nada que ver con
  // las "secciones" de este archivo, que son las solapas — coinciden en la palabra y nada más.
  // El rol `jefe` entra a esta solapa para configurar las secciones que tiene a cargo — es
  // la única del panel de admin que ve, y la sirve routes/sections.js, no routes/admin.js.
  { key: 'admin_sections',       panel: 'admin', label: 'Secciones',  icon: 'groups',       path: '/admin/secciones',      roles: ['admin', 'superadmin', 'jefe'] },
  { key: 'admin_import',         panel: 'admin', label: 'Importar',   icon: 'upload_file',  path: '/admin/import',         roles: ['admin', 'superadmin'] },
  { key: 'admin_audit',          panel: 'admin', label: 'Auditoría',  icon: 'history',      path: '/admin/audit',          roles: ['admin', 'superadmin'] },
  // Las tres de abajo editan la configuración de UNA escuela (el tema, las tareas y las
  // plantillas asignadas): sin escuela propia no hay nada que abrir. De ahí el needsSchool.
  { key: 'admin_theme',          panel: 'admin', label: 'Tema',       icon: 'palette',      path: '/admin/theme',          roles: ['admin', 'superadmin'], needsSchool: true },
  { key: 'admin_tasks',          panel: 'admin', label: 'Tareas',     icon: 'checklist',    path: '/admin/tasks',          roles: ['admin', 'superadmin'], needsSchool: true },
  { key: 'admin_task_templates', panel: 'admin', label: 'Plantillas', icon: 'assignment',   path: '/admin/task-templates', roles: ['admin', 'superadmin'], flag: 'taskTemplatesEnabled', needsSchool: true },
  // Recursos y reservas. El `flag` acá NO sale de una variable de entorno como
  // taskTemplatesEnabled: sale de School.modules (ver config/modulos.js), así que cambia de
  // escuela en escuela. server.js lo publica en res.locals con este mismo nombre.
  //
  // ⚠️ El flag solo esconde la solapa. Quien BLOQUEA la ruta es requireModulo('recursos') en
  // el propio router: sectionGuard es fail-open y dejaría pasar una URL escrita a mano, y el
  // montaje condicional que usa /superadmin/tasks no sirve para un flag por escuela (el
  // montaje ocurre al arrancar, cuando todavía no hay request del que sacar la escuela).
  { key: 'admin_recursos',       panel: 'admin', label: 'Recursos',   icon: 'event_seat',   path: '/admin/recursos',       roles: ['admin', 'superadmin'], flag: 'recursosEnabled',     needsSchool: true },

  // ── Panel Directivo (base: middleware/directivo.js) ────────────────────────
  { key: 'directivo_dashboard', panel: 'directivo', label: 'Resumen',    icon: 'dashboard', path: '/directivo',           roles: ['directivo', 'admin', 'superadmin'], locked: true },
  { key: 'directivo_courses',   panel: 'directivo', label: 'Materias',   icon: 'menu_book', path: '/directivo/courses',   roles: ['directivo', 'admin', 'superadmin'] },
  { key: 'directivo_divisions', panel: 'directivo', label: 'Divisiones', icon: 'school',    path: '/directivo/divisions', roles: ['directivo', 'admin', 'superadmin'] },
  { key: 'directivo_students',  panel: 'directivo', label: 'Alumnos',    icon: 'group',     path: '/directivo/students',  roles: ['directivo', 'admin', 'superadmin'] },
  { key: 'directivo_teachers',  panel: 'directivo', label: 'Docentes',   icon: 'badge',     path: '/directivo/teachers',  roles: ['directivo', 'admin', 'superadmin'] },
  { key: 'directivo_grades',    panel: 'directivo', label: 'Promedios',  icon: 'grade',     path: '/directivo/grades',    roles: ['directivo', 'admin', 'superadmin'] },
  // Clases que se están dictando ahora (salas en vivo). Se puede apagar por escuela: mirar
  // una clase en curso es una capacidad institucionalmente sensible y no toda escuela va a
  // querer dársela a dirección.
  { key: 'directivo_envivo',    panel: 'directivo', label: 'En vivo',    icon: 'sensors',   path: '/directivo/en-vivo',   roles: ['directivo', 'admin', 'superadmin'] },
  // Qué materias dejaron actividad en un rango de fechas y cuáles no. Es la hermana institucional
  // de 'preceptor_actividades': misma regla, pero sobre toda la escuela y por rango en vez de un
  // mes por división. Configurable por el mismo motivo que aquella: es seguimiento de la
  // producción docente, y quién puede mirarlo cambia de escuela en escuela.
  { key: 'directivo_actividades', panel: 'directivo', label: 'Actividades Diarias', icon: 'event_note', path: '/directivo/actividades-diarias', roles: ['directivo', 'admin', 'superadmin'] },

  // ── Panel Preceptoría (base: middleware/preceptor.js ROLES_CON_ACCESO) ─────
  // Es la única solapa del panel: deshabilitarla equivale a borrarle el rol a alguien,
  // que no es lo que esta pantalla resuelve. Si algún día hace falta, lo correcto es un
  // flag "rol habilitado" aparte.
  { key: 'preceptor_dashboard', panel: 'preceptor', label: 'Mis cursos', icon: 'school', path: '/preceptor', roles: ['preceptor', 'directivo', 'admin', 'superadmin'], locked: true },
  // Primera solapa CONFIGURABLE de este panel: a diferencia del dashboard, apagarla no deja a
  // nadie afuera del panel (la INVARIANTE del redirect de "/" sigue apuntando al dashboard,
  // que sigue locked). Muestra las salas en vivo de las divisiones a cargo del preceptor.
  { key: 'preceptor_envivo',    panel: 'preceptor', label: 'En vivo',    icon: 'sensors', path: '/preceptor/en-vivo', roles: ['preceptor', 'directivo', 'admin', 'superadmin'] },
  // La toma de asistencia del día, por curso. También configurable: hay escuelas donde la
  // asistencia la lleva otro sistema y ofrecerla al pedo confunde más de lo que ayuda.
  { key: 'preceptor_asistencia', panel: 'preceptor', label: 'Asistencia', icon: 'fact_check', path: '/preceptor/asistencia', roles: ['preceptor', 'directivo', 'admin', 'superadmin'] },
  // Calendario del mes por curso: qué materias dejaron actividad cada día. También configurable
  // y por el mismo motivo que Asistencia: es seguimiento de la producción docente, y hay escuelas
  // donde eso lo mira dirección y no preceptoría.
  { key: 'preceptor_actividades', panel: 'preceptor', label: 'Actividades del día', icon: 'calendar_month', path: '/preceptor/actividades', roles: ['preceptor', 'directivo', 'admin', 'superadmin'] },

  // ── Panel Jefatura de Sección (base: middleware/jefatura.js ROLES_CON_ACCESO) ──
  // 'Actividades' es la pantalla de entrada del panel, por eso va locked (ver la INVARIANTE
  // de arriba). 'Docentes' sí se puede apagar: es una vista derivada de la misma información.
  { key: 'jefe_dashboard', panel: 'jefatura', label: 'Actividades', icon: 'assignment', path: '/jefatura',          roles: ['jefe', 'directivo', 'admin', 'superadmin'], locked: true },
  { key: 'jefe_teachers',  panel: 'jefatura', label: 'Docentes',    icon: 'badge',      path: '/jefatura/docentes', roles: ['jefe', 'directivo', 'admin', 'superadmin'] },

  // ── Panel Orientación Escolar (base: middleware/soe.js requireSoe) ─────────
  // ⚠️ ATENCIÓN, ACÁ LA REGLA ES DISTINTA. Que `directivo` y `admin` figuren en `roles` NO
  // les da acceso: este catálogo solo puede QUITAR (ver el encabezado del archivo), y quien
  // CONCEDE la entrada al panel es requireSoe leyendo School.soeAccess, que arranca cerrado
  // para todos menos el propio SOE. Están listados para que /superadmin/roles pueda pintar
  // la celda, y para que una escuela que les dio acceso pueda además apagarles una solapa.
  //
  // Preceptor y docente SÍ figuran en las dos primeras: su techo es 'resumen' (las fortalezas
  // del alumno y las estrategias acordadas para el aula), y si una escuela se lo habilita
  // tienen que tener dónde leerlo. En 'Derivaciones' NO están, porque esa pantalla nombra el
  // destino de cada derivación y 'resumen' está definido como "sabe que hay una en curso, sin
  // saber a dónde".
  //
  // ⚠️ Que estén o no en `roles` NO es lo que cierra esa puerta —sectionGuard es fail-open y
  // solo deniega lo explícitamente denegado—: la cierra `requireCompleto` en routes/soe.js.
  // Esta lista decide qué solapa se PINTA; aquella, a qué se puede ENTRAR.
  //
  // 'soe_dashboard' va locked por la INVARIANTE del archivo: es el destino del redirect de
  // "/" para el rol `soe` (server.js).
  { key: 'soe_dashboard',    panel: 'soe', label: 'Resumen',      icon: 'psychology', path: '/soe',              roles: ['soe', 'directivo', 'admin', 'superadmin', 'preceptor', 'teacher'], locked: true },
  { key: 'soe_alumnos',      panel: 'soe', label: 'Alumnos',      icon: 'group',      path: '/soe/alumnos',      roles: ['soe', 'directivo', 'admin', 'superadmin', 'preceptor', 'teacher'] },
  { key: 'soe_derivaciones', panel: 'soe', label: 'Derivaciones', icon: 'share',      path: '/soe/derivaciones', roles: ['soe', 'directivo', 'admin', 'superadmin'] },

  // ── General: los accesos del menú lateral (header.ejs) ─────────────────────
  { key: 'app_courses', panel: 'app', label: 'Mis clases',     icon: 'menu_book',       path: '/courses',               roles: ['admin', 'directivo', 'teacher', 'preceptor', 'jefe', 'soe', 'student'], locked: true },
  { key: 'app_profile', panel: 'app', label: 'Mi perfil',      icon: 'account_circle',  path: '/courses/profile',       roles: ['admin', 'directivo', 'teacher', 'preceptor', 'jefe', 'soe', 'student'] },
  { key: 'app_pending', panel: 'app', label: 'Mis pendientes', icon: 'pending_actions', path: '/activities/my-pending', roles: ['student'] },
  // El calendario de reservas, del lado de quien las pide. Incluye a `preceptor` y
  // `directivo` a propósito: el que organiza un acto o una jornada no siempre es docente.
  // Como este catálogo es restrictivo, la escuela que no lo quiera se lo apaga por rol desde
  // /superadmin/roles sin tocar una línea de código.
  // El alumno NO está: reservar la sala de computación es una decisión institucional.
  //
  // needsSchool: el calendario es el de UNA escuela. El superadmin no tiene
  // (school: null), así que no habría grilla que pintarle — mismo criterio que Tema, Tareas
  // y Plantillas. La solapa no se le ofrece y requireModulo, que es fail-closed sin escuela,
  // le contesta 403 si escribe la URL. Para ver el de una escuela concreta, impersona.
  { key: 'app_reservas', panel: 'app', label: 'Reservas', icon: 'calendar_month', path: '/reservas', roles: ['teacher', 'preceptor', 'directivo', 'jefe', 'admin', 'superadmin'], flag: 'recursosEnabled', needsSchool: true },

  // ── Panel Superadministración: TODO locked ────────────────────────────────
  // Decisión del usuario: el superadministrador no se restringe nunca, para que no exista
  // forma de quedarse afuera del panel desde donde se configura esto mismo.
  // Se catalogan igual (en vez de omitirlas) para que la pantalla de Roles pinte la columna
  // con candados y se vea POR QUÉ no se puede tocar, en lugar de mostrar un hueco.
  { key: 'superadmin_dashboard',   panel: 'superadmin', label: 'Resumen',     icon: 'dashboard',            path: '/superadmin',             roles: ['superadmin'], locked: true },
  { key: 'superadmin_schools',     panel: 'superadmin', label: 'Escuelas',    icon: 'domain',               path: '/superadmin/schools',     roles: ['superadmin'], locked: true },
  { key: 'superadmin_users',       panel: 'superadmin', label: 'Usuarios',    icon: 'people',               path: '/superadmin/users',       roles: ['superadmin'], locked: true },
  { key: 'superadmin_import',      panel: 'superadmin', label: 'Importar',    icon: 'upload_file',          path: '/superadmin/import',      roles: ['superadmin'], locked: true },
  { key: 'superadmin_suggestions', panel: 'superadmin', label: 'Sugerencias', icon: 'lightbulb',            path: '/superadmin/suggestions', roles: ['superadmin'], locked: true },
  // Vecina de Sugerencias a propósito: una es el correo que entra y la otra el que sale.
  { key: 'superadmin_messages',    panel: 'superadmin', label: 'Mensajes',    icon: 'forum',                path: '/superadmin/messages',    roles: ['superadmin'], locked: true },
  { key: 'superadmin_themes',      panel: 'superadmin', label: 'Temas',       icon: 'palette',              path: '/superadmin/themes',      roles: ['superadmin'], locked: true },
  { key: 'superadmin_roles',       panel: 'superadmin', label: 'Roles',       icon: 'admin_panel_settings', path: '/superadmin/roles',       roles: ['superadmin'], locked: true },
  { key: 'superadmin_tasks',       panel: 'superadmin', label: 'Tareas',      icon: 'assignment',           path: '/superadmin/tasks',       roles: ['superadmin'], locked: true, flag: 'taskTemplatesEnabled' },
  { key: 'superadmin_monitor',     panel: 'superadmin', label: 'Monitor',     icon: 'monitor_heart',        path: '/superadmin/monitor',     roles: ['superadmin'], locked: true },
  { key: 'superadmin_audit',       panel: 'superadmin', label: 'Auditoría',   icon: 'history',              path: '/superadmin/audit',       roles: ['superadmin'], locked: true },
  { key: 'superadmin_backup',      panel: 'superadmin', label: 'Backup',      icon: 'backup',               path: '/superadmin/backup',      roles: ['superadmin'], locked: true, ownerOnly: true },
  { key: 'superadmin_otros',       panel: 'superadmin', label: 'Otros',       icon: 'healing',              path: '/superadmin/otros',       roles: ['superadmin'], locked: true, ownerOnly: true },
];

const SECTIONS_BY_KEY = Object.fromEntries(SECTIONS.map(s => [s.key, s]));

// Orden en que se muestran los paneles en la pantalla de Roles. Superadministración va
// última: es toda de solo lectura, informativa.
const PANELS = [
  { id: 'admin',      label: 'Administración' },
  { id: 'directivo',  label: 'Directivo' },
  { id: 'preceptor',  label: 'Preceptoría' },
  { id: 'jefatura',   label: 'Jefatura de Sección' },
  { id: 'soe',        label: 'Orientación Escolar' },
  { id: 'app',        label: 'General' },
  { id: 'superadmin', label: 'Superadministración' },
];

const sectionsForPanel = (panel) => SECTIONS.filter(s => s.panel === panel);

// ¿La escuela le prohibió esta sección a este rol?
// Restrictivo puro: solo mira la lista de DENEGADAS. El acceso base lo sigue decidiendo
// requireAdmin y compañía — esta función no reemplaza a nadie, se suma.
// Todo lo que no está explícitamente denegado, pasa (fail-open): así una escuela sin
// configurar, un rol sin entrada o una key que este código todavía no conoce se comportan
// exactamente como antes de que existiera esta función.
function isDenied(school, role, key) {
  const sec = SECTIONS_BY_KEY[key];
  if (!sec)                  return false; // sección desconocida
  if (role === 'superadmin') return false; // nunca se auto-bloquea
  if (sec.locked)            return false;
  if (!school)               return false; // usuario sin escuela → defaults
  const denied = school.rolePermissions && school.rolePermissions[role];
  return Array.isArray(denied) && denied.includes(key);
}

// ¿Este rol tiene que VER esta solapa? Acceso base + no denegada. La usa el nav.
function isAllowed(school, role, key) {
  const sec = SECTIONS_BY_KEY[key];
  if (!sec)  return true;   // key desconocida: no escondemos nada por las dudas
  if (!role) return false;
  if (!sec.roles.includes(role)) return false;
  return !isDenied(school, role, key);
}

// ¿Se puede configurar esta celda (rol × sección) desde /superadmin/roles?
// Una sola función para el candado de la UI y la validación del POST, así no puede pasar
// que la pantalla muestre un toggle que el servidor rechaza (ni al revés).
const isConfigurable = (role, key) => {
  const sec = SECTIONS_BY_KEY[key];
  return !!sec
      && role !== 'superadmin'
      && !sec.locked
      && sec.panel !== 'superadmin'
      && !sec.ownerOnly
      && sec.roles.includes(role);
};

// Reemplaza los segmentos con forma de ObjectId (24 hex) por ":id", para que
// "/courses/64f2.../grades" y "/courses/64ab.../grades" caigan bajo el mismo nombre de
// pantalla en vez de generar un evento distinto por cada curso. La usa la analítica
// (public/js/analytics.js) como nombre de pantalla de respaldo para rutas que no están
// en el catálogo de arriba (dashboard de materias, detalle de curso, login, register...).
function normalizePath(url) {
  const clean = (url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return clean.replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, '/:id');
}

// Busca, entre TODAS las secciones (sin importar el panel), la que tiene el path más largo
// que matchea la URL — mismo criterio de "prefijo más largo gana" que sectionGuard en
// middleware/sections.js, pero sin acotarse a un panel. La usa la analítica para nombrar
// la pantalla actual con la MISMA clave que ya usan el nav y /superadmin/roles: así
// "Importar" es "admin_import" en el menú, en el enforcement y en los reportes.
//
// Se duplica la lógica de matcheo en vez de reusar sectionGuard a propósito: esa función
// vive en el camino de autorización (ya cubierta por 167 smoke tests) y no vale la pena
// arriesgar una regresión ahí por compartir código con una feature de solo lectura.
function sectionForPath(url) {
  const clean = (url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  let best = null;
  for (const s of SECTIONS) {
    if (clean === s.path || clean.startsWith(s.path + '/')) {
      if (!best || s.path.length > best.path.length) best = s;
    }
  }
  return best;
}

module.exports = {
  SECTIONS, SECTIONS_BY_KEY, PANELS, sectionsForPanel, isDenied, isAllowed, isConfigurable,
  normalizePath, sectionForPath,
};
