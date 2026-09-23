const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const Activity   = require('../models/Activity');
const Course     = require('../models/Course');
const Submission = require('../models/Submission');
const ActivityView = require('../models/ActivityView');
const User       = require('../models/User');
const XLSX       = require('xlsx');
const { requireAuth } = require('../middleware/auth');
// Permisos por solapa configurados en /superadmin/roles (ver middleware/sections.js).
const { requireSection } = require('../middleware/sections');
const { logAudit }    = require('../middleware/audit');
const { uploadLimiter } = require('../middleware/rate-limits');
const ActivityTemplate   = require('../models/ActivityTemplate');
const TemplateAssignment = require('../models/TemplateAssignment');
const { computeAutoGrade } = require('../services/autoGrader');
// La regla de qué nota puede poner una PERSONA a mano (mínimo 1). Vive en public/js porque la
// comparte el navegador: si la escribiéramos dos veces, la pantalla podría aceptar un valor que
// el servidor rechaza. No la usa el autocalificador — ver el comentario del propio archivo.
const { notaValidaManual } = require('../public/js/devoluciones');
// Modo Corrector: los tres valores de `returnedAt` (RN-21), qué visor le toca a cada archivo
// y el recorte de la extensión que se loguea. Vive en public/js por lo mismo que las otras:
// la pantalla y el servidor tienen que contestar igual. Ver specs/correccion-de-entregas.spec.md.
const Correccion = require('../public/js/correccion');
const { logDeRuta, logRechazo } = require('../middleware/route-log');
// Guarda de forma del :id, en la primera línea de cada handler con parámetro. Ver
// middleware/objectId.js y el issue conocido nº 10 de agente.md. Ojo con `como: 'json'`:
// varios GET de este router son endpoints de fetch(), no vistas.
const { idMalo } = require('../middleware/objectId');
const { conErroresDeSubida } = require('../middleware/upload-errors');
// Sala en vivo: SOLO para avisar en el chat cuando la actividad se creó desde la clase
// (POST /create con fromRoom). Es la única parte de este router que sabe que las salas existen,
// y está acotada a un bloque con su propio try/catch — ver specs/actividades-en-clase.spec.md.
const RoomSession = require('../models/RoomSession');
const live        = require('../services/liveRoom');
// Regla única de "¿el alumno ve esta actividad?" (availableFrom + el ojo del docente).
// Vive en public/js porque el navegador la necesita igual para dibujar el chip de la
// tarjeta — ver el encabezado del archivo y specs/visibilidad-actividades.spec.md.
const {
  esVisibleParaAlumno,
  filtroVisibleParaAlumno,
  proximoOverride,
  estadoVisibilidad,
} = require('../public/js/visibilidadActividad');
// Regla única de "¿esto todavía le cuenta como tarea pendiente?": la sin fecha de entrega y
// la vencida con las tardías abiertas caducan solas. Ver specs/pendientes-vencidos.spec.md.
const { sigueSiendoPendiente, porUrgencia } = require('../public/js/pendienteActividad');
// Regla única de "¿el alumno puede todavía tocar su entrega?" (corregida / vencida / el
// check del docente). La comparten las tres rutas de entrega de acá abajo, el DELETE que
// la retira y las dos pantallas del alumno. Ver specs/edicion-de-la-entrega.spec.md.
const { puedeEditar: puedeEditarEntrega } = require('../public/js/edicionEntrega');
// Regla compartida con el navegador sobre los adjuntos: qué es una imagen y qué URL puede
// guardarse como adjunto. Ver public/js/adjuntosActividad.js y specs/actividad-imagenes.spec.md.
const { esUrlDeAdjunto } = require('../public/js/adjuntosActividad');
// Pipeline de imágenes (memoria → sharp → WebP → disco), el mismo de avatares, portadas,
// novedades y la sala en vivo.
const { subirImagen, guardarImagenOptimizada, ImagenInvalidaError } = require('../middleware/image-upload');
const { EXT_IMAGENES } = require('../config/imagePresets');
// Previsualización de documentos y de planos. Los tres son del corrector de entregas:
// la URL firmada que necesita Microsoft (RN-15), LibreOffice (RN-16) y ODA (RN-42).
const firmaArchivo     = require('../services/firmaArchivo');
const conversionOffice = require('../services/conversionOffice');
const conversionCad    = require('../services/conversionCad');
// El historial de la entrega: el tope de 5 versiones y dónde viven los archivos viejos (RN-33).
const { recortarVersiones, rutaEnVersiones, DIR_VERSIONES } = require('../services/versionesEntrega');
// El limitador del hilo de comentarios va POR PERSONA, no por IP (RN-32): toda la escuela
// sale por una sola IP NAT. `ipKeyGenerator` es el fallback correcto para IPv6 cuando no hay
// usuario, igual que en routes/diagnostico.js.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Adjuntos del docente: dentro de /public (acceso estático directo)
// Estructura: public/archivos/{schoolId}/actividades/{courseId}/{filename}
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

// Entregas de alumnos: FUERA de /public (protegidas por ruta auth)
// Estructura: archivos/entregas/{schoolId}/{activityId}/{studentId}/{filename}
const ENTREGAS_BASE = path.join(__dirname, '../archivos/entregas');

// Cache de derivados: el PDF de un Office (RN-16b) y el DXF de un DWG (RN-42d).
// Estructura: archivos/derivados/{schoolId}/{filename}.{pdf|dxf}
//
// NO entra al backup y está declarado así a propósito (routes/backup.js, CARPETAS_EXCLUIDAS):
// se regenera del original, y respaldarla duplica el peso sin agregar información. La clave
// es única por subida (`uniqueFilename`), así que la cache NO se invalida nunca: cada archivo
// se convierte una sola vez en su vida. El derivado se borra CON su original — es una copia
// del trabajo de un menor y no puede sobrevivirlo.
const DERIVADOS_BASE = path.join(__dirname, '../archivos/derivados');

// El derivado que le toca a un archivo de entrega. `ext` con punto ('.pdf' | '.dxf').
function rutaDerivada(schoolId, filename, ext) {
  return path.join(DERIVADOS_BASE, String(schoolId || 'general'), path.basename(filename) + ext);
}

// Extensiones permitidas para adjuntos del docente.
//
// `.dwg` y `.dxf` son los planos de AutoCAD (pedido del 2026-08-29, para las materias
// técnicas). Entran como un documento más y no hay nada adentro que el navegador pueda
// ejecutar. Lo que NO tienen es visor —el previsualizador los manda derecho al botón
// "Descargar"— así que no se los agrega a ninguna lista de "ver en línea".
//
// Ojo con la diferencia entre los dos, que no es evidente: el DWG es binario y el DXF es
// TEXTO plano. Un archivo de texto que la escuela sirve de vuelta es justo la familia de la
// que hay que desconfiar, pero acá no llega a ser un problema: `mime-types` lo declara
// `image/vnd.dxf`, helmet manda `nosniff` en toda la aplicación, y ningún navegador
// promueve un `image/*` a HTML. Lo que sí importa es que eso NO se apoye en el contenido:
// la lista cerrada sigue siendo la primera defensa. Ver tests/unit/subidaPlanos.test.js,
// que ata los nueve lugares donde vive "qué se puede subir".
//
// `.ppt` y `.pptx` entraron el 2026-09-21 (§ J de specs/correccion-de-entregas.spec.md).
// Corrigen una asimetría que no decidió nadie: la sala en vivo YA los aceptaba
// (services/liveRoom.js, EXT_ARCHIVOS), así que un docente podía compartir un PowerPoint en
// clase pero no adjuntarlo a la actividad ni recibirlo como entrega.
const EXT_ALLOWED     = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.dwg', '.dxf'];
// Tope de un adjunto del docente: holgado a propósito, son PDFs escolares escaneados. Una
// sola constante para los dos multer que lo usan (crear la actividad y el pre-upload) y para
// los mensajes de error, que antes repetían el número a mano.
const ADJUNTO_MAX_MB  = 50;
// Extensiones permitidas para entregas de alumnos por la ruta de ARCHIVOS.
//
// Desde el 2026-08-24 las fotos NO entran por acá: van por /upload-submission-image, que las
// recomprime a WebP. Las de imagen se dejan igual en esta lista a propósito, como red: un
// navegador con el JS viejo en cache sigue mandando la foto a esta ruta, y es mejor que se
// guarde entera a que le rebote. Cuando el cache ya no importe se pueden sacar.
const EXT_SUBMISSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.dwg', '.dxf', '.jpg', '.jpeg', '.png', '.gif'];

// § K — el rechazo por extensión deja una línea en el log, y no es auditoría: es poder
// contestar dentro de dos semanas QUÉ FORMATO LE ESTÁ FALTANDO A LA ESCUELA, que hoy es
// imposible. Hasta esta feature los tres fileFilter de acá abajo hacían `cb(null, false)`
// sin loguear nada, así que un formato rechazado no dejaba rastro EN NINGÚN LADO: el archivo
// no llega al disco y los reportes de /diagnostico solo cubren motivos de red.
//
// Va la EXTENSIÓN SOLA, nunca el nombre del archivo (RN-46): los alumnos nombran la entrega
// con su propio nombre («TP3-Juan-Perez.docx»), que es un dato personal y no aporta nada a
// la pregunta. Y va recortada (Correccion.extensionParaLog, RN-47) porque el nombre lo
// escribe el cliente: sin el recorte, una "extensión" de 2.000 caracteres infla
// logs/combined.log, que NO rota.

// Genera un nombre único para evitar colisiones en disco: timestamp + random + extensión original
function uniqueFilename(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  return Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
}

// Busboy (usado por multer) decodifica los headers multipart como latin1 por defecto,
// pero los navegadores mandan el nombre del archivo en UTF-8 — sin este fix, "Guía.pdf"
// llega como "GuÃ­a.pdf". Reinterpretar los bytes como UTF-8 recupera los acentos; en
// nombres sin acentos (puro ASCII) el round-trip no cambia nada.
function fixFilenameEncoding(originalname) {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

// Devuelve una copia de la pregunta sin las claves que revelan la respuesta correcta.
// Se usa al mandar templateSnapshot al alumno: enunciado + opciones/pares sí,
// pero isCorrect / correctAnswer / correctPairs / acceptedAnswers NO.
function stripAnswerKeys(q) {
  const out = { _id: q._id, type: q.type, prompt: q.prompt, points: q.points };
  if (q.type === 'mc' && q.mc) {
    out.mc = {
      multipleAllowed: q.mc.multipleAllowed,
      options: (q.mc.options || []).map(o => ({ _id: o._id, text: o.text })),
    };
  }
  if (q.type === 'tf')     out.tf     = {}; // solo enunciado, sin correctAnswer
  if (q.type === 'match' && q.match) {
    out.match = {
      leftItems:  (q.match.leftItems  || []).map(i => ({ _id: i._id, text: i.text })),
      rightItems: (q.match.rightItems || []).map(i => ({ _id: i._id, text: i.text })),
    };
  }
  if (q.type === 'fill' && q.fill) {
    out.fill = { template: q.fill.template };
  }
  if (q.type === 'common' && q.common) {
    out.common = { instructions: q.common.instructions };
  }
  return out;
}

// Multer para adjuntos del docente al crear/editar actividades
// schoolId y courseId vienen de res.locals.user y req.body.courseId respectivamente
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const courseId = req.body.courseId || 'general';
      const dir = path.join(ARCHIVOS_BASE, schoolId, 'actividades', courseId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: ADJUNTO_MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Recortada antes de tocar el log: ver el bloque de § K de arriba (RN-46/RN-47).
    const extParaLog = Correccion.extensionParaLog(file.originalname);
    const permitida = EXT_ALLOWED.includes(ext);
    if (!permitida) {
      logRechazo(req.res, 400, 'formato no permitido',
        { evento: 'formato_rechazado', ext: extParaLog, ruta: 'actividad_adjunto', origen: 'servidor' });
    }
    cb(null, permitida);
  },
});
// Ídem la entrega del alumno: sin esto, crear la actividad con un adjunto pasado de tamaño
// salía como 500 después de haber subido los 50 MB. Ver middleware/upload-errors.js.
const subirAdjuntosDeActividad = conErroresDeSubida(
  upload.array('files', 10),
  { maxMb: ADJUNTO_MAX_MB },
);

// Resuelve el curso de `?courseId=` y corta si quien sube no puede administrarlo.
//
// Va ANTES de multer, no adentro del handler, y ahí está toda la gracia: multer recibe el
// cuerpo ENTERO antes de que el handler llegue a correr. Con el chequeo tardío, alguien
// ajeno a la materia alcanzaba a escribir 50 MB en su disco y recién después leía el 403
// (la ruta los borraba a mano con un unlink que ahora sobra). Es la misma regla que dejó
// escrita la sala en vivo con `exigirPermisoDeImagen`.
async function exigirGestorDelCurso(req, res, next) {
  try {
    const course = await Course.findById(req.query.courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso al curso' });
    }
    req.cursoDestino = course;
    next();
  } catch {
    // Un courseId con forma inválida es lo mismo que un curso que no existe: 404, no 500.
    res.status(404).json({ error: 'Curso no encontrado' });
  }
}

