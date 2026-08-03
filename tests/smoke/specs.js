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

// sharp es dependencia de la app (la usa el optimizador de imágenes), así que usarla acá
// no agrega nada al proyecto. Sirve para FABRICAR las imágenes de prueba: los specs de
// optimización necesitan subir una foto grande de verdad, y commitear binarios de varios
// MB en el repo para eso sería absurdo.
const sharp = require('sharp');

const RUN_ID = Date.now().toString(36);

// DNI de prueba, único por corrida y por índice. El DNI pasó a ser OBLIGATORIO en toda
// alta de usuario el 2026-07-30 (ver services/dni.js), así que cada spec que crea una
// cuenta necesita uno propio: el índice {school, dni} es único, y dos specs con el mismo
// número se pisarían entre sí. Los 6 dígitos del reloj + 2 del índice dan los 8 que valida
// normalizeDni y hacen la colisión entre corridas prácticamente imposible.
const DNI_BASE = Date.now() % 1000000;
const dniSmoke = (n) => `${String(DNI_BASE).padStart(6, '0')}${String(n).padStart(2, '0')}`;

// Genera un JPEG que se comporta como una foto real frente al compresor (ruido de baja
// frecuencia escalado = gradientes con detalle). Un color plano se comprimiría a nada y
// los specs de "esto adelgazó mucho" pasarían por accidente.
async function fotoDePrueba(width, height) {
  const s = 32;
  const semilla = Buffer.alloc(s * s * 3);
  for (let i = 0; i < semilla.length; i++) semilla[i] = Math.floor(Math.random() * 256);
  return sharp(semilla, { raw: { width: s, height: s, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' })
    .jpeg({ quality: 95 })
    .toBuffer();
}

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
const coTeacher = {
  name:     'Smoke CoTeacher',
  email:    `smoke.coteacher.${RUN_ID}@example.com`,
  password: 'SmokeTest1234',
};
const preceptor = {
  name:     'Smoke Preceptor',
  email:    `smoke.preceptor.${RUN_ID}@example.com`,
  password: 'SmokeTest1234',
};
// Alumno dado de alta POR el preceptor (no por el admin), para verificar que su alta
// matricula igual que la del panel de administración.
const preceptorStudent = {
  name:     'Smoke Preceptor Student',
  email:    `smoke.preceptor.student.${RUN_ID}@example.com`,
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
    id: 'health-reports-loaded-version',
    title: '/health responde sin auth y reporta la versión que está cargada en memoria',
    async run({ client, assert }) {
      // Sin cookie de sesión: /health tiene que contestar igual (se lo consulta justamente
      // cuando algo anda mal). Va montado antes del rate limiter y del modo mantenimiento.
      const res = await client.get(null, '/health', { expectStatus: 200 });

      assert(res.json.status === 'ok', `status debería ser "ok", fue "${res.json.status}"`);
      assert(res.json.db === 'ok', `db debería ser "ok", fue "${res.json.db}"`);
      assert(typeof res.json.pid === 'number', 'debería reportar el pid del worker');

      // El chequeo que le da sentido al endpoint: la versión en MEMORIA tiene que coincidir
      // con la de package.json en DISCO. Si divergen, hubo un deploy que copió archivos pero
      // no recargó los workers — el bug del 2026-07-28. Ver el script de deploy en server.js.
      const onDisk = require('../../package.json').version;
      assert(
        res.json.version === onDisk,
        `versión en memoria (v${res.json.version}) != package.json en disco (v${onDisk}) — ` +
        'los workers están corriendo código viejo, hace falta un reload',
      );
    },
  },
  {
    id: 'register-teacher',
    title: 'Un docente puede autoregistrarse',
    async run({ client, state }) {
      const res = await client.post('teacher', '/register', {
        body: { name: teacher.name, email: teacher.email, password: teacher.password, role: 'teacher', dni: dniSmoke(1) },
        expectStatus: 201,
      });
      state.teacherId = res.json.user._id;
    },
  },
  {
    id: 'register-student',
    title: 'Un alumno se autoregistra eligiendo su curso y queda matriculado',
    async run({ client, state, assert }) {
      // Desde el 2026-07-31 el alumno elige Curso al registrarse (automatrícula temporal,
      // ver services/selfEnroll.js). El id se saca del formulario mismo, que es de donde
      // lo saca una persona: si el <select> deja de pintarse, el spec falla acá y no en
      // un 400 críptico del POST.
      const page   = await client.get(null, '/register', { expectStatus: 200 });
      const bloque = (page.text || '').split('id="divisionId"')[1] || '';
      const opcion = bloque.match(/<option value="([a-f0-9]{24})"/i);
      assert(opcion, 'el formulario de registro no ofrece ningún curso para elegir');
      state.selfEnrollDivisionId = opcion[1];

      const res = await client.post('student', '/register', {
        body: {
          name: student.name, email: student.email, password: student.password,
          role: 'student', dni: dniSmoke(2), divisionId: opcion[1],
        },
        expectStatus: 201,
      });
      state.studentId = res.json.user._id;
      assert(res.json.materias > 0,
        `debería haber quedado inscripto en las materias del curso, quedó en ${res.json.materias}`);
      assert(res.json.user.school,
        'elegir curso también tiene que asignarle la escuela; quedó sin escuela');
    },
  },
  {
    id: 'register-student-requires-curso',
    title: 'El alumno que no elige curso no se puede registrar (400)',
    async run({ client }) {
      // Es la razón de ser de la automatrícula: que no vuelvan a nacer cuentas de alumno
      // sin escuela y sin ninguna materia, que es lo que diagnostica /superadmin/otros.
      await client.post(null, '/register', {
        body: {
          name: 'Smoke Sin Curso', email: `sincurso.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'student', dni: dniSmoke(15),
        },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'self-enroll-only-once',
    title: 'El alumno ya matriculado no puede volver a elegir curso (409)',
    async run({ client, state }) {
      // "Una sola vez" no es un flag: la ruta mira si hoy está en alguna materia. El
      // alumno del spec anterior ya lo está, así que este pedido tiene que rebotar.
      await client.post('student', '/courses/self-enroll', {
        body: { divisionId: state.selfEnrollDivisionId },
        expectStatus: 409,
      });
    },
  },
  {
    id: 'profile-about-validation',
    title: 'El perfil personal guarda bien y rechaza intereses fuera de la lista',
    async run({ client, assert }) {
      const { INTEREST_IDS, MAX_INTERESTS } = require('../../config/interests');
      const valido = INTEREST_IDS[0];

      // Guardado normal
      const ok = await client.patch('student', '/courses/profile/about', {
        body: { bio: 'Hola, soy alumno de smoke test.', interests: [valido], futureGoal: 'Programación' },
        expectStatus: 200,
      });
      assert(ok.json.bio === 'Hola, soy alumno de smoke test.', 'debería guardar la presentación');
      assert(ok.json.interests.length === 1 && ok.json.interests[0] === valido,
        'debería guardar el interés válido');

      // Un id que no está en config/interests.js se descarta en silencio. Sin esta defensa,
      // un POST directo (salteando la UI) guardaría texto arbitrario que después se renderea
      // en el panel del directivo.
      const colado = await client.patch('student', '/courses/profile/about', {
        body: { bio: '', interests: [valido, 'no-existe-este-interes'], futureGoal: '' },
        expectStatus: 200,
      });
      assert(!colado.json.interests.includes('no-existe-este-interes'),
        'un interés fuera de la lista curada NO debería guardarse');
      assert(colado.json.interests.length === 1, 'el interés válido sí debería sobrevivir');

      // Tope de cantidad y de largo
      await client.patch('student', '/courses/profile/about', {
        body: { bio: '', interests: INTEREST_IDS.slice(0, MAX_INTERESTS + 1), futureGoal: '' },
        expectStatus: 400,
      });
      await client.patch('student', '/courses/profile/about', {
        body: { bio: 'a'.repeat(281), interests: [], futureGoal: '' },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'profile-prompt-lifecycle',
    title: 'El aviso de completar perfil aparece con el perfil vacío y desaparece al completarlo',
    async run({ client, assert }) {
      const { INTEREST_IDS } = require('../../config/interests');

      // El alumno recién registrado no tiene nada cargado → el aviso tiene que estar
      const vacio = await client.get('student', '/courses', { expectStatus: 200 });
      assert(vacio.text.includes('id="profileBand"'),
        'con el perfil vacío el dashboard debería incluir el aviso');

      // Al completar los tres campos, el servidor deja de mandarlo. Esto depende de que
      // PATCH /profile/about invalide el cache de usuario — si no lo hiciera, el aviso
      // seguiría apareciendo hasta que venciera el TTL.
      await client.patch('student', '/courses/profile/about', {
        body: { bio: 'Alumno de smoke.', interests: [INTEREST_IDS[0]], futureGoal: 'Algo' },
        expectStatus: 200,
      });
      const completo = await client.get('student', '/courses', { expectStatus: 200 });
      assert(!completo.text.includes('id="profileBand"'),
        'con el perfil completo el aviso NO debería aparecer');

      // Si se vacía un solo campo, vuelve
      await client.patch('student', '/courses/profile/about', {
        body: { bio: 'Alumno de smoke.', interests: [INTEREST_IDS[0]], futureGoal: '' },
        expectStatus: 200,
      });
      const parcial = await client.get('student', '/courses', { expectStatus: 200 });
      assert(parcial.text.includes('id="profileBand"'),
        'faltando un campo el aviso debería volver');
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
      state.divisionId   = res.json.division._id;
      // El nombre se guarda para poder BUSCAR la división en el panel directivo:
      // la escuela real tiene ~39 divisiones y los listados cortan en 25, así que
      // no alcanza con esperar que aparezca en la primera página.
      state.divisionName = res.json.division.name;
    },
  },
  {
    id: 'admin-create-scoped-teacher',
    title: 'El admin da de alta un docente de prueba en su escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: teacher.name, email: `scoped.${teacher.email}`, password: teacher.password, role: 'teacher', dni: dniSmoke(3) },
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
        body: { name: student.name, email: `scoped.${student.email}`, password: student.password, role: 'student', dni: dniSmoke(4) },
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
    id: 'course-add-student',
    title: 'El docente matricula al alumno en su curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Antes esto se hacía con `POST /courses/join` y el código de clase. Esa vía se
      // eliminó el 2026-07-30 (ver routes/courses.js): matricular es una acción
      // administrativa, y esta ruta es la que quedó para sumar a alguien a una materia
      // suelta. El resto de la cadena (entregas, calificación, gradebook) depende de que
      // el alumno quede inscripto acá.
      await client.post('scopedTeacher', `/courses/${state.courseId}/add-student`, {
        body: { email: state.scopedStudentEmail },
        expectStatus: 200,
      });
    },
  },
  {
    // ── Automatrícula desde el panel del alumno (TEMPORAL, ver services/selfEnroll.js) ──
    // Cubre al alumno que YA tenía cuenta cuando se agregó la función: el admin lo dio de
    // alta sin Curso, así que entra y no ve ninguna materia. Es el caso que alimenta el
    // diagnóstico 'alumnos-sin-matricular' de /superadmin/otros.
    id: 'self-enroll-setup-student-without-course',
    title: 'El admin da de alta un alumno SIN curso (queda sin ninguna materia)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const email = `sinmateria.${RUN_ID}@example.com`;
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Sin Materia ${RUN_ID}`, email, password: student.password, role: 'student', dni: dniSmoke(16) },
        expectStatus: 201,
      });
      state.loneStudentId    = res.json.user._id;
      state.loneStudentEmail = email;
      await client.post('loneStudent', '/login', { body: { email, password: student.password }, expectStatus: 200 });
    },
  },
  {
    id: 'self-enroll-panel-offers-curso',
    title: 'El alumno sin materias ve el selector de curso en su panel',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('loneStudent', '/courses', { expectStatus: 200 });
      assert((res.text || '').includes('autoMatriculaCurso'),
        'el panel del alumno sin materias debería ofrecerle elegir su curso');
      assert((res.text || '').includes(state.divisionId),
        'el curso de prueba debería estar entre las opciones ofrecidas');
    },
  },
  {
    id: 'self-enroll-student-picks-course',
    title: 'El alumno elige su curso y queda inscripto en sus materias',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('loneStudent', '/courses/self-enroll', {
        body: { divisionId: state.divisionId },
        expectStatus: 200,
      });
      assert(res.json.materias >= 1,
        `debería haber quedado en al menos una materia, quedó en ${res.json.materias}`);

      // Y el selector desaparece: la elección es una sola vez, y lo que la cierra es el
      // estado (ya tiene materias), no un flag que alguien pueda olvidarse de escribir.
      const panel = await client.get('loneStudent', '/courses', { expectStatus: 200 });
      assert(!(panel.text || '').includes('autoMatriculaCurso'),
        'después de matricularse, el panel no debería seguir ofreciendo elegir curso');
    },
  },
  {
    id: 'admin-users-curso-column',
    title: 'El listado de usuarios del admin muestra el Curso de cada alumno',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Se busca por RUN_ID para no depender de la paginación: el listado corta en 25 y
      // la escuela real tiene cientos de usuarios.
      const res = await client.get('admin', `/admin/users?search=${encodeURIComponent(RUN_ID)}`, { expectStatus: 200 });
      assert(res.text.includes('<th>Curso</th>'),
        'la tabla debería tener la columna Curso entre Rol y Nov·Act·Msg');
      assert(res.text.includes(state.divisionName),
        `el alumno matriculado debería mostrar su curso (${state.divisionName}) en la columna`);

      // La celda queda vacía para los que no son alumnos: el docente de smoke aparece en
      // este mismo listado y no tiene curso que mostrar.
      const filaDocente = (res.text.split(state.scopedTeacherEmail)[1] || '').split('</tr>')[0];
      assert(filaDocente && !filaDocente.includes(state.divisionName),
        'la fila del docente no debería mostrar ningún curso');
    },
  },
  {
    id: 'self-enroll-rejects-non-student',
    title: 'Un docente no puede usar la automatrícula (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedTeacher', '/courses/self-enroll', {
        body: { divisionId: state.divisionId },
        expectStatus: 403,
      });
    },
  },
  {
    // ── Código de clase (repuesto el 2026-07-31, ver services/joinByCode.js) ──────────
    // Reemplaza al viejo spec `course-join-route-is-gone`, que verificaba el 404 de cuando
    // la ruta estuvo eliminada (2026-07-30 → 2026-07-31).
    id: 'course-join-by-code',
    title: 'El alumno se suma con el código a una materia de SU curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Materia nueva en la MISMA división donde el alumno ya cursa: es el caso de uso real
      // (el docente crea una materia después de que los alumnos ya estaban matriculados).
      const nueva = await client.post('scopedTeacher', '/courses/create', {
        body: { name: `Materia Codigo ${RUN_ID}`, divisionId: state.divisionId, room: '103' },
        expectStatus: 201,
      });
      state.joinCourseId = nueva.json.course._id;
      const code = nueva.json.course.code;
      assert(code && code.length === 6, 'la materia nueva debería traer su código de 6 caracteres');

      // En minúscula y con espacios, como lo tipea alguien a quien se lo dictaron.
      const res = await client.post('scopedStudent', '/courses/join', {
        body: { code: ` ${code.toLowerCase()} ` },
        expectStatus: 200,
      });
      assert(res.json.materia._id === state.joinCourseId,
        'debería haber quedado en la materia del código');

      // Repetirlo no duplica ni rompe: avisa que ya está.
      await client.post('scopedStudent', '/courses/join', { body: { code }, expectStatus: 400 });

      // El código tiene que estar A LA VISTA del docente, que es quien lo dicta: si no se
      // pinta, la función existe pero nadie puede usarla. Y NO al alumno, que ya está en la
      // materia y solo tendría algo para reenviar.
      const vistaDocente = await client.get('scopedTeacher', `/courses/${state.courseId}`, { expectStatus: 200 });
      assert(vistaDocente.text.includes('id="codigoClase"') && vistaDocente.text.includes(state.courseCode),
        'el docente debería ver el código de su materia en el encabezado');
      const vistaAlumno = await client.get('scopedStudent', `/courses/${state.courseId}`, { expectStatus: 200 });
      assert(!vistaAlumno.text.includes('id="codigoClase"'),
        'al alumno no se le muestra el código de la materia');

      const panel = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(panel.text.includes('showJoinModal'),
        'el alumno debería tener el botón para unirse con un código en su panel');

      // ⚠️ Se borra ACÁ y no en la limpieza del final: varios specs posteriores
      // (enrolldiv-*, dni-existing-completes-missing-course) cuentan las materias de esta
      // división y esperan que haya UNA sola. Dejar la del código viva les cambia el
      // resultado a 2 y los hace fallar por un motivo que no tiene que ver con lo que
      // prueban. El id se limpia para que la limpieza del final no intente borrarla de
      // nuevo; si este spec falla antes de llegar acá, sigue ahí como red de seguridad.
      await client.post('admin', `/admin/courses/${state.joinCourseId}/delete`, { expectStatus: 200 });
      state.joinCourseId = null;
    },
  },
  {
    id: 'course-join-rejects-other-division',
    title: 'El código de una materia de OTRO curso no sirve (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es la guarda que hace segura a esta función: sin ella, un código reenviado por
      // WhatsApp mete al alumno en materias de otro año — el desorden que diagnostica
      // 'alumnos-en-varios-cursos' en /superadmin/otros.
      const div = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-AJENA-${RUN_ID}` },
        expectStatus: 201,
      });
      state.joinOtherDivisionId = div.json.division._id;

      const ajena = await client.post('scopedTeacher', '/courses/create', {
        body: { name: `Materia Ajena ${RUN_ID}`, divisionId: state.joinOtherDivisionId, room: '104' },
        expectStatus: 201,
      });
      state.joinOtherCourseId = ajena.json.course._id;

      const res = await client.post('scopedStudent', '/courses/join', {
        body: { code: ajena.json.course.code },
        expectStatus: 400,
      });
      assert(/curso/i.test(res.json.error || ''),
        `el error debería explicar que la materia es de otro curso, dijo: ${res.json.error}`);

      // Autocontenido, igual que el spec anterior: la materia va primero porque una división
      // con materias adentro no se puede borrar.
      await client.post('admin', `/admin/courses/${state.joinOtherCourseId}/delete`, { expectStatus: 200 });
      await client.post('admin', `/admin/divisions/${state.joinOtherDivisionId}/delete`, { expectStatus: 200 });
      state.joinOtherCourseId = null;
      state.joinOtherDivisionId = null;
    },
  },
  {
    id: 'course-join-rejects-unknown-code',
    title: 'Un código inexistente es rechazado (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('scopedStudent', '/courses/join', { body: { code: 'ZZZZZZ' }, expectStatus: 400 });
    },
  },
  {
    id: 'course-join-rejects-teacher',
    title: 'Un docente no puede usar el código de clase (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedTeacher', '/courses/join', {
        body: { code: state.courseCode },
        expectStatus: 403,
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
  // ── Optimización de imágenes (v1.0.7) ────────────────────────────────────
  // Antes, multer guardaba en disco el archivo tal cual llegaba: 78 imágenes = 74,7 MB en
  // el mirror local, con avatares de 3 MB mostrados en un círculo de 40 px. Ahora la imagen
  // pasa por sharp antes de tocar el disco (512×512 WebP el avatar, 1600 px las demás).
  // Estos specs verifican el flujo COMPLETO contra el server: que la URL guardada apunte a
  // un .webp, que el archivo servido pese lo que tiene que pesar, y que la validación real
  // (¿es una imagen?) rechace lo que no lo es.
  {
    id: 'avatar-upload-optimiza',
    title: 'El avatar subido se guarda como WebP chico y se sirve correctamente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const foto = await fotoDePrueba(2400, 1800);
      assert(foto.length > 300 * 1024, 'la foto de prueba debería pesar cientos de KB');

      const fd = new FormData();
      fd.append('avatar', new Blob([foto], { type: 'image/jpeg' }), 'perfil.jpg');
      const res = await client.post('scopedTeacher', '/courses/profile/avatar', {
        form: fd, expectStatus: 200,
      });

      assert(res.json.avatar, 'debería devolver la URL del avatar');
      assert(res.json.avatar.endsWith('.webp'),
        `el avatar debería guardarse como .webp, quedó: ${res.json.avatar}`);
      state.avatarUrl = res.json.avatar;

      // El archivo servido: existe, es WebP, y pesa una fracción del original
      const archivo = await client.get('scopedTeacher', res.json.avatar, { expectStatus: 200 });
      const ct = archivo.headers.get('content-type') || '';
      assert(ct.includes('webp'), `esperaba content-type webp, vino: ${ct}`);
      assert(archivo.byteLength > 0, 'el archivo servido no debería estar vacío');
      assert(archivo.byteLength < 100 * 1024,
        `el avatar optimizado debería pesar menos de 100 KB, pesó ${archivo.byteLength}`);
    },
  },
  {
    id: 'avatar-upload-cambia-de-url',
    title: 'Volver a subir el avatar genera una URL nueva (rompe el cache del navegador)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Con nombre fijo (`avatar.webp`) la URL no cambiaba al re-subir y el navegador
      // seguía mostrando la foto anterior desde su cache. Por eso el sufijo único.
      const foto = await fotoDePrueba(800, 800);
      const fd = new FormData();
      fd.append('avatar', new Blob([foto], { type: 'image/jpeg' }), 'perfil2.jpg');
      const res = await client.post('scopedTeacher', '/courses/profile/avatar', {
        form: fd, expectStatus: 200,
      });

      assert(res.json.avatar !== state.avatarUrl,
        'la URL del avatar debería cambiar en cada subida');

      // Y la anterior tiene que haber desaparecido del disco: si se acumularan, el ahorro
      // se perdería con cada re-subida.
      const vieja = await client.get('scopedTeacher', state.avatarUrl);
      assert(vieja.status === 404,
        `el avatar anterior debería borrarse del disco, respondió ${vieja.status}`);
      state.avatarUrl = res.json.avatar;
    },
  },
  {
    id: 'avatar-rechaza-archivo-que-no-es-imagen',
    title: 'Un archivo cualquiera renombrado a .jpg se rechaza (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // El fileFilter de multer solo mira la extensión y el Content-Type que declara el
      // cliente — los dos falsificables. Decodificar con sharp es la validación de verdad;
      // sin ella, esto terminaba escrito dentro de /public.
      const fd = new FormData();
      fd.append('avatar', new Blob(['#!/bin/sh\nrm -rf /\n'], { type: 'image/jpeg' }), 'payload.jpg');
      const res = await client.post('scopedTeacher', '/courses/profile/avatar', {
        form: fd, expectStatus: 400,
      });
      assert(res.json && res.json.error, 'debería devolver un error en JSON');
    },
  },
  {
    id: 'avatar-rechaza-extension-no-permitida',
    title: 'Un .pdf en el campo de avatar se rechaza (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      const fd = new FormData();
      fd.append('avatar', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'documento.pdf');
      await client.post('scopedTeacher', '/courses/profile/avatar', {
        form: fd, expectStatus: 400,
      });
    },
  },
  {
    id: 'header-upload-optimiza',
    title: 'La portada de la materia se guarda optimizada como WebP',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const foto = await fotoDePrueba(3000, 2000);
      const fd = new FormData();
      fd.append('mode', 'image');
      fd.append('color', '#1a73e8');
      fd.append('image', new Blob([foto], { type: 'image/jpeg' }), 'portada.jpg');

      const res = await client.post('scopedTeacher', `/courses/${state.courseId}/customize`, {
        form: fd, expectStatus: 200,
      });

      assert(res.json.header && res.json.header.image, 'debería devolver la URL de la portada');
      assert(res.json.header.image.endsWith('.webp'),
        `la portada debería guardarse como .webp, quedó: ${res.json.header.image}`);
      state.headerUrl = res.json.header.image;

      const archivo = await client.get('scopedTeacher', res.json.header.image, { expectStatus: 200 });
      assert(archivo.byteLength < 300 * 1024,
        `la portada optimizada debería pesar menos de 300 KB, pesó ${archivo.byteLength}`);
      assert(archivo.byteLength < foto.length / 3,
        'la portada debería pesar bastante menos que el original');
    },
  },
  {
    id: 'header-upload-ajeno-sigue-403',
    title: 'Un docente no puede personalizar (ni pisar la portada de) un curso ajeno',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Regresión histórica: el multer viejo borraba la portada anterior dentro de su
      // callback `filename()`, que corre ANTES del handler — un docente ajeno recibía 403
      // pero la portada de la víctima ya estaba borrada. Con la subida en memoria el
      // borrado pasó al handler; este spec verifica el 403 Y que la imagen siga viva.
      assert(state.headerUrl, 'este spec depende de la portada subida por header-upload-optimiza');

      const foto = await fotoDePrueba(600, 400);
      const fd = new FormData();
      fd.append('mode', 'image');
      fd.append('image', new Blob([foto], { type: 'image/jpeg' }), 'intruso.jpg');

      // `student` es un usuario del Nivel 1, sin ninguna relación con este curso
      await client.post('student', `/courses/${state.courseId}/customize`, {
        form: fd, expectStatus: 403,
      });

      // Lo que de verdad importa: la portada de la víctima sigue en disco
      await client.get('scopedTeacher', state.headerUrl, { expectStatus: 200 });
    },
  },
  {
    id: 'novedad-imagen-optimiza',
    title: 'La imagen de una novedad se guarda optimizada como WebP',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const foto = await fotoDePrueba(2500, 1600);
      const fd = new FormData();
      fd.append('courseId', state.courseId);
      fd.append('text', 'Novedad con imagen (smoke)');
      fd.append('image', new Blob([foto], { type: 'image/jpeg' }), 'pizarron.jpg');

      const res = await client.post('scopedTeacher', '/announcements/create', {
        form: fd, expectStatus: 201,
      });

      const url = res.json.announcement.image;
      assert(url, 'la novedad debería tener imagen');
      assert(url.endsWith('.webp'), `la imagen debería guardarse como .webp, quedó: ${url}`);
      state.novedadConImagenId = res.json.announcement._id;

      const archivo = await client.get('scopedTeacher', url, { expectStatus: 200 });
      assert(archivo.byteLength < 300 * 1024,
        `la imagen optimizada debería pesar menos de 300 KB, pesó ${archivo.byteLength}`);
    },
  },
  {
    id: 'novedad-rechaza-archivo-que-no-es-imagen',
    title: 'Una novedad con un archivo que no es imagen se rechaza (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const fd = new FormData();
      fd.append('courseId', state.courseId);
      fd.append('text', 'Novedad con payload');
      fd.append('image', new Blob(['no soy una imagen'], { type: 'image/png' }), 'falso.png');
      await client.post('scopedTeacher', '/announcements/create', {
        form: fd, expectStatus: 400,
      });
    },
  },
  {
    id: 'activity-create',
    title: 'El docente crea una actividad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // allowResubmission=1 porque el suite hace varios submits secuenciales sobre esta misma actividad
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: 'Actividad de smoke test', type: 'tarea', points: '10', allowResubmission: '1' },
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
    id: 'entrega-pdf-no-se-toca',
    title: 'El optimizador no toca los adjuntos que no son imágenes (el PDF sigue siendo PDF)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Las entregas siguen en diskStorage y SIN optimizar (fuera del alcance de v1.0.7:
      // ahí hay PDFs de hasta 50 MB que no tienen por qué pasar por RAM). Este spec fija
      // ese límite — si algún día se extiende el optimizador a las entregas, que no se
      // lleve puestos los PDFs por el camino.
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4 smoke sin tocar'], { type: 'application/pdf' }), 'intacto.pdf');
      const up = await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-file`, {
        form: fd, expectStatus: 200,
      });
      assert(up.json.filename.endsWith('.pdf'),
        `el PDF debería conservar su extensión, quedó: ${up.json.filename}`);
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

  // ── Multi-docente: un coTeacher puede hacer todo lo que el owner (infra de esta sesión) ──
  // Todavía no existe endpoint en la API para agregar un co-docente (lo hará
  // scripts/merge-courses.js al fusionar materias duplicadas) — por eso el segundo spec
  // toca Mongo directo, igual que las limpiezas de auditlogs/sugerencias más abajo.
  {
    id: 'coteacher-setup-create',
    title: 'El admin da de alta un segundo docente para probar coTeachers',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: coTeacher.name, email: coTeacher.email, password: coTeacher.password, role: 'teacher', dni: dniSmoke(5) },
        expectStatus: 201,
      });
      state.coTeacherId = res.json.user._id;
    },
  },
  {
    id: 'coteacher-add-to-course-db',
    title: 'Se agrega el segundo docente a coTeachers del curso de smoke (directo en Mongo)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ env, state }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        await client.db().collection('courses').updateOne(
          { _id: new ObjectId(state.courseId) },
          { $addToSet: { coTeachers: new ObjectId(state.coTeacherId) } },
        );
      } finally {
        await client.close();
      }
    },
  },
  {
    id: 'coteacher-login',
    title: 'El co-docente inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('coTeacher', '/login', {
        body: { email: coTeacher.email, password: coTeacher.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'coteacher-can-create-activity',
    title: 'El co-docente crea una actividad en el curso (no es el owner)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('coTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: 'Actividad de co-docente smoke', type: 'tarea', points: '10' },
        expectStatus: 201,
      });
      state.coTeacherActivityId = res.json.activity._id;
    },
  },
  {
    id: 'coteacher-can-publish-announcement',
    title: 'El co-docente publica una novedad en el curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('coTeacher', '/announcements/create', {
        body: { courseId: state.courseId, text: 'Novedad de co-docente smoke' },
        expectStatus: 201,
      });
    },
  },
  {
    id: 'coteacher-add-student-setup',
    title: 'Se crea un alumno adicional para probar agregar/quitar por el co-docente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const email = `smoke.coteacher.student.${RUN_ID}@example.com`;
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'Smoke CoTeacher Student', email, password: 'SmokeTest1234', role: 'student', dni: dniSmoke(6) },
        expectStatus: 201,
      });
      state.coTeacherStudentId    = res.json.user._id;
      state.coTeacherStudentEmail = email;
    },
  },
  {
    id: 'coteacher-can-add-student',
    title: 'El co-docente agrega al alumno al curso (no es el owner)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('coTeacher', `/courses/${state.courseId}/add-student`, {
        body: { email: state.coTeacherStudentEmail },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'coteacher-can-remove-student',
    title: 'El co-docente quita al mismo alumno del curso (no es el owner)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.delete('coTeacher', `/courses/${state.courseId}/students/${state.coTeacherStudentId}`, {
        expectStatus: 200,
      });
    },
  },
  {
    id: 'coteacher-can-grade',
    title: 'El co-docente ve y califica una entrega de su propia actividad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/activities/${state.coTeacherActivityId}/submit`, {
        body: { text: 'Entrega para el co-docente' },
        expectStatus: 200,
      });
      const subs = await client.get('coTeacher', `/activities/${state.coTeacherActivityId}/submissions`, { expectStatus: 200 });
      assert(subs.json.submissions.length === 1, 'debería haber exactamente 1 entrega');
      await client.post('coTeacher', `/activities/${state.coTeacherActivityId}/grade`, {
        body: { studentId: state.scopedStudentId, points: '8', feedback: 'Bien (co-docente)' },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'coteacher-can-customize',
    title: 'El co-docente personaliza el curso (no es el owner)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const fd = new FormData();
      fd.append('mode', 'gradient');
      fd.append('color', '#123456');
      await client.post('coTeacher', `/courses/${state.courseId}/customize`, {
        form: fd, expectStatus: 200,
      });
    },
  },
  {
    id: 'coteacher-cleanup',
    title: 'Limpieza: borra la actividad del co-docente y las cuentas de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.coTeacherActivityId) {
        await client.delete('coTeacher', `/activities/${state.coTeacherActivityId}`, { expectStatus: 200 });
      }
      if (state.coTeacherStudentId) {
        await client.post('admin', `/admin/users/${state.coTeacherStudentId}/delete`, { expectStatus: 200 });
      }
      if (state.coTeacherId) {
        await client.post('admin', `/admin/users/${state.coTeacherId}/delete`, { expectStatus: 200 });
      }
    },
  },

  // ── Alta de alumno con Curso (matricula automática en materias + regla temporal) ──
  // Verifica el flujo nuevo: admin crea usuario con role=student + divisionId, y el backend:
  //  1. Inscribe al alumno en TODAS las materias del Curso seleccionado (1 en smoke — el
  //     único curso creado por `course-create`).
  //  2. Guarda joinedAt = ahora en Course.enrollmentDates para ese alumno.
  //  3. En GET /activities/course/:id, si el alumno tiene joinedAt, el server oculta las
  //     tareas cuyo dueDate ya venció ANTES de ese momento — salvo que el docente haya
  //     habilitado tardías (decisión explícita del usuario).
  // Se contrasta con `scopedStudent` (que se unió por código, sin joinedAt) — ese sigue
  // viendo TODAS las actividades (backward compat con lo que había antes de esta feature).
  {
    id: 'enrolldiv-teacher-creates-past-activity',
    title: 'El docente crea una actividad con dueDate en el PASADO (ambientar el caso borde)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: 'Tarea vencida (pre-latejoiner)', type: 'tarea', points: '10', dueDate: yesterday },
        expectStatus: 201,
      });
      state.pastActivityId = res.json.activity._id;
    },
  },
  {
    id: 'enrolldiv-admin-creates-latejoiner-with-division',
    title: 'El admin crea un alumno con divisionId → se inscribe en las materias del Curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const email = `latejoiner.${Date.now()}@example.com`;
      const res = await client.post('admin', '/admin/users/create', {
        body: {
          name: 'Late Joiner Smoke',
          email,
          password: 'SmokeTest1234',
          role: 'student',
          dni: dniSmoke(10),
          divisionId: state.divisionId,
        },
        expectStatus: 201,
      });
      assert(res.json.enrolledIn === 1, `esperaba enrolledIn=1 (el único curso del smoke), recibí ${res.json.enrolledIn}`);
      state.lateJoinerId    = res.json.user._id;
      state.lateJoinerEmail = email;
    },
  },
  {
    id: 'enrolldiv-latejoiner-login',
    title: 'El late-joiner inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('lateJoiner', '/login', {
        body: { email: state.lateJoinerEmail, password: 'SmokeTest1234' },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'enrolldiv-latejoiner-hides-past-activity',
    title: 'El late-joiner NO ve la actividad vencida antes de su alta',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('lateJoiner', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const seesPast = res.json.activities.some(a => a._id === state.pastActivityId);
      assert(!seesPast, 'la actividad vencida antes de la inscripción NO debería figurarle al late-joiner');
    },
  },
  {
    id: 'enrolldiv-latejoiner-sees-current-activity',
    title: 'El late-joiner SÍ ve la actividad vigente (creada antes pero con dueDate futuro o sin dueDate)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('lateJoiner', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const seesCurrent = res.json.activities.some(a => a._id === state.activityId);
      assert(seesCurrent, 'la actividad vigente (sin dueDate) SÍ debería figurarle al late-joiner');
    },
  },
  {
    id: 'enrolldiv-oldstudent-still-sees-past',
    title: 'El alumno unido por código (sin joinedAt) sigue viendo todas las actividades',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const seesPast    = res.json.activities.some(a => a._id === state.pastActivityId);
      const seesCurrent = res.json.activities.some(a => a._id === state.activityId);
      assert(seesPast,    'scopedStudent (sin joinedAt) debería seguir viendo la actividad vencida — backward compat');
      assert(seesCurrent, 'scopedStudent debería seguir viendo la actividad vigente');
    },
  },
  {
    id: 'enrolldiv-late-submissions-override',
    title: 'Si el docente habilita tardías en la actividad vencida, el late-joiner también la ve',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Habilitar tardías en la actividad vencida
      await client.patch('scopedTeacher', `/activities/${state.pastActivityId}/toggle-late`, { expectStatus: 200 });

      const res = await client.get('lateJoiner', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const seesPast = res.json.activities.some(a => a._id === state.pastActivityId);
      assert(seesPast, 'con allowLateSubmissions=true, la actividad vencida debería aparecer también al late-joiner');
    },
  },
  {
    id: 'enrolldiv-cleanup-latejoiner',
    title: 'Limpieza: el admin borra al late-joiner y la actividad vencida',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.pastActivityId) {
        await client.delete('scopedTeacher', `/activities/${state.pastActivityId}`, { expectStatus: 200 });
      }
      if (state.lateJoinerId) {
        await client.post('admin', `/admin/users/${state.lateJoinerId}/delete`, { expectStatus: 200 });
      }
    },
  },

  // ── Alta de alumno con DNI ya existente: completa matrícula, no duplica ────
  // Reproduce el escenario descripto por el usuario: si el DNI ingresado ya pertenece
  // a un alumno, el sistema NO debe crear una cuenta nueva — debe usar la existente y
  // matricularla solo en las materias del Curso que todavía le falten.
  {
    id: 'dni-required-on-create',
    title: 'El alta de usuario rechaza un DNI ausente o inválido (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      // Sin DNI
      await client.post('admin', '/admin/users/create', {
        body: { name: 'Sin DNI', email: `sindni.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student' },
        expectStatus: 400,
      });
      // DNI demasiado corto
      await client.post('admin', '/admin/users/create', {
        body: { name: 'DNI Corto', email: `dnicorto.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student', dni: '123' },
        expectStatus: 400,
      });
      // Solo letras → al quedarse sin dígitos se trata como ausente
      await client.post('admin', '/admin/users/create', {
        body: { name: 'DNI Letras', email: `dniletras.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student', dni: 'abcdefgh' },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'dni-normalized-on-create',
    title: 'El DNI se guarda normalizado a solo dígitos ("40.123.456" → "40123456")',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const digitos = dniSmoke(14);
      const conPuntos = `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5)}`;
      const res = await client.post('admin', '/admin/users/create', {
        body: {
          name: 'Alumno DNI Con Puntos', email: `dnipuntos.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'student', dni: conPuntos,
        },
        expectStatus: 201,
      });
      state.dniNormalizedId = res.json.user._id;
      assert(res.json.user.dni === digitos,
        `el DNI debería guardarse como ${digitos} (sin puntos), quedó ${res.json.user.dni}`);
    },
  },
  {
    id: 'dni-required-on-self-register',
    title: 'El auto-registro también exige DNI (400)',
    async run({ client }) {
      await client.post(null, '/register', {
        body: { name: 'Registro Sin DNI', email: `regsindni.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student' },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'dni-existing-setup-second-course',
    title: 'Se crea una segunda materia en el mismo Curso (para probar matrícula parcial)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('scopedTeacher', '/courses/create', {
        body: { name: `Materia Smoke 2 ${RUN_ID}`, divisionId: state.divisionId, room: '102' },
        expectStatus: 201,
      });
      state.secondCourseId = res.json.course._id;
    },
  },
  {
    id: 'dni-existing-create-partial-student',
    title: 'Se crea un alumno con DNI, matriculado a mano en solo UNA de las dos materias',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const email = `dni.partial.${RUN_ID}@example.com`;
      const dni   = dniSmoke(12);
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'Alumno DNI Partial', email, password: 'SmokeTest1234', role: 'student', dni },
        expectStatus: 201,
      });
      state.dniStudentId  = res.json.user._id;
      state.dniStudentDni = dni;
      // Lo agrega manualmente a la PRIMERA materia (state.courseId) — NO a la segunda
      await client.post('scopedTeacher', `/courses/${state.courseId}/add-student`, {
        body: { email },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'dni-existing-completes-missing-course',
    title: 'Reingresar el mismo DNI con el Curso completa la materia faltante (no duplica ni crea cuenta nueva)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: {
          name: 'Nombre Que Debe Ignorarse',
          email: `otro.email.${RUN_ID}@example.com`,
          password: 'OtraClave1234',
          role: 'student',
          dni: state.dniStudentDni,
          divisionId: state.divisionId,
        },
        expectStatus: 200, // 200, no 201: no se crea nada nuevo
      });
      assert(res.json.existedAlready === true, 'debería indicar que el alumno ya existía');
      assert(res.json.enrolledIn === 1, `esperaba completar 1 materia faltante, recibí ${res.json.enrolledIn}`);
      assert(res.json.user._id === state.dniStudentId, 'debería devolver la cuenta EXISTENTE, no una nueva');
      assert(res.json.user.name === 'Alumno DNI Partial', 'el nombre NO debería sobrescribirse con el del formulario');
    },
  },
  {
    id: 'dni-existing-fully-enrolled-noop',
    title: 'Reingresar el mismo DNI cuando ya está en TODAS las materias no rompe nada (enrolledIn=0)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'x', email: `x.${RUN_ID}@example.com`, password: 'x123456', role: 'student', dni: state.dniStudentDni, divisionId: state.divisionId },
        expectStatus: 200,
      });
      assert(res.json.existedAlready === true, 'debería seguir indicando que ya existía');
      assert(res.json.enrolledIn === 0, `ya debería estar en todas las materias, recibí enrolledIn=${res.json.enrolledIn}`);
    },
  },
  {
    id: 'dni-belongs-to-other-role-setup',
    title: 'Se crea un docente de prueba con DNI conocido',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const dni = dniSmoke(13);
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'Docente Con DNI', email: `docente.dni.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'teacher', dni },
        expectStatus: 201,
      });
      state.teacherWithDniId = res.json.user._id;
      state.teacherWithDni   = dni;
    },
  },
  {
    id: 'dni-belongs-to-other-role-rejected',
    title: 'Dar de alta un alumno con el DNI de un docente existente es rechazado (409)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: { name: 'Intento Alumno', email: `intento.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student', dni: state.teacherWithDni },
        expectStatus: 409,
      });
      assert(res.json.error.includes('Docente'), 'el mensaje debería mencionar que el DNI ya pertenece a un Docente');
    },
  },
  {
    id: 'dni-existing-cleanup',
    title: 'Limpieza: borra la segunda materia, el alumno DNI y el docente de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.secondCourseId)   await client.post('admin', `/admin/courses/${state.secondCourseId}/delete`, { expectStatus: 200 });
      if (state.dniStudentId)     await client.post('admin', `/admin/users/${state.dniStudentId}/delete`, { expectStatus: 200 });
      if (state.teacherWithDniId) await client.post('admin', `/admin/users/${state.teacherWithDniId}/delete`, { expectStatus: 200 });
    },
  },

  // ── Auditoría (fase 1: 4 eventos piloto) ──────────────────────────────────
  // Los specs anteriores ya dispararon las 4 acciones instrumentadas:
  //   activity.create · submission.create · submission.update · submission.grade
  //   announcement.create
  // El helper logAudit es fire-and-forget (no await en la ruta), así que en
  // teoría hay una ventana de milisegundos entre el response HTTP y el insert
  // en Mongo. En la práctica, cuando este spec corre ya pasaron varios HTTP
  // roundtrips más, muy por encima del tiempo de un insertOne.
  {
    id: 'audit-denied-for-teacher',
    title: 'Un docente NO puede acceder al panel de auditoría (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('scopedTeacher', '/admin/audit', { expectStatus: [403, 302] });
    },
  },
  {
    id: 'audit-admin-sees-events',
    title: 'El admin ve el panel de auditoría con los eventos recientes de su escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('admin', '/admin/audit', { expectStatus: 200 });
      // La actividad de smoke y la novedad de smoke debieron generar eventos visibles
      assert(res.text.includes('Actividad de smoke test'),
        'el panel debería mostrar la actividad de smoke (activity.create)');
      assert(res.text.includes('creó una actividad') || res.text.includes('calificó una entrega'),
        'el panel debería usar los verbos del catálogo de acciones');
    },
  },
  {
    id: 'audit-filter-by-category',
    title: 'El filtro por categoría acota los eventos del panel',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Compara el total mostrado en el header del panel — el string "X evento(s)"
      // es único de la sección-header y no aparece en los <option> del dropdown.
      // Filtrar por categoría debe reducir estrictamente el total.
      const extractTotal = (html) => {
        const m = html.match(/([\d.]+) evento/); // "12 eventos" o "1 evento"
        if (!m) throw new Error('no se encontró el contador "X eventos" en el HTML');
        return parseInt(m[1].replace(/\./g, ''), 10);
      };

      const all         = await client.get('admin', '/admin/audit', { expectStatus: 200 });
      const submissions = await client.get('admin', '/admin/audit?category=submission', { expectStatus: 200 });
      const activities  = await client.get('admin', '/admin/audit?category=activity', { expectStatus: 200 });

      const totalAll         = extractTotal(all.text);
      const totalSubmissions = extractTotal(submissions.text);
      const totalActivities  = extractTotal(activities.text);

      assert(totalSubmissions < totalAll,  `filtro submission debería reducir el total (${totalSubmissions} vs ${totalAll})`);
      assert(totalActivities  < totalAll,  `filtro activity debería reducir el total (${totalActivities} vs ${totalAll})`);
      assert(totalSubmissions > 0,         'debería haber al menos una entrega/calificación registrada');
      assert(totalActivities  > 0,         'debería haber al menos una creación de actividad registrada');
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

  // ── Bandeja de sugerencias: respuesta del superadmin + sobre con badge ────
  {
    id: 'suggestions-student-fetches-mine',
    title: 'El alumno ve su propia sugerencia en /suggestions/mine',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = res.json.suggestions.find(s => s.text === state.studentSuggestionText);
      assert(mine, 'la sugerencia recién enviada debería aparecer en /suggestions/mine');
      assert(mine.status === 'pending', `esperaba status pending, encontré ${mine.status}`);
      assert(mine.readByUser === false, 'una sugerencia sin respuesta no debería estar marcada como leída');
      state.studentSuggestionId = mine._id;
    },
  },
  {
    id: 'suggestions-superadmin-can-respond',
    title: 'El superadmin responde la sugerencia del alumno',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, env }) {
      // Login propio del actor 'superadmin' acá: el spec genérico "superadmin-login" vive
      // mucho más abajo en el archivo (sección Nivel 3), después de esta sección. Sin este
      // login, la cookie jar de 'superadmin' está vacía y el POST cae en 302 → /login.
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      state.suggestionResponseText = `Gracias por la sugerencia — smoke ${RUN_ID}`;
      await client.post('superadmin', `/superadmin/suggestions/${state.studentSuggestionId}/respond`, {
        body: { text: state.suggestionResponseText, isEdit: false },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'suggestions-student-sees-answer-and-badge',
    title: 'El alumno ve la respuesta y el badge del sobre aparece en el header',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine, 'la sugerencia debería seguir apareciendo en /suggestions/mine');
      assert(mine.status === 'answered', `esperaba status answered, encontré ${mine.status}`);
      assert(mine.response === state.suggestionResponseText, 'el texto de la respuesta debería coincidir');
      assert(mine.readByUser === false, 'recién respondida: todavía no debería estar marcada como leída');

      // El badge del sobre se renderiza server-side en cualquier página con header (ej. /courses)
      const pageRes = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(pageRes.text.includes('id="inboxBadge"'), 'el header debería mostrar el badge del sobre con respuestas sin leer');
    },
  },
  {
    id: 'suggestions-student-marks-read-clears-badge',
    title: 'Marcar como leída hace desaparecer el badge del sobre',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/suggestions/mine/${state.studentSuggestionId}/read`, { expectStatus: 200 });

      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine.readByUser === true, 'después de marcar como leída, readByUser debería ser true');

      const pageRes = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(!pageRes.text.includes('id="inboxBadge"'), 'el badge no debería aparecer una vez leída la respuesta');
    },
  },
  {
    id: 'suggestions-edit-response-reopens-badge',
    title: 'Editar la respuesta vuelve a marcarla como no leída (el badge reaparece)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const editedText = `Respuesta editada — smoke ${RUN_ID}`;
      await client.post('superadmin', `/superadmin/suggestions/${state.studentSuggestionId}/respond`, {
        body: { text: editedText, isEdit: true },
        expectStatus: 200,
      });

      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine.response === editedText, 'la respuesta editada debería reflejarse');
      assert(mine.readByUser === false, 'editar la respuesta debería resetear readByUser a false');

      const pageRes = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(pageRes.text.includes('id="inboxBadge"'), 'el badge debería reaparecer tras editar la respuesta');
    },
  },
  {
    id: 'suggestions-inbox-denies-other-users-suggestions',
    title: 'Un usuario no puede marcar como leída la sugerencia de otro (404)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // scopedTeacher intenta marcar como leída la sugerencia del alumno — no es suya
      await client.post('scopedTeacher', `/suggestions/mine/${state.studentSuggestionId}/read`, {
        expectStatus: 404,
      });
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

  // ── Cambio de correo propio (cualquier rol) ───────────────────────────────
  {
    id: 'email-change-wrong-password-rejected',
    title: 'Cambiar de correo con la contraseña actual incorrecta es rechazado (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('scopedTeacher', '/courses/profile/change-email', {
        body: { newEmail: `nuevo.email.${RUN_ID}@example.com`, currentPassword: 'contraseña-incorrecta' },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'email-change-invalid-format-rejected',
    title: 'Un correo con formato inválido es rechazado (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('scopedTeacher', '/courses/profile/change-email', {
        body: { newEmail: 'no-es-un-email', currentPassword: teacher.password },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'email-change-success',
    title: 'El docente cambia su correo — el viejo deja de funcionar, el nuevo sí loguea',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const newEmail = `scoped.teacher.new.${RUN_ID}@example.com`;
      const res = await client.post('scopedTeacher', '/courses/profile/change-email', {
        body: { newEmail, currentPassword: teacher.password },
        expectStatus: 200,
      });
      assert(res.json.email === newEmail, 'la respuesta debería confirmar el nuevo email');

      // El email viejo ya no debería poder loguearse (la cuenta ahora usa el nuevo)
      await client.post(null, '/login', {
        body: { email: state.scopedTeacherEmail, password: teacher.password },
        expectStatus: 400,
      });

      // El nuevo email SÍ debería poder loguearse
      await client.post(null, '/login', {
        body: { email: newEmail, password: teacher.password },
        expectStatus: 200,
      });

      state.scopedTeacherEmail = newEmail; // por si algún spec posterior lo necesita
    },
  },
  {
    id: 'email-change-duplicate-rejected',
    title: 'Cambiar el correo a uno ya en uso por otra cuenta es rechazado (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // scopedStudent intenta tomar el email (ya cambiado) del scopedTeacher
      await client.post('scopedStudent', '/courses/profile/change-email', {
        body: { newEmail: state.scopedTeacherEmail, currentPassword: student.password },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'email-change-protected-account-blocked',
    title: 'La cuenta protegida del dueño del sistema NO puede autocambiarse el correo (403)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, env }) {
      // Login propio del actor acá (no depende del spec "superadmin-login", que corre
      // mucho más abajo en el archivo — mismo motivo que en los specs de sugerencias).
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });
      await client.post('superadmin', '/courses/profile/change-email', {
        body: { newEmail: `otra.cosa.${RUN_ID}@example.com`, currentPassword: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 403,
      });
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
        body: { name: 'Smoke Directivo', email, password: 'SmokeTest1234', role: 'directivo', dni: dniSmoke(7) },
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
    async run({ client, assert }) {
      // La vista tiene que renderear con sus métricas
      const res = await client.get('directivo', '/directivo/courses', { expectStatus: 200 });
      assert(res.text.includes('Tasa de entrega'), 'el listado debería mostrar la tasa de entrega');

      // El curso de smoke se busca por nombre en vez de esperarlo en la primera página.
      // Antes este test hacía `includes('Materia Smoke')` sobre el listado sin filtrar y
      // fallaba SIEMPRE contra una base espejada de producción: /directivo/courses pagina
      // de a 25 y ordena por peor tasa de entrega, y con 419 materias el curso de smoke
      // nunca caía en la página 1. El test es anterior a que se agregara esa paginación.
      const buscado = await client.get('directivo', '/directivo/courses?search=Materia+Smoke', { expectStatus: 200 });
      assert(buscado.text.includes('Materia Smoke'),
        'el curso de smoke debería aparecer al buscarlo por nombre');
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
      assert(res.text.includes('Actividades por mes') || res.text.includes('Sin calificar'),
        'la vista debería incluir métricas de actividad docente');
    },
  },
  {
    id: 'directivo-teachers-search',
    title: 'El buscador de docentes filtra y la paginación conserva los filtros',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Una búsqueda que no puede coincidir con nadie debe vaciar la tabla, no ignorarse:
      // si el filtro no se aplicara, esto devolvería el listado completo.
      const vacio = await client.get('directivo', '/directivo/teachers?search=zzzznoexistezzz', { expectStatus: 200 });
      assert(vacio.text.includes('Sin resultados') || vacio.text.includes('Ningún docente coincide'),
        'una búsqueda sin coincidencias debería mostrar el estado vacío');

      // El sort no debe romper la vista
      await client.get('directivo', '/directivo/teachers?sort=acts-asc', { expectStatus: 200 });

      // Los links de paginación tienen que arrastrar search y sort, o pasar de página
      // perdería el filtro (ver partials/pagination.ejs, que arma el query desde queryParams).
      const conFiltro = await client.get('directivo', '/directivo/teachers?sort=name', { expectStatus: 200 });
      if (conFiltro.text.includes('class="pagination"')) {
        assert(conFiltro.text.includes('sort=name&amp;page=') || conFiltro.text.includes('sort=name&page='),
          'los links de paginación deberían conservar el sort');
      }
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
      assert(res.text.includes('Evolución de los últimos'),
        'el perfil debería incluir el gráfico de evolución mensual');
    },
  },
  {
    id: 'directivo-divisions-list',
    title: 'El directivo ve el listado de divisiones con sus métricas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('directivo', '/directivo/divisions', { expectStatus: 200 });
      assert(res.text.includes('Tasa de entrega'), 'el listado debería mostrar la tasa de entrega');
      // La división de smoke se busca por nombre para no depender de la paginación:
      // la escuela real tiene ~39 divisiones y el listado corta en 25.
      const buscada = await client.get('directivo', `/directivo/divisions?search=${encodeURIComponent(state.divisionName || '')}`, { expectStatus: 200 });
      if (state.divisionName) {
        assert(buscada.text.includes(state.divisionName),
          'la división de smoke debería aparecer al buscarla por nombre');
      }
    },
  },
  {
    id: 'directivo-division-detail',
    title: 'El detalle de división lista materias y alumnos, y rechaza IDs de otra escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      if (!state.divisionId) return;
      const res = await client.get('directivo', `/directivo/divisions/${state.divisionId}`, { expectStatus: 200 });
      assert(res.text.includes('Materias de la división'), 'debería listar las materias');
      assert(res.text.includes('Alumnos de la división'), 'debería listar los alumnos');

      // Un ObjectId válido pero inexistente no debe filtrar datos ni tirar 500
      const inexistente = await client.get('directivo', '/directivo/divisions/000000000000000000000000');
      assert(inexistente.status === 404,
        `una división inexistente debería dar 404, dio ${inexistente.status}`);
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
    id: 'superadmin-users-link-to-profile',
    title: 'El listado de usuarios del superadmin lleva al perfil, y ahí puede suplantar',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // El listado del superadmin solo tenía los selectores inline de rol y escuela: para
      // llegar al perfil (única pantalla con "Ver como este usuario", deshabilitar cuenta y
      // restablecer contraseña) había que dar la vuelta por /admin/users o escribir la URL.
      const lista = await client.get('superadmin', '/superadmin/users', { expectStatus: 200 });
      const ids = [...(lista.text || '').matchAll(/href="\/admin\/users\/([a-f0-9]{24})"/g)].map(m => m[1]);
      assert(ids.length > 0, 'cada fila del listado del superadmin debería enlazar al perfil del usuario');

      // Y el link tiene que ABRIR: /admin/users/:id corta por escuela con `school && ...`,
      // que con el school:null del superadmin no filtra. Si eso cambiara, el botón daría 403.
      const perfil = await client.get('superadmin', `/admin/users/${ids[0]}`, { expectStatus: 200 });
      assert((perfil.text || '').includes('Ver como este usuario'),
        'el perfil debería ofrecer la suplantación');

      // El perfil es una vista del panel de admin que ahora comparten los dos roles. Si le
      // pinta al superadmin las solapas de administrador, sale de ahí a /admin/users y queda
      // encerrado: ninguna solapa de ese panel vuelve a /superadmin, y parece que perdió el
      // rol. Por eso se verifica que la navegación sea la SUYA.
      assert((perfil.text || '').includes('href="/superadmin/schools"'),
        'el superadmin debería ver SUS solapas en el perfil, no las del panel de administrador');
      assert((perfil.text || '').includes('href="/superadmin/users" class="btn btn-outline"'),
        'el botón de volver debería devolverlo al listado del superadmin');
    },
  },
  {
    id: 'exit-impersonate-returns-to-own-panel',
    title: 'Al salir de la suplantación, cada rol vuelve a SU panel (no todos a /admin)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, env, state, assert }) {
      // /exit-impersonate redirigía SIEMPRE a /admin. El admin no lo notaba (es su panel),
      // pero el superadmin terminaba en el panel de administración: con las solapas de admin
      // y sin las suyas, como si al volver de la suplantación hubiera cambiado de rol.
      //
      // Cada caso usa su propio actor: si algo falla en el medio, la cookie del suplantado no
      // le queda pegada a los actores 'admin'/'superadmin' que usan los demás specs.
      const casos = [
        { actor: 'exitSuper', email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD,
          target: state.studentId,       panel: '/superadmin' },
        { actor: 'exitAdmin', email: env.SMOKE_ADMIN_EMAIL,      password: env.SMOKE_ADMIN_PASSWORD,
          target: state.scopedStudentId, panel: '/admin' },
      ];

      for (const c of casos) {
        assert(c.target, `falta el alumno de prueba para el caso ${c.actor}`);
        await client.post(c.actor, '/login', {
          body: { email: c.email, password: c.password }, expectStatus: 200,
        });

        await client.post(c.actor, `/admin/users/${c.target}/impersonate`, { expectStatus: 200 });
        const comoAlumno = await client.get(c.actor, '/', { expectStatus: 302 });
        assert(comoAlumno.headers.get('location') === '/courses',
          `suplantando a un alumno, / debería llevar a /courses; llevó a ${comoAlumno.headers.get('location')}`);

        const salida = await client.get(c.actor, '/exit-impersonate', { expectStatus: 302 });
        assert(salida.headers.get('location') === '/',
          `salir de la suplantación debería ir a / (que reparte por rol); fue a ${salida.headers.get('location')}`);

        const vuelta = await client.get(c.actor, '/', { expectStatus: 302 });
        assert(vuelta.headers.get('location') === c.panel,
          `${c.actor} debería volver a ${c.panel}, volvió a ${vuelta.headers.get('location')}`);
      }
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
  {
    id: 'superadmin-monitor-disk',
    title: 'El monitor reporta el uso de disco y el desglose de lo almacenado',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/monitor/stats', { expectStatus: 200 });
      const d = res.json.disk;
      assert(d, 'el payload debería incluir la sección disk');

      // Espacio del volumen (fs.statfs). Si el sistema no lo soporta, disponible:false
      // y el resto tiene que seguir viniendo igual.
      if (d.volumen.disponible) {
        assert(d.volumen.total > 0, 'el volumen debería reportar tamaño total');
        assert(d.volumen.usado + d.volumen.libre <= d.volumen.total + 1,
          'usado + libre no puede superar el total');
        assert(d.volumen.porcentaje >= 0 && d.volumen.porcentaje <= 100,
          `el porcentaje debería estar entre 0 y 100, fue ${d.volumen.porcentaje}`);
      }

      // Desglose de carpetas administradas por la app
      assert(Array.isArray(d.carpetas) && d.carpetas.length >= 2,
        'debería desglosar al menos entregas y materiales');
      d.carpetas.forEach(c => {
        assert(typeof c.bytes === 'number' && c.bytes >= 0, `${c.id}: bytes inválido`);
        assert(typeof c.archivos === 'number' && c.archivos >= 0, `${c.id}: conteo inválido`);
      });

      // El resto del monitor no debe verse afectado por la sección nueva
      ['users', 'memory', 'load', 'heap', 'uptime'].forEach(k => {
        assert(k in res.json, `el monitor perdió la sección "${k}"`);
      });
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

  // ── Auditoría (fase 2: cobertura de todas las categorías nuevas) ──────────
  // Este spec corre AL FINAL del flujo (justo antes de cleanup), así ya se
  // dispararon eventos de: activity/submission/announcement/course/user/
  // suggestion/system/course.delete → todas las categorías instrumentadas.
  {
    id: 'audit-full-coverage',
    title: 'El panel muestra al menos una acción de cada categoría instrumentada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const extractTotal = (html) => {
        const m = html.match(/([\d.]+) evento/);
        if (!m) throw new Error('no se encontró el contador "X eventos" en el HTML');
        return parseInt(m[1].replace(/\./g, ''), 10);
      };

      // Cada categoría debería tener >= 1 evento por lo que ya corrió antes.
      const categorias = ['activity', 'submission', 'announcement', 'course', 'user', 'suggestion'];
      for (const cat of categorias) {
        const res = await client.get('admin', `/admin/audit?category=${cat}`, { expectStatus: 200 });
        const total = extractTotal(res.text);
        assert(total > 0, `categoría "${cat}" debería tener al menos 1 evento (encontré ${total})`);
      }
    },
  },
  {
    id: 'audit-search-filter',
    title: 'El filtro de búsqueda por texto encuentra eventos del smoke actual',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Los targets del smoke tienen "Smoke" o "smoke" en su nombre (Materia Smoke, etc.)
      const res = await client.get('admin', '/admin/audit?q=Smoke', { expectStatus: 200 });
      const match = res.text.match(/([\d.]+) evento/);
      assert(match && parseInt(match[1].replace(/\./g, ''), 10) > 0,
        'la búsqueda por "Smoke" debería devolver eventos');
    },
  },
  {
    id: 'audit-superadmin-sees-system-events',
    title: 'El superadmin ve los eventos de sistema (mantenimiento) en su panel',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/audit?category=system', { expectStatus: 200 });
      const match = res.text.match(/([\d.]+) evento/);
      const total = match ? parseInt(match[1].replace(/\./g, ''), 10) : 0;
      // maintenance_on + maintenance_off del spec de mantenimiento
      assert(total >= 2, `deberían haber al menos 2 eventos de sistema (mantenimiento on/off), encontré ${total}`);
    },
  },

  // ── Preceptoría: alcance por divisiones y administración de alumnos ──────
  // El preceptor solo ve/administra las divisiones que un admin le asignó. Lo que se
  // verifica acá es sobre todo la BARRERA: que un id fuera de su alcance devuelva 403 en
  // lectura y en escritura, porque es lo único que separa a un preceptor de los datos de
  // los cursos que no tiene a cargo.
  {
    id: 'admin-create-second-division',
    title: 'El admin crea una segunda división (quedará FUERA del alcance del preceptor)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-B-${RUN_ID}` },
        expectStatus: 201,
      });
      state.otherDivisionId = res.json.division._id;
    },
  },
  {
    id: 'admin-create-third-division',
    title: 'El admin crea una tercera división (SÍ asignada al preceptor, como destino de traslados)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-C-${RUN_ID}` },
        expectStatus: 201,
      });
      state.thirdDivisionId = res.json.division._id;
    },
  },
  {
    id: 'admin-create-preceptor',
    title: 'El admin da de alta un preceptor con una sola división a cargo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('admin', '/admin/users/create', {
        body: {
          name: preceptor.name, email: `scoped.${preceptor.email}`,
          password: preceptor.password, role: 'preceptor', dni: dniSmoke(8),
          allDivisions: false, divisionIds: [state.divisionId, state.thirdDivisionId],
        },
        expectStatus: 201,
      });
      state.preceptorId    = res.json.user._id;
      state.preceptorEmail = `scoped.${preceptor.email}`;
      assert(res.json.user.assignedDivisions.length === 2,
        `el preceptor debería quedar con 2 divisiones asignadas, tiene ${res.json.user.assignedDivisions.length}`);
      assert(res.json.user.allDivisions === false, 'allDivisions debería quedar en false');
    },
  },
  {
    id: 'preceptor-login',
    title: 'El preceptor inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('preceptor', '/login', {
        body: { email: state.preceptorEmail, password: preceptor.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'preceptor-sees-only-assigned-divisions',
    title: 'El panel del preceptor muestra solo la división asignada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('preceptor', '/preceptor', { expectStatus: 200 });
      assert(res.text.includes(`SMOKE-${RUN_ID}`), 'debería listar la división asignada');
      assert(!res.text.includes(`SMOKE-B-${RUN_ID}`), 'NO debería listar la división ajena');
    },
  },
  {
    id: 'preceptor-opens-assigned-division',
    title: 'El preceptor abre su división y ve materias y alumnos',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('preceptor', `/preceptor/divisions/${state.divisionId}`, { expectStatus: 200 });
      assert(res.text.includes('Materias y docentes'), 'debería mostrar la tabla de materias con sus docentes');
      assert(res.text.includes('Agregar alumno'), 'debería ofrecer el alta de alumno');
    },
  },
  {
    id: 'preceptor-blocked-outside-scope',
    title: 'El preceptor recibe 403 en una división fuera de su alcance (lectura y escritura)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('preceptor', `/preceptor/divisions/${state.otherDivisionId}`, { expectStatus: 403 });
      await client.post('preceptor', `/preceptor/divisions/${state.otherDivisionId}/students`, {
        body: { name: 'No debería crearse', email: `intruso.${RUN_ID}@example.com`, password: 'SmokeTest1234' },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'preceptor-blocked-from-other-panels',
    title: 'El preceptor no entra a los paneles de admin ni de directivo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('preceptor', '/admin/users', { expectStatus: 403 });
      await client.get('preceptor', '/directivo',   { expectStatus: 403 });
    },
  },
  {
    id: 'preceptor-cannot-create-course',
    title: 'El preceptor no puede crear materias',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('preceptor', '/courses/create', {
        body: { name: `Materia trucha ${RUN_ID}`, divisionId: state.divisionId },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'preceptor-creates-student',
    title: 'El preceptor da de alta un alumno y queda matriculado en las materias de la división',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/divisions/${state.divisionId}/students`, {
        body: {
          name: preceptorStudent.name, email: preceptorStudent.email,
          password: preceptorStudent.password, dni: dniSmoke(11),
        },
        expectStatus: 201,
      });
      state.preceptorStudentId = res.json.user._id;
      assert(res.json.user.role === 'student', `el alta del preceptor debe crear un alumno, creó ${res.json.user.role}`);
      // El curso del smoke vive en esta división, así que la matrícula tiene que haberlo alcanzado.
      assert(res.json.enrolledIn >= 1, `debería quedar inscripto en al menos 1 materia, quedó en ${res.json.enrolledIn}`);
    },
  },
  {
    id: 'preceptor-blocked-unenroll-with-submissions',
    title: 'El preceptor NO puede sacar del curso a un alumno que ya entregó (409)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // scopedStudent entregó en la actividad del smoke (spec activity-submit), y su curso
      // está en la división que el preceptor tiene a cargo. Mismo criterio que rige para
      // los docentes en DELETE /courses/:id/students/:studentId.
      if (!state.scopedStudentId) return;
      await client.post('preceptor', `/preceptor/students/${state.scopedStudentId}/unenroll`, {
        body: { divisionId: state.divisionId },
        expectStatus: 409,
      });
      // El destino tiene que estar dentro del alcance, si no la ruta corta antes con 403
      // y nunca se llega a evaluar la guarda de entregas, que es lo que este spec prueba.
      await client.post('preceptor', `/preceptor/students/${state.scopedStudentId}/move`, {
        body: { fromDivisionId: state.divisionId, toDivisionId: state.thirdDivisionId },
        expectStatus: 409,
      });
    },
  },
  {
    id: 'preceptor-unenroll-rejects-outside-scope',
    title: 'Sacar o mover hacia un curso fuera del alcance devuelve 403',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // otherDivisionId existe pero NO está asignada al preceptor (ver admin-create-preceptor).
      await client.post('preceptor', `/preceptor/students/${state.preceptorStudentId}/unenroll`, {
        body: { divisionId: state.otherDivisionId },
        expectStatus: 403,
      });
      await client.post('preceptor', `/preceptor/students/${state.preceptorStudentId}/move`, {
        body: { fromDivisionId: state.divisionId, toDivisionId: state.otherDivisionId },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'preceptor-edits-and-disables-student',
    title: 'El preceptor edita los datos de su alumno y deshabilita la cuenta',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('preceptor', `/preceptor/students/${state.preceptorStudentId}/edit`, {
        body: {
          name: 'Smoke Preceptor Student EDITADO', email: preceptorStudent.email,
          dni: dniSmoke(11), phone: '2615550000',
        },
        expectStatus: 200,
      });
      const res = await client.post('preceptor', `/preceptor/students/${state.preceptorStudentId}/toggle-active`,
        { expectStatus: 200 });
      assert(res.json.active === false, 'la cuenta debería quedar deshabilitada');
    },
  },
  {
    id: 'preceptor-unenrolls-student',
    title: 'El preceptor saca del curso a un alumno sin entregas y la cuenta sobrevive',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/students/${state.preceptorStudentId}/unenroll`, {
        body: { divisionId: state.divisionId },
        expectStatus: 200,
      });
      assert(res.json.removed >= 1, `debería salir de al menos 1 materia, salió de ${res.json.removed}`);

      // Sacarlo del curso NO borra la cuenta: la ficha tiene que seguir abriendo... salvo
      // que al quedarse sin materias caiga fuera del alcance del preceptor, que es
      // justamente lo que pasa. El admin sí la sigue viendo.
      await client.get('admin', `/admin/users/${state.preceptorStudentId}`, { expectStatus: 200 });
    },
  },
  {
    id: 'preceptor-cannot-touch-student-outside-scope',
    title: 'El preceptor no puede editar un alumno que no está en sus divisiones',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // OJO con elegir el alumno de prueba acá: scopedStudent NO sirve, porque el spec
      // course-add-student lo matricula en el curso del smoke, que vive en la división
      // asignada al preceptor — o sea, está legítimamente dentro de su alcance.
      // Un alumno sin ninguna matrícula no pertenece a ninguna división, y ese es el caso
      // que hay que probar. `dniNormalizedId` se crea sin divisionId más arriba.
      if (!state.dniNormalizedId) return;
      const ajeno = state.dniNormalizedId;
      await client.get('preceptor', `/preceptor/students/${ajeno}`, { expectStatus: 403 });
      await client.post('preceptor', `/preceptor/students/${ajeno}/edit`, {
        body: { name: 'No debería cambiar', email: `dnipuntos.${RUN_ID}@example.com`, dni: dniSmoke(14) },
        expectStatus: 403,
      });
      await client.post('preceptor', `/preceptor/students/${ajeno}/toggle-active`, { expectStatus: 403 });
    },
  },
  {
    id: 'preceptor-role-not-self-assignable',
    title: 'Nadie puede auto-registrarse como preceptor (queda como alumno)',
    async run({ client, state, assert }) {
      const res = await client.post(null, '/register', {
        body: {
          name: 'Smoke Fake Preceptor', email: `fake.preceptor.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'preceptor', dni: dniSmoke(9),
          // Cae a rol alumno, y el alumno necesita curso para registrarse: sin esto el
          // POST devolvería 400 y el spec no llegaría a probar lo que quiere probar.
          divisionId: state.selfEnrollDivisionId,
        },
        expectStatus: 201,
      });
      // Queda sin escuela, igual que los usuarios de Nivel 1: el admin no puede borrarlo
      // (su delete exige misma escuela), así que se limpia junto a ellos desde Mongo.
      state.fakePreceptorId = res.json.user._id;
      assert(res.json.user.role === 'student',
        `el rol preceptor no debe ser auto-asignable, quedó como ${res.json.user.role}`);
    },
  },

  // ── Limpieza (Nivel 2): borra todo lo que creó esta corrida ───────────────
  {
    id: 'cleanup-preceptor',
    title: 'Limpieza: el admin borra el preceptor, su alumno y la segunda división',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.preceptorStudentId) await client.post('admin', `/admin/users/${state.preceptorStudentId}/delete`, { expectStatus: 200 });
      if (state.preceptorId)        await client.post('admin', `/admin/users/${state.preceptorId}/delete`, { expectStatus: 200 });
      if (state.dniNormalizedId)    await client.post('admin', `/admin/users/${state.dniNormalizedId}/delete`, { expectStatus: 200 });
      if (state.otherDivisionId)    await client.post('admin', `/admin/divisions/${state.otherDivisionId}/delete`, { expectStatus: 200 });
      if (state.thirdDivisionId)    await client.post('admin', `/admin/divisions/${state.thirdDivisionId}/delete`, { expectStatus: 200 });
    },
  },
  {
    // ── Fusión de docentes duplicados por DNI (/superadmin/otros) ────────────
    // Reproduce el caso real: la cuenta vieja con el mail personal tiene las materias y la
    // institucional está vacía. El DNI se guarda con puntos en una y sin puntos en la otra,
    // que es como conviven en la base pese al índice único { school, dni }.
    id: 'docentes-dup-setup',
    title: 'Se arman dos cuentas de docente con el mismo DNI (una con materia, otra vacía)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state }) {
      const dni = dniSmoke(17);
      state.dupDni = dni;

      const conMateria = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Dup Personal ${RUN_ID}`, email: `dup.personal.${RUN_ID}@example.com`,
                password: 'SmokeTest1234', role: 'teacher', dni },
        expectStatus: 201,
      });
      state.dupConMateriaId = conMateria.json.user._id;

      const vacia = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Dup Institucional ${RUN_ID}`, email: `dup.institucional.${RUN_ID}@example.com`,
                password: 'SmokeTest1234', role: 'teacher', dni: dniSmoke(18) },
        expectStatus: 201,
      });
      state.dupVaciaId = vacia.json.user._id;

      const curso = await client.post('admin', '/admin/courses/create', {
        body: { name: `Materia Dup Smoke ${RUN_ID}`, divisionId: state.divisionId, teacherId: state.dupConMateriaId },
        expectStatus: 201,
      });
      state.dupCourseId = curso.json.course._id;

      // El DNI repetido va directo a Mongo: por la ruta de alta no entra (normalizeDni le
      // saca los puntos y ahí sí choca contra el índice único).
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        await mongo.db().collection('users').updateOne(
          { _id: new ObjectId(state.dupVaciaId) },
          { $set: { dni: `${dni.slice(0, 2)}.${dni.slice(2, 5)}.${dni.slice(5)}` } },
        );
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'docentes-dup-diagnostico',
    title: 'El panel Otros detecta el DNI repetido aunque esté escrito con puntos',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin', '/superadmin/otros/docentes-dni-duplicado/diagnostico', { expectStatus: 200 });
      const grupo = (res.json.grupos || []).find(g => g.dni === state.dupDni.replace(/^0+/, ''));
      assert(grupo, `debería detectar el grupo del DNI ${state.dupDni}`);
      assert(grupo.cuentas.length === 2, `el grupo debería tener 2 cuentas, tiene ${grupo.cuentas.length}`);
      state.dupClave = grupo.clave;

      const conMateria = grupo.cuentas.find(c => c.id === state.dupConMateriaId);
      assert(conMateria.titular === 1, `la cuenta vieja debería figurar con 1 materia, figura con ${conMateria.titular}`);
      assert(grupo.sugeridaId === state.dupConMateriaId, 'la sugerida debería ser la que tiene la materia');
    },
  },
  {
    id: 'docentes-dup-rechaza-cuenta-ajena',
    title: 'Fusionar hacia una cuenta que no es del grupo se rechaza',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state }) {
      // Sin esto, un id copiado a mano podría llevarse materias de una persona a otra.
      await client.post('superadmin', '/superadmin/otros/docentes-dni-duplicado/fusionar', {
        body: { clave: state.dupClave, keepId: state.scopedStudentId },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'docentes-dup-fusion',
    title: 'Se elige la cuenta institucional y se le transfiere la materia de la otra',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      // A propósito se conserva la cuenta VACÍA: es el caso que no se puede automatizar
      // (quedarse con el mail institucional aunque las materias estén en el otro).
      const res = await client.post('superadmin', '/superadmin/otros/docentes-dni-duplicado/fusionar', {
        body: { clave: state.dupClave, keepId: state.dupVaciaId, sobrante: 'deshabilitar' },
        expectStatus: 200,
      });
      assert(/1 materia\(s\) como titular/.test(res.json.mensaje), `debería informar la materia transferida — dijo: ${res.json.mensaje}`);

      // La materia quedó a nombre de la cuenta elegida.
      const listado = await client.get('admin', `/admin/courses?search=${encodeURIComponent('Materia Dup Smoke ' + RUN_ID)}`, { expectStatus: 200 });
      assert(listado.text.includes(`Smoke Dup Institucional ${RUN_ID}`),
        'el listado de materias debería mostrar a la cuenta institucional como docente');

      // La sobrante quedó deshabilitada: no puede iniciar sesión.
      await client.post('dupSobrante', '/login', {
        body: { email: `dup.personal.${RUN_ID}@example.com`, password: 'SmokeTest1234' },
        expectStatus: [400, 401, 403],
      });

      // Y el grupo ya no figura como duplicado pendiente.
      const despues = await client.get('superadmin', '/superadmin/otros/docentes-dni-duplicado/diagnostico', { expectStatus: 200 });
      assert(!(despues.json.grupos || []).some(g => g.clave === state.dupClave),
        'el grupo fusionado no debería seguir apareciendo');
    },
  },
  {
    // El caso que más se usa en la práctica: quedarse con la cuenta que YA tiene las
    // materias (así no se mueve nada) pero con el correo institucional, que está en la otra.
    // Como User.email es único global, las dos cuentas se INTERCAMBIAN el correo.
    id: 'docentes-dup-email-setup',
    title: 'Se arma un segundo par duplicado para probar la elección de correo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state }) {
      const dni = dniSmoke(19);
      state.dupMailDni = dni;
      state.dupMailViejo = `dup.mail.viejo.${RUN_ID}@example.com`;
      state.dupMailNuevo = `dup.mail.institucional.${RUN_ID}@example.com`;

      const vieja = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Dup Mail Vieja ${RUN_ID}`, email: state.dupMailViejo,
                password: 'SmokeTest1234', role: 'teacher', dni },
        expectStatus: 201,
      });
      state.dupMailViejaId = vieja.json.user._id;

      const nueva = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Dup Mail Nueva ${RUN_ID}`, email: state.dupMailNuevo,
                password: 'OtraClave1234', role: 'teacher', dni: dniSmoke(20) },
        expectStatus: 201,
      });
      state.dupMailNuevaId = nueva.json.user._id;

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        await mongo.db().collection('users').updateOne(
          { _id: new ObjectId(state.dupMailNuevaId) },
          { $set: { dni: `${dni.slice(0, 2)}.${dni.slice(2, 5)}.${dni.slice(5)}` } },
        );
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'docentes-dup-elige-correo',
    title: 'Se conserva una cuenta y se le pasa el correo de la otra (se intercambian)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      const diag = await client.get('superadmin', '/superadmin/otros/docentes-dni-duplicado/diagnostico', { expectStatus: 200 });
      const grupo = (diag.json.grupos || []).find(g => g.dni === state.dupMailDni.replace(/^0+/, ''));
      assert(grupo, 'debería detectar el segundo par duplicado');

      // Un correo que no es de ninguna cuenta del grupo se rechaza.
      await client.post('superadmin', '/superadmin/otros/docentes-dni-duplicado/fusionar', {
        body: { clave: grupo.clave, keepId: state.dupMailViejaId, emailId: state.scopedStudentId },
        expectStatus: 400,
      });

      const res = await client.post('superadmin', '/superadmin/otros/docentes-dni-duplicado/fusionar', {
        body: { clave: grupo.clave, keepId: state.dupMailViejaId, emailId: state.dupMailNuevaId, sobrante: 'deshabilitar' },
        expectStatus: 200,
      });
      assert(res.json.mensaje.includes(state.dupMailNuevo), `el mensaje debería informar el correo nuevo — dijo: ${res.json.mensaje}`);

      // La cuenta conservada entra con el correo adoptado y SU contraseña de siempre.
      await client.post('dupMailConservada', '/login', {
        body: { email: state.dupMailNuevo, password: 'SmokeTest1234' },
        expectStatus: 200,
      });

      // Y el correo viejo quedó en la cuenta deshabilitada, que no puede iniciar sesión.
      await client.post('dupMailSobrante', '/login', {
        body: { email: state.dupMailViejo, password: 'OtraClave1234' },
        expectStatus: [400, 401, 403],
      });
    },
  },
  {
    id: 'docentes-dup-cleanup',
    title: 'Limpieza: se borran la materia y las dos cuentas duplicadas de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.dupMailViejaId) await client.post('admin', `/admin/users/${state.dupMailViejaId}/delete`, { expectStatus: 200 });
      if (state.dupMailNuevaId) await client.post('admin', `/admin/users/${state.dupMailNuevaId}/delete`, { expectStatus: 200 });
      // La materia se borra ACÁ y no en la limpieza final: los specs de matrícula por
      // división cuentan las materias de state.divisionId y esperan una sola.
      if (state.dupCourseId)      await client.post('admin', `/admin/courses/${state.dupCourseId}/delete`, { expectStatus: 200 });
      if (state.dupVaciaId)       await client.post('admin', `/admin/users/${state.dupVaciaId}/delete`, { expectStatus: 200 });
      if (state.dupConMateriaId)  await client.post('admin', `/admin/users/${state.dupConMateriaId}/delete`, { expectStatus: 200 });
    },
  },
  {
    // Regresión del 2026-08-03: en producción /admin/courses tiraba 500 para el admin.
    // Dos materias tenían `owner` apuntando a un usuario ya borrado; populate() devolvía
    // null y la vista hacía `c.owner._id`. Peor: idToString() en models/Course.js reventaba
    // con null, así que isTeacher()/canManage() fallaban y la materia quedaba inaccesible
    // para TODOS los roles, no solo en el panel.
    id: 'owner-huerfano-no-rompe-el-panel',
    title: 'Una materia con el docente titular borrado no rompe /admin/courses ni la ficha del curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      const HUERFANO = new ObjectId('000000000000000000000000'); // no existe ningún usuario así
      try {
        await mongo.connect();
        const courses = mongo.db().collection('courses');
        await courses.updateOne({ _id: new ObjectId(state.courseId) }, { $set: { owner: HUERFANO } });

        const listado = await client.get('admin', `/admin/courses?search=${encodeURIComponent('Materia Smoke ' + RUN_ID)}`, { expectStatus: 200 });
        assert(listado.text.includes('Sin docente'), 'el listado debería marcar la materia como "Sin docente"');

        // canManage() con el owner colgado: el admin de la escuela sigue entrando.
        await client.get('admin', `/courses/${state.courseId}`, { expectStatus: 200 });

        await courses.updateOne(
          { _id: new ObjectId(state.courseId) },
          { $set: { owner: new ObjectId(state.scopedTeacherId) } },
        );
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'delete-docente-titular-bloqueado',
    title: 'No se puede borrar a un docente que es titular de materias (409)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es la causa raíz del bug de arriba: borrar al titular dejaba la referencia colgada.
      const res = await client.post('admin', `/admin/users/${state.scopedTeacherId}/delete`, { expectStatus: 409 });
      assert(/titular de \d+ materia/.test(res.json?.error || ''), `el error debería decir de cuántas materias es titular — fue: ${res.json?.error}`);
      // Y no lo borró: el spec de limpieza de más abajo cuenta con que siga existiendo.
      await client.get('admin', `/admin/users/${state.scopedTeacherId}`, { expectStatus: 200 });
    },
  },
  {
    id: 'cleanup-course',
    title: 'Limpieza: el admin borra el curso de prueba (cascada)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Las materias del código de clase van primero: la división ajena no se puede borrar
      // mientras tenga una materia adentro, y su limpieza está en el spec de abajo.
      if (state.joinCourseId)      await client.post('admin', `/admin/courses/${state.joinCourseId}/delete`, { expectStatus: 200 });
      if (state.joinOtherCourseId) await client.post('admin', `/admin/courses/${state.joinOtherCourseId}/delete`, { expectStatus: 200 });
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
      if (state.loneStudentId)   await client.post('admin', `/admin/users/${state.loneStudentId}/delete`, { expectStatus: 200 });
      if (state.divisionId)      await client.post('admin', `/admin/divisions/${state.divisionId}/delete`, { expectStatus: 200 });
      if (state.joinOtherDivisionId) await client.post('admin', `/admin/divisions/${state.joinOtherDivisionId}/delete`, { expectStatus: 200 });
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
  {
    // Los usuarios de Nivel 1 se autoregistran (no los crea el admin), así que no hay
    // ruta que los borre: el DELETE del admin exige misma escuela y hasta el 2026-07-31
    // estos quedaban sin ninguna. Ahora el alumno elige curso al registrarse, así que
    // además de la cuenta hay que sacarlo de las materias REALES donde quedó inscripto —
    // si no, el docente ve un alumno de prueba en su lista de la base local.
    id: 'cleanup-self-registered-db',
    title: 'Limpieza: borra los usuarios autoregistrados y su matrícula',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const ids = [state.teacherId, state.studentId, state.fakePreceptorId]
        .filter(Boolean).map(s => new ObjectId(s));
      if (!ids.length) return;

      const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();
        await client.db().collection('courses').updateMany(
          { students: { $in: ids } },
          {
            $pull:  { students: { $in: ids } },
            $unset: Object.fromEntries(ids.map(id => [`enrollmentDates.${id}`, ''])),
          },
        );
        await client.db().collection('users').deleteMany({ _id: { $in: ids } });
      } finally {
        await client.close();
      }
    },
  },
  {
    // Los audit logs generados por esta corrida se identifican por dos vías:
    //  1. Los IDs reales de los recursos de smoke (curso, división, usuarios, actividad)
    //     — cualquier evento que los tenga en actor.userId o targets[].id se borra.
    //     Es el criterio más confiable: no depende de que el name/email siga formato.
    //  2. RUN_ID como fallback: cubre eventos donde el actor es un usuario de smoke
    //     (actor.email = scoped.smoke.*.<RUN_ID>@...) o donde el target lleva RUN_ID
    //     en el nombre (ej. "Materia Smoke <RUN_ID>").
    // Los eventos de sistema (backup/maintenance) del superadmin quedan porque
    // no contienen el RUN_ID ni ids de smoke; son 3 registros por corrida — inofensivos.
    id: 'cleanup-auditlogs-db',
    title: 'Limpieza: borra los audit logs generados por esta corrida',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state }) {
      // Delay corto: los logAudit son fire-and-forget (no await en la ruta),
      // así que los últimos disparados por cleanup-users-and-division / cleanup-course
      // pueden estar todavía en vuelo cuando llegamos acá. 500ms alcanza y sobra
      // para un insertOne local; sin esto quedan huérfanos hasta la próxima corrida.
      await new Promise(r => setTimeout(r, 500));

      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await client.connect();

        // IDs de recursos del smoke (los presentes; algunos pueden no estar si el spec falló)
        const idStrings = [
          state.scopedTeacherId, state.scopedStudentId, state.directivoId,
          state.courseId, state.divisionId, state.activityId,
          state.announcementId, state.teacherId, state.studentId,
          state.coTeacherId, state.coTeacherStudentId, state.coTeacherActivityId,
          state.preceptorId, state.preceptorStudentId, state.otherDivisionId,
          state.fakePreceptorId, state.dniNormalizedId, state.thirdDivisionId,
          state.joinCourseId, state.joinOtherCourseId, state.joinOtherDivisionId,
          state.dupConMateriaId, state.dupVaciaId, state.dupCourseId,
          state.dupMailViejaId, state.dupMailNuevaId,
        ].filter(Boolean);
        const ids = idStrings.map(s => new ObjectId(s));

        await client.db().collection('auditlogs').deleteMany({
          $or: [
            { 'actor.userId': { $in: ids } },
            { 'targets.id':   { $in: ids } },
            { 'actor.email':  { $regex: RUN_ID } },
            { 'targets.name': { $regex: RUN_ID } },
          ],
        });
      } finally {
        await client.close();
      }
    },
  },
];

module.exports = { specs, RUN_ID };
