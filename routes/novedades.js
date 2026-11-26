// Novedades guiadas — specs/recorrido-novedades.spec.md.
//
//   POST /novedades/:id/vista   La marca como vista (body { como: 'entendido' | 'omitir' }).
//   POST /novedades/repetir     "Volver a ver las novedades" de Mi perfil (D8).
//
// Solo tocan el usuario que lo pide. Suplantando a otro, no hacen nada (RN de D4).

const express = require('express');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { invalidateUser } = require('../middleware/cache');
const { logDeRuta } = require('../middleware/route-log');
const { POR_ID, queLeCorresponden } = require('../config/novedades');
const S = require('../services/secretariaDia');

const router = express.Router();

router.post('/novedades/repetir', requireAuth, async (req, res) => {
  try {
    if (res.locals.impersonating) return res.json({ ok: true, cuantas: 0 });
    const user = res.locals.user;
    const ids = queLeCorresponden({ user, school: res.locals.school, hoy: S.fechaDe(new Date()) }).map(n => n.id);
    if (!ids.length) return res.json({ ok: true, cuantas: 0 });
    await User.updateOne(
      { _id: user._id },
      { $set: { 'novedadesVistas.$[e].repetidaEn': new Date() } },
      { arrayFilters: [{ 'e.id': { $in: ids } }] },
    );
    invalidateUser(user._id);
    res.json({ ok: true, cuantas: ids.length });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo. Probá de nuevo.' });
  }
});

router.post('/novedades/:id/vista', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!POR_ID[id]) return res.status(400).json({ error: 'Esa novedad no existe.' });   // RN-3
  try {
    if (res.locals.impersonating) return res.json({ ok: true });
    const como = (req.body && req.body.como) === 'entendido' ? 'entendido' : 'omitir';
    const userId = res.locals.user._id;
    const ahora = new Date();
    // Si estaba pedida para repetir: se actualiza. Si nunca la vio: se agrega UNA entrada (el
    // filtro $ne hace que dos pedidos a la par no dupliquen). Si ya la había visto: no cambia.
    const r = await User.updateOne(
      { _id: userId, novedadesVistas: { $elemMatch: { id, repetidaEn: { $ne: null } } } },
      { $set: { 'novedadesVistas.$.fecha': ahora, 'novedadesVistas.$.como': como, 'novedadesVistas.$.repetidaEn': null } },
    );
    if (!r.matchedCount) {
      await User.updateOne(
        { _id: userId, 'novedadesVistas.id': { $ne: id } },
        { $push: { novedadesVistas: { id, fecha: ahora, como, repetidaEn: null } } },
      );
    }
    invalidateUser(userId);
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar.' });
  }
});

module.exports = router;
