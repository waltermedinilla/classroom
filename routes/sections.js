// CRUD de Secciones — /admin/secciones
//
// Una Sección es un recorte del establecimiento con nombre: mezcla divisiones ENTERAS con
// materias sueltas, y tiene uno o más jefes. Ver models/Section.js para el porqué de la
// forma; acá solo está el CRUD.
//
// OJO con la palabra: estas Secciones son datos de la escuela. Las "secciones" de
// config/sections.js y del sectionGuard son las SOLAPAS del panel. No se tocan entre sí.
//
// ── POR QUÉ ESTÁ ACÁ Y NO EN routes/admin.js, DE DONDE SALIÓ ────────────────────────────
// routes/admin.js:133 monta `requireAdmin` sobre TODO el panel de una sola vez. El Jefe de
// Sección tiene que poder configurar el contenido de sus propias secciones, y meterle una
// excepción a esa guarda lo dejaría entrar también a Usuarios, Cursos, Importar y Auditoría.
// Con un router aparte —montado en server.js ANTES de /admin, para que gane el match— la
// guarda del panel se queda intacta y acá se decide caso por caso.
//
// ── LAS DOS FORMAS DE ENTRAR ────────────────────────────────────────────────────────────
//   admin / superadmin → ven y administran todas las secciones de su escuela
//   jefe               → solo las suyas (las que lo tienen en Section.heads), y solo para
//                        editarles el nombre y el contenido
//
// Lo que el jefe NO puede: crear, borrar, ni tocar la lista de jefes. Crear una sección
// sería otorgarse un alcance desde cero; editar `heads`, dárselo a un tercero. Las dos cosas
// siguen siendo del admin.
//
// Lo que SÍ puede, y es una decisión explícita del usuario: elegir CUALQUIER curso y
// CUALQUIER materia de su escuela para meter en su sección — o sea, ampliarse el alcance
// hasta la escuela entera si quiere. El control es posterior y vive en la auditoría, donde
// cada `section.edit` queda con el conteo de cursos y materias que dejó.

const express  = require('express');
const mongoose = require('mongoose');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Division = require('../models/Division');
const Section  = require('../models/Section');
const { requireAuth }      = require('../middleware/auth');
const { requireSection }   = require('../middleware/sections');
const { logAudit }         = require('../middleware/audit');
const { logDeRuta, logRechazo } = require('../middleware/route-log');

const router = express.Router();

const ROLES_CON_ACCESO = ['admin', 'superadmin', 'jefe'];

// El rol es la puerta de calle; el alcance dentro de la pantalla lo decide `esAdmin` y
// `puedeEditar`, más abajo.
const requireAccesoSecciones = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// requireSection y no sectionGuard: este router es UNA sola solapa del catálogo, no un panel
// entero, así que no hay path que resolver. Sigue respetando el toggle de /superadmin/roles
// —ahora también para el rol jefe, que a partir de este cambio tiene su celda ahí.
router.use(requireAuth, requireAccesoSecciones, requireSection('admin_sections'));

// Quién administra el CONJUNTO: crear, borrar y decidir quién está a cargo de qué.
const esAdmin = (user) => user.role === 'admin' || user.role === 'superadmin';

// ¿Este usuario puede tocar ESTA sección? Se chequea contra el documento y no contra una
// lista precalculada al entrar: `heads` cambia sin invalidar ninguna caché (ver el comentario
// largo de models/Section.js), así que sacar a un jefe de una sección le cierra la puerta ya
// en el request siguiente.
const puedeEditar = (user, seccion) =>
  esAdmin(user) || (seccion.heads || []).some(h => h.toString() === user._id.toString());

// Rechazo de las acciones que son solo del admin. Rama JSON porque los POST de las dos
// vistas salen por fetch(): sin ella recibirían HTML donde esperan JSON, igual que en
// middleware/sections.js.
function soloAdmin(req, res, motivo) {
  logRechazo(res, 403, motivo, { seccion: req.params.id || null });
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return res.status(403).send('Acceso denegado');
}

// Filtra una lista de ids dejando solo los que existen y son de `school`. Mismo criterio y
// mismo motivo que resolveScopeDivisions: sin esto, un POST armado a mano podría meter
// materias de otra escuela dentro de una sección y el jefe las vería.
async function resolveDeLaEscuela(Model, ids, school, extraFiltro = {}) {
  if (!Array.isArray(ids) || !ids.length || !school) return [];
  const validos = await Model.find({ _id: { $in: ids.filter(mongoose.isValidObjectId) }, school, ...extraFiltro })
    .select('_id').lean();
  return validos.map(d => d._id);
}

