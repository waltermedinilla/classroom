const express    = require('express');
const Suggestion = require('../models/Suggestion');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_ROLES = ['superadmin', 'admin', 'directivo', 'preceptor', 'soe'];

function requireSuggestionRole(req, res, next) {
  const role = res.locals.user?.role;
  if (!ALLOWED_ROLES.includes(role)) return res.status(403).json({ error: 'Sin permiso' });
  next();
}

// POST /suggestions
router.post('/', requireAuth, requireSuggestionRole, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'La sugerencia no puede estar vacía' });
    }
    await Suggestion.create({
      text:   text.trim(),
      user:   req.userId,
      school: res.locals.user?.school || null,
    });
    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error al guardar la sugerencia' });
  }
});

module.exports = router;
