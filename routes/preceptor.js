// Panel de preceptoría — /preceptor
//
// El preceptor trabaja sobre las divisiones que tiene a cargo ("cursos" en el lenguaje de
// la escuela: 1°1°, 2°3°…). Puede ver sus materias con los docentes que las dictan, la
// nómina de alumnos con su rendimiento, y administrar a esos alumnos: darlos de alta,
// editar sus datos y deshabilitar cuentas.
//
// Lo que NO puede hacer, por diseño: tocar materias, docentes o cualquier usuario que no
// sea alumno de sus divisiones; borrar alumnos definitivamente; resetear contraseñas.
//
// TODA ruta con un :id valida contra el alcance resuelto en middleware/preceptor.js. La
// regla es que el alcance se chequea en el servidor en cada request: ocultar un curso de
// la grilla no impide que alguien escriba el id en la URL.

const express  = require('express');
const mongoose = require('mongoose');
const User     = require('../models/User');
const Course   = require('../models/Course');
const Division = require('../models/Division');
const Activity   = require('../models/Activity');
const Submission = require('../models/Submission');
const { requireAuth } = require('../middleware/auth');
const { requirePreceptor, loadPreceptorScope, inScope } = require('../middleware/preceptor');
// Permisos por solapa configurados en /superadmin/roles (ver middleware/sections.js).
const { sectionGuard } = require('../middleware/sections');
const { getDivisionDetail } = require('../services/divisionDetail');
const {
  enrollStudentInDivisionCourses, unenrollStudentFromDivision, contarEntregasEnDivision,
} = require('../services/enrollment');
const { normalizeDni } = require('../services/dni');
const { logAudit } = require('../middleware/audit');
const { invalidateUser } = require('../middleware/cache');

const router = express.Router();
// sectionGuard va ANTES de loadPreceptorScope para no pagar la query de divisiones en un
// request que va a terminar en 403. Hoy es un no-op (preceptor_dashboard está locked en
// config/sections.js): va por simetría con los otros paneles.
router.use(requireAuth, requirePreceptor, sectionGuard('preceptor'), loadPreceptorScope);

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// ¿Este alumno pertenece a alguna materia de alguna división del alcance?
//
// Es la guarda de las tres rutas /students/:id. Sin ella alcanzaría con conocer el _id de
// cualquier alumno de la escuela para editarlo: el chequeo de escuela solo, que es lo que
// hacen las rutas del directivo (que es read-only), acá no basta porque hay escritura.
async function alumnoEnAlcance(studentId, scopeDivisionIds) {
  if (!scopeDivisionIds.length) return false;
  const count = await Course.countDocuments({
    division: { $in: scopeDivisionIds.map(oid) },
    students: studentId,
  });
  return count > 0;
}

