const express    = require('express');
const Suggestion = require('../models/Suggestion');
const { requireAuth } = require('../middleware/auth');
const { logAudit }    = require('../middleware/audit');

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
  } catch {
    res.status(500).json({ error: 'Error al guardar la sugerencia' });
  }
});

// GET /suggestions/mine — bandeja del usuario: todas SUS sugerencias (cualquier estado),
// más recientes primero. Usado por el modal del sobre en el header.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const suggestions = await Suggestion.find({ user: req.userId })
      .populate('respondedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(50); // bandeja personal, no necesita paginación real todavía
    res.json({ suggestions });
  } catch {
    res.status(500).json({ error: 'Error al cargar tus sugerencias' });
  }
});

// POST /suggestions/mine/:id/read — el usuario marca una respuesta como leída
// (se dispara al abrir el modal). Solo puede tocar SUS propias sugerencias.
router.post('/mine/:id/read', requireAuth, async (req, res) => {
  try {
    const s = await Suggestion.findOne({ _id: req.params.id, user: req.userId });
    if (!s) return res.status(404).json({ error: 'Sugerencia no encontrada' });
    if (!s.readByUser) {
      s.readByUser = true;
      await s.save();
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
