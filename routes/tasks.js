// Rutas del gestor de plantillas de actividades interactivas — panel del superadmin.
// Se monta en /superadmin/tasks (ver server.js). Todas las rutas requieren superadmin.
//
// La UI vive en views/superadmin/tasks/* (Fase 2). Por ahora este archivo entrega
// endpoints JSON crudos + una redirección temporal a /superadmin cuando se navega
// al GET raíz sin UI, para que el nav no tire 404 mientras armamos la Fase 2.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { requireAuth }        = require('../middleware/auth');
const { requireSuperadmin }  = require('../middleware/admin');
const { logAudit }           = require('../middleware/audit');
const ActivityTemplate       = require('../models/ActivityTemplate');
const TemplateAssignment     = require('../models/TemplateAssignment');
const School                 = require('../models/School');
const { computeAutoGrade }   = require('../services/autoGrader');
const { logDeRuta } = require('../middleware/route-log');
// Guarda de forma del :id, en la primera línea de cada handler con parámetro.
// Ver middleware/objectId.js y el issue conocido nº 10 de agente.md.
const { idMalo } = require('../middleware/objectId');

// El builder del cliente genera ids temporales "tmp-*" para preguntas, opciones,
// match items, etc. Antes de guardar, tenemos que asignarles ObjectIds reales
// Y traducir las referencias que apuntan a esos tmp-* (ej: correctPairs.leftId).
// Si no, Mongoose castea el string tmp-* a un ObjectId de bytes ASCII y las
// referencias quedan huérfanas — autoGrader nunca acertaría.
function isTmpId(s) {
  return typeof s === 'string' && s.startsWith('tmp-');
}

function normalizeIds(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => {
    const out = { ...q };
    if (isTmpId(out._id) || !out._id) out._id = new mongoose.Types.ObjectId();

    if (out.type === 'mc' && out.mc) {
      out.mc = { ...out.mc };
      out.mc.options = (out.mc.options || []).map(o => ({
        ...o,
        _id: (isTmpId(o._id) || !o._id) ? new mongoose.Types.ObjectId() : o._id,
      }));
    }

    if (out.type === 'match' && out.match) {
      const m = { ...out.match };
      // Mapping tmp-id → ObjectId real, en los DOS lados.
      const idMap = new Map();
      const remap = (arr) => (arr || []).map(it => {
        const wasTmp = isTmpId(it._id) || !it._id;
        const newId  = wasTmp ? new mongoose.Types.ObjectId() : it._id;
        if (wasTmp && it._id) idMap.set(String(it._id), String(newId));
        return { ...it, _id: newId };
      });
      m.leftItems  = remap(m.leftItems);
      m.rightItems = remap(m.rightItems);
      // Traducir referencias en correctPairs; si no está en el mapa lo dejamos
      // (era un ObjectId real de una edición previa).
      m.correctPairs = (m.correctPairs || []).map(p => ({
        leftId:  idMap.get(String(p.leftId))  || p.leftId,
        rightId: idMap.get(String(p.rightId)) || p.rightId,
      }));
      out.match = m;
    }

    return out;
  });
}

router.use(requireAuth, requireSuperadmin);

