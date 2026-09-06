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

  // ── Verificación de contacto ───────────────────────────────────────────────
  // specs/verificacion-de-contacto.spec.md. Responden una pregunta que el resto del modelo
  // no puede: `email` y `phone` solo están validados DE FORMA (un regex y sanitizePhone),
  // así que la plataforma cree todo lo que le escriben. Y el correo es la llave de entrada
  // al sistema — se inicia sesión con él.
  //
  // `null` = no verificado. NO hay booleano a propósito: la fecha es el dato, porque
  // "verificado hace 8 meses" no es lo mismo que "verificado ayer".
  //
  // ⚠️ LA REGLA DE ORO DE TODA LA FEATURE: cambiar el dato BORRA su verificación. No se
  // cumple acordándose en cada ruta — se cumple usando setEmail()/setPhone() más abajo, y
  // tests/unit/verificacionRegla.test.js falla si alguna ruta asigna `.email =` directo.
  emailVerifiedAt: {
    type: Date,
    default: null,
  },
  emailVerifiedVia: {
    // 'enlace'|'codigo' = lo hizo la propia persona · 'staff' = lo confirmó la escuela
    // (ver D6) · 'importacion' reservado para un backfill futuro desde una fuente confiable.
    type: String,
    enum: ['enlace', 'codigo', 'staff', 'importacion', null],
    default: null,
  },
  phoneVerifiedAt: {
    type: Date,
    default: null,
  },
  phoneVerifiedVia: {
    type: String,
    enum: ['codigo', 'staff', null],
    default: null,
  },
  // El celular en E.164 (`+5492615551234`), que es el único formato que entiende un proveedor
  // de SMS o WhatsApp. Va APARTE de `phone` y no lo reemplaza: `phone` es lo que la persona
  // escribió y lo que leen las fichas y el link de wa.me. Lo calcula services/telefonoAR.js.
  // null = hay un número cargado que no se pudo interpretar (o no hay ninguno) → NO se manda.
  phoneE164: {
    type: String,
    default: null,
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

// Cobertura de verificación por escuela ("¿a cuántos les llega un correo?"). Sobre 600 usuarios
// por escuela no es imprescindible, pero el contador se pinta en dos paneles y cuesta nada.
userSchema.index({ school: 1, emailVerifiedAt: 1 });

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

// ── La regla de oro de la verificación de contacto ───────────────────────────
// Cambiar el correo o el celular BORRA su verificación. Es el bug clásico que hunde estas
// features: se verifica el correo, después se cambia por otro, y la marca verde queda pegada
// a un dato que nadie confirmó nunca.
//
// Por qué son métodos y no un hook pre('save'): las rutas de este proyecto escriben usuarios
// por los dos caminos —`user.email = x; await user.save()` y `findByIdAndUpdate(...)`— y un
// hook de documento no ve el segundo. Un método que hay que llamar explícitamente sí se puede
// exigir, y tests/unit/verificacionRegla.test.js falla ante cualquier `.email =` suelto en
// routes/. Para los findByIdAndUpdate está camposDeContacto() acá abajo.
//
// No hay excepción por "es el mismo valor": el correo se normaliza a minúsculas y se recorta,
// así que "Ana@X.com " y "ana@x.com" son el mismo correo y no borran nada; cualquier otra
// diferencia es un correo distinto y sí lo borra.
userSchema.methods.setEmail = function (nuevo) {
  const normalizado = String(nuevo || '').toLowerCase().trim();
  if (normalizado === this.email) return this;
  this.email            = normalizado;
  this.emailVerifiedAt  = null;
  this.emailVerifiedVia = null;
  return this;
};

userSchema.methods.setPhone = function (nuevo) {
  // require() adentro para no crear un ciclo: services/telefonoAR.js es puro, pero el modelo
  // lo cargan tests y scripts que no levantan la app entera.
  const { normalizar } = require('../services/telefonoAR');
  const limpio = nuevo ? String(nuevo).trim() : null;
  if (limpio === this.phone) return this;
  this.phone            = limpio;
  this.phoneE164        = normalizar(limpio).e164;
  this.phoneVerifiedAt  = null;
  this.phoneVerifiedVia = null;
  return this;
};

// La misma regla para el otro camino de escritura: findByIdAndUpdate / updateOne, donde no hay
// documento sobre el que llamar un método. Devuelve el objeto de campos a mezclar en el $set.
//
//   await User.findByIdAndUpdate(id, { ...otrosCampos, ...camposDeContacto({ phone }) })
//
// Solo incluye los canales que se pasan: `camposDeContacto({ phone })` no toca el correo.
userSchema.statics.camposDeContacto = function ({ email, phone } = {}) {
  const { normalizar } = require('../services/telefonoAR');
  const campos = {};
  if (email !== undefined) {
    campos.email            = String(email || '').toLowerCase().trim();
    campos.emailVerifiedAt  = null;
    campos.emailVerifiedVia = null;
  }
  if (phone !== undefined) {
    const limpio = phone ? String(phone).trim() : null;
    campos.phone            = limpio;
    campos.phoneE164        = normalizar(limpio).e164;
    campos.phoneVerifiedAt  = null;
    campos.phoneVerifiedVia = null;
  }
  return campos;
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
