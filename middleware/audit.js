// Helper fire-and-forget para registrar eventos en la colección auditlogs.
// ────────────────────────────────────────────────────────────────────────────
// INVARIANTE — logAudit() NUNCA debe throwear al llamador.
// ────────────────────────────────────────────────────────────────────────────
// El diseño es que un fallo en el audit (Mongo caído, payload malformado,
// bug en el catálogo) NO puede romper la operación real (calificar, entregar,
// borrar, etc.). Por eso:
//   1. TODO el cuerpo está envuelto en try/catch — captura errores síncronos
//      (regex mal armado, propiedad rota, tipo incorrecto).
//   2. La promesa de `AuditLog.create(...)` tiene su propio .catch() — captura
//      errores asíncronos (Mongo timeout, ValidationError, red, disco lleno).
//   3. Ninguna rama del código hace throw, ni retorna la promesa. Se pierde
//      un log pero la request principal sigue de largo.
//
// KILLSWITCH — variable de entorno AUDIT_ENABLED=false desactiva TODO. Útil
// para debug de emergencia en producción sin necesidad de redeploy: pm2 restart
// con la env var seteada apaga por completo la escritura de auditoría.
//
// Uso típico:
//   logAudit(req, 'activity.create',
//     [{ type: 'activity', id: activity._id, name: activity.title },
//      { type: 'course',   id: course._id,   name: course.name }],
//     { puntos: activity.points });
//
// Options:
//   schoolId — override para eventos donde el actor no coincide con la escuela
//              del recurso (ej: superadmin editando una escuela específica).
//              Default: la escuela del actor autenticado.

const AuditLog    = require('../models/AuditLog');
const logger      = require('../config/logger');
const { ACTIONS } = require('../config/audit-actions');

const AUDIT_ENABLED = process.env.AUDIT_ENABLED !== 'false';

function logAudit(req, action, targets = [], meta = {}, options = {}) {
  // Killswitch: si está desactivado, no hacemos NADA. Ni siquiera armamos el payload.
  if (!AUDIT_ENABLED) return;

  try {
    // Sanity check en dev: si la acción no está en el catálogo, avisar. En prod
    // igual se guarda — no queremos que un typo rompa nada, solo se registra.
    if (process.env.NODE_ENV !== 'production' && !ACTIONS[action]) {
      logger.warn(`[audit] acción no registrada en el catálogo: ${action}`);
    }

    const user     = req?.res?.locals?.user;
    const schoolId = options && options.schoolId !== undefined
      ? options.schoolId
      : (user?.school || null);

    // Normaliza targets defensivamente: acepta undefined, null, no-array, elementos rotos.
    const safeTargets = Array.isArray(targets)
      ? targets
          .filter(t => t && t.type && t.id)
          .map(t => ({ type: String(t.type), id: t.id, name: String(t.name || '') }))
      : [];

    const payload = {
      action: String(action || ''),
      actor: {
        userId: user?._id  || null,
        name:   String(user?.name  || ''),
        role:   String(user?.role  || ''),
        email:  String(user?.email || ''),
      },
      targets:   safeTargets,
      school:    schoolId,
      timestamp: new Date(),
      meta:      (meta && typeof meta === 'object') ? meta : {},
      ip:        req?.ip || '',
      userAgent: (typeof req?.get === 'function' ? (req.get('user-agent') || '') : '').slice(0, 200),
    };

    // Sin await — Mongoose devuelve una promesa que atrapamos con .catch(). No
    // hay throw fuera de este .catch(), así que unhandledRejection nunca dispara.
    AuditLog.create(payload).catch(err => {
      // Loguear a stderr pero JAMÁS re-throwear.
      try { logger.error('audit log failed', { action, error: err.message }); } catch {}
    });
  } catch (err) {
    // Cualquier error síncrono (payload malformado, propiedad rota, bug del catálogo)
    // se traga acá. La request principal ya se completó normalmente.
    try { logger.error('audit log threw synchronously', { action, error: err.message }); } catch {}
  }
}

module.exports = { logAudit };