// GET /superadmin/tasks — HTML (index del gestor) o JSON (lista cruda).
// Detección: si el cliente pide JSON explícito (Accept: application/json), va JSON;
// si no, renderiza la vista con la lista precargada.
router.get('/', async (req, res) => {
  try {
    const templates = await ActivityTemplate.find()
      .sort({ updatedAt: -1 })
      .select('_id title description status questions defaultPoints createdBy createdAt updatedAt')
      .lean();

    // Detección explícita: si el fetch pasa Accept: application/json, devolvemos JSON.
    // Cualquier otra cosa (navegador) va a HTML.
    const wantsJson = req.get('accept') && req.get('accept').includes('application/json') && !req.get('accept').includes('text/html');
    if (wantsJson) return res.json({ templates });

    const stats = {
      total:     templates.length,
      draft:     templates.filter(t => t.status === 'draft').length,
      published: templates.filter(t => t.status === 'published').length,
      archived:  templates.filter(t => t.status === 'archived').length,
    };
    res.render('superadmin/tasks/index', { templates, stats });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /superadmin/tasks/new — builder vacío para crear plantilla.
router.get('/new', (req, res) => {
  res.render('superadmin/tasks/builder', { template: null });
});

// GET /superadmin/tasks/assign — matriz plantillas × escuelas. Trae todo cruzado
// para renderizar la vista de una sola vez (no hay paginación por ahora — el
// volumen esperado es bajo: pocas plantillas × pocas escuelas).
router.get('/assign', async (req, res) => {
  try {
    const [templates, schools, assignments] = await Promise.all([
      ActivityTemplate.find().sort({ updatedAt: -1 })
        .select('_id title description status questions defaultPoints updatedAt').lean(),
      School.find().sort({ name: 1 }).select('_id name color').lean(),
      TemplateAssignment.find().select('template school status respondedAt').lean(),
    ]);
    // Indexado por "templateId|schoolId" para que la vista busque O(1).
    const byPair = {};
    for (const a of assignments) byPair[`${a.template}|${a.school}`] = a;
    res.render('superadmin/tasks/assign', { templates, schools, byPair });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /superadmin/tasks/:id — detalle de una plantilla (JSON).
router.get('/:id', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada', { como: 'json' })) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id).lean();
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ template: t });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /superadmin/tasks/:id/edit — builder cargado con la plantilla existente.
router.get('/:id/edit', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id).lean();
    if (!t) return res.status(404).send('Plantilla no encontrada');
    res.render('superadmin/tasks/builder', { template: t });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /superadmin/tasks/:id/preview — jugarla como si fuera alumno (sin persistir).
router.get('/:id/preview', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id).lean();
    if (!t) return res.status(404).send('Plantilla no encontrada');
    res.render('superadmin/tasks/preview', { template: t });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /superadmin/tasks/:id/preview-grade — corre autoGrader sobre respuestas
// del propio superadmin y devuelve el breakdown. NO persiste nada.
router.post('/:id/preview-grade', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id).lean();
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const result = computeAutoGrade(t.questions || [], req.body.answers || []);
    res.json({ result });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/tasks — crear plantilla nueva (queda en status='draft').
// Body: { title, description?, defaultPoints?, questions[] }
router.post('/', async (req, res) => {
  try {
    const { title, description, defaultPoints, questions } = req.body;
    const t = await ActivityTemplate.create({
      title,
      description:   description   || '',
      defaultPoints: defaultPoints == null ? 100 : defaultPoints,
      questions:     normalizeIds(questions),
      createdBy:     req.userId,
      status:        'draft',
    });
    logAudit(req, 'task_template.create',
      [{ type: 'task_template', id: t._id, name: t.title }],
      { preguntas: t.questions.length },
    );
    res.status(201).json({ template: t });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /superadmin/tasks/:id — actualizar plantilla (solo campos editables).
// Cambiar status manualmente NO se permite acá — usar /publish o /archive.
router.put('/:id', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const { title, description, defaultPoints, questions } = req.body;
    const patch = {};
    if (title         !== undefined) patch.title = title;
    if (description   !== undefined) patch.description = description;
    if (defaultPoints !== undefined) patch.defaultPoints = defaultPoints;
    if (questions     !== undefined) patch.questions = normalizeIds(questions);
    const t = await ActivityTemplate.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true, runValidators: true });
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    logAudit(req, 'task_template.edit',
      [{ type: 'task_template', id: t._id, name: t.title }],
      { campos: Object.keys(patch).join(',') },
    );
    res.json({ template: t });
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/tasks/:id/publish — draft → published (habilita asignación a escuelas).
router.post('/:id/publish', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (!t.questions || t.questions.length === 0) {
      return res.status(400).json({ error: 'Agregá al menos una pregunta antes de publicar' });
    }
    t.status = 'published';
    await t.save();
    logAudit(req, 'task_template.publish',
      [{ type: 'task_template', id: t._id, name: t.title }],
    );
    res.json({ template: t });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/tasks/:id/archive — published → archived (oculta de listados por defecto).
// Las TemplateAssignment vivas y las Activity instanciadas NO se tocan.
router.post('/:id/archive', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findByIdAndUpdate(req.params.id, { $set: { status: 'archived' } }, { new: true });
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    logAudit(req, 'task_template.archive',
      [{ type: 'task_template', id: t._id, name: t.title }],
    );
    res.json({ template: t });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/tasks/:id/offer — ofrecer plantilla a una escuela.
// Body: { schoolId }. Upsert por índice único (template, school). Si la escuela
// ya la había rechazado, la re-ofrece (status vuelve a 'offered', se limpia
// respondedBy/respondedAt).
router.post('/:id/offer', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const { schoolId } = req.body;
    const t = await ActivityTemplate.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (t.status !== 'published') {
      return res.status(400).json({ error: 'Solo podés ofrecer plantillas publicadas' });
    }
    const school = await School.findById(schoolId).select('_id name');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    const a = await TemplateAssignment.findOneAndUpdate(
      { template: t._id, school: school._id },
      {
        $set:         { status: 'offered', offeredBy: req.userId },
        $unset:       { respondedBy: '', respondedAt: '' },
        $setOnInsert: { template: t._id, school: school._id },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logAudit(req, 'task_template.offer',
      [{ type: 'task_template', id: t._id, name: t.title }, { type: 'school', id: school._id, name: school.name }],
    );
    res.json({ assignment: a });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/tasks/:id/revoke — quita la oferta de una escuela.
// Body: { schoolId }. Borrado del TemplateAssignment. Si el admin ya había
// aceptado, la revocación deja a los docentes sin acceso (Fase 5 chequea el doc).
router.post('/:id/revoke', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const { schoolId } = req.body;
    const t = await ActivityTemplate.findById(req.params.id).select('_id title');
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const school = await School.findById(schoolId).select('_id name');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    const r = await TemplateAssignment.findOneAndDelete({ template: t._id, school: school._id });
    if (!r) return res.status(404).json({ error: 'Esta plantilla no estaba ofrecida a esa escuela' });

    logAudit(req, 'task_template.revoke',
      [{ type: 'task_template', id: t._id, name: t.title }, { type: 'school', id: school._id, name: school.name }],
    );
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /superadmin/tasks/:id — borrado duro. Bloqueado si tiene asignaciones vivas.
router.delete('/:id', async (req, res) => {
  if (idMalo(req, res, 'Plantilla no encontrada')) return;
  try {
    const t = await ActivityTemplate.findById(req.params.id);
    if (!t) return res.status(404).json({ error: 'Plantilla no encontrada' });

    // Si hay asignaciones a escuelas, exigimos desasignar primero para evitar
    // dejar TemplateAssignment huérfanos apuntando a plantillas inexistentes.
    const assignedCount = await TemplateAssignment.countDocuments({ template: t._id });
    if (assignedCount > 0) {
      return res.status(400).json({
        error: `La plantilla está asignada a ${assignedCount} escuela(s). Desasignala primero.`,
      });
    }

    await t.deleteOne();
    logAudit(req, 'task_template.delete',
      [{ type: 'task_template', id: t._id, name: t.title }],
    );
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