const SUBMISSION_MAX_SIZE = 20 * 1024 * 1024; // 20 MB por archivo

// Multer para entregas de alumnos
// req.params.id = activityId; req.userId = studentId (seteado por requireAuth)
const submissionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      const dir = path.join(ENTREGAS_BASE, schoolId, req.params.id, req.userId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: SUBMISSION_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Recortada antes de tocar el log: ver el bloque de § K de arriba (RN-46/RN-47).
    const extParaLog = Correccion.extensionParaLog(file.originalname);
    const permitida = EXT_SUBMISSIONS.includes(ext);
    if (!permitida) {
      logRechazo(req.res, 400, 'formato no permitido',
        { evento: 'formato_rechazado', ext: extParaLog, ruta: 'entrega', origen: 'servidor' });
    }
    cb(null, permitida);
  },
});

// GET /activities/new?courseId=...
// Renderiza el formulario de creación de actividad; solo el owner del curso puede acceder
router.get('/new', requireAuth, async (req, res) => {
  try {
    const course = await Course.findById(req.query.courseId).populate('owner', 'name');
    if (!course || !course.canManage(res.locals.user)) {
      return res.redirect('/courses');
    }
    res.render('activities/new', { course });
  } catch {
    res.redirect('/courses');
  }
});

// GET /activities/course/:courseId
// Lista las actividades de un curso para el usuario autenticado
// Si es owner: devuelve todas las actividades con el array completo de grades
// Si es alumno: solo actividades con availableFrom <= ahora; grades filtrado a su propia nota (myGrade)
// Retorna: { activities: [...], isOwner: bool }
router.get('/course/:courseId', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Curso no encontrado', { param: 'courseId', como: 'json' })) return;
  try {
    const course = await Course.findById(req.params.courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });

    const userId  = res.locals.user._id.toString();
    const isOwner = course.canManage(res.locals.user);

    const query = { course: req.params.courseId };
    // Los alumnos ven todas las actividades ya publicadas (availableFrom <= ahora), y esa es
    // la ÚNICA condición: el plazo de entrega no decide la visibilidad.
    //
    // ⚠️ Hasta el 2026-08-31 había una segunda condición acá: al alumno con enrollmentDate
    // para el curso se le ocultaban las actividades cuya fecha de entrega había vencido ANTES
    // de su alta, salvo que el docente hubiera habilitado las tardías. Se sacó a pedido de una
    // docente (sugerencia enviada desde producción): esa regla no le quitaba una tarea, le
    // quitaba el MATERIAL de todas las clases anteriores —enunciados y adjuntos—, y para
    // recuperarlo el docente tenía que ir abriendo las entregas de una por una. Encima no
    // afectaba solo al que llega tarde: las herramientas de mantenimiento que rematriculan
    // (services/enrollment.js, dbFixes 'matricula-parcial') escriben enrollmentDates = ahora,
    // así que un alumno de siempre podía quedarse sin ver el año entero. En Classroom, el que
    // entra a la clase ve todo lo publicado; entregar es otra cosa.
    //
    // Lo que NO cambió, y es la mitad del diseño: `allowLateSubmissions` sigue mandando en la
    // ENTREGA (exigirAlumnoQuePuedeEntregar + POST /:id/submit), y la vencida no le vuelve a
    // aparecer como pendiente porque sigueSiendoPendiente() la caduca sola. Ver ambos en
    // public/js/pendienteActividad.js.
    if (!isOwner) Object.assign(query, filtroVisibleParaAlumno(new Date()));

    const activities = await Activity.find(query)
      .populate('author', 'name')
      .sort({ createdAt: -1 }); // Más recientes primero

    let result;
    if (isOwner) {
      // Para el docente: conteo de entregas (chip "X/Y entregaron") y de aperturas
      // (chip "X/Y vieron"). Los dos aggregates son independientes → van en paralelo.
      const actIds = activities.map(a => a._id);
      const [counts, viewCounts, unreadCounts] = await Promise.all([
        Submission.aggregate([
          { $match: { activity: { $in: actIds } } },
          { $group: { _id: '$activity', count: { $sum: 1 } } },
        ]),
        // Acotado a los alumnos que HOY están en el curso: el denominador del chip es
        // course.students.length, así que contar a un desmatriculado daría "3/2".
        // La tabla del modal aplica el mismo criterio (cruza contra studentGrades).
        ActivityView.aggregate([
          { $match: { activity: { $in: actIds }, student: { $in: course.students } } },
          { $group: { _id: '$activity', count: { $sum: 1 } } },
        ]),
        // Chip "N sin leer" del hilo privado (RN-31c). Va como TERCER aggregate del
        // Promise.all que ya corría dos, y no como una request por actividad: la solapa de
        // actividades no puede sumar 30 llamadas para pintar un chip. Lo resuelve el índice
        // { activity, unreadForTeacher } de models/Submission.js.
        Submission.aggregate([
          { $match: { activity: { $in: actIds }, unreadForTeacher: true } },
          { $group: { _id: '$activity', count: { $sum: 1 } } },
        ]),
      ]);
      const countMap     = {};
      counts.forEach(c => { countMap[c._id.toString()] = c.count; });
      const viewMap      = {};
      viewCounts.forEach(c => { viewMap[c._id.toString()] = c.count; });
      const unreadMap    = {};
      unreadCounts.forEach(c => { unreadMap[c._id.toString()] = c.count; });
      const totalStudents = course.students.length;

      result = activities.map(act => {
        const obj          = act.toObject();
        obj.submittedCount = countMap[obj._id.toString()] || 0;
        obj.viewedCount    = viewMap[obj._id.toString()]  || 0;
        // Cuenta ENTREGAS con algo sin leer, no comentarios: el dato accionable es a
        // cuántos alumnos hay que contestarles.
        obj.comentariosSinLeer = unreadMap[obj._id.toString()] || 0;
        obj.totalStudents  = totalStudents;
        return obj;
      });
    } else {
      // Sus propias entregas, en una sola consulta indexada por el índice único
      // { activity, student } de Submission. Sin esto la solapa Actividades no puede
      // distinguir "todavía la tengo que hacer" de "ya la entregué" y le pone "Pendiente"
      // a las dos, y "Próximas entregas" le sigue mostrando lo que ya hizo. La regla que
      // consume este campo es public/js/estadoActividad.js.
      //
      // Va la FECHA, no un booleano: es lo que hace falta para poder mostrar "Entregada el
      // 14/8" sin pedirle al navegador una segunda vuelta por actividad.
      const misEntregas = await Submission.find({
        student:  userId,
        activity: { $in: activities.map(a => a._id) },
      }).select('activity firstSubmittedAt createdAt unreadForStudent');
      const entregaPorActividad = {};
      misEntregas.forEach(s => {
        entregaPorActividad[s.activity.toString()] = {
          at: s.firstSubmittedAt || s.createdAt,
          // "Comentario nuevo" en la tarjeta (RN-31d). Es el mismo mecanismo del otro lado
          // del hilo, y por eso es un booleano y no un contador.
          comentariosSinLeer: !!s.unreadForStudent,
        };
      });

      result = activities.map(act => {
        const obj = act.toObject();
        // Para el alumno: extrae solo su propia calificación del array grades y borra el resto
        const myGrade = act.grades.find(g => g.student.toString() === userId);
        // points puede venir null: es una devolución escrita sin nota. El front la muestra
        // como "Con devolución" (no como calificada) — ver renderStudentActivity en course.js.
        // `manual` viaja porque public/js/edicionEntrega.js lo necesita para NO tomar una
        // autocalificación como corrección del docente: sin él, el alumno vería cerrado el
        // cuestionario que acaba de responder (el servidor decidiría bien igual, pero la
        // pantalla le mostraría un cartel que no corresponde).
        //
        // ⚠️ En BORRADOR no viaja NADA (RN-24): esta es la única puerta del alumno a su nota,
        // así que acá se omite `myGrade` entero. No alcanzaba con anular `points` — el
        // alumno también vería `feedback` y el chip "devolución sin nota" de
        // estadoActividad.js, o sea que se enteraría igual de que ya lo corrigieron.
        obj.myGrade = (myGrade && Correccion.estaDevuelta(myGrade))
          ? { points: myGrade.points ?? null, feedback: myGrade.feedback || '', manual: myGrade.manual !== false }
          : null;
        // Su propia entrega: { at, comentariosSinLeer } o null. Nunca los archivos ni el
        // texto — para eso está GET /activities/:id/my-submission, que abre el modal.
        const entregadaEl = entregaPorActividad[obj._id.toString()];
        obj.mySubmission = entregadaEl
          ? { at: entregadaEl.at, comentariosSinLeer: entregadaEl.comentariosSinLeer }
          : null;
        delete obj.grades; // No exponer notas de otros alumnos
        // Si es una actividad interactiva, filtrar las respuestas correctas del snapshot
        // (el autoGrader corre siempre server-side; el alumno nunca las necesita ver).
        if (obj.templateSnapshot && obj.templateSnapshot.questions) {
          obj.templateSnapshot.questions = obj.templateSnapshot.questions.map(stripAnswerKeys);
        }
        return obj;
      });
    }

    res.json({ activities: result, isOwner });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al cargar actividades' });
  }
});

