const express  = require('express');
const AuditLog = require('../models/AuditLog');
const School   = require('../models/School');
const { requireAuth }        = require('../middleware/auth');
const { requireAdmin }       = require('../middleware/admin');
const { requireSuperAdmin }  = require('../middleware/superadmin');
const { ACTIONS, CATEGORIES } = require('../config/audit-actions');

const router    = express.Router();
const PAGE_SIZE = 50;

// Handler compartido admin/superadmin.
// isSuperadmin=true → sin scope de escuela + filtro extra opcional ?schoolId.
async function listAudit(req, res, { isSuperadmin }) {
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = {};

  if (isSuperadmin) {
    // El superadmin puede filtrar por una escuela específica o por "sin escuela"
    // (eventos platform-wide como backup/mantenimiento/crear escuela).
    if (req.query.schoolId === 'none')      filter.school = null;
    else if (req.query.schoolId)            filter.school = req.query.schoolId;
  } else {
    // Admin: siempre acotado a su propia escuela.
    filter.school = res.locals.user.school || null;
  }

  if (req.query.action) filter.action = req.query.action;
  // Filtro por categoría: prefix match sobre la parte antes del punto de la acción.
  // Se pasa por regex escapada (los valores del catálogo son alfanuméricos, así
  // que no hay caracteres raros que romper; el escape es defensa en profundidad).
  if (req.query.category) {
    const safe = req.query.category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.action = { $regex: '^' + safe + '\\.' };
  }
  if (req.query.role) filter['actor.role'] = req.query.role;
  if (req.query.from || req.query.to) {
    filter.timestamp = {};
    if (req.query.from) filter.timestamp.$gte = new Date(req.query.from);
    // Incluye todo el día del "to" (hasta 23:59:59.999)
    if (req.query.to)   filter.timestamp.$lte = new Date(req.query.to + 'T23:59:59.999Z');
  }
  if (req.query.q) {
    const safe = req.query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    filter.$or = [
      { 'actor.name':   re },
      { 'actor.email':  re },
      { 'targets.name': re },
    ];
  }

  const [total, entries, schools] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).sort({ timestamp: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    isSuperadmin ? School.find().select('name color').sort({ name: 1 }).lean() : Promise.resolve([]),
  ]);

  const totalPages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);

  // queryParams para preservar filtros en los links de paginación
  const queryParams = {};
  ['action', 'category', 'role', 'from', 'to', 'q', 'schoolId'].forEach(k => {
    if (req.query[k]) queryParams[k] = req.query[k];
  });

  res.render(isSuperadmin ? 'superadmin/audit' : 'admin/audit', {
    entries,
    total,
    page:       clampedPage,
    totalPages,
    pageSize:   PAGE_SIZE,
    queryParams,
    filters: {
      action:   req.query.action   || '',
      category: req.query.category || '',
      role:     req.query.role     || '',
      from:     req.query.from     || '',
      to:       req.query.to       || '',
      q:        req.query.q        || '',
      schoolId: req.query.schoolId || '',
    },
    actions:    ACTIONS,
    categories: CATEGORIES,
    schools,
    isSuperadmin,
  });
}

router.get('/admin/audit',      requireAuth, requireAdmin,      (req, res, next) => listAudit(req, res, { isSuperadmin: false }).catch(next));
router.get('/superadmin/audit', requireAuth, requireSuperAdmin, (req, res, next) => listAudit(req, res, { isSuperadmin: true  }).catch(next));

module.exports = router;
