const mongoose = require('mongoose');

// Una toma de asistencia: el preceptor la abre para UN CURSO (3°2°) y UN DÍA, y la cierra
// cuando terminó. Las marcas de cada alumno cuelgan de acá (models/AttendanceMark.js).
//
// Ver specs/asistencia-preceptoria.spec.md.
//
// Por qué por CURSO y no por materia: la asistencia que toma preceptoría es institucional
// —el chico vino a la escuela o no—, no "estuvo en la clase de Matemática". Eso último ya
// existe y es otra cosa: la presencia en la sala en vivo (models/RoomPresence.js), que es un
// registro de conexión y que esta feature solo LEE, para sugerir.
//
// El único criterio de "está abierta" es closedAt === null. No hay flag aparte: dos fuentes
// de verdad para lo mismo terminan discrepando (mismo criterio que RoomSession).
const attendanceSessionSchema = new mongoose.Schema({
  division: { type: mongoose.Schema.Types.ObjectId, ref: 'Division', required: true },

  // DENORMALIZADA a propósito, igual que en RoomSession: todo $match del proyecto arranca
  // por la escuela del usuario. Sin este campo habría que traer las tomas de todas las
  // escuelas y filtrarlas en memoria por la división populada.
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },

  // Día escolar 'YYYY-MM-DD' calculado por el SERVIDOR en la zona de la escuela
  // (services/attendance.js → diaEscolar). String y no Date, por tres motivos:
  //   1. Producción corre en UTC. Un `new Date()` a medianoche local fecha la toma de las
  //      21:30 en el día siguiente, y el índice único de abajo dejaría abrir una segunda
  //      toma "del mismo día".
  //   2. Hace el índice único trivial: no hay que normalizar horas ni rangos.
  //   3. Las comparaciones de rango del reporte mensual son exactas y ordenan solas.
  date: { type: String, required: true },

  // '' para la toma del día (el caso normal). 'Tarde', '2ª hora'... para una segunda toma
  // el mismo día. Es parte del índice único, así que se guarda con trim.
  label: { type: String, trim: true, default: '', maxlength: 30 },

  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  openedAt: { type: Date, default: Date.now },
  // null = la toma está abierta. Es el único criterio en todo el sistema.
  closedAt: { type: Date, default: null },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // true = la cerró el autocierre por cambio de día, no una persona. Se distingue para que
  // el preceptor entienda por qué su toma de ayer figura cerrada sin haberla cerrado él.
  autoClosed: { type: Boolean, default: false },

  // 'pase'    = pase de lista: el preceptor marca uno por uno y cierra.
  // 'ventana' = queda abierta y los alumnos la van dando desde su pantalla.
  mode: { type: String, enum: ['pase', 'ventana'], default: 'pase' },

  // Cierre programado opcional (solo tiene sentido en 'ventana'). null = la cierra una
  // persona. Vencido, el alumno ya no puede marcarse aunque la toma siga abierta para el
  // preceptor: ver puedeAutoMarcarse() en services/attendance.js.
  closesAt: { type: Date, default: null },

  settings: {
    // ¿El alumno puede marcarse solo? En 'pase' arranca apagada; en 'ventana', prendida.
    selfCheckin: { type: Boolean, default: false },
  },

  // Total de la nómina al momento de abrir. Se guarda aunque se pueda contar las marcas,
  // para que el "N de M" de una toma de hace seis meses siga diciendo lo que decía ese día
  // aunque el curso haya cambiado de tamaño.
  rosterSize: { type: Number, default: 0 },
}, { timestamps: true });

// No puede haber dos tomas del mismo curso, el mismo día, con la misma etiqueta. Es lo que
// hace IDEMPOTENTE a abrirToma(): dos preceptores del mismo curso tocando "Abrir" a la vez
// es un caso real, no teórico (mismo criterio que openSession en services/liveRoom.js).
attendanceSessionSchema.index({ division: 1, date: 1, label: 1 }, { unique: true });

// "¿Hay alguna toma abierta en esta escuela?" — la query del cartel del alumno.
attendanceSessionSchema.index({ school: 1, closedAt: 1 });

// Historial de un curso, de la toma más reciente a la más vieja.
attendanceSessionSchema.index({ division: 1, date: -1 });

module.exports = mongoose.model('AttendanceSession', attendanceSessionSchema);
