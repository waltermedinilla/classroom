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
  // Tema visual ofrecido por el superadmin; aceptado/rechazado/configurado por el admin
  theme: {
    slug:      { type: String, default: null },
    status:    { type: String, enum: ['offered', 'accepted', 'rejected'], default: null },
    offeredBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    config: {
      confetti:       { type: Boolean, default: true },
      buttonBorder:   { type: Boolean, default: true },
      navColors:      { type: Boolean, default: true },
      flags:          { type: Boolean, default: true },
      confettiCount:  { type: Number,  default: 30 },
      confettiSpeed:  { type: String,  default: 'normal' },
    },
  },
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
