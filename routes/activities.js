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
const { logDeRuta } = require('../middleware/route-log');
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
// Regla compartida con el navegador sobre los adjuntos: qué es una imagen y qué URL puede
// guardarse como adjunto. Ver public/js/adjuntosActividad.js y specs/actividad-imagenes.spec.md.
const { esUrlDeAdjunto } = require('../public/js/adjuntosActividad');
// Pipeline de imágenes (memoria → sharp → WebP → disco), el mismo de avatares, portadas,
// novedades y la sala en vivo.
const { subirImagen, guardarImagenOptimizada, ImagenInvalidaError } = require('../middleware/image-upload');
const { EXT_IMAGENES } = require('../config/imagePresets');

// Adjuntos del docente: dentro de /public (acceso estático directo)
// Estructura: public/archivos/{schoolId}/actividades/{courseId}/{filename}
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');

// Entregas de alumnos: FUERA de /public (protegidas por ruta auth)
// Estructura: archivos/entregas/{schoolId}/{activityId}/{studentId}/{filename}
const ENTREGAS_BASE = path.join(__dirname, '../archivos/entregas');

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
const EXT_ALLOWED     = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.dwg', '.dxf'];
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
const EXT_SUBMISSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.dwg', '.dxf', '.jpg', '.jpeg', '.png', '.gif'];

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
    cb(null, EXT_ALLOWED.includes(path.extname(file.originalname).toLowerCase()));
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
    cb(null, EXT_SUBMISSIONS.includes(path.extname(file.originalname).toLowerCase()));
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
    // Los alumnos solo ven actividades que ya fueron publicadas (availableFrom <= ahora).
    // Además, si tienen enrollmentDate para este curso (o sea, fueron dados de alta con el
    // flujo "Nuevo usuario → seleccionar Curso"), ocultamos las tareas cuya fecha de entrega
    // ya venció ANTES de que se inscribieran — no las pudieron haber hecho. Se dejan visibles
    // las que no tienen dueDate (nunca vencen) y las que el docente marcó con tardías abiertas
    // (decisión explícita del usuario: si el docente abrió tardías, todos ven la actividad,
    // incluso los alumnos recién llegados). Alumnos sin enrollmentDate (los que ya estaban
    // antes de esta feature, o los que agregó el docente manualmente) ven todo — backward compat.
    if (!isOwner) {
      // Dos condiciones independientes, las dos con `$or` adentro: si se asignaran las dos a
      // query.$or la segunda pisaría a la primera en silencio (y el alumno vería las
      // programadas). Por eso van anidadas en un $and.
      const condiciones = [filtroVisibleParaAlumno(new Date())];
      const joinedAt = course.enrollmentDates?.get?.(userId);
      if (joinedAt) {
        condiciones.push({ $or: [
          { dueDate: null },
          { dueDate: { $gte: joinedAt } },
          { allowLateSubmissions: true },
        ] });
      }
      query.$and = condiciones;
    }

    const activities = await Activity.find(query)
      .populate('author', 'name')
      .sort({ createdAt: -1 }); // Más recientes primero

    let result;
    if (isOwner) {
      // Para el docente: conteo de entregas (chip "X/Y entregaron") y de aperturas
      // (chip "X/Y vieron"). Los dos aggregates son independientes → van en paralelo.
      const actIds = activities.map(a => a._id);
      const [counts, viewCounts] = await Promise.all([
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
      ]);
      const countMap     = {};
      counts.forEach(c => { countMap[c._id.toString()] = c.count; });
      const viewMap      = {};
      viewCounts.forEach(c => { viewMap[c._id.toString()] = c.count; });
      const totalStudents = course.students.length;

      result = activities.map(act => {
        const obj          = act.toObject();
        obj.submittedCount = countMap[obj._id.toString()] || 0;
        obj.viewedCount    = viewMap[obj._id.toString()]  || 0;
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
      }).select('activity firstSubmittedAt createdAt');
      const entregaPorActividad = {};
      misEntregas.forEach(s => {
        entregaPorActividad[s.activity.toString()] = s.firstSubmittedAt || s.createdAt;
      });

      result = activities.map(act => {
        const obj = act.toObject();
        // Para el alumno: extrae solo su propia calificación del array grades y borra el resto
        const myGrade = act.grades.find(g => g.student.toString() === userId);
        // points puede venir null: es una devolución escrita sin nota. El front la muestra
        // como "Con devolución" (no como calificada) — ver renderStudentActivity en course.js.
        obj.myGrade = myGrade ? { points: myGrade.points ?? null, feedback: myGrade.feedback || '' } : null;
        // Su propia entrega: { at } o null. Nunca los archivos ni el texto — para eso está
        // GET /activities/:id/my-submission, que es lo que abre el modal de detalle.
        const entregadaEl = entregaPorActividad[obj._id.toString()];
        obj.mySubmission = entregadaEl ? { at: entregadaEl } : null;
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
      allowResubmission: !!allowResubmission,
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
    cb(null, EXT_ALLOWED.includes(path.extname(file.originalname).toLowerCase()));
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
    // Traemos también enrollmentDates para poder aplicar por curso el mismo filtro de
    // "no mostrar actividades vencidas antes de la inscripción del alumno" que usamos en
    // GET /activities/course/:id. Sin este filtro acá, "Mis pendientes" mostraría tareas
    // que no le figuran al alumno cuando entra al curso — inconsistencia visible al usuario.
    const joinedCourses = await Course.find({ students: user._id }).select('name _id enrollmentDates');
    const courseIds = joinedCourses.map(c => c._id);
    const userIdStr = user._id.toString();
    const joinedAtByCourse = {};
    joinedCourses.forEach(c => {
      const dt = c.enrollmentDates?.get?.(userIdStr);
      if (dt) joinedAtByCourse[c._id.toString()] = dt;
    });

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

    // Filtra las que están realmente pendientes (sin entrega y plazo aún abierto)
    // + oculta las vencidas ANTES de la inscripción del alumno (misma regla que /course/:id)
    const pending = activities.filter(a => {
      if (submittedSet.has(a._id.toString())) return false;
      // Regla de inscripción: solo aplica si el alumno tiene joinedAt registrado para ese curso
      const joinedAt = joinedAtByCourse[a.course._id.toString()];
      if (joinedAt && a.dueDate && new Date(a.dueDate) < joinedAt && !a.allowLateSubmissions) {
        return false;
      }
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
      gradeMap[g.student.toString()] = { points: g.points, feedback: g.feedback || '' };
    });

    // Para cada alumno inscripto: su nota y feedback, o null si no fue calificado todavía
    const studentGrades = course.students.map(s => ({
      _id:      s._id,
      name:     s.name,
      email:    s.email,
      points:   gradeMap[s._id.toString()]?.points ?? null,
      feedback: gradeMap[s._id.toString()]?.feedback || '',
    }));

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
router.post('/:id/grade', requireAuth, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const { studentId, points, feedback } = req.body;
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
      nota = Number(points);
      if (!Number.isFinite(nota) || nota < 0) {
        return res.status(400).json({ error: 'La nota tiene que ser un número mayor o igual a 0' });
      }
      if (activity.points != null && nota > activity.points) {
        return res.status(400).json({ error: `La nota no puede superar el máximo de la actividad (${activity.points})` });
      }
    }

    const existing = activity.grades.find(g => g.student.toString() === studentId);
    if (existing) {
      if (mandaNota) existing.points = nota;
      existing.gradedAt = new Date();
      existing.manual   = true; // el docente sobrescribe → protege contra re-autocalificación
      if (feedback !== undefined) existing.feedback = feedback.trim();
    } else {
      activity.grades.push({
        student:  studentId,
        points:   mandaNota ? nota : null, // null = devolución sin nota
        feedback: (feedback || '').trim(),
        manual:   true,
      });
    }

    await activity.save();

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
      },
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
    const submissions = await Submission.find({ activity: req.params.id });
    submissions.forEach(sub => {
      sub.files.forEach(f => {
        const fp = path.join(ENTREGAS_BASE, f.storagePath);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      });
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
    activity.allowResubmission = !!allowResubmission;
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

// GET /activities/submission-file/:filename
// Descarga protegida de archivos de entrega: solo el alumno que entregó o el docente del curso
// Verifica propiedad buscando el Submission por filename, luego chequea si es el alumno o el docente
router.get('/submission-file/:filename', requireAuth, async (req, res) => {
  try {
    const { filename } = req.params;
    const userId = res.locals.user._id.toString();

    // Busca la entrega que contiene este archivo (por el filename único)
    const submission = await Submission.findOne({ 'files.filename': filename }).populate('activity');
    if (!submission) return res.status(404).send('Archivo no encontrado');

    const isStudent = submission.student.toString() === userId;
    if (!isStudent) {
      // Si no es el alumno, verifica que sea docente del curso (o admin de la escuela)
      const course = await Course.findById(submission.activity.course);
      if (!course || !course.canManage(res.locals.user)) return res.status(403).send('Acceso denegado');
    }

    const file     = submission.files.find(f => f.filename === filename);
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

// Guard del alumno que va a entregar: existe la actividad, está inscripto, el plazo sigue
// abierto y no tiene una entrega cerrada. Es exactamente lo que ya chequeaba a mano
// /upload-submission-file, pero acá va ANTES de multer y esa es toda la gracia: multer recibe
// el cuerpo ENTERO antes de que el handler corra, así que con el chequeo tardío alguien que
// no puede entregar igual alcanza a empujar 20 MB. Misma regla que `exigirGestorDelCurso`.
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
    if (activity.dueDate && new Date(activity.dueDate) < new Date() && !activity.allowLateSubmissions) {
      return res.status(403).json({ error: 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.' });
    }
    const yaEntregada = await Submission.findOne({ activity: req.params.id, student: userId });
    if (yaEntregada && !activity.allowResubmission) {
      return res.status(403).json({ error: 'Esta actividad no permite modificar la entrega una vez enviada.' });
    }
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
router.post('/:id/upload-submission-file', requireAuth, (req, res, next) => {
  // La guarda va ANTES de multer a propósito: si el id no puede existir, no tiene sentido
  // escribir el archivo en disco para después contestar 404 y dejarlo huérfano.
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  next();
}, uploadLimiter, (req, res, next) => {
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

    const activity = await Activity.findById(req.params.id);
    if (!activity) { fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Actividad no encontrada' }); }

    const course = await Course.findById(activity.course);
    const userId = res.locals.user._id.toString();

    // Solo alumnos inscriptos: mismo chequeo que /submit
    if (!course.students.map(s => s.toString()).includes(userId)) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'No estás inscripto en este curso' });
    }
    // Bloquea si el plazo venció y no hay entregas tardías habilitadas
    if (activity.dueDate && new Date(activity.dueDate) < new Date() && !activity.allowLateSubmissions) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.' });
    }
    // Bloquea si ya entregó antes y el docente no habilitó la edición
    const existingSub = await Submission.findOne({ activity: req.params.id, student: userId });
    if (existingSub && !activity.allowResubmission) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'Esta actividad no permite modificar la entrega una vez enviada.' });
    }

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

router.post('/:id/submit', requireAuth, uploadLimiter, conditionalMultipart, async (req, res) => {
  if (idMalo(req, res, 'Actividad no encontrada')) return;
  try {
    const activity = await Activity.findById(req.params.id);
    if (!activity) return res.status(404).json({ error: 'Actividad no encontrada' });

    const course = await Course.findById(activity.course);
    const userId = res.locals.user._id.toString();

    // Solo alumnos inscriptos en el curso pueden entregar
    if (!course.students.map(s => s.toString()).includes(userId)) {
      return res.status(403).json({ error: 'No estás inscripto en este curso' });
    }

    // Bloquea la entrega a una actividad que el alumno no debería estar viendo (programada
    // para más adelante, u ocultada con el ojo). Por la interfaz no llega —el listado se las
    // filtra—, pero sí por un link directo guardado de antes de que la bajaran.
    if (!esVisibleParaAlumno(activity, new Date())) {
      return res.status(403).json({ error: 'Esta actividad todavía no está disponible.' });
    }

    // Bloquea si el plazo venció y el docente no habilitó entregas tardías
    if (activity.dueDate && new Date(activity.dueDate) < new Date() && !activity.allowLateSubmissions) {
      return res.status(403).json({ error: 'El plazo de entrega ha vencido. El docente debe habilitar las entregas tardías.' });
    }

    // Si ya entregó antes y el docente no habilitó la edición, la entrega queda fija:
    // el alumno solo puede visualizarla, no reenviarla.
    const existing = await Submission.findOne({ activity: req.params.id, student: userId });
    if (existing && !activity.allowResubmission) {
      return res.status(403).json({ error: 'Esta actividad no permite modificar la entrega una vez enviada.' });
    }

    const schoolId = res.locals.user.school?.toString() || 'general';
    const { text } = req.body;

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

    let filesToSave;
    if (newFiles.length > 0) {
      // Con nuevos archivos: borra los anteriores del disco antes de guardar los nuevos
      if (existing) {
        existing.files.forEach(f => {
          const fp = path.join(ENTREGAS_BASE, f.storagePath);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        });
      }
      filesToSave = newFiles;
    } else {
      // Sin nuevos archivos: mantiene los archivos anteriores (solo cambia el texto)
      filesToSave = existing?.files || [];
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
      $set: { files: filesToSave, text: text?.trim() || '' },
      $setOnInsert: { firstSubmittedAt: new Date() },
    };
    if (answersToSave) submissionUpdate.$set.answers = answersToSave;
    if (autoGraded)    submissionUpdate.$set.autoGraded = autoGraded;

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
        if (gExisting) {
          gExisting.points   = autoGraded.points;
          gExisting.feedback = 'Autocalificado';
          gExisting.gradedAt = autoGraded.gradedAt;
          gExisting.manual   = false;
        } else {
          activity.grades.push({
            student:  userId,
            points:   autoGraded.points,
            feedback: 'Autocalificado',
            gradedAt: autoGraded.gradedAt,
            manual:   false,
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
    res.json({ submission: submission || null });
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

    res.json({ submissions });
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