// POST /activities/create
// Crea una nueva actividad con adjuntos y/o links
// multipart/form-data: { courseId, title, description?, dueDate?, availableFrom?, points?, links?, files? }
// GET /activities/available-templates?courseId=X
// Devuelve las plantillas ACEPTADAS por la escuela del curso, listas para
// instanciar. Solo válido si el docente es owner del curso y el feature flag
// TASK_TEMPLATES_TEACHER_ENABLED está prendido; con el flag off responde
// siempre { templates: [] } — así el frontend puede llamar sin problema y
// simplemente ve una lista vacía → no muestra selector.
router.get('/available-templates', requireAuth, async (req, res) => {
  try {
    if (!res.locals.taskTemplatesTeacherEnabled) return res.json({ templates: [] });
    const { courseId } = req.query;
    if (!courseId) return res.status(400).json({ error: 'Falta courseId' });

    const course = await Course.findById(courseId).select('school owner coTeachers').lean();
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    // Comparación a mano (no course.canManage()) porque esta query es .lean(): el documento
    // no trae los métodos del schema. Mismo criterio que canManage: docentes + admins de la
    // escuela del curso + superadmin.
    const uid  = String(res.locals.user._id);
    const role = res.locals.user.role;
    const isTeacher = String(course.owner) === uid
      || (course.coTeachers || []).some(t => String(t) === uid);
    const isSchoolAdmin = role === 'superadmin'
      || (role === 'admin' && res.locals.user.school
          && String(course.school) === String(res.locals.user.school));
    if (!isTeacher && !isSchoolAdmin) return res.status(403).json({ error: 'Sin acceso' });

    // Todas las plantillas aceptadas por la escuela del curso (activo = status:'accepted').
    const assignments = await TemplateAssignment.find({ school: course.school, status: 'accepted' })
      .populate('template', 'title description questions defaultPoints status')
      .lean();

    const templates = assignments
      .filter(a => a.template && a.template.status === 'published')
      .map(a => ({
        _id:           a.template._id,
        title:         a.template.title,
        description:   a.template.description,
        questionsCount: (a.template.questions || []).length,
        defaultPoints: a.template.defaultPoints,
      }));

    res.json({ templates });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// links es un JSON string de array: [{ url, name? }]
// Retorna: { activity } con autor populado (201)
router.post('/create', requireAuth, uploadLimiter, subirAdjuntosDeActividad, async (req, res) => {
  try {
    const { courseId, title, description, dueDate, availableFrom, points, links, type, templateId, allowResubmission } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Solo el docente puede crear actividades' });
    }

    // Si viene templateId (y el feature flag está prendido), validar que la escuela
    // haya aceptado la plantilla y copiar sus preguntas al snapshot inmutable. Si el
    // superadmin edita la plantilla luego, esta actividad NO cambia — protege las
    // entregas ya realizadas de alumnos.
    let templateSnapshot;
    if (templateId) {
      if (!res.locals.taskTemplatesTeacherEnabled) {
        return res.status(403).json({ error: 'Las plantillas de tareas no están habilitadas' });
      }
      const assignment = await TemplateAssignment.findOne({
        school: course.school, template: templateId, status: 'accepted',
      }).lean();
      if (!assignment) {
        return res.status(403).json({ error: 'Esta plantilla no está habilitada para tu escuela' });
      }
      const tpl = await ActivityTemplate.findById(templateId).lean();
      if (!tpl || tpl.status !== 'published') {
        return res.status(400).json({ error: 'Plantilla no disponible' });
      }
      templateSnapshot = {
        templateId:        tpl._id,
        templateUpdatedAt: tpl.updatedAt,
        questions:         tpl.questions,
      };
    }

    const schoolId    = res.locals.user.school?.toString() || 'general';
    const attachments = [];

    // Archivos pre-subidos vía /upload-attachment o /upload-image (URL ya guardada en disco).
    //
    // `uploadedFiles` es un JSON que arma el navegador: lo que llega acá es lo que quiera
    // mandar quien llame a la ruta, NO lo que efectivamente se subió. Por eso cada URL pasa
    // por esUrlDeAdjunto(): antes se guardaba como "archivo" de la actividad cualquier cosa
    // —incluida una `javascript:`— y quien terminaba abriéndola era el alumno.
    //
    // Se corta la creación entera en vez de saltear la entrada mala: un cliente legítimo no
    // puede llegar a esto, y perder el adjunto en silencio sería peor que no crear la tarea.
    if (req.body.uploadedFiles) {
      const previos = JSON.parse(req.body.uploadedFiles);
      if (previos.some(f => !esUrlDeAdjunto(f?.url))) {
        return res.status(400).json({ error: 'Uno de los archivos adjuntos no es válido' });
      }
      previos.forEach(f => {
        attachments.push({ type: 'file', name: f.name || 'archivo', url: f.url, mime: f.mime || '' });
      });
    }

    // Archivos enviados directamente en el FormData (compatibilidad)
    (req.files || []).forEach(f => {
      attachments.push({
        type: 'file',
        name: fixFilenameEncoding(f.originalname),
        url:  `/archivos/${schoolId}/actividades/${courseId}/${f.filename}`,
        mime: f.mimetype,
      });
    });

    // Parsea y agrega los links; se valida que tengan url
    if (links) {
      JSON.parse(links).forEach(l => {
        if (l.url) attachments.push({ type: 'link', name: l.name || l.url, url: l.url, mime: '' });
      });
    }

    // Si viene con plantilla y el docente no puso puntos, tomo los de la plantilla.
    const resolvedPoints = (points !== '' && points != null)
      ? Number(points)
      : (templateSnapshot ? Number(templateSnapshot.questions.reduce((a, q) => a + (Number(q.points) || 0), 0)) : null);

    const activity = await Activity.create({
      course:        courseId,
      author:        res.locals.user._id,
      title:         title?.trim(),
      description:   description?.trim() || '',
      dueDate:       dueDate || null,
      availableFrom: availableFrom || new Date(), // Por defecto: disponible de inmediato
      points:        resolvedPoints,
      type:          type || 'tarea',
      // Ausente ≠ destildado. Un `!!undefined` acá le pasaría por encima al default true del
      // modelo y cada actividad creada por un cliente que no manda el campo nacería
      // congelada — que es exactamente el problema que esta feature vino a sacar.
      allowResubmission: allowResubmission === undefined ? true : !!allowResubmission,
      attachments,
      ...(templateSnapshot ? { templateSnapshot } : {}),
    });

    await activity.populate('author', 'name');

    // Creada desde el botón de la sala en vivo: la clase se entera en el chat, en el momento.
    //
    // La sesión se resuelve ACÁ y no se toma del body: el cliente puede mandar cualquier id, y
    // del otro lado hay el chat de un curso de menores. Sin sala abierta simplemente no hay
    // aviso — crear una actividad nunca exigió estar en clase.
    //
    // El try/catch propio es el punto: la actividad YA está creada. Que falle escribir en el
    // chat no puede voltear la respuesta ni dejar al docente creyendo que no se guardó nada.
    let avisadaEnSala = false;
    if (req.body.fromRoom) {
      try {
        const session = await RoomSession.findOne({ course: course._id, closedAt: null });
        if (session) {
          const titulo = activity.title.length > 80 ? activity.title.slice(0, 79) + '…' : activity.title;
          // El id va aparte del texto: es lo que le permite a la sala pintar el botón
          // "Ver actividad" sin tener que parsear el mensaje (ver models/RoomMessage.js).
          await live.systemMessage(session, `${res.locals.user.name} creó la actividad «${titulo}».`,
            { activity: activity._id });
          avisadaEnSala = true;
        }
      } catch (e) {
        logDeRuta(e, res);
      }
    }

    logAudit(req, 'activity.create',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        tipo:      activity.type,
        adjuntos:  attachments.length,
        ...(activity.points != null ? { puntos: activity.points } : {}),
        ...(avisadaEnSala ? { desdeSala: true } : {}),
      },
    );

    res.status(201).json({ activity });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al crear actividad' });
  }
});

// Multer exclusivo para pre-subida: lee courseId desde req.query para evitar problemas
// de timing con el stream multipart (los text fields del body llegan junto con el archivo)
const uploadSingle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const schoolId = req.res?.locals?.user?.school?.toString() || 'general';
      // El id CANÓNICO del curso que resolvió exigirGestorDelCurso, no el string crudo de la
      // query: Mongoose acepta el hex en mayúsculas y lo normaliza, así que un cliente que
      // mande "ABC…" escribiría en una carpeta y recibiría la URL de otra.
      const courseId = req.cursoDestino?._id?.toString() || req.query.courseId || 'general';
      const dir = path.join(ARCHIVOS_BASE, schoolId, 'actividades', courseId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
  }),
  limits: { fileSize: ADJUNTO_MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Recortada antes de tocar el log: ver el bloque de § K de arriba (RN-46/RN-47).
    const extParaLog = Correccion.extensionParaLog(file.originalname);
    const permitida = EXT_ALLOWED.includes(ext);
    if (!permitida) {
      logRechazo(req.res, 400, 'formato no permitido',
        { evento: 'formato_rechazado', ext: extParaLog, ruta: 'actividad_adjunto_presubida', origen: 'servidor' });
    }
    cb(null, permitida);
  },
});

// POST /activities/upload-attachment?courseId=...
// Pre-sube un adjunto antes de crear la actividad; courseId viene en la query string.
// Body multipart: { file }
// Retorna: { url, name, mime }
router.post('/upload-attachment', requireAuth, uploadLimiter, exigirGestorDelCurso, (req, res, next) => {
  // Intercepta errores de multer para devolver JSON en español en lugar del mensaje en inglés
  uploadSingle.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `El archivo es demasiado grande (máximo ${ADJUNTO_MAX_MB} MB)` });
      }
      return res.status(400).json({ error: err.message || 'Error al procesar el archivo' });
    }
    next();
  });
}, async (req, res) => {
  try {
    // El cartel sale de la LISTA y no de un texto a mano: escrito a mano decía "(PDF, Word,
    // Excel)" y quedaba desactualizado en cuanto la lista cambiaba —es la misma forma de
    // mentir que tenía el cartel de la entrega antes del 2026-08-24—.
    if (!req.file) {
      return res.status(400).json({ error: `Ese archivo no se puede subir. Aceptamos ${EXT_ALLOWED.join(', ')}. Las fotos van por su propio botón.` });
    }
    const schoolId = res.locals.user.school?.toString() || 'general';
    const courseId = req.cursoDestino._id.toString();
    const url = `/archivos/${schoolId}/actividades/${courseId}/${req.file.filename}`;
    res.json({ url, name: fixFilenameEncoding(req.file.originalname), mime: req.file.mimetype });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    logDeRuta(err, res);
    res.status(500).json({ error: err.message || 'Error al subir el archivo' });
  }
});

// POST /activities/upload-image?courseId=...
// Pre-sube una IMAGEN del docente: la foto del pizarrón, la consigna escaneada, el mapa.
// Body multipart: { file }
// Retorna: { url, name, mime } — la MISMA forma que /upload-attachment, para que el formulario
// meta las dos en el mismo `uploadedFiles` sin tener que recordar de dónde vino cada una.
//
// Ruta aparte y no una extensión más en EXT_ALLOWED porque el camino del archivo es otro: la
// imagen no se guarda como llega, se recomprime a WebP con el preset 'adjunto' antes de tocar
// el disco (multer en memoria). Una foto de celular de 4 MB termina en unos cientos de KB, que
// es lo que van a bajar 30 alumnos.
router.post('/upload-image', requireAuth, uploadLimiter, exigirGestorDelCurso,
  subirImagen('file'), async (req, res) => {
    try {
      // Sin req.file hay dos causas y el docente tiene que poder distinguirlas: el fileFilter
      // rechazó la extensión (el caso real es el .heic del iPhone, que acá SÍ entra), o no se
      // adjuntó nada. Mismo criterio que la sala en vivo.
      if (!req.file) {
        return res.status(400).json({
          error: `Esa imagen no se puede subir. Aceptamos: ${EXT_IMAGENES.join(', ')}`,
        });
      }

      const schoolId = res.locals.user.school?.toString() || 'general';
      const courseId = req.cursoDestino._id.toString();
      const guardada = await guardarImagenOptimizada(req.file, {
        preset: 'adjunto',
        dir:    path.join(ARCHIVOS_BASE, schoolId, 'actividades', courseId),
      });

      // El nombre VISIBLE lleva la extensión que quedó EN DISCO, no la que eligió el docente:
      // si sube "pizarron.jpg" y se guarda como WebP, mostrar ".jpg" haría que el archivo
      // descargado no coincida con su propio nombre. Misma regla que la sala.
      const original = fixFilenameEncoding(req.file.originalname);
      const extFinal = path.extname(guardada.filename).toLowerCase();
      const base     = path.basename(original, path.extname(original));

      res.json({
        url:  `/archivos/${schoolId}/actividades/${courseId}/${guardada.filename}`,
        name: `${base}${extFinal}`.slice(0, 120),
        mime: extFinal === '.webp' ? 'image/webp' : (req.file.mimetype || ''),
      });
    } catch (err) {
      // ImagenInvalidaError = el archivo que mandaron no es una imagen de verdad (sharp no la
      // pudo decodificar). Es culpa del archivo, no nuestra: 400 con el mensaje que ya explica
      // qué pasó, no un 500 en el error.log.
      if (err instanceof ImagenInvalidaError) return res.status(400).json({ error: err.message });
      logDeRuta(err, res);
      res.status(500).json({ error: 'Error al subir la imagen' });
    }
  });

// GET /activities/my-pending
// Página del alumno: listado de todas sus actividades pendientes en todos sus cursos
// Solo accesible para alumnos (redirige a /courses si el rol no es student)
router.get('/my-pending', requireAuth, requireSection('app_pending'), async (req, res) => {
  try {
    const user = res.locals.user;
    if (user.role !== 'student') return res.redirect('/courses');

    const now = new Date();
    // Ya no se filtra por enrollmentDates. Iba de la mano del filtro que GET /course/:id tenía
    // hasta el 2026-08-31, y sacarlo no cambia esta lista ni en un renglón: la actividad
    // vencida antes del alta del alumno tampoco pasa sigueSiendoPendiente() —sin tardías el
    // corte es el vencimiento pelado—, así que la condición era redundante. De paso quedan una
    // sola regla y un solo número entre esta pantalla y el cartel del inicio (GET /courses),
    // que nunca tuvo el filtro de inscripción.
    const joinedCourses = await Course.find({ students: user._id }).select('name _id');
    const courseIds = joinedCourses.map(c => c._id);

    // El orden final NO lo decide esta query: `sort({ dueDate: 1 })` pone los `null` PRIMERO
    // (así ordena Mongo) y la lista arrancaba con las tareas sin plazo, empujando abajo lo que
    // vence mañana. Acá solo se pide un orden estable para los empates; el bueno lo pone
    // porUrgencia() después de filtrar.
    const activities = await Activity.find({
      course: { $in: courseIds },
      ...filtroVisibleParaAlumno(now),
    }).populate('course', 'name').sort({ createdAt: 1 });

    const submissions = await Submission.find({
      student:  user._id,
      activity: { $in: activities.map(a => a._id) },
    }).select('activity');
    const submittedSet = new Set(submissions.map(s => s.activity.toString()));

    // Filtra las que están realmente pendientes (sin entrega y todavía en ventana)
    const pending = activities.filter(a => {
      if (submittedSet.has(a._id.toString())) return false;
      // Misma función que usa el contador del inicio (GET /courses): si las dos pantallas
      // no comparten la regla, el cartel dice un número y esta lista muestra otro.
      return sigueSiendoPendiente(a, now);
    });

    // Lo que vence primero, arriba; las que no tienen fecha de entrega, al final.
    pending.sort(porUrgencia);

    res.render('activities/pending', { pending });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// GET /activities/:id/grades
// Devuelve la actividad + notas por alumno para el docente
// Construye la lista cruzando course.students con activity.grades
// Retorna: { activity, studentGrades: [{ _id, name, email, points }] }
router.get('/:id/grades', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const activity = await Activity.findById(req.params.id).populate('author', 'name');
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course).populate('students', 'name email');
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // Índice O(1) studentId → { points, feedback } para cruzar con la lista de alumnos
    const gradeMap = {};
    activity.grades.forEach(g => {
      // `returnedAt` viaja TAL CUAL, incluido el caso ausente: el navegador lo lee con
      // Correccion.estaDevuelta() y ahí undefined significa "nota anterior a la feature, ya
      // devuelta" (RN-21). Normalizarlo a null acá convertiría todas las notas viejas en
      // borradores a los ojos de la planilla.
      gradeMap[g.student.toString()] = { points: g.points, feedback: g.feedback || '', returnedAt: g.returnedAt };
    });

    // Para cada alumno inscripto: su nota y feedback, o null si no fue calificado todavía
    const studentGrades = course.students.map(s => {
      const g = gradeMap[s._id.toString()];
      const fila = {
        _id:      s._id,
        name:     s.name,
        email:    s.email,
        points:   g?.points ?? null,
        feedback: g?.feedback || '',
      };
      // Solo se agrega si el grade TIENE el campo: una nota legada no puede llegar al
      // navegador con `returnedAt: null` (= borrador) por culpa del armado de este objeto.
      if (g && g.returnedAt !== undefined) fila.returnedAt = g.returnedAt;
      return fila;
    });

    res.json({ activity, studentGrades });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al cargar calificaciones' });
  }
});