// Cuántas materias abarca realmente una sección, con el mismo criterio que usa el panel del
// jefe: las materias de sus divisiones enteras MÁS las sueltas, sin contar dos veces una
// materia que esté por los dos caminos.
async function materiasDeSeccion(seccion, school) {
  if (!seccion.divisions.length && !seccion.courses.length) return 0;
  return Course.countDocuments({
    school,
    $or: [
      { division: { $in: seccion.divisions } },
      { _id: { $in: seccion.courses } },
    ],
  });
}

router.get('/', async (req, res) => {
  const user   = res.locals.user;
  const school = user.school;
  const sf     = school ? { school } : {};
  const { search } = req.query;
  const filter = { ...sf };
  if (search) filter.name = { $regex: search, $options: 'i' };

  // El jefe ve SOLO las suyas. No alcanza con que la barrera de /:id/edit lo frene: sin este
  // filtro la grilla ya le mostraría el nombre, el contenido y los jefes de todas las
  // secciones de la escuela, que es justo lo que el rol no tiene por qué ver.
  if (!esAdmin(user)) filter.heads = user._id;

  const secciones = await Section.find(filter)
    .populate('divisions', 'name')
    .populate('heads', 'name email active')
    .sort({ name: 1 })
    .lean();

  const filas = await Promise.all(secciones.map(async (s) => ({
    ...s,
    materias: await materiasDeSeccion(s, school),
  })));

  res.render('admin/sections', {
    secciones: filas,
    search: search || '',
    puedeAdministrar: esAdmin(user),
  });
});

// El formulario de alta y el de edición son la misma vista. Las dos ramas cargan el árbol
// completo de divisiones y materias de la escuela: son ~40 y ~420 documentos, chico como
// para mandarlo entero y armar el acordeón del lado del navegador.
//
// El árbol es el mismo para el jefe: puede elegir cualquier curso y cualquier materia de su
// escuela (ver el encabezado del archivo).
async function datosFormularioSeccion(school) {
  const [divisiones, materias, jefes] = await Promise.all([
    Division.find({ school }).sort({ name: 1 }).select('_id name').lean(),
    Course.find({ school }).sort({ name: 1 }).select('_id name division').lean(),
    // Solo usuarios con el rol: asignar como jefe a alguien que no lo es le dejaría el
    // alcance guardado sin poder entrar nunca al panel.
    User.find({ school, role: 'jefe' }).sort({ name: 1 }).select('_id name email active').lean(),
  ]);
  return {
    divisiones: divisiones.map(d => ({ id: d._id.toString(), nombre: d.name })),
    materias:   materias.map(c => ({ id: c._id.toString(), nombre: c.name, division: c.division?.toString() || '' })),
    jefes:      jefes.map(u => ({ id: u._id.toString(), nombre: u.name, email: u.email, activo: u.active !== false })),
  };
}

router.get('/create', async (req, res) => {
  const user = res.locals.user;
  if (!esAdmin(user)) return soloAdmin(req, res, 'jefe intentó crear una sección');

  const school = user.school;
  if (!school) return res.status(400).send('Sin escuela asignada');
  res.render('admin/section-form', {
    seccion: null, puedeAdministrar: true, ...await datosFormularioSeccion(school),
  });
});

router.get('/:id/edit', async (req, res) => {
  const user = res.locals.user;
  // Un id con forma inválida hacía lanzar CastError a findById, y en Express 4 un throw
  // dentro de un handler async deja el request colgado. Acá importa más que en otras
  // pantallas: la barrera de abajo es lo único que separa a un jefe de las notas de otra
  // sección, y se prueba justamente escribiendo ids en la barra de direcciones.
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send('Sección no encontrada');

  const school  = user.school;
  const seccion = await Section.findById(req.params.id).lean();
  if (!seccion) return res.status(404).send('Sección no encontrada');
  if (school && seccion.school?.toString() !== school.toString()) return res.status(403).send('Acceso denegado');
  if (!puedeEditar(user, seccion)) return soloAdmin(req, res, 'jefe intentó abrir una sección que no es suya');

  res.render('admin/section-form', {
    seccion: {
      ...seccion,
      divisions: seccion.divisions.map(String),
      courses:   seccion.courses.map(String),
      heads:     seccion.heads.map(String),
    },
    puedeAdministrar: esAdmin(user),
    ...await datosFormularioSeccion(school),
  });
});

