const mongoose = require('mongoose');

// El registro histórico de una emisión: una fila por cada vez que alguien prende y apaga la
// transmisión. Ver specs/transmision-en-vivo.spec.md.
//
// NO es lo mismo que una sesión de sala: en una clase la docente puede transmitir, cortar para
// que los chicos hagan un ejercicio, y volver a transmitir. Son tres documentos de éstos y una
// sola RoomSession.
//
// Para qué existe, concretamente: para poder contestar dentro de un año la pregunta que
// seguro va a venir — "¿cuánto nos costó realmente esto?". Sin este registro, esa pregunta no
// tiene respuesta, porque el consumo vive en la memoria de un proceso que se reinicia.
const transmisionSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'RoomSession', required: true },
  course:  { type: mongoose.Schema.Types.ObjectId, ref: 'Course',      required: true },

  // Denormalizadas por el mismo motivo que en RoomSession: el panel del superadmin lista por
  // ESCUELA y el informe de supervisión filtra por DIVISIÓN. Sin estos dos campos habría que
  // traer todas las transmisiones del sistema y filtrarlas en memoria por el curso populado.
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School',   required: true },
  division: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true },

  docente: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Snapshot, mismo criterio que RoomMessage.authorName y AuditLog: el informe de consumo de
  // hace ocho meses tiene que seguir siendo legible aunque el usuario ya no exista.
  docenteNombre: { type: String, default: '' },

  iniciadaAt:   { type: Date, default: Date.now },
  terminadaAt:  { type: Date, default: null },
  // Por qué terminó. 'caida' es la que importa: es la que distingue "la docente cerró" de "se
  // cayó el proceso de medios en el medio de la clase", que son dos conversaciones distintas.
  cerradaPor:   { type: String, enum: ['docente', 'cierre-sala', 'caida', ''], default: '' },

  // Medición. Se acumula desde el proceso de medios y se vuelca al cerrar.
  picoEspectadores:   { type: Number, default: 0 },
  espectadoresUnicos: { type: Number, default: 0 },
  bytesSalida:        { type: Number, default: 0 },
  capaMaxAlcanzada:   { type: String, default: '' },

  // Cuántas veces el gobernador tuvo que bajar la calidad de ESTA transmisión, y cuántas
  // veces se rechazó a alguien. Son la prueba de que el techo actuó: convierten un "el video
  // andaba mal el martes" en una línea con hora y número.
  degradaciones:     { type: Number, default: 0 },
  cortesTotales:     { type: Number, default: 0 },
  ticketsRechazados: { type: Number, default: 0 },
}, { timestamps: true });

// El panel del superadmin: "las transmisiones de mi escuela, de la más reciente a la más vieja".
transmisionSchema.index({ school: 1, iniciadaAt: -1 });

// El historial de una materia.
transmisionSchema.index({ course: 1, iniciadaAt: -1 });

module.exports = mongoose.model('Transmision', transmisionSchema);
