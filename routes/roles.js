// Panel de Roles — /superadmin/roles
//
// Grilla de roles × solapas donde el superadmin habilita o deshabilita, POR ESCUELA, qué
// ve y qué puede abrir cada rol. Lo que se guarda son las secciones DENEGADAS (ver
// models/School.js, campo rolePermissions); el catálogo de secciones y las reglas de qué
// se puede tocar viven en config/sections.js.
//
// Va en archivo propio y no dentro de routes/superadmin.js por el mismo criterio que
// routes/backup.js y routes/dbFixes.js: superadmin.js ya tiene ~950 líneas y 30 rutas.
// El mount en server.js va ANTES del catch-all de /superadmin.
//
// Este panel NO se puede restringir a sí mismo: superadmin_roles está locked, igual que
// todo el panel de superadministración. Es a propósito — si se pudiera, existiría una
// configuración que deja a la cuenta afuera de la única pantalla desde donde se arregla.

const express  = require('express');
const mongoose = require('mongoose');
const School   = require('../models/School');
const User     = require('../models/User');
const { requireAuth }       = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superadmin');
const { invalidateSchool }  = require('../middleware/cache');
const { logAudit }          = require('../middleware/audit');
const { SECTIONS, PANELS, isConfigurable } = require('../config/sections');
// Confidencialidad de los legajos del SOE. No pasa por SECTIONS a propósito: aquel sistema
// es restrictivo (solo quita) y este tiene que AGREGAR acceso sobre un default cerrado.
// Ver models/School.js, campo soeAccess.
const soeAcceso = require('../services/soeAcceso');
const { logDeRuta } = require('../middleware/route-log');

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

// Los datos que necesita la tarjeta de legajos del SOE. En un helper para que las dos
// ramas del GET (con escuelas y sin ninguna) no puedan quedar desincronizadas.
const localesSoe = (school) => ({
  SOE_ROLES: soeAcceso.ROLES_CONFIGURABLES,
  SOE_NIVELES_POR_ROL: Object.fromEntries(
    soeAcceso.ROLES_CONFIGURABLES.map(r => [r, soeAcceso.nivelesPara(r)]),
  ),
  SOE_NIVEL_LABELS: soeAcceso.NIVEL_LABELS,
  soeAccess: (school && school.soeAccess) || {},
});