// Deja el body en la forma que se guarda, validando las tres listas contra la escuela.
// Devuelve un string con el error si algo no cierra, o null si está todo bien.
//
// `headsFijos` es la rama del jefe: en vez de leer body.headIds se conservan los jefes que la
// sección ya tenía. El body llega igual desde el navegador (la vista manda el formulario
// entero), así que lo que lo hace seguro es que acá NO se mira.
async function armarSeccion(body, school, headsFijos = null) {
  const divisions = await resolveDeLaEscuela(Division, body.divisionIds, school);
  const courses   = await resolveDeLaEscuela(Course,   body.courseIds,   school);
  const base      = { name: (body.name || '').trim(), divisions, courses };

  if (headsFijos) return { datos: { ...base, heads: headsFijos } };

  const heads = await resolveDeLaEscuela(User, body.headIds, school, { role: 'jefe' });

  // Que la sección quede vacía no se bloquea: el admin puede querer crearla y llenarla
  // después. La pantalla avisa en ámbar, y el jefe ve la pantalla de "sin alcance".
  if (Array.isArray(body.headIds) && body.headIds.length !== heads.length) {
    return { error: 'Alguno de los jefes elegidos no existe, no es de esta escuela o ya no tiene el rol Jefe de Sección.' };
  }
  return { datos: { ...base, heads } };
}

router.post('/create', async (req, res) => {
  try {
    const user = res.locals.user;
    if (!esAdmin(user)) return soloAdmin(req, res, 'jefe intentó crear una sección');

    const school = user.school;
    if (!school) return res.status(400).json({ error: 'Sin escuela asignada' });

    const { datos, error } = await armarSeccion(req.body, school);
    if (error) return res.status(400).json({ error });

    const seccion = await Section.create({ ...datos, school });

    logAudit(req, 'section.create',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      { cursos: seccion.divisions.length, materias: seccion.courses.length, jefes: seccion.heads.length },
    );

    res.status(201).json({ seccion });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una sección con ese nombre en esta escuela' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

router.post('/:id/edit', async (req, res) => {
  try {
    const user = res.locals.user;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Sección no encontrada' });

    const school   = user.school;
    const existing = await Section.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Sección no encontrada' });
    if (school && existing.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });
    if (!puedeEditar(user, existing)) return soloAdmin(req, res, 'jefe intentó editar una sección que no es suya');

    // El jefe no toca `heads`: se conservan los que la sección ya tenía. Poder editarlos
    // sería poder darle acceso a las notas de su sección a cualquier otro jefe de la escuela
    // —o quitárselo a un colega— sin que el admin se entere.
    const { datos, error } = await armarSeccion(req.body, school, esAdmin(user) ? null : existing.heads);
    if (error) return res.status(400).json({ error });

    const seccion = await Section.findByIdAndUpdate(req.params.id, datos, { new: true, runValidators: true });

    // No hace falta invalidateUser: los jefes se resuelven leyendo Section en cada request
    // (middleware/jefatura.js), no desde el doc de usuario cacheado. El cambio se ve ya.
    logAudit(req, 'section.edit',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      {
        ...(existing.name !== seccion.name ? { de: existing.name, a: seccion.name } : {}),
        cursos: seccion.divisions.length, materias: seccion.courses.length, jefes: seccion.heads.length,
      },
      { schoolId: existing.school || null },
    );

    res.json({ seccion });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Ya existe una sección con ese nombre' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Sin guarda referencial a propósito: borrar una sección no destruye ningún dato de la
// escuela, solo les saca el alcance a sus jefes. La vista lo dice en el confirm().
//
// El jefe no llega acá aunque la sección sea suya: borrarla dejaría sin alcance también a
// los otros jefes que la comparten.
router.post('/:id/delete', async (req, res) => {
  try {
    const user = res.locals.user;
    if (!esAdmin(user)) return soloAdmin(req, res, 'jefe intentó borrar una sección');
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Sección no encontrada' });

    const school  = user.school;
    const seccion = await Section.findById(req.params.id);
    if (!seccion) return res.status(404).json({ error: 'Sección no encontrada' });
    if (school && seccion.school?.toString() !== school.toString()) return res.status(403).json({ error: 'Sin acceso' });

    await Section.findByIdAndDelete(req.params.id);

    logAudit(req, 'section.delete',
      [{ type: 'section', id: seccion._id, name: seccion.name }],
      { jefes: seccion.heads.length },
      { schoolId: seccion.school || null },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