/* ─── Inicio · grilla de cursos a cargo ──────────────────────────────────── */
// Una tarjeta por división del alcance, con sus contadores. Los alumnos se cuentan ÚNICOS
// por división (un alumno cursa varias materias del mismo año, sumar students.length de
// cada materia lo contaría repetido) — de ahí el $setUnion sobre el $reduce que aplana.
router.get('/', async (req, res) => {
  if (!res.locals.user.school) return res.render('preceptor/no-scope', { motivo: 'sin-escuela' });
  if (!req.scopeDivisionIds.length) return res.render('preceptor/no-scope', { motivo: 'sin-cursos' });

  try {
    const divisiones = await Division.aggregate([
      { $match: { _id: { $in: req.scopeDivisionIds.map(oid) } } },
      { $lookup: { from: 'courses', localField: '_id', foreignField: 'division', as: 'cursos' } },
      { $project: {
          name: 1,
          materias: { $size: '$cursos' },
          alumnos: { $size: { $setUnion: [{ $reduce: {
              input: '$cursos.students', initialValue: [],
              in: { $concatArrays: ['$$value', '$$this'] },
          } }, []] } },
          docentes: { $size: { $setUnion: ['$cursos.owner', []] } },
      } },
      { $sort: { name: 1 } },
    ]);

    res.render('preceptor/dashboard', {
      divisions: divisiones,
      totals: {
        cursos:  divisiones.length,
        alumnos: divisiones.reduce((a, d) => a + d.alumnos, 0),
      },
      activePage: 'dashboard',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Detalle de un curso ────────────────────────────────────────────────── */
// Lo que pidió el usuario al hacer click en la tarjeta: materias con sus docentes, y la
// nómina de alumnos. Reusa el mismo servicio que el panel del directivo para que ambos
// paneles no puedan divergir en los números.
router.get('/divisions/:id', async (req, res) => {
  if (!inScope(req, req.params.id)) return res.status(403).send('Acceso denegado');

  try {
    const detalle = await getDivisionDetail(req.params.id);
    if (!detalle) return res.status(404).send('Curso no encontrado');

    res.render('preceptor/division-detail', {
      division: detalle.division,
      courses:  detalle.courses,
      students: detalle.students,
      stats:    detalle.stats,
      activePage: 'dashboard',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Alta de alumno en un curso ─────────────────────────────────────────── */
// Mismo comportamiento que el alta del admin (services/enrollment.js): crea la cuenta y
// la inscribe en TODAS las materias de la división, con enrollmentDates = ahora para que
// no le figuren las tareas que ya vencieron.
//
// El caso "el DNI ya existe" está contemplado igual que en /admin/users/create: el índice
// único {school, dni} solo permite una cuenta por DNI, así que si la persona ya está en el
// sistema no se crea otra — se le completa la matrícula en las materias que le falten.
router.post('/divisions/:id/students', async (req, res) => {
  if (!inScope(req, req.params.id)) return res.status(403).json({ error: 'Acceso denegado' });

  try {
    const { name, email, password, dni } = req.body;
    const school = res.locals.user.school;

    if (!name || !name.trim())  return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'El correo es obligatorio' });
    if (!password || password.length < 5) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 5 caracteres' });
    }
    const { value: trimmedDni, error: dniError } = normalizeDni(dni);
    if (dniError) return res.status(400).json({ error: dniError });

    const existing = await User.findOne({ school, dni: trimmedDni });
    if (existing) {
      // Ya existe con otro rol: no es un alumno al que le falte matrícula, es un choque
      // real de identidad. El preceptor no puede resolverlo — lo derivamos a un admin.
      if (existing.role !== 'student') {
        return res.status(409).json({
          error: `Este DNI ya pertenece a ${existing.name}, que no es alumno. Pedile a un administrador que lo revise.`,
        });
      }
      const enrolledIn = await enrollStudentInDivisionCourses(
        req, existing, req.params.id, school, 'alta-alumno-preceptor-dni-existente');
      return res.status(200).json({ user: existing, enrolledIn, existedAlready: true });
    }

    // El rol va fijo: un preceptor da de alta alumnos, nunca otro tipo de cuenta.
    const user = await User.create({
      name: name.trim(), email: email.trim(), password,
      role: 'student', school, dni: trimmedDni,
    });

    logAudit(req, 'user.create',
      [{ type: 'user', id: user._id, name: user.name }],
      { rol: 'student', email: user.email, via: 'preceptor' },
    );

    const enrolledIn = await enrollStudentInDivisionCourses(
      req, user, req.params.id, school, 'alta-alumno-preceptor');

    res.status(201).json({ user, enrolledIn, existedAlready: false });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'El correo ya está registrado' });
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Perfil de un alumno ────────────────────────────────────────────────── */
// Datos editables + rendimiento. Las materias y entregas que se muestran son SOLO las de
// las divisiones a cargo: si el alumno además cursa algo fuera del alcance del preceptor
// (repitentes, materias de otro año), eso no es asunto suyo y no aparece.
router.get('/students/:id', async (req, res) => {
  try {
    const student = await User.findById(req.params.id)
      .select('_id name email dni active role school phone createdAt');
    if (!student) return res.status(404).send('Alumno no encontrado');
    if (student.role !== 'student') return res.status(404).send('El usuario no es alumno');
    if (!await alumnoEnAlcance(student._id, req.scopeDivisionIds)) {
      return res.status(403).send('Acceso denegado');
    }

    const courses = await Course.find({
      students: student._id,
      division: { $in: req.scopeDivisionIds.map(oid) },
    })
      .populate('owner', 'name')
      .populate('division', 'name')
      .select('_id name owner division');

    const courseIds = courses.map(c => c._id);
    const activities = await Activity.find({ course: { $in: courseIds } })
      .populate('course', 'name')
      .select('_id title course dueDate points grades')
      .sort({ createdAt: -1 });

    const submissions = await Submission.find({
      student:  student._id,
      activity: { $in: activities.map(a => a._id) },
    }).select('activity createdAt updatedAt');
    const subByActivity = Object.fromEntries(submissions.map(s => [s.activity.toString(), s]));

    // Una fila por actividad de sus materias: entregó o no, tarde o no, y con qué nota.
    // Se compara updatedAt (último reenvío) contra dueDate — usar createdAt marcaría como
    // puntual a quien entregó a tiempo y después reenvió tarde.
    const entries = activities.map(act => {
      const sub = subByActivity[act._id.toString()];
      const g   = act.grades.find(x => x.student.toString() === student._id.toString());
      const normalized = g && act.points > 0
        ? Math.round(((g.points / act.points) * 10) * 10) / 10
        : null;
      return {
        activityTitle: act.title,
        courseName:    act.course?.name || '—',
        dueDate:       act.dueDate,
        submitted:     !!sub,
        submittedAt:   sub ? sub.createdAt : null,
        late:          !!(sub && act.dueDate && sub.updatedAt > act.dueDate),
        points:        g ? g.points : null,
        maxPoints:     act.points,
        normalized,
      };
    });

    const calificadas = entries.filter(e => e.normalized !== null);
    const avg = calificadas.length
      ? Math.round((calificadas.reduce((a, e) => a + e.normalized, 0) / calificadas.length) * 10) / 10
      : null;

    // ── Datos para el bloque de matriculación ────────────────────────────────
    // Las acciones (sacar del curso, mover) son por CURSO, no por materia suelta: el alumno
    // cursa el año completo. Por eso las materias se agrupan por división y cada grupo trae
    // su propio conteo de entregas, que es lo que habilita o bloquea el botón de sacar.
    const porDivision = new Map();
    for (const c of courses) {
      const key = c.division?._id?.toString();
      if (!key) continue;
      if (!porDivision.has(key)) {
        porDivision.set(key, { _id: key, name: c.division.name, materias: 0 });
      }
      porDivision.get(key).materias++;
    }

    const matriculacion = await Promise.all(
      [...porDivision.values()].map(async (d) => {
        const { entregas, materias } = await contarEntregasEnDivision(
          student._id, d._id, res.locals.user.school);
        // Cuántas materias tiene la división en total, para poder mostrar "3 de 9"
        const totalMaterias = await Course.countDocuments({ division: oid(d._id) });
        return {
          ...d,
          totalMaterias,
          entregas,
          materiasConEntrega: materias,
          // Con entregas no se puede sacar ni mover: se perdería de vista trabajo ya hecho.
          bloqueado: entregas > 0,
        };
      })
    );

    // Cursos del alcance a los que se lo puede mover: todos menos los que ya cursa.
    const yaCursa = new Set(porDivision.keys());
    const destinos = (await Division.find({ _id: { $in: req.scopeDivisionIds.map(oid) } })
      .sort({ name: 1 }).select('_id name').lean())
      .filter(d => !yaCursa.has(d._id.toString()))
      .map(d => ({ _id: d._id.toString(), name: d.name }));

    res.render('preceptor/student-detail', {
      student,
      courses: courses.map(c => ({
        _id: c._id, name: c.name,
        teacher:  c.owner?.name    || '—',
        division: c.division?.name || '—',
      })),
      matriculacion,
      destinos,
      entries,
      stats: {
        totalActividades: entries.length,
        entregadas: entries.filter(e => e.submitted).length,
        tardias:    entries.filter(e => e.late).length,
        avg,
      },
      activePage: 'dashboard',
    });
  } catch (err) {
    res.status(500).send('Error del servidor');
  }
});

/* ─── Editar datos de un alumno ──────────────────────────────────────────── */
// Nombre, correo, DNI y teléfono. La contraseña NO se toca acá: resetearla quedó fuera del
// alcance del rol (decisión explícita del usuario) y sigue siendo cosa del admin.
router.post('/students/:id/edit', async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (student.role !== 'student') return res.status(403).json({ error: 'El usuario no es alumno' });
    if (!await alumnoEnAlcance(student._id, req.scopeDivisionIds)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { name, email, dni, phone } = req.body;
    if (!name || !name.trim())   return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'El correo es obligatorio' });
    // El DNI también es obligatorio al editar: es la vía por la que se completa el dato en
    // las cuentas viejas que se crearon sin él.
    const { value: nuevoDni, error: dniError } = normalizeDni(dni);
    if (dniError) return res.status(400).json({ error: dniError });

    const cambios = [];
    if (name.trim() !== student.name)                 cambios.push('nombre');
    if (email.trim().toLowerCase() !== student.email) cambios.push('correo');
    if (nuevoDni !== student.dni)                     cambios.push('DNI');
    if ((phone ? String(phone).trim() : null) !== student.phone) cambios.push('teléfono');

    student.name  = name.trim();
    student.email = email.trim();
    student.dni   = nuevoDni;
    student.phone = phone ? String(phone).trim() : null;
    await student.save({ validateModifiedOnly: true });

    // El doc vive cacheado 45s por worker: sin invalidar, el propio alumno seguiría viendo
    // sus datos viejos en el header hasta que expire el TTL.
    invalidateUser(student._id);

    if (cambios.length) {
      logAudit(req, 'user.edit',
        [{ type: 'user', id: student._id, name: student.name }],
        { campos: cambios.join(', '), via: 'preceptor' },
      );
    }

    res.json({ ok: true, user: student });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Ya existe otra cuenta con ese correo o DNI en la escuela' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: Object.values(err.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Sacar a un alumno de un curso ──────────────────────────────────────── */
// Lo desmatricula de TODAS las materias de esa división. No borra la cuenta ni sus datos:
// se lo puede volver a matricular después.
//
// Se BLOQUEA si ya entregó algo en ese curso (409), con el mismo criterio que rige para los
// docentes en `DELETE /courses/:id/students/:studentId`. Sacarlo escondería su trabajo y la
// corrección del docente sin dejar rastro de que existieron.
router.post('/students/:id/unenroll', async (req, res) => {
  try {
    const { divisionId } = req.body;
    if (!inScope(req, divisionId)) return res.status(403).json({ error: 'Ese curso no está a tu cargo' });

    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (student.role !== 'student') return res.status(403).json({ error: 'El usuario no es alumno' });
    if (!await alumnoEnAlcance(student._id, req.scopeDivisionIds)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const school = res.locals.user.school;
    const { entregas, materias } = await contarEntregasEnDivision(student._id, divisionId, school);
    if (entregas > 0) {
      return res.status(409).json({
        error: `No se puede sacar a ${student.name} de este curso: ya tiene ${entregas} entrega(s) ` +
               `en ${materias} materia(s). Si igual hay que moverlo, primero tiene que resolverlo un administrador.`,
      });
    }

    const removed = await unenrollStudentFromDivision(req, student, divisionId, school, 'preceptor-sacar-del-curso');
    if (!removed) return res.status(400).json({ error: 'El alumno no estaba matriculado en ese curso.' });

    res.json({
      ok: true, removed,
      mensaje: `${student.name} salió de ${removed} materia(s) del curso. La cuenta sigue activa.`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Mover a un alumno de un curso a otro ───────────────────────────────── */
// Lo saca de todas las materias del curso viejo y lo inscribe en todas las del nuevo.
// Ambos cursos tienen que estar a cargo del preceptor: mover a alguien a un curso que no
// administra sería sacárselo de encima hacia un lugar donde no puede seguirlo.
//
// Misma guarda de entregas que arriba, y por el mismo motivo: si ya entregó en el curso
// de origen, mudarlo dejaría ese trabajo colgado de una materia donde ya no figura.
router.post('/students/:id/move', async (req, res) => {
  try {
    const { fromDivisionId, toDivisionId } = req.body;
    if (!inScope(req, fromDivisionId)) return res.status(403).json({ error: 'El curso de origen no está a tu cargo' });
    if (!inScope(req, toDivisionId))   return res.status(403).json({ error: 'El curso de destino no está a tu cargo' });
    if (String(fromDivisionId) === String(toDivisionId)) {
      return res.status(400).json({ error: 'El curso de origen y el de destino son el mismo.' });
    }

    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (student.role !== 'student') return res.status(403).json({ error: 'El usuario no es alumno' });
    if (!await alumnoEnAlcance(student._id, req.scopeDivisionIds)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const school = res.locals.user.school;
    const { entregas, materias } = await contarEntregasEnDivision(student._id, fromDivisionId, school);
    if (entregas > 0) {
      return res.status(409).json({
        error: `No se puede mover a ${student.name}: ya tiene ${entregas} entrega(s) en ${materias} ` +
               'materia(s) del curso actual. Moverlo dejaría ese trabajo fuera de su legajo.',
      });
    }

    // El orden importa: primero sacar, después inscribir. Al revés, si las dos divisiones
    // compartieran alguna materia, el alta la sumaría y la baja la volvería a quitar.
    const removed  = await unenrollStudentFromDivision(req, student, fromDivisionId, school, 'preceptor-mover-origen');
    const enrolled = await enrollStudentInDivisionCourses(req, student, toDivisionId, school, 'preceptor-mover-destino');

    const destino = await Division.findById(toDivisionId).select('name').lean();
    res.json({
      ok: true, removed, enrolled,
      mensaje: `${student.name} pasó a ${destino?.name || 'el curso nuevo'}: ` +
               `salió de ${removed} materia(s) y quedó inscripto en ${enrolled}.`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/* ─── Habilitar / deshabilitar la cuenta de un alumno ────────────────────── */
// Baja LÓGICA: active:false impide iniciar sesión pero no borra nada (ver middleware/auth.js).
// El borrado definitivo no está disponible para este rol.
router.post('/students/:id/toggle-active', async (req, res) => {
  try {
    const student = await User.findById(req.params.id);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });
    if (student.role !== 'student') return res.status(403).json({ error: 'El usuario no es alumno' });
    if (!await alumnoEnAlcance(student._id, req.scopeDivisionIds)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    student.active = student.active === false;
    await student.save({ validateModifiedOnly: true });
    invalidateUser(student._id);

    logAudit(req, 'user.toggle_active',
      [{ type: 'user', id: student._id, name: student.name }],
      { estado: student.active ? 'habilitado' : 'deshabilitado', via: 'preceptor' },
    );

    res.json({ ok: true, active: student.active });
  } catch (err) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