// POST /activities/:id/grade
// Guarda o actualiza la nota y/o la devolución escrita de un alumno (solo el docente owner)
// Body: { studentId, points?, feedback? }
// Upsert manual: si ya existe un registro de ese alumno lo actualiza, si no lo inserta
//
// La nota es OPCIONAL: el docente puede mandar solo `feedback` para dejar una devolución
// sin calificar todavía. Si `points` no viene, la nota que ya estuviera cargada NO se toca
// (mandar solo feedback nunca borra una nota existente).
//
// Desde specs/correccion-de-entregas.spec.md acepta además `devolver?: boolean`, y el flag
// AUSENTE significa DEVOLVER (RN-22b). Es lo que contiene el radio de explosión de toda la
// feature: todos los clientes que ya existen —las tres pantallas que cargan notas, los ocho
// llamados del smoke y cualquier curl— siguen publicando exactamente como hoy.
router.post('/:id/grade', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const { studentId, points, feedback } = req.body;
    // `devolver: false` es la ÚNICA forma de crear un borrador, y es explícita.
    const devolver = req.body.devolver !== false;
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // '' / null / undefined = "no manda nota". Ojo con Number(''), que da 0 y antes
    // convertía un campo vacío en un flamante cero.
    const mandaNota = points !== undefined && points !== null && String(points).trim() !== '';
    if (!mandaNota && feedback === undefined) {
      return res.status(400).json({ error: 'No hay nota ni devolución para guardar' });
    }

    let nota;
    if (mandaNota) {
      // ⭐ La nota mínima es 1, y esta es la guarda que de verdad la impone: las tres pantallas
      // que cargan notas mandan acá, y un `curl` también. El texto del error nombra la salida
      // (dejar el casillero vacío = devolución sin nota), porque ESE es el caso que produce los
      // ceros a mano. Ver el comentario largo de public/js/devoluciones.js.
      const veredicto = notaValidaManual(points, activity.points);
      if (!veredicto.ok) return res.status(400).json({ error: veredicto.error });
      nota = veredicto.points;
    }

    const existing = activity.grades.find(g => g.student.toString() === studentId);
    if (existing) {
      // Se pregunta ANTES de tocar nada: RN-23 dice que una nota ya devuelta no vuelve a
      // borrador. Sin esto, editar una nota vieja con `devolver: false` se la escondería al
      // alumno que ya la había visto, de a una por vez y sin que nadie se entere.
      const yaEstabaDevuelta = Correccion.estaDevuelta(existing);
      if (mandaNota) existing.points = nota;
      existing.gradedAt = new Date();
      existing.manual   = true; // el docente sobrescribe → protege contra re-autocalificación
      if (feedback !== undefined) existing.feedback = feedback.trim();
      // Corolario de RN-22: la ruta escribe `returnedAt` SIEMPRE explícitamente. El campo no
      // tiene default (no puede tenerlo), así que "no tocarlo" dejaría toda nota nueva en
      // undefined — que lee DEVUELTA, o sea publicando sin que nadie lo haya decidido.
      if (devolver) existing.returnedAt = new Date();
      else if (!yaEstabaDevuelta) existing.returnedAt = null;
    } else {
      activity.grades.push({
        student:  studentId,
        points:   mandaNota ? nota : null, // null = devolución sin nota
        feedback: (feedback || '').trim(),
        manual:   true,
        returnedAt: devolver ? new Date() : null, // null = borrador (RN-21)
      });
    }

    await activity.save();

    // Poner nota CIERRA una entrega que estuviera reabierta: rehizo, la corregí de nuevo,
    // se cierra. Sin esto, la primera vez que el docente aprieta "Permitir que lo rehaga" le
    // dejaría la puerta abierta para siempre. Solo con NOTA: una devolución escrita no
    // cierra nada (ver esCorregida en public/js/edicionEntrega.js).
    //
    // ⚠️ Y solo al DEVOLVER (RN-26b): ese "se cierra" pertenece al momento en que al alumno
    // se le avisa. Un docente que corrige 30 en borrador cerraría 30 reaperturas antes de
    // devolver nada, y varias de esas entregas estaban abiertas SOLO por la reapertura.
    if (mandaNota && devolver) {
      await Submission.updateOne(
        { activity: req.params.id, student: studentId },
        { $set: { reopenedAt: null, reopenedBy: null } },
      );
    }

    // Snapshot del alumno calificado (nombre para el log). Query minimal, solo name.
    const student = await User.findById(studentId).select('name').lean();
    logAudit(req, 'submission.grade',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'user',     id: studentId,    name: student?.name || '' },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        // Sin nota el registro es una devolución escrita: se loguea como tal en vez de un 0 falso
        ...(mandaNota
          ? { puntos: nota, ...(activity.points != null ? { maximo: activity.points } : {}) }
          : { devolucion: 'sin nota' }),
        // Lo que NO se ve en la pantalla del alumno tiene que verse en la auditoría: una
        // nota guardada en borrador es una nota puesta que todavía nadie recibió.
        ...(devolver ? {} : { estado: 'borrador' }),
      },
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /activities/:id/devolver
// Publica correcciones ya guardadas. Body: { studentIds: [...] }
//
// Devolver ≠ Guardar (D5 de specs/correccion-de-entregas.spec.md): esta ruta NO toca
// `points` ni `feedback`, solo decide CUÁNDO el alumno ve lo que el docente ya escribió. Es
// lo que permite el flujo natural del Modo Corrector, "corrijo los 30 y los devuelvo juntos".
//
// El alumno sin nada que devolver no es un error: vuelve en `omitidas[]` y el lote sigue.
router.post('/:id/devolver', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const pedidos = Array.isArray(req.body.studentIds) ? req.body.studentIds.map(String) : [];
    const ahora = new Date();
    const devueltas = [];
    const omitidas  = [];

    for (const sid of pedidos) {
      const grade = activity.grades.find(g => g.student.toString() === sid);
      // La misma función pura que gobierna el botón: el docente no puede pedir por API algo
      // que la pantalla no le deja pedir (RN-27).
      if (!Correccion.puedeDevolver(grade)) { omitidas.push(sid); continue; }
      grade.returnedAt = ahora;
      devueltas.push(sid);
    }

    if (!devueltas.length) {
      return res.status(400).json({
        error: 'No hay ninguna corrección para devolver: falta la nota o la devolución escrita.',
        codigo: 'NADA_PARA_DEVOLVER',
        omitidas,
      });
    }

    await activity.save();

    // Devolver SÍ cierra la reapertura (RN-26b): es el momento en el que al alumno se le
    // avisa, que es lo que significaba el "se cierra" de la regla original.
    await Submission.updateMany(
      { activity: req.params.id, student: { $in: devueltas } },
      { $set: { reopenedAt: null, reopenedBy: null } },
    );

    // Una entrada POR ALUMNO: el lote es una comodidad de la pantalla, no una unidad de
    // auditoría. Dentro de un mes, la pregunta es "¿cuándo se le devolvió a ESTE alumno?".
    const alumnos = await User.find({ _id: { $in: devueltas } }).select('name').lean();
    const nombre = {};
    alumnos.forEach(a => { nombre[a._id.toString()] = a.name; });
    for (const sid of devueltas) {
      logAudit(req, 'submission.return',
        [
          { type: 'activity', id: activity._id, name: activity.title },
          { type: 'user',     id: sid,          name: nombre[sid] || '' },
          { type: 'course',   id: course._id,   name: course.name },
        ],
        {},
      );
    }

    res.json({ ok: true, devueltas: devueltas.length, omitidas });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al devolver las correcciones' });
  }
});

// POST /activities/:id/reopen-submission
// El docente habilita a UN alumno a rehacer su entrega. Body: { studentId, reabrir? }
//
// Es la salida para los dos casos que la regla sola no cubre:
//   · el docente que ya puso nota y quiere que el alumno rehaga el trabajo igual;
//   · el docente que corrigió por error y necesita devolverle la posibilidad.
//
// NO pasa por exigirAlumnoQuePuedeEntregar, y no es un olvido: esa guarda contesta 403
// justamente en el estado en el que esta ruta hace falta. Acá el permiso es el del docente
// que gestiona la materia.
//
// La reapertura le gana a la nota, al plazo vencido y al check destildado (ver
// public/js/edicionEntrega.js); se apaga sola cuando el docente vuelve a poner nota, o a
// mano mandando `reabrir: false`.
router.post('/:id/reopen-submission', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const { studentId } = req.body;
    const reabrir = req.body.reabrir !== false; // por omisión, reabre

    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const submission = await Submission.findOne({ activity: req.params.id, student: studentId });
    // Sin entrega no hay nada que reabrir: al que no entregó lo habilita el plazo (y las
    // entregas tardías), no esto.
    if (!submission) {
      return res.status(404).json({ error: 'Ese alumno todavía no entregó nada' });
    }

    submission.reopenedAt = reabrir ? new Date() : null;
    submission.reopenedBy = reabrir ? res.locals.user._id : null;
    await submission.save();

    const student = await User.findById(studentId).select('name').lean();
    logAudit(req, 'submission.reopen',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'user',     id: studentId,    name: student?.name || '' },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { accion: reabrir ? 'habilitó a rehacer' : 'volvió a cerrar' },
    );

    res.json({ ok: true, reopenedAt: submission.reopenedAt });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al habilitar la edición' });
  }
});

// DELETE /activities/:id
// Elimina una actividad con CASCADA COMPLETA:
// 1. Borra archivos de entrega de cada alumno del disco (ENTREGAS_BASE/{storagePath})
// 2. Borra todos los documentos Submission de la BD
// 3. Borra archivos adjuntos del docente del disco (ARCHIVOS_BASE/{relPath})
// 4. Borra el documento Activity de la BD
router.delete('/:id', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    // 1. Borrar archivos físicos de entregas de alumnos
    // storagePath es relativo desde ENTREGAS_BASE: schoolId/actId/studentId/filename
    //
    // Incluye las VERSIONES anteriores y los derivados (RN-36). Si se las salteara quedarían
    // archivos de menores en disco sin ningún documento que los nombre — y como
    // cleanup-files.js ahora SÍ referencia `versions[].files[]`, no los limpiaría nunca más:
    // serían huérfanos permanentes, invisibles para las dos herramientas.
    const submissions = await Submission.find({ activity: req.params.id });
    submissions.forEach(sub => {
      archivosDeLaEntrega(sub).forEach(borrarArchivoDeEntrega);
    });

    // 2. Borrar todos los documentos Submission (incluye texto/comentario del alumno)
    await Submission.deleteMany({ activity: req.params.id });

    // 2b. Borrar los acuses de lectura de la actividad (si no, quedan colgados para siempre:
    // no hay ninguna otra ruta que los limpie y nadie los vuelve a mirar)
    await ActivityView.deleteMany({ activity: req.params.id });

    // 3. Borrar archivos adjuntos del docente del disco
    // La URL tiene formato /archivos/{relPath}; se convierte a ruta absoluta via ARCHIVOS_BASE
    activity.attachments
      .filter(a => a.type === 'file' && a.url.startsWith('/archivos/'))
      .forEach(a => {
        const relPath = a.url.replace(/^\/archivos\//, '');
        const fp = path.join(ARCHIVOS_BASE, relPath);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });

    // 4. Borrar el documento Activity de la BD
    await activity.deleteOne();

    logAudit(req, 'activity.delete',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        entregas_borradas: submissions.length,
        adjuntos_borrados: (activity.attachments || []).filter(a => a.type === 'file').length,
      },
    );

    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al eliminar: ' + err.message });
  }
});

