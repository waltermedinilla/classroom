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

    // false = los alumnos no comparten fotos en esta clase. Interruptor PROPIO y no atado a
    // `studentsCanWrite`, a pedido del usuario: cuando las fotos se van de tema, la docente
    // tiene que poder cortarlas sin callar a la clase entera, que es lo único que podía hacer
    // antes. Al revés sí manda: apagar la palabra apaga también las fotos (ver
    // puedeCompartirImagen en services/liveRoom.js) — silenciar a alguien lo silencia entero.
    //
    // Por sesión, mismo criterio que sus dos hermanos: apagarlas un martes no las apaga el
    // jueves. Default true: la sesión de una clase que ya estaba abierta cuando esto se
    // desplegó lee `undefined`, y el default hace que se comporte como el resto.
    studentsCanShareImages: { type: Boolean, default: true },
  },

  // La transmisión en vivo de ESTA clase. Ver specs/transmision-en-vivo.spec.md.
  //
  // Va adentro de la sesión y no en una colección propia por el mismo motivo que `settings` y
  // `mutedStudents`: la transmisión no sobrevive a la clase, empieza y termina adentro. Una
  // colección aparte obligaría a una query más en el camino MÁS caliente de la app (el poll,
  // cada 4 s por cada persona de la sala).
  //
  // El registro histórico —cuánto duró, cuánta gente, cuántos bytes— sí es una colección
  // aparte (models/Transmision.js): eso se consulta una vez por mes, no cada 4 segundos.
  transmision: {
    activa:     { type: Boolean, default: false },
    iniciadaAt: { type: Date,    default: null },

    // Qué está publicando. Los tres son independientes: se puede tener micrófono sin cámara y
    // pantalla sin micrófono. `camara` arranca en false a propósito (ver D6 de la spec): el
    // modo por defecto de una clase no es la cara del docente, es lo que está mostrando.
    micro:    { type: Boolean, default: false },
    pantalla: { type: Boolean, default: false },
    camara:   { type: Boolean, default: false },

    // Techo de calidad VIGENTE. Puede haberlo bajado el gobernador (media/aforo.js) y no el
    // docente, y por eso se guarda junto con el motivo: sin `degradadaPor`, la docente ve que
    // su clase se ve peor y no tiene forma de saber que no es su internet.
    capaMax:      { type: String, enum: ['audio', '180p', '360p'], default: '360p' },
    degradadaPor: { type: String, default: '' },   // '' | 'aforo' | 'red' | 'docente'

    // Quién tiene la palabra AHORA. Vive en la base y no en la memoria del proceso de medios
    // para que un reinicio de ese proceso no le regale el micrófono a nadie ni se lo saque a
    // quien lo tenía. Ver D7.
    palabra:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    palabraDesde:  { type: Date,    default: null },
    palabraCamara: { type: Boolean, default: false },

    // Cola de manos levantadas, EN ORDEN DE LLEGADA. Es un array y no un Set ni un campo en
    // RoomPresence justamente porque el orden ES el dato: "quién levantó la mano primero" es
    // la pregunta que hace el docente, y es lo que Meet no sabe contestar.
    manos: [{
      _id:    false,
      user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      // Snapshot del nombre, mismo criterio que RoomMessage.authorName: la cola se pinta en
      // cada poll y resolverla con populate agregaría una query al camino más caliente.
      nombre: { type: String, default: '' },
      desde:  { type: Date,   default: Date.now },
    }],
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
