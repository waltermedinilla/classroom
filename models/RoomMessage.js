const mongoose = require('mongoose');

// Reacción con emoji a un mensaje. `users` guarda quiénes reaccionaron para poder mostrar
// "vos reaccionaste" y para que la segunda pulsada del mismo usuario saque su reacción
// en vez de duplicarla.
const reactionSchema = new mongoose.Schema({
  emoji: { type: String, required: true },
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { _id: false });

// La respuesta citada, estilo WhatsApp: este mensaje contesta a otro y muestra un pedacito
// del original arriba.
//
// Es un SNAPSHOT y no solamente un ref, por el mismo motivo que authorName: el poll pinta
// hasta 100 mensajes cada 4 segundos por cada persona de la sala, y resolver la cita con
// populate agregaría una query a EL camino más caliente de la app. Acá el texto de la cita
// ya viene escrito y pintarla no cuesta nada.
//
// `borrado` es la contraparte obligatoria de ese snapshot. Sin él, borrar un mensaje
// ofensivo lo dejaría vivo adentro de la cita de cada respuesta —o sea, la moderación no
// moderaría nada— porque el texto citado está copiado en OTRO documento. Se marca en el
// momento del borrado (una operación rara) y no se recalcula en cada poll (la operación cara).
const replySchema = new mongoose.Schema({
  to:       { type: mongoose.Schema.Types.ObjectId, ref: 'RoomMessage', required: true },
  seq:      { type: Number, default: null },   // posición del original: así se lo busca en el DOM
  autor:    { type: String, default: '' },     // snapshot del nombre, igual que authorName
  extracto: { type: String, default: '' },     // los primeros 90 caracteres; '' si era un adjunto
  kind:     { type: String, default: 'text' }, // 'text' | 'image' | 'file'
  borrado:  { type: Boolean, default: false },
}, { _id: false });

// Un mensaje dentro de una sesión de sala en vivo.
const roomMessageSchema = new mongoose.Schema({
  session: { type: mongoose.Schema.Types.ObjectId, ref: 'RoomSession', required: true },
  // Denormalizada: la purga (cleanup-rooms.js) y el export trabajan por materia sin tener
  // que resolver la sesión primero.
  course:  { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },

  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Snapshot del autor, mismo criterio que models/AuditLog.js: si mañana se elimina al
  // usuario, la transcripción de una clase de hace ocho meses tiene que seguir siendo
  // legible. Con solo el ref, populate devuelve null y la conversación queda anónima.
  authorName: { type: String, default: '' },
  authorRole: { type: String, default: '' },

  // 'system' = avisos automáticos de la propia sala (se abrió, se cerró, entró preceptoría).
  // Se guardan como mensajes y no como eventos aparte para que la transcripción se lea en
  // orden, con un solo cursor.
  //
  // 'image' y 'file' son los adjuntos que comparte la docente. Son un MENSAJE MÁS y no una
  // colección aparte a propósito: así heredan el `seq` (el cursor del poll), el soft delete,
  // la moderación y la transcripción sin duplicar nada de eso. Un adjunto que viviera fuera
  // de la secuencia habría que ordenarlo por fecha contra los mensajes — que es justamente
  // el problema que `seq` existe para no tener.
  kind: { type: String, enum: ['text', 'system', 'image', 'file'], default: 'text' },

  // Obligatorio solo para los mensajes que SON texto. Un adjunto no lleva texto: su contenido
  // es el archivo, y el nombre visible vive en `attachment.name`. Con `required: true` a secas,
  // guardar una imagen exigía inventarle un texto de relleno que después ensuciaba la burbuja,
  // el CSV y la búsqueda.
  text: {
    type: String, trim: true, maxlength: 500,
    required: function () { return this.kind === 'text' || this.kind === 'system'; },
    default: '',
  },

  // Metadatos del archivo adjunto. Solo cuando kind es 'image' o 'file'.
  //
  // `path` es la ruta RELATIVA a archivos/salas (ver SALAS_BASE en routes/rooms.js) y NUNCA
  // se manda al cliente: los archivos viven FUERA de /public y se sirven por una ruta
  // autenticada que revalida el permiso de la sala en cada pedido. Es lo que hace que
  // "eliminar" signifique eliminar de verdad — con una URL estática, cualquiera que se hubiera
  // guardado el link seguiría viendo la imagen después de que la docente la borró, sin estar
  // siquiera logueado. Es un chat de menores: ese agujero no se deja abierto.
  attachment: {
    name:   { type: String, default: '' },   // nombre original, el que ve la clase
    ext:    { type: String, default: '' },   // '.pdf' — la etiqueta de la card
    mime:   { type: String, default: '' },
    bytes:  { type: Number, default: 0 },
    path:   { type: String, default: '' },   // relativa a archivos/salas — nunca sale al cliente
    width:  { type: Number, default: null }, // solo imágenes: reserva el alto del preview
    height: { type: Number, default: null }, //   y evita que el chat pegue un salto al cargar
  },

  // Actividad a la que apunta este mensaje. Hoy solo la lleva el aviso de sistema que se
  // publica cuando la docente crea una actividad desde la clase (routes/activities.js), y es
  // lo que le permite a la sala pintar el botón "Ver actividad".
  //
  // Va como REF y no como una URL armada en el texto: el texto es lo que se lee (y lo que
  // queda en la transcripción y en el CSV), el link es un dato aparte. Con la URL adentro del
  // texto habría que parsearla para pintar el botón, y cualquier cambio de ruta rompería los
  // mensajes viejos.
  //
  // Opcional y sin índice: no se consulta por este campo, se lee junto con el mensaje. Los
  // mensajes anteriores a esta feature lo tienen en null y se pintan como siempre.
  activity: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', default: null },

  // A qué mensaje contesta este. Ver replySchema arriba. `null` (el default) es "no contesta
  // a nadie", que es como se leen todos los mensajes anteriores a esta feature.
  //
  // Sin índice propio: nunca se consulta POR este campo salvo al borrar un mensaje, y esa
  // query va acotada por `session` —que sí está indexado— porque una cita solo puede apuntar
  // a un mensaje de la misma sesión (no se cita la clase del martes en la del jueves).
  reply: { type: replySchema, default: null },

  // Posición dentro de la sesión (1..N). Es el cursor del polling: el cliente manda el
  // último `seq` que tiene y recibe solo lo posterior. Se asigna con un $inc atómico sobre
  // RoomSession.lastSeq — ver services/liveRoom.js. NO usar createdAt como cursor: dos
  // mensajes en el mismo milisegundo son indistinguibles y uno se pierde, que es justo lo
  // que pasa cuando media clase contesta a la vez.
  seq: { type: Number, required: true },

  reactions: { type: [reactionSchema], default: [] },

  // Soft delete. El texto original NO se borra: es lo que permite reconstruir qué pasó si
  // hubo un problema de convivencia, que es exactamente cuando un mensaje se borra. La vista
  // muestra "Mensaje eliminado" y conserva el `seq` — si el mensaje desapareciera de la
  // secuencia, los clientes que ya lo tienen quedarían desincronizados.
  //
  // Con los ADJUNTOS el criterio se parte en dos, a propósito: el documento se marca igual
  // (queda el registro de que se compartió tal archivo y quién lo borró), pero el archivo
  // en disco se BORRA de verdad. Un texto de 500 caracteres guardado por si hace falta
  // reconstruir un episodio es una cosa; conservar indefinidamente una foto que la docente
  // decidió sacar de la vista de un curso de menores es otra. Y el disco no crecería nunca.
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// EL índice caliente: el poll de cada persona en la sala, cada 4 segundos.
roomMessageSchema.index({ session: 1, seq: 1 });

// Purga por antigüedad (cleanup-rooms.js): borra los mensajes de las sesiones ya cerradas.
roomMessageSchema.index({ course: 1, createdAt: 1 });

module.exports = mongoose.model('RoomMessage', roomMessageSchema);