// PATCH /activities/:id/toggle-late
// Invierte el flag allowLateSubmissions de la actividad (solo el docente owner)
// Se usa cuando el plazo venció y el docente quiere abrir/cerrar entregas tardías
// Retorna: { allowLateSubmissions: bool }
router.patch('/:id/toggle-late', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    activity.allowLateSubmissions = !activity.allowLateSubmissions;
    await activity.save();

    logAudit(req, 'activity.toggle_late',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { habilitadas: activity.allowLateSubmissions ? 'sí' : 'no' },
    );

    res.json({ allowLateSubmissions: activity.allowLateSubmissions });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PATCH /activities/:id/toggle-visibility
// Botón de ojo de la tarjeta: invierte el estado efectivo de la actividad para los alumnos
// (solo quien administra el curso). No es un booleano crudo: si para lograr el estado pedido
// alcanza con volver al automático, `proximoOverride` devuelve null y la actividad queda otra
// vez esperando su `availableFrom` — la fecha programada nunca se pierde.
// Retorna: { visibleOverride, estado, availableFrom }
router.patch('/:id/toggle-visibility', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    activity.visibleOverride = proximoOverride(activity, new Date());
    await activity.save();

    const estado = estadoVisibilidad(activity, new Date());
    logAudit(req, 'activity.toggle_visibility',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { estado },
    );

    res.json({
      visibleOverride: activity.visibleOverride,
      estado,
      availableFrom:   activity.availableFrom,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /activities/:id
// Edita campos básicos de la actividad (no modifica adjuntos ni calificaciones)
// Body: { title, description?, dueDate?, availableFrom?, points?, type?, allowResubmission? }
// Retorna: { activity }
router.put('/:id', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const { title, description, dueDate, availableFrom, points, type, allowResubmission } = req.body;
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (!title?.trim()) return res.status(400).json({ error: 'El título es requerido' });

    activity.title         = title.trim();
    activity.description   = description?.trim() || '';
    activity.dueDate       = dueDate || null;
    activity.availableFrom = availableFrom || activity.availableFrom;
    activity.points        = points !== '' && points != null ? Number(points) : null;
    if (type) activity.type = type;
    // Ausente = no se toca (mismo criterio que en la creación): editar el título desde un
    // cliente que no manda el check no puede congelarle la entrega a nadie.
    if (allowResubmission !== undefined) activity.allowResubmission = !!allowResubmission;
    await activity.save();

    logAudit(req, 'activity.edit',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {},
    );

    res.json({ activity });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Error al editar' });
  }
});

/* ─── Entregas ─── */

// Busca un archivo de entrega por su filename único, EN LA ENTREGA ACTUAL O EN SUS VERSIONES
// anteriores (RN-37). Devuelve { submission, file } o { submission: null }.
//
// Las dos consultas van por separado y en orden: la de `files` es la que se usa el 99% de
// las veces y resuelve por el índice de siempre; la de `versions` solo corre si la primera
// no encontró nada.
async function buscarArchivoDeEntrega(filename) {
  let submission = await Submission.findOne({ 'files.filename': filename }).populate('activity');
  if (submission) {
    return { submission, file: submission.files.find(f => f.filename === filename) };
  }
  submission = await Submission.findOne({ 'versions.files.filename': filename }).populate('activity');
  if (!submission) return { submission: null, file: null };
  for (const v of submission.versions || []) {
    const file = (v.files || []).find(f => f.filename === filename);
    if (file) return { submission, file };
  }
  return { submission: null, file: null };
}

// Borra un archivo de entrega del disco CON sus derivados. Los tres llamadores son los tres
// momentos en los que un archivo deja de existir: la versión que se cae del tope, la entrega
// que el alumno retira y la actividad que el docente borra.
//
// El derivado se va con el original y no queda para después: es una copia del trabajo de un
// menor y no puede sobrevivirlo. Y como cleanup-files.js ya referencia las versiones
// (RN-35), un derivado huérfano que quedara acá no lo limpiaría nadie nunca más.
function borrarArchivoDeEntrega(f) {
  try {
    const fp = path.join(ENTREGAS_BASE, f.storagePath);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
  const schoolId = String(f.storagePath || '').split('/')[0];
  for (const ext of ['.pdf', '.dxf']) {
    try {
      const derivado = rutaDerivada(schoolId, f.filename, ext);
      if (fs.existsSync(derivado)) fs.unlinkSync(derivado);
    } catch {}
  }
}

// Todos los archivos de una entrega: los actuales Y los de sus versiones anteriores.
function archivosDeLaEntrega(sub) {
  return [
    ...(sub.files || []),
    ...(sub.versions || []).flatMap(v => v.files || []),
  ];
}

// La guarda de siempre, tal cual: o es el alumno que entregó, o es alguien que gestiona la
// materia. Se extrae a una función porque ahora la usan cuatro rutas (el archivo, el PDF
// derivado, el DXF derivado y la emisión del enlace firmado) y no puede divergir entre ellas.
async function puedeVerEntrega(submission, usuario) {
  if (submission.student.toString() === usuario._id.toString()) return true;
  const course = await Course.findById(submission.activity.course);
  return !!(course && course.canManage(usuario));
}

// GET /activities/submission-file/:filename
// Descarga protegida de archivos de entrega: solo el alumno que entregó o el docente del curso
// Verifica propiedad buscando el Submission por filename, luego chequea si es el alumno o el docente
router.get('/submission-file/:filename', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;

    // La búsqueda incluye las VERSIONES anteriores (RN-37): el archivo que el alumno
    // reemplazó ya no está en `files[]` pero sigue en disco, dentro de `_versiones/`, y
    // tanto el docente como el propio alumno tienen que poder abrirlo. La guarda es
    // EXACTAMENTE la misma de siempre — lo único que cambia es dónde se busca el archivo.
    const { submission, file } = await buscarArchivoDeEntrega(filename);
    if (!submission) return res.status(404).send('Archivo no encontrado');
    if (!(await puedeVerEntrega(submission, res.locals.user))) {
      return res.status(403).send('Acceso denegado');
    }

    const filePath = path.join(ENTREGAS_BASE, file.storagePath);
    if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado en disco');

    // Por defecto sirve inline (permite que el navegador o el previewer del frontend muestren
    // el PDF/imagen embebidos en un iframe). Con ?dl=1 fuerza descarga. Antes SIEMPRE forzaba
    // descarga, lo que rompía la previsualización: aunque el frontend abriera un modal con
    // <iframe src="...">, el navegador disparaba el "Save as…" al recibir el header attachment.
    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(filePath);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// POST /activities/submission-file/:filename/enlace
// Emite una URL firmada de vida corta para que el visor de Microsoft pueda BAJAR el archivo
// (RN-15). Responde { url, expiraEn }.
//
// Solo la emite quien puede ver el archivo por la ruta normal Y gestiona la materia: el
// ALUMNO no puede emitir enlaces firmados de nada, ni de lo suyo. Un enlace firmado es una
// puerta sin cookie durante 5 minutos, y esa decisión es del docente que está corrigiendo,
// no del dueño del archivo.
router.post('/submission-file/:filename/enlace', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const { submission } = await buscarArchivoDeEntrega(filename);
    if (!submission) return res.status(404).json({ error: 'Archivo no encontrado' });

    const course = await Course.findById(submission.activity.course);
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const { url, expiraEn } = firmaArchivo.firmar(filename, res.locals.user._id.toString());

    // Cada emisión se audita: es la contrapartida escrita de abrir una puerta sin cookie
    // sobre el archivo de un menor, aunque dure cinco minutos.
    logAudit(req, 'submission.preview_link',
      [
        { type: 'activity', id: submission.activity._id, name: submission.activity.title },
        { type: 'user',     id: submission.student,      name: '' },
        { type: 'course',   id: course._id,              name: course.name },
      ],
      { archivo: Correccion.extensionParaLog(filename) },
    );

    res.json({ url, expiraEn });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al preparar la vista previa' });
  }
});

// GET /activities/entrega-firmada/:filename?exp&sig
// La otra punta del enlace firmado. NO pasa por requireAuth, y por eso es una ruta APARTE:
// un bypass condicional adentro de la ruta con guarda es como nacen los agujeros de auth.
// Lo único que la protege es la firma, que ata el archivo, el vencimiento y el docente que
// la pidió.
router.get('/entrega-firmada/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const veredicto = firmaArchivo.verificar({ filename, exp: req.query.exp, sig: req.query.sig });
    if (!veredicto.ok) {
      const texto = veredicto.motivo === 'ENLACE_VENCIDO'
        ? 'El enlace venció. Volvé a abrir la vista previa.'
        : 'El enlace no es válido.';
      logRechazo(res, 403, veredicto.motivo, { ruta: 'entrega_firmada' });
      return res.status(403).json({ error: texto, codigo: veredicto.motivo });
    }

    const { submission, file } = await buscarArchivoDeEntrega(filename);
    if (!submission) return res.status(404).json({ error: 'Archivo no encontrado' });

    const filePath = path.join(ENTREGAS_BASE, file.storagePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });

    // `inline`: del otro lado hay un visor, no un navegador que descarga.
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.sendFile(filePath);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Traduce el error de un conversor al par (status, código) de la spec. Ninguno de los
// caminos de conversión puede terminar en 500: el archivo del alumno se puede descargar
// siempre, así que un conversor caído es una degradación, no una falla del servidor.
const HTTP_DE_CONVERSION = {
  SIN_CONVERSOR:            501,
  SIN_CONVERSOR_CAD:        501,
  ARCHIVO_DEMASIADO_GRANDE: 413,
  CONVERSION_EN_CURSO:      409,
  CONVERSION_FALLIDA:       422,
};

function responderErrorDeConversion(res, err, textoPorDefecto) {
  const codigo = HTTP_DE_CONVERSION[err?.codigo] ? err.codigo : 'CONVERSION_FALLIDA';
  const texto = codigo === 'CONVERSION_FALLIDA' ? textoPorDefecto : err.message;
  return res.status(HTTP_DE_CONVERSION[codigo]).json({ error: texto, codigo });
}

// GET /activities/submission-file/:filename/pdf
// El PDF derivado de un Office (paso 2 de la cadena, RN-16). Mismo permiso que el original.
// La cache es permanente y no se invalida nunca: el filename es único por subida, así que
// cada archivo se convierte UNA vez en su vida.
router.get('/submission-file/:filename/pdf', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const { submission, file } = await buscarArchivoDeEntrega(filename);
    if (!submission) return res.status(404).json({ error: 'Archivo no encontrado' });
    if (!(await puedeVerEntrega(submission, res.locals.user))) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (!Correccion.EXT_OFFICE.includes(Correccion.extensionDe(file.name || filename))) {
      return res.status(400).json({ error: 'Ese archivo no se convierte a PDF' });
    }

    const origen = path.join(ENTREGAS_BASE, file.storagePath);
    if (!fs.existsSync(origen)) {
      return res.status(404).json({
        error: 'El archivo no está en el servidor. Avisale al alumno que lo vuelva a subir.',
        codigo: 'ARCHIVO_NO_ENCONTRADO',
      });
    }

    const destino = rutaDerivada(String(file.storagePath).split('/')[0], filename, '.pdf');
    try {
      await conversionOffice.convertirAPdf(origen, destino);
    } catch (err) {
      return responderErrorDeConversion(res, err,
        'No se pudo convertir el archivo para verlo acá (puede estar dañado o protegido con contraseña).');
    }

    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file.name, path.extname(file.name)) + '.pdf')}`);
    res.sendFile(destino);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /activities/submission-file/:filename/dxf
// El DXF derivado de un DWG (RN-42a). De acá en adelante el plano lo dibuja el navegador,
// igual que un .dxf subido — incluida la regla de RN-40: el texto que viene adentro es del
// alumno, no lo escribió el servidor, y pasar por un conversor no sanitiza nada.
//
// Por DEMANDA, en el clic: medio segundo en el VPS. Sin cola y sin prefetch, al revés que
// Office — poner el plano atrás de una conversión de cuatro segundos que no tiene nada que
// ver con él sería peor que esperarlo.
router.get('/submission-file/:filename/dxf', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const { submission, file } = await buscarArchivoDeEntrega(filename);
    if (!submission) return res.status(404).json({ error: 'Archivo no encontrado' });
    if (!(await puedeVerEntrega(submission, res.locals.user))) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    if (Correccion.extensionDe(file.name || filename) !== '.dwg') {
      return res.status(400).json({ error: 'Ese archivo no es un plano .dwg' });
    }

    const origen = path.join(ENTREGAS_BASE, file.storagePath);
    if (!fs.existsSync(origen)) {
      return res.status(404).json({
        error: 'El archivo no está en el servidor. Avisale al alumno que lo vuelva a subir.',
        codigo: 'ARCHIVO_NO_ENCONTRADO',
      });
    }

    const destino = rutaDerivada(String(file.storagePath).split('/')[0], filename, '.dxf');
    if (!fs.existsSync(destino)) {
      // El tope de ENTRADA rebota antes de mandar nada a convertir, y está calculado para que
      // su peor expansión medida (×5,8) siga entrando en el tope de dibujo (RN-41).
      if (fs.statSync(origen).size > Correccion.TOPES.entradaDwg) {
        return res.status(413).json({
          error: 'El plano es demasiado grande para previsualizarlo. Descargalo y abrilo con AutoCAD.',
          codigo: 'ARCHIVO_DEMASIADO_GRANDE',
        });
      }
      if (!(await conversionCad.odaDisponible())) {
        return res.status(501).json({
          error: 'El servidor no tiene instalado el conversor de planos, así que este .dwg solo se puede descargar.',
          codigo: 'SIN_CONVERSOR_CAD',
        });
      }
      try {
        await conversionCad.convertirDwgADxf(origen, { destino });
      } catch (err) {
        return responderErrorDeConversion(res, err,
          'No se pudo convertir el plano para verlo acá (puede estar dañado).');
      }
    }

    // Se sirve `attachment` con su mime, igual que el original: lo que lo dibuja es un
    // fetch() del navegador, al que el Content-Disposition no le importa (RN-39).
    res.setHeader('Content-Type', 'image/vnd.dxf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.name, path.extname(file.name)) + '.dxf')}`);
    res.sendFile(destino);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /activities/:id/staged-file/:filename