// GET /superadmin/roles[?school=<id>]
// Sin ?school, muestra la primera escuela: la pantalla nunca arranca vacía.
router.get('/', async (req, res) => {
  try {
    const schools = await School.find().select('name color slug').sort({ name: 1 }).lean();
    if (!schools.length) {
      return res.render('superadmin/roles', {
        schools: [], school: null, SECTIONS, PANELS, roles: User.getRoles(), activePage: 'roles',
        ...localesSoe(null),
      });
    }

    const wanted = req.query.school && mongoose.isValidObjectId(req.query.school)
      ? schools.find(s => s._id.toString() === req.query.school)
      : null;
    const target = wanted || schools[0];

    const school = await School.findById(target._id).select('name color rolePermissions soeAccess').lean();
    if (!school) return res.status(404).send('Escuela no encontrada');

    res.render('superadmin/roles', {
      schools, school, SECTIONS, PANELS, roles: User.getRoles(), activePage: 'roles',
      ...localesSoe(school),
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /superadmin/roles/toggle — habilita/deshabilita una sección para un rol.
// Body: { schoolId, role, key, enabled }
//
// Se valida TODO en el servidor y no solo con el candado de la vista: isConfigurable()
// es la misma función que usa la pantalla para decidir qué celda dibuja como toggle, así
// que no puede pasar que la UI ofrezca algo que el servidor rechaza (ni al revés).
router.post('/toggle', async (req, res) => {
  try {
    const { schoolId, role, key } = req.body;
    const enabled = req.body.enabled === true || req.body.enabled === 'true';

    if (!mongoose.isValidObjectId(schoolId)) {
      return res.status(400).json({ error: 'Escuela inválida' });
    }
    if (!User.getRoles().includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    if (role === 'superadmin') {
      return res.status(400).json({ error: 'El superadministrador no se puede restringir' });
    }
    // Cubre de una sola vez: key desconocida, sección locked, panel de superadmin,
    // sección atada al email del dueño, y rol que no tiene acceso base a esa sección.
    if (!isConfigurable(role, key)) {
      return res.status(400).json({ error: 'Esta solapa no se puede configurar para ese rol' });
    }

    // Escritura atómica, sin leer-modificar-guardar: si dos toggles de la misma escuela
    // salen casi a la vez, ninguno pisa al otro.
    const update = enabled
      ? { $pull:     { [`rolePermissions.${role}`]: key } }
      : { $addToSet: { [`rolePermissions.${role}`]: key } };

    const school = await School.findByIdAndUpdate(schoolId, update, { new: true })
      .select('name rolePermissions');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    // Obligatorio: res.locals.school va cacheado por worker (ver middleware/cache.js).
    // Sin esto, el cambio no se ve hasta que expire el TTL.
    invalidateSchool(schoolId);

    // schoolId explícito: el superadmin no tiene escuela propia, y sin el override el
    // evento quedaría registrado como "sin escuela" en vez de contra la que se editó.
    logAudit(req, 'school.role_permissions_update',
      [{ type: 'school', id: school._id, name: school.name }],
      { rol: role, seccion: key, habilitado: enabled },
      { schoolId },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/roles/reset — devuelve un rol a los permisos por defecto.
// Body: { schoolId, role }. Es la red de seguridad para desarmar de un saque una escuela
// que quedó mal configurada, sin tener que apagar toggle por toggle.
router.post('/reset', async (req, res) => {
  try {
    const { schoolId, role } = req.body;

    if (!mongoose.isValidObjectId(schoolId)) {
      return res.status(400).json({ error: 'Escuela inválida' });
    }
    if (!User.getRoles().includes(role) || role === 'superadmin') {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const school = await School.findByIdAndUpdate(
      schoolId,
      { $unset: { [`rolePermissions.${role}`]: '' } },
      { new: true },
    ).select('name rolePermissions');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    invalidateSchool(schoolId);

    logAudit(req, 'school.role_permissions_update',
      [{ type: 'school', id: school._id, name: school.name }],
      { rol: role, seccion: 'todas', habilitado: true },
      { schoolId },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /superadmin/roles/soe-access — nivel de acceso de un rol a los legajos del SOE.
// Body: { schoolId, role, nivel }
//
// Endpoint aparte de /toggle porque lo que se guarda es distinto: no es una solapa denegada
// sino un nivel de acceso a CONTENIDO, y vive en School.soeAccess (ver models/School.js).
//
// La validación repite el techo por rol que ya aplica services/soeAcceso.js al leer. No es
// redundancia inútil: acá evita que quede guardado un valor imposible, y allá garantiza que
// aunque quede guardado (por un mongosh, una importación o un bug futuro) no conceda nada.
router.post('/soe-access', async (req, res) => {
  try {
    const { schoolId, role, nivel } = req.body;

    if (!mongoose.isValidObjectId(schoolId)) {
      return res.status(400).json({ error: 'Escuela inválida' });
    }
    if (!soeAcceso.ROLES_CONFIGURABLES.includes(role)) {
      return res.status(400).json({ error: 'Ese rol no se configura acá' });
    }
    if (!soeAcceso.nivelesPara(role).includes(nivel)) {
      return res.status(400).json({ error: 'Nivel no permitido para ese rol' });
    }

    const school = await School.findByIdAndUpdate(
      schoolId,
      { $set: { [`soeAccess.${role}`]: nivel } },
      { new: true, runValidators: true },
    ).select('name soeAccess');
    if (!school) return res.status(404).json({ error: 'Escuela no encontrada' });

    // Obligatorio: res.locals.school va cacheado por worker (ver middleware/cache.js), y
    // este campo es el que decide quién entra al panel del SOE. Sin esto, el cambio no
    // tiene efecto hasta que expire el TTL de 5 minutos.
    invalidateSchool(schoolId);

    logAudit(req, 'school.role_permissions_update',
      [{ type: 'school', id: school._id, name: school.name }],
      { rol: role, seccion: 'soe_legajos', nivel },
      { schoolId },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
