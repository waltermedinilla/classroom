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

  openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  openedAt: { type: Date, default: Date.now },

  // Cuántas veces se pasó lista sobre esta misma planilla. El preceptor puede pasar lista
  // varias veces en el día —a primera hora, después del recreo, a la tarde— y cada pasada
  // AJUSTA la lista del día en vez de crear otra: al final del día queda UNA sola
  // (decisión del usuario, 2026-08-10). Este contador es solo informativo, para que la
  // pantalla pueda decir "3ª pasada" y se entienda que la planilla se fue completando.
  pasadas: { type: Number, default: 1 },
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

// UNA sola toma por curso y por día. El índice lo garantiza a nivel base, que es lo único
// que aguanta los dos workers de PM2: dos preceptores del mismo curso tocando "Pasar lista"
// a la vez es un caso real, no teórico (mismo criterio que openSession en liveRoom.js).
//
// Es también lo que hace que la planilla mensual tenga sentido: una columna por día, un
// estado por alumno. Con dos tomas el mismo día, cuál de las dos aparecía en esa columna
// dependía del orden en que Mongo devolviera los documentos.
attendanceSessionSchema.index({ division: 1, date: 1 }, { unique: true });

// "¿Hay alguna toma abierta en esta escuela?" — la query del cartel del alumno.
attendanceSessionSchema.index({ school: 1, closedAt: 1 });

// Historial de un curso, de la toma más reciente a la más vieja.
attendanceSessionSchema.index({ division: 1, date: -1 });

module.exports = mongoose.model('AttendanceSession', attendanceSessionSchema);