// Sirve inline un archivo YA pre-subido por el alumno pero AÚN NO enviado como entrega
// (o sea, el archivo está en disco en el path final pero no hay Submission todavía, o hay
// una Submission distinta y este es un archivo nuevo por adjuntar).
// Seguridad: solo devuelve el archivo si existe en {schoolId}/{actId}/{userId}/{filename},
// el path bajo el propio dir del alumno — imposible ver archivos de otros pasando filenames.
router.get('/:id/staged-file/:filename', requireAuth, async (req, res) => {
  // `:filename` no se valida acá: no es un ObjectId. De ese lado protege el path.basename.
  if (idMalo(req, res, 'Archivo no encontrado')) return;
  try {
    const { id: activityId, filename } = req.params;
    const userId   = res.locals.user._id.toString();
    const schoolId = res.locals.user.school?.toString() || 'general';

    // path.join normaliza .. y separadores; el filename viene de multer (timestamp+random+ext)
    // así que no contiene barras, pero verificamos igual con basename para no dejar pasar traversal.
    const safeName = path.basename(filename);
    const filePath = path.join(ENTREGAS_BASE, schoolId, activityId, userId, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado');

    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.sendFile(filePath);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Guard del alumno que va a entregar: existe la actividad, está inscripto, la ve, y su
// entrega sigue abierta. La ÚNICA guarda de entrega del archivo: la usan las dos rutas de
// subida, el submit y el DELETE que retira.
//
// Va ANTES de multer y esa es toda la gracia: multer recibe el cuerpo ENTERO antes de que
// el handler corra, así que con el chequeo tardío alguien que no puede entregar igual
// alcanza a empujar 20 MB al disco. `/upload-submission-file` lo hacía tarde justamente por
// eso — tenía la condición copiada a mano en su propio handler.
//
// Lo que consulta queda en `req.entrega` para que el handler no lo vuelva a buscar: son tres
// queries (actividad, curso, entrega) que el submit necesita igual.
async function exigirAlumnoQuePuedeEntregar(req, res, next) {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    const userId = res.locals.user._id.toString();
    if (!course || !course.students.map(s => s.toString()).includes(userId)) {
      return res.status(403).json({ error: 'No estás inscripto en este curso' });
    }

    // Bloquea la entrega a una actividad que el alumno no debería estar viendo (programada
    // para más adelante, u ocultada con el ojo). Por la interfaz no llega —el listado se las
    // filtra—, pero sí por un link directo guardado de antes de que la bajaran.
    if (!esVisibleParaAlumno(activity, new Date())) {
      return res.status(403).json({ error: 'Esta actividad todavía no está disponible.' });
    }

    const submission = await Submission.findOne({ activity: req.params.id, student: userId });
    // El motivo y su texto salen del módulo: el cartel que ve el alumno en la pantalla y
    // este 403 dicen lo mismo porque SON lo mismo.
    const veredicto = puedeEditarEntrega({
      act:        activity,
      grade:      activity.grades.find(g => g.student.toString() === userId) || null,
      hayEntrega: !!submission,
      reabierta:  !!submission?.reopenedAt,
      ahora:      new Date(),
    });
    if (!veredicto.puede) {
      // El plazo vencido conserva su mensaje histórico, que dice qué puede hacer el docente
      // para reabrirlo; los otros dos motivos son nuevos y traen el suyo.
      const error = veredicto.motivo === 'vencida'
        ? 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.'
        : veredicto.texto;
      return res.status(403).json({ error, motivo: veredicto.motivo });
    }

    req.entrega = { activity, course, submission, userId };
    next();
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al preparar la entrega' });
  }
}

// POST /activities/:id/upload-submission-image
// La FOTO de la entrega del alumno: la hoja de la carpeta, el ejercicio resuelto, la maqueta.
//
// Ruta aparte de /upload-submission-file por el mismo motivo que /upload-image lo es de
// /upload-attachment: el camino del archivo es otro. Acá va multer EN MEMORIA → sharp → WebP
// → disco, y aquella es diskStorage. Sumar las imágenes a EXT_SUBMISSIONS habría guardado la
// foto de 4 MB tal cual.
//
// Qué resuelve (auditoría del 2026-08-24): era el ÚNICO camino de subida de la aplicación que
// no pasaba por el optimizador, y se notaba en las dos puntas:
//
//   1. Rechazaba `.heic` —lo que manda un iPhone— con el cartel "Tipo de archivo no permitido
//      (PDF, Word, Excel, imágenes o ZIP)", que nombra a las imágenes mientras rechaza una.
//      También `.webp` (lo que baja de WhatsApp o de Chrome) y `.jfif`.
//   2. Lo que sí entraba viajaba y se guardaba entero: una foto de celular son varios MB por
//      alumno por entrega, y cuanto más tarda la subida más expuesta está a los cortes del
//      Funnel (ver el informe de subidas del 18/08).
//
// La respuesta es IDÉNTICA a la de /upload-submission-file a propósito: el navegador mete las
// dos en el mismo `_subUploadedFiles` y el submit no distingue.
router.post('/:id/upload-submission-image', requireAuth, uploadLimiter,
  exigirAlumnoQuePuedeEntregar, subirImagen('file'), async (req, res) => {
    try {
      // Una extensión rechazada ya no llega hasta acá (el fileFilter falla con su propio 400
      // y la lista completa). Lo que queda es "no adjuntó nada".
      if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });

      const schoolId = res.locals.user.school?.toString() || 'general';
      const userId   = res.locals.user._id.toString();
      // Mismo directorio y mismo formato de storagePath que la ruta de archivos: el submit
      // valida que el prefijo sea {schoolId}/{activityId}/{userId}/ y no le importa por cuál
      // de las dos rutas entró.
      const guardada = await guardarImagenOptimizada(req.file, {
        preset: 'adjunto',
        dir:    path.join(ENTREGAS_BASE, schoolId, req.params.id, userId),
      });

      // El nombre VISIBLE lleva la extensión que quedó EN DISCO. Misma regla que la sala y que
      // el adjunto del docente: si no, el archivo que el docente descarga no coincide con su
      // propio nombre.
      const original = fixFilenameEncoding(req.file.originalname);
      const extFinal = path.extname(guardada.filename).toLowerCase();
      const base     = path.basename(original, path.extname(original));

      res.json({
        storagePath: [schoolId, req.params.id, userId, guardada.filename].join('/'),
        name:        `${base}${extFinal}`.slice(0, 120),
        filename:    guardada.filename,
        mime:        extFinal === '.webp' ? 'image/webp' : (req.file.mimetype || ''),
        size:        guardada.bytes,
      });
    } catch (err) {
      if (err instanceof ImagenInvalidaError) return res.status(400).json({ error: err.message });
      logDeRuta(err, res);
      res.status(500).json({ error: 'Error al subir la imagen' });
    }
  });

// POST /activities/:id/upload-submission-file
// Pre-sube UN archivo al path final de la entrega, igual que el docente hace con
// /activities/upload-attachment. Devuelve la metadata para que el frontend la mande
// en el JSON del submit final (ver POST /:id/submit).
// Body multipart: { file }
// Retorna: { storagePath, name, filename, mime, size }
// La guarda va ANTES de multer a propósito, y desde el 2026-09-04 es la MISMA que usa la
// ruta de imágenes: antes esta ruta repetía los chequeos a mano en su handler, o sea DESPUÉS
// de que multer escribiera el archivo — quien no podía entregar igual empujaba sus 20 MB al
// disco antes de leer el 403.
router.post('/:id/upload-submission-file', requireAuth, uploadLimiter,
  exigirAlumnoQuePuedeEntregar, (req, res, next) => {
  // Intercepta errores de multer para devolver JSON en español, como en /upload-attachment
  submissionUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `El archivo es demasiado grande (máximo ${SUBMISSION_MAX_SIZE / 1024 / 1024} MB)` });
      }
      return res.status(400).json({ error: err.message || 'Error al procesar el archivo' });
    }
    next();
  });
}, async (req, res) => {
  try {
    // El mensaje enumera lo que ESTA ruta acepta. Antes decía "(PDF, Word, Excel, imágenes o
    // ZIP)" y era justo el cartel que veía el alumno cuando le rebotaba una foto de iPhone:
    // nombraba a las imágenes entre lo permitido mientras rechazaba una. Las fotos ahora
    // tienen su propia ruta y su propio mensaje.
    if (!req.file) {
      return res.status(400).json({
        error: `Ese archivo no se puede subir. Aceptamos ${EXT_SUBMISSIONS.join(', ')} y fotos.`,
      });
    }

    // Los chequeos de acceso ya corrieron en exigirAlumnoQuePuedeEntregar, antes de multer.
    const { userId } = req.entrega;
    const schoolId = res.locals.user.school?.toString() || 'general';
    res.json({
      storagePath: [schoolId, req.params.id, userId, req.file.filename].join('/'),
      name:        fixFilenameEncoding(req.file.originalname),
      filename:    req.file.filename,
      mime:        req.file.mimetype,
      size:        req.file.size,
    });
  } catch (err) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    logDeRuta(err, res);
    res.status(500).json({ error: err.message || 'Error al subir el archivo' });
  }
});

// POST /activities/:id/submit
// El alumno entrega o reenvía su trabajo para una actividad.
// Acepta dos formatos por compatibilidad:
//   1. JSON: { text?, uploadedFiles?: [{ storagePath, name, filename, mime, size }] }
//      → los archivos ya se pre-subieron con /upload-submission-file (flujo nuevo, con
//        progreso real por archivo).
//   2. multipart/form-data: { text?, files? }  (flujo viejo — se mantiene por si algún
//      cliente/test aún lo usa).
// Si hay nuevos archivos: reemplaza los anteriores (borra del disco + upsert en BD).
// Si no hay archivos nuevos: mantiene los archivos anteriores, solo actualiza el texto.
// Middleware: solo corre el parseo multipart si el request efectivamente lo es.
// El body-parser JSON global (server.js) ya se encarga del flujo nuevo (application/json).
// El envoltorio de errores es lo que evita que una entrega pasada de tamaño termine como
// 500 "Error del servidor (ref: ...)". Es el peor lugar donde puede pasar: el alumno espera
// la subida ENTERA y recibe un error de sistema que no explica nada. Ver
// middleware/upload-errors.js.
const subirEntrega = conErroresDeSubida(
  submissionUpload.array('files', 10),
  { maxMb: SUBMISSION_MAX_SIZE / 1024 / 1024 },
);
const conditionalMultipart = (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return subirEntrega(req, res, next);
  next();
};

