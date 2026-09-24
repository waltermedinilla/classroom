// Guardas y resolución de alcance del panel de Jefatura de Sección.
//
// Un Jefe de Sección no ve la escuela entera: ve las Secciones donde un admin lo puso como
// jefe (Section.heads). Una sección mezcla divisiones ENTERAS con materias sueltas, así que
// el alcance se resuelve siempre a un conjunto de MATERIAS (Course), que es el grano contra
// el que cuelgan las actividades.
//
// Igual que en middleware/preceptor.js, el alcance se resuelve UNA vez por request y todas
// las rutas consultan el resultado en vez de recalcularlo.
//
// REGLA QUE NO HAY QUE ROMPER: alcance vacío significa "no ve nada", nunca "ve todo". El rol
// se puede asignar por varios caminos que no preguntan por secciones (cambio de rol
// individual o en lote desde /admin y /superadmin), y en todos ellos el usuario queda sin
// ninguna sección. Si "vacío" significara "todas", esos caminos entregarían la escuela entera.
//
// ⚠️ Nada que ver con middleware/sections.js: aquél es el enforcement de las SOLAPAS del
// panel. Acá "sección" es la entidad de datos de models/Section.js.
//
// ── EL DOCENTE JEFE ─────────────────────────────────────────────────────────────────────
// Un `teacher` que figura en Section.heads también entra, acotado a sus secciones y sin
// dejar de ser docente (specs/docente-jefe-de-seccion.spec.md). Para él la jefatura no la da
// el rol: la da la sección. Por eso requireJefe lo deja pasar solo como CANDIDATO y la
// barrera real es loadJefaturaScope — una ruta de jefatura montada fuera de esa cadena le
// abriría el panel a cualquier docente.

const Section = require('../models/Section');
const Course  = require('../models/Course');
const logger  = require('../config/logger');
const { logRechazo } = require('./route-log');
const {
  ROLES_JEFATURA_SIN_LIMITE, ROLES_JEFATURA_POR_ROL, ROLES_JEFATURA_POR_SECCION,
  modoJefatura, decidirAccesoJefatura,
} = require('../services/jefaturaAcceso');

// Roles que pueden entrar al panel. Los de mayor privilegio ven lo mismo que un jefe,
// misma filosofía que middleware/directivo.js y middleware/preceptor.js. El `teacher` está
// como candidato: sin ninguna sección a cargo, loadJefaturaScope le contesta 403.
const ROLES_CON_ACCESO = [...ROLES_JEFATURA_POR_ROL, ...ROLES_JEFATURA_SIN_LIMITE, ...ROLES_JEFATURA_POR_SECCION];

// Roles que NO están acotados a las secciones donde figuran como jefe: ven todas las
// secciones de su escuela. Un directivo o un admin entra a mirar el panel sin que nadie
// tenga que agregarlo como jefe de cada sección.
const ROLES_SIN_LIMITE = ROLES_JEFATURA_SIN_LIMITE;

