const mongoose = require('mongoose');
const { Schema } = mongoose;

// Paleta de colores permitida para identificar visualmente cada escuela
const COLORS = ['#1a73e8','#34a853','#ea4335','#fbbc04','#9334e6','#0d7377','#e91e63','#ff5722','#795548','#607d8b'];

// Convierte un nombre a slug URL-friendly: minúsculas, sin tildes, sin caracteres especiales
// Ej: "Escuela N° 4039" → "escuela-n-4039"
const slugify = (str) =>
  str.toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // Elimina diacríticos (tildes, ñ → n, etc.)
    .replace(/[^a-z0-9\s-]/g, '')           // Elimina caracteres no alfanuméricos
    .replace(/\s+/g, '-').replace(/-+/g, '-');

const schoolSchema = new Schema({
  name:        { type: String, required: [true, 'El nombre es requerido'], trim: true, unique: true },
  // Slug generado automáticamente desde name en el hook pre-validate (ver abajo)
  // Usado para URLs amigables y como identificador alternativo
  slug:        { type: String, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '', trim: true },
  // Color de la escuela (restringido a la paleta COLORS); se muestra en badges y encabezados del panel
  color:       { type: String, default: '#1a73e8', enum: { values: COLORS, message: 'Color no válido' } },
  // Token aleatorio de 48 hex chars. "Sin enlace activo" se representa con el campo
  // AUSENTE, no con null, y eso NO es un detalle de estilo: el índice de abajo es
  // `sparse`, y sparse saltea los documentos donde el campo no está — uno que vale `null`
  // sí está y sí se indexa. Con `default: null`, toda escuela nacía ocupando el mismo
  // casillero del índice único y la SEGUNDA escuela que se creara chocaba contra la
  // primera: 400 "Ya existe una escuela con ese nombre", con el nombre de rehén de un
  // problema que no era del nombre. Como en producción hay una sola escuela, el botón
  // "Nueva escuela" nunca había funcionado y nadie podía saberlo.
  // Todo el código que lo lee usa truthiness (`school.inviteToken ? …`), así que undefined
  // y null se comportan igual: el cambio no se ve en ninguna pantalla.
  // Smoke: superadmin-crea-dos-escuelas.
  inviteToken: { type: String },
  // Temas visuales ofrecidos por el superadmin; cada uno aceptado/rechazado por el admin
  themes: [{
    slug:       { type: String },
    status:     { type: String, enum: ['offered', 'accepted', 'rejected'], default: 'offered' },
    offeredBy:  { type: Schema.Types.ObjectId, ref: 'User' },
    startDate:  { type: String, default: null }, // "MM-DD"
    endDate:    { type: String, default: null }, // "MM-DD"
    config:     { type: Schema.Types.Mixed, default: {} },
  }],
  // Ajustes que el admin de la escuela controla desde /admin/tasks.
  // Ojo: lo que se agregue acá hay que sumarlo al .select() de server.js que arma
  // res.locals.school, o el campo nunca llega a las vistas (el doc va cacheado).
  settings: {
    // Si está en true, al alumno se le avisa en el detalle de la actividad que el docente
    // puede ver que la abrió. El registro del acuse (ActivityView) ocurre siempre: este
    // flag solo controla la transparencia hacia el alumno.
    // Default false para no cambiarle el comportamiento a las escuelas existentes sin que
    // el admin lo decida.
    showViewReceiptToStudents: { type: Boolean, default: false },
  },
  // Permisos de solapas por rol, que configura el SUPERADMIN desde /superadmin/roles.
  // Formato: { <rol>: [<sectionKey>, ...] } — se listan SOLO las secciones DENEGADAS.
  // Campo ausente, rol ausente o array vacío = la escuela usa los defaults del catálogo
  // (config/sections.js). Por eso las escuelas existentes no necesitan migración.
  //
  // Por qué DENEGADAS y no habilitadas: una solapa nueva que se sume al catálogo aparece
  // sola, con su default, sin que nadie tenga que volver a guardar escuela por escuela.
  // Con una lista de habilitadas quedaría invisible hasta que alguien la tildara.
  //
  // Por qué NO va adentro de `settings`: ese namespace lo edita el ADMIN de la escuela
  // desde /admin/tasks (lista blanca TASK_SETTINGS en routes/admin.js). Si esto viviera
  // ahí, sumar una key a esa lista por error le daría al admin la llave para
  // desbloquearse sus propias solapas. Son dos dueños distintos, dos campos distintos.
  //
  // Ojo: mismo caveat que `settings` (ver arriba) — está en el .select() de server.js;
  // si se saca de ahí, el campo no llega y la restricción queda muda.
  rolePermissions: { type: Schema.Types.Mixed, default: undefined },

  // Quién puede LEER los legajos del Servicio de Orientación Escolar, y cuánto de ellos.
  // Lo configura el SUPERADMIN desde /superadmin/roles. Ver specs/soe-orientacion.spec.md.
  //
  // Por qué NO va por config/sections.js como el resto de los permisos: aquel sistema es
  // restrictivo y fail-open — solo puede QUITAR lo que los middlewares ya conceden, y todo
  // lo que no está denegado pasa. Es lo correcto para una solapa de "Materias" y lo
  // equivocado para una historia psicopedagógica: acá el default tiene que ser CERRADO y la
  // configuración tiene que AGREGAR acceso, no quitarlo.
  //
  // Por qué tampoco va adentro de `settings`: ese namespace lo edita el admin de la escuela
  // desde /admin/tasks. El admin no puede ser quien se habilita a sí mismo a leer legajos.
  // Mismo razonamiento que `rolePermissions` acá arriba.
  //
  // Escuela sin el campo (todas las que existen hoy) = todos en 'none': solo el SOE. Sin
  // migración y sin cambiarle el comportamiento a nadie.
  //
  // 'soe' y 'superadmin' NO figuran acá y no son configurables: el primero es el dueño del
  // legajo, el segundo tiene la base entera igual (y su lectura queda auditada).
  //
  // ⚠️ Preceptor y docente topean en 'resumen' — el enum de acá lo impide del lado del
  // guardado, pero el techo REAL lo aplica services/soeAcceso.js: un valor escrito a mano
  // con mongosh no pasa por esta validación.
  //
  // ⚠️ Mismo caveat que `settings` y `rolePermissions`: está en el .select() de server.js.
  // Si se saca de ahí, el campo no llega a las vistas y la guarda queda muda.
  soeAccess: {
    directivo: { type: String, enum: ['none', 'resumen', 'completo'], default: 'none' },
    admin:     { type: String, enum: ['none', 'resumen', 'completo'], default: 'none' },
    preceptor: { type: String, enum: ['none', 'resumen'],             default: 'none' },
    teacher:   { type: String, enum: ['none', 'resumen'],             default: 'none' },
  },

  // Módulos OPCIONALES prendidos para esta escuela. Catálogo en config/modulos.js,
  // enforcement en middleware/modulos.js, y lo prende el SUPERADMIN desde
  // /superadmin/schools.
  //
  // Un módulo es una funcionalidad entera que no existe para la escuela que no la usa
  // (reservas de recursos; más adelante cuotas y conectores externos). Es otra cosa que
  // `rolePermissions`, que reparte entre roles lo que ya existe para todos.
  //
  // Por qué NO va adentro de `settings`: mismo motivo que rolePermissions acá arriba y que
  // soeAccess acá abajo. `settings` lo edita el ADMIN de la escuela desde /admin/tasks
  // (lista blanca TASK_SETTINGS en routes/admin.js); si esto viviera ahí, sumar una key a
  // esa lista por error le daría al admin la llave para prenderse sus propios módulos.
  //
  // Escuela sin el campo (todas las que existen hoy) = todos apagados, que es exactamente
  // el comportamiento de antes de que el módulo existiera. Sin migración.
  //
  // ⚠️ Mismo caveat que los tres campos de arriba: está en el .select() de server.js que
  // arma res.locals.school. Si se saca de ahí, moduloActivo() lee undefined, contesta que
  // no —es fail-closed— y el módulo queda invisible sin que nadie lo haya apagado.
  modules: {
    recursos: {
      enabled: { type: Boolean, default: false },
    },
  },
}, { timestamps: true });

