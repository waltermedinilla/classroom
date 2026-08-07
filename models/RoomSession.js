const mongoose = require('mongoose');

// Una sesión de la "sala en vivo" de una materia: la docente la abre cuando empieza la clase
// y la cierra al terminar. Todo lo que pasa adentro (mensajes, presencia) cuelga de acá.
//
// Por qué por SESIÓN y no un chat perpetuo por materia:
//   - Da el registro de asistencia por clase sin pedirle trabajo extra a nadie: quiénes
//     estuvieron el martes es "las RoomPresence de la sesión del martes".
//   - Evita un chat de alumnos —menores— funcionando de madrugada sin ningún adulto: fuera
//     de la ventana abierta/cerrada, nadie escribe.
//   - El historial se lee por clase en vez de ser un muro infinito.
//
// El único criterio de "está en vivo" es closedAt === null. No hay flag `abierta` aparte:
// dos fuentes de verdad para lo mismo terminan discrepando.
const roomSessionSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },

  // school y division van DENORMALIZADAS a propósito: el panel de dirección lista las salas
  // abiertas POR ESCUELA y el de preceptoría filtra POR DIVISIÓN. Sin estos dos campos habría
  // que traer todas las sesiones abiertas del sistema y filtrarlas en memoria por el curso
  // populado — justo lo contrario del patrón multi-tenant del resto del proyecto, donde todo
  // $match arranca por la escuela del usuario.
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School',   required: true },
  division: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true },

  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  openedAt: { type: Date, default: Date.now },
  // null = la sala está abierta. Es el único criterio de "en vivo" en todo el sistema.
  closedAt: { type: Date, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // true = la cerró el autocierre por inactividad, no una persona. Se distingue para que la
  // docente entienda por qué su sala aparece cerrada sin que ella la haya cerrado.
  autoClosed: { type: Boolean, default: false },

  title: { type: String, trim: true, default: '', maxlength: 80 },

  // Último mensaje o ping recibido. Alimenta el autocierre a las 3 h (services/liveRoom.js).
  // Se toca seguido, así que se actualiza con updateOne directo y no con save().
  lastActivityAt: { type: Date, default: Date.now },

  // Contador de mensajes de ESTA sesión. Cada mensaje nuevo hace $inc y se queda con el valor
  // resultante como su `seq`. Es atómico entre los dos workers de PM2 (ecosystem.config.js),
  // que es exactamente lo que un cursor basado en fechas no puede garantizar: dos mensajes en
  // el mismo milisegundo son indistinguibles y el poll se saltea uno.
  lastSeq: { type: Number, default: 0 },

  settings: {
    // false = modo "solo yo escribo". Es por sesión: apagar la palabra un martes no la apaga
    // el jueves.
    studentsCanWrite: { type: Boolean, default: true },
    reactionsOn:      { type: Boolean, default: true },
  },

  // Silenciados SOLO en esta sesión. No vive en User ni en Course a propósito: silenciar a
  // alguien es una medida para el rato que dura la clase, no una marca que lo persiga. El
  // silenciado sigue leyendo y sigue contando como presente; solo pierde el cuadro de escribir.
  mutedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

// Panel de dirección y de preceptoría: "salas abiertas de mi escuela", la query más caliente
// de los dos paneles (se repite cada 15 s por cada supervisor conectado).
roomSessionSchema.index({ school: 1, closedAt: 1 });

// "Clases anteriores" de una materia, de la más reciente a la más vieja.
roomSessionSchema.index({ course: 1, openedAt: -1 });

module.exports = mongoose.model('RoomSession', roomSessionSchema);