const requireJefe = (req, res, next) => {
  if (!res.locals.user || !ROLES_CON_ACCESO.includes(res.locals.user.role)) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// El docente sin ninguna sección recibe 403 y no la pantalla "Todavía no tenés secciones a
// cargo": esa le habla a un jefe que espera una asignación, y mostrársela a cualquier docente
// que escriba la URL le haría creer que le falta una. Queda en el log para poder contestar
// "no me deja entrar a Jefatura" sin adivinar.
function rechazarDocente(res) {
  logRechazo(res, 403, 'docente sin secciones a cargo');
  return res.status(403).send('Acceso denegado');
}

// ── ¿Este docente está a cargo de alguna sección? ─────────────────────────────────────
// Memo POR REQUEST y nunca entre requests: un caché le dejaría el menú desactualizado hasta
// que venza, y su invalidación tendría el mismo problema de los dos workers que ya documenta
// middleware/cache.js. Lo comparten el guard de /admin/secciones y el menú: la misma página
// paga una sola consulta.
//
// Si la consulta falla, la promesa rechaza y decide quien llama: el guard responde 500, el
// menú pinta sin el enlace.
const MEMO_PERTENENCIA = Symbol('pertenenciaJefatura');

function pertenenciaJefatura(req, res, SectionModel = Section) {
  if (!req[MEMO_PERTENENCIA]) {
    const user = res.locals.user;
    req[MEMO_PERTENENCIA] = (async () => {
      // Sin escuela no cuenta nada: figurar en heads de otra escuela no es estar a cargo.
      const esJefe = !!(user && user.school)
        && !!(await SectionModel.exists({ school: user.school, heads: user._id }));
      res.locals.esJefeDeSeccion = esJefe;
      return esJefe;
    })();
  }
  return req[MEMO_PERTENENCIA];
}

// ── La marca del menú: res.locals.esJefeDeSeccion ─────────────────────────────────────
// Global, montado en server.js antes de las rutas. La consulta se hace AL RENDERIZAR y no al
// entrar, porque solo la necesita el menú lateral: el poll de la sala (un JSON cada 4 s por
// persona), las subidas y los redirects no pintan ningún menú y no la pagan. Moverla a la
// entrada del request "para simplificar" es volver a pagarla en cada poll.
//
// Se envuelve res.render, que es un patrón nuevo en el proyecto (DA-7). Lo que no puede
// romper: llamar al render original UNA vez, pasarle los mismos datos, y no tragarse sus
// errores. Una vista armada con ejs.render + res.send queda sin el enlace: falla cerrada.
function marcarDocenteJefe(SectionModel = Section) {
  return (req, res, next) => {
    res.locals.esJefeDeSeccion = false;
    const user = res.locals.user;
    if (!user || !user.school || modoJefatura(user.role) !== 'por-seccion') return next();

    const renderOriginal = res.render;
    res.render = function (view, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      return pertenenciaJefatura(req, res, SectionModel)
        // Nunca un 500 por el menú: la página se pinta sin el enlace. El acceso a /jefatura
        // no depende de esto, lo decide loadJefaturaScope con su propia query.
        .catch((err) => {
          logger.warn('menú: no se pudo resolver si el docente está a cargo de una sección', {
            requestId: req.id || null,
            usuario:   user._id,
            error:     err && err.message,
          });
          return false;
        })
        .then((esJefe) => {
          res.locals.esJefeDeSeccion = esJefe === true;
          // Va también en las opciones y no solo en res.locals: al mezclarse, las opciones de
          // la ruta le ganan a res.locals, y la marca es de este middleware, no de la ruta.
          const opciones = { ...(options || {}), esJefeDeSeccion: res.locals.esJefeDeSeccion };
          return renderOriginal.call(res, view, opciones, callback);
        })
        // Un throw sincrónico del render original, que Express le habría pasado al next de
        // la ruta. Mismo destino que usa el callback por defecto de res.render.
        .catch((err) => (req.next || next)(err));
    };
    next();
  };
}

// Resuelve el alcance y lo deja en:
//   req.scopeCourseIds  Array<String> — las materias que el usuario puede mirar
//   req.scopeSections   [{ _id, name, divisions, courses }] — para los títulos de la vista
//   res.locals.scopeAll Boolean — true si entró por rol y no por ser jefe de algo
//
// Cuesta dos queries, las dos indexadas: { heads: 1 } en Section y { division: 1 } / _id
// en Course. Mismo orden de magnitud que loadPreceptorScope.
//
// Para el docente, la primera query ES la de pertenencia: si no trae ninguna sección, 403.
// Deja cargado el memo de pertenenciaJefatura para que el menú de la misma página no
// vuelva a preguntar.
const loadJefaturaScope = async (req, res, next) => {
  const user = res.locals.user;
  res.locals.scopeAll   = false;
  req.scopeCourseIds    = [];
  req.scopeSections     = [];

  const porSeccion = !!user && modoJefatura(user.role) === 'por-seccion';

  if (!user || !user.school) { // sin escuela no hay nada que mostrar
    return porSeccion ? rechazarDocente(res) : next();
  }

  try {
    const sinLimite = modoJefatura(user.role) === 'sin-limite';

    // El filtro por escuela se aplica SIEMPRE, también sobre las secciones donde figura
    // como jefe: si un superadmin lo mueve de escuela (POST /superadmin/users/:id/school no
    // desvincula nada, por decisión explícita), quedaría como jefe de secciones de la
    // escuela anterior.
    const filtro = sinLimite
      ? { school: user.school }
      : { school: user.school, heads: user._id };

    const secciones = await Section.find(filtro)
      .select('_id name divisions courses')
      .sort({ name: 1 })
      .lean();

    const acceso = decidirAccesoJefatura(user, secciones.length);
    if (porSeccion) {
      req[MEMO_PERTENENCIA]      = Promise.resolve(acceso.entra);
      res.locals.esJefeDeSeccion = acceso.entra;
    }
    if (!acceso.entra) return rechazarDocente(res);
    res.locals.scopeAll = acceso.scopeAll;

    if (!secciones.length) return next(); // fail-closed: sin secciones, sin acceso

    const divisionIds = [...new Set(secciones.flatMap(s => (s.divisions || []).map(String)))];
    const sueltas     = [...new Set(secciones.flatMap(s => (s.courses   || []).map(String)))];
    if (!divisionIds.length && !sueltas.length) {
      req.scopeSections = secciones;  // hay secciones pero están vacías: se avisa distinto
      return next();
    }

    // Resolución DINÁMICA: las materias de una división entera se buscan ACÁ, no se guardan
    // en la sección. Por eso una materia creada después de armar la sección —o cargada con
    // el alta masiva de /superadmin/otros— entra sola, sin que nadie edite nada.
    //
    // El filtro por escuela cubre además los ids que quedaron colgados en la sección.
    const materias = await Course.find({
      school: user.school,
      $or: [
        { division: { $in: divisionIds } },
        { _id:      { $in: sueltas } },
      ],
    }).select('_id').lean();

    req.scopeCourseIds = materias.map(m => m._id.toString());
    req.scopeSections  = secciones;
    next();
  } catch (err) {
    next(err);
  }
};

// ¿Esta materia está dentro del alcance del request? Es la barrera de TODA ruta con un :id.
// Sin esto, cambiar el id en la barra de direcciones alcanzaría para leer las actividades
// —y las notas— de una materia de otra sección.
const materiaEnScope = (req, courseId) =>
  !!courseId && req.scopeCourseIds.includes(courseId.toString());

// ¿Este docente dicta alguna materia del alcance? Titular o suplente: un suplente que
// sostiene la materia tiene que poder abrirse igual que el titular.
const docenteEnScope = async (req, teacherId) => {
  if (!teacherId || !req.scopeCourseIds.length) return false;
  const n = await Course.countDocuments({
    _id: { $in: req.scopeCourseIds },
    $or: [{ owner: teacherId }, { coTeachers: teacherId }],
  });
  return n > 0;
};

module.exports = {
  requireJefe, loadJefaturaScope, materiaEnScope, docenteEnScope,
  pertenenciaJefatura, marcarDocenteJefe,
  ROLES_CON_ACCESO, ROLES_SIN_LIMITE,
};