// Índice único sparse: solo indexa las escuelas donde el campo EXISTE.
//
// ⚠️ El comentario original de esta línea decía "null no se indexa" y era falso: `sparse`
// mira si el campo está presente, no su valor. Un `null` explícito se indexa como cualquier
// otro valor, y por eso dos escuelas sin enlace chocaban entre sí. Se arregló del lado del
// documento (arriba: sin `default`, y `$unset` al revocar), que es lo que NO obliga a tocar
// la base de producción.
//
// El arreglo de fondo sería cambiar este índice por uno parcial:
//   { unique: true, partialFilterExpression: { inviteToken: { $type: 'string' } } }
// que además protegería contra cualquier `null` que se cuele en el futuro. Requiere
// dropIndex + createIndex sobre la base de PRODUCCIÓN, así que se avisa antes y se hace
// aparte. Mientras tanto, la única escuela que hoy tiene `inviteToken: null` guardado no
// molesta: un solo null es válido para un índice único.
schoolSchema.index({ inviteToken: 1 }, { unique: true, sparse: true });

// Hook pre-validate: genera el slug automáticamente a partir del nombre si todavía no tiene uno
// Se ejecuta antes de la validación para que el slug esté disponible si el schema lo requiere
schoolSchema.pre('validate', function (next) {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  next();
});

module.exports = mongoose.model('School', schoolSchema);
