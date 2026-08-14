const express    = require('express');
const Suggestion = require('../models/Suggestion');
const { requireAuth } = require('../middleware/auth');
const { logAudit }    = require('../middleware/audit');
const { logDeRuta } = require('../middleware/route-log');
const { hilo, esperaAlEquipo, puedeResponderElUsuario, cuantosMensajes, MAX_MENSAJES } =
  require('../services/suggestionThread');

const router = express.Router();

// POST /suggestions — cualquier usuario autenticado (docente, alumno, etc.) puede enviar una sugerencia
router.post('/', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'La sugerencia no puede estar vacía' });
    }
    const s = await Suggestion.create({
      text:   text.trim(),
      user:   req.userId,
      school: res.locals.user?.school || null,
    });

    logAudit(req, 'suggestion.create',
      [{ type: 'suggestion', id: s._id, name: s.text.slice(0, 60) }],
      {},
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al guardar la sugerencia' });
  }
});

// GET /suggestions/mine — bandeja del usuario: todas SUS sugerencias (cualquier estado),
// más recientes primero. Usado por el modal del sobre en el header.
//
// Cada una viaja con su hilo ya armado: la bandeja pinta la conversación completa y no tiene
// por qué saber que los dos primeros mensajes viven en campos aparte (ver services/suggestionThread.js).
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const suggestions = await Suggestion.find({ user: req.userId })
      .populate('respondedBy', 'name')
      .sort({ updatedAt: -1 })
      .limit(50); // bandeja personal, no necesita paginación real todavía
    res.json({
      suggestions: suggestions.map(s => ({
        ...s.toObject(),
        hilo: hilo(s).map(m => ({ from: m.from, text: m.text, at: m.at, editedAt: m.editedAt })),
        puedeResponder: puedeResponderElUsuario(s),
        esperaAlEquipo: esperaAlEquipo(s),
      })),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al cargar tus sugerencias' });
  }
});

// POST /suggestions/mine/:id/reply — el usuario sigue el hilo de UNA sugerencia suya.
//
// Solo se puede responder algo que el equipo ya contestó: mientras la sugerencia está sin
// responder no hay conversación que seguir, y si el tema es otro corresponde una sugerencia
// nueva (es la regla que da sentido al hilo, no una limitación técnica).
//
// La sugerencia vuelve a 'pending': es lo que la devuelve a la bandeja del superadmin, que
// entra por default a "Pendientes". Sin esto, una respuesta sobre un hilo ya respondido se
// quedaría archivada en "Respondidas" y nadie la vería.
router.post('/mine/:id/reply', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'La respuesta no puede estar vacía' });
    }
    if (text.trim().length > 1000) {
      return res.status(400).json({ error: 'La respuesta no puede superar los 1000 caracteres' });
    }

    const s = await Suggestion.findOne({ _id: req.params.id, user: req.userId });
    if (!s) return res.status(404).json({ error: 'Sugerencia no encontrada' });

    if (!puedeResponderElUsuario(s)) {
      return res.status(400).json({
        error: cuantosMensajes(s) >= MAX_MENSAJES
          ? `Esta conversación llegó a los ${MAX_MENSAJES} mensajes. Para seguir, enviá una sugerencia nueva.`
          : 'Todavía no hay una respuesta del equipo para continuar. Si querés plantear otra cosa, enviá una sugerencia nueva.',
      });
    }

    s.messages.push({ from: 'user', author: req.userId, text: text.trim() });
    s.status     = 'pending';
    // Ya leyó lo que le habían contestado: si estuviera en false, el sobre le seguiría
    // marcando un mensaje sin leer que es justamente el que acaba de responder.
    s.readByUser = true;
    await s.save();

    logAudit(req, 'suggestion.reply',
      [{ type: 'suggestion', id: s._id, name: (s.text || '').slice(0, 60) }],
      { mensajes: cuantosMensajes(s) },
      { schoolId: s.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al enviar tu respuesta' });
  }
});

// POST /suggestions/mine/:id/read — el usuario marca una respuesta como leída
// (se dispara al abrir el modal). Solo puede tocar SUS propias sugerencias.
router.post('/mine/:id/read', requireAuth, async (req, res) => {
  try {
    const s = await Suggestion.findOne({ _id: req.params.id, user: req.userId }).select('readByUser');
    if (!s) return res.status(404).json({ error: 'Sugerencia no encontrada' });
    if (!s.readByUser) {
      // `timestamps: false` a propósito: los dos paneles ordenan por updatedAt para que un
      // hilo con mensaje nuevo suba a la vista. Abrir la bandeja no es actividad de la
      // conversación, así que no tiene que reordenar nada.
      await Suggestion.updateOne({ _id: s._id }, { $set: { readByUser: true } }, { timestamps: false });
    }
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
