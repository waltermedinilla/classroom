// Panel "Otros" del superadmin — /superadmin/otros
//
// Sanar la base de datos: arreglos de integridad que se diagnostican y se aplican con un
// botón. El catálogo vive en services/dbFixes.js; acá solo están las rutas y las guardas.
//
// Autorización: misma doble capa que backup/restore (rol superadmin + SYSTEM_OWNER_EMAIL).
// Estos arreglos escriben en masa sobre miles de documentos y no hay "deshacer", así que
// no alcanza con el chequeo de rol por si en el futuro se crea otro superadmin.

const express = require('express');
const { requireAuth }       = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/admin');
const { invalidateAll }     = require('../middleware/cache');
const { logAudit }          = require('../middleware/audit');
const { SYSTEM_OWNER_EMAIL } = require('../config/maintenance');
const { getFix, diagnosticarTodos } = require('../services/dbFixes');

const router = express.Router();

function requireOwner(req, res, next) {
  if (res.locals.user?.email !== SYSTEM_OWNER_EMAIL) {
    return res.status(403).send('Acceso denegado');
  }
  next();
}

router.use(requireAuth, requireSuperadmin, requireOwner);

/* ─── Pantalla principal ─────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const fixes = await diagnosticarTodos();
    res.render('superadmin/otros', {
      fixes,
      pendientes: fixes.filter(f => f.total > 0).length,
      activePage: 'otros',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Re-diagnóstico de un arreglo (para refrescar la tarjeta sin recargar) ─ */
router.get('/:id/diagnostico', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  try {
    const d = await fix.diagnosticar();
    res.json({ total: d.total, muestra: d.muestra, nota: d.nota || null });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo diagnosticar: ' + err.message });
  }
});

/* ─── Aplicar ────────────────────────────────────────────────────────────── */
router.post('/:id/aplicar', async (req, res) => {
  const fix = getFix(req.params.id);
  if (!fix) return res.status(404).json({ error: 'Ese arreglo no existe' });
  if (!fix.aplicable || typeof fix.aplicar !== 'function') {
    return res.status(400).json({
      error: 'Este arreglo es solo de diagnóstico: no hay una regla automática que lo resuelva sin inventar datos.',
    });
  }

  try {
    // El conteo previo va al log de auditoría: es lo que permite después saber sobre
    // cuántos registros se corrió, aunque el diagnóstico ya dé cero.
    const antes = await fix.diagnosticar();
    const resultado = await fix.aplicar(req.body || {});

    // Varios arreglos tocan documentos de User (escuela, alcance de preceptor) que viven
    // cacheados 45s por worker. Sin limpiar, el efecto no se ve hasta que expire el TTL.
    invalidateAll();

    logAudit(req, 'system.db_fix',
      [],
      {
        arreglo: fix.id,
        detectados: antes.total,
        afectados: resultado.afectados,
        ...(req.body && Object.keys(req.body).length ? { parametros: JSON.stringify(req.body) } : {}),
      },
    );

    const despues = await fix.diagnosticar();
    res.json({
      ok: true,
      afectados: resultado.afectados,
      mensaje: resultado.mensaje,
      restantes: despues.total,
    });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo aplicar: ' + err.message });
  }
});

module.exports = router;
