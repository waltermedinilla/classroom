// Catálogo de escenarios end-to-end, ordenados: cada spec puede depender del `state`
// que dejaron los anteriores (curso creado, código, ids). Pensado para correr contra
// el server local + Mongo local (ver run.js, que bloquea correr contra un host remoto).
//
// Los specs marcados con requiresEnv se saltean (no fallan) si esas variables no están
// seteadas — así el Nivel 1 (registro/login) corre siempre, y el Nivel 2 (curso completo,
// actividades, entregas, sugerencias) solo corre si hay credenciales de un admin de escuela.
//
// Esta misma lista de escenarios (qué debe funcionar, por rol) es la que después se
// reimplementa con Playwright para verificar además la UI real (ver README.md).

const RUN_ID = Date.now().toString(36);

const teacher = {
  name:     'Smoke Teacher',
  email:    `smoke.teacher.${RUN_ID}@example.com`,
  password: 'SmokeTest1234',
};
const student = {
  name:     'Smoke Student',
  email:    `smoke.student.${RUN_ID}@example.com`,
  password: 'SmokeTest1234',
};

const specs = [
  // ── Nivel 1: sin credenciales — server, registro, login ──────────────────
  {
    id: 'server-up',
    title: 'El servidor responde y sirve /login',
    async run({ client }) {
      await client.get(null, '/login', { expectStatus: 200 });
    },
  },
  {
    id: 'register-teacher',
    title: 'Un docente puede autoregistrarse',
    async run({ client, state }) {
      const res = await client.post('teacher', '/register', {
        body: { name: teacher.name, email: teacher.email, password: teacher.password, role: 'teacher' },
        expectStatus: 201,
      });
      state.teacherId = res.json.user._id;
    },
  },
  {
    id: 'register-student',
    title: 'Un alumno puede autoregistrarse',
    async run({ client, state }) {
      const res = await client.post('student', '/register', {
        body: { name: student.name, email: student.email, password: student.password, role: 'student' },
        expectStatus: 201,
      });
      state.studentId = res.json.user._id;
    },
  },
  {
    id: 'login-wrong-password',
    title: 'Login con contraseña incorrecta es rechazado (400)',
    async run({ client }) {
      await client.post(null, '/login', {
        body: { email: teacher.email, password: 'contraseña-incorrecta' },
        expectStatus: 400,
      });
    },
  },

  // ── Nivel 2: requiere un admin de escuela (SMOKE_ADMIN_EMAIL/PASSWORD) ───
  // El admin recién creado por /register no tiene escuela asignada (por diseño: solo
  // las invitaciones o el panel admin asignan escuela), así que el curso completo
  // (crear materia, unirse, actividades) necesita un admin real para dar de alta a los
  // usuarios de prueba YA con escuela. Ver tests/smoke/README.md para setear las env vars.
  {
    id: 'admin-login',
    title: 'El admin de escuela puede iniciar sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, env }) {
      await client.post('admin', '/login', {
        body: { email: env.SMOKE_ADMIN_EMAIL, password: env.SMOKE_ADMIN_PASSWORD },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'admin-create-division',
    title: 'El admin crea una división de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-${RUN_ID}` },
        expectStatus: 201,
      });
      state.divisionId = res.json.division._id;
    },
  },
  {
    id: 'admin-create-scoped-teacher',
    title: 'El admin da de alta un docente de prueba en su escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: teacher.name, email: `scoped.${teacher.email}`, password: teacher.password, role: 'teacher' },
        expectStatus: 201,
      });
      state.scopedTeacherId    = res.json.user._id;
      state.scopedTeacherEmail = `scoped.${teacher.email}`;
    },
  },
  {
    id: 'admin-create-scoped-student',
    title: 'El admin da de alta un alumno de prueba en su escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: student.name, email: `scoped.${student.email}`, password: student.password, role: 'student' },
        expectStatus: 201,
      });
      state.scopedStudentId    = res.json.user._id;
      state.scopedStudentEmail = `scoped.${student.email}`;
    },
  },
  {
    id: 'scoped-teacher-login',
    title: 'El docente de la escuela inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedTeacher', '/login', {
        body: { email: state.scopedTeacherEmail, password: teacher.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'scoped-student-login',
    title: 'El alumno de la escuela inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: student.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'course-create',
    title: 'El docente crea un curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('scopedTeacher', '/courses/create', {
        body: { name: `Materia Smoke ${RUN_ID}`, divisionId: state.divisionId, room: '101' },
        expectStatus: 201,
      });
      assert(res.json.course?.code?.length === 6, 'el curso debería tener un código de 6 caracteres');
      state.courseId   = res.json.course._id;
      state.courseCode = res.json.course.code;
    },
  },
  {
    id: 'course-join',
    title: 'El alumno se une al curso con el código',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedStudent', '/courses/join', {
        body: { code: state.courseCode },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'announcement-create',
    title: 'El docente publica una novedad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('scopedTeacher', '/announcements/create', {
        body: { courseId: state.courseId, text: 'Novedad de smoke test' },
        expectStatus: 201,
      });
      state.announcementId = res.json.announcement._id;
    },
  },
  {
    id: 'announcement-comment',
    title: 'El alumno comenta la novedad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedStudent', `/announcements/${state.announcementId}/comment`, {
        body: { text: 'Comentario de smoke test' },
        expectStatus: 201,
      });
    },
  },
  {
    id: 'activity-create',
    title: 'El docente crea una actividad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: 'Actividad de smoke test', type: 'tarea', points: '10' },
        expectStatus: 201,
      });
      state.activityId = res.json.activity._id;
    },
  },
  {
    id: 'activity-visible-to-student',
    title: 'El alumno ve la actividad publicada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const found = res.json.activities.some(a => a._id === state.activityId);
      assert(found, 'la actividad recién creada debería aparecer para el alumno');
    },
  },
  {
    id: 'activity-submit',
    title: 'El alumno entrega la actividad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
        body: { text: 'Mi entrega de smoke test' },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'submission-preupload-rejects-bad-ext',
    title: 'La pre-subida de entrega rechaza extensiones no permitidas (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const fd = new FormData();
      fd.append('file', new Blob(['contenido'], { type: 'video/mp4' }), 'malicioso.mp4');
      await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-file`, {
        form: fd, expectStatus: 400,
      });
    },
  },
  {
    id: 'submission-preupload-and-submit-json',
    title: 'El alumno pre-sube un archivo real y envía la entrega con JSON (flujo nuevo, opción A)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // 1. Pre-sube un PDF simulado
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4 smoke test'], { type: 'application/pdf' }), 'entrega-smoke.pdf');
      const upload = await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-file`, {
        form: fd, expectStatus: 200,
      });
      assert(upload.json.storagePath && upload.json.filename, 'la pre-subida debería devolver storagePath y filename');
      state.preUploadedFile = upload.json;

      // 2. Envía la entrega referenciando el archivo pre-subido (JSON, no multipart)
      const submit = await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
        body: { text: 'Mi entrega con flujo nuevo', uploadedFiles: [upload.json] },
        expectStatus: 200,
      });
      assert(submit.json.submission.files.length === 1, 'la entrega debería tener 1 archivo');
      assert(submit.json.submission.files[0].filename === upload.json.filename, 'el filename debería coincidir');
    },
  },
  {
    id: 'submission-preupload-rejects-cross-user-path',
    title: 'La entrega ignora archivos cuyo storagePath no pertenece al alumno (defensa en profundidad)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Intenta enviar una entrega referenciando un storagePath ajeno (otro userId)
      const submit = await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
        body: {
          text: 'Intento de hijack',
          uploadedFiles: [{
            storagePath: 'evil-school/evil-act/evil-user/hack.pdf',
            name: 'hack.pdf', filename: 'hack.pdf', mime: 'application/pdf', size: 100,
          }],
        },
        expectStatus: 200,
      });
      // El server debe filtrarlo silenciosamente: la entrega queda sin ese archivo
      const hasEvil = submit.json.submission.files.some(f => f.filename === 'hack.pdf');
      assert(!hasEvil, 'no debería haberse aceptado un archivo con storagePath ajeno');
    },
  },
  {
    id: 'activity-grade',
    title: 'El docente ve la entrega y la califica',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const subs = await client.get('scopedTeacher', `/activities/${state.activityId}/submissions`, { expectStatus: 200 });
      assert(subs.json.submissions.length === 1, 'debería haber exactamente 1 entrega');
      await client.post('scopedTeacher', `/activities/${state.activityId}/grade`, {
        body: { studentId: state.scopedStudentId, points: '9', feedback: 'Bien' },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'gradebook-reflects-grade',
    title: 'La nota aparece en el libro de calificaciones del curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedTeacher', `/courses/${state.courseId}/gradebook`, { expectStatus: 200 });
      const points = res.json.gradeMap[state.activityId]?.[state.scopedStudentId];
      assert(points === 9, `esperaba nota 9 en el gradebook, encontré ${points}`);
    },
  },

  // ── Regresión: sugerencias abiertas a docente/alumno (arreglo de esta sesión) ──
  {
    id: 'suggestions-teacher-sees-fab',
    title: 'El docente ve el botón de sugerencias en el dashboard',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('scopedTeacher', '/courses', { expectStatus: 200 });
      assert(res.text.includes('fabSuggest'), 'el FAB de sugerencias debería estar en el HTML');
    },
  },
  {
    id: 'suggestions-teacher-can-submit',
    title: 'El docente puede enviar una sugerencia (antes daba 403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('scopedTeacher', '/suggestions', {
        body: { text: `Smoke test — sugerencia de docente ${RUN_ID}` },
        expectStatus: 201,
      });
      state.teacherSuggestionText = `Smoke test — sugerencia de docente ${RUN_ID}`;
    },
  },
  {
    id: 'suggestions-student-can-submit',
    title: 'El alumno puede enviar una sugerencia (antes daba 403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedStudent', '/suggestions', {
        body: { text: `Smoke test — sugerencia de alumno ${RUN_ID}` },
        expectStatus: 201,
      });
      state.studentSuggestionText = `Smoke test — sugerencia de alumno ${RUN_ID}`;
    },
  },

  // ── Regresión: /courses/:id/customize rechaza al no-owner ANTES del multer ─
  // Antes del fix, un docente A podía golpear /courses/{ID_B}/customize y — por el
  // orden de middlewares — el multer borraba el header del curso B en su callback
  // filename() antes de que el handler validara ownership. Ahora el chequeo de owner
  // corre PRIMERO. Este spec no simula el ataque completo (no sube archivo real),
  // simplemente verifica que un usuario ajeno reciba 403 antes de que multer haga nada.
  {
    id: 'customize-rejects-non-owner',
    title: 'POST /courses/:id/customize rechaza a no-owner con 403 (antes del multer)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // scopedStudent NO es el owner del courseId — debería recibir 403 sin efecto colateral
      const fd = new FormData();
      fd.append('mode', 'gradient');
      fd.append('color', '#000000');
      const res = await client.post('scopedStudent', `/courses/${state.courseId}/customize`, {
        form: fd, expectStatus: 403,
      });
      assert(res.json?.error, 'debería devolver un JSON con error');
    },
  },

  // ── Regresión: invalidación de cache al deshabilitar un usuario ──────────
  {
    id: 'cache-invalidation-on-disable',
    title: 'Deshabilitar un alumno corta su sesión ya activa (no queda "vivo" en cache)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('admin', `/admin/users/${state.scopedStudentId}/toggle-active`, { expectStatus: 200 });
      // Misma cookie de antes: sin invalidación de cache seguiría "activa" hasta 5 min.
      const res = await client.get('scopedStudent', '/courses', { expectStatus: [302, 401, 403] });
      assert(res.status === 302, `esperaba redirect (302) al quedar deshabilitado, recibí ${res.status}`);
      // Re-habilita para dejar el usuario consistente antes del borrado en cleanup
      await client.post('admin', `/admin/users/${state.scopedStudentId}/toggle-active`, { expectStatus: 200 });
    },
  },

  // ── Panel Directivo (A1 + A2) ─────────────────────────────────────────────
  {
    id: 'directivo-create-user',
    title: 'El admin da de alta un directivo de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const email = `smoke.directivo.${state.courseId || Date.now()}@example.com`;
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'Smoke Directivo', email, password: 'SmokeTest1234', role: 'directivo' },
        expectStatus: 201,
      });
      state.directivoId    = res.json.user._id;
      state.directivoEmail = email;
    },
  },
  {
    id: 'directivo-login-and-dashboard',
    title: 'El directivo inicia sesión y ve su dashboard',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('directivo', '/login', {
        body: { email: state.directivoEmail, password: 'SmokeTest1234' },
        expectStatus: 200,
      });
      // "/" debe redirigir al directivo a /directivo (no a /courses)
      const rootRes = await client.get('directivo', '/', { expectStatus: 302 });
      assert(rootRes.headers.get('location') === '/directivo',
        `esperaba redirect a /directivo, recibí ${rootRes.headers.get('location')}`);

      const dashRes = await client.get('directivo', '/directivo', { expectStatus: 200 });
      assert(dashRes.text.includes('Panel Directivo'), 'la vista debería contener "Panel Directivo"');
    },
  },
  {
    id: 'directivo-sees-courses-with-metrics',
    title: 'El directivo ve el listado de materias con tasa de entrega',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('directivo', '/directivo/courses', { expectStatus: 200 });
      // El curso de smoke debería aparecer (con 1 alumno y 1 actividad y 1 entrega = 100%)
      assert(res.text.includes(`Materia Smoke`), 'el listado debería incluir el curso de smoke');
    },
  },
  {
    id: 'directivo-course-detail',
    title: 'El directivo puede abrir el detalle read-only de una materia',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('directivo', `/directivo/courses/${state.courseId}`, { expectStatus: 200 });
      assert(res.text.includes('Actividades') && res.text.includes('Alumnos'),
        'el detalle debería tener secciones de Actividades y Alumnos');
    },
  },
  {
    id: 'directivo-cannot-edit-course',
    title: 'El directivo NO puede borrar cursos (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Solo admins/superadmin pueden llegar a las rutas de mutación. Un directivo debe rebotar.
      await client.post('directivo', `/admin/courses/${state.courseId}/delete`, {
        expectStatus: [403, 302],
      });
    },
  },
  {
    id: 'directivo-grades',
    title: 'El directivo ve la vista de promedios (M1)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('directivo', '/directivo/grades', { expectStatus: 200 });
      assert(res.text.includes('Promedios') || res.text.includes('promedio'),
        'la vista debería mencionar "Promedios"');
    },
  },
  {
    id: 'directivo-students',
    title: 'El directivo ve el listado de alumnos con chips de filtro (M2)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('directivo', '/directivo/students', { expectStatus: 200 });
      assert(res.text.includes('Bajo rendimiento') && res.text.includes('Silencioso'),
        'la vista debería tener los chips de filtro Bajo rendimiento y Silencioso');
      // Y probar los filtros
      await client.get('directivo', '/directivo/students?estado=bajo',       { expectStatus: 200 });
      await client.get('directivo', '/directivo/students?estado=silencioso', { expectStatus: 200 });
      await client.get('directivo', '/directivo/students?estado=tardias',    { expectStatus: 200 });
    },
  },
  {
    id: 'directivo-student-detail',
    title: 'El directivo puede abrir el perfil read-only de un alumno (M4)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('directivo', `/directivo/students/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(res.text.includes('Historial de entregas'),
        'el perfil debería tener "Historial de entregas"');
    },
  },
  {
    id: 'directivo-teachers',
    title: 'El directivo ve el listado de docentes con métricas (M3)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('directivo', '/directivo/teachers', { expectStatus: 200 });
      assert(res.text.includes('Actividades últ. mes') || res.text.includes('Sin calificar'),
        'la vista debería incluir métricas de actividad docente');
    },
  },
  {
    id: 'directivo-teacher-detail',
    title: 'El directivo puede abrir el perfil read-only de un docente (M4)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('directivo', `/directivo/teachers/${state.scopedTeacherId}`, { expectStatus: 200 });
      assert(res.text.includes('Materias que dicta'),
        'el perfil debería tener "Materias que dicta"');
    },
  },
  {
    id: 'directivo-cleanup',
    title: 'Limpieza: el admin borra el directivo de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.directivoId) await client.post('admin', `/admin/users/${state.directivoId}/delete`, { expectStatus: 200 });
    },
  },

  // ── Nivel 3 (opcional): superadmin ────────────────────────────────────────
  {
    id: 'superadmin-login',
    title: 'El superadmin puede iniciar sesión',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, env }) {
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'superadmin-suggestions-paginated',
    title: 'El panel de sugerencias del superadmin pagina correctamente',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('superadmin', '/superadmin/suggestions?page=1', { expectStatus: 200 });
      await client.get('superadmin', '/superadmin/suggestions?page=999', { expectStatus: 200 });
    },
  },

  // ── Backup / Restore ──────────────────────────────────────────────────────
  // No hay spec de /restore acá a propósito: aunque restaurar el mismo backup recién
  // generado es seguro (se verificó manualmente — conteos y _id idénticos antes/después),
  // cada corrida generaría un backup de seguridad de ~20 MB en disco (backups/) sin
  // límite de retención. Se prueba manualmente antes de cada release, no en cada smoke run.
  {
    id: 'backup-access-denied-for-regular-admin',
    title: 'Un admin de escuela (no waltermedinilla) NO puede acceder al backup (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      // Cubre la capa requireSuperAdmin (rol). La capa extra de email específico
      // (requireBackupAccess) se verifica manualmente antes de cada release — crear un
      // superadmin de prueba desechable para este check no vale el riesgo de dejarlo
      // huérfano (no existe DELETE /superadmin/users/:id).
      await client.get('admin', '/superadmin/backup', { expectStatus: [403, 302] });
      await client.get('admin', '/superadmin/backup/download', { expectStatus: [403, 302] });
    },
  },
  {
    id: 'backup-stats',
    title: 'El endpoint de stats devuelve contadores de todas las colecciones',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/backup/stats', { expectStatus: 200 });
      const expected = ['schools', 'users', 'courses', 'activities', 'submissions', 'announcements', 'suggestions', 'divisions', 'subjects'];
      expected.forEach(name => assert(typeof res.json.collections[name] === 'number', `falta el contador de ${name}`));
      assert(typeof res.json.files.archivos.sizeBytes === 'number', 'falta el tamaño de archivos/');
    },
  },
  {
    id: 'backup-download-produces-valid-tarball',
    title: 'La descarga de backup genera un .tar.gz con Content-Disposition correcto',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/backup/download', { expectStatus: 200 });
      const disposition = res.headers.get('content-disposition') || '';
      assert(/classroom-backup-.*\.tar\.gz/.test(disposition), `Content-Disposition inesperado: ${disposition}`);
      assert(res.byteLength > 1000, `el archivo descargado parece demasiado chico (${res.byteLength} bytes)`);
    },
  },
  {
    id: 'backup-preview-rejects-invalid-file',
    title: 'El preview de restore rechaza un archivo que no es un backup válido (400)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client }) {
      const fd = new FormData();
      fd.append('file', new Blob(['esto no es un tar.gz'], { type: 'application/gzip' }), 'fake.tar.gz');
      await client.post('superadmin', '/superadmin/backup/preview', { form: fd, expectStatus: 400 });
    },
  },

  // ── Modo mantenimiento ────────────────────────────────────────────────────
  {
    id: 'maintenance-access-denied-for-regular-admin',
    title: 'Un admin de escuela NO puede activar/consultar mantenimiento (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('admin', '/superadmin/backup/maintenance-status', { expectStatus: 403 });
      await client.post('admin', '/superadmin/backup/maintenance/on', { body: {}, expectStatus: 403 });
    },
  },
  {
    id: 'maintenance-toggle-blocks-and-restores',
    title: 'Activar mantenimiento bloquea a otros usuarios; el dueño tiene bypass; desactivar restaura el acceso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // try/finally: SIEMPRE desactiva el mantenimiento al salir, incluso si un assert
      // falla a mitad de camino — sino los specs de limpieza que corren después (que usan
      // el actor 'admin') quedarían bloqueados por el 503 y el ambiente de test roto.
      try {
        await client.post('superadmin', '/superadmin/backup/maintenance/on', {
          body: { message: 'Smoke test de mantenimiento', eta: '1 minuto' },
          expectStatus: 200,
        });

        const blocked = await client.get('scopedTeacher', '/courses', { expectStatus: 503 });
        assert(blocked.text.includes('Estamos en mantenimiento'), 'debería mostrar la página de mantenimiento');

        const blockedJson = await client.get('admin', '/courses', {
          headers: { Accept: 'application/json' }, expectStatus: 503,
        });
        assert(blockedJson.json?.maintenance === true, 'la respuesta JSON debería indicar maintenance:true');

        // El dueño (mismo actor que activó) tiene bypass total — sigue viendo la app real
        await client.get('superadmin', '/courses', { expectStatus: 200 });
      } finally {
        await client.post('superadmin', '/superadmin/backup/maintenance/off', { body: {} });
      }

      // Fuera del finally: confirma que el acceso normal quedó restablecido
      await client.get('scopedTeacher', '/courses', { expectStatus: 200 });
    },
  },

  // ── Limpieza (Nivel 2): borra todo lo que creó esta corrida ───────────────
  {
    id: 'cleanup-course',
    title: 'Limpieza: el admin borra el curso de prueba (cascada)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (!state.courseId) return;
      await client.post('admin', `/admin/courses/${state.courseId}/delete`, { expectStatus: 200 });
    },
  },
  {
    id: 'cleanup-users-and-division',
    title: 'Limpieza: el admin borra los usuarios y la división de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.scopedTeacherId) await client.post('admin', `/admin/users/${state.scopedTeacherId}/delete`, { expectStatus: 200 });
      if (state.scopedStudentId) await client.post('admin', `/admin/users/${state.scopedStudentId}/delete`, { expectStatus: 200 });
      if (state.divisionId)      await client.post('admin', `/admin/divisions/${state.divisionId}/delete`, { expectStatus: 200 });
    },
  },
  {
    // El panel de sugerencias no tiene un GET en JSON (solo HTML), así que para no
    // depender de scrapear el HTML, la limpieza de las sugerencias de prueba se hace
    // directo contra Mongo, filtrando por el RUN_ID único de esta corrida.
    id: 'cleanup-suggestions-db',
    title: 'Limpieza: borra las sugerencias de smoke test de la base',
    requiresEnv: ['MONGODB_URI'],
    async run({ env }) {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        await client.db().collection('suggestions').deleteMany({ text: { $regex: RUN_ID } });
      } finally {
        await client.close();
      }
    },
  },
];

module.exports = { specs, RUN_ID };
