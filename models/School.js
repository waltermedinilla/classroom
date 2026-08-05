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
  // Token aleatorio de 48 hex chars; null = sin enlace activo
  inviteToken: { type: String, default: null },
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
}, { timestamps: true });

// Índice único sparse: solo indexa escuelas que tienen token activo (null no se indexa)
schoolSchema.index({ inviteToken: 1 }, { unique: true, sparse: true });

// Hook pre-validate: genera el slug automáticamente a partir del nombre si todavía no tiene uno
// Se ejecuta antes de la validación para que el slug esté disponible si el schema lo requiere
schoolSchema.pre('validate', function (next) {
  if (!this.slug && this.name) this.slug = slugify(this.name);
  next();
});

module.exports = mongoose.model('School', schoolSchema);
