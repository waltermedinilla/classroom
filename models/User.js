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
  lastSeen: {
    type: Date,
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
