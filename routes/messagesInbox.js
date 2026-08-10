// BANDEJA DEL DESTINATARIO (/messages/mine).
//
// Lo que ve cualquier usuario que recibió un mensaje del superadministrador. No se pinta en
// una pantalla propia: se fusiona con las sugerencias en el modal del sobre del header
// (views/partials/footer.ejs), que es donde el usuario ya mira.
//
// El panel del que envía vive en routes/messages.js.

const express = require('express');

const Message          = require('../models/Message');
const MessageRecipient = require('../models/MessageRecipient');

const { requireAuth }         = require('../middleware/auth');
const { logAudit }            = require('../middleware/audit');
const { messageReplyLimiter } = require('../middleware/rate-limits');

const { hilo, esperaAlDestinatario, puedeResponderElUsuario, cuantosMensajes, MAX_MENSAJES } =
  require('../services/messageThread');

const router = express.Router();

const MAX_TEXTO = 2000;

router.use(requireAuth, (req, res, next) => {
  if (process.env.MESSAGES_ENABLED === 'false') return res.status(404).json({ error: 'No encontrado' });
  next();
});

// GET /messages/mine — los mensajes que recibió ESTE usuario, con el hilo ya armado.
//
// Tope 50 sin paginación real, igual que /suggestions/mine: es una bandeja personal que se
// abre en un modal, no un archivo histórico.
router.get('/mine', async (req, res) => {
  try {
    const recibidos = await MessageRecipient.find({ user: req.userId })
      .populate({ path: 'message', populate: { path: 'sender', select: 'name' } })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    const messages = recibidos
      // Una fila sin mensaje solo puede existir si un borrado se cortó por la mitad. Se
      // saltea en vez de romper la bandeja entera por un huérfano.
      .filter(r => r.message)
      .map(r => ({
        recipientId:  r._id,
        subject:      r.message.subject || '',
        body:         r.message.body,
        sender:       r.message.sender ? { name: r.message.sender.name } : null,
        sentAt:       r.message.createdAt,
        readAt:       r.readAt,
        allowReplies: !!r.message.allowReplies,
        // El hilo viaja armado: el cliente no tiene por qué saber que el primer mensaje vive
        // en Message.body y el resto en thread[].
        hilo: hilo(r.message, r).map(m => ({
          from: m.from, text: m.text, at: m.at, editedAt: m.editedAt,
        })),
        puedeResponder:       puedeResponderElUsuario(r.message, r),
        esperaAlDestinatario: esperaAlDestinatario(r.message, r),
        // Lo que decide el badge: el mensaje sin abrir, o una respuesta nueva sobre uno ya leído.
        sinLeer: !r.readAt || !!r.unreadForUser,
      }));

    res.json({ messages });
  } catch {
    res.status(500).json({ error: 'Error al cargar tus mensajes' });
  }
});

// POST /messages/mine/:recipientId/read — se dispara al abrir el modal, fire-and-forget.
router.post('/mine/:recipientId/read', async (req, res) => {
  try {
    const rec = await MessageRecipient.findOne({
      _id: req.params.recipientId, user: req.userId,
    }).select('readAt unreadForUser');
    // 404 y no 403: no se confirma que la fila exista si no es de quien pregunta.
    if (!rec) return res.status(404).json({ error: 'Mensaje no encontrado' });

    if (!rec.readAt || rec.unreadForUser) {
      // timestamps:false a propósito: los dos paneles ordenan por updatedAt para que un hilo
      // con mensaje nuevo suba a la vista. Abrir la bandeja no es actividad de la
      // conversación, así que no tiene que reordenar nada. Mismo criterio que sugerencias.
      await MessageRecipient.updateOne(
        { _id: rec._id },
        { $set: { readAt: rec.readAt || new Date(), unreadForUser: false } },
        { timestamps: false },
      );
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /messages/mine/:recipientId/reply — el destinatario contesta.
//
// A diferencia de las sugerencias, acá puede contestar de entrada: el mensaje inicial ya es
// del equipo, así que siempre hay algo a lo que responder. La única puerta es el toggle que
// eligió el remitente.
router.post('/mine/:recipientId/reply', messageReplyLimiter, async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text)                   return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
    if (text.length > MAX_TEXTO) return res.status(400).json({ error: `La respuesta no puede superar los ${MAX_TEXTO} caracteres` });

    const rec = await MessageRecipient.findOne({
      _id: req.params.recipientId, user: req.userId,
    });
    if (!rec) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const mensaje = await Message.findById(rec.message);
    if (!mensaje) return res.status(404).json({ error: 'Mensaje no encontrado' });

    // Se revalida en el servidor y no solo en la vista: el toggle se puede haber apagado
    // entre que la bandeja se pintó y el usuario apretó Enviar.
    if (!mensaje.allowReplies) {
      return res.status(403).json({ error: 'Este mensaje no admite respuestas' });
    }
    if (!puedeResponderElUsuario(mensaje, rec)) {
      return res.status(400).json({
        error: `Esta conversación llegó a los ${MAX_MENSAJES} mensajes.`,
      });
    }

    rec.thread.push({ from: 'user', author: req.userId, text });
    // Ya leyó lo que le habían mandado: si quedara sin marcar, el sobre le seguiría avisando
    // por el mensaje que acaba de contestar.
    rec.unreadForUser  = false;
    rec.readAt         = rec.readAt || new Date();
    rec.unreadForStaff = true;
    await rec.save();

    logAudit(req, 'message.reply',
      [{ type: 'message', id: mensaje._id, name: (mensaje.subject || mensaje.body).slice(0, 60) }],
      { mensajes: cuantosMensajes(mensaje, rec) },
      { schoolId: rec.schoolAtSend || null },
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'No se pudo enviar tu respuesta' });
  }
});

module.exports = router;