router.post('/:id/submit', requireAuth, uploadLimiter, exigirAlumnoQuePuedeEntregar,
  conditionalMultipart, async (req, res) => {
  try {
    // Todo lo que sigue ya lo verificó y lo buscó exigirAlumnoQuePuedeEntregar: que la
    // actividad exista, que el alumno esté inscripto, que la vea, y que su entrega siga
    // abierta (no corregida, no vencida, no congelada por el docente).
    const { activity, course, submission: existing, userId } = req.entrega;

    const schoolId = res.locals.user.school?.toString() || 'general';

    // Archivos pre-subidos vía /upload-submission-file (flujo nuevo)
    // Se filtran los storagePath para asegurar que apunten al userId del solicitante:
    // impide que un alumno referencie archivos de otro pasando storagePaths arbitrarios.
    const preUploadedRaw = req.body.uploadedFiles
      ? (typeof req.body.uploadedFiles === 'string' ? JSON.parse(req.body.uploadedFiles) : req.body.uploadedFiles)
      : [];
    const expectedPrefix = [schoolId, req.params.id, userId, ''].join('/');
    const preUploadedFiles = preUploadedRaw
      .filter(f => f && f.storagePath && f.storagePath.startsWith(expectedPrefix))
      .map(f => ({
        name:        f.name,
        filename:    f.filename,
        storagePath: f.storagePath,
        mime:        f.mime || '',
        size:        f.size || 0,
      }));

    // Archivos que llegan directo en el FormData (flujo viejo, compatibilidad)
    const multipartFiles = (req.files || []).map(f => ({
      name:        fixFilenameEncoding(f.originalname),
      filename:    f.filename,
      storagePath: [schoolId, req.params.id, userId, f.filename].join('/'),
      mime:        f.mimetype,
      size:        f.size,
    }));

    const newFiles = [...preUploadedFiles, ...multipartFiles];

    // `keepFiles`: los filenames de la entrega anterior que SOBREVIVEN. Es lo que convierte
    // el reenvío ("reemplazo todo") en una edición ("agrego este, saco aquel"), que es la
    // mitad del pedido del 2026-09-04 — antes, subir un archivo más borraba del disco los
    // que ya estaban.
    //
    // AUSENTE ≠ VACÍO, y esa diferencia es una red de seguridad, no un detalle: sin el campo
    // (el flujo multipart viejo y cualquier cliente anterior a esta feature) rige el
    // comportamiento histórico de abajo; `[]` es una orden explícita de no conservar
    // ninguno. Si los tratáramos igual, un cliente con un bug que omitiera el campo borraría
    // la entrega entera contestando 200, sin dejar rastro en ningún log.
    const keepRaw = typeof req.body.keepFiles === 'string'
      ? JSON.parse(req.body.keepFiles)
      : req.body.keepFiles;
    const mandaKeep = Array.isArray(keepRaw);

    let filesToSave;
    if (mandaKeep) {
      // Los conservados salen de `existing.files`, NO de lo que mandó el cliente: el
      // navegador elige cuál de los suyos sobrevive, no qué archivo existe. Un filename que
      // no esté en su propia entrega se ignora en silencio.
      const keep = new Set(keepRaw.map(String));
      filesToSave = [...(existing?.files || []).filter(f => keep.has(f.filename)), ...newFiles];
    } else if (newFiles.length > 0) {
      // Sin `keepFiles`: comportamiento histórico. Con archivos nuevos, reemplaza todo.
      filesToSave = newFiles;
    } else {
      // Sin archivos nuevos: mantiene los anteriores (solo cambia el texto).
      filesToSave = existing?.files || [];
    }

    // La entrega no se vacía por esta ruta. Retirarla es una decisión y tiene su botón, su
    // confirmación y su ruta (DELETE /:id/submission): quedarse sin entrega no puede ser el
    // residuo de haber sacado el último archivo. Las interactivas quedan afuera del chequeo
    // porque su entrega son las respuestas, que no son ni archivo ni texto.
    const textoFinal = (req.body.text || '').trim();
    if (filesToSave.length === 0 && !textoFinal && !req.body.answers) {
      return res.status(400).json({
        error: existing
          ? 'Tu entrega quedaría vacía. Si querés sacarla, usá «Retirar entrega».'
          : 'Adjuntá al menos un archivo o escribí un comentario para entregar.',
      });
    }

    // ⭐ Lo que quedó afuera YA NO SE BORRA: se MUEVE a `_versiones/` (RN-33). Hasta el
    // 2026-09-21 acá había un unlink, y con él, si el alumno reemplazaba el archivo después
    // de que el docente lo corrigió, lo corregido no existía en ninguna parte.
    //
    // `_versiones/` vive dentro de la carpeta del propio alumno, que ya está en CARPETAS
    // (id `entregas`): el historial entra al backup sin agregar una sola carpeta nueva.
    const sobreviven = new Set(filesToSave.map(f => f.filename));
    const desplazados = (existing?.files || []).filter(f => !sobreviven.has(f.filename));
    const borrados = desplazados.length;

    let versionesFinales = null;
    if (desplazados.length) {
      const movidos = [];
      for (const f of desplazados) {
        const origen     = path.join(ENTREGAS_BASE, f.storagePath);
        const destinoRel = rutaEnVersiones(f.storagePath);
        try {
          const destino = path.join(ENTREGAS_BASE, destinoRel);
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          fs.renameSync(origen, destino);
          movidos.push({
            name: f.name, filename: f.filename, storagePath: destinoRel,
            mime: f.mime || '', size: f.size || 0,
          });
        } catch (err) {
          // Si el rename falla, se borra como se hacía hasta ahora y se deja la línea en el
          // log: guardar el historial no puede romper la entrega del alumno.
          logDeRuta(err, res, { paso: 'mover la versión anterior a _versiones/' });
          try { if (fs.existsSync(origen)) fs.unlinkSync(origen); } catch {}
        }
      }
      if (movidos.length) {
        const { versiones, descartada } = recortarVersiones(
          existing?.versions || [],
          { at: existing?.updatedAt || new Date(), text: existing?.text || '', files: movidos },
        );
        versionesFinales = versiones;
        // La que se cayó del tope se borra DE VERDAD, con sus derivados: el tope existe
        // porque `archivos/entregas` es el 99,8% del peso del backup y el backup viaja por
        // FTP a la PC del dueño.
        (descartada?.files || []).forEach(borrarArchivoDeEntrega);
      }
    }

    // Si la actividad viene de una plantilla interactiva, aceptar respuestas
    // estructuradas y autocalificar server-side. El campo `answers` viaja en el
    // JSON body; el autocalificador es la única fuente de verdad para el puntaje.
    let autoGraded;
    let answersToSave;
    if (activity.templateSnapshot && req.body.answers) {
      const rawAnswers = typeof req.body.answers === 'string' ? JSON.parse(req.body.answers) : req.body.answers;
      answersToSave = Array.isArray(rawAnswers) ? rawAnswers : [];
      const result = computeAutoGrade(activity.templateSnapshot.questions || [], answersToSave);
      autoGraded = {
        points:    result.points,
        maxPoints: result.maxPoints,
        breakdown: result.breakdown,
        gradedAt:  new Date(),
      };
    }

    // Upsert: crea la entrega si no existe, la actualiza si ya existe
    // $setOnInsert solo aplica en la creación: preserva la fecha original de la primera entrega
    const submissionUpdate = {
      $set: { files: filesToSave, text: textoFinal },
      $setOnInsert: { firstSubmittedAt: new Date() },
    };
    if (answersToSave) submissionUpdate.$set.answers = answersToSave;
    if (autoGraded)    submissionUpdate.$set.autoGraded = autoGraded;
    if (versionesFinales) submissionUpdate.$set.versions = versionesFinales;

    const submission = await Submission.findOneAndUpdate(
      { activity: req.params.id, student: userId },
      submissionUpdate,
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    // Si hay autocalificación, escribirla también en activity.grades[] para que el
    // gradebook / directivo la vean igual que una nota manual. NUNCA pisa un
    // override manual del docente: si ya existe un grade con manual=true, respetamos.
    if (autoGraded) {
      const gExisting = activity.grades.find(g => g.student.toString() === userId);
      if (!gExisting || gExisting.manual === false) {
        // ⚠️ El autocalificador NUNCA queda retenido en borrador (RN-25): escribe
        // `returnedAt` con la fecha, siempre. Este camino no pasa por POST /:id/grade, así
        // que si no lo escribiera acá, el alumno respondería el cuestionario y no vería su
        // propia nota hasta que un docente se acordara de devolvérsela.
        if (gExisting) {
          gExisting.points   = autoGraded.points;
          gExisting.feedback = 'Autocalificado';
          gExisting.gradedAt = autoGraded.gradedAt;
          gExisting.manual   = false;
          gExisting.returnedAt = new Date();
        } else {
          activity.grades.push({
            student:  userId,
            points:   autoGraded.points,
            feedback: 'Autocalificado',
            gradedAt: autoGraded.gradedAt,
            manual:   false,
            returnedAt: new Date(),
          });
        }
        await activity.save();
      }
    }

    // Distingue primera entrega vs reenvío usando el snapshot de `existing`
    // capturado ANTES del upsert. La fecha de la actividad puede ser null
    // (actividad sin plazo) — en ese caso, `tardia` no se agrega al meta.
    const now = new Date();
    const wasLate = activity.dueDate && now > new Date(activity.dueDate);
    logAudit(req, existing ? 'submission.update' : 'submission.create',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      {
        archivos: filesToSave.length,
        // Solo si sacó alguno: en una entrega normal el renglón sería siempre "quitados: 0"
        // y el registro de auditoría se lee peor.
        ...(borrados ? { quitados: borrados } : {}),
        ...(activity.dueDate ? { tardia: wasLate ? 'sí' : 'no' } : {}),
      },
    );

    res.json({ submission });
  } catch (err) {
    // Si multer subió archivos antes de que falle el proceso, los limpia del disco
    (req.files || []).forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al enviar la entrega: ' + err.message });
  }
});

// GET /activities/:id/export-grades
// Genera y descarga un Excel con todas las calificaciones de la actividad (solo el docente owner)
// Columnas: Alumno, DNI, Email, Nota, Máximo, Feedback, Fecha calificación
router.get('/:id/export-grades', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).send('Actividad no encontrada');

    const course = await Course.findById(activity.course).populate('students', 'name email dni');
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).send('Sin acceso');
    }

    // Índice rápido de calificaciones por studentId
    const gradeMap = {};
    activity.grades.forEach(g => {
      gradeMap[g.student.toString()] = { points: g.points, feedback: g.feedback || '', gradedAt: g.gradedAt };
    });

    const maxPts = activity.points != null ? activity.points : '';

    // Una fila por alumno inscripto (aunque no haya sido calificado)
    const rows = course.students.map(s => {
      const g = gradeMap[s._id.toString()];
      return {
        'Alumno':              s.name,
        'DNI':                 s.dni || '',
        'Email':               s.email,
        'Nota':                g?.points != null ? g.points : '',
        'Máximo':              maxPts,
        'Feedback docente':    g?.feedback || '',
        'Fecha calificación':  g?.gradedAt ? live.fechaCorta(g.gradedAt) : '',
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    // Ajusta el ancho de las columnas automáticamente según el contenido más largo de cada una
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length)) + 2,
    }));
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Calificaciones');

    const safeName  = activity.title.replace(/[^a-z0-9áéíóúüñ ]/gi, '_').trim();
    const filename  = `${safeName}_calificaciones.xlsx`;
    const buf       = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error al generar el archivo: ' + err.message);
  }
});

// DELETE /activities/:id/submission
// El alumno RETIRA su entrega: borra sus archivos del disco y el documento Submission.
// La actividad le vuelve a figurar como pendiente.
//
// Existe porque el alumno tiene que poder deshacer una entrega equivocada, pero es una
// decisión y no un residuo: sacar el último archivo desde `/submit` da 400 y manda acá. Por
// eso vive en su propia ruta, con su confirmación en pantalla y su registro de auditoría.
//
// Misma guarda que editar: no se puede retirar una entrega corregida ni vencida. Si el
// docente ya la miró, retirarla le borraría de abajo lo que acaba de corregir.
router.delete('/:id/submission', requireAuth, exigirAlumnoQuePuedeEntregar, async (req, res) => {
  try {
    const { activity, course, submission } = req.entrega;
    if (!submission) return res.status(404).json({ error: 'No tenés una entrega para retirar' });

    // Retirar la entrega SÍ borra todo, versiones incluidas (RN-33): es una decisión
    // explícita del alumno sobre su propio trabajo, no una rotación.
    archivosDeLaEntrega(submission).forEach(borrarArchivoDeEntrega);
    const archivos = submission.files.length;
    await Submission.deleteOne({ _id: submission._id });

    logAudit(req, 'submission.withdraw',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { archivos },
    );

    res.json({ ok: true, archivos });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al retirar la entrega' });
  }
});

