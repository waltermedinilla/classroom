const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// Lista completa de roles válidos en el sistema (en orden de jerarquía descendente)
// 'jefe' = Jefe de Sección: ve, sin poder tocar nada, las actividades de las materias de
// las Secciones que tiene a cargo (models/Section.js). Su alcance NO vive acá: vive en
// Section.heads, así que agregarlo o sacarlo de una sección no pasa por el cache de 45s
// de este documento — solo el cambio de rol sí.
const ROLES = ['superadmin', 'admin', 'directivo', 'teacher', 'preceptor', 'jefe', 'soe', 'student'];

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,       // Índice único global entre todas las escuelas
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [5, 'La contraseña debe tener al menos 5 caracteres'],
    // Se hashea automáticamente antes de guardar (ver hook pre-save)
  },
  role: {
    type: String,
    enum: ROLES,        // Solo acepta valores del array ROLES
    default: 'student',
  },
  school: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'School',
    default: null,      // null = superadmin (sin escuela) o usuario sin asignar
  },
  dni: {
    type: String,
    trim: true,
    default: null,      // Identificador argentino; puede estar ausente
  },
  active: {
    type: Boolean,
    default: true,      // false = cuenta deshabilitada (no puede iniciar sesión)
  },
  avatar: {
    type: String,
    default: null,      // URL pública del avatar; null = usar inicial del nombre
  },
  phone: {
    type: String,
    trim: true,
    default: null,      // Celular de contacto; se valida formato en la ruta, no acá
  },
  instagram: {
    type: String,
    trim: true,
    default: null,      // Solo el handle limpio (sin @ ni URL); el link se arma al mostrarlo
  },
  facebook: {
    type: String,
    trim: true,
    default: null,      // Solo el handle limpio (sin URL); el link se arma al mostrarlo
  },
  lastSeen: {
    type: Date,
    default: null,
  },

  // ── Alcance del preceptor ──────────────────────────────────────────────────
  // Qué divisiones (los "cursos" 1°1°, 2°3°… del lenguaje de la escuela) puede ver y
  // administrar un preceptor. Solo se leen cuando role === 'preceptor'; en cualquier
  // otro rol quedan en su default y se ignoran.
  //
  // FAIL-CLOSED A PROPÓSITO: no existe la convención "array vacío = todas". El rol
  // 'preceptor' se puede asignar por varios caminos que no preguntan por divisiones
  // (cambio de rol individual o en lote desde /admin y /superadmin), y en todos ellos
  // el usuario queda con allDivisions:false + assignedDivisions:[] — es decir, sin ver
  // nada hasta que un admin le asigne el alcance explícitamente. Si "vacío" significara
  // "todas", esos mismos caminos entregarían la escuela entera por omisión.
  //
  // Ambos campos los escribe únicamente routes/admin.js (alta de usuario y
  // POST /admin/users/:id/divisions). Al modificarlos hay que llamar a invalidateUser():
  // el doc de usuario vive cacheado 45s en middleware/cache.js y el scope se resuelve
  // desde ahí en cada request (ver middleware/preceptor.js).
  assignedDivisions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Division',
    default: [],
  }],
  allDivisions: {
    type: Boolean,
    default: false,   // true = todas las divisiones de su escuela, sin enumerarlas
  },

  // ── Perfil personal ────────────────────────────────────────────────────────
  // Lo carga el propio usuario desde /profile y lo ve, además de él, el equipo
  // directivo en sus paneles (mismo alcance que phone/instagram/facebook — ver
  // views/partials/about-info.ejs). Decisión tomada explícitamente con el usuario:
  // los alumnos son menores, así que no se expone a compañeros ni docentes.
  bio: {
    type: String,
    trim: true,
    maxlength: [280, 'La presentación no puede superar los 280 caracteres'],
    default: null,      // Presentación breve escrita por el usuario
  },
  interests: {
    type: [String],
    default: [],        // IDs de config/interests.js — lista CERRADA, se valida en la ruta
  },
  futureGoal: {
    type: String,
    trim: true,
    maxlength: [120, 'Este campo no puede superar los 120 caracteres'],
    // Alumnos: a qué les gustaría dedicarse (dato de valor para Orientación Escolar).
    // Docentes y demás roles: su formación o especialidad. El label cambia en la vista
    // según el rol, pero el campo es uno solo.
    default: null,
  },
}, { timestamps: true }); // Agrega createdAt y updatedAt automáticamente

// Índice único compuesto school+dni: evita DNI duplicados dentro de la misma escuela
// sparse: true → solo indexa documentos donde dni está presente (no nulos)
// partialFilterExpression → garantiza que el índice solo aplique cuando dni es string
userSchema.index(
  { school: 1, dni: 1 },
  { unique: true, sparse: true, partialFilterExpression: { dni: { $type: 'string' } } }
);

// Usado por el monitor de superadmin para contar usuarios "conectados ahora" (countDocuments
// + aggregate por rol filtrando lastSeen >= cutoff, refrescado cada pocos segundos)
userSchema.index({ lastSeen: 1 });

// Hook pre-save: hashea la contraseña antes de persistir
// Solo se ejecuta si el campo password fue modificado (evita re-hashear en otros cambios)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10); // Factor de coste 10 (balance seguridad/velocidad)
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Método de instancia: compara una contraseña en texto plano con el hash almacenado
// Retorna true si coinciden, false si no. Usado en POST /login
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Override toJSON: elimina el campo password al serializar el doc (p.ej. en res.json)
userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

// Método estático: devuelve el array ROLES (usado en /register para mostrar opciones)
userSchema.statics.getRoles = () => ROLES;

module.exports = mongoose.model('User', userSchema);
