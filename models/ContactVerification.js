const mongoose = require('mongoose');
const crypto   = require('crypto');

// Un pedido de verificación de contacto vivo: "le mandamos un código a esta persona y estamos
// esperando que lo ponga". Ver specs/verificacion-de-contacto.spec.md.
//
// UN SOLO MODELO PARA LOS DOS CANALES, con un campo `canal`. Correo y celular comparten todo lo
// que es difícil —generar un secreto, hashearlo, no permitir 40 intentos, expirar, no dejar
// reenviar cada 2 segundos, auditar, limpiar lo viejo— y lo único que cambia es por dónde sale
// el mensaje (services/canales/) y qué se le muestra al usuario. Dos modelos gemelos garantizan
// que el arreglo de mañana se aplique a uno solo: este proyecto ya tiene esa cicatriz con las
// DOS listas de TIPOS_ENTRADA del SOE y con los 9 lugares de los formatos de archivo.
//
// NADA SE GUARDA EN CLARO. Ni el token del enlace ni el código de 6 dígitos: van hasheados con
// SHA-256, con el mismo criterio que una contraseña. Quien lea un dump de Mongo no puede
// verificar correos ajenos. SHA-256 pelado y no bcrypt a propósito: son secretos de alta
// entropía y vida corta (48 bytes al azar / 6 dígitos con tope de 5 intentos y 15 minutos), así
// que el costo de cómputo de bcrypt no compra nada y sí encarece cada intento.
const contactVerificationSchema = new mongoose.Schema({
  user: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },
  // La escuela del usuario al momento de pedir la verificación. Está desnormalizada para poder
  // contar el tope diario por escuela sin un $lookup contra users en cada envío.
  school: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'School',
    default: null,
  },
  canal: {
    type:     String,
    enum:     ['email', 'celular'],
    required: true,
  },
  // El correo o el E.164 al que se mandó, CONGELADO. Se compara al confirmar: si la persona
  // pide el código, cambia el número y después mete el código, se rechaza — verificó otra cosa.
  destino: {
    type:     String,
    required: true,
    trim:     true,
  },
  // SHA-256 del token del enlace. Solo para canal 'email': en un SMS un enlace es exactamente
  // lo que se le enseña a la gente a no tocar (ver D3).
  tokenHash: {
    type:    String,
    default: null,
  },
  // SHA-256 del código de 6 dígitos. Va en los dos canales.
  codigoHash: {
    type:     String,
    required: true,
  },
  intentos: {
    type:    Number,
    default: 0,
  },
  enviadoEn: {
    type:    Date,
    default: Date.now,
  },
  // Índice TTL: la limpieza la hace Mongo sola. No hay cron que barrer ni tarea que se olvide
  // de correr, que es la clase de deuda que este proyecto ya tiene en otros lados.
  expiraEn: {
    type:     Date,
    required: true,
  },
  // null mientras esté viva. Se completa al verificar o al invalidarla por una nueva.
  usadoEn: {
    type:    Date,
    default: null,
  },
  // Para diagnosticar una queja real ("no me llegó") sin adivinar: con qué proveedor salió,
  // qué id devolvió y, si lo rechazó, por qué.
  proveedor:  { type: String, default: null },
  envioId:    { type: String, default: null },
  envioError: { type: String, default: null },
}, { timestamps: true });

// La verificación viva de una persona en un canal. Es la consulta de todos los POST de código.
contactVerificationSchema.index({ user: 1, canal: 1, usadoEn: 1 });

// Resolver el enlace del correo en un solo golpe. sparse porque el canal celular no tiene token.
contactVerificationSchema.index({ tokenHash: 1 }, { sparse: true });

// TTL de Mongo: borra el documento cuando `expiraEn` queda en el pasado.
// ⚠️ El barrido de TTL corre cada 60 segundos, así que un documento puede sobrevivir hasta un
// minuto después de expirar. Por eso la expiración se valida IGUAL en el código al confirmar:
// el índice es la limpieza, no la regla.
contactVerificationSchema.index({ expiraEn: 1 }, { expireAfterSeconds: 0 });

// El tope diario de envíos por escuela, que es la única red que hay contra una factura por un
// script suelto o un bucle.
contactVerificationSchema.index({ school: 1, canal: 1, enviadoEn: -1 });

// ── Helpers de secretos ──────────────────────────────────────────────────────
// Estáticos y no funciones sueltas del router para que el hash se calcule en UN solo lugar:
// si mañana cambia el algoritmo, cambia acá y no en las cinco rutas que lo usan.

contactVerificationSchema.statics.hashear = function (valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
};

// Token del enlace: 48 bytes al azar. NO 6 dígitos, y el motivo es concreto: el enlace se abre
// SIN sesión (el mail se lee en el celular y la sesión está en la netbook del aula), así que no
// hay ninguna otra cosa que identifique a quien lo usa. Un código corto sin sesión se adivina a
// fuerza bruta; con sesión, no.
contactVerificationSchema.statics.nuevoToken = function () {
  return crypto.randomBytes(48).toString('base64url');
};

// Código de 6 dígitos, con randomInt (CSPRNG) y no Math.random(). Se muestra siempre con los
// ceros a la izquierda: "004321" es un código válido y perder el cero lo volvería de 5 dígitos.
contactVerificationSchema.statics.nuevoCodigo = function () {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
};

// Compara un valor candidato contra un hash guardado en tiempo constante.
//
// timingSafeEqual y no `===`: comparar strings corta en el primer byte distinto, y esa
// diferencia de microsegundos, medida muchas veces, filtra el secreto dígito por dígito. Acá el
// riesgo real es bajo (hay tope de 5 intentos) pero el costo de hacerlo bien es una línea.
contactVerificationSchema.statics.coincide = function (candidato, hashGuardado) {
  if (!candidato || !hashGuardado) return false;
  const a = Buffer.from(this.hashear(candidato), 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// ¿Sigue sirviendo? Una verificación puede estar muerta por tres motivos distintos y los tres
// tienen que dar el mismo resultado hacia afuera.
contactVerificationSchema.methods.estaViva = function (ahora = new Date()) {
  if (this.usadoEn) return false;
  if (this.expiraEn <= ahora) return false;
  if (this.intentos >= 5) return false;
  return true;
};

module.exports = mongoose.model('ContactVerification', contactVerificationSchema);