// GET /activities/:id/my-submission
// El alumno consulta su propia entrega para mostrar en el modal de detalle
// Retorna: { submission } o { submission: null } si todavía no entregó
router.get('/:id/my-submission', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const submission = await Submission.findOne({
      activity: req.params.id,
      student:  res.locals.user._id,
    });

    // Abrir el detalle apaga el no-leído del alumno, igual que GET /:id/entrega/:studentId
    // lo apaga del lado del docente: es donde el hilo se pinta (RN-31b).
    if (submission?.unreadForStudent) {
      await Submission.updateOne({ _id: submission._id }, { $set: { unreadForStudent: false } });
      submission.unreadForStudent = false;
    }

    // El hilo viaja aparte de `submission` y no adentro: es lo que pinta el modal, y así el
    // cliente no tiene que saber que vive embebido en la entrega.
    res.json({
      submission: submission || null,
      privateComments: submission?.privateComments || [],
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /activities/:id/submissions
// El docente ve todas las entregas de una actividad con datos del alumno
// Retorna: { submissions } array con student populado (name, email, dni)
router.get('/:id/submissions', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const submissions = await Submission.find({ activity: req.params.id })
      .populate('student', 'name email dni')
      .sort({ updatedAt: -1 }); // Las más recientes primero

    // La planilla necesita SABER que hay historial y que hay hilo, no traérselos: son 30
    // entregas por actividad y los arrays completos multiplicarían el peso de esta respuesta
    // por nada. El detalle pesado de UN alumno lo sirve GET /:id/entrega/:studentId.
    const lista = submissions.map(s => {
      const obj = s.toObject();
      obj.versionesCount    = (obj.versions || []).length;
      obj.comentariosCount  = (obj.privateComments || []).length;
      obj.unreadForTeacher  = !!obj.unreadForTeacher;
      delete obj.versions;
      delete obj.privateComments;
      return obj;
    });

    res.json({ submissions: lista });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /activities/:id/view
// Acuse de lectura: el alumno abrió el detalle de la actividad. Lo dispara course.js
// (fire-and-forget) al abrir el modal. Es POST y no se cuelga de /my-submission a propósito:
// un GET no debe mutar, y así queda testeable por separado.
// Retorna: { ok: true } siempre que no haya error real — el cliente no usa la respuesta.
router.post('/:id/view', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    // Solo se registran alumnos. El docente/admin que entra a mirar su propia actividad no
    // debe inflar el contador "N vieron" — pero tampoco es un error: se ignora en silencio.
    if (res.locals.user.role !== 'student') return res.json({ ok: true });

    const activity = await Activity.findById(req.params.id).select('course');
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    // Verificar que el alumno esté inscripto en el curso de la actividad: sin esto,
    // cualquiera podría registrar vistas en actividades de otros cursos pingueando IDs.
    const course = await Course.findById(activity.course).select('students');
    const isEnrolled = course?.students.some(s => s.toString() === res.locals.user._id.toString());
    if (!isEnrolled) return res.status(403).json({ error: 'Sin acceso' });

    const now = new Date();
    await ActivityView.findOneAndUpdate(
      { activity: activity._id, student: res.locals.user._id },
      {
        $setOnInsert: { firstViewedAt: now }, // solo en la primera apertura
        $set:         { lastViewedAt: now },
        $inc:         { viewCount: 1 },
      },
      { upsert: true },
    );
    // No se audita: es alto volumen y de bajo valor forense.
    res.json({ ok: true });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Modo Corrector: el detalle de UN alumno y el hilo privado ─── */

// Los Office de esta entrega que todavía no tienen su PDF derivado, listos para el prefetch
// de RN-16b: [{ origen, destino }]. El schoolId sale del propio storagePath y no de la
// sesión — el que mira puede ser un admin de la escuela, pero el archivo vive donde vive.
function officeParaConvertir(submission) {
  return (submission?.files || [])
    .filter(f => Correccion.EXT_OFFICE.includes(Correccion.extensionDe(f.name || f.filename)))
    .map(f => ({
      origen:  path.join(ENTREGAS_BASE, f.storagePath),
      destino: rutaDerivada(String(f.storagePath || '').split('/')[0], f.filename, '.pdf'),
    }))
    .filter(par => fs.existsSync(par.origen) && !fs.existsSync(par.destino));
}

// GET /activities/:id/entrega/:studentId
// El detalle pesado de UN alumno: su entrega completa (con hilo e historial), su nota y su
// acuse de lectura. Es la puerta del Modo Corrector y solo la abre quien gestiona la materia.
//
// Hace dos cosas más, y las dos están acá y no en otro lado a propósito:
//   · APAGA el no-leído del docente. Se marca al abrir EL DETALLE, que es donde el hilo se
//     pinta — no en POST /:id/view, que se dispara igual aunque nadie haya mirado el hilo.
//   · DISPARA el prefetch de las conversiones de Office (RN-16b), fire-and-forget: los
//     segundos de LibreOffice transcurren mientras el docente lee el panel.
router.get('/:id/entrega/:studentId', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  if (idMalo(req, res, 'Alumno no encontrado', { param: 'studentId', como: 'json' })) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const submission = await Submission.findOne({
      activity: req.params.id,
      student:  req.params.studentId,
    }).populate('student', 'name email dni');

    if (submission?.unreadForTeacher) {
      await Submission.updateOne({ _id: submission._id }, { $set: { unreadForTeacher: false } });
      submission.unreadForTeacher = false;
    }

    const grade = activity.grades.find(g => g.student.toString() === req.params.studentId) || null;
    const view  = await ActivityView.findOne({
      activity: req.params.id,
      student:  req.params.studentId,
    });

    if (submission) conversionOffice.prefetch(officeParaConvertir(submission));

    res.json({ submission: submission || null, grade, view: view || null });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// El hilo privado de una entrega (RN-29 a RN-32). Los límites viven acá y no en el schema
// porque los dos son del HILO, no del comentario: 2.000 caracteres es el maxlength de
// privateCommentSchema, y 100 comentarios es el tope de la conversación.
const MAX_COMENTARIOS = 100;

// Rate limit POR PERSONA, no por IP: toda la escuela sale por una sola IP NAT, así que un
// límite por IP castigaría al aula entera por lo que hace uno. Mismo criterio y mismo
// mecanismo que diagLimiter (routes/diagnostico.js).
// ⚠️ El techo real es 40 por los 2 workers de PM2, como todo límite en memoria de este proyecto.
const comentarioLimiter = rateLimit({
  windowMs:        5 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.userId || ipKeyGenerator(req.ip),
  message:         { error: 'Esperá un momento antes de mandar otro comentario.', codigo: 'DEMASIADOS_COMENTARIOS' },
});

// La guarda del docente, ANTES del limitador y no adentro del handler.
//
// ⚠️ El orden importa y ya se pagó una vez en este proyecto: con el limitador primero, un
// alumno que toca la ruta del DOCENTE recibe "esperá un momento antes de mandar otro
// comentario" —"no tan rápido" cuando la respuesta correcta es "no podés"— y encima le
// consume cupo al limitador alguien que nunca debió pasar la puerta. Es la misma doctrina que
// pone a `exigirAlumnoQuePuedeEntregar` antes de multer: la guarda barata va primero.
async function exigirGestorDeLaActividad(req, res, next) {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  if (req.params.studentId && idMalo(req, res, 'Alumno no encontrado', { param: 'studentId' })) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });
    const course = await Course.findById(activity.course);
    if (!course || !course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    req.actividad = activity;
    req.curso = course;
    next();
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Ídem del lado del alumno: sin entrega no hay hilo, y ese 404 tampoco tiene por qué gastarle
// cupo al limitador.
async function exigirMiEntrega(req, res, next) {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const submission = await Submission.findOne({
      activity: req.params.id,
      student:  res.locals.user._id,
    });
    if (!submission) {
      return res.status(404).json({ error: 'El hilo se abre con la entrega.', codigo: 'SIN_ENTREGA' });
    }
    req.miEntrega = submission;
    next();
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
}

// Valida el texto que llega de cualquiera de las dos puntas. Devuelve { texto } o { error }.
function validarComentario(body, submission) {
  const texto = typeof body?.texto === 'string' ? body.texto.trim() : '';
  if (!texto) {
    return { error: { status: 400, codigo: 'COMENTARIO_VACIO', mensaje: 'Escribí algo antes de enviar el comentario.' } };
  }
  if (texto.length > 2000) {
    return { error: { status: 400, codigo: 'COMENTARIO_LARGO', mensaje: 'El comentario no puede superar los 2000 caracteres.' } };
  }
  if ((submission.privateComments || []).length >= MAX_COMENTARIOS) {
    return { error: { status: 400, codigo: 'HILO_LLENO', mensaje: 'Este hilo llegó al máximo de comentarios.' } };
  }
  return { texto };
}

// El texto se guarda TAL CUAL, con sus `<` y sus `>`: el escape es al PINTAR (textContent,
// nunca innerHTML), no al guardar. Escapar en la base rompe el texto del alumno que escribió
// "a < b" y no protege de nada que el pintado no proteja mejor.
function agregarComentario(submission, from, autorId, texto) {
  submission.privateComments.push({ from, author: autorId, text: texto });
  // Escribe el docente → le queda sin leer al alumno, y al revés. Dos booleanos y no un
  // readAt por comentario: con marcas por comentario, pintar el chip de una tarjeta
  // obligaría a traer y recorrer los 30 hilos de esa actividad en cada carga (RN-31b).
  if (from === 'teacher') submission.unreadForStudent = true;
  else                    submission.unreadForTeacher = true;
  return submission.privateComments[submission.privateComments.length - 1];
}

// POST /activities/:id/entrega/:studentId/comentario — la punta del DOCENTE.
//
// Ruta separada de la del alumno, no una ruta con un `if` adentro (mismo criterio que la URL
// firmada): la del alumno no lleva `:studentId` en la URL, así que no existe el parámetro
// que habría que validar. Antecedente `fuga_datos_api_curso`: la pantalla decía 403 y la API
// contestaba 200.
router.post('/:id/entrega/:studentId/comentario', requireAuth, exigirGestorDeLaActividad,
  comentarioLimiter, async (req, res) => {
  try {
    const { actividad: activity, curso: course } = req;

    const submission = await Submission.findOne({
      activity: req.params.id,
      student:  req.params.studentId,
    });
    // El hilo es de la ENTREGA, así que existe cuando existe la entrega (RN-31). NO se crea
    // una Submission vacía para alojar un comentario: rompería el contador "N entregaron" y
    // el estado `mySubmission` del alumno.
    if (!submission) {
      return res.status(404).json({ error: 'El hilo se abre con la entrega.', codigo: 'SIN_ENTREGA' });
    }

    const { texto, error } = validarComentario(req.body, submission);
    if (error) return res.status(error.status).json({ error: error.mensaje, codigo: error.codigo });

    // 'teacher' es el rol EN ESTE HILO, no el rol del usuario: quien gestiona la materia
    // escribe como docente aunque sea admin o directivo (mismo criterio que roleAtSend).
    const comentario = agregarComentario(submission, 'teacher', res.locals.user._id, texto);
    await submission.save();

    logAudit(req, 'submission.comment',
      [
        { type: 'activity', id: activity._id, name: activity.title },
        { type: 'user',     id: req.params.studentId, name: '' },
        { type: 'course',   id: course._id,   name: course.name },
      ],
      { de: 'docente' },
    );

    res.json({ comentario });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al guardar el comentario' });
  }
});

// POST /activities/:id/mi-comentario — la punta del ALUMNO, sobre SU entrega.
//
// Sin `:studentId`: el alumno sale de la sesión. Puede escribir EN CUALQUIER MOMENTO —antes
// de que le corrijan, con la nota en borrador y después de devuelta— porque los dos casos
// que justifican el hilo pasan antes de la devolución: "subí el archivo equivocado, el bueno
// es el segundo" y "no entendí el punto 3".
router.post('/:id/mi-comentario', requireAuth, exigirMiEntrega, comentarioLimiter, async (req, res) => {
  try {
    const submission = req.miEntrega;

    const { texto, error } = validarComentario(req.body, submission);
    if (error) return res.status(error.status).json({ error: error.mensaje, codigo: error.codigo });

    const comentario = agregarComentario(submission, 'student', res.locals.user._id, texto);
    await submission.save();

    const activity = await Activity.findById(req.params.id).select('title course');
    logAudit(req, 'submission.comment',
      [
        ...(activity ? [{ type: 'activity', id: activity._id, name: activity.title }] : []),
        ...(activity ? [{ type: 'course',   id: activity.course, name: '' }] : []),
      ],
      { de: 'alumno' },
    );

    res.json({ comentario });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error al guardar el comentario' });
  }
});

// GET /activities/:id/views
// El docente ve qué alumnos abrieron la actividad y cuándo
// Retorna: { views } array con student populado (name, email) + firstViewedAt/lastViewedAt/viewCount
router.get('/:id/views', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada', { como: 'json' })) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    if (!course.canManage(res.locals.user)) {
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const views = await ActivityView.find({ activity: req.params.id })
      .populate('student', 'name email')
      .sort({ firstViewedAt: 1 }); // Los primeros en abrirla, primero

    res.json({ views });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
