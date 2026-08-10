const mongoose = require('mongoose');
const { Schema } = mongoose;

// UN ENVÍO del superadministrador. Un documento por mensaje redactado, NO por destinatario:
// el texto se guarda una sola vez y el estado de cada persona vive en MessageRecipient.
//
// Por qué separado y no con los destinatarios adentro: un envío a "toda la comunidad" son
// cientos de personas, cada una con su estado de lectura y su hilo privado. Embebidos, todas
// escribirían el MISMO documento al responder (contención pura) y el doc crecería sin techo
// contra el límite de 16 MB. Ver specs/mensajeria-superadmin.spec.md.
const messageSchema = new Schema({
  // Opcional: es lo que se ve en el listado del panel y en el encabezado del mensaje en la
  // bandeja. Sin asunto, ambos muestran las primeras palabras del cuerpo.
  subject: { type: String, trim: true, maxlength: 120, default: '' },

  // 2000 y no 1000 como una sugerencia: acá es comunicación institucional (instrucciones,
  // plazos, explicaciones), no una idea suelta.
  body: { type: String, required: true, trim: true, maxlength: 2000 },

  sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },

  // El toggle del pedido original. Se puede cambiar DESPUÉS de enviado, en los dos sentidos:
  // apagarlo cierra la caja de texto pero no borra nada de lo ya escrito (RN-08).
  allowReplies: { type: Boolean, default: false },

  // MEMORIA de lo que se pidió, NO fuente de verdad de a quién le llegó.
  //
  // Sirve para tres cosas y ninguna más: mostrar "Enviado a: Docentes — 42 personas" en el
  // panel, permitir reenviar con los mismos filtros, y auditar el criterio. La audiencia REAL
  // son los MessageRecipient, congelados al enviar.
  //
  // NUNCA se re-evalúa para decidir quién ve qué. Si se re-evaluara, el alta de un docente en
  // agosto lo metería dentro de un mensaje de marzo que nunca fue para él.
  audience: {
    everyone: { type: Boolean, default: false },
    roles:    [{ type: String }],
    schools:  [{ type: Schema.Types.ObjectId, ref: 'School' }],
    userIds:  [{ type: Schema.Types.ObjectId, ref: 'User' }],
    // `divisions` no existe todavía a propósito: el recorte por curso quedó explícitamente
    // para más adelante. Cuando se sume, entra acá y en services/messageAudience.js, sin
    // migración y sin tocar nada más.
  },

  // Denominador de "leído por X de Y". Se calcula UNA vez, al enviar, con la cantidad
  // REALMENTE insertada. Recontar destinatarios en cada pintada del listado sería un
  // countDocuments por fila.
  recipientCount: { type: Number, default: 0 },

  // Alcance institucional del envío. Hoy siempre null: el superadmin no tiene escuela y manda
  // a donde quiera. Existe desde ahora para que habilitar a admin/directivo el día de mañana
  // sea una ruta nueva y no una migración.
  scopeSchool: { type: Schema.Types.ObjectId, ref: 'School', default: null },
}, { timestamps: true });

// Listado del panel: los envíos de un remitente, más recientes primero.
messageSchema.index({ sender: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
