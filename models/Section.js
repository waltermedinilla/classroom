const mongoose = require('mongoose');
const { Schema } = mongoose;

// Sección: un recorte del establecimiento con nombre, a cargo de uno o más "Jefes de
// Sección" (rol `jefe`). Es el alcance de ese rol, igual que assignedDivisions lo es del
// preceptor — pero con un grano más fino, porque una sección no coincide con una división
// ni con una materia: se arma a mano mezclando las dos cosas.
//
// ⚠️ NO CONFUNDIR con config/sections.js ni con middleware/sections.js. Aquéllas son las
// "secciones" en el sentido de SOLAPAS del panel (qué ve cada rol en el nav). Esto es una
// entidad de datos de la escuela. Comparten la palabra y nada más.
//
// Vocabulario del modelo, que va al revés del de la escuela:
//   Division = el "curso" de la escuela (1°1°)
//   Course   = la MATERIA dictada dentro de esa división
const sectionSchema = new Schema({
  name: {
    type: String,
    required: [true, 'El nombre de la sección es requerido'],
    trim: true,
  },
  school: {
    type: Schema.Types.ObjectId,
    ref: 'School',
    required: [true, 'La escuela es requerida'],
  },

  // ── Contenido de la sección ────────────────────────────────────────────────
  // Se guardan por separado A PROPÓSITO, y no aplanados a una lista de materias.
  //
  // `divisions` son cursos ENTEROS: incluir 1°1° significa "todas las materias de 1°1°,
  // las de hoy y las de mañana". Si se guardara la lista de materias que la división tiene
  // en el momento de armar la sección, quedaría congelada y una materia creada después
  // (o cargada con el alta masiva de /superadmin/otros) no entraría nunca. La resolución
  // es dinámica, en cada request — misma semántica que allDivisions:true del preceptor.
  //
  // `courses` son materias sueltas: "solo Matemática de 2°3°", sin el resto de la división.
  //
  // Los ids que quedan colgados (una materia borrada, una división movida de escuela) NO
  // rompen nada: middleware/jefatura.js resuelve el alcance con un find() acotado por
  // escuela, así que lo que ya no existe simplemente no vuelve. Igual los deletes de
  // Division y Course hacen $pull para que la sección no acumule basura.
  divisions: [{
    type: Schema.Types.ObjectId,
    ref: 'Division',
    default: [],
  }],
  courses: [{
    type: Schema.Types.ObjectId,
    ref: 'Course',
    default: [],
  }],

  // ── Jefes de la sección ────────────────────────────────────────────────────
  // La relación vive ACÁ y no como un `assignedSections` en User. Dos motivos:
  //   1. Es lo que se pidió: la sección se arma en una sola pantalla (contenido + jefes).
  //   2. No toca el schema de User, así que no hay migración ni backfill — y, sobre todo,
  //      no queda pegada al doc de usuario, que vive cacheado 45s en middleware/cache.js.
  //      Consecuencia útil: agregar o sacar un jefe tiene efecto en el request siguiente,
  //      sin invalidar nada. Lo único que sigue tardando hasta 45s es el cambio de ROL.
  //
  // Muchos a muchos: una sección puede tener varios jefes y un jefe varias secciones (su
  // alcance es la unión). Solo se aceptan usuarios con role 'jefe' de la misma escuela;
  // eso lo valida routes/admin.js al guardar, no el schema.
  heads: [{
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: [],
  }],
}, { timestamps: true });

// No puede haber dos secciones con el mismo nombre en la misma escuela. Mismo criterio que
// Division, y da el err.code === 11000 que las rutas del admin ya traducen a un 400 legible.
sectionSchema.index({ name: 1, school: 1 }, { unique: true });

// "Las secciones de este jefe" es la primera query de CADA request del panel /jefatura.
sectionSchema.index({ heads: 1 });

module.exports = mongoose.model('Section', sectionSchema);
