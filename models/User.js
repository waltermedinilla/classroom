const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// Lista completa de roles válidos en el sistema (en orden de jerarquía descendente)
const ROLES = ['superadmin', 'admin', 'directivo', 'teacher', 'preceptor', 'soe', 'student'];

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
