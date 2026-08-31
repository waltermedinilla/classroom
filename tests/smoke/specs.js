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

// Todas dependencias que ya usa la app (routes/backup.js). Sirven para FABRICAR backups de
// prueba: los specs de preview necesitan un .tar.gz con un manifest controlado, y el que
// genera /download siempre trae las colecciones completas — justo el caso que NO hay que probar.
const tar  = require('tar');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// La lista REAL de colecciones que respalda el backup. Se importa —en vez de repetirla acá—
// para que el spec del preview derive de ella qué se va a vaciar: ver el comentario largo en
// 'backup-preview-accepts-backup-sin-colecciones-nuevas'.
const { COLLECTIONS } = require('../../routes/backup');

// Las 9 colecciones que ya existían cuando se congeló el formato de backup 1.0. Un backup de
// esa época las trae todas y no trae ninguna de las de sala en vivo (que nacieron después).
const COLECCIONES_V1 = {
  schools: 1, users: 10, courses: 2, activities: 3, submissions: 4,
  announcements: 1, suggestions: 0, divisions: 1, subjects: 5,
};

// Destino FTP que NO puede coincidir con ninguno guardado en la máquina donde corre el
// smoke: el puerto 1 de localhost no tiene a nadie escuchando (ECONNREFUSED inmediato, sin
// esperas de red) y el usuario es imposible. Lo segundo es lo que importa: la ruta solo
// reusa la contraseña guardada si host+puerto+usuario coinciden, así que con este destino
// los specs nunca llegan a disparar un envío real ni a pisar el ftp-destino.json del dueño.
const FTP_INEXISTENTE = {
  host: '127.0.0.1', puerto: 1, usuario: 'smoke-inexistente', modo: 'plano', directorio: '/',
};

// Arma un .tar.gz con pinta de backup real pero SOLO con el manifest adentro. Alcanza: el
// preview a propósito no desempaqueta db/ ni files/ (serían cientos de MB), lee el manifest
// y nada más. Así el fixture pesa unos bytes y no hay que commitear un binario en el repo.
async function backupSintetico(collections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-backup-'));
  try {
    const manifest = {
      version:     '1.0',
      createdAt:   new Date().toISOString(),
      appVersion:  '0.0.0-smoke',
      generatedBy: 'smoke@test',
      collections,
      files: { archivos: { count: 0, sizeBytes: 0 }, entregas: { count: 0, sizeBytes: 0 } },
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const tarPath = path.join(dir, 'backup.tar.gz');
    await tar.c({ gzip: true, cwd: dir, file: tarPath }, ['manifest.json']);
    return fs.readFileSync(tarPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// El día escolar sale del MISMO service que usa la app (services/liveRoom.js) y no de un
// toISOString() acá: la zona de la escuela tiene un solo dueño, y un test que se arma la fecha
// por su cuenta empieza a fallar de noche por un bug que no existe.
// AUTO_CLOSE_MS viene del mismo lugar por la misma razón: el spec envejece una sala "más allá
// del límite" sin repetir el número, así que ajustar la ventana no lo rompe.
const { diaEscolar, AUTO_CLOSE_MS } = require('../../services/liveRoom');

const RUN_ID = Date.now().toString(36);

// DNI de prueba, único por corrida y por índice. El DNI pasó a ser OBLIGATORIO en toda
// alta de usuario el 2026-07-30 (ver services/dni.js), así que cada spec que crea una
// cuenta necesita uno propio: el índice {school, dni} es único, y dos specs con el mismo
// número se pisarían entre sí. Los 6 dígitos del reloj + 2 del índice dan los 8 que valida
// normalizeDni y hacen la colisión entre corridas prácticamente imposible.
const DNI_BASE = Date.now() % 1000000;
const dniSmoke = (n) => `${String(DNI_BASE).padStart(6, '0')}${String(n).padStart(2, '0')}`;

// Lee el número del badge del sobre desde el HTML de cualquier página con header.
// Devuelve 0 cuando el badge no está (que es como se pinta el "nada sin leer").
//
// El badge es UNIFICADO: cuenta las sugerencias sin leer MÁS los mensajes sin leer del
// superadmin (ver server.js, res.locals.unreadInboxCount). Por eso los specs de mensajes no
// pueden asumir que arranca en cero — a esa altura del suite el alumno ya tiene una
// sugerencia sin leer de los specs de arriba. Se compara siempre contra una base tomada
// ANTES de enviar, que además verifica la aritmética de las dos fuentes juntas.
//
// Ojo: arriba de 9 el header pinta "9+" y el número exacto se pierde. En este suite la base
// es 1, así que nunca se llega ahí.
function badgeDelSobre(html) {
  const m = html.match(/id="inboxBadge"[^>]*>([^<]*)</);
  if (!m) return 0;
  const txt = m[1].trim();
  return txt === '9+' ? 9 : (parseInt(txt, 10) || 0);
}

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
const jefe = {
  name:     'Smoke Jefe',
  email:    `smoke.jefe.${RUN_ID}@example.com`,
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
    // ── Nivel 1: los dos actores base ────────────────────────────────────────
    // El registro público quedó CERRADO el 2026-08-23 (ver services/registroPublico.js):
    // estos dos ya no pueden autoregistrarse, así que entran por la única puerta que queda,
    // el alta administrativa.
    //
    // Se usa el SUPERADMIN y no el admin de escuela A PROPÓSITO: `POST /superadmin/users/create`
    // deja la cuenta con `school: null`, que es exactamente la semántica que tenían estos dos
    // cuando se autoregistraban. Con el alta del admin quedarían CON escuela y specs de más
    // abajo —los 403 de la sala, del adjunto ajeno, del alta de materia— pasarían a probar
    // otra cosa sin que nadie se entere.
    id: 'alta-teacher-por-superadmin',
    title: 'El superadmin da de alta al docente de prueba (el registro público está cerrado)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, env }) {
      // Login inline en vez de depender del spec `superadmin-login`, que corre 3000 líneas
      // más abajo: subirlo hasta acá reordenaría la cadena de `state` de media suite. El
      // login es idempotente, así que aquel spec sigue valiendo tal como está.
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      const res = await client.post('superadmin', '/superadmin/users/create', {
        body: {
          name: teacher.name, email: teacher.email, password: teacher.password,
          role: 'teacher', dni: dniSmoke(1),
        },
        expectStatus: 201,
      });
      state.teacherId = res.json.user._id;

      // El actor 'teacher' necesita su propia cookie: los specs de abajo entran como él.
      // Antes se la daba el 201 del registro; ahora hay que iniciar sesión de verdad.
      await client.post('teacher', '/login', {
        body: { email: teacher.email, password: teacher.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'alta-student-por-superadmin',
    title: 'El superadmin da de alta al alumno de prueba y el alumno elige su curso',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('superadmin', '/superadmin/users/create', {
        body: {
          name: student.name, email: student.email, password: student.password,
          role: 'student', dni: dniSmoke(2),
        },
        expectStatus: 201,
      });
      state.studentId = res.json.user._id;
      await client.post('student', '/login', {
        body: { email: student.email, password: student.password },
        expectStatus: 200,
      });

      // La automatrícula sigue viva, pero desde el 2026-08-23 su ÚNICA puerta es el panel
      // del alumno (services/selfEnroll.js): la otra era el formulario de registro y murió
      // con él. El id del curso se saca del panel mismo, que es de donde lo saca una
      // persona: si el <select> deja de pintarse, el spec falla acá y no en un 400 críptico.
      const panel  = await client.get('student', '/courses', { expectStatus: 200 });
      const bloque = (panel.text || '').split('autoMatriculaCurso')[1] || '';
      const opcion = bloque.match(/<option value="([a-f0-9]{24})"/i);
      assert(opcion, 'el panel del alumno sin materias no le ofrece ningún curso para elegir');
      state.selfEnrollDivisionId = opcion[1];

      const r = await client.post('student', '/courses/self-enroll', {
        body: { divisionId: opcion[1] },
        expectStatus: 200,
      });
      assert(r.json.materias > 0,
        `debería haber quedado inscripto en las materias del curso, quedó en ${r.json.materias}`);
    },
  },
  {
    // El cambio del 2026-08-23, probado por la puerta principal. Reemplaza al viejo
    // `register-student-requires-curso`, que verificaba el 400 del alumno que no elegía
    // curso al registrarse: ya no hay registro donde elegirlo.
    id: 'registro-publico-cerrado',
    title: 'El registro público está cerrado: /register no muestra formulario ni da de alta',
    async run({ client, assert }) {
      // La pantalla ya no existe para el que llega de un favorito viejo: se lo manda al login.
      const pagina = await client.get(null, '/register', { expectStatus: 302 });
      assert(/\/login/.test(pagina.headers.get('location') || ''),
        `GET /register debería redirigir a /login, mandó a ${pagina.headers.get('location')}`);

      // Y el POST no crea la cuenta ni con un cuerpo completo y válido — que es lo único
      // que importa: la pantalla es una comodidad, la ruta es la puerta.
      const alta = await client.post(null, '/register', {
        body: {
          name: 'Smoke Colado', email: `colado.registro.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'student', dni: dniSmoke(15),
        },
        expectStatus: 403,
      });
      assert(alta.json && alta.json.registroCerrado === true,
        `el 403 debería declarar registroCerrado; dijo ${JSON.stringify(alta.json)}`);

      // Y la pantalla de login ya no ofrece la puerta: sin esto el enlace podría quedar
      // pintado apuntando a una ruta que contesta 403, que es peor que no ofrecer nada.
      const login = await client.get(null, '/login', { expectStatus: 200 });
      assert(!/href="\/register"/.test(login.text || ''),
        'la pantalla de login no debería seguir ofreciendo "Crear cuenta nueva"');
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
    id: 'sesion-de-usuario-borrado',
    title: 'Una sesión cuyo usuario fue borrado va a /login, no revienta con 500',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, assert }) {
      // Bug de producción del 2026-08-11: `GET /courses` tiraba 500 con "Cannot read
      // properties of null (reading 'role')" en views/dashboard.ejs. La cookie dura 7 días,
      // así que a quien le borran la cuenta le queda un JWT PERFECTAMENTE VÁLIDO —
      // requireAuth solo miraba firma y vencimiento, lo dejaba pasar, y la vista se
      // encontraba con `res.locals.user` en null.
      const email = `smoke.borrado.${RUN_ID}@example.com`;
      const alta = await client.post('admin', '/admin/users/create', {
        body: { name: 'Smoke Borrado', email, password: student.password, role: 'student', dni: dniSmoke(34) },
        expectStatus: 201,
      });

      await client.post('fantasma', '/login', {
        body: { email, password: student.password },
        expectStatus: 200,
      });

      // ⚠️ NO hacer ningún request con el actor 'fantasma' entre el login y el borrado: el
      // userCache tiene TTL de 45 s por worker (middleware/cache.js), así que una sola
      // navegación dejaría al usuario cacheado y el borrado no se notaría hasta que expire
      // — el test pasaría sin haber ejercitado nada.
      //
      // Se borra DIRECTO en Mongo y no por la API a propósito: el DELETE del admin también
      // invalidaría la sesión, y lo que hay que reproducir es justamente la cookie que
      // sobrevive a su usuario.
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const r = await mongo.db().collection('users').deleteOne({ _id: new ObjectId(alta.json.user._id) });
        assert(r.deletedCount === 1, 'el usuario de prueba tendría que haberse borrado de la base');
      } finally {
        await mongo.close();
      }

      const res = await client.get('fantasma', '/courses');
      assert(res.status !== 500, 'una sesión huérfana no puede tirar 500: es el bug que este test cuida');
      assert(res.status === 302, `esperaba redirección a /login, recibió ${res.status}`);
      assert((res.headers.get('location') || '').includes('/login'),
        `esperaba que redirigiera a /login, redirigió a "${res.headers.get('location')}"`);
    },
  },
  {
    // Hasta el 2026-08-14 esta materia la creaba el propio docente por POST /courses/create.
    // Desde que esa ruta es lista blanca y el docente quedó afuera (decisión del usuario: el
    // docente no crea materias ni cursos), la da de alta el administrador y le asigna el
    // titular en el mismo POST. El resto de la suite no cambia: la materia queda con
    // `owner` = scopedTeacher, que es lo que necesitan los specs de más abajo.
    id: 'course-create',
    title: 'El administrador crea una materia y le asigna el docente titular',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('admin', '/admin/courses/create', {
        body: {
          name: `Materia Smoke ${RUN_ID}`, divisionId: state.divisionId,
          teacherId: state.scopedTeacherId, room: '101',
        },
        expectStatus: 201,
      });
      assert(res.json.course?.code?.length === 6, 'el curso debería tener un código de 6 caracteres');
      assert(String(res.json.course.owner) === String(state.scopedTeacherId),
        'el titular de la materia debería ser el docente, no el admin que la creó');
      state.courseId   = res.json.course._id;
      state.courseCode = res.json.course.code;
    },
  },
  {
    id: 'teacher-cannot-create-course',
    title: 'El docente no puede crear materias por POST directo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const nombre = `Materia del docente ${RUN_ID}`;
      await client.post('scopedTeacher', '/courses/create', {
        body: { name: nombre, divisionId: state.divisionId, room: '888' },
        expectStatus: 403,
      });
      const listado = await client.get('admin', '/admin/courses?search=Materia+del+docente',
        { expectStatus: 200 });
      assert(!listado.text.includes(nombre), 'la materia no debería haberse creado');
    },
  },
  {
    // El agujero 🔴 que estaba abierto desde el 2026-07-30, y el contracara del spec de
    // arriba: la misma ruta que el docente usa con todo derecho la aceptaba de CUALQUIERA
    // con sesión. El botón "Crear clase" nunca estuvo para el alumno, pero eso es la vista.
    // Y no es una materia de más: el que crea queda como `owner`, y desde ahí
    // `Course.isTeacher()` lo habilita a calificar, publicar novedades y agregar o sacar
    // alumnos de esa materia.
    //
    // Va acá y no junto a `preceptor-cannot-create-course` por una razón de la suite: para
    // esa altura el jar de `scopedStudent` está vacío (lo vacía `cache-invalidation-on-disable`,
    // ver la nota de `attendance-setup-actores`) y el POST daría 302 a /login en vez de 403,
    // que es un verde falso — pasaría igual con el agujero abierto.
    id: 'student-cannot-create-course',
    title: 'El alumno no puede crear materias por POST directo (y no queda como owner)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const nombre = `Materia del alumno ${RUN_ID}`;
      await client.post('scopedStudent', '/courses/create', {
        body: { name: nombre, divisionId: state.divisionId, room: '999' },
        expectStatus: 403,
      });

      // Que el 403 no sea lo único: la materia no tiene que existir. Si el rechazo llegara
      // DESPUÉS del Course.create, el alumno seguiría siendo owner igual.
      const listado = await client.get('admin', '/admin/courses?search=Materia+del+alumno',
        { expectStatus: 200 });
      assert(!listado.text.includes(nombre),
        'la materia no debería haberse creado: el rechazo tiene que ir ANTES del Course.create');
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
      // (se da de alta una materia después de que los alumnos ya estaban matriculados).
      const nueva = await client.post('admin', '/admin/courses/create', {
        body: {
          name: `Materia Codigo ${RUN_ID}`, divisionId: state.divisionId,
          teacherId: state.scopedTeacherId, room: '103',
        },
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

      const ajena = await client.post('admin', '/admin/courses/create', {
        body: {
          name: `Materia Ajena ${RUN_ID}`, divisionId: state.joinOtherDivisionId,
          teacherId: state.scopedTeacherId, room: '104',
        },
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
  /* ─── Auditoría de subidas de imagen (2026-08-24) ───
     specs/subidas-de-imagen.spec.md. Los dos specs de acá abajo son EL caso: antes del
     arreglo, una imagen con una extensión que el servidor no conocía se descartaba en
     silencio y la novedad se publicaba igual, con 201 y sin foto. No había cartel, ni línea
     en el log, ni código SUB — así que del lado del usuario "a veces no sube la imagen" era
     literalmente imposible de rastrear. */
  {
    id: 'novedad-imagen-rara-avisa-en-vez-de-descartar',
    title: 'Una imagen con formato no aceptado se rechaza con cartel, no se descarta callada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const foto = await fotoDePrueba(1200, 900);
      const fd = new FormData();
      fd.append('courseId', state.courseId);
      fd.append('text', 'Novedad con una imagen .bmp (smoke)');
      fd.append('image', new Blob([foto], { type: 'image/bmp' }), 'lamina.bmp');

      const res = await client.post('scopedTeacher', '/announcements/create', {
        form: fd, expectStatus: 400,
      });
      assert(/\.bmp/.test(res.json.error || ''), `el cartel tiene que nombrar la extensión: ${res.json.error}`);
      assert(/\.jpg/.test(res.json.error || ''), 'y enumerar lo que sí aceptamos');
    },
  },
  {
    id: 'novedad-imagen-jfif-entra',
    title: 'Un .jfif (lo que guarda Chrome en Windows) se acepta y sale como WebP',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // .jfif ES un JPEG: rechazarlo era fricción pura, y le pasaba a cualquiera que bajara
      // una lámina con "Guardar imagen como".
      const foto = await fotoDePrueba(2000, 1500);
      const fd = new FormData();
      fd.append('courseId', state.courseId);
      fd.append('text', 'Novedad con .jfif (smoke)');
      fd.append('image', new Blob([foto], { type: 'image/jpeg' }), 'lamina.jfif');

      const res = await client.post('scopedTeacher', '/announcements/create', {
        form: fd, expectStatus: 201,
      });
      const url = res.json.announcement.image;
      assert(url && url.endsWith('.webp'), `el .jfif debería quedar como .webp, quedó: ${url}`);

      await client.post('scopedTeacher', `/announcements/${res.json.announcement._id}/delete`,
        { expectStatus: 200 });
    },
  },
  {
    id: 'portada-imagen-rara-avisa',
    title: 'La portada de la materia también avisa en vez de guardar sin imagen',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Mismo bug que la novedad y por la misma causa: `if (req.file)` sin else. Acá el
      // síntoma era peor de leer — la docente apretaba Guardar, recibía 200 y la portada
      // seguía siendo la de antes.
      const foto = await fotoDePrueba(1600, 600);
      const fd = new FormData();
      fd.append('mode', 'image');
      fd.append('color', '#0d7377');
      fd.append('image', new Blob([foto], { type: 'image/bmp' }), 'portada.bmp');

      const res = await client.post('scopedTeacher', `/courses/${state.courseId}/customize`, {
        form: fd, expectStatus: 400,
      });
      assert(/\.bmp/.test(res.json.error || ''), `el cartel tiene que nombrar la extensión: ${res.json.error}`);
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
    id: 'activity-view-ping',
    title: 'Al abrir la actividad, el alumno queda registrado y el docente lo ve',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/activities/${state.activityId}/view`, { expectStatus: 200 });

      const res = await client.get('scopedTeacher', `/activities/${state.activityId}/views`, { expectStatus: 200 });
      assert(res.json.views.length === 1, `debería haber 1 registro de vista, hay ${res.json.views.length}`);
      const v = res.json.views[0];
      assert(v.student._id === state.scopedStudentId, 'el registro debería ser del alumno del suite');
      assert(v.viewCount === 1, `viewCount debería ser 1, es ${v.viewCount}`);
      assert(!!v.firstViewedAt, 'firstViewedAt debería estar seteado');
      state.firstViewedAt = v.firstViewedAt;
    },
  },
  {
    id: 'activity-view-idempotent',
    title: 'Reabrir la actividad incrementa el contador pero no crea otro registro',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/activities/${state.activityId}/view`, { expectStatus: 200 });

      const res = await client.get('scopedTeacher', `/activities/${state.activityId}/views`, { expectStatus: 200 });
      assert(res.json.views.length === 1, `debería seguir habiendo 1 registro, hay ${res.json.views.length}`);
      const v = res.json.views[0];
      assert(v.viewCount === 2, `viewCount debería ser 2, es ${v.viewCount}`);
      assert(v.firstViewedAt === state.firstViewedAt, 'firstViewedAt no debería cambiar al reabrir');
    },
  },
  {
    id: 'activity-views-forbidden-for-student',
    title: 'El alumno no puede ver quién abrió la actividad (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('scopedStudent', `/activities/${state.activityId}/views`, { expectStatus: 403 });
    },
  },
  {
    id: 'activity-view-count-in-list',
    title: 'El listado del docente trae el contador de aperturas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedTeacher', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const act = res.json.activities.find(a => a._id === state.activityId);
      assert(act, 'la actividad debería estar en el listado del docente');
      assert(act.viewedCount === 1, `viewedCount debería ser 1 (un alumno), es ${act.viewedCount}`);
    },
  },
  {
    id: 'activity-view-survives-unenrolled-student',
    title: 'El contador de aperturas ignora a un alumno que ya no está en el curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Un alumno desmatriculado deja su ActivityView en la base. Si el aggregate no lo
      // filtrara, el chip mostraría más vistos que alumnos inscriptos ("3/2").
      const otro = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Vista Suelta ${RUN_ID}`, email: `vista.suelta.${RUN_ID}@smoke.local`,
          password: student.password, role: 'student', dni: dniSmoke(21), divisionId: state.divisionId },
        expectStatus: 201,
      });
      const otroId = otro.json.user._id;

      await client.post('vistaSuelta', '/login', {
        body: { email: `vista.suelta.${RUN_ID}@smoke.local`, password: student.password },
        expectStatus: 200,
      });
      await client.post('vistaSuelta', `/activities/${state.activityId}/view`, { expectStatus: 200 });

      const antes = await client.get('scopedTeacher', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const actAntes = antes.json.activities.find(a => a._id === state.activityId);
      assert(actAntes.viewedCount === 2, `con los dos alumnos deberían ser 2 vistas, son ${actAntes.viewedCount}`);

      // Al borrar la cuenta, la cascada limpia su ActivityView y el contador vuelve a 1
      await client.post('admin', `/admin/users/${otroId}/delete`, { expectStatus: 200 });
      const despues = await client.get('scopedTeacher', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const actDespues = despues.json.activities.find(a => a._id === state.activityId);
      assert(actDespues.viewedCount === 1, `tras borrar la cuenta debería quedar 1 vista, quedan ${actDespues.viewedCount}`);
      assert(actDespues.viewedCount <= actDespues.totalStudents, 'nunca puede haber más vistos que alumnos');
    },
  },

  /* ─── Visibilidad: actividad programada + botón de ojo ───
     specs/visibilidad-actividades.spec.md. Trabajan sobre actividades PROPIAS y no sobre
     state.activityId, que la comparten los specs de entregas y notas que vienen después. */
  {
    id: 'visibilidad-crea-programada',
    title: 'El docente carga una actividad con "Disponible desde" a futuro',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Dos días adelante: el caso real es preparar hoy la clase del martes que viene.
      const enDosDias = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: {
          courseId: state.courseId, title: `Actividad programada ${RUN_ID}`, type: 'tarea',
          points: '10', availableFrom: enDosDias.toISOString(),
        },
        expectStatus: 201,
      });
      state.actProgramadaId = res.json.activity._id;
      assert(res.json.activity.visibleOverride == null,
        'una actividad recién creada no debería nacer con override manual');
    },
  },
  {
    id: 'visibilidad-programada-oculta-al-alumno',
    title: 'La programada no le figura al alumno, pero sí al docente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const alumno = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(!alumno.json.activities.some(a => a._id === state.actProgramadaId),
        'el alumno NO debería ver una actividad cuya fecha de publicación todavía no llegó');
      // Y la que sí está publicada tiene que seguir viéndose: el filtro nuevo no puede
      // llevarse puesto el resto del listado.
      assert(alumno.json.activities.some(a => a._id === state.activityId),
        'la actividad ya publicada debería seguir apareciendo');

      const docente = await client.get('scopedTeacher', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(docente.json.activities.some(a => a._id === state.actProgramadaId),
        'el docente tiene que ver TODAS sus actividades, programadas incluidas');
    },
  },
  {
    id: 'visibilidad-programada-rechaza-entrega',
    title: 'El alumno no puede entregar una actividad que todavía no ve (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Por la interfaz no llega; por link directo, sí. La guarda está en POST /submit.
      await client.post('scopedStudent', `/activities/${state.actProgramadaId}/submit`, {
        body: { text: 'entrega adelantada' }, expectStatus: 403,
      });
    },
  },
  {
    id: 'visibilidad-alumno-no-puede-togglear',
    title: 'El alumno no puede tocar la visibilidad de una actividad (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.patch('scopedStudent', `/activities/${state.actProgramadaId}/toggle-visibility`, {
        expectStatus: 403,
      });
    },
  },
  {
    id: 'visibilidad-ojo-adelanta-publicacion',
    title: 'El ojo publica la programada sin esperar a la fecha',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.patch('scopedTeacher', `/activities/${state.actProgramadaId}/toggle-visibility`, {
        expectStatus: 200,
      });
      assert(res.json.visibleOverride === true, `visibleOverride debería ser true, es ${res.json.visibleOverride}`);
      assert(res.json.estado === 'visible', `estado debería ser "visible", es "${res.json.estado}"`);

      const alumno = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(alumno.json.activities.some(a => a._id === state.actProgramadaId),
        'tras tocar el ojo, el alumno debería ver la actividad aunque la fecha sea futura');
    },
  },
  {
    id: 'visibilidad-ojo-vuelve-al-automatico',
    title: 'El segundo click la devuelve a programada, conservando la fecha',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const antes = await client.get('scopedTeacher', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const fechaAntes = antes.json.activities.find(a => a._id === state.actProgramadaId).availableFrom;

      const res = await client.patch('scopedTeacher', `/activities/${state.actProgramadaId}/toggle-visibility`, {
        expectStatus: 200,
      });
      // Lo importante: NO queda en false (oculta para siempre), vuelve al automático.
      assert(res.json.visibleOverride === null, `visibleOverride debería volver a null, es ${res.json.visibleOverride}`);
      assert(res.json.estado === 'programada', `estado debería ser "programada", es "${res.json.estado}"`);
      assert(new Date(res.json.availableFrom).getTime() === new Date(fechaAntes).getTime(),
        'la fecha programada no se puede perder al ir y volver con el ojo');

      const alumno = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(!alumno.json.activities.some(a => a._id === state.actProgramadaId),
        'vuelta al automático, el alumno no debería verla otra vez');
    },
  },
  {
    id: 'visibilidad-ojo-baja-una-publicada',
    title: 'El ojo también oculta una actividad que ya estaba publicada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Actividad aparte: bajar la del suite rompería los specs de entrega y notas.
      const creada = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: `Actividad a ocultar ${RUN_ID}`, type: 'tarea', points: '10' },
        expectStatus: 201,
      });
      const actId = creada.json.activity._id;

      const alumnoAntes = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(alumnoAntes.json.activities.some(a => a._id === actId), 'recién creada, el alumno debería verla');

      const off = await client.patch('scopedTeacher', `/activities/${actId}/toggle-visibility`, { expectStatus: 200 });
      assert(off.json.visibleOverride === false, `visibleOverride debería ser false, es ${off.json.visibleOverride}`);
      assert(off.json.estado === 'oculta', `estado debería ser "oculta", es "${off.json.estado}"`);

      const alumnoDespues = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(!alumnoDespues.json.activities.some(a => a._id === actId),
        'ocultada con el ojo, el alumno no debería verla aunque su fecha ya haya pasado');
      await client.post('scopedStudent', `/activities/${actId}/submit`, {
        body: { text: 'entrega a una oculta' }, expectStatus: 403,
      });

      // Y el tercer estado: volver a mostrarla deja el override en null, no en true.
      const on = await client.patch('scopedTeacher', `/activities/${actId}/toggle-visibility`, { expectStatus: 200 });
      assert(on.json.visibleOverride === null, `al volver a mostrarla debería quedar en null, es ${on.json.visibleOverride}`);
      assert(on.json.estado === 'visible', `estado debería ser "visible", es "${on.json.estado}"`);

      await client.delete('scopedTeacher', `/activities/${actId}`, { expectStatus: 200 });
    },
  },
  /* ─── Pendientes que caducan solos ───
     specs/pendientes-vencidos.spec.md. Actividades PROPIAS de este bloque —se crean con
     fechas viejas a mano y se borran al final—, para no tocar state.activityId, que la
     comparten los specs de entregas y notas.

     El caso que se está cubriendo: antes, "sin fecha de entrega" y "vencida con tardías
     abiertas" eran dos formas de quedar pendiente PARA SIEMPRE. Las dos actividades viejas
     de acá abajo fallan estos specs si se revierte public/js/pendienteActividad.js. */
  {
    id: 'pendientes-caducidad-alta',
    title: 'El docente carga las cuatro actividades del caso (viejas y nuevas)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const hace = d => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
      const crear = async (clave, titulo, body) => {
        const res = await client.post('scopedTeacher', '/activities/create', {
          body: { courseId: state.courseId, title: `${titulo} ${RUN_ID}`, type: 'tarea', points: '10', ...body },
          expectStatus: 201,
        });
        state[clave] = res.json.activity._id;
        state[clave + 'Titulo'] = `${titulo} ${RUN_ID}`;
      };

      // Vencidas. Las tardías se prenden después, con la ruta del docente.
      await crear('pendTardiaVieja',    'Vencida hace 20 dias',   { dueDate: hace(20) });
      await crear('pendTardiaReciente', 'Vencida hace 3 dias',    { dueDate: hace(3)  });
      // Sin fecha de entrega: lo que las separa es CUÁNDO se publicaron.
      await crear('pendSinFechaVieja',  'Sin fecha hace 20 dias', { availableFrom: hace(20) });
      await crear('pendSinFechaNueva',  'Sin fecha de hoy',       {});

      for (const clave of ['pendTardiaVieja', 'pendTardiaReciente']) {
        const res = await client.patch('scopedTeacher', `/activities/${state[clave]}/toggle-late`, {
          expectStatus: 200,
        });
        assert(res.json.allowLateSubmissions === true, `las tardías de ${clave} deberían quedar abiertas`);
      }
    },
  },
  {
    id: 'pendientes-caducidad-my-pending',
    title: 'A "Mis pendientes" solo llegan las que todavía están en ventana',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', '/activities/my-pending', { expectStatus: 200 });

      // Sin la caducidad estas dos figuraban para siempre: la vencida porque el docente dejó
      // las tardías abiertas, la sin fecha porque `if (!a.dueDate) return true`.
      assert(!res.text.includes(state.pendTardiaViejaTitulo),
        'una vencida hace 20 días no debería seguir siendo pendiente, aunque tenga tardías');
      assert(!res.text.includes(state.pendSinFechaViejaTitulo),
        'una sin fecha publicada hace 20 días ya pasó su ventana de 15');

      // Y las que sí: la gracia de 14 días de las tardías y la ventana de 15 de la sin fecha.
      assert(res.text.includes(state.pendTardiaRecienteTitulo),
        'una vencida hace 3 días con tardías abiertas tiene que seguir pendiente');
      assert(res.text.includes(state.pendSinFechaNuevaTitulo),
        'una sin fecha publicada hoy tiene que estar pendiente');

      // Y en ese orden: lo que tiene plazo arriba, lo que no lo tiene al final. Mongo ordena
      // los `null` PRIMERO, así que sin el sort en JS la sin fecha encabezaba la lista.
      assert(res.text.indexOf(state.pendTardiaRecienteTitulo) < res.text.indexOf(state.pendSinFechaNuevaTitulo),
        'la que tiene fecha de entrega tiene que figurar ANTES que la que no tiene');
    },
  },
  {
    id: 'pendientes-caducidad-no-cierra-la-puerta',
    title: 'La caducada sigue en la materia y se puede entregar igual',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Caducar el pendiente NO es ocultar la actividad ni cerrar la entrega: el alumno la
      // sigue teniendo en la solapa Actividades y, con las tardías abiertas, puede entregar.
      const curso = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      assert(curso.json.activities.some(a => a._id === state.pendTardiaVieja),
        'la vencida caducada tiene que seguir apareciendo en la materia');
      assert(curso.json.activities.some(a => a._id === state.pendSinFechaVieja),
        'la sin fecha caducada tiene que seguir apareciendo en la materia');

      await client.post('scopedStudent', `/activities/${state.pendTardiaVieja}/submit`, {
        body: { text: 'entrega tardía a una que ya no cuenta como pendiente' },
        expectStatus: 200,
      });
    },
  },
  /* ─── La entregada sale de lo pendiente ───
     specs/entrega-sale-de-pendientes.spec.md. Se apoya en las actividades del bloque de
     arriba: `pendTardiaVieja` ya viene entregada del spec anterior y `pendTardiaReciente`
     se entrega acá. Sin el arreglo, GET /activities/course/:id no le manda al alumno nada
     sobre su propia entrega y la tarjeta le sigue diciendo "Pendiente". */
  {
    id: 'entrega-sale-de-pendientes',
    title: 'Entregar saca la tarea de lo pendiente y le pone su fecha',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const delCurso = async () => {
        const res = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
        return Object.fromEntries(res.json.activities.map(a => [a._id, a]));
      };

      // Antes de entregar: el campo existe y viene vacío. Que exista importa tanto como su
      // valor — si el servidor no lo manda, el navegador no puede distinguir nada.
      const antes = await delCurso();
      assert('mySubmission' in antes[state.pendTardiaReciente],
        'el alumno tiene que recibir mySubmission en cada actividad del curso');
      assert(antes[state.pendTardiaReciente].mySubmission === null,
        'sin entregar, mySubmission tiene que venir en null');
      assert(antes[state.pendTardiaVieja].mySubmission,
        'la que entregó en el spec anterior tiene que venir con su entrega');
      assert(antes[state.pendTardiaVieja].mySubmission.at,
        'y con la fecha de la entrega, que es lo que se muestra en la tarjeta');

      // Y no se filtra nada de nadie: solo la fecha propia, nunca los archivos ni el texto.
      assert(!('files' in antes[state.pendTardiaVieja].mySubmission),
        'mySubmission es solo la fecha; los archivos van por GET /activities/:id/my-submission');

      // La que se va a entregar todavía figura como pendiente.
      const listaAntes = await client.get('scopedStudent', '/activities/my-pending', { expectStatus: 200 });
      assert(listaAntes.text.includes(state.pendTardiaRecienteTitulo),
        'antes de entregar tiene que estar en "Mis pendientes"');

      await client.post('scopedStudent', `/activities/${state.pendTardiaReciente}/submit`, {
        body: { text: 'la entrego y no me tiene que figurar más como pendiente' },
        expectStatus: 200,
      });

      const despues = await delCurso();
      assert(despues[state.pendTardiaReciente].mySubmission,
        'entregada, mySubmission tiene que venir cargada');
      assert(despues[state.pendTardiaReciente].mySubmission.at,
        'con su fecha: la tarjeta muestra "Entregado: <fecha>" en lugar de "Venció: ..."');

      const listaDespues = await client.get('scopedStudent', '/activities/my-pending', { expectStatus: 200 });
      assert(!listaDespues.text.includes(state.pendTardiaRecienteTitulo),
        'entregada, no puede seguir en "Mis pendientes": es el pedido del usuario');
    },
  },
  {
    id: 'pendientes-caducidad-contador-coincide',
    title: 'El cartel del inicio dice el mismo número que "Mis pendientes"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Las dos pantallas comparten sigueSiendoPendiente(). Si alguien vuelve a escribir la
      // regla a mano en una de las dos, este spec es el que se cae.
      const inicio = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      const lista  = await client.get('scopedStudent', '/activities/my-pending', { expectStatus: 200 });

      const m = inicio.text.match(/Ten[eé]s\s*<strong>\s*(\d+)\s*<\/strong>/);
      const enElCartel = m ? Number(m[1]) : 0;   // sin cartel = sin pendientes
      const enLaLista  = (lista.text.match(/class="pending-item /g) || []).length;

      assert(enElCartel === enLaLista,
        `el cartel dice ${enElCartel} y la lista muestra ${enLaLista}`);
    },
  },
  {
    id: 'pendientes-caducidad-limpieza',
    title: 'Se borran las cuatro actividades del caso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      for (const clave of ['pendTardiaVieja', 'pendTardiaReciente', 'pendSinFechaVieja', 'pendSinFechaNueva']) {
        await client.delete('scopedTeacher', `/activities/${state[clave]}`, { expectStatus: 200 });
      }
    },
  },
  {
    id: 'admin-task-settings-toggle',
    title: 'El admin prende y apaga el aviso de acuse de lectura',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      await client.get('admin', '/admin/tasks', { expectStatus: 200 });

      const on = await client.post('admin', '/admin/tasks/settings', {
        body: { key: 'showViewReceiptToStudents', value: true },
        expectStatus: 200,
      });
      assert(on.json.settings.showViewReceiptToStudents === true, 'el ajuste debería quedar en true');

      // Se deja apagado (el default del schema) para no alterar la escuela del entorno.
      const off = await client.post('admin', '/admin/tasks/settings', {
        body: { key: 'showViewReceiptToStudents', value: false },
        expectStatus: 200,
      });
      assert(off.json.settings.showViewReceiptToStudents === false, 'el ajuste debería quedar en false');
    },
  },
  {
    id: 'admin-task-settings-rejects-unknown-key',
    title: 'El panel de tareas rechaza una key fuera de la lista blanca (400)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('admin', '/admin/tasks/settings', {
        body: { key: 'role', value: 'superadmin' },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'admin-task-settings-forbidden-for-teacher',
    title: 'Un docente no puede tocar los ajustes de la escuela (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('scopedTeacher', '/admin/tasks/settings', {
        body: { key: 'showViewReceiptToStudents', value: true },
        expectStatus: 403,
      });
    },
  },

  // ── Telemetría del rate limit (/superadmin/monitor/ratelimit) ─────────────
  // Alimenta la sección "Rate limit" del monitor. Ver specs/monitor-ratelimit.spec.md.
  // Nació del 2026-08-13: el cupo se agotó corriendo dos suites seguidas y la única huella
  // de un 429 era una línea `warn` en el log.
  {
    id: 'monitor-ratelimit-shape',
    title: 'El monitor informa el cupo actual del rate limit y la serie acumulada',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, env, assert }) {
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      const res = await client.get('superadmin', '/superadmin/monitor/ratelimit?rango=1h', { expectStatus: 200 });
      const d = res.json;
      assert(d, 'debería responder JSON');

      // `ahora` sale de req.rateLimit: si el middleware de telemetría se desmontara del
      // server, o el limiter dejara de correr sobre /superadmin, esto se cae acá.
      assert(d.ahora, 'debería traer el cupo de la IP que consulta');
      assert(d.ahora.limite > 0, `el límite debería ser positivo, vino ${d.ahora.limite}`);
      assert(d.ahora.usado >= 1, 'este mismo request ya consume cupo, así que usado >= 1');
      assert(d.ahora.restante === d.ahora.limite - d.ahora.usado,
        `restante tiene que cerrar con limite - usado (${d.ahora.restante} vs ${d.ahora.limite - d.ahora.usado})`);
      assert(Array.isArray(d.serie), 'serie debería ser un array');
      assert(d.resumen, 'debería traer el resumen');
      assert(d.bucketMin === 1, `el rango 1h se agrupa por minuto, vino ${d.bucketMin}`);
    },
  },
  {
    id: 'monitor-ratelimit-counts-usage',
    title: 'El cupo consumido sube con cada petición, y el rango inválido no rompe',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const leer = async (rango = '1h') => (
        await client.get('superadmin', `/superadmin/monitor/ratelimit?rango=${rango}`, { expectStatus: 200 })
      ).json;

      const antes = await leer();
      await client.get('superadmin', '/superadmin/monitor', { expectStatus: 200 });
      const despues = await leer();

      // ⚠️ En PM2 cluster cada worker tiene SU contador, así que dos lecturas seguidas
      // pueden caer en workers distintos y el número bajaría sin que nada esté roto. El
      // smoke corre contra un server de un solo proceso (npm run dev / node server.js),
      // que es donde esta comparación tiene sentido.
      assert(despues.ahora.usado > antes.ahora.usado,
        `el consumo debería subir: antes ${antes.ahora.usado}, después ${despues.ahora.usado}`);

      // Basura en la query string: cae en 1h en vez de reventar el panel entero
      const raro = await leer('no-existe');
      assert(raro.rango === '1h', `un rango desconocido debería caer en 1h, vino ${raro.rango}`);
    },
  },
  {
    id: 'monitor-ratelimit-forbidden-for-admin',
    title: 'Un admin de escuela no puede ver la telemetría del rate limit (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('admin', '/superadmin/monitor/ratelimit', { expectStatus: 403 });
    },
  },

  // ── Permisos de solapas por rol (/superadmin/roles) ───────────────────────
  // El superadmin habilita/deshabilita, por escuela, qué solapa ve y puede abrir cada rol
  // (config/sections.js + middleware/sections.js). Todos estos specs dejan la escuela como
  // la encontraron: usan try/finally o restablecen explícitamente al final.
  {
    id: 'roles-screen-loads',
    title: 'La pantalla de Roles carga con la grilla de secciones',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env, assert }) {
      // Login propio del actor 'superadmin': el spec genérico vive más abajo en el archivo
      // (mismo motivo que en suggestions-superadmin-can-respond).
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      // La escuela sobre la que se prueba es la del admin de las credenciales, no la
      // primera de la lista: los asserts de bloqueo se verifican con ese mismo admin.
      const { MongoClient } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const admin = await mongo.db().collection('users').findOne({ email: env.SMOKE_ADMIN_EMAIL });
        assert(admin && admin.school, `el admin ${env.SMOKE_ADMIN_EMAIL} debería tener una escuela asignada`);
        state.rolesSchoolId = admin.school.toString();
      } finally {
        await mongo.close();
      }

      const res = await client.get('superadmin', `/superadmin/roles?school=${state.rolesSchoolId}`, { expectStatus: 200 });
      assert(res.text.includes('admin_import'), 'la grilla debería incluir la sección admin_import');
      assert(res.text.includes('/superadmin/roles/toggle'), 'la pantalla debería traer el JS que guarda los toggles');
    },
  },
  {
    id: 'roles-toggle-hides-and-blocks',
    title: 'Apagar una solapa la saca del menú Y bloquea su URL y sus acciones (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      const toggle = (enabled) => client.post('superadmin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role: 'admin', key: 'admin_import', enabled },
        expectStatus: 200,
      });

      // try/finally: si un assert falla a mitad, la solapa tiene que volver a habilitarse
      // igual — si no, los specs que corren después con el actor 'admin' heredan el bloqueo.
      try {
        await toggle(false);

        await client.get('admin', '/admin/import', { expectStatus: 403 });
        // La acción POST de esa solapa también queda cerrada, no solo la pantalla.
        await client.post('admin', '/admin/import/execute', { body: {}, expectStatus: 403 });

        const nav = await client.get('admin', '/admin', { expectStatus: 200 });
        assert(!nav.text.includes('/admin/import'), 'la solapa Importar no debería aparecer en el menú');
        assert(nav.text.includes('/admin/users'), 'las demás solapas deberían seguir en el menú');
      } finally {
        await toggle(true);
      }

      await client.get('admin', '/admin/import', { expectStatus: 200 });
      const navFinal = await client.get('admin', '/admin', { expectStatus: 200 });
      assert(navFinal.text.includes('/admin/import'), 'al rehabilitarla, la solapa debería volver al menú');
    },
  },
  {
    id: 'roles-blocks-audit-mounted-outside-panel',
    title: 'El bloqueo alcanza a /admin/audit, que se monta fuera del router de admin',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state }) {
      // routes/audit.js se monta en "/" antes que adminRoutes, así que el guard de panel
      // nunca lo ve: lleva su propio requireSection. Sin este spec, esa ruta podría quedar
      // abierta sin que ningún otro test lo note.
      const toggle = (enabled) => client.post('superadmin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role: 'admin', key: 'admin_audit', enabled },
        expectStatus: 200,
      });

      try {
        await toggle(false);
        await client.get('admin', '/admin/audit', { expectStatus: 403 });
      } finally {
        await toggle(true);
      }
      await client.get('admin', '/admin/audit', { expectStatus: 200 });
    },
  },
  {
    id: 'roles-rejects-superadmin-role',
    title: 'El superadministrador no se puede restringir, ni salteando la pantalla (400)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'SMOKE_ADMIN_EMAIL', 'MONGODB_URI'],
    async run({ client, state }) {
      // El candado de la vista es presentación: la regla real vive en el servidor.
      await client.post('superadmin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role: 'superadmin', key: 'admin_users', enabled: false },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'roles-rejects-locked-and-unknown-sections',
    title: 'Rechaza secciones bloqueadas, del panel de superadmin y desconocidas (400)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'SMOKE_ADMIN_EMAIL', 'MONGODB_URI'],
    async run({ client, state }) {
      const rechaza = (key, role = 'admin') => client.post('superadmin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role, key, enabled: false },
        expectStatus: 400,
      });

      await rechaza('admin_dashboard');     // locked: es la puerta de entrada del panel
      await rechaza('superadmin_backup');   // panel de superadmin + atada al email del dueño
      await rechaza('no_existe_esta_key');  // fuera del catálogo
      await rechaza('admin_users', 'teacher'); // el rol no tiene acceso base a esa sección
    },
  },
  {
    id: 'roles-forbidden-for-admin',
    title: 'Un admin de escuela no puede tocar los permisos de roles (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI', 'SMOKE_SUPERADMIN_EMAIL'],
    async run({ client, state }) {
      await client.get('admin', '/superadmin/roles', { expectStatus: 403 });
      await client.post('admin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role: 'admin', key: 'admin_users', enabled: true },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'roles-reset-restores-defaults',
    title: 'Restablecer devuelve al rol todos sus accesos de una sola vez',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state }) {
      const apagar = (key) => client.post('superadmin', '/superadmin/roles/toggle', {
        body: { schoolId: state.rolesSchoolId, role: 'admin', key, enabled: false },
        expectStatus: 200,
      });

      try {
        await apagar('admin_import');
        await apagar('admin_subjects');
        await client.get('admin', '/admin/import',   { expectStatus: 403 });
        await client.get('admin', '/admin/subjects', { expectStatus: 403 });
      } finally {
        await client.post('superadmin', '/superadmin/roles/reset', {
          body: { schoolId: state.rolesSchoolId, role: 'admin' },
          expectStatus: 200,
        });
      }

      await client.get('admin', '/admin/import',   { expectStatus: 200 });
      await client.get('admin', '/admin/subjects', { expectStatus: 200 });
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
      // Desde el 2026-08-24 las FOTOS de la entrega sí se optimizan (por
      // /upload-submission-image), pero los documentos no: siguen en diskStorage y enteros,
      // porque acá hay PDFs de hasta 20 MB que no tienen por qué pasar por RAM. Este spec es
      // el que vigila esa frontera — que el optimizador no se lleve puestos los PDFs.
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
    id: 'entrega-foto-se-recomprime',
    title: 'La foto de la entrega se recomprime a WebP antes de tocar el disco',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Era el único camino de subida de la aplicación que guardaba la imagen tal cual venía
      // del celular. Además de disco, costaba tiempo de subida: cuanto más tarda, más
      // expuesta está a los cortes del Funnel (ver el informe de subidas del 18/08).
      const foto = await fotoDePrueba(2400, 1800);
      const fd = new FormData();
      fd.append('file', new Blob([foto], { type: 'image/jpeg' }), 'carpeta.jpg');

      const up = await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-image`, {
        form: fd, expectStatus: 200,
      });

      assert(up.json.filename.endsWith('.webp'), `debería quedar como .webp, quedó: ${up.json.filename}`);
      // El nombre VISIBLE lleva la extensión que quedó en disco: si dijera .jpg, el archivo
      // que descarga el docente no coincidiría con su propio nombre.
      assert(up.json.name === 'carpeta.webp', `el nombre visible debería ser carpeta.webp, es: ${up.json.name}`);
      assert(up.json.size < foto.length,
        `la foto tendría que adelgazar: ${up.json.size} vs ${foto.length} original`);
      assert(up.json.mime === 'image/webp', `el mime debería ser image/webp, es: ${up.json.mime}`);

      // Y entra en la entrega como cualquier otro archivo: el submit no distingue por cuál de
      // las dos rutas subió.
      const submit = await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
        body: { text: 'Foto de la carpeta', uploadedFiles: [up.json] },
        expectStatus: 200,
      });
      assert(submit.json.submission.files.some(f => f.filename === up.json.filename),
        'la foto debería quedar en la entrega');
    },
  },
  {
    id: 'entrega-foto-de-iphone',
    title: 'La foto de iPhone (.heic) entra, o explica cómo pasarla a JPG — nunca "no permitido"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El caso: hasta el 2026-08-24 la entrega rechazaba .heic con el cartel "Tipo de archivo
      // no permitido (PDF, Word, Excel, imágenes o ZIP)" — nombraba a las imágenes mientras
      // rechazaba una, y no le decía al alumno qué hacer.
      //
      // El resultado correcto depende del servidor y este spec acepta los dos, porque los dos
      // son correctos; lo que NO se acepta es un cartel que no explique nada:
      //
      //   - con el códec HEVC     → 200, y la foto sale convertida a WebP;
      //   - sin el códec (el caso de hoy: el libvips precompilado trae el loader heif solo
      //     para AVIF) → 400 en el primer segundo, con el cartel que dice cómo poner la cámara
      //     en "Más compatible". El rechazo es RÁPIDO: no se sube la foto entera para nada.
      const foto = await fotoDePrueba(1800, 2400);
      const fd = new FormData();
      fd.append('file', new Blob([foto], { type: 'image/heic' }), 'IMG_4821.HEIC');

      const up = await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-image`, {
        form: fd, expectStatus: [200, 400],
      });

      if (up.status === 200) {
        assert(up.json.filename.endsWith('.webp'),
          'el HEIC nunca queda publicado tal cual: sale convertido');
      } else {
        assert(/iPhone/i.test(up.json.error || ''),
          `el cartel tiene que explicar el problema, dijo: ${up.json.error}`);
        assert(/JPG|compatible/i.test(up.json.error || ''),
          'y decirle a la persona qué hacer para poder entregar');
      }
    },
  },
  {
    id: 'entrega-foto-de-un-ajeno-no-entra',
    title: 'Quien no está inscripto no llega ni a subir la foto (el permiso va antes de multer)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // El guard corre ANTES de recibir el cuerpo: sin eso, alguien ajeno alcanza a empujar
      // 20 MB al disco de la escuela y recién después lee el 403. Misma regla que dejó escrita
      // el adjunto del docente.
      const foto = await fotoDePrueba(800, 600);
      const fd = new FormData();
      fd.append('file', new Blob([foto], { type: 'image/jpeg' }), 'colada.jpg');
      await client.post('scopedTeacher', `/activities/${state.activityId}/upload-submission-image`, {
        form: fd, expectStatus: 403,
      });
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

  // ── Alta de alumno con Curso: matrícula automática + la vencida NO se le esconde ──
  // Verifica el flujo del alta: admin crea usuario con role=student + divisionId, y el backend:
  //  1. Inscribe al alumno en TODAS las materias del Curso seleccionado (1 en smoke — el
  //     único curso creado por `course-create`).
  //  2. Guarda joinedAt = ahora en Course.enrollmentDates para ese alumno.
  //  3. Y desde el 2026-08-31 NO usa ese joinedAt para ocultarle nada: el alumno recién dado
  //     de alta ve también las actividades vencidas antes de su alta, con las tardías cerradas.
  //
  // El caso real, reportado por una docente desde producción: con la regla anterior el chico
  // perdía el MATERIAL de todas las clases anteriores (enunciado y adjuntos), y devolvérselo
  // dependía de que el docente abriera las entregas de una por una. Ver el bloque de abajo:
  // la actividad se ve, pero entregarla sigue dando 403, y no vuelve a "Mis pendientes".
  //
  // Se contrasta con `scopedStudent` (que se unió por código, sin joinedAt): los dos ven lo
  // mismo, que es justamente lo que antes no pasaba.
  {
    id: 'enrolldiv-teacher-creates-past-activity',
    title: 'El docente crea una actividad con dueDate en el PASADO (ambientar el caso borde)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // El título lleva el RUN_ID porque "Mis pendientes" se verifica buscándolo en el HTML.
      const titulo = `Tarea vencida (pre-latejoiner) ${RUN_ID}`;
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: titulo, type: 'tarea', points: '10', dueDate: yesterday },
        expectStatus: 201,
      });
      state.pastActivityId     = res.json.activity._id;
      state.pastActivityTitulo = titulo;
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
    id: 'enrolldiv-latejoiner-sees-past-activity',
    title: 'El late-joiner SÍ ve la actividad vencida antes de su alta, con las tardías cerradas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res  = await client.get('lateJoiner', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const past = res.json.activities.find(a => a._id === state.pastActivityId);
      assert(past, 'la actividad vencida antes del alta TIENE que figurarle: es el material de la clase');
      // Que las tardías estén cerradas es la mitad del spec. Si estuvieran abiertas, la
      // actividad se vería también con la regla vieja y el test no probaría nada.
      assert(past.allowLateSubmissions !== true,
        'el fixture tiene que estar con las tardías CERRADAS, si no el spec no distingue nada');
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
    id: 'enrolldiv-latejoiner-cannot-submit-past',
    title: 'Verla no es poder entregarla: la vencida con tardías cerradas devuelve 403',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // La otra mitad del pedido de la docente: se abre el material, no la entrega. Si alguien
      // "arregla" la visibilidad abriendo también la puerta, este spec se cae.
      const res = await client.post('lateJoiner', `/activities/${state.pastActivityId}/submit`, {
        body: { text: 'no debería poder entregar esto' },
        expectStatus: 403,
      });
      assert(/plazo de entrega/i.test(res.json?.error || ''),
        `esperaba el 403 del plazo vencido, recibí: ${JSON.stringify(res.json)}`);
    },
  },
  {
    id: 'enrolldiv-latejoiner-past-not-pending',
    title: 'Y tampoco le vuelve como pendiente: está en la materia, no en "Mis pendientes"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es lo que hace que mostrar las vencidas no sea molesto: sigueSiendoPendiente() las
      // caduca sola (public/js/pendienteActividad.js), así que /activities/my-pending puede
      // dejar de filtrar por enrollmentDates sin llenarse de tareas viejas.
      const res = await client.get('lateJoiner', '/activities/my-pending', { expectStatus: 200 });
      assert(!res.text.includes(state.pastActivityTitulo),
        'la vencida se ve en la materia pero NO puede contar como pendiente');
    },
  },
  {
    id: 'enrolldiv-oldstudent-still-sees-past',
    title: 'El alumno unido por código (sin joinedAt) ve exactamente lo mismo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const seesPast    = res.json.activities.some(a => a._id === state.pastActivityId);
      const seesCurrent = res.json.activities.some(a => a._id === state.activityId);
      assert(seesPast,    'scopedStudent (sin joinedAt) tiene que ver la actividad vencida');
      assert(seesCurrent, 'scopedStudent tiene que ver la actividad vigente');
    },
  },
  {
    id: 'enrolldiv-late-submissions-override',
    title: 'Habilitar las tardías ya no cambia la visibilidad: cambia solo la entrega',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const idsDelCurso = async () => {
        const res = await client.get('lateJoiner', `/activities/course/${state.courseId}`, { expectStatus: 200 });
        return res.json.activities.map(a => a._id).sort();
      };

      const antes = await idsDelCurso();
      const patch = await client.patch('scopedTeacher', `/activities/${state.pastActivityId}/toggle-late`, {
        expectStatus: 200,
      });
      assert(patch.json.allowLateSubmissions === true, 'el toggle tenía que dejar las tardías abiertas');

      // Lo que ve el alumno es idéntico antes y después: el flag es la puerta de la entrega,
      // no el estante del material. Antes del 2026-08-31 esta lista crecía con el toggle.
      const despues = await idsDelCurso();
      assert(JSON.stringify(despues) === JSON.stringify(antes),
        `abrir las tardías no debería cambiar QUÉ ve el alumno: ${antes.length} → ${despues.length}`);

      // Y ahora sí puede entregar la misma actividad que hace dos specs le daba 403.
      await client.post('lateJoiner', `/activities/${state.pastActivityId}/submit`, {
        body: { text: 'entrega tardía, con las tardías abiertas por el docente' },
        expectStatus: 200,
      });
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
    // Antes se llamaba `dni-required-on-self-register` y verificaba el 400 por DNI faltante
    // en el auto-registro. Desde el 2026-08-23 no hay auto-registro, así que lo que hay que
    // fijar es el ORDEN de las guardas: la puerta cerrada contesta ANTES que la validación
    // del DNI. Si algún día alguien reordena eso, el 400 volvería a filtrar que la ruta
    // sigue procesando cuerpos de alta.
    id: 'registro-cerrado-gana-a-la-validacion',
    title: 'Con el registro cerrado, /register contesta 403 antes de validar nada (ni el DNI)',
    async run({ client, assert }) {
      const r = await client.post(null, '/register', {
        body: { name: 'Registro Sin DNI', email: `regsindni.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student' },
        expectStatus: 403,
      });
      assert(r.json && r.json.registroCerrado === true,
        `debería cortar por registro cerrado y no por el DNI; dijo ${JSON.stringify(r.json)}`);
    },
  },
  {
    id: 'dni-existing-setup-second-course',
    title: 'Se crea una segunda materia en el mismo Curso (para probar matrícula parcial)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const res = await client.post('admin', '/admin/courses/create', {
        body: {
          name: `Materia Smoke 2 ${RUN_ID}`, divisionId: state.divisionId,
          teacherId: state.scopedTeacherId, room: '102',
        },
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
    // ── Hilo de conversación (ver services/suggestionThread.js) ──────────────
    // La regla que le da sentido al hilo: se puede seguir una conversación, no abrir una
    // sin contestar. Mientras nadie respondió no hay hilo, y lo que corresponde es una
    // sugerencia nueva. Va acá porque más abajo la sugerencia ya está respondida.
    id: 'suggestions-thread-blocked-before-answer',
    title: 'Sin respuesta del equipo, el usuario no puede seguir el hilo (le pide abrir una nueva)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine.puedeResponder === false, 'sin respuesta del equipo no debería poder responder');
      assert(mine.esperaAlEquipo === true, 'debería figurar esperando al equipo');
      assert(mine.hilo.length === 1, `el hilo debería tener solo la sugerencia, tiene ${mine.hilo.length}`);

      const res = await client.post('scopedStudent', `/suggestions/mine/${state.studentSuggestionId}/reply`, {
        body: { text: 'No debería entrar' },
        expectStatus: 400,
      });
      assert(/sugerencia nueva/.test(res.json.error || ''),
        `el error debería derivar a abrir una sugerencia nueva — dijo: ${res.json.error}`);
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
  {
    id: 'suggestions-thread-student-replies',
    title: 'El alumno responde la respuesta y la sugerencia vuelve a Pendientes',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.threadStudentReply = `Repregunta del alumno — smoke ${RUN_ID}`;
      await client.post('scopedStudent', `/suggestions/mine/${state.studentSuggestionId}/reply`, {
        body: { text: state.threadStudentReply },
        expectStatus: 200,
      });

      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      // Vuelve a 'pending' a propósito: es lo que la devuelve a la bandeja donde el
      // superadmin entra por default. Si quedara en 'answered' nadie vería la repregunta.
      assert(mine.status === 'pending', `esperaba pending tras responder, encontré ${mine.status}`);
      assert(mine.hilo.length === 3, `el hilo debería tener 3 mensajes, tiene ${mine.hilo.length}`);
      assert(mine.hilo[2].from === 'user' && mine.hilo[2].text === state.threadStudentReply,
        'el último mensaje del hilo debería ser el del alumno');
      assert(mine.esperaAlEquipo === true, 'ahora la pelota queda del lado del equipo');
      // Su propia respuesta no puede dejarle el sobre marcado como no leído.
      assert(mine.readByUser === true, 'responder no debería dejar la sugerencia como no leída');

      const panel = await client.get('superadmin', '/superadmin/suggestions?status=pending', { expectStatus: 200 });
      assert(panel.text.includes(state.threadStudentReply), 'el panel del superadmin debería mostrar la repregunta');
      assert(panel.text.includes('TE RESPONDIÓ'), 'la tarjeta debería avisar que el usuario respondió');
    },
  },
  {
    id: 'suggestions-thread-superadmin-replies-again',
    title: 'El superadmin vuelve a responder: suma al hilo sin pisar la primera respuesta',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.threadStaffReply = `Segunda respuesta del equipo — smoke ${RUN_ID}`;
      await client.post('superadmin', `/superadmin/suggestions/${state.studentSuggestionId}/respond`, {
        body: { text: state.threadStaffReply, isEdit: false },
        expectStatus: 200,
      });

      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine.status === 'answered', `esperaba answered, encontré ${mine.status}`);
      assert(mine.hilo.length === 4, `el hilo debería tener 4 mensajes, tiene ${mine.hilo.length}`);
      assert(mine.hilo[3].from === 'staff' && mine.hilo[3].text === state.threadStaffReply,
        'el último mensaje debería ser la segunda respuesta del equipo');
      // La primera respuesta vive en `response` y no se toca: es lo que mantiene legibles
      // las sugerencias históricas sin migrar la base.
      assert(mine.hilo[1].text !== state.threadStaffReply, 'la primera respuesta no debería haberse pisado');
      assert(mine.readByUser === false, 'un mensaje nuevo del equipo debería volver a marcarla sin leer');

      const pageRes = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(pageRes.text.includes('id="inboxBadge"'), 'el badge del sobre debería reaparecer');
    },
  },
  {
    id: 'suggestions-thread-edit-touches-last-message',
    title: 'Editar corrige el último mensaje del equipo, no el primero',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const corregida = `Segunda respuesta corregida — smoke ${RUN_ID}`;
      await client.post('superadmin', `/superadmin/suggestions/${state.studentSuggestionId}/respond`, {
        body: { text: corregida, isEdit: true },
        expectStatus: 200,
      });

      const mineRes = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      const mine = mineRes.json.suggestions.find(s => s._id === state.studentSuggestionId);
      assert(mine.hilo.length === 4, 'editar no debería agregar un mensaje al hilo');
      assert(mine.hilo[3].text === corregida, 'el último mensaje debería quedar corregido');
      assert(mine.hilo[3].editedAt, 'el mensaje corregido debería quedar marcado como editado');
      assert(mine.hilo[2].text === state.threadStudentReply, 'la repregunta del alumno no debería tocarse');
    },
  },
  {
    id: 'suggestions-thread-denies-other-users',
    title: 'Un usuario no puede responder en el hilo de otro (404)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('scopedTeacher', `/suggestions/mine/${state.studentSuggestionId}/reply`, {
        body: { text: 'No es mi conversación' },
        expectStatus: 404,
      });
    },
  },

  // ══ Mensajes del superadministrador ═══════════════════════════════════════
  // El camino inverso al de las sugerencias: el superadmin le escribe a la gente. Cubre los
  // criterios 15-45 de specs/mensajeria-superadmin.spec.md.
  //
  // Queda FUERA de acá el criterio 23 (429 al envío 21 en una hora): probarlo exige 21 envíos
  // reales, y cada uno crea documentos por destinatario. El limiter es el mismo patrón ya
  // ejercitado por roomMessageLimiter, y el costo de verificarlo acá no se justifica.
  // También quedan fuera los criterios 36-37 (killswitch apagado), que necesitan levantar el
  // server con otra env var.
  {
    id: 'messages-panel-loads',
    title: 'La pantalla de Mensajes carga con el formulario de redacción',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, env, assert }) {
      // Login propio del actor 'superadmin', por el mismo motivo que en los specs de
      // sugerencias y de roles: el spec genérico vive más abajo en el archivo.
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      const res = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(res.text.includes('id="cuerpo"'),       'debería estar el textarea del mensaje');
      assert(res.text.includes('id="everyone"'),     'debería estar la opción "Toda la comunidad"');
      assert(res.text.includes('id="allowReplies"'), 'debería estar el toggle de respuestas');
      // El nav tiene que ofrecer la solapa nueva, o la pantalla existe pero no se llega.
      assert(res.text.includes('/superadmin/messages'), 'la solapa Mensajes debería estar en el nav');
    },
  },
  {
    id: 'messages-preview-counts-without-sending',
    title: 'La previsualización devuelve el alcance sin crear nada',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/messages/preview?roles=student', { expectStatus: 200 });
      assert(res.json.total > 0, 'debería haber al menos un alumno en el alcance');
      assert(res.json.porRol.student === res.json.total, 'filtrando por Alumno, todos deberían ser alumnos');
      assert(Array.isArray(res.json.muestra) && res.json.muestra.length > 0, 'debería traer una muestra de nombres');
      assert(res.json.muestra.length <= 10, 'la muestra no debería pasar de 10');
    },
  },
  {
    id: 'messages-preview-empty-without-filters',
    title: 'Sin filtros y sin "toda la comunidad", el alcance es 0 (criterio 8)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/messages/preview', { expectStatus: 200 });
      assert(res.json.total === 0, `sin filtros el alcance debería ser 0, dio ${res.json.total}`);
    },
  },
  {
    id: 'messages-search-finds-by-dni',
    title: 'El buscador de personas encuentra por DNI',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin',
        `/superadmin/messages/users?q=${encodeURIComponent(state.scopedStudentEmail)}`, { expectStatus: 200 });
      const encontrado = (res.json.users || []).find(u => u._id === state.scopedStudentId);
      assert(encontrado, 'debería encontrar al alumno del suite por su correo');
      assert('dni' in encontrado, 'el resultado debería traer el DNI (va primero en la lista)');
    },
  },
  {
    id: 'messages-send-rejects-empty-body',
    title: 'Enviar sin cuerpo devuelve 400 (criterio 19)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('superadmin', '/superadmin/messages', {
        body: { body: '   ', userIds: [state.scopedStudentId] },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'messages-send-rejects-long-body',
    title: 'Un cuerpo de 2001 caracteres devuelve 400 (criterio 19)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('superadmin', '/superadmin/messages', {
        body: { body: 'x'.repeat(2001), userIds: [state.scopedStudentId] },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'messages-send-rejects-empty-audience',
    title: 'Sin destinatarios devuelve 400 y NO crea el mensaje (criterio 20)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const antes = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      const marca = `Sin destinatarios — smoke ${RUN_ID}`;

      const res = await client.post('superadmin', '/superadmin/messages', {
        body: { body: marca },
        expectStatus: 400,
      });
      assert(/destinatarios/i.test(res.json.error || ''),
        `el error debería hablar de destinatarios — dijo: ${res.json.error}`);

      // Lo importante no es el 400 sino que no haya quedado un Message huérfano.
      const despues = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(!despues.text.includes(marca), 'no debería haberse creado el mensaje');
      assert(antes.status === 200 && despues.status === 200, 'el panel debería seguir cargando');
    },
  },
  {
    id: 'messages-non-superadmin-denied',
    title: 'Un usuario que no es superadmin no entra al panel (criterio 21)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('scopedStudent', '/superadmin/messages', { expectStatus: [403, 302] });
      await client.post('scopedStudent', '/superadmin/messages', {
        body: { body: 'No debería entrar', userIds: [state.scopedStudentId] },
        expectStatus: [403, 302],
      });
    },
  },
  {
    id: 'messages-send-to-two-people',
    title: 'El superadmin envía a dos personas elegidas a mano (criterios 15 y 16)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.msgSubject = `Aviso smoke ${RUN_ID}`;
      state.msgBody    = `Cuerpo del aviso de prueba — smoke ${RUN_ID}`;

      // Base del badge ANTES de enviar. A esta altura del suite el alumno ya tiene una
      // sugerencia sin leer, así que el badge no arranca en cero: lo que se verifica de acá
      // en adelante es que el mensaje SUME uno y lo devuelva al leerlo.
      const antes = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      state.badgeBase = badgeDelSobre(antes.text);

      const res = await client.post('superadmin', '/superadmin/messages', {
        body: {
          subject:      state.msgSubject,
          body:         state.msgBody,
          allowReplies: false,
          userIds:      [state.scopedStudentId, state.scopedTeacherId],
        },
        expectStatus: 201,
      });
      assert(res.json.destinatarios === 2, `esperaba 2 destinatarios, dio ${res.json.destinatarios}`);
      state.messageId = res.json.id;

      // recipientCount es el denominador de "leído por X de Y": tiene que reflejar las filas
      // realmente insertadas, y el panel lo muestra tal cual.
      const panel = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(panel.text.includes(state.msgSubject), 'el envío debería aparecer en el listado');
      assert(panel.text.includes('Leído por 0 de 2'), 'debería decir que nadie lo leyó todavía');
    },
  },
  {
    id: 'messages-recipient-sees-it',
    title: 'El destinatario lo ve en su bandeja, sin caja de texto (criterios 24-26)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.subject === state.msgSubject);
      assert(mine, 'el mensaje recién enviado debería aparecer en /messages/mine');
      assert(mine.body === state.msgBody, 'el cuerpo debería coincidir');
      assert(mine.readAt === null,           'recién enviado: no debería estar leído');
      assert(mine.sinLeer === true,          'debería contar para el badge');
      assert(mine.allowReplies === false,    'este envío no admite respuestas');
      assert(mine.puedeResponder === false,  'sin respuestas habilitadas no debería poder responder');
      assert(mine.hilo.length === 1,         `el hilo debería tener solo el mensaje, tiene ${mine.hilo.length}`);
      assert(mine.hilo[0].from === 'staff',  'el primer mensaje del hilo es del equipo');
      state.recipientId = mine.recipientId;

      // El badge del sobre se renderiza server-side en cualquier página con header. Suma las
      // dos fuentes, así que tiene que valer exactamente uno más que antes del envío.
      const page = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      const badge = badgeDelSobre(page.text);
      assert(badge === state.badgeBase + 1,
        `el badge debería pasar de ${state.badgeBase} a ${state.badgeBase + 1}, quedó en ${badge}`);
    },
  },
  {
    id: 'messages-reply-blocked-when-disabled',
    title: 'Responder un mensaje que no admite respuestas da 403 (criterio 29)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Se llama al endpoint directo, salteando la vista: la puerta tiene que estar en el
      // servidor, no en que el botón no se pinte.
      const res = await client.post('scopedStudent', `/messages/mine/${state.recipientId}/reply`, {
        body: { text: 'No debería entrar' },
        expectStatus: 403,
      });
      assert(/no admite respuestas/i.test(res.json.error || ''),
        `el error debería decir que no admite respuestas — dijo: ${res.json.error}`);
    },
  },
  {
    id: 'messages-read-denies-other-users',
    title: 'Nadie puede marcar como leído el mensaje de otro (criterio 28)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      // 404 y no 403: no se confirma que la fila exista si no es de quien pregunta.
      await client.post('scopedTeacher', `/messages/mine/${state.recipientId}/read`, { expectStatus: 404 });
      await client.post('scopedTeacher', `/messages/mine/${state.recipientId}/reply`, {
        body: { text: 'No es mi mensaje' },
        expectStatus: 404,
      });
    },
  },
  {
    id: 'messages-mark-read-clears-badge',
    title: 'Marcar como leído baja el badge y suma al contador del panel (criterios 27, 34, 38)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/messages/mine/${state.recipientId}/read`, { expectStatus: 200 });

      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.recipientId === state.recipientId);
      assert(mine.readAt !== null, 'después de marcarlo, readAt no debería ser null');
      assert(mine.sinLeer === false, 'ya leído: no debería contar para el badge');

      // El badge vuelve a la base: baja el mensaje leído, pero NO se lleva puesto lo que el
      // alumno tenga sin leer de sugerencias. Ese es el punto del contador unificado.
      const page  = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      const badge = badgeDelSobre(page.text);
      assert(badge === state.badgeBase,
        `leído el mensaje, el badge debería volver a ${state.badgeBase}, quedó en ${badge}`);

      const panel = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(panel.text.includes('Leído por 1 de 2'), 'el panel debería contar la lectura');
    },
  },
  {
    id: 'messages-detail-shows-dni-and-spanish-roles',
    title: 'El detalle lista destinatarios con DNI primero y roles en español (criterios 17, 39, 40)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin', `/superadmin/messages/${state.messageId}`, { expectStatus: 200 });

      const cabecera = res.text.slice(res.text.indexOf('<thead>'), res.text.indexOf('</thead>'));
      assert(cabecera.indexOf('DNI') < cabecera.indexOf('Nombre'),
        'el DNI tiene que ser la primera columna de la tabla');

      // roleAtSend congelado en el envío, traducido con roleNames.
      assert(res.text.includes('>Alumno<'),  'el rol del alumno debería verse en español');
      assert(res.text.includes('>Docente<'), 'el rol del docente debería verse en español');
      assert(!res.text.includes('>student<'), 'no debería filtrarse el valor crudo del rol');

      assert(res.text.includes('Leído</span>'),    'debería marcar al que leyó');
      assert(res.text.includes('Sin leer</span>'), 'debería marcar al que no leyó');
    },
  },
  {
    id: 'messages-detail-filter-unread',
    title: 'El filtro "no leídos" trae solo a los que no abrieron (criterio 41)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin',
        `/superadmin/messages/${state.messageId}?filtro=no-leidos`, { expectStatus: 200 });
      assert(res.text.includes('Sin leer</span>'), 'debería mostrar al que no leyó');
      assert(!res.text.includes('Leído</span>'),   'no debería mostrar al que ya leyó');
    },
  },
  {
    id: 'messages-toggle-replies-on',
    title: 'Prender las respuestas después de enviado habilita la caja de texto (criterio 43)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.patch('superadmin', `/superadmin/messages/${state.messageId}/replies`, {
        body: { allowReplies: true },
        expectStatus: 200,
      });

      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.recipientId === state.recipientId);
      assert(mine.allowReplies === true,   'el mensaje debería admitir respuestas ahora');
      assert(mine.puedeResponder === true, 'el destinatario debería poder responder');
    },
  },
  {
    id: 'messages-recipient-replies',
    title: 'El destinatario responde y el panel lo avisa (criterio 30)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.msgUserReply = `Respuesta del alumno — smoke ${RUN_ID}`;
      await client.post('scopedStudent', `/messages/mine/${state.recipientId}/reply`, {
        body: { text: state.msgUserReply },
        expectStatus: 200,
      });

      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.recipientId === state.recipientId);
      assert(mine.hilo.length === 2, `el hilo debería tener 2 mensajes, tiene ${mine.hilo.length}`);
      assert(mine.hilo[1].from === 'user' && mine.hilo[1].text === state.msgUserReply,
        'el último mensaje debería ser el del alumno');
      assert(mine.esperaAlDestinatario === false, 'ahora la pelota queda del lado del equipo');
      // Su propia respuesta no puede dejarle el sobre encendido.
      assert(mine.sinLeer === false, 'responder no debería dejarlo como sin leer');

      const panel = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(panel.text.includes('1 respuesta nueva'), 'el panel debería avisar la respuesta nueva');

      const detalle = await client.get('superadmin', `/superadmin/messages/${state.messageId}`, { expectStatus: 200 });
      assert(detalle.text.includes(state.msgUserReply), 'el detalle debería mostrar la respuesta');
    },
  },
  {
    id: 'messages-staff-replies-relights-badge',
    title: 'La respuesta del superadmin vuelve a encender el badge (criterio 35)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.msgStaffReply = `Respuesta del equipo — smoke ${RUN_ID}`;
      await client.post('superadmin', `/superadmin/messages/${state.messageId}/reply`, {
        body: { recipientId: state.recipientId, text: state.msgStaffReply },
        expectStatus: 200,
      });

      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.recipientId === state.recipientId);
      assert(mine.hilo.length === 3, `el hilo debería tener 3 mensajes, tiene ${mine.hilo.length}`);
      assert(mine.hilo[2].text === state.msgStaffReply, 'el último debería ser la respuesta del equipo');
      // ESTE es el caso que readAt solo no cubre: el mensaje ya estaba leído y aun así el
      // badge tiene que volver a encenderse.
      assert(mine.readAt !== null, 'el mensaje sigue estando leído');
      assert(mine.sinLeer === true, 'una respuesta nueva sobre un mensaje leído debería encender el badge');

      const page  = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      const badge = badgeDelSobre(page.text);
      assert(badge === state.badgeBase + 1,
        `el badge debería volver a subir a ${state.badgeBase + 1}, quedó en ${badge}`);
    },
  },
  {
    id: 'messages-toggle-replies-off-keeps-thread',
    title: 'Apagar las respuestas cierra la caja pero conserva lo escrito (criterio 43)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.patch('superadmin', `/superadmin/messages/${state.messageId}/replies`, {
        body: { allowReplies: false },
        expectStatus: 200,
      });

      const res  = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      const mine = res.json.messages.find(m => m.recipientId === state.recipientId);
      assert(mine.puedeResponder === false, 'con las respuestas apagadas no debería poder escribir');
      assert(mine.hilo.length === 3, 'lo ya escrito tiene que seguir estando');
      assert(mine.hilo.some(m => m.text === state.msgUserReply), 'su respuesta no puede haberse perdido');

      await client.post('scopedStudent', `/messages/mine/${state.recipientId}/reply`, {
        body: { text: 'Ya no debería poder' },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'messages-audit-logged',
    title: 'El envío queda registrado en la auditoría (criterio 22)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/audit?action=message.send', { expectStatus: 200 });
      assert(res.text.includes('envió un mensaje'),
        'el evento de envío debería aparecer en el panel de auditoría con su etiqueta en español');
    },
  },
  {
    id: 'messages-delete-cascades',
    title: 'Borrar el envío lo saca de todas las bandejas (criterios 44 y 45)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.delete('superadmin', `/superadmin/messages/${state.messageId}`, { expectStatus: 200 });

      const panel = await client.get('superadmin', '/superadmin/messages', { expectStatus: 200 });
      assert(!panel.text.includes(state.msgSubject), 'el envío no debería seguir en el listado');

      const res = await client.get('scopedStudent', '/messages/mine', { expectStatus: 200 });
      assert(!res.json.messages.some(m => m.recipientId === state.recipientId),
        'el mensaje debería desaparecer de la bandeja del destinatario');

      // Y el badge no puede quedar contando algo que ya no existe: el mensaje estaba sin leer
      // (el superadmin había vuelto a responder), así que borrarlo tiene que devolverlo a la base.
      const page  = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      const badge = badgeDelSobre(page.text);
      assert(badge === state.badgeBase,
        `borrado el mensaje, el badge debería volver a ${state.badgeBase}, quedó en ${badge}`);

      const audit = await client.get('superadmin', '/superadmin/audit?action=message.delete', { expectStatus: 200 });
      assert(audit.text.includes('eliminó un mensaje enviado'), 'el borrado debería quedar auditado');
    },
  },
  {
    id: 'messages-suggestions-still-work',
    title: 'Regresión: la bandeja de sugerencias sigue funcionando igual (criterios 46 y 47)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('scopedStudent', '/suggestions/mine', { expectStatus: 200 });
      assert(Array.isArray(res.json.suggestions), '/suggestions/mine debería seguir devolviendo su lista');

      // El sobre sigue en el header y sigue siendo el mismo botón, ahora con las dos fuentes.
      const page = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(page.text.includes('id="inboxBtn"'), 'el botón del sobre debería seguir en el header');
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

  // ── La cuenta propia: lo que hace CUALQUIER rol con la suya ───────────────
  // Cerrar sesión, cambiar la contraseña y editar el contacto son las tres cosas que los
  // ocho roles hacen igual, y ninguna de las tres estaba en el smoke. El cambio de CORREO sí
  // lo estaba (los specs email-change-*), que es lo que hacía fácil no notar el hueco.
  {
    id: 'cuenta-propia-setup',
    title: 'Setup: una cuenta propia y descartable para probar sus ajustes',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Cuenta propia del bloque en vez de reusar el alumno de prueba: estos specs cambian
      // la contraseña y el contacto, y hacerlo sobre una cuenta que miran otros veinte specs
      // convierte cualquier falla a mitad de camino en una cascada de fallas ajenas.
      const email = `smoke.cuenta.${RUN_ID}@example.com`;
      const dni   = dniSmoke(71);
      const r = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Cuenta ${RUN_ID}`, email, password: 'SmokeTest1234', role: 'student', dni },
        expectStatus: 201,
      });
      state.cuentaId    = r.json.user._id;
      state.cuentaEmail = email;
      state.cuentaDni   = dni;
    },
  },
  {
    id: 'cuenta-propia-cambia-la-contrasena',
    title: 'Cualquier usuario cambia su propia contraseña y la nueva es la que vale',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const vieja = 'SmokeTest1234';
      const nueva = 'SmokeTest5678';

      await client.post('pwUser', '/login', { body: { email: state.cuentaEmail, password: vieja }, expectStatus: 200 });
      await client.post('pwUser', '/courses/profile/change-password', {
        body: { currentPassword: vieja, newPassword: nueva }, expectStatus: 200,
      });

      // Las DOS mitades: la vieja tiene que dejar de servir y la nueva tiene que entrar. Sin
      // la primera, un handler que contestara ok sin guardar nada pasaría el test igual.
      await client.post('pwCheck', '/login', { body: { email: state.cuentaEmail, password: vieja }, expectStatus: 400 });
      await client.post('pwCheck', '/login', { body: { email: state.cuentaEmail, password: nueva }, expectStatus: 200 });

      // Y se la devuelve, que los specs de abajo asumen la de siempre.
      await client.post('pwUser', '/courses/profile/change-password', {
        body: { currentPassword: nueva, newPassword: vieja }, expectStatus: 200,
      });
      await client.post('pwCheck', '/login', { body: { email: state.cuentaEmail, password: vieja }, expectStatus: 200 });
    },
  },
  {
    id: 'cuenta-propia-contrasena-valida-los-datos',
    title: 'Contraseña actual equivocada, campos vacíos o contraseña corta se rechazan con 400',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // El resguardo que importa es el primero: una sesión abierta en una compu compartida
      // no puede cambiar la contraseña sin saber la actual.
      const r = await client.post('pwUser', '/courses/profile/change-password', {
        body: { currentPassword: 'LaQueNoEs9999', newPassword: 'OtraCosa1234' }, expectStatus: 400,
      });
      assert(/actual/i.test(r.json?.error || ''), `debería decir que la actual no coincide; dijo ${JSON.stringify(r.json)}`);

      await client.post('pwUser', '/courses/profile/change-password', { body: { newPassword: 'OtraCosa1234' }, expectStatus: 400 });
      await client.post('pwUser', '/courses/profile/change-password', {
        body: { currentPassword: 'SmokeTest1234', newPassword: '123' }, expectStatus: 400,
      });
    },
  },
  {
    id: 'cuenta-propia-edita-el-contacto',
    title: 'El usuario guarda su contacto y se guarda el handle limpio, no el link entero',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Lo que se prueba no es que guarde, sino que NORMALICE: la ruta guarda el handle y
      // arma el link al mostrarlo. Si alguna vez guardara la URL entera, el perfil quedaría
      // con links tipo instagram.com/instagram.com/pepe y nadie lo notaría hasta verlo.
      const r = await client.patch('pwUser', '/courses/profile/contact', {
        body: { phone: '11 2233-4455', instagram: 'https://instagram.com/smoke.test', facebook: '' },
        expectStatus: 200,
      });
      assert(r.json.instagram === 'smoke.test',
        `debería guardar el handle pelado, guardó ${JSON.stringify(r.json.instagram)}`);
      assert(r.json.facebook === null, 'un campo vacío debería borrarse');

      await client.patch('pwUser', '/courses/profile/contact', {
        body: { phone: '', instagram: '', facebook: '' }, expectStatus: 200,
      });
    },
  },
  {
    id: 'cuenta-propia-cierra-sesion',
    title: 'Cerrar sesión invalida la cookie de verdad, no solo en la pantalla',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // POST /logout nunca había pasado por el smoke, y es de las poquísimas rutas que los
      // ocho roles usan todos los días. Lo que se verifica es que la sesión quede muerta:
      // la ruta borra las cookies, así que después de esto el mismo actor —con el mismo
      // cookie jar— tiene que comportarse como un anónimo.
      await client.post('logoutUser', '/login', { body: { email: state.cuentaEmail, password: 'SmokeTest1234' }, expectStatus: 200 });
      await client.get('logoutUser', '/courses', { expectStatus: 200 });

      await client.post('logoutUser', '/logout', { expectStatus: 200 });

      const despues = await client.get('logoutUser', '/courses');
      assert(despues.status === 302, `después de cerrar sesión /courses debería redirigir, dio ${despues.status}`);
      assert((despues.headers.get('location') || '').includes('/login'),
        `debería mandar al login, mandó a ${despues.headers.get('location')}`);
    },
  },
  {
    id: 'register-lookup-encuentra-por-dni',
    title: 'El buscador por DNI del registro encuentra la cuenta y valida la entrada',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es una ruta SIN autenticación: la usa quien no sabe con qué correo entrar. Por eso
      // importa verificar también qué devuelve de más — solo nombre, correo y DNI.
      const r = await client.get(null, `/register/lookup?dni=${state.cuentaDni}`, { expectStatus: 200 });
      assert(Array.isArray(r.json?.users) && r.json.users.length >= 1, `debería encontrar la cuenta; devolvió ${JSON.stringify(r.json)}`);
      const campos = Object.keys(r.json.users[0]).filter(k => k !== '_id');
      assert(campos.every(k => ['name', 'email', 'dni'].includes(k)),
        `una ruta sin login no debería devolver ${campos.join(', ')}`);

      await client.get(null, '/register/lookup?dni=123',        { expectStatus: 400 });
      await client.get(null, '/register/lookup?dni=99999999999', { expectStatus: 404 });
    },
  },
  {
    id: 'cuenta-propia-cleanup',
    title: 'Limpieza: borra la cuenta de los ajustes propios',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.cuentaId) {
        await client.post('admin', `/admin/users/${state.cuentaId}/delete`, { expectStatus: [200, 204] });
      }
    },
  },

  // ── Diagnóstico de subidas fallidas ───────────────────────────────────────
  // El navegador le cuenta al servidor lo que el servidor NO puede ver: una subida que se
  // cortó en camino no deja línea en el access log, porque nunca llegó. Lo que se prueba
  // acá es la propiedad que hace útil todo el mecanismo — que el código que ve el usuario
  // en pantalla alcance para encontrar el reporte entero en el log.
  {
    id: 'diagnostico-subida-queda-en-el-log',
    title: 'Un reporte de subida fallida se puede encontrar después por su código',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const fs   = require('fs');
      const path = require('path');
      const codigo = 'SUB-' + RUN_ID.toUpperCase().replace(/[ILO]/g, 'X').slice(-6).padStart(6, 'Z');

      await client.post('admin', '/diagnostico/subida', {
        body: {
          codigo,
          ruta:     '/activities/xxx/upload-submission-file',
          motivo:   'red',
          archivo:  { nombre: 'consigna.pdf', bytes: 3145728, mime: 'application/pdf' },
          enviados: 1048576,
          ms:       12000,
          intentos: 4,
          conexion: '3g',
          pantalla: '/courses/xxx',
        },
        expectStatus: 200,
      });

      // winston escribe a archivo de forma asíncrona: se espera un poco antes de leer.
      const log = path.join(__dirname, '../../logs/combined.log');
      let linea = null;
      for (let i = 0; i < 20 && !linea; i++) {
        await new Promise(r => setTimeout(r, 100));
        const txt = fs.readFileSync(log, 'utf8');
        const idx = txt.lastIndexOf(codigo);
        if (idx !== -1) {
          const desde = txt.lastIndexOf('\n', idx) + 1;
          const hasta = txt.indexOf('\n', idx);
          try { linea = JSON.parse(txt.slice(desde, hasta === -1 ? undefined : hasta)); } catch {}
        }
      }
      assert(linea, `el reporte ${codigo} debería quedar en combined.log`);
      assert(linea.evento === 'subida_fallida', `debería marcarse con evento subida_fallida, tiene ${linea.evento}`);

      // El porcentaje lo calcula el SERVIDOR, no el cliente: es el primer número que se mira
      // y no puede depender de que el navegador lo haya hecho bien.
      assert(linea.porcentaje === 33, `1 MB de 3 MB deberían ser 33%, dice ${linea.porcentaje}`);
      // Y quién lo mandó sale de la sesión, no del body — que es lo único de todo el reporte
      // en lo que se puede confiar.
      assert(String(linea.usuario).includes('@'), `debería registrar al usuario de la sesión, dice ${linea.usuario}`);
      assert(linea.rol, 'debería registrar el rol');
      assert(linea.archivo?.nombre === 'consigna.pdf', 'debería registrar el archivo');
      // Cuántas veces se reintentó antes de rendirse. Es lo que distingue "se cayó un
      // paquete" de "el corte duró los cincuenta segundos", que son dos investigaciones
      // distintas. Ver el reintento automático en public/js/subida-diagnostico.js.
      assert(linea.intentos === 4, `debería registrar los 4 intentos, dice ${linea.intentos}`);
    },
  },
  {
    id: 'diagnostico-subida-no-se-le-puede-inundar-el-log',
    title: 'El reporte se valida y se recorta: no se puede escribir cualquier cosa en el log',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const fs   = require('fs');
      const path = require('path');

      // Un código con otra forma se rechaza: sin eso, esto es un endpoint que escribe en el
      // log lo que le manden.
      await client.post('admin', '/diagnostico/subida', { body: { codigo: 'cualquier cosa' }, expectStatus: 400 });
      await client.post('admin', '/diagnostico/subida', { body: {}, expectStatus: 400 });

      // Y los textos se recortan. El log es la herramienta que se usa cuando algo se rompe
      // de verdad: si desde el navegador se pueden escribir megabytes, cualquiera puede
      // taparlo de basura y volverlo inservible justo cuando hace falta.
      const codigo = 'SUB-ZZ' + String(Date.now()).slice(-4);
      await client.post('admin', '/diagnostico/subida', {
        body: {
          codigo,
          motivo:    'inventado',                    // fuera de la lista conocida
          respuesta: 'A'.repeat(50000),
          archivo:   { nombre: 'B'.repeat(5000), bytes: 'no es un número' },
          status:    99999,
          ms:        -1,
          intentos:  'muchos',
        },
        expectStatus: 200,
      });

      const log = path.join(__dirname, '../../logs/combined.log');
      let linea = null;
      for (let i = 0; i < 20 && !linea; i++) {
        await new Promise(r => setTimeout(r, 100));
        const txt = fs.readFileSync(log, 'utf8');
        const idx = txt.lastIndexOf(codigo);
        if (idx !== -1) {
          const desde = txt.lastIndexOf('\n', idx) + 1;
          const hasta = txt.indexOf('\n', idx);
          try { linea = JSON.parse(txt.slice(desde, hasta === -1 ? undefined : hasta)); } catch {}
        }
      }
      assert(linea, 'el reporte debería registrarse igual, pero saneado');
      assert(linea.respuesta.length <= 300, `la respuesta debería recortarse a 300, quedó en ${linea.respuesta.length}`);
      assert(linea.archivo.nombre.length <= 200, `el nombre debería recortarse a 200, quedó en ${linea.archivo.nombre.length}`);
      assert(linea.motivo === 'desconocido', `un motivo fuera de la lista debería quedar como desconocido, quedó ${linea.motivo}`);
      assert(linea.archivo.bytes === undefined, 'un tamaño que no es número no debería registrarse');
      assert(linea.status === 599, `el status debería toparse en 599, quedó ${linea.status}`);
      assert(linea.ms === undefined, 'un tiempo negativo no debería registrarse');
      assert(linea.intentos === undefined, 'un contador de intentos que no es número no debería registrarse');
    },
  },
  {
    id: 'diagnostico-subida-exige-sesion',
    title: 'El reporte de subida no lo puede mandar cualquiera desde afuera',
    async run({ client, assert }) {
      // Sin sesión no se acepta: el valor del registro es saber QUIÉN lo sufrió, y un
      // endpoint de escritura al log abierto a internet es un regalo.
      const r = await client.post(null, '/diagnostico/subida', { body: { codigo: 'SUB-ABC123' } });
      assert([302, 401, 403].includes(r.status), `debería rechazar al anónimo, dio ${r.status}`);
    },
  },

  // ── El ciclo de un tema, de punta a punta ─────────────────────────────────
  // Cuatro rutas que nunca habían corrido (offer, config, revoke del superadmin y respond
  // del admin) y que además son la ÚNICA función del sistema que cruza los dos paneles: el
  // superadmin ofrece, el admin de la escuela acepta. Probar cada ruta por separado no
  // habría servido de mucho — lo que puede romperse acá es el pasamanos.
  //
  // Todos dejan la escuela como la encontraron: el último spec revoca, y revocar borra el
  // tema del documento. Por eso se elige un slug que el usuario no usa a mano.
  {
    id: 'tema-superadmin-lo-ofrece',
    title: 'El superadmin ofrece un tema a la escuela y le queda en estado "offered"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      // Login propio del actor acá: este bloque corre ANTES del spec "superadmin-login",
      // que está mucho más abajo en el archivo. Mismo motivo (y mismo patrón) que en
      // email-change-protected-account-blocked.
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      // La escuela sale del propio admin logueado, no de una constante: el smoke corre
      // contra el mirror local de cada uno.
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const admin = await mongo.db().collection('users').findOne({ email: env.SMOKE_ADMIN_EMAIL.toLowerCase() });
        assert(admin?.school, 'el admin de prueba debería tener escuela');
        state.temaSchoolId = String(admin.school);

        // Si el tema ya estaba en la escuela, este spec lo pisaría y el revoke final se lo
        // borraría al usuario. Se elige uno que no esté.
        const escuela = await mongo.db().collection('schools').findOne({ _id: new ObjectId(state.temaSchoolId) });
        const usados  = new Set((escuela.themes || []).map(t => t.slug));
        state.temaSlug = ['carnaval', 'primavera', 'halloween'].find(s => !usados.has(s));
        assert(state.temaSlug, 'la escuela ya tiene todos los temas candidatos: elegir otro para el test');
      } finally { await mongo.close(); }

      await client.post('superadmin', '/superadmin/themes/offer', {
        body: { schoolId: state.temaSchoolId, slug: state.temaSlug }, expectStatus: 200,
      });

      const pantalla = await client.get('admin', '/admin/theme', { expectStatus: 200 });
      assert((pantalla.text || '').includes(state.temaSlug),
        `la pantalla de Tema del admin debería mostrar el tema ofrecido (${state.temaSlug})`);
    },
  },
  {
    id: 'tema-rechaza-un-slug-que-no-existe',
    title: 'Ofrecer un tema que no está en el catálogo se rechaza con 400',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('superadmin', '/superadmin/themes/offer', {
        body: { schoolId: state.temaSchoolId, slug: 'tema-inventado' }, expectStatus: 400,
      });
    },
  },
  {
    id: 'tema-el-admin-lo-acepta',
    title: 'El admin acepta el tema ofrecido y queda en "accepted"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      await client.post('admin', '/admin/theme/respond', {
        body: { slug: state.temaSlug, action: 'accept' }, expectStatus: 200,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const escuela = await mongo.db().collection('schools').findOne({ _id: new ObjectId(state.temaSchoolId) });
        const t = (escuela.themes || []).find(x => x.slug === state.temaSlug);
        assert(t?.status === 'accepted', `el tema debería quedar accepted, quedó ${t?.status}`);
      } finally { await mongo.close(); }
    },
  },
  {
    id: 'tema-el-admin-no-toca-otra-escuela',
    title: 'El admin solo responde por SU escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      // La ruta filtra por res.locals.user.school y no acepta un schoolId del body. Se
      // verifica mandándoselo igual: si algún día alguien lo lee del body, esto lo caza.
      assert(state.temaSlug, 'falta el tema del setup');
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const otra = await mongo.db().collection('schools').findOne({ _id: { $ne: new ObjectId(state.temaSchoolId) } });
        if (!otra) return; // mirror con una sola escuela: no hay nada que verificar
        const antes = JSON.stringify(otra.themes || []);

        await client.post('admin', '/admin/theme/respond', {
          body: { slug: state.temaSlug, action: 'reject', schoolId: String(otra._id) }, expectStatus: 200,
        });

        const despues = await mongo.db().collection('schools').findOne({ _id: otra._id });
        assert(JSON.stringify(despues.themes || []) === antes,
          'responder con el schoolId de otra escuela en el body no debería tocarla');
      } finally { await mongo.close(); }
    },
  },
  {
    id: 'tema-superadmin-lo-configura',
    title: 'El superadmin cambia la configuración de un tema ya aceptado',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      await client.post('superadmin', '/superadmin/themes/config', {
        body: { schoolId: state.temaSchoolId, slug: state.temaSlug, startDate: '2030-01-01', endDate: '2030-01-31' },
        expectStatus: 200,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const escuela = await mongo.db().collection('schools').findOne({ _id: new ObjectId(state.temaSchoolId) });
        const t = (escuela.themes || []).find(x => x.slug === state.temaSlug);
        assert(String(t.startDate).startsWith('2030-01-01') || new Date(t.startDate).getUTCFullYear() === 2030,
          `debería haber guardado la fecha de inicio, guardó ${t.startDate}`);
        assert(t.status === 'accepted', 'configurar no debería cambiarle el estado');
      } finally { await mongo.close(); }

      // Y sobre un tema que la escuela no tiene, 404.
      await client.post('superadmin', '/superadmin/themes/config', {
        body: { schoolId: state.temaSchoolId, slug: 'dia-bandera-que-no-tiene' }, expectStatus: 404,
      });
    },
  },
  {
    id: 'tema-superadmin-lo-revoca',
    title: 'Revocar saca el tema de la escuela y deja todo como estaba',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      await client.post('superadmin', '/superadmin/themes/revoke', {
        body: { schoolId: state.temaSchoolId, slug: state.temaSlug }, expectStatus: 200,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const escuela = await mongo.db().collection('schools').findOne({ _id: new ObjectId(state.temaSchoolId) });
        assert(!(escuela.themes || []).some(x => x.slug === state.temaSlug),
          'el tema revocado debería haber desaparecido de la escuela');
      } finally { await mongo.close(); }
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
    // specs/directivo-actividades-diarias.spec.md — CA-02 a CA-06, CA-08, CA-11 y CA-13.
    // Para cuando corre este spec, la materia de smoke ya tiene actividades creadas HOY (las
    // dejó 'teacher-creates-activity'), así que el rango de hoy tiene que darla como Entregado.
    id: 'directivo-actividades-diarias',
    title: 'El directivo ve qué materias tienen actividad cargada y cuáles no',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const hoy = diaEscolar();
      const url = (q) => `/directivo/actividades-diarias${q ? '?' + q : ''}`;

      // Sin un solo parámetro tiene que abrir en HOY: es la pantalla de entrada de la solapa.
      const inicio = await client.get('directivo', url(), { expectStatus: 200 });
      assert(inicio.text.includes('Actividades Diarias'), 'debería abrir la solapa');
      assert(inicio.text.includes(`value="${hoy}"`),
        `sin parámetros debería abrir en el día de hoy (${hoy})`);

      // Acotado a la división de smoke, la materia de smoke tiene actividad de hoy.
      const conDatos = await client.get('directivo',
        url(`desde=${hoy}&hasta=${hoy}&division=${state.divisionId}`), { expectStatus: 200 });
      assert(conDatos.text.includes('Materia Smoke'),
        'la materia de smoke debería estar listada en su división');
      assert(conDatos.text.includes('Entregado'),
        'con actividad cargada hoy, alguna materia debería figurar como Entregado');

      // El filtro de estado acota de verdad: pidiendo solo pendientes, la materia que SÍ tiene
      // actividad de hoy no puede seguir apareciendo.
      const pendientes = await client.get('directivo',
        url(`desde=${hoy}&hasta=${hoy}&division=${state.divisionId}&estado=pendiente`), { expectStatus: 200 });
      assert(!pendientes.text.includes('Materia Smoke'),
        'la materia con actividad de hoy no debería salir en "Solo pendientes"');

      // Cambiar a fecha de entrega cambia la pregunta, y la pantalla lo avisa: las actividades
      // sin dueDate no cuentan (RN-03), así que un docente puede figurar distinto en cada modo.
      const porEntrega = await client.get('directivo',
        url(`desde=${hoy}&hasta=${hoy}&division=${state.divisionId}&campo=entrega`), { expectStatus: 200 });
      assert(porEntrega.text.includes('sin fecha límite'),
        'el modo "por fecha de entrega" debería avisar que las actividades sin vencimiento no cuentan');

      // Un rango dado vuelta o escrito a mano no rompe: cae en hoy (CA-13). Es lo que separa
      // "la pantalla se defiende" de un 500 por un parámetro de URL.
      const dadoVuelta = await client.get('directivo',
        url('desde=2026-12-31&hasta=2026-01-01'), { expectStatus: 200 });
      assert(dadoVuelta.text.includes(`value="${hoy}"`), 'un rango dado vuelta debería caer en hoy');
      await client.get('directivo', url('desde=ayer&hasta=manana'),          { expectStatus: 200 });
      await client.get('directivo', url('desde=2015-01-01&hasta=2026-12-31'), { expectStatus: 200 });
      await client.get('directivo', url('campo=constructor&estado=xyz&division=no-es-un-id'), { expectStatus: 200 });
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
    // El superadmin es el ÚNICO usuario con `school: null` (administra la plataforma, no una
    // escuela). El header condicionaba el nombre a `if (school)`, así que era justo el rol que
    // se quedaba sin él. Se prueba con el superadmin porque cualquier otro rol pasa igual.
    id: 'superadmin-header-nombre-y-reloj',
    title: 'El superadmin ve el nombre de la escuela y el reloj en el header',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const page = await client.get('superadmin', '/superadmin', { expectStatus: 200 });
      const html = page.text || '';
      assert(html.includes('header-school-name'),
        'el header debería mostrar el nombre aunque el usuario no tenga escuela');
      assert(html.includes('id="headerClock"'), 'el header debería traer el reloj de la escuela');
      // La hora la pone el SERVIDOR: sin data-epoch el reloj quedaría a merced del reloj del
      // equipo, que es exactamente lo que la feature evita.
      const epoch = Number((html.match(/data-epoch="(\d+)"/) || [])[1]);
      assert(epoch > 0, 'el reloj debería traer data-epoch con la hora del servidor');
      assert(Math.abs(Date.now() - epoch) < 5 * 60 * 1000,
        `data-epoch debería ser de recién, vino ${new Date(epoch).toISOString()}`);
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
  // ── Acciones masivas del superadmin ───────────────────────────────────────
  // Estas dos rutas nunca habían pasado por el smoke, y era justo ahí donde el sistema
  // tenía la única mutación que escribía sin validar: `updateMany` NO corre los
  // validadores del schema salvo que se le pida (`runValidators`), y las vías de a uno sí
  // lo hacen. O sea que la misma operación aceptaba por lote exactamente lo que rechazaba
  // de a uno — y con `role`, lo que se escribía era un valor fuera del enum.
  {
    id: 'bulk-setup-usuario',
    title: 'Setup: un usuario descartable para las acciones masivas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const email = `smoke.bulk.${RUN_ID}@example.com`;
      const r = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Bulk ${RUN_ID}`, email, password: 'SmokeTest1234', role: 'student', dni: dniSmoke(70) },
        expectStatus: 201,
      });
      state.bulkUserId    = r.json.user._id;
      state.bulkUserEmail = email;
      state.bulkSchoolId  = r.json.user.school;
      assert(state.bulkSchoolId, 'el alta por el panel de admin debería dejar al usuario con la escuela del admin');
    },
  },
  {
    id: 'bulk-role-rechaza-rol-invalido',
    title: 'Cambiar roles en lote a un valor fuera del enum se rechaza con 400 y no toca la base',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env, assert }) {
      // Verificado en rojo: sin la validación, esto contesta 200 {"ok":true,"updated":1} y
      // deja `role: "DIRECTOR_SUPREMO"` escrito en la base. No es escalada de privilegios
      // —ningún middleware reconoce ese rol, así que el usuario queda con los permisos
      // mínimos— pero TAPIA la cuenta: cualquier ruta que haga `.save()` sobre ese
      // documento revalida el enum y explota. En concreto, el dueño de la cuenta deja de
      // poder cambiar su propia contraseña (500), y no hay nada en la UI que lo explique.
      const r = await client.post('superadmin', '/superadmin/users/bulk-role', {
        body: { userIds: [state.bulkUserId], role: 'DIRECTOR_SUPREMO' },
        expectStatus: 400,
      });
      assert(/rol/i.test(r.json?.error || ''), `el error debería nombrar el rol; fue ${JSON.stringify(r.json)}`);

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const u = await mongo.db().collection('users').findOne({ _id: new ObjectId(state.bulkUserId) });
        assert(u.role === 'student', `el rol en la base debería seguir siendo student, es "${u.role}"`);
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'bulk-role-invalido-no-tapia-la-cuenta',
    title: 'Tras el rechazo, el dueño de la cuenta sigue pudiendo cambiar su contraseña',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es la consecuencia REAL del bug, y por eso se verifica acá y no en el spec de
      // arriba: un rol fuera del enum no se nota hasta que alguien toca el documento con
      // `.save()`, y entonces falla algo que no tiene nada que ver con roles.
      const PASS = 'SmokeTest1234';
      await client.post('bulkUser', '/login', { body: { email: state.bulkUserEmail, password: PASS }, expectStatus: 200 });
      const cambio = await client.post('bulkUser', '/courses/profile/change-password', {
        body: { currentPassword: PASS, newPassword: PASS + 'X' },
        expectStatus: 200,
      });
      assert(cambio.json?.ok, 'debería poder cambiar su contraseña');
      // Se la devuelve, que los specs de más abajo no saben de esto.
      await client.post('bulkUser', '/courses/profile/change-password', {
        body: { currentPassword: PASS + 'X', newPassword: PASS }, expectStatus: 200,
      });
    },
  },
  {
    id: 'bulk-role-cambia-el-rol-de-verdad',
    title: 'Cambiar roles en lote con un rol válido sí funciona',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env, assert }) {
      // El camino feliz también estaba sin cubrir: al agregar la validación hay que
      // asegurarse de no haber cerrado la puerta de más.
      await client.post('superadmin', '/superadmin/users/bulk-role', {
        body: { userIds: [state.bulkUserId], role: 'teacher' }, expectStatus: 200,
      });
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const u = await mongo.db().collection('users').findOne({ _id: new ObjectId(state.bulkUserId) });
        assert(u.role === 'teacher', `el rol debería haber pasado a teacher, es "${u.role}"`);
      } finally {
        await mongo.close();
      }
      // Se lo deja como estaba: los specs de limpieza lo borran igual, pero un docente
      // suelto en la escuela confunde si algo falla antes de llegar ahí.
      await client.post('superadmin', '/superadmin/users/bulk-role', {
        body: { userIds: [state.bulkUserId], role: 'student' }, expectStatus: 200,
      });
    },
  },
  {
    id: 'bulk-role-valida-la-lista',
    title: 'El lote sin usuarios, sin rol o solo con uno mismo se rechaza con 400',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('superadmin', '/superadmin/users/bulk-role', { body: { userIds: [], role: 'teacher' }, expectStatus: 400 });
      await client.post('superadmin', '/superadmin/users/bulk-role', { body: { userIds: [state.bulkUserId] },   expectStatus: 400 });
    },
  },
  {
    id: 'role-de-a-uno-rechaza-con-400',
    title: 'Un rol inválido de a uno devuelve 400, no 500',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // La vía de a uno SÍ rechazaba el rol inválido (tiene runValidators: true), pero el
      // ValidationError caía en el catch genérico y salía como 500 "Error del servidor":
      // un error de datos del que pide, contado como una falla del servidor. Ensucia el
      // error.log —que es donde se mira cuando algo se rompe de verdad— y no le dice nada
      // al que está del otro lado.
      const r = await client.post('superadmin', `/superadmin/users/${state.bulkUserId}/role`, {
        body: { role: 'DIRECTOR_SUPREMO' }, expectStatus: 400,
      });
      assert(/rol/i.test(r.json?.error || ''), `el error debería nombrar el rol; fue ${JSON.stringify(r.json)}`);
    },
  },
  {
    id: 'role-de-a-uno-del-admin-rechaza-con-400',
    title: 'Lo mismo desde el panel de admin: rol inválido = 400',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Misma ruta, otro router: /admin/users/:id/role tenía el mismo catch genérico.
      const r = await client.post('admin', `/admin/users/${state.bulkUserId}/role`, {
        body: { role: 'DIRECTOR_SUPREMO' }, expectStatus: 400,
      });
      assert(/rol/i.test(r.json?.error || ''), `el error debería nombrar el rol; fue ${JSON.stringify(r.json)}`);
    },
  },
  {
    id: 'bulk-school-rechaza-escuela-inexistente',
    title: 'Asignar en lote una escuela que no existe se rechaza y no deja usuarios huérfanos',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env, assert }) {
      // Verificado en rojo: contestaba 200 {"ok":true,"updated":1} y dejaba al usuario
      // apuntando a un ObjectId que no es ninguna escuela. Es la misma clase de referencia
      // colgada que en agosto tiró abajo /admin/courses con un 500 (Course.owner apuntando
      // a un usuario borrado): no rompe nada el día que se hace, rompe meses después en
      // una pantalla que no tiene nada que ver.
      const { MongoClient, ObjectId } = require('mongodb');
      const fantasma = String(new ObjectId());
      await client.post('superadmin', '/superadmin/users/bulk-school', {
        body: { userIds: [state.bulkUserId], schoolId: fantasma }, expectStatus: 404,
      });

      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const u = await mongo.db().collection('users').findOne({ _id: new ObjectId(state.bulkUserId) });
        assert(String(u.school) === String(state.bulkSchoolId),
          `el usuario debería seguir en su escuela, quedó en ${u.school}`);
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'school-de-a-uno-rechaza-escuela-inexistente',
    title: 'Lo mismo de a uno: una escuela inexistente devuelve 404',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state }) {
      const { ObjectId } = require('mongodb');
      await client.post('superadmin', `/superadmin/users/${state.bulkUserId}/school`, {
        body: { schoolId: String(new ObjectId()) }, expectStatus: 404,
      });
    },
  },
  {
    id: 'bulk-school-asigna-y-desasigna',
    title: 'Asignar en lote una escuela real y desasignarla sí funciona',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env, assert }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const leerEscuela = async () => {
        const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        try {
          await mongo.connect();
          const u = await mongo.db().collection('users').findOne({ _id: new ObjectId(state.bulkUserId) });
          return u.school;
        } finally { await mongo.close(); }
      };

      // schoolId "" es el caso documentado de "sacarle la escuela": tiene que seguir
      // pasando, es lo que distingue "no existe" de "ninguna".
      await client.post('superadmin', '/superadmin/users/bulk-school', {
        body: { userIds: [state.bulkUserId], schoolId: '' }, expectStatus: 200,
      });
      assert((await leerEscuela()) === null, 'schoolId vacío debería dejar al usuario sin escuela');

      await client.post('superadmin', '/superadmin/users/bulk-school', {
        body: { userIds: [state.bulkUserId], schoolId: state.bulkSchoolId }, expectStatus: 200,
      });
      assert(String(await leerEscuela()) === String(state.bulkSchoolId), 'debería haber vuelto a su escuela');
    },
  },
  {
    id: 'bulk-cleanup-usuario',
    title: 'Limpieza: borra el usuario de las acciones masivas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.bulkUserId) {
        await client.post('admin', `/admin/users/${state.bulkUserId}/delete`, { expectStatus: [200, 204] });
      }
    },
  },

  // ── Altas y pantallas que nunca habían corrido ────────────────────────────
  // El resto de la zona ciega: escuelas, el alta del superadmin, el catálogo de materias,
  // las plantillas de importación y tres GET que el frontend llama por su cuenta. Ninguna
  // es sofisticada; el valor está en que ahora existen y cualquier cambio las despierta.
  {
    id: 'superadmin-crea-dos-escuelas',
    title: 'Se pueden crear DOS escuelas seguidas (la plataforma es multiescuela)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Verificado en rojo: la SEGUNDA escuela que se crea en una base falla con
      // 400 "Ya existe una escuela con ese nombre" — y el nombre no tiene nada que ver.
      //
      // El culpable es el índice `{ inviteToken: 1 }, { unique: true, sparse: true }` de
      // models/School.js contra el `default: null` del mismo campo. `sparse` saltea los
      // documentos donde el campo NO ESTÁ; uno que vale `null` sí está y sí se indexa. Como
      // toda escuela nace con `inviteToken: null`, la segunda choca con la primera. El
      // manejador del error 11000 de la ruta traduce cualquier duplicado a "ese nombre", que
      // es justo el lugar equivocado donde mirar.
      //
      // Por eso el test crea DOS y no una: con una sola, esto pasa siempre (no hay con qué
      // chocar) y el bug queda invisible. Es lo que lo mantuvo escondido — en la base de
      // producción hay una sola escuela, así que el botón "Nueva escuela" nunca funcionó y
      // nadie lo supo.
      await client.get('superadmin', '/superadmin/schools/create', { expectStatus: 200 });

      const creadas = [];
      try {
        for (const sufijo of ['A', 'B']) {
          const nombre = `Escuela Smoke ${RUN_ID} ${sufijo}`;
          const r = await client.post('superadmin', '/superadmin/schools/create', {
            body: { name: nombre, description: 'creada por el smoke', color: '#0d7377' },
            expectStatus: 201,
          });
          creadas.push(r.json.school._id);
          assert(r.json.school.slug, 'el slug lo genera el hook pre-validate del model: debería venir');
        }

        // Se abre el perfil: es la pantalla que rompía en producción cuando algún dato
        // quedaba colgado, así que el alta y la apertura van juntas en el test.
        await client.get('superadmin', `/superadmin/schools/${creadas[0]}`, { expectStatus: 200 });

        // Y el nombre repetido DE VERDAD sigue dando 400 (índice único sobre `name`).
        await client.post('superadmin', '/superadmin/schools/create', {
          body: { name: `Escuela Smoke ${RUN_ID} A` }, expectStatus: 400,
        });
        // Sin nombre, la validación del schema también es 400.
        await client.post('superadmin', '/superadmin/schools/create', { body: { description: 'sin nombre' }, expectStatus: 400 });
      } finally {
        for (const id of creadas) {
          await client.post('superadmin', `/superadmin/schools/${id}/delete`, { expectStatus: [200, 204] });
        }
      }
    },
  },
  {
    id: 'superadmin-enlace-de-invitacion-va-y-viene',
    title: 'Generar y revocar el enlace de invitación no deja la escuela sin poder convivir con otra',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // La otra mitad del mismo bug: revocar volvía a escribir `inviteToken: null`, así que
      // una escuela que alguna vez tuvo enlace y lo perdió volvía a ocupar el casillero del
      // índice y bloqueaba a la siguiente. Se prueba el ciclo completo sobre dos escuelas
      // porque el choque solo existe DE A DOS.
      const creadas = [];
      try {
        for (const sufijo of ['C', 'D']) {
          const r = await client.post('superadmin', '/superadmin/schools/create', {
            body: { name: `Escuela Invite ${RUN_ID} ${sufijo}`, color: '#0d7377' }, expectStatus: 201,
          });
          creadas.push(r.json.school._id);
        }

        // Genera enlace en las dos: dos tokens distintos conviven sin problema.
        const urls = [];
        for (const id of creadas) {
          const r = await client.post('superadmin', `/superadmin/schools/${id}/invite`, { expectStatus: 200 });
          assert(/\/register\/invite\/[a-f0-9]{48}$/.test(r.json?.inviteUrl || ''),
            `debería devolver el enlace de invitación; devolvió ${JSON.stringify(r.json)}`);
          urls.push(r.json.inviteUrl);
        }
        assert(urls[0] !== urls[1], 'cada escuela debería tener su propio token');

        // El enlace se sigue generando y revocando (es lo que prueba este spec: que el
        // índice sparse no choque), pero desde el 2026-08-23 YA NO DA DE ALTA A NADIE:
        // el registro por invitación está cerrado en services/registroPublico.js.
        //
        // Antes acá se verificaba que la pantalla nombrara a la escuela. Ahora se verifica
        // lo contrario, y es a propósito: un enlace que no registra a nadie tampoco tiene
        // por qué seguir revelando a qué institución pertenece.
        const token = urls[0].split('/').pop();
        const vivo = await client.get(null, `/register/invite/${token}`, { expectStatus: 200 });
        assert((vivo.text || '').includes('Registro cerrado'),
          'la pantalla de invitación debería avisar que el registro está cerrado');
        assert(!(vivo.text || '').includes(`Escuela Invite ${RUN_ID} C`),
          'y no debería nombrar a la escuela: el enlace ya no da de alta a nadie');

        // La puerta misma: ni con el token VIVO se crea la cuenta.
        const conTokenVivo = await client.post(null, `/register/invite/${token}`, {
          body: { name: 'Colado Invitado', email: `colado.invite.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'directivo', dni: dniSmoke(74) },
          expectStatus: 403,
        });
        assert(conTokenVivo.json && conTokenVivo.json.registroCerrado === true,
          `el alta por invitación debería cortar por registro cerrado; dijo ${JSON.stringify(conTokenVivo.json)}`);

        // Se revocan los dos. Es acá donde se reintroducía el choque.
        for (const id of creadas) {
          await client.post('superadmin', `/superadmin/schools/${id}/revoke-invite`, { expectStatus: 200 });
        }

        // El enlace viejo deja de servir. El GET contesta 200 A PROPÓSITO: la misma vista
        // pinta la pantalla de "enlace inválido" (routes/auth.js pasa school:null), así que
        // lo que hay que verificar es el CONTENIDO, no el código. El que sí corta con un
        // error es el POST, que es el que crearía la cuenta.
        const muerto = await client.get(null, `/register/invite/${token}`, { expectStatus: 200 });
        assert(!(muerto.text || '').includes(`Escuela Invite ${RUN_ID} C`),
          'el enlace revocado no debería nombrar a la escuela');

        // Con la invitación cerrada, el POST corta ANTES de mirar el token: el mensaje ya no
        // habla de "revocado" sino de registro cerrado. La distinción vivo/revocado deja de
        // ser observable desde afuera, que es exactamente lo que se quiere de una puerta
        // cerrada — y por eso lo que se prueba acá es el 403, no el 400 de antes.
        const alta = await client.post(null, `/register/invite/${token}`, {
          body: { name: 'Colado', email: `colado.${RUN_ID}@example.com`, password: 'SmokeTest1234', role: 'student', dni: dniSmoke(73) },
          expectStatus: 403,
        });
        assert(alta.json && alta.json.registroCerrado === true,
          `el alta por un enlace revocado también corta por registro cerrado; dijo ${JSON.stringify(alta.json)}`);

        // La prueba de fuego: con las dos revocadas, todavía se puede crear una tercera.
        const tercera = await client.post('superadmin', '/superadmin/schools/create', {
          body: { name: `Escuela Invite ${RUN_ID} E`, color: '#0d7377' }, expectStatus: 201,
        });
        creadas.push(tercera.json.school._id);
      } finally {
        for (const id of creadas) {
          await client.post('superadmin', `/superadmin/schools/${id}/delete`, { expectStatus: [200, 204] });
        }
      }
    },
  },
  {
    id: 'superadmin-crea-usuario-exige-dni',
    title: 'El alta del superadmin exige DNI y deja la cuenta sin escuela',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const email = `smoke.sacreate.${RUN_ID}@example.com`;

      // El DNI es obligatorio en TODA alta desde 2026-07-30, y esta ruta es la que más fácil
      // se olvida porque es la única fuera del panel de administración.
      await client.post('superadmin', '/superadmin/users/create', {
        body: { name: 'Smoke SA Create', email, password: 'SmokeTest1234', role: 'teacher' },
        expectStatus: 400,
      });

      const r = await client.post('superadmin', '/superadmin/users/create', {
        body: { name: 'Smoke SA Create', email, password: 'SmokeTest1234', role: 'teacher', dni: dniSmoke(72) },
        expectStatus: 201,
      });
      try {
        // Documentado en el backlog como trampa: el superadmin no tiene escuela, así que la
        // cuenta nace con school:null y queda fuera de los paneles por escuela. No es un bug
        // —es lo que hace la ruta— pero es exactamente el tipo de cosa que un test tiene que
        // fijar, para que si algún día cambia, cambie a propósito.
        assert(r.json.user.school == null,
          `el alta del superadmin deja la cuenta sin escuela; vino school=${r.json.user.school}`);
      } finally {
        await client.post('superadmin', `/admin/users/${r.json.user._id}/delete`, { expectStatus: [200, 204] });
      }
    },
  },
  {
    id: 'admin-crea-materia-en-el-catalogo',
    title: 'El admin da de alta una materia del catálogo y el nombre repetido se rechaza',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('admin', '/admin/subjects/create', { expectStatus: 200 });

      const nombre = `Materia Catálogo ${RUN_ID}`;
      const r = await client.post('admin', '/admin/subjects/create', {
        body: { name: nombre, description: 'del smoke', color: '#795548' }, expectStatus: 201,
      });
      const creadas = [r.json.subject._id];
      try {
        // Un color fuera de la paleta del modelo sí se rechaza.
        await client.post('admin', '/admin/subjects/create', {
          body: { name: `${nombre} bis`, color: '#123456' }, expectStatus: 400,
        });

        // ⚠️ El nombre repetido NO se rechaza, y el test lo fija así a propósito.
        // `routes/admin.js` tiene el manejador del error 11000 ("Ya existe una materia con
        // ese nombre"), pero `subjects` no tiene ningún índice único que lo dispare: el
        // único índice de la colección es `_id_`. O sea que ese catch es código muerto.
        //
        // NO se arregla acá porque el arreglo es un índice nuevo en la base de PRODUCCIÓN, y
        // eso se avisa antes. Queda anotado en el backlog. Importa más de lo que parece:
        // la relación Subject↔Course se resuelve por el TEXTO del nombre (deuda nº 16 del
        // backlog), así que dos materias homónimas en la misma escuela hacen que el detalle
        // de materia muestre cursos de la otra, sin ningún error a la vista.
        const repetida = await client.post('admin', '/admin/subjects/create', {
          body: { name: nombre }, expectStatus: 201,
        });
        creadas.push(repetida.json.subject._id);
      } finally {
        for (const id of creadas) {
          await client.post('admin', `/admin/subjects/${id}/delete`, { expectStatus: [200, 204] });
        }
      }
    },
  },
  {
    id: 'import-plantilla-se-descarga',
    title: 'Las dos plantillas de importación se descargan como Excel de verdad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Se mira el Content-Disposition y que pese algo: una plantilla que se genera mal
      // suele salir con 200 y cero bytes, y así el admin baja un archivo que Excel no abre.
      for (const [actor, ruta] of [['admin', '/admin/import/template'], ['superadmin', '/superadmin/import/template']]) {
        const r = await client.get(actor, ruta, { expectStatus: 200 });
        assert(/\.xlsx/.test(r.headers.get('content-disposition') || ''),
          `${ruta} debería ofrecer un .xlsx; mandó ${r.headers.get('content-disposition')}`);
        assert((r.byteLength || 0) > 1000, `${ruta} devolvió ${r.byteLength} bytes: la plantilla salió vacía`);
      }
    },
  },
  {
    id: 'courses-divisions-lista-las-de-la-escuela',
    title: 'El selector de cursos devuelve las divisiones de la escuela del usuario',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const r = await client.get('admin', '/courses/divisions', { expectStatus: 200 });
      assert(Array.isArray(r.json?.divisions), `debería devolver { divisions: [] }; devolvió ${JSON.stringify(r.json).slice(0, 80)}`);
      if (state.divisionName) {
        assert(r.json.divisions.some(d => d.name === state.divisionName),
          'la división de prueba debería estar en la lista');
      }
    },
  },
  {
    id: 'available-templates-responde-siempre',
    title: 'El selector de plantillas del docente contesta una lista, con el flag prendido o apagado',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El contrato de esta ruta es "siempre una lista": con TASK_TEMPLATES_TEACHER_ENABLED
      // apagado devuelve [] en vez de un error, justamente para que el frontend pueda
      // llamarla sin preguntar por el flag. Si algún día devolviera 404, el formulario de
      // crear actividad rompería en una escuela que no usa plantillas.
      assert(state.courseId, 'falta el curso de prueba');
      const r = await client.get('scopedTeacher', `/activities/available-templates?courseId=${state.courseId}`, { expectStatus: 200 });
      assert(Array.isArray(r.json?.templates), `debería devolver { templates: [] }; devolvió ${JSON.stringify(r.json).slice(0, 80)}`);

      // Sin courseId es 400 solo con el flag prendido; con el flag apagado la ruta corta
      // antes y devuelve la lista vacía. Las dos son respuestas válidas: lo que no puede
      // pasar es un 500.
      const sinCurso = await client.get('scopedTeacher', '/activities/available-templates');
      assert([200, 400].includes(sinCurso.status), `sin courseId debería ser 200 o 400, fue ${sinCurso.status}`);
    },
  },
  {
    id: 'upload-attachment-sube-y-respeta-permisos',
    title: 'El docente pre-sube un PDF y un ajeno no puede pre-subir a su materia',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El camino feliz de la pre-subida (la que usa /activities/new) nunca había corrido.
      // Es la ruta por la que entra CADA adjunto de actividad del sistema.
      assert(state.courseId, 'falta el curso de prueba');
      const pdf = Buffer.concat([
        Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
        Buffer.alloc(64 * 1024, 0x25), // '%' = comentario: sigue siendo un PDF válido
      ]);

      const fd = new FormData();
      fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'consigna.pdf');
      const r = await client.post('scopedTeacher', `/activities/upload-attachment?courseId=${state.courseId}`, {
        form: fd, expectStatus: 200, timeoutMs: 30000,
      });
      assert(/^\/archivos\/.+\.pdf$/.test(r.json?.url || ''), `debería devolver la URL del archivo; devolvió ${JSON.stringify(r.json)}`);
      assert(r.json.name === 'consigna.pdf', `debería conservar el nombre original; devolvió ${r.json.name}`);

      // El alumno de la materia tampoco puede: la ruta pide canManage, no matrícula.
      // Relogin por el mismo motivo que en submit-archivo-demasiado-grande-da-413: el spec
      // de invalidación de cache le dejó el jar vacío, y un 302 al login haría pasar este
      // chequeo por la razón equivocada (un anónimo tampoco entra, pero eso no prueba nada).
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: 'SmokeTest1234' }, expectStatus: 200,
      });
      const fd2 = new FormData();
      fd2.append('file', new Blob([pdf], { type: 'application/pdf' }), 'colada.pdf');
      await client.post('scopedStudent', `/activities/upload-attachment?courseId=${state.courseId}`, {
        form: fd2, expectStatus: 403, timeoutMs: 30000,
      });

      // Y un tipo de archivo fuera de la lista se rechaza con 400 explicando cuáles valen.
      const fd3 = new FormData();
      fd3.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'notas.txt');
      const malo = await client.post('scopedTeacher', `/activities/upload-attachment?courseId=${state.courseId}`, {
        form: fd3, expectStatus: 400, timeoutMs: 30000,
      });
      assert(/PDF/i.test(malo.json?.error || ''), `debería decir qué formatos acepta; dijo ${JSON.stringify(malo.json)}`);

      // El 403 del ajeno tiene que llegar ANTES de que el archivo se escriba: el chequeo de
      // permiso pasó a ser un middleware previo a multer (exigirGestorDelCurso). Con un
      // courseId que no existe la ruta corta igual, sin llegar a tocar el disco.
      const fd4 = new FormData();
      fd4.append('file', new Blob([pdf], { type: 'application/pdf' }), 'inexistente.pdf');
      await client.post('scopedTeacher', '/activities/upload-attachment?courseId=000000000000000000000000', {
        form: fd4, expectStatus: 404, timeoutMs: 30000,
      });
    },
  },
  {
    id: 'planos-dwg-y-dxf-docente-y-alumno',
    title: 'Los planos de AutoCAD entran por los dos lados: los adjunta la docente y los entrega el alumno',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Pedido del 2026-08-29 (materias técnicas): primero el .dwg y en seguida el .dxf.
      //
      // Los dos formatos Y los dos caminos van juntos en un solo spec a propósito: el bug que
      // esto previene no es "el plano no entra", es "entra por uno de los dos" —el .heic del
      // 2026-08-24 fue exactamente eso, la lista de la entrega quedó atrás de la del resto de
      // la aplicación y nadie lo vio hasta que una persona no pudo entregar—. Un spec por
      // camino habría dejado pasar la mitad del problema.
      assert(state.courseId, 'falta el curso de prueba');

      // Los dos formatos, con contenido de verdad. El servidor no mira adentro de los
      // documentos —no hay nada que decodificar, van enteros a disco— pero archivos con la
      // forma correcta dejan el spec parecido al caso real. Y son dos cosas distintas: el DWG
      // es binario (cabecera AC1032 = AutoCAD 2018) y el DXF es texto plano.
      const PLANOS = [
        ['.dwg', 'image/vnd.dwg',
         Buffer.concat([Buffer.from('AC1032\x00\x00\x00\x00\x00', 'binary'), Buffer.alloc(32 * 1024, 0x00)])],
        ['.dxf', 'image/vnd.dxf',
         Buffer.from('  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n', 'utf8')],
      ];

      for (const [ext, mime, contenido] of PLANOS) {
        // ── La docente lo adjunta a la actividad ───────────────────────────
        const fd = new FormData();
        fd.append('file', new Blob([contenido], { type: mime }), `corte transversal${ext}`);
        const adj = await client.post('scopedTeacher', `/activities/upload-attachment?courseId=${state.courseId}`, {
          form: fd, expectStatus: 200, timeoutMs: 30000,
        });
        assert(new RegExp(`^/archivos/.+\\${ext}$`).test(adj.json?.url || ''),
          `el plano ${ext} debería conservar su extensión; devolvió ${JSON.stringify(adj.json)}`);
        // El espacio del nombre sobrevive al multipart, igual que en el PDF.
        assert(adj.json.name === `corte transversal${ext}`,
          `debería conservar el nombre original; devolvió ${adj.json.name}`);

        // ── El alumno lo entrega ───────────────────────────────────────────
        // Por la ruta de ARCHIVOS y no por la de imágenes: un plano no es una foto, así que no
        // pasa por sharp. Si algún día alguien lo metiera en la lista de imágenes, esto falla
        // con el "no se puede decodificar" del optimizador, que es justo lo que queremos saber.
        const fd2 = new FormData();
        fd2.append('file', new Blob([contenido], { type: mime }), `tp5 plano${ext}`);
        const ent = await client.post('scopedStudent', `/activities/${state.activityId}/upload-submission-file`, {
          form: fd2, expectStatus: 200, timeoutMs: 30000,
        });
        assert(ent.json.filename.endsWith(ext),
          `la entrega debería conservar la extensión, quedó: ${ent.json.filename}`);

        const submit = await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
          body: { text: `Plano del TP5 (${ext})`, uploadedFiles: [ent.json] }, expectStatus: 200,
        });
        assert(submit.json.submission.files.some(f => f.filename === ent.json.filename),
          `el plano ${ext} debería quedar en la entrega`);

        // ── Y se BAJA, no se intenta mostrar ───────────────────────────────
        // mime-types los mapea a `image/vnd.dwg` y `image/vnd.dxf`: servidos inline, el
        // navegador se queda con una pestaña en blanco creyendo que le pasamos una imagen
        // rota. El previsualizador del alumno pide el archivo con ?dl=1 justamente por eso.
        const bajada = await client.get('scopedTeacher',
          `/activities/submission-file/${ent.json.filename}?dl=1`, { expectStatus: 200 });
        assert((bajada.headers.get('content-disposition') || '').startsWith('attachment'),
          `un plano ${ext} se descarga: no hay visor de AutoCAD en el navegador`);
      }
    },
  },
  {
    id: 'actividad-adjunto-imagen',
    title: 'La docente adjunta una foto a la actividad, se guarda en WebP y el alumno la ve',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El pedido del 2026-08-19: "en la creación de una actividad, el docente debe poder
      // subir y compartir archivos de imágenes". Antes rebotaba por extensión — la foto del
      // pizarrón había que subirla a Drive y pegar el enlace.
      assert(state.courseId, 'falta el curso de prueba');

      // Una foto GRANDE de verdad, como la que sale de un celular. No sirve un PNG de 1×1:
      // el optimizador conserva el original cuando el WebP pesaría más (que es lo correcto
      // para un ícono diminuto), así que con la imagen chica este spec estaría midiendo la
      // rama equivocada y pasaría sin probar nada de lo que dice probar.
      const foto = await fotoDePrueba(2400, 1800);
      const formCon = (buf, nombre, tipo) => {
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: tipo }), nombre);
        return fd;
      };
      const rutaImagen = `/activities/upload-image?courseId=${state.courseId}`;

      // ── La docente la pre-sube ────────────────────────────────────────────
      const sub = await client.post('scopedTeacher', rutaImagen, {
        form: formCon(foto, 'pizarrón clase 1.jpg', 'image/jpeg'),
        expectStatus: 200, timeoutMs: 30000,
      });
      assert(/^\/archivos\/.+\.webp$/.test(sub.json?.url || ''),
        `debería guardarse recomprimida a WebP; devolvió ${JSON.stringify(sub.json)}`);
      // El nombre visible lleva la extensión que quedó EN DISCO: mostrar ".jpg" haría que el
      // archivo descargado no coincida con su propio nombre.
      assert(sub.json.name === 'pizarrón clase 1.webp',
        `el nombre debería conservar el original con la extensión final; es "${sub.json.name}"`);
      assert(sub.json.mime === 'image/webp', `el mime debería ser image/webp; es "${sub.json.mime}"`);

      // El archivo está y se sirve: es lo que va a pedir el <img> de la miniatura. Y pesa una
      // fracción del original — es lo que van a bajar 30 alumnos al abrir la tarea.
      const enDisco = await client.get('scopedTeacher', sub.json.url, { expectStatus: 200 });
      assert((enDisco.byteLength || 0) > 0, 'la imagen servida no puede venir vacía');
      assert(enDisco.byteLength < foto.length / 2,
        `la guardada debería pesar bastante menos que el original (${foto.length} B); pesa ${enDisco.byteLength} B`);

      // ── Y la usa al crear la actividad ────────────────────────────────────
      const creada = await client.post('scopedTeacher', '/activities/create', {
        body: {
          courseId: state.courseId,
          title:    `Actividad con foto ${RUN_ID}`,
          type:     'tarea',
          uploadedFiles: JSON.stringify([{ url: sub.json.url, name: sub.json.name, mime: sub.json.mime }]),
        },
        expectStatus: 201,
      });
      const actId   = creada.json.activity._id;
      const adjunto = (creada.json.activity.attachments || [])[0];
      assert(adjunto && adjunto.url === sub.json.url,
        `la actividad debería quedar con la imagen adjunta; quedó ${JSON.stringify(creada.json.activity.attachments)}`);
      assert(adjunto.type === 'file', `el adjunto debería ser de tipo file; es "${adjunto.type}"`);

      // Una URL que NO salió de nuestras rutas de subida no se guarda como adjunto: el campo
      // `uploadedFiles` lo arma el navegador, y lo que se guarde ahí lo termina abriendo el
      // alumno. Se corta la creación entera, no se saltea la entrada en silencio.
      const colada = await client.post('scopedTeacher', '/activities/create', {
        body: {
          courseId: state.courseId,
          title:    `Actividad con URL colada ${RUN_ID}`,
          uploadedFiles: JSON.stringify([{ url: 'https://ejemplo.invalido/pixel.png', name: 'pixel.png' }]),
        },
        expectStatus: 400,
      });
      assert(/adjunt/i.test(colada.json?.error || ''),
        `debería explicar que el adjunto no es válido; dijo ${JSON.stringify(colada.json)}`);

      // ── El alumno la ve ───────────────────────────────────────────────────
      // Relogin por el mismo motivo que en upload-attachment-sube-y-respeta-permisos: el spec
      // de invalidación de cache le deja el jar vacío, y un 302 al login haría pasar los dos
      // chequeos de abajo por la razón equivocada.
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: 'SmokeTest1234' }, expectStatus: 200,
      });
      const delAlumno = await client.get('scopedStudent', `/activities/course/${state.courseId}`, { expectStatus: 200 });
      const vista = delAlumno.json.activities.find(a => a._id === actId);
      assert(vista && (vista.attachments || []).some(a => a.url === sub.json.url),
        'el alumno debería ver la imagen entre los adjuntos de la actividad');

      // Pero no puede subir una: la ruta pide poder administrar el curso, no matrícula.
      await client.post('scopedStudent', rutaImagen, {
        form: formCon(foto, 'colada.jpg', 'image/jpeg'), expectStatus: 403, timeoutMs: 30000,
      });

      // ── Lo que no es una imagen no entra ──────────────────────────────────
      // Extensión permitida pero contenido que no es una imagen: lo caza sharp al decodificar,
      // y tiene que ser un 400 explicando el problema, no un 500 en el error.log.
      await client.post('scopedTeacher', rutaImagen, {
        form: formCon(Buffer.from('esto no es una imagen'), 'trucha.png', 'image/png'),
        expectStatus: 400, timeoutMs: 30000,
      });
      // Extensión fuera de la lista: se corta antes, por el fileFilter.
      const texto = await client.post('scopedTeacher', rutaImagen, {
        form: formCon(Buffer.from('hola'), 'notas.txt', 'text/plain'),
        expectStatus: 400, timeoutMs: 30000,
      });
      assert(/jpg|png/i.test(texto.json?.error || ''),
        `debería decir qué formatos acepta; dijo ${JSON.stringify(texto.json)}`);

      // ── Borrar la actividad se lleva la imagen del disco ──────────────────
      await client.delete('scopedTeacher', `/activities/${actId}`, { expectStatus: 200 });
      await client.get('scopedTeacher', sub.json.url, { expectStatus: 404 });
    },
  },
  // ── Subidas: un error del usuario no es un error del servidor ─────────────
  // multer corta la subida ANTES del handler (archivo muy grande, tipo no permitido) y para
  // eso lanza un error. Las rutas que no lo interceptan lo dejan llegar al manejador global,
  // que contesta 500 "Error del servidor (ref: ...)": el que sube se queda sin saber qué
  // hizo mal, y el error.log —que es donde se mira cuando algo se rompe DE VERDAD— se llena
  // de fallas que no son fallas. El patrón correcto ya existía en cuatro rutas
  // (subirImagen, conArchivo, upload-attachment, el pre-upload de entregas); estas eran las
  // que habían quedado afuera, y ninguna estaba en el smoke.
  {
    id: 'import-rechaza-archivo-que-no-es-excel',
    title: 'Subir un .csv al importador devuelve 400 explicando el formato, no 500',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Confundir el .csv del padrón con el .xlsx es EL error de dedo de esta pantalla.
      for (const [actor, ruta] of [['admin', '/admin/import/upload'], ['superadmin', '/superadmin/import/upload']]) {
        const fd = new FormData();
        fd.append('file', new Blob([Buffer.from('col1,col2\n1,2\n')], { type: 'text/csv' }), 'padron.csv');
        const r = await client.post(actor, ruta, { form: fd, expectStatus: 400, timeoutMs: 30000 });
        assert(/xls/i.test(r.json?.error || ''),
          `${ruta} debería decir qué formato espera; dijo ${JSON.stringify(r.json)}`);
      }
    },
  },
  {
    id: 'import-rechaza-excel-demasiado-grande',
    title: 'Un Excel que se pasa del tope devuelve 413 diciendo el tope, no 500',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.alloc(16 * 1024 * 1024, 0x41)]), 'enorme.xlsx');
      const r = await client.post('admin', '/admin/import/upload', { form: fd, expectStatus: 413, timeoutMs: 60000 });
      assert(/15 MB/.test(r.json?.error || ''),
        `el error debería nombrar el tope; dijo ${JSON.stringify(r.json)}`);
    },
  },
  {
    id: 'submit-archivo-demasiado-grande-da-413',
    title: 'Una entrega que se pasa del tope devuelve 413, no "Error del servidor"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es el caso que peor se ve: el alumno adjunta algo grande, espera la subida entera y
      // al final recibe un error genérico con una referencia de soporte. multer corta antes
      // que el handler, así que este 413 llega aunque la entrega estuviera cerrada por otro
      // motivo (plazo vencido, reenvío no permitido) — el tamaño se evalúa primero.
      assert(state.activityId, 'falta la actividad de prueba');
      // Relogin: 'cache-invalidation-on-disable' corre antes que este spec y deja al alumno
      // SIN cookie (deshabilitarlo hace que el middleware la borre; la cuenta se rehabilita
      // pero la sesión no vuelve sola). Sin esto, todo lo que haga este actor de acá en
      // adelante es un 302 al login, que se lee como una falla del endpoint y no lo es.
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: 'SmokeTest1234' }, expectStatus: 200,
      });

      const fd = new FormData();
      fd.append('files', new Blob([Buffer.alloc(21 * 1024 * 1024, 0x41)], { type: 'application/pdf' }), 'pesada.pdf');
      const r = await client.post('scopedStudent', `/activities/${state.activityId}/submit`, {
        form: fd, expectStatus: 413, timeoutMs: 60000,
      });
      assert(/20 MB/.test(r.json?.error || ''),
        `el error debería nombrar el tope; dijo ${JSON.stringify(r.json)}`);
    },
  },
  {
    id: 'activity-create-archivo-demasiado-grande-da-413',
    title: 'Crear una actividad con un adjunto pasado de tope devuelve 413, no 500',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      assert(state.courseId, 'falta el curso de prueba');
      const fd = new FormData();
      fd.append('courseId', state.courseId);
      fd.append('title', `Actividad pesada ${RUN_ID}`);
      fd.append('files', new Blob([Buffer.alloc(51 * 1024 * 1024, 0x41)], { type: 'application/pdf' }), 'gigante.pdf');
      const r = await client.post('teacher', '/activities/create', {
        form: fd, expectStatus: 413, timeoutMs: 120000,
      });
      assert(/50 MB/.test(r.json?.error || ''),
        `el error debería nombrar el tope; dijo ${JSON.stringify(r.json)}`);
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
      await client.get('admin', '/superadmin/backup/file-stats', { expectStatus: [403, 302] });
      // El envío por FTP saca una copia COMPLETA de la base fuera del servidor, a un destino
      // que elige quien llama. Es la ruta más sensible de toda la pantalla: si alguna vez se
      // montara fuera del router protegido, sería una exfiltración con un solo POST.
      await client.get('admin', '/superadmin/backup/ftp/config', { expectStatus: [403, 302] });
      await client.post('admin', '/superadmin/backup/ftp/enviar', { body: {}, expectStatus: [403, 302] });
      await client.post('admin', '/superadmin/backup/ftp/probar', { body: {}, expectStatus: [403, 302] });
    },
  },
  {
    id: 'backup-stats',
    title: 'El endpoint de stats devuelve contadores de todas las colecciones',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/backup/stats', { expectStatus: 200 });
      // La lista tiene que ser la misma que COLLECTIONS en routes/backup.js. Una colección
      // que se respalda pero no aparece acá es exactamente el agujero contra el que avisa
      // el comentario de ese array: nadie se entera hasta que hace falta restaurarla.
      const expected = [
        'schools', 'users', 'courses', 'activities', 'submissions', 'announcements',
        'suggestions', 'divisions', 'subjects', 'roomsessions', 'roommessages', 'roompresences',
      ];
      expected.forEach(name => assert(typeof res.json.collections[name] === 'number', `falta el contador de ${name}`));
      assert(typeof res.json.files.archivos.sizeBytes === 'number', 'falta el tamaño de archivos/');
    },
  },
  {
    id: 'backup-file-stats',
    title: 'El desglose por tipo de archivo alimenta el modal de compresión',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/backup/file-stats', { expectStatus: 200 });
      const d = res.json;

      // Los tipos son fijos (services/backupCompressor.js): la vista arma un check por cada
      // comprimible, y uno que desaparezca sería ahorro perdido en silencio.
      ['imagenes', 'pdf', 'webp', 'documentos', 'otros'].forEach(id => {
        const t = d.porTipo[id];
        assert(t, `falta el tipo ${id}`);
        assert(typeof t.count === 'number' && t.count >= 0, `${id}: count inválido`);
        assert(typeof t.bytes === 'number' && t.bytes >= 0, `${id}: bytes inválido`);
        assert(typeof t.comprimible === 'boolean', `${id}: falta el flag comprimible`);
        assert(t.ahorroEstimado >= 0 && t.ahorroEstimado <= t.bytes,
          `${id}: el ahorro estimado (${t.ahorroEstimado}) no puede superar el peso (${t.bytes})`);
        if (!t.comprimible) assert(t.ahorroEstimado === 0, `${id} no es comprimible pero estima ahorro`);
      });

      const suma = Object.values(d.porTipo).reduce((a, t) => a + t.bytes, 0);
      assert(suma === d.total.bytes, `los tipos suman ${suma} pero el total dice ${d.total.bytes}`);

      assert(Array.isArray(d.topPesados) && d.topPesados.length <= 10, 'topPesados debería ser un array de hasta 10');
      d.topPesados.forEach(p => {
        assert(typeof p.bytes === 'number', 'falta el peso de un archivo del top');
        assert(typeof p.zona === 'string' && p.zona, 'falta la zona del archivo');
      });
      for (let i = 1; i < d.topPesados.length; i++) {
        assert(d.topPesados[i - 1].bytes >= d.topPesados[i].bytes, 'topPesados debería venir ordenado de mayor a menor');
      }

      // La vista deshabilita los checks según esto; si falta, quedarían todos habilitados
      // y el usuario pediría una compresión que el servidor no puede hacer.
      assert(typeof d.herramientas.imagenes === 'boolean', 'falta herramientas.imagenes');
      assert(typeof d.herramientas.pdf === 'boolean', 'falta herramientas.pdf');
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

      // El .tar.gz se streamea mientras se arma, así que un fallo a mitad de camino no puede
      // cambiar el status (ya salió 200). Verificar la firma gzip es lo que distingue un
      // backup de verdad de una respuesta rota que igual llegó con 200 y con el header puesto.
      assert(res.firstBytes && res.firstBytes[0] === 0x1f && res.firstBytes[1] === 0x8b,
        `el cuerpo no arranca con la firma gzip (1f 8b): ${res.firstBytes ? [...res.firstBytes].map(b => b.toString(16)).join(' ') : 'sin cuerpo'}`);
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
  {
    id: 'backup-preview-accepts-backup-sin-colecciones-nuevas',
    title: 'El preview ACEPTA un backup anterior a la sala en vivo y avisa qué se va a vaciar',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Regresión de un bug real (2026-08-08): el preview exigía TODAS las colecciones de
      // COLLECTIONS, y roomsessions/roommessages/roompresences se agregaron con la sala en vivo.
      // Resultado: los 12 pre-restore-*.tar.gz acumulados en backups/ (2,8 GB, jul–ago 2026)
      // daban 400 — es decir, las redes de seguridad que genera el propio /restore antes de
      // pisar la base eran todas irrestaurables, y no había forma de enterarse hasta necesitarlas.
      //
      // Deja un .tar.gz de unos bytes en el UPLOADS_DIR del server, que se autolimpia a los
      // 30 min (no hay endpoint para descartar un preview).
      const fd = new FormData();
      fd.append('file', new Blob([await backupSintetico(COLECCIONES_V1)], { type: 'application/gzip' }), 'viejo.tar.gz');
      const res = await client.post('superadmin', '/superadmin/backup/preview', { form: fd, expectStatus: 200 });

      assert(res.json.previewToken, 'un backup viejo válido debería habilitar el restore, no rechazarse');

      // Todas las colecciones que nacieron DESPUÉS de que se congelara el formato 1.0.
      //
      // La lista se DERIVA de COLLECTIONS en vez de escribirse a mano. Antes estaba fija en
      // las cinco de entonces (sala en vivo + asistencia de preceptoría) con un comentario
      // que pedía acordarse de actualizarla, y el 2026-08-29 —cuando se sumaron las 14 que
      // faltaban, entre ellas los legajos del SOE— este spec se cayó por eso y no por un
      // problema real. Un test que hay que acordarse de mantener al día es un test que en
      // algún momento va a mentir: o se rompe cuando todo está bien, o pasa cuando no.
      //
      // Derivarla no lo vuelve tautológico: lo que se verifica no es la lista sino que el
      // preview la CALCULE y la REPORTE. Si alguien suma una colección sin `optional: true`,
      // el preview rechaza el backup viejo y el assert del previewToken de arriba lo caza.
      const nuevas = COLLECTIONS
        .filter(c => c.optional && !(c.name in COLECCIONES_V1))
        .map(c => c.name);
      nuevas.forEach(n => assert(res.json.willEmpty?.includes(n), `willEmpty debería avisar de ${n}`));
      assert(res.json.willEmpty.length === nuevas.length,
        `willEmpty debería tener exactamente esas ${nuevas.length}, trajo: ${res.json.willEmpty.join(', ')}`);

      // El aviso tiene que llegar también fila por fila: sin esto la tabla muestra un 0 que se
      // lee igual que "la colección venía vacía", que es una historia distinta.
      nuevas.forEach(n => assert(res.json.diff[n]?.missing === true, `el diff debería marcar ${n} como ausente`));
      assert(!res.json.diff.users.missing, 'users SÍ venía en el backup, no debería marcarse como ausente');
    },
  },
  {
    id: 'backup-preview-rejects-backup-sin-coleccion-obligatoria',
    title: 'El preview RECHAZA un backup al que le falta una colección obligatoria (400)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // La contracara del spec anterior, y la razón de que la tolerancia sea por colección y no
      // general: un backup truncado sin `users` tiene que seguir rechazándose, porque restaurarlo
      // vaciaría la tabla de usuarios en silencio.
      const { users, ...sinUsers } = COLECCIONES_V1;
      const fd = new FormData();
      fd.append('file', new Blob([await backupSintetico(sinUsers)], { type: 'application/gzip' }), 'truncado.tar.gz');
      const res = await client.post('superadmin', '/superadmin/backup/preview', { form: fd, expectStatus: 400 });
      assert(/users/.test(res.json?.error || ''),
        `el error debería nombrar la colección faltante, dijo: ${res.json?.error}`);
    },
  },

  // ── Envío del backup por FTP ──────────────────────────────────────────────
  // Estos specs NUNCA guardan un destino ni disparan un envío real, a propósito: correrían
  // contra el ftp-destino.json de la máquina de desarrollo y le pisarían al dueño el destino
  // que tenga configurado (la contraseña no se puede releer para dejarla como estaba). Por
  // eso todos usan un usuario que no puede coincidir con ninguno guardado — así el chequeo
  // de "es otro destino, escribí la contraseña" corta ANTES de tocar nada.
  //
  // La transferencia en sí se prueba en tests/unit/backupFtp.test.js, contra un servidor FTP
  // de verdad levantado por el propio test.
  {
    id: 'backup-ftp-config-shape',
    title: 'El destino FTP guardado se puede consultar sin que la contraseña vuelva al navegador',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('superadmin', '/superadmin/backup/ftp/config', { expectStatus: 200 });

      assert(typeof res.json.tienePassword === 'boolean', 'falta el flag tienePassword');
      assert(typeof res.json.puedeGuardarPassword === 'boolean', 'falta el flag puedeGuardarPassword');
      assert(Array.isArray(res.json.modos), 'falta la lista de modos de conexión');

      // Lo único que no puede pasar nunca: que la contraseña del FTP del dueño viaje al
      // navegador, ni en claro ni cifrada.
      const crudo = JSON.stringify(res.json);
      assert(!/passwordCifrada/.test(crudo), 'se filtró la contraseña cifrada al navegador');
      assert(!res.json.destino || !('password' in res.json.destino), 'se filtró la contraseña al navegador');
    },
  },
  {
    id: 'backup-ftp-config-rejects-invalid-host',
    title: 'Guardar un destino FTP inválido devuelve 400 con un mensaje entendible',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Falla en la validación, o sea ANTES de escribir el archivo: no pisa el destino real.
      const res = await client.post('superadmin', '/superadmin/backup/ftp/config', {
        body: { host: 'no es un host', usuario: 'x', modo: 'plano' }, expectStatus: 400,
      });
      assert(/no parece una IP/i.test(res.json?.error || ''),
        `el error debería explicar qué está mal, dijo: ${res.json?.error}`);
    },
  },
  {
    id: 'backup-ftp-probar-traduce-el-error-de-conexion',
    title: 'Probar un destino FTP que no existe devuelve 502 con una explicación accionable',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // Puerto 1 en localhost: nadie escucha ahí, así que el ECONNREFUSED es inmediato y el
      // spec no queda esperando un timeout de red.
      const res = await client.post('superadmin', '/superadmin/backup/ftp/probar', {
        body: { ...FTP_INEXISTENTE, password: 'da-igual' }, expectStatus: 502,
      });

      const error = res.json?.error || '';
      // 502 y no 400: la request estaba bien, lo que falló es la máquina del otro lado.
      assert(/servidor FTP/i.test(error), `el error debería hablar del servidor FTP, dijo: ${error}`);
      // Devolver "connect ECONNREFUSED 127.0.0.1:1" obligaría al dueño a googlearlo. La
      // traducción es la mitad del valor de esta pantalla.
      assert(!/ECONNREFUSED/.test(error), `se filtró el error crudo de Node: ${error}`);
    },
  },
  {
    id: 'backup-ftp-enviar-exige-contrasena-antes-de-empezar',
    title: 'Enviar a un destino sin contraseña falla con 400 y no arranca ninguna transferencia',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      // La ruta responde en streaming (NDJSON), así que los headers salen antes de saber si
      // va a funcionar. Todo lo que se pueda detectar ANTES tiene que salir como status HTTP
      // de verdad: si esto degradara a 200 + evento de error, un fallo de configuración
      // pasaría por "envío iniciado" y encima habría armado el .tar.gz al pedo.
      const res = await client.post('superadmin', '/superadmin/backup/ftp/enviar', {
        body: FTP_INEXISTENTE, expectStatus: 400,
      });

      assert(/contraseña/i.test(res.json?.error || ''),
        `el error debería pedir la contraseña, dijo: ${res.json?.error}`);
      // Que la respuesta sea JSON y no el stream es parte de lo que se está fijando acá.
      assert(res.json && !res.json.tipo, 'debería ser un error JSON, no un evento del stream');
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

  // ── Ventana de mantenimiento (esperar a que la plataforma se vacíe) ────────
  // Ver specs/mantenimiento-ventana.spec.md. Todos usan try/finally con
  // /maintenance/off (y NO /cancel): off apaga cualquiera de los dos estados, así que
  // limpia incluso si el escenario terminó activando el mantenimiento de verdad. Si algo
  // quedara pegado, los specs siguientes se quedarían sin poder autenticar a sus actores.
  {
    id: 'maintenance-pending-blocks-ingress',
    title: 'Mantenimiento EN ESPERA: corta los ingresos nuevos y NO toca a quien ya está trabajando',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert, env }) {
      try {
        // Umbral de 60 min a propósito: garantiza que los actores de este mismo smoke
        // cuenten como "gente trabajando" y la ventana quede EN ESPERA en vez de
        // activarse en el acto (que es lo que pasaría con la plataforma vacía).
        const prog = await client.post('superadmin', '/superadmin/backup/maintenance/schedule', {
          body: { message: 'Smoke: mantenimiento programado', eta: '5 minutos', idleMinutes: 60 },
          expectStatus: 200,
        });
        assert(prog.json.activated === false,
          'con los actores del smoke conectados debería quedar en espera, no activarse');
        assert(prog.json.pending && prog.json.pending.pending === true,
          'debería devolver el estado en espera');

        const status = await client.get('superadmin', '/superadmin/backup/maintenance-status', { expectStatus: 200 });
        assert(status.json.state === null,
          'una espera NO puede figurar como mantenimiento activo: bloquearía a todos');
        assert(status.json.pending, 'maintenance-status debería reportar la espera');

        // El corazón del pedido: el que ya está adentro sigue trabajando sin enterarse.
        await client.get('teacher', '/courses', { expectStatus: 200 });

        // Pero no entra nadie nuevo, ni con credenciales válidas.
        const rechazo = await client.post('ingressProbe', '/login', {
          body: { email: teacher.email, password: teacher.password },
          expectStatus: 503,
        });
        assert(rechazo.json && rechazo.json.pending === true,
          'el 503 debería aclarar que es por un mantenimiento en espera');

        // El dueño SÍ puede entrar: sin esta excepción, una cookie vencida durante su
        // propia ventana lo dejaría afuera del panel donde se apaga.
        await client.post('ownerProbe', '/login', {
          body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
          expectStatus: 200,
        });

        // Y el formulario lo avisa antes de que nadie tipee una contraseña.
        const loginPage = await client.get(null, '/login', { expectStatus: 200 });
        assert(loginPage.text.includes('Mantenimiento en unos minutos'),
          'la pantalla de login debería avisar del mantenimiento inminente');

        // Crear una cuenta era "la forma más extrema de querer entrar ahora" y este probe
        // esperaba el 503 del mantenimiento. Desde el 2026-08-23 el registro está cerrado
        // (services/registroPublico.js), así que la respuesta correcta es 403 y no 503: la
        // puerta cerrada gana sobre el "volvé más tarde", que sería mentirle al que pregunta.
        // El corte de ingresos por mantenimiento ya quedó probado arriba, sobre /login.
        const bloqueado = await client.post('ingressProbe', '/register', {
          body: {
            name: 'Smoke Bloqueado', email: `smoke.blocked.${RUN_ID}@example.com`,
            password: 'SmokeTest1234', role: 'teacher', dni: dniSmoke(90),
          },
          expectStatus: 403,
        });
        assert(bloqueado.json && bloqueado.json.registroCerrado === true,
          `ni en mantenimiento el registro debería contestar otra cosa que registro cerrado; dijo ${JSON.stringify(bloqueado.json)}`);
      } finally {
        await client.post('superadmin', '/superadmin/backup/maintenance/off', { body: {} });
      }

      // Cancelada la espera, la puerta se abre de nuevo en la request siguiente.
      const limpio = await client.get('superadmin', '/superadmin/backup/maintenance-status', { expectStatus: 200 });
      assert(limpio.json.pending === null, 'no debería quedar ninguna espera en curso');
      await client.post('reingressProbe', '/login', {
        body: { email: teacher.email, password: teacher.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'maintenance-activity-semaforo',
    title: 'El semáforo dice cuánta gente está trabajando, sin contar al dueño',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      const act = await client.get('superadmin', '/superadmin/backup/maintenance/activity?idleMinutes=2', { expectStatus: 200 });
      assert(typeof act.json.count === 'number', 'debería devolver cuánta gente hay trabajando');
      assert(typeof act.json.ready === 'boolean', 'debería devolver el semáforo listo/ocupado');
      assert(Array.isArray(act.json.users), 'debería devolver quiénes son');
      assert(act.json.ready === (act.json.count === 0), 'ready y count tienen que ser coherentes');

      // El dueño no puede contar como "gente trabajando": mirando este mismo panel
      // refresca su lastSeen cada 10 s y bloquearía su propio mantenimiento para siempre.
      // El monitor (que NO lo excluye) sí lo ve conectado ahora — misma ventana de 2 min.
      const mon = await client.get('superadmin', '/superadmin/monitor/stats', { expectStatus: 200 });
      assert((mon.json.users.byRole.superadmin || 0) >= 1,
        'el monitor debería ver al dueño conectado ahora mismo');
      assert(!act.json.byRole.superadmin,
        'el dueño no puede figurar entre la gente que está trabajando');

      // Umbral fuera de rango: se recorta, no se rechaza.
      const recortado = await client.get('superadmin', '/superadmin/backup/maintenance/activity?idleMinutes=999', { expectStatus: 200 });
      assert(recortado.json.idleMinutes === 60, `debería recortar a 60 min, devolvió ${recortado.json.idleMinutes}`);
      assert(recortado.json.users.length <= 25, 'la lista no debería pasar de 25 personas');
      assert(recortado.json.truncated === (recortado.json.count > recortado.json.users.length),
        'truncated tiene que ser coherente con count y la lista');
    },
  },
  {
    id: 'maintenance-window-conflicts',
    title: 'Cancelar la espera, y no confundirla con el mantenimiento ya activo',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, assert }) {
      try {
        await client.post('superadmin', '/superadmin/backup/maintenance/schedule', {
          body: { message: 'Smoke: espera a cancelar', idleMinutes: 60 }, expectStatus: 200,
        });
        await client.post('superadmin', '/superadmin/backup/maintenance/cancel', { body: {}, expectStatus: 200 });

        const tras = await client.get('superadmin', '/superadmin/backup/maintenance-status', { expectStatus: 200 });
        assert(tras.json.pending === null && tras.json.state === null,
          'cancelar debería dejar el sistema funcionando normalmente');

        // Cancelar dos veces no es un error (idempotente).
        await client.post('superadmin', '/superadmin/backup/maintenance/cancel', { body: {}, expectStatus: 200 });

        // Con el mantenimiento YA activo, ni se programa una espera ni se "cancela":
        // desbloquear la app tiene que ser un acto explícito (/maintenance/off).
        await client.post('superadmin', '/superadmin/backup/maintenance/on', {
          body: { message: 'Smoke: activo' }, expectStatus: 200,
        });
        await client.post('superadmin', '/superadmin/backup/maintenance/schedule', {
          body: { idleMinutes: 60 }, expectStatus: 409,
        });
        await client.post('superadmin', '/superadmin/backup/maintenance/cancel', { body: {}, expectStatus: 409 });

        const activo = await client.get('superadmin', '/superadmin/backup/maintenance-status', { expectStatus: 200 });
        assert(activo.json.state, 'el mantenimiento activo tiene que seguir intacto tras los 409');
      } finally {
        await client.post('superadmin', '/superadmin/backup/maintenance/off', { body: {} });
      }

      await client.get('scopedTeacher', '/courses', { expectStatus: 200 });
    },
  },
  {
    id: 'maintenance-window-denied-for-regular-admin',
    title: 'Un admin de escuela NO puede ver el semáforo ni programar mantenimiento (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('admin',  '/superadmin/backup/maintenance/activity', { expectStatus: 403 });
      await client.post('admin', '/superadmin/backup/maintenance/schedule', { body: {}, expectStatus: 403 });
      await client.post('admin', '/superadmin/backup/maintenance/cancel',   { body: {}, expectStatus: 403 });
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
    // specs/actividades-en-clase.spec.md — CA-11 a CA-17.
    // Para cuando corre este spec, la materia del curso ya tiene actividades creadas HOY
    // (las dejó 'teacher-creates-activity'), así que el día de hoy tiene que dar "subió".
    id: 'preceptor-actividades-del-dia',
    title: 'El preceptor ve el calendario del mes y el detalle del día de su curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const pantalla = await client.get('preceptor',
        `/preceptor/actividades?division=${state.divisionId}`, { expectStatus: 200 });
      assert(pantalla.text.includes('Actividades del día'), 'debería abrir la solapa');
      assert(pantalla.text.includes('data-dia='), 'el calendario debería traer sus días clickeables');

      const hoy = diaEscolar();
      const dia = await client.get('preceptor',
        `/preceptor/actividades/${state.divisionId}/dia/${hoy}`, { expectStatus: 200 });
      assert(dia.json.dia === hoy, 'debería contestar por el día pedido');
      assert(dia.json.subieron.length + dia.json.noSubieron.length === dia.json.totalMaterias,
        'la suma de las dos listas tiene que dar el total de materias del curso');
      assert(dia.json.subieron.some(m => (m.actividades || []).length > 0),
        'al menos una materia del curso debería figurar con actividad de hoy');

      // Una fecha que no existe no llega a la base.
      await client.get('preceptor', `/preceptor/actividades/${state.divisionId}/dia/2026-13-40`,
        { expectStatus: 400 });

      // Y el alcance manda: la división ajena no se lee cambiando el id en la URL.
      await client.get('preceptor', `/preceptor/actividades/${state.otherDivisionId}/dia/${hoy}`,
        { expectStatus: 403 });
    },
  },
  // ── Preceptoría: asistencia del día (specs/asistencia-preceptoria.spec.md) ──
  //
  // El orden sigue una jornada real y eso es lo que hace legible al bloque: el preceptor deja
  // la ventana abierta a la mañana, los chicos se la dan solos, él corrige lo que hace falta,
  // cierra, y más tarde vuelve a pasar lista sobre LA MISMA planilla. Al final del día queda
  // una sola (decisión del usuario, 2026-08-10).
  //
  // Corre antes que los specs que dan de alta, deshabilitan y desmatriculan alumnos, para que
  // la nómina del curso no se mueva mientras se prueba.
  {
    id: 'attendance-setup-actores',
    title: 'Se preparan los actores del bloque de asistencia',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // El jar de cookies de `scopedStudent` viene VACÍO desde 'cache-invalidation-on-disable':
      // ese spec lo deshabilita, checkUser responde con clearCookie('token') y el cliente de
      // test guarda la cookie vacía. Re-habilitarlo NO le devuelve la sesión al cliente.
      // Es la misma trampa que documenta 'sala-setup-sesiones' más abajo; acá aparece antes
      // porque este bloque es el primero que vuelve a usar al alumno.
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: student.password },
        expectStatus: 200,
      });
      await client.post('scopedTeacher', '/login', {
        body: { email: state.scopedTeacherEmail, password: teacher.password },
        expectStatus: 200,
      });

      // Segundo alumno del curso. Hace falta uno que NO sea tocado por el preceptor, para
      // poder probar que el ausente que deja el cierre no le impide darse la asistencia en
      // una pasada posterior. Se crea ANTES de abrir la planilla: la nómina se congela.
      const email = `smoke.alumno2.${RUN_ID}@example.com`;
      const alta = await client.post('admin', '/admin/users/create', {
        body: {
          name: 'Smoke Alumno Dos', email, password: student.password,
          role: 'student', dni: dniSmoke(33), divisionId: state.divisionId,
        },
        expectStatus: 201,
      });
      state.alumno2Id = alta.json.user._id;
      await client.post('alumno2', '/login', {
        body: { email, password: student.password }, expectStatus: 200,
      });

      // Segundo preceptor, con la misma división a cargo que el primero. Dos preceptores
      // compartiendo curso es lo normal en una escuela (turnos, o dos personas cubriendo el
      // mismo año).
      const emailP = `smoke.preceptor2.${RUN_ID}@example.com`;
      const altaP = await client.post('admin', '/admin/users/create', {
        body: {
          name: 'Smoke Preceptor 2', email: emailP, password: preceptor.password,
          role: 'preceptor', dni: dniSmoke(32),
          allDivisions: false, divisionIds: [state.divisionId],
        },
        expectStatus: 201,
      });
      state.preceptor2Id = altaP.json.user._id;
      await client.post('preceptor2', '/login', {
        body: { email: emailP, password: preceptor.password }, expectStatus: 200,
      });
    },
  },
  {
    id: 'preceptor-attendance-panel',
    title: 'El panel de asistencia lista los cursos a cargo y hoy figura sin tomar',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const res = await client.get('preceptor', '/preceptor/asistencia', { expectStatus: 200 });
      assert(res.text.includes(`SMOKE-${RUN_ID}`), 'debería listar la división asignada');
      assert(!res.text.includes(`SMOKE-B-${RUN_ID}`), 'NO debería listar la división ajena');
      assert(res.text.includes('Sin tomar'), 'la asistencia de hoy todavía no se tomó');

      // Se busca la basura como VALOR RENDERIZADO (entre tags, después de ":" o de "="), no
      // como subcadena suelta: "undefined" es una palabra del propio JavaScript de los
      // partials y "NaN" aparece de casualidad dentro de nombres propios. Mismo criterio que
      // el spec envivo-tarjetas, que ya se comió ese falso positivo.
      const basura = res.text.match(/(?:>|:\s*|=\s*"?)(NaN|Infinity)\b|>undefined</);
      assert(!basura, `el panel no debería mostrar ${basura ? basura[0] : ''} — contexto: ` +
        (basura ? JSON.stringify(res.text.slice(Math.max(0, basura.index - 80), basura.index + 40)) : ''));
    },
  },
  {
    id: 'preceptor-attendance-blocked-outside-scope',
    title: 'Abrir o ver la asistencia de un curso ajeno devuelve 403',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // otherDivisionId existe pero NO está asignada al preceptor. Es la barrera que separa
      // a un preceptor de la asistencia de los cursos que no tiene a cargo.
      await client.get('preceptor', `/preceptor/asistencia/${state.otherDivisionId}`, { expectStatus: 403 });
      await client.post('preceptor', `/preceptor/asistencia/${state.otherDivisionId}/abrir`, {
        body: { mode: 'pase' },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'preceptor-attendance-open',
    title: 'El preceptor abre la ventana del día y la nómina queda congelada sin marcar',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/asistencia/${state.divisionId}/abrir`, {
        body: { mode: 'ventana', closesInMin: 360 },   // 6 h: el tope
        expectStatus: 200,
      });
      assert(res.json.creada === true, 'la planilla debería crearse');
      state.tomaId = res.json.tomaId;

      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      assert(poll.json.estado === 'abierta', 'la planilla debería estar abierta');
      assert(poll.json.modo === 'ventana', `el modo debería ser 'ventana', es '${poll.json.modo}'`);
      assert(poll.json.autoasistencia === true, 'la ventana habilita la autoasistencia');
      assert(poll.json.cierraA, 'debería traer la hora de cierre ya formateada por el servidor');
      assert(poll.json.pasadas === 1, 'es la primera pasada del día');
      assert(poll.json.resumen.total >= 2, 'la nómina debería tener al menos dos alumnos');
      assert(poll.json.resumen.total === poll.json.resumen.sinMarcar,
        'al abrir, toda la nómina tiene que estar sin marcar');
      // Un alumno cursa varias materias del mismo curso: tiene que aparecer UNA sola vez.
      const ids = poll.json.marcas.map(m => m.studentId);
      assert(new Set(ids).size === ids.length, 'ningún alumno puede aparecer repetido en la nómina');
      assert(ids.includes(state.alumno2Id), 'el alumno creado antes de abrir tiene que estar en la nómina');
    },
  },
  {
    // El caso que reportó el usuario: la lista se abre con "Pasar lista", los chicos no ven
    // nada —en ese modo no participan— y desde la planilla no había forma de notarlo. Ahora
    // se corrige sin cerrar ni perder lo marcado.
    id: 'attendance-autoasistencia-toggle',
    title: 'Con el pase de lista el alumno no ve nada, y se abre para él sin cerrar la planilla',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Se apaga la autoasistencia sobre la planilla ya abierta.
      const off = await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/autoasistencia`, {
        body: { on: false },
        expectStatus: 200,
      });
      assert(off.json.autoasistencia === false, 'debería quedar apagada');
      assert(off.json.cierraA === null, 'sin ventana no tiene sentido conservar la hora de cierre');

      const sinNada = await client.get('scopedStudent', '/asistencia/abierta', { expectStatus: 200 });
      assert(!(sinNada.json.tomas || []).some(t => t.id === state.tomaId),
        'con el pase de lista el alumno NO tiene que ver la toma');
      const inicioSin = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(!inicioSin.text.includes('Dar presente'), 'ni el cartel en su inicio');
      await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`, { expectStatus: 409 });

      // Y se vuelve a abrir para ellos, con la planilla SIEMPRE abierta.
      const on = await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/autoasistencia`, {
        body: { on: true, closesInMin: 120 },
        expectStatus: 200,
      });
      assert(on.json.autoasistencia === true, 'debería quedar abierta para los alumnos');
      assert(on.json.cierraA, 'y con su hora de cierre ya formateada');

      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      assert(poll.json.estado === 'abierta', 'la planilla nunca se cerró');
      assert(poll.json.pasadas === 1, 'y esto no cuenta como una pasada nueva');
    },
  },
  {
    id: 'student-attendance-banner',
    title: 'El alumno ve la asistencia abierta en su inicio',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('scopedStudent', '/asistencia/abierta', { expectStatus: 200 });
      const toma = (res.json.tomas || []).find(t => t.id === state.tomaId);
      assert(toma, 'la planilla abierta debería figurarle al alumno');
      assert(toma.yaDi === false, 'todavía no la dio');
      assert(toma.abiertaDesde, 'debería traer la hora ya formateada por el servidor');

      const inicio = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(inicio.text.includes('Dar presente'), 'el cartel debería aparecer en el inicio');
    },
  },
  {
    id: 'student-attendance-checkin',
    title: 'El alumno se da la asistencia y queda con origen "alumno"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`,
        { expectStatus: 200 });
      assert(res.json.yaDi === false, 'es la primera vez que la da');
      assert(res.json.estado === 'presente', `debería quedar presente, quedó ${res.json.estado}`);
      assert(res.json.respetada === true, 'nadie había decidido antes, su marca vale');

      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const marca = poll.json.marcas.find(m => m.studentId === state.scopedStudentId);
      assert(marca.estado === 'presente' && marca.origen === 'alumno',
        `la marca debería ser presente/alumno, es ${marca.estado}/${marca.origen}`);
      assert(marca.seMarcoSolo === true, 'el preceptor tiene que ver que la dio el alumno');
      assert(marca.hora, 'la marca debería traer la hora ya formateada por el servidor');
      assert(poll.json.resumen.presentes === 1, 'el resumen debería contar 1 presente');
    },
  },
  {
    id: 'student-attendance-idempotent',
    title: 'Tocar el botón dos veces no duplica la marca ni pisa la hora original',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`,
        { expectStatus: 200 });
      assert(res.json.yaDi === true, 'la segunda vez tiene que avisar que ya la había dado, no dar error');

      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const suyas = poll.json.marcas.filter(m => m.studentId === state.scopedStudentId);
      assert(suyas.length === 1, `debería haber UNA marca suya, hay ${suyas.length}`);
      assert(poll.json.resumen.presentes === 1, 'y un solo presente en el resumen');
    },
  },
  {
    id: 'student-attendance-ignores-body',
    title: 'El alumno no puede marcar a un compañero ni elegir el estado',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El cuerpo se ignora POR COMPLETO. Es la puerta que hay que dejar cerrada: sin esto,
      // conocer el id de un compañero alcanzaría para ponerlo presente o justificado.
      const antes = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const companeroAntes = antes.json.marcas.find(m => m.studentId !== state.scopedStudentId);
      if (!companeroAntes) return;   // curso de un solo alumno: no hay a quién intentar marcarle

      await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`, {
        body: { studentId: companeroAntes.studentId, status: 'justificado', note: 'inventado' },
        expectStatus: 200,
      });

      const post = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const companero = post.json.marcas.find(m => m.studentId === companeroAntes.studentId);
      assert(companero.estado === companeroAntes.estado,
        `el compañero NO puede haber cambiado de estado (era ${companeroAntes.estado}, quedó ${companero.estado})`);
      const propia = post.json.marcas.find(m => m.studentId === state.scopedStudentId);
      assert(propia.estado === 'presente', 'y el que tocó el botón sigue simplemente presente');
      assert(!propia.nota, 'la nota del body tampoco se toma');
    },
  },
  {
    id: 'student-attendance-outside-roster',
    title: 'Un alumno que no cursa en ese curso no puede darse la asistencia (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // thirdDivisionId está en el alcance del preceptor pero NO tiene alumnos: la planilla
      // se abre con la nómina vacía, así que scopedStudent no figura en ella.
      const res = await client.post('preceptor', `/preceptor/asistencia/${state.thirdDivisionId}/abrir`, {
        body: { mode: 'ventana' },
        expectStatus: 200,
      });
      state.tomaAjenaId = res.json.tomaId;

      await client.post('scopedStudent', `/asistencia/${state.tomaAjenaId}/presente`, { expectStatus: 403 });
      // Y el docente tampoco, por más que sea de la escuela: esta ruta es solo de alumnos.
      await client.post('scopedTeacher', `/asistencia/${state.tomaId}/presente`, { expectStatus: 403 });
    },
  },
  {
    id: 'preceptor-attendance-dos-preceptores',
    title: 'Un segundo preceptor entra a la MISMA planilla y puede marcar en ella',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Con la planilla abierta, "abrir" devuelve LA MISMA: no se generan dos listas
      // paralelas del mismo día.
      const res = await client.post('preceptor2', `/preceptor/asistencia/${state.divisionId}/abrir`, {
        body: { mode: 'pase' },
        expectStatus: 200,
      });
      assert(res.json.creada === false, 'no debería crear una segunda planilla del mismo día');
      assert(res.json.pasadaNueva === false, 'con la planilla abierta no es una pasada nueva: se sigue en ella');
      assert(res.json.tomaId === state.tomaId,
        'debería devolver la planilla que ya había abierto el primer preceptor');

      // Y puede trabajar sobre ella: la asistencia del curso es una sola, la toma cualquiera
      // de los dos. Se marca a alguien que NO es scopedStudent ni alumno2, que tienen su
      // propio guion más abajo.
      const poll = await client.get('preceptor2', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const otro = poll.json.marcas.find(m => !m.estado
        && m.studentId !== state.scopedStudentId && m.studentId !== state.alumno2Id);
      if (!otro) return;

      await client.post('preceptor2', `/preceptor/asistencia/toma/${state.tomaId}/marcar`, {
        body: { studentId: otro.studentId, status: 'ausente' },
        expectStatus: 200,
      });
      const post = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const marca = post.json.marcas.find(m => m.studentId === otro.studentId);
      assert(marca.estado === 'ausente',
        'lo que marca el segundo preceptor tiene que verlo el primero: es una sola planilla');
    },
  },
  {
    id: 'preceptor-attendance-mark',
    title: 'El preceptor corrige la autoasistencia y rechaza los estados inventados',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/marcar`, {
        body: { studentId: state.scopedStudentId, status: 'tarde' },
        expectStatus: 200,
      });
      assert(res.json.corregida === true, 'pisar la marca que dio el alumno es una corrección');

      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const marca = poll.json.marcas.find(m => m.studentId === state.scopedStudentId);
      assert(marca.estado === 'tarde' && marca.origen === 'preceptor',
        'la corrección del preceptor manda');
      assert(marca.seMarcoSolo === true,
        'pero tiene que seguir constando que el alumno dio el presente — es lo que se discute en un reclamo');

      // Y si el chico vuelve a tocar el botón, no revierte la decisión del preceptor.
      const otra = await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`,
        { expectStatus: 200 });
      assert(otra.json.respetada === false, 'debería avisar que preceptoría ya había decidido');
      const post = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      assert(post.json.marcas.find(m => m.studentId === state.scopedStudentId).estado === 'tarde',
        'el alumno no puede revertir al preceptor desde el celular');

      // Lista blanca cerrada de estados: nunca se confía en el body.
      for (const basura of ['PRESENTE', 'inventado', '', null]) {
        await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/marcar`, {
          body: { studentId: state.scopedStudentId, status: basura },
          expectStatus: 400,
        });
      }
      // Un alumno que no está en ESTA planilla (nómina congelada) no se agrega marcándolo.
      await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/marcar`, {
        body: { studentId: state.preceptorId, status: 'presente' },
        expectStatus: 404,
      });
    },
  },
  {
    id: 'preceptor-attendance-close',
    title: 'Al cerrar, los que quedaron sin marcar pasan a ausentes por cierre',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/cerrar`,
        { expectStatus: 200 });
      const r = res.json.resumen;
      assert(r.sinMarcar === 0, `una planilla cerrada no puede tener sin marcar, tiene ${r.sinMarcar}`);
      assert(r.presentes + r.tarde + r.ausentes + r.justificados === r.total,
        'la suma de los estados tiene que dar el total de la nómina');

      // El ausente que pone el CIERRE se distingue del que marcó una persona. No es un
      // detalle: es lo que permite que una pasada posterior le sirva al alumno.
      const poll = await client.get('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/poll`,
        { expectStatus: 200 });
      const alumno2 = poll.json.marcas.find(m => m.studentId === state.alumno2Id);
      assert(alumno2.estado === 'ausente' && alumno2.origen === 'cierre',
        `el que nadie marcó debería quedar ausente/cierre, quedó ${alumno2.estado}/${alumno2.origen}`);

      // Con la planilla cerrada no se marca, ni el preceptor ni el alumno.
      await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/marcar`, {
        body: { studentId: state.scopedStudentId, status: 'presente' },
        expectStatus: 409,
      });
      await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`, { expectStatus: 409 });

      // Y el cartel del inicio desaparece.
      const abierta = await client.get('scopedStudent', '/asistencia/abierta', { expectStatus: 200 });
      assert(!(abierta.json.tomas || []).some(t => t.id === state.tomaId),
        'con la planilla cerrada el cartel no debería ofrecerla');
    },
  },
  {
    id: 'preceptor-attendance-otra-pasada',
    title: 'Pasar lista otra vez reabre la MISMA planilla, sin crear una segunda',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('preceptor', `/preceptor/asistencia/${state.divisionId}/abrir`, {
        body: { mode: 'ventana', closesInMin: 120 },
        expectStatus: 200,
      });
      assert(res.json.creada === false, 'no puede crear una segunda planilla del mismo día');
      assert(res.json.pasadaNueva === true, 'debería contar como una pasada nueva');
      assert(res.json.tomaId === state.tomaId, 'tiene que ser la MISMA planilla de hoy');
      assert(res.json.pasadas >= 2, `debería ir por la 2ª pasada o más, va por ${res.json.pasadas}`);

      // Lo que hace útil a la pasada nueva: el alumno que había quedado ausente POR EL CIERRE
      // sí puede darse la asistencia ahora. Si el cierre contara como decisión del preceptor,
      // la ventana de la tarde no le serviría a nadie.
      const suya = await client.post('alumno2', `/asistencia/${state.tomaId}/presente`,
        { expectStatus: 200 });
      assert(suya.json.respetada === true,
        'el ausente por cierre no es una decisión de nadie: el alumno todavía puede darse la asistencia');
      assert(suya.json.estado === 'presente', `debería quedar presente, quedó ${suya.json.estado}`);

      // Y el que SÍ tocó el preceptor sigue intocable.
      const otra = await client.post('scopedStudent', `/asistencia/${state.tomaId}/presente`,
        { expectStatus: 200 });
      assert(otra.json.respetada === false, 'lo que decidió el preceptor no lo cambia el alumno');

      await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaId}/cerrar`,
        { expectStatus: 200 });
      await client.post('preceptor', `/preceptor/asistencia/toma/${state.tomaAjenaId}/cerrar`,
        { expectStatus: 200 });
    },
  },
  {
    id: 'preceptor-attendance-audit',
    title: 'La apertura, el cierre y la corrección quedan en la auditoría',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const cuenta = async (accion) => {
        const res = await client.get('admin', `/admin/audit?action=${accion}`, { expectStatus: 200 });
        const m = res.text.match(/([\d.]+) evento/);
        return m ? parseInt(m[1].replace(/\./g, ''), 10) : 0;
      };
      for (const accion of ['attendance.open', 'attendance.close', 'attendance.change', 'attendance.reopen']) {
        assert(await cuenta(accion) > 0, `debería haber al menos un evento ${accion}`);
      }
    },
  },
  {
    id: 'preceptor-attendance-teacher-blocked',
    title: 'El docente y el alumno no entran a la asistencia de preceptoría',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('scopedTeacher', '/preceptor/asistencia', { expectStatus: 403 });
      await client.post('scopedTeacher', `/preceptor/asistencia/${state.divisionId}/abrir`, {
        body: { mode: 'pase' },
        expectStatus: 403,
      });
    },
  },

  // ── Historial y exportación ─────────────────────────────────────────────────
  {
    id: 'attendance-historial',
    title: 'El historial del curso lista los días tomados y el acumulado por alumno',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('preceptor', `/preceptor/asistencia/${state.divisionId}/historial`,
        { expectStatus: 200 });
      assert(res.text.includes('Historial'), 'debería renderizar la pantalla de historial');
      assert(res.text.includes('Por alumno'), 'debería traer el acumulado por alumno');
      assert(res.text.includes('pasadas'), 'debería avisar que ese día se pasó lista más de una vez');
      assert(/1 día con asistencia tomada/.test(res.text),
        'las varias pasadas del día son UN día en el historial, no varios');

      const basura = res.text.match(/(?:>|:\s*|=\s*"?)(NaN|Infinity)\b|>undefined</);
      assert(!basura, `el historial no debería mostrar ${basura ? basura[0] : ''}`);
    },
  },
  {
    id: 'attendance-historial-rango-invalido',
    title: 'Un rango de fechas malformado o invertido devuelve 400',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const base = `/preceptor/asistencia/${state.divisionId}`;
      await client.get('preceptor', `${base}/historial?desde=2026-08-31&hasta=2026-08-01`, { expectStatus: 400 });
      await client.get('preceptor', `${base}/historial?desde=31/08/2026&hasta=2026-08-01`, { expectStatus: 400 });
      await client.get('preceptor', `${base}/export?tipo=mes&desde=2026-13-99&hasta=2026-08-01`, { expectStatus: 400 });
      await client.get('preceptor', `${base}/export?tipo=dia&fecha=ayer`, { expectStatus: 400 });
    },
  },
  {
    id: 'attendance-export',
    title: 'Los dos CSV salen con punto y coma y los datos del curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const base = `/preceptor/asistencia/${state.divisionId}`;
      // El día lo arma diaEscolar (zona de la escuela), NO toISOString, que es UTC. Con
      // toISOString este test fallaba TODAS las noches a partir de las 21:00 de Buenos Aires:
      // la toma se archiva con el día escolar de hoy y el test la pedía con el de mañana,
      // así que el export respondía 404 "Toma de asistencia no encontrada". Es el mismo bug
      // que documenta el comentario de diaEscolar en services/liveRoom.js, del lado del test.
      const hoy  = require('../../services/liveRoom').diaEscolar();

      // El BOM NO se puede verificar desde acá: el decoder UTF-8 de fetch() lo saca al
      // llamar a res.text(). Se testea a nivel string en tests/unit/attendance.test.js.
      // Lo que sí se comprueba acá es el separador y que el contenido sea el del curso.
      const dia = await client.get('preceptor', `${base}/export?tipo=dia&fecha=${hoy}`, { expectStatus: 200 });
      assert(dia.text.includes('Alumno;DNI;Estado;'), `encabezado inesperado: ${dia.text.slice(0, 80)}`);
      // La columna "Quién la puso" es lo que hace útil al CSV del día: distingue lo que
      // decidió una persona de lo que se marcó solo el alumno.
      assert(dia.text.includes('El propio alumno'),
        'el CSV tiene que decir quién puso cada marca');

      const mes = await client.get('preceptor', `${base}/export?tipo=mes`, { expectStatus: 200 });
      assert(mes.text.includes('% de días que asistió'), 'debería traer la columna de porcentaje');
      assert(mes.text.includes('P = presente'), 'debería traer la referencia al pie');
    },
  },
  {
    id: 'attendance-export-outside-scope',
    title: 'El historial y el export de un curso ajeno devuelven 403',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('preceptor', `/preceptor/asistencia/${state.otherDivisionId}/historial`, { expectStatus: 403 });
      await client.get('preceptor', `/preceptor/asistencia/${state.otherDivisionId}/export?tipo=mes`, { expectStatus: 403 });
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
    // Antes: "nadie puede auto-registrarse como preceptor (cae a alumno)". Desde el
    // 2026-08-23 nadie puede auto-registrarse Y PUNTO, así que la garantía es más fuerte y
    // el spec lo dice: el rol no se degrada, la cuenta directamente no nace.
    //
    // La lista blanca de roles del POST sigue existiendo en routes/auth.js detrás del flag.
    // Es a propósito: si alguna vez se reabre el registro, tiene que reabrirse con el
    // preceptor todavía afuera.
    id: 'preceptor-role-not-self-assignable',
    title: 'Nadie puede auto-registrarse como preceptor: no hay auto-registro (403)',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const email = `fake.preceptor.${RUN_ID}@example.com`;
      await client.post(null, '/register', {
        body: {
          name: 'Smoke Fake Preceptor', email,
          password: 'SmokeTest1234', role: 'preceptor', dni: dniSmoke(9),
          divisionId: state.selfEnrollDivisionId,
        },
        expectStatus: 403,
      });

      // Y lo que de verdad importa: que no haya quedado NADA creado. Un 403 que igual
      // hubiera escrito el usuario sería el peor de los mundos.
      await client.post('noExiste', '/login', {
        body: { email, password: 'SmokeTest1234' },
        expectStatus: 400,
      });
      assert(true, 'la cuenta no existe: el login de esa dirección es rechazado');
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
      if (state.preceptor2Id)       await client.post('admin', `/admin/users/${state.preceptor2Id}/delete`, { expectStatus: 200 });
      if (state.alumno2Id)          await client.post('admin', `/admin/users/${state.alumno2Id}/delete`, { expectStatus: 200 });
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
    // ── Fusión de ALUMNOS duplicados por DNI (/superadmin/otros) ─────────────
    // Mismo panel y misma puerta que los docentes, pero lo que se transfiere son entregas y
    // notas. El caso real: la cuenta vieja es la que cursa y tiene las notas, la nueva se
    // creó después con el correo bueno, y el docente ve al alumno repetido en el gradebook.
    id: 'alumnos-dup-setup',
    title: 'Se arman dos cuentas de alumno con el mismo DNI en un curso (una con nota, otra vacía)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state }) {
      const dni = dniSmoke(25);
      state.dupAlumnoDni    = dni;
      state.dupAlumnoVieja  = `dup.alumno.viejo.${RUN_ID}@example.com`;
      state.dupAlumnoNueva  = `dup.alumno.nuevo.${RUN_ID}@example.com`;

      const vieja = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Alumno Dup Viejo ${RUN_ID}`, email: state.dupAlumnoVieja,
                password: 'SmokeTest1234', role: 'student', dni, divisionId: state.divisionId },
        expectStatus: 201,
      });
      state.dupAlumnoViejaId = vieja.json.user._id;

      const nueva = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Alumno Dup Nuevo ${RUN_ID}`, email: state.dupAlumnoNueva,
                password: 'OtraClave1234', role: 'student', dni: dniSmoke(26), divisionId: state.divisionId },
        expectStatus: 201,
      });
      state.dupAlumnoNuevaId = nueva.json.user._id;

      // La cuenta vieja es la que tiene trabajo hecho: es lo único que decide la sugerencia.
      await client.post('scopedTeacher', `/activities/${state.activityId}/grade`, {
        body: { studentId: state.dupAlumnoViejaId, points: '7', feedback: 'Smoke' },
        expectStatus: 200,
      });

      // El DNI repetido va directo a Mongo: por la ruta de alta no entra (normalizeDni le
      // saca los puntos y ahí sí choca contra el índice único).
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        await mongo.db().collection('users').updateOne(
          { _id: new ObjectId(state.dupAlumnoNuevaId) },
          { $set: { dni: `${dni.slice(0, 2)}.${dni.slice(2, 5)}.${dni.slice(5)}` } },
        );
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'alumnos-dup-diagnostico',
    title: 'El panel Otros detecta al alumno repetido y sugiere la cuenta que tiene la nota',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin', '/superadmin/otros/dni-duplicado-en-curso/diagnostico', { expectStatus: 200 });
      const grupo = (res.json.grupos || []).find(g => g.dni === state.dupAlumnoDni.replace(/^0+/, ''));
      assert(grupo, `debería detectar el grupo del DNI ${state.dupAlumnoDni}`);
      assert(grupo.cuentas.length === 2, `el grupo debería tener 2 cuentas, tiene ${grupo.cuentas.length}`);
      state.dupAlumnoClave = grupo.clave;

      assert(grupo.sugeridaId === state.dupAlumnoViejaId, 'la sugerida debería ser la que tiene la nota');
      const conNota = grupo.cuentas.find(c => c.id === state.dupAlumnoViejaId);
      assert(/1 nota\(s\)/.test(conNota.detalle), `el detalle debería contar la nota — dice: ${conNota.detalle}`);
      // La tercera opción para la cuenta sobrante es propia de los alumnos: sacarla del curso
      // sin tocar la cuenta, que es lo que hacía el arreglo antes de ser elegible caso por caso.
      assert((grupo.opcionesSobrante || []).some(o => o.value === 'sacar'),
        'debería poder dejarse la cuenta sobrante solo fuera del curso');
    },
  },
  {
    id: 'alumnos-dup-rechaza-cuenta-ajena',
    title: 'Fusionar un alumno hacia una cuenta que no es del grupo se rechaza',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state }) {
      // Sin esto, un id copiado a mano podría llevarse las notas de un alumno a otro.
      await client.post('superadmin', '/superadmin/otros/dni-duplicado-en-curso/fusionar', {
        body: { clave: state.dupAlumnoClave, keepId: state.scopedStudentId },
        expectStatus: 400,
      });
    },
  },
  {
    id: 'alumnos-dup-fusion-elige-correo',
    title: 'Se conserva la cuenta nueva con el correo de la vieja y se le pasa la nota',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert }) {
      const res = await client.post('superadmin', '/superadmin/otros/dni-duplicado-en-curso/fusionar', {
        body: { clave: state.dupAlumnoClave, keepId: state.dupAlumnoNuevaId,
                emailId: state.dupAlumnoViejaId, sobrante: 'deshabilitar' },
        expectStatus: 200,
      });
      assert(/1 nota\(s\)/.test(res.json.mensaje), `debería informar la nota transferida — dijo: ${res.json.mensaje}`);
      assert(res.json.mensaje.includes(state.dupAlumnoVieja), `debería informar el correo adoptado — dijo: ${res.json.mensaje}`);

      // La nota quedó en la cuenta conservada, no en la que se dio de baja.
      const libro = await client.get('scopedTeacher', `/courses/${state.courseId}/gradebook`, { expectStatus: 200 });
      const notas = libro.json.gradeMap[state.activityId] || {};
      assert(notas[state.dupAlumnoNuevaId] === 7, `la nota 7 debería estar en la cuenta conservada, gradeMap dice ${notas[state.dupAlumnoNuevaId]}`);
      assert(notas[state.dupAlumnoViejaId] === undefined, 'la cuenta sobrante no debería seguir con la nota');

      // La conservada entra con el correo adoptado y SU contraseña de siempre; la sobrante
      // se quedó con el correo que soltó y no puede iniciar sesión.
      await client.post('dupAlumnoConservada', '/login', {
        body: { email: state.dupAlumnoVieja, password: 'OtraClave1234' },
        expectStatus: 200,
      });
      await client.post('dupAlumnoSobrante', '/login', {
        body: { email: state.dupAlumnoNueva, password: 'SmokeTest1234' },
        expectStatus: [400, 401, 403],
      });

      const despues = await client.get('superadmin', '/superadmin/otros/dni-duplicado-en-curso/diagnostico', { expectStatus: 200 });
      assert(!(despues.json.grupos || []).some(g => g.clave === state.dupAlumnoClave),
        'el grupo fusionado no debería seguir apareciendo');
    },
  },
  {
    id: 'alumnos-dup-cleanup',
    title: 'Limpieza: se borran las dos cuentas de alumno duplicadas de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.dupAlumnoNuevaId) await client.post('admin', `/admin/users/${state.dupAlumnoNuevaId}/delete`, { expectStatus: 200 });
      if (state.dupAlumnoViejaId) await client.post('admin', `/admin/users/${state.dupAlumnoViejaId}/delete`, { expectStatus: 200 });
    },
  },
  // ── Alta masiva de materias en varios cursos (/superadmin/otros) ──────────
  // Lo que hay que probar no es que cree —eso es un insertMany— sino lo contrario: que
  // NO toque la materia que ya estaba. Por eso la segunda tanda va con otro docente y
  // otra aula a propósito, y se verifica contra Mongo que sigan siendo los originales.
  // Divisiones propias: los specs de matrícula cuentan las materias de state.divisionId.
  {
    id: 'alta-masiva-setup',
    title: 'El admin crea dos divisiones vacías para el alta masiva',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const a = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-AM1-${RUN_ID}` }, expectStatus: 201,
      });
      const b = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-AM2-${RUN_ID}` }, expectStatus: 201,
      });
      state.amDivisionA = a.json.division._id;
      state.amDivisionB = b.json.division._id;

      // Un segundo docente, solo para probar que la segunda tanda NO le pasa las materias
      // que ya existen. No queda a cargo de nada, así que su borrado no choca con el 409.
      const otro = await client.post('admin', '/admin/users/create', {
        body: {
          name: `Smoke AM Otro Docente ${RUN_ID}`, email: `am.otro.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'teacher', dni: dniSmoke(22),
        },
        expectStatus: 201,
      });
      state.amOtroDocenteId = otro.json.user._id;

      state.amMaterias = [
        { nombre: `AM Uno ${RUN_ID}`, docenteId: state.scopedTeacherId, aula: 'Aula original' },
        { nombre: `AM Dos ${RUN_ID}`, docenteId: state.scopedTeacherId, aula: '' },
      ];
    },
  },
  {
    id: 'alta-masiva-panel-renderiza',
    title: 'El panel Otros pinta la tarjeta-formulario con los cursos y docentes de la escuela',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.get('superadmin', '/superadmin/otros', { expectStatus: 200 });
      assert(res.text.includes('data-fix="alta-masiva-materias"'), 'debería aparecer la tarjeta del alta masiva');
      assert(res.text.includes('data-compositor'), 'la tarjeta debería pintarse como formulario, no como contador + botón');
      // El JSON de opciones va embebido en la página: si la división recién creada figura,
      // es que llegó la lista real de cursos y no una vacía.
      assert(res.text.includes(`SMOKE-AM1-${RUN_ID}`), 'las divisiones de la escuela deberían llegar como opciones');
      assert(res.text.includes('data-crear') && res.text.includes('data-previsualizar'),
        'deberían estar los botones de crear y de vista previa');
      // Con total = 0 una tarjeta común se pinta como "limpio" y esconde los botones: el
      // compositor tiene que quedar fuera de esa rama o el formulario no sirve para nada.
      // El class va ANTES del data-fix en el div de la tarjeta, así que se mira hacia atrás.
      const i = res.text.indexOf('data-fix="alta-masiva-materias"');
      const apertura = res.text.slice(Math.max(0, i - 120), i);
      assert(!apertura.includes('limpio'), `el compositor no debería pintarse como tarjeta "limpia" — abre con: ${apertura.trim()}`);
    },
  },
  {
    id: 'alta-masiva-previsualiza',
    title: 'La vista previa anuncia 2 materias × 2 cursos sin escribir nada',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const res = await client.post('superadmin', '/superadmin/otros/alta-masiva-materias/previsualizar', {
        body: { divisionIds: [state.amDivisionA, state.amDivisionB], materias: state.amMaterias },
        expectStatus: 200,
      });
      assert(res.json.totalCrear === 4, `debería anunciar 4 materias a crear, anunció ${res.json.totalCrear}`);
      assert(res.json.totalIntactas === 0, `no debería haber materias existentes todavía, dice ${res.json.totalIntactas}`);
      assert(res.json.cursos.length === 2, `debería detallar los 2 cursos, detalló ${res.json.cursos.length}`);
    },
  },
  {
    id: 'alta-masiva-rechaza-carga-incompleta',
    title: 'Sin cursos, sin materias, sin docente o con el nombre repetido devuelve 400',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const cursos = [state.amDivisionA];
      const casos = [
        ['sin cursos',      { divisionIds: [],     materias: state.amMaterias }],
        ['sin materias',    { divisionIds: cursos, materias: [] }],
        ['sin docente',     { divisionIds: cursos, materias: [{ nombre: 'X', docenteId: '', aula: '' }] }],
        // Mismo nombre con otra tilde y otra caja: si esto pasara, crearía la materia
        // duplicada dentro del mismo curso.
        ['nombre repetido', { divisionIds: cursos, materias: [
          { nombre: 'Educación Física', docenteId: state.scopedTeacherId, aula: '' },
          { nombre: 'educacion fisica', docenteId: state.scopedTeacherId, aula: '' },
        ] }],
      ];
      for (const [caso, body] of casos) {
        const res = await client.post('superadmin', '/superadmin/otros/alta-masiva-materias/aplicar', {
          body, expectStatus: 400,
        });
        assert(res.json?.error, `el caso "${caso}" debería devolver un mensaje de error`);
      }
    },
  },
  {
    id: 'alta-masiva-crea',
    title: 'Se crean las 4 materias, con su docente, su aula y su código propio',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      const res = await client.post('superadmin', '/superadmin/otros/alta-masiva-materias/aplicar', {
        body: { divisionIds: [state.amDivisionA, state.amDivisionB], materias: state.amMaterias },
        expectStatus: 200,
      });
      assert(res.json.afectados === 4, `debería crear 4 materias, creó ${res.json.afectados}`);

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const creadas = await mongo.db().collection('courses')
          .find({ division: { $in: [state.amDivisionA, state.amDivisionB].map(id => new ObjectId(id)) } })
          .toArray();
        assert(creadas.length === 4, `deberían quedar 4 materias en las dos divisiones, hay ${creadas.length}`);

        const conAula = creadas.filter(c => c.room === 'Aula original');
        assert(conAula.length === 2, `2 deberían tener el aula cargada, tienen ${conAula.length}`);
        assert(creadas.every(c => String(c.owner) === state.scopedTeacherId), 'todas deberían quedar a cargo del docente elegido');
        assert(new Set(creadas.map(c => c.code)).size === 4, 'cada materia debería tener su propio código de unión');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'alta-masiva-no-pisa-lo-que-ya-existe',
    title: 'Repetir la tanda con otro docente y otra aula no toca las materias que ya están',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      // El pedido original: "en caso de que encuentre dicha materia, la deje como está".
      // El nombre va escrito distinto (minúsculas) para que además pruebe la normalización.
      const res = await client.post('superadmin', '/superadmin/otros/alta-masiva-materias/aplicar', {
        body: {
          divisionIds: [state.amDivisionA, state.amDivisionB],
          materias: state.amMaterias.map(m => ({
            nombre: m.nombre.toLowerCase(), docenteId: state.amOtroDocenteId,
            aula: 'AULA QUE NO DEBE PISAR',
          })),
        },
        expectStatus: 200,
      });
      assert(res.json.afectados === 0, `no debería crear nada, creó ${res.json.afectados}`);

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const despues = await mongo.db().collection('courses')
          .find({ division: { $in: [state.amDivisionA, state.amDivisionB].map(id => new ObjectId(id)) } })
          .toArray();
        assert(despues.length === 4, `deberían seguir siendo 4 materias, hay ${despues.length}`);
        assert(!despues.some(c => c.room === 'AULA QUE NO DEBE PISAR'), 'el aula de las materias existentes no debía cambiar');
        assert(despues.every(c => String(c.owner) === state.scopedTeacherId), 'el docente de las materias existentes no debía cambiar');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'cleanup-alta-masiva',
    title: 'Limpieza: borra las materias del alta masiva y sus dos divisiones',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state }) {
      if (!state.amDivisionA) return;
      // Las materias van directo por Mongo: se crearon en masa y no hay un listado en JSON
      // del que sacar sus ids. La división no se puede borrar mientras tenga materias.
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        await mongo.db().collection('courses').deleteMany({
          division: { $in: [state.amDivisionA, state.amDivisionB].map(id => new ObjectId(id)) },
        });
      } finally {
        await mongo.close();
      }
      await client.post('admin', `/admin/divisions/${state.amDivisionA}/delete`, { expectStatus: 200 });
      await client.post('admin', `/admin/divisions/${state.amDivisionB}/delete`, { expectStatus: 200 });
      if (state.amOtroDocenteId) await client.post('admin', `/admin/users/${state.amOtroDocenteId}/delete`, { expectStatus: 200 });
    },
  },

  // ── Rol Jefe de Sección + panel /jefatura ─────────────────────────────────
  // Lo que se verifica acá es sobre todo el FAIL-CLOSED y la BARRERA: un jefe sin sección
  // no tiene que ver nada, y con sección no tiene que ver un milímetro fuera de ella. Es lo
  // único que separa a un jefe de las notas de los alumnos del resto de la escuela.
  //
  // Todo el escenario usa divisiones propias (IN y OUT) para no alterar los conteos de los
  // specs de matrícula, que cuentan las materias de state.divisionId.
  {
    id: 'jefatura-setup',
    title: 'Se arma el escenario: dos divisiones (una dentro de la sección y otra fuera) con su actividad',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const dentro = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-JEF-IN-${RUN_ID}` }, expectStatus: 201,
      });
      const fuera = await client.post('admin', '/admin/divisions/create', {
        body: { name: `SMOKE-JEF-OUT-${RUN_ID}` }, expectStatus: 201,
      });
      state.jefDivIn  = dentro.json.division._id;
      state.jefDivOut = fuera.json.division._id;

      const matIn = await client.post('admin', '/admin/courses/create', {
        body: { name: `Materia Jef IN ${RUN_ID}`, divisionId: state.jefDivIn, teacherId: state.scopedTeacherId },
        expectStatus: 201,
      });
      const matOut = await client.post('admin', '/admin/courses/create', {
        body: { name: `Materia Jef OUT ${RUN_ID}`, divisionId: state.jefDivOut, teacherId: state.scopedTeacherId },
        expectStatus: 201,
      });
      state.jefCourseIn  = matIn.json.course._id;
      state.jefCourseOut = matOut.json.course._id;

      const actIn = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.jefCourseIn, title: `Actividad DENTRO ${RUN_ID}`, type: 'tarea' },
        expectStatus: 201,
      });
      const actOut = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.jefCourseOut, title: `Actividad FUERA ${RUN_ID}`, type: 'tarea' },
        expectStatus: 201,
      });
      state.jefActIn  = actIn.json.activity._id;
      state.jefActOut = actOut.json.activity._id;
    },
  },
  {
    id: 'jefatura-alta-del-rol',
    title: 'El admin da de alta un Jefe de Sección y crea una sección todavía sin jefes',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const u = await client.post('admin', '/admin/users/create', {
        body: { name: jefe.name, email: jefe.email, password: jefe.password, role: 'jefe', dni: dniSmoke(23) },
        expectStatus: 201,
      });
      state.jefeId = u.json.user._id;
      assert(u.json.user.role === 'jefe', `debería quedar con rol jefe, quedó ${u.json.user.role}`);

      // La sección se crea con la división IN ENTERA y sin jefes: así el spec de abajo
      // prueba el fail-closed con una sección que sí tiene contenido.
      const s = await client.post('admin', '/admin/secciones/create', {
        body: { name: `Sección Smoke ${RUN_ID}`, divisionIds: [state.jefDivIn], courseIds: [], headIds: [] },
        expectStatus: 201,
      });
      state.seccionId = s.json.seccion._id;
    },
  },
  {
    id: 'jefatura-rechaza-jefe-que-no-tiene-el-rol',
    title: 'Poner como jefe a alguien que no tiene el rol devuelve 400',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Sin esto se podría guardar un alcance para una cuenta que nunca va a poder entrar
      // al panel, y la pantalla de secciones mostraría un jefe que no lo es.
      const res = await client.post('admin', `/admin/secciones/${state.seccionId}/edit`, {
        body: {
          name: `Sección Smoke ${RUN_ID}`, divisionIds: [state.jefDivIn], courseIds: [],
          headIds: [state.scopedTeacherId],
        },
        expectStatus: 400,
      });
      assert(res.json?.error, 'debería explicar por qué no se puede');
    },
  },
  {
    id: 'jefatura-login',
    title: 'El Jefe de Sección inicia sesión',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.post('jefe', '/login', {
        body: { email: jefe.email, password: jefe.password },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'jefatura-sin-seccion-no-ve-nada',
    title: 'Sin sección asignada no ve NINGUNA actividad (fail-closed)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El spec más importante del bloque: el rol se puede asignar por caminos que no
      // preguntan por secciones, así que el estado por defecto tiene que ser "no ve nada".
      const res = await client.get('jefe', '/jefatura', { expectStatus: 200 });
      assert(/Todavía no tenés secciones a cargo/.test(res.text),
        'debería mostrar la pantalla de sin alcance');
      assert(!res.text.includes(`Actividad DENTRO ${RUN_ID}`),
        'no debería listar ninguna actividad sin sección asignada');
      assert(!res.text.includes(`Actividad FUERA ${RUN_ID}`),
        'no debería listar ninguna actividad sin sección asignada');
    },
  },
  {
    id: 'jefatura-asignar-jefe',
    title: 'El admin le asigna la sección al jefe',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.post('admin', `/admin/secciones/${state.seccionId}/edit`, {
        body: {
          name: `Sección Smoke ${RUN_ID}`, divisionIds: [state.jefDivIn], courseIds: [],
          headIds: [state.jefeId],
        },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'jefatura-ve-solo-su-seccion',
    title: 'Ve las actividades de su sección y NO las de afuera',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      // El cambio de jefes no pasa por el cache de 45s del doc de usuario: se resuelve
      // leyendo Section en cada request, así que tiene efecto en este mismo request.
      const res = await client.get('jefe', '/jefatura', { expectStatus: 200 });
      assert(res.text.includes(`Actividad DENTRO ${RUN_ID}`),
        'debería listar la actividad de su sección');
      assert(!res.text.includes(`Actividad FUERA ${RUN_ID}`),
        'NO debería listar la actividad de una división fuera de su sección');
    },
  },
  {
    id: 'jefatura-materia-nueva-entra-sola',
    title: 'Una materia creada después aparece sin tocar la sección (resolución dinámica)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // La sección guarda la DIVISIÓN, no la lista de materias. Si guardara las materias,
      // esto no aparecería nunca y habría que reeditar la sección en cada alta.
      const mat = await client.post('admin', '/admin/courses/create', {
        body: { name: `Materia Jef NUEVA ${RUN_ID}`, divisionId: state.jefDivIn, teacherId: state.scopedTeacherId },
        expectStatus: 201,
      });
      state.jefCourseNueva = mat.json.course._id;

      const act = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.jefCourseNueva, title: `Actividad NUEVA ${RUN_ID}`, type: 'tarea' },
        expectStatus: 201,
      });
      state.jefActNueva = act.json.activity._id;

      const res = await client.get('jefe', '/jefatura', { expectStatus: 200 });
      assert(res.text.includes(`Actividad NUEVA ${RUN_ID}`),
        'la materia nueva de la división debería entrar al alcance sin editar la sección');
    },
  },
  {
    id: 'jefatura-drill-down',
    title: 'Abre las entregas de una actividad suya y la ficha del docente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const entregas = await client.get('jefe', `/jefatura/actividades/${state.jefActIn}`, { expectStatus: 200 });
      assert(entregas.text.includes('Alumnos de la materia'), 'debería mostrar la nómina de la materia');

      const listado = await client.get('jefe', '/jefatura/docentes', { expectStatus: 200 });
      // El docente del alcance es el "scoped teacher", que se dio de alta con teacher.name.
      assert(listado.text.includes(teacher.name), 'el docente de la sección debería figurar en el listado');

      const ficha = await client.get('jefe', `/jefatura/docentes/${state.scopedTeacherId}`, { expectStatus: 200 });
      assert(ficha.text.includes(`Actividad DENTRO ${RUN_ID}`), 'la ficha debería listar su actividad de la sección');
      assert(!ficha.text.includes(`Actividad FUERA ${RUN_ID}`),
        'la ficha NO debería mostrar lo que el docente hace fuera de la sección');
    },
  },
  {
    id: 'jefatura-fuera-de-alcance-403',
    title: 'Una actividad o un docente fuera de la sección devuelven 403',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Es la barrera real: la actividad de afuera no aparece en la grilla, pero nada impide
      // escribir su id en la URL — y del otro lado hay notas de alumnos.
      await client.get('jefe', `/jefatura/actividades/${state.jefActOut}`, { expectStatus: 403 });
      // Un usuario que no dicta nada en la sección tampoco se puede abrir como docente.
      await client.get('jefe', `/jefatura/docentes/${state.scopedStudentId}`, { expectStatus: 403 });
    },
  },

  // ── El jefe configura el contenido de sus secciones (/admin/secciones) ────────────────
  // La pantalla es la MISMA que usa el admin, servida por routes/sections.js, que se monta
  // aparte de /admin justamente para poder dejar entrar a este rol sin abrirle el panel.
  // Lo que se prueba acá es dónde está la línea: puede tocar el contenido de LAS SUYAS, y
  // nada más que eso.
  {
    id: 'jefatura-secciones-ve-solo-las-suyas',
    title: 'En /admin/secciones ve su sección y NO las del resto de la escuela',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const ajena = await client.post('admin', '/admin/secciones/create', {
        body: { name: `Sección Ajena ${RUN_ID}`, divisionIds: [state.jefDivOut], courseIds: [], headIds: [] },
        expectStatus: 201,
      });
      state.seccionAjenaId = ajena.json.seccion._id;

      const res = await client.get('jefe', '/admin/secciones', { expectStatus: 200 });
      assert(res.text.includes(`Sección Smoke ${RUN_ID}`), 'debería listar la sección que tiene a cargo');
      assert(!res.text.includes(`Sección Ajena ${RUN_ID}`),
        'NO debería listar una sección de la que no es jefe — el nombre y el contenido tampoco son suyos');
      assert(!res.text.includes('Nueva Sección'), 'no debería ofrecerle crear secciones');
    },
  },
  {
    id: 'jefatura-secciones-no-abre-una-ajena',
    title: 'El formulario de una sección ajena devuelve 403 aunque se escriba la URL',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Misma barrera que /jefatura/actividades/:id: que no aparezca en la grilla no impide
      // escribir el id a mano. Si esto pasara, el POST de abajo también, y el jefe se
      // quedaría con el alcance de otro.
      await client.get('jefe', `/admin/secciones/${state.seccionAjenaId}/edit`, { expectStatus: 403 });
      await client.post('jefe', `/admin/secciones/${state.seccionAjenaId}/edit`, {
        body: { name: `Sección Ajena ${RUN_ID}`, divisionIds: [], courseIds: [], headIds: [] },
        expectStatus: 403,
      });
    },
  },
  {
    id: 'jefatura-secciones-no-crea-ni-borra',
    title: 'No puede crear secciones nuevas ni borrar la suya',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Crear sería otorgarse un alcance desde cero; borrar dejaría sin alcance también a
      // los otros jefes que compartan la sección. Las dos siguen siendo del admin.
      await client.get('jefe', '/admin/secciones/create', { expectStatus: 403 });
      await client.post('jefe', '/admin/secciones/create', {
        body: { name: `Sección Propia ${RUN_ID}`, divisionIds: [state.jefDivOut], courseIds: [], headIds: [] },
        expectStatus: 403,
      });
      await client.post('jefe', `/admin/secciones/${state.seccionId}/delete`, { expectStatus: 403 });
    },
  },
  {
    id: 'jefatura-secciones-configura-la-suya',
    title: 'Agrega un curso a su sección y el alcance cambia en el request siguiente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El corazón de la feature: lo que el jefe elige acá es lo que ve en Actividades.
      // Antes de esto, la actividad de jefDivOut le daba 403 (spec de arriba).
      await client.get('jefe', `/admin/secciones/${state.seccionId}/edit`, { expectStatus: 200 });

      await client.post('jefe', `/admin/secciones/${state.seccionId}/edit`, {
        body: {
          name: `Sección Smoke ${RUN_ID}`,
          divisionIds: [state.jefDivIn, state.jefDivOut], courseIds: [], headIds: [],
        },
        expectStatus: 200,
      });

      const res = await client.get('jefe', '/jefatura', { expectStatus: 200 });
      assert(res.text.includes(`Actividad FUERA ${RUN_ID}`),
        'el curso que acaba de sumar debería entrar al alcance sin esperar a que expire ningún cache');

      // Y se deshace, para que los specs de abajo vean el escenario original.
      await client.post('jefe', `/admin/secciones/${state.seccionId}/edit`, {
        body: {
          name: `Sección Smoke ${RUN_ID}`,
          divisionIds: [state.jefDivIn], courseIds: [], headIds: [],
        },
        expectStatus: 200,
      });
      await client.get('jefe', `/jefatura/actividades/${state.jefActOut}`, { expectStatus: 403 });
    },
  },
  {
    id: 'jefatura-secciones-no-cambia-los-jefes',
    title: 'Guardar sin jefes en el body no lo deja fuera de su propia sección',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El formulario manda `headIds` siempre; para el jefe el servidor NO lo mira y conserva
      // los que ya estaban. Si lo mirara, este POST —que es el que sale de su propia
      // pantalla, donde la lista de jefes es de solo lectura— lo expulsaría de su sección.
      await client.post('jefe', `/admin/secciones/${state.seccionId}/edit`, {
        body: {
          name: `Sección Smoke ${RUN_ID}`, divisionIds: [state.jefDivIn], courseIds: [],
          headIds: [state.scopedTeacherId],   // ni siquiera tiene el rol jefe
        },
        expectStatus: 200,
      });

      const res = await client.get('jefe', '/admin/secciones', { expectStatus: 200 });
      assert(res.text.includes(`Sección Smoke ${RUN_ID}`),
        'debería seguir siendo jefe de su sección después de guardar');
      assert(res.text.includes(jefe.name), 'debería seguir figurando él como jefe');
      assert(!res.text.includes(teacher.name),
        'no debería haber podido meter a otro usuario como jefe de la sección');
    },
  },

  {
    id: 'jefatura-no-entra-a-otros-paneles',
    title: 'No entra a Administración, Directivo ni Preceptoría, y no puede crear materias',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      await client.get('jefe', '/admin/users',     { expectStatus: 403 });
      await client.get('jefe', '/admin/divisions', { expectStatus: 403 });
      await client.get('jefe', '/admin/courses',   { expectStatus: 403 });
      await client.get('jefe', '/admin/import',    { expectStatus: 403 });
      await client.get('jefe', '/admin/audit',     { expectStatus: 403 });
      await client.get('jefe', '/directivo',       { expectStatus: 403 });
      await client.get('jefe', '/preceptor',       { expectStatus: 403 });
      // /admin/secciones es la ÚNICA excepción, y da 200 a propósito: la sirve
      // routes/sections.js, montado aparte justamente para que el `requireAdmin` que cubre
      // todo routes/admin.js —y que las líneas de arriba comprueban— se quede intacto.
      await client.get('jefe', '/admin/secciones', { expectStatus: 200 });
      // Fuera de sus propias secciones sigue sin poder escribir nada por ninguna ruta.
      await client.post('jefe', '/courses/create', {
        body: { name: `No debería crearse ${RUN_ID}`, divisionId: state.jefDivIn },
        expectStatus: 403,
      });
    },
  },
  {
    // Misma historia que `preceptor-role-not-self-assignable`: desde el 2026-08-23 la
    // garantía no es "queda como alumno" sino "no se crea la cuenta".
    id: 'jefatura-rol-no-autoasignable',
    title: 'Nadie puede auto-registrarse como Jefe de Sección: no hay auto-registro (403)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const r = await client.post(null, '/register', {
        body: {
          name: 'Smoke Fake Jefe', email: `fake.jefe.${RUN_ID}@example.com`,
          password: 'SmokeTest1234', role: 'jefe', dni: dniSmoke(24),
          divisionId: state.selfEnrollDivisionId,
        },
        expectStatus: 403,
      });
      assert(r.json && r.json.registroCerrado === true,
        `debería cortar por registro cerrado; dijo ${JSON.stringify(r.json)}`);
    },
  },

  // Issue conocido nº 10 de agente.md. Un `:id` que no tiene forma de ObjectId hace lanzar
  // CastError a findById, y de ahí salen DOS síntomas según cómo esté escrito el handler:
  // con try/catch cae en el catch genérico y da 500; SIN try/catch —los GET de admin.js— el
  // rechazo no lo captura nadie (Express 4) y el request queda COLGADO para siempre, con un
  // unhandledRejection en el log y el navegador esperando. Por eso todos los pedidos de acá
  // llevan `timeoutMs`: sin él, la ruta colgada no falla el spec, cuelga el corredor.
  //
  // Las rutas de escritura se prueban igual que las de lectura: la guarda contesta ANTES de
  // tocar la base, así que ningún POST de esta lista puede modificar nada.
  {
    id: 'objectid-invalido-da-404',
    title: 'Un :id con forma inválida da 404 en todos los routers (y no cuelga)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert, state }) {
      // 'new' es el caso real que lo destapó: GET /admin/users/new no existe (la buena es
      // /users/create) y caía en /users/:id. Los otros dos cubren las formas vecinas —
      // 24 caracteres que no son hex, y un id de 23.
      const malos = ['new', 'no-es-un-id', 'zzzzzzzzzzzzzzzzzzzzzzzz', '6a7472072ab622c54757700'];

      const rutas = [
        // routes/directivo.js — las 4 que ya estaban documentadas.
        // Van con el actor 'admin' y no con 'directivo' a propósito: requireDirectivo acepta
        // directivo, admin y superadmin, y el directivo del smoke ya lo borró su propia
        // limpieza mucho antes de llegar acá (su cookie da 302 a /login, que es lo correcto).
        // Atarse a ese fixture haría que este spec dependiera de dónde está puesto.
        ['admin', 'GET',  id => `/directivo/courses/${id}`],
        ['admin', 'GET',  id => `/directivo/students/${id}`],
        ['admin', 'GET',  id => `/directivo/teachers/${id}`],
        ['admin', 'GET',  id => `/directivo/divisions/${id}`],

        // routes/admin.js
        ['admin', 'GET',  id => `/admin/users/${id}`],
        ['admin', 'POST', id => `/admin/users/${id}/divisions`],
        ['admin', 'POST', id => `/admin/users/${id}/courses`],
        ['admin', 'POST', id => `/admin/users/${id}/role`],
        ['admin', 'POST', id => `/admin/users/${id}/toggle-active`],
        ['admin', 'POST', id => `/admin/users/${id}/reset-password`],
        ['admin', 'POST', id => `/admin/users/${id}/delete`],
        ['admin', 'POST', id => `/admin/users/${id}/impersonate`],
        ['admin', 'GET',  id => `/admin/courses/${id}/edit`],
        ['admin', 'POST', id => `/admin/courses/${id}/edit`],
        ['admin', 'POST', id => `/admin/courses/${id}/assign-teacher`],
        ['admin', 'POST', id => `/admin/courses/${id}/co-teachers`],
        ['admin', 'POST', id => `/admin/courses/${id}/delete`],
        ['admin', 'GET',  id => `/admin/divisions/${id}/edit`],
        ['admin', 'POST', id => `/admin/divisions/${id}/edit`],
        ['admin', 'POST', id => `/admin/divisions/${id}/delete`],
        ['admin', 'GET',  id => `/admin/subjects/${id}`],
        ['admin', 'GET',  id => `/admin/subjects/${id}/edit`],
        ['admin', 'POST', id => `/admin/subjects/${id}/edit`],
        ['admin', 'POST', id => `/admin/subjects/${id}/delete`],

        // routes/superadmin.js
        ['superadmin', 'GET',    id => `/superadmin/schools/${id}`],
        ['superadmin', 'GET',    id => `/superadmin/schools/${id}/edit`],
        ['superadmin', 'POST',   id => `/superadmin/schools/${id}/edit`],
        ['superadmin', 'POST',   id => `/superadmin/schools/${id}/delete`],
        ['superadmin', 'POST',   id => `/superadmin/schools/${id}/invite`],
        ['superadmin', 'POST',   id => `/superadmin/schools/${id}/revoke-invite`],
        ['superadmin', 'POST',   id => `/superadmin/users/${id}/school`],
        ['superadmin', 'POST',   id => `/superadmin/users/${id}/role`],
        ['superadmin', 'POST',   id => `/superadmin/suggestions/${id}/reviewed`],
        ['superadmin', 'POST',   id => `/superadmin/suggestions/${id}/respond`],
        ['superadmin', 'DELETE', id => `/superadmin/suggestions/${id}`],

        // routes/sections.js — arregladas el 2026-08-14, van acá para que no se pierda la guarda
        ['admin', 'GET',  id => `/admin/secciones/${id}/edit`],
        ['admin', 'POST', id => `/admin/secciones/${id}/edit`],
        ['admin', 'POST', id => `/admin/secciones/${id}/delete`],

        // routes/activities.js — con el docente, que es quien las usa. `requireAuth` alcanza:
        // la guarda contesta antes de cualquier chequeo de permiso.
        ['scopedTeacher', 'GET',    id => `/activities/course/${id}`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/grades`],
        ['scopedTeacher', 'POST',   id => `/activities/${id}/grade`],
        ['scopedTeacher', 'DELETE', id => `/activities/${id}`],
        ['scopedTeacher', 'PATCH',  id => `/activities/${id}/toggle-late`],
        ['scopedTeacher', 'PATCH',  id => `/activities/${id}/toggle-visibility`],
        ['scopedTeacher', 'PUT',    id => `/activities/${id}`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/staged-file/prueba.pdf`],
        ['scopedTeacher', 'POST',   id => `/activities/${id}/upload-submission-file`],
        ['scopedTeacher', 'POST',   id => `/activities/${id}/submit`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/export-grades`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/my-submission`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/submissions`],
        ['scopedTeacher', 'POST',   id => `/activities/${id}/view`],
        ['scopedTeacher', 'GET',    id => `/activities/${id}/views`],

        // routes/courses.js
        ['scopedTeacher', 'GET',  id => `/courses/${id}`],
        ['scopedTeacher', 'POST', id => `/courses/${id}/add-student`],
        ['scopedTeacher', 'GET',  id => `/courses/${id}/gradebook`],
        ['scopedTeacher', 'GET',  id => `/courses/${id}/export-students`],
        ['scopedTeacher', 'GET',  id => `/courses/${id}/data`],
        ['scopedTeacher', 'POST', id => `/courses/${id}/customize`],

        // routes/announcements.js
        ['scopedTeacher', 'GET',  id => `/announcements/course/${id}`],
        ['scopedTeacher', 'POST', id => `/announcements/${id}/comment`],
        ['scopedTeacher', 'PUT',  id => `/announcements/${id}`],
        ['scopedTeacher', 'POST', id => `/announcements/${id}/delete`],

        // routes/tasks.js — si TASK_TEMPLATES_ENABLED='false' el router ni se monta y la URL
        // cae en el catch-all de /superadmin, que también da 404. El spec vale igual.
        // 'new' queda excluido acá y solo acá: `/superadmin/tasks/new` ES una ruta real (el
        // formulario de alta, routes/tasks.js:103) definida antes de `/:id`, así que
        // contesta 200 con todo derecho. Lo mismo vale para `/activities/new`.
        ['superadmin', 'GET',    id => `/superadmin/tasks/${id}`, ['new']],
        ['superadmin', 'GET',    id => `/superadmin/tasks/${id}/edit`],
        ['superadmin', 'GET',    id => `/superadmin/tasks/${id}/preview`],
        ['superadmin', 'POST',   id => `/superadmin/tasks/${id}/preview-grade`],
        ['superadmin', 'PUT',    id => `/superadmin/tasks/${id}`],
        ['superadmin', 'POST',   id => `/superadmin/tasks/${id}/publish`],
        ['superadmin', 'POST',   id => `/superadmin/tasks/${id}/archive`],
        ['superadmin', 'POST',   id => `/superadmin/tasks/${id}/offer`],
        ['superadmin', 'POST',   id => `/superadmin/tasks/${id}/revoke`],
        ['superadmin', 'DELETE', id => `/superadmin/tasks/${id}`],

        // routes/preceptor.js — con el admin por el mismo motivo que las de /directivo:
        // requirePreceptor acepta preceptor, directivo, admin y superadmin, y el preceptor
        // del smoke ya lo borró su propia limpieza antes de llegar acá.
        ['admin', 'GET',  id => `/preceptor/divisions/${id}`],
        ['admin', 'POST', id => `/preceptor/divisions/${id}/students`],
        ['admin', 'GET',  id => `/preceptor/students/${id}`],
        ['admin', 'POST', id => `/preceptor/students/${id}/edit`],
        ['admin', 'POST', id => `/preceptor/students/${id}/unenroll`],
        ['admin', 'POST', id => `/preceptor/students/${id}/move`],
        ['admin', 'POST', id => `/preceptor/students/${id}/toggle-active`],
        ['admin', 'GET',  id => `/preceptor/actividades/${id}/dia/2026-08-14`],

        // routes/messages.js y routes/messagesInbox.js — con MESSAGES_ENABLED='false' el
        // router contesta 404 igual, así que el spec no depende del flag.
        ['superadmin',    'GET',    id => `/superadmin/messages/${id}`],
        ['superadmin',    'POST',   id => `/superadmin/messages/${id}/reply`],
        ['superadmin',    'PATCH',  id => `/superadmin/messages/${id}/replies`],
        ['superadmin',    'DELETE', id => `/superadmin/messages/${id}`],
        ['scopedStudent', 'POST',   id => `/messages/mine/${id}/read`],
        ['scopedStudent', 'POST',   id => `/messages/mine/${id}/reply`],

        // routes/suggestions.js
        ['scopedStudent', 'POST', id => `/suggestions/mine/${id}/reply`],
        ['scopedStudent', 'POST', id => `/suggestions/mine/${id}/read`],

        // Las de abajo YA validaban antes de esta tanda (rooms por el router.use de
        // cargarSala, asistencia por cargarDivision/cargarToma, jefatura inline). Van igual:
        // el spec es la red que evita que se pierdan.
        ['scopedTeacher', 'GET', id => `/courses/${id}/sala`],
        ['scopedTeacher', 'GET', id => `/courses/${id}/sala/poll`],
        ['admin',         'GET', id => `/preceptor/asistencia/${id}`],
        ['admin',         'GET', id => `/preceptor/asistencia/toma/${id}/poll`],
        ['jefe',          'GET', id => `/jefatura/actividades/${id}`],
        ['jefe',          'GET', id => `/jefatura/docentes/${id}`],
        // El botón "Dar presente" del alumno. Vive en el SEGUNDO router de
        // routes/attendance.js (`alumnoRouter`, montado en /asistencia), que es justamente
        // el que se saltea cualquier auditoría que busque rutas por `^router.`.
        // Se prueba con UN solo id malo: detrás hay un limiter de 10 cada 5 minutos por
        // usuario y el alumno del smoke ya gastó parte de su cupo en los specs de asistencia.
        ['scopedStudent', 'POST', id => `/asistencia/${id}/presente`,
          ['new', 'zzzzzzzzzzzzzzzzzzzzzzzz', '6a7472072ab622c54757700']],
      ];

      // Rutas con DOS parámetros: tienen que dar 404 tanto si el malo es el primero como si
      // es el segundo. Validar solo el primero las dejaba rotas por el segundo.
      const bueno = '6a7472072ab622c547577001';
      const dosParams = [
        ['admin',         'POST',   `/admin/courses/${bueno}/co-teachers/no-es-un-id/delete`],
        ['admin',         'POST',   `/admin/courses/no-es-un-id/co-teachers/${bueno}/delete`],
        ['scopedTeacher', 'DELETE', `/courses/${bueno}/students/no-es-un-id`],
        ['scopedTeacher', 'DELETE', `/courses/no-es-un-id/students/${bueno}`],
        ['scopedTeacher', 'POST',   `/courses/${bueno}/students/no-es-un-id/toggle-active`],
        ['scopedTeacher', 'POST',   `/courses/no-es-un-id/students/${bueno}/toggle-active`],
        // La sala ya validaba :mid y :uid por su cuenta; quedan cubiertos para que no se
        // pierdan. Van con el curso REAL del smoke: con uno inexistente cortaría antes
        // `cargarSala` con su propio 404 y estas dos no probarían nada.
        ['scopedTeacher', 'DELETE', `/courses/${state.courseId}/sala/mensajes/no-es-un-id`],
        ['scopedTeacher', 'POST',   `/courses/${state.courseId}/sala/silenciar/no-es-un-id`],
      ];

      const fallas = [];
      // `excluidos` son los ids que en ESA ruta no son inválidos porque hay un segmento
      // literal con ese nombre definido antes del `/:id`.
      for (const [actor, metodo, armar, excluidos = []] of rutas) {
        for (const malo of malos) {
          if (excluidos.includes(malo)) continue;
          const ruta = armar(malo);
          try {
            // fetch rechaza un GET con body, así que el cuerpo vacío va solo donde corresponde.
            const res = await client.request(actor, metodo, ruta,
              { ...(metodo === 'GET' ? {} : { body: {} }), timeoutMs: 5000 });
            if (res.status !== 404) fallas.push(`${metodo} ${ruta} → ${res.status}`);
          } catch (err) {
            fallas.push(err.message);
          }
        }
      }
      for (const [actor, metodo, ruta] of dosParams) {
        try {
          const res = await client.request(actor, metodo, ruta, { body: {}, timeoutMs: 5000 });
          if (res.status !== 404) fallas.push(`${metodo} ${ruta} → ${res.status}`);
        } catch (err) {
          fallas.push(err.message);
        }
      }

      assert(fallas.length === 0,
        `${fallas.length} ruta(s) no dieron 404 con un id inválido:\n      ` + fallas.join('\n      '));
    },
  },
  {
    id: 'cleanup-jefatura',
    title: 'Limpieza: borra la sección, el jefe, las materias y las divisiones del escenario',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      for (const id of [state.seccionId, state.seccionAjenaId]) {
        if (id) await client.post('admin', `/admin/secciones/${id}/delete`, { expectStatus: 200 });
      }
      // Las materias van antes que las divisiones: una división con materias adentro no se
      // puede borrar. Y el docente titular tampoco, mientras siga a cargo de estas materias.
      for (const id of [state.jefCourseIn, state.jefCourseOut, state.jefCourseNueva]) {
        if (id) await client.post('admin', `/admin/courses/${id}/delete`, { expectStatus: 200 });
      }
      for (const id of [state.jefDivIn, state.jefDivOut]) {
        if (id) await client.post('admin', `/admin/divisions/${id}/delete`, { expectStatus: 200 });
      }
      if (state.jefeId) await client.post('admin', `/admin/users/${state.jefeId}/delete`, { expectStatus: 200 });
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
  // ── Sala en vivo (specs/sala-en-vivo.spec.md) ────────────────────────────
  // Corren con el curso del smoke todavía vivo: state.courseId, su docente
  // (scopedTeacher) y su alumno matriculado (scopedStudent).
  {
    id: 'sala-setup-sesiones',
    title: 'Setup: actores propios de la sala (dirección y preceptoría) con sesión válida',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Este bloque corre al FINAL del archivo, y para entonces los usuarios directivo y
      // preceptor del smoke ya fueron borrados por 'directivo-cleanup' y 'cleanup-preceptor'.
      // Con la cuenta borrada, checkUser no hidrata res.locals.user y todo responde 403 con
      // un JWT que sigue siendo válido. Por eso la sala crea los suyos, y los borra al final.
      const dir = await client.post('admin', '/admin/users/create', {
        body: { name: 'Smoke Sala Directivo', email: `smoke.sala.dir.${RUN_ID}@example.com`,
                password: 'SmokeTest1234', role: 'directivo', dni: dniSmoke(30) },
        expectStatus: 201,
      });
      state.salaDirectivoId = dir.json.user._id;
      await client.post('salaDirectivo', '/login', {
        body: { email: `smoke.sala.dir.${RUN_ID}@example.com`, password: 'SmokeTest1234' },
        expectStatus: 200,
      });

      const pre = await client.post('admin', '/admin/users/create', {
        body: { name: 'Smoke Sala Preceptor', email: `smoke.sala.pre.${RUN_ID}@example.com`,
                password: 'SmokeTest1234', role: 'preceptor', dni: dniSmoke(31) },
        expectStatus: 201,
      });
      state.salaPreceptorId = pre.json.user._id;
      // Con la división del curso de prueba a cargo: es lo que le da acceso a esa sala.
      await client.post('admin', `/admin/users/${state.salaPreceptorId}/divisions`, {
        body: { divisionIds: [state.divisionId], allDivisions: false },
        expectStatus: 200,
      });
      await client.post('salaPreceptor', '/login', {
        body: { email: `smoke.sala.pre.${RUN_ID}@example.com`, password: 'SmokeTest1234' },
        expectStatus: 200,
      });
      // El jar de cookies de `scopedStudent` viene VACÍO desde
      // 'cache-invalidation-on-disable': ese spec deshabilita al alumno, y checkUser
      // responde con clearCookie('token') — que el cliente de test guarda como cookie
      // vacía. Re-habilitarlo no le devuelve la sesión al cliente. Ningún spec volvía a
      // usar ese actor después, así que el jar roto nunca se notó hasta que la sala
      // empezó a usarlo: sin esto, todas las llamadas del alumno responden 302 a /login.
      //
      // Los otros dos se re-loguean por higiene: hace que este bloque no dependa del
      // estado de sesión que dejaron 200 specs anteriores.
      await client.post('scopedStudent', '/login', {
        body: { email: state.scopedStudentEmail, password: student.password },
        expectStatus: 200,
      });
      await client.post('scopedTeacher', '/login', {
        body: { email: state.scopedTeacherEmail, password: teacher.password },
        expectStatus: 200,
      });

      const ok = await client.get('scopedStudent', '/courses', { expectStatus: 200 });
      assert(ok.status === 200, 'el alumno debería tener sesión válida antes de entrar a la sala');
    },
  },
  {
    id: 'sala-abrir-cerrar',
    title: 'La docente abre la sala, reabrirla no duplica, el alumno no puede abrirla',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const abrir = await client.post('scopedTeacher', `/courses/${state.courseId}/sala/abrir`, { expectStatus: 200 });
      assert(abrir.json.creada === true, 'la primera apertura debería crear la sesión');
      state.salaSessionId = abrir.json.sessionId;

      // Idempotencia: dos docentes tocando "Abrir" a la vez es un caso real (RN-02).
      const otra = await client.post('scopedTeacher', `/courses/${state.courseId}/sala/abrir`, { expectStatus: 200 });
      assert(otra.json.creada === false, 'reabrir no debería crear una segunda sesión');
      assert(otra.json.sessionId === state.salaSessionId, 'debería devolver la MISMA sesión');

      // El alumno no abre salas.
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/abrir`, { expectStatus: 403 });
    },
  },
  {
    id: 'sala-presencia',
    title: 'El poll del alumno crea UNA sola presencia y lo muestra conectado',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      let res;
      for (let i = 0; i < 3; i++) {
        res = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll`, {
          expectStatus: 200, headers: { Accept: 'application/json' },
        });
      }
      assert(res.json.estado === 'abierta', 'la sala debería figurar abierta');
      assert(res.json.presencia.presentes === 1,
        `debería haber 1 alumno presente, hubo ${res.json.presencia.presentes}`);
      assert(res.json.presencia.total >= 1, 'el total debería contar la matrícula del curso');
      assert(res.json.presencia.conectados.some(c => c.rol === 'student'),
        'el alumno debería aparecer en la lista de conectados');

      // El docente polleando NO suma al conteo de alumnos presentes (RN-07).
      const conDocente = await client.get('scopedTeacher', `/courses/${state.courseId}/sala/poll`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(conDocente.json.presencia.presentes === 1,
        `la docente no debe sumar a "presentes"; quedó en ${conDocente.json.presencia.presentes}`);
      assert(conDocente.json.presencia.conectados[0].rol === 'teacher',
        'la docente debería aparecer primera en la fila de círculos');
    },
  },
  {
    // specs/actividades-en-clase.spec.md — CA-05, CA-06.
    id: 'sala-crear-actividad',
    title: 'La docente crea una actividad desde la clase y la sala lo avisa',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const titulo = `Consigna en clase ${RUN_ID}`;
      const res = await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: titulo, type: 'tarea', fromRoom: '1' },
        expectStatus: 201,
      });
      state.salaActivityId = res.json.activity._id;

      // El aviso viaja por el MISMO poll que el resto de la sala: si se hubiera guardado
      // fuera de la secuencia de `seq`, no llegaría acá.
      const poll = await client.get('scopedTeacher', `/courses/${state.courseId}/sala/poll?since=0`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      const aviso = (poll.json.mensajes || [])
        .find(m => m.kind === 'system' && String(m.texto || '').includes(titulo));
      assert(aviso, 'la sala debería tener el aviso de sistema con el título de la actividad');

      // El aviso lleva el link a la actividad (el botón "Ver actividad" del chat). El id va
      // como dato aparte del texto: si viajara adentro del mensaje habría que parsearlo.
      assert(aviso.actividad && aviso.actividad.id === state.salaActivityId,
        'el aviso debería traer el id de la actividad para el botón "Ver actividad"');
      assert(aviso.actividad.url === `/courses/${state.courseId}?actividad=${state.salaActivityId}`,
        `la URL del botón salió mal: ${aviso.actividad && aviso.actividad.url}`);

      // Los avisos que no son de una actividad (se abrió la sala) no llevan botón.
      const apertura = (poll.json.mensajes || [])
        .find(m => m.kind === 'system' && String(m.texto || '').includes('abrió la sala'));
      assert(apertura && apertura.actividad === null,
        'el aviso de apertura de sala no debería traer link a ninguna actividad');

      // Y lo que se creó es una actividad NORMAL: el alumno la ve en su solapa Actividades.
      const lista = await client.get('scopedStudent', `/activities/course/${state.courseId}`,
        { expectStatus: 200 });
      assert((lista.json.activities || []).some(a => a._id === state.salaActivityId),
        'la actividad creada desde la sala debería aparecer en la solapa Actividades');
    },
  },
  {
    // Vive acá y no con el resto de la asistencia porque necesita las dos cosas a la vez:
    // una sala en vivo con alguien adentro Y una toma abierta. Es el único punto del smoke
    // donde eso pasa.
    id: 'attendance-sugerencia-desde-la-sala',
    title: 'La sala en vivo SUGIERE quiénes están en clase, sin marcar a nadie',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      if (!state.divisionId || !state.scopedStudentId) return;

      const abrir = await client.post('salaPreceptor', `/preceptor/asistencia/${state.divisionId}/abrir`, {
        body: { mode: 'pase' },
        expectStatus: 200,
      });
      state.tomaSalaId = abrir.json.tomaId;

      // Se lo pone AUSENTE a propósito: es el caso que más sirve de la feature —el chico
      // figura ausente y está sentado en una clase en vivo en este mismo momento—, y el que
      // el preceptor no puede detectar de otra forma.
      await client.post('salaPreceptor', `/preceptor/asistencia/toma/${state.tomaSalaId}/marcar`, {
        body: { studentId: state.scopedStudentId, status: 'ausente' },
        expectStatus: 200,
      });

      const poll = await client.get('salaPreceptor', `/preceptor/asistencia/toma/${state.tomaSalaId}/poll`,
        { expectStatus: 200 });

      const sugerido = (poll.json.enClase || []).find(a => a.studentId === state.scopedStudentId);
      assert(sugerido, 'el alumno que figura ausente y está en la sala debería aparecer como sugerencia');
      assert(sugerido.materia, 'la sugerencia tiene que decir en qué materia está');

      // Lo importante: sugerir NO marca. Sigue figurando ausente hasta que el preceptor
      // decida otra cosa.
      const antes = poll.json.marcas.find(m => m.studentId === state.scopedStudentId);
      assert(antes.estado === 'ausente',
        `la sugerencia no puede cambiar el estado por su cuenta, quedó ${antes.estado}`);

      // Y cuando el preceptor la acepta, la marca queda a nombre de ÉL, no de la sala.
      await client.post('salaPreceptor', `/preceptor/asistencia/toma/${state.tomaSalaId}/marcar-lote`, {
        body: { studentIds: poll.json.enClase.map(a => a.studentId), status: 'presente' },
        expectStatus: 200,
      });
      const post = await client.get('salaPreceptor', `/preceptor/asistencia/toma/${state.tomaSalaId}/poll`,
        { expectStatus: 200 });
      const marca = post.json.marcas.find(m => m.studentId === state.scopedStudentId);
      assert(marca.estado === 'presente' && marca.origen === 'preceptor',
        `la decisión la tomó el preceptor: esperaba presente/preceptor, hay ${marca.estado}/${marca.origen}`);
      assert(!(post.json.enClase || []).some(a => a.studentId === state.scopedStudentId),
        'ya marcado, no se lo sigue sugiriendo');

      await client.post('salaPreceptor', `/preceptor/asistencia/toma/${state.tomaSalaId}/cerrar`,
        { expectStatus: 200 });
    },
  },
  {
    id: 'sala-mensajes-cursor',
    title: 'El cursor por seq no pierde mensajes ni reenvía los ya vistos',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const m1 = await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'presente 👋' }, expectStatus: 200,
      });
      const desde = m1.json.mensaje.seq;
      state.salaMensajeId = m1.json.mensaje.id;

      // Dos mensajes en paralelo: el $inc atómico tiene que darles seq distintos y
      // consecutivos, incluso si caen en el mismo milisegundo (RN-04). Es el test que
      // justifica no usar createdAt como cursor.
      const [a, b] = await Promise.all([
        client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, { body: { text: 'uno' }, expectStatus: 200 }),
        client.post('scopedTeacher', `/courses/${state.courseId}/sala/mensajes`, { body: { text: 'dos' }, expectStatus: 200 }),
      ]);
      // Los dos se guardan aparte para 'sala-borrado-propio': el de la docente es el "mensaje
      // ajeno" (desde que el alumno borra lo suyo, probar el rechazo con su PROPIO mensaje
      // dejó de probar nada) y el del alumno es el que él mismo va a borrar.
      //
      // Se REUSAN en vez de mandar mensajes nuevos: roomMessageLimiter deja 10 por minuto y
      // por usuario, y el bloque de la sala entero corre bien adentro de ese minuto. Un par de
      // mensajes de más y los specs empiezan a fallar con 429 por el test, no por el código.
      state.salaMensajeDocenteId = b.json.mensaje.id;
      state.salaMensajeAlumnoId  = a.json.mensaje.id;

      const seqs = [a.json.mensaje.seq, b.json.mensaje.seq].sort((x, y) => x - y);
      assert(seqs[0] !== seqs[1], `dos mensajes simultáneos recibieron el mismo seq (${seqs[0]})`);
      assert(seqs[1] - seqs[0] === 1, `los seq deberían ser consecutivos, fueron ${seqs.join(' y ')}`);

      const nuevos = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll?since=${desde}`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(nuevos.json.mensajes.length === 2,
        `since=${desde} debería devolver 2 mensajes, devolvió ${nuevos.json.mensajes.length}`);

      const alDia = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll?since=${seqs[1]}`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(alDia.json.mensajes.length === 0,
        'con el cursor al día no debería reenviar nada (si no, cada poll manda la conversación entera)');

      // La hora la manda el SERVIDOR ya formateada, no la fecha cruda. Si vuelve a viajar como
      // fecha, cada navegador la interpreta con la zona horaria de su máquina y el mismo
      // mensaje aparece a una hora distinta en cada pantalla del aula (era el bug real).
      const hora = nuevos.json.mensajes[0].hora;
      assert(/^\d{2}:\d{2}$/.test(hora),
        `la hora del mensaje debería venir formateada "HH:MM" desde el servidor, vino ${JSON.stringify(hora)}`);
      const enBsAs = (d) => new Intl.DateTimeFormat('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(d);
      // El minuto anterior también vale: el mensaje pudo escribirse justo antes de que el
      // reloj cambiara de minuto, y ese borde no es un bug.
      const ahora = new Date();
      const esperadas = [enBsAs(ahora), enBsAs(new Date(ahora.getTime() - 60000))];
      assert(esperadas.includes(hora),
        `la hora debería ser la de la escuela (${esperadas.join(' o ')}), vino ${hora}`);
    },
  },
  {
    id: 'sala-validaciones',
    title: 'Mensaje vacío 400, texto largo se corta, emoji inválido 400',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: '   ' }, expectStatus: 400,
      });
      const largo = await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'x'.repeat(800) }, expectStatus: 200,
      });
      assert(largo.json.mensaje.texto.length === 500,
        `el texto debería cortarse en 500, quedó en ${largo.json.mensaje.texto.length}`);

      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeId}/reaccion`, {
        body: { emoji: '💣' }, expectStatus: 400,
      });
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeId}/reaccion`, {
        body: { emoji: '👍' }, expectStatus: 200,
      });
      // Toggle: la segunda pulsada saca la reacción en vez de duplicarla.
      const off = await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeId}/reaccion`, {
        body: { emoji: '👍' }, expectStatus: 200,
      });
      assert((off.json.mensaje.reacciones || []).length === 0,
        'reaccionar dos veces con el mismo emoji debería quitar la reacción');
    },
  },
  {
    id: 'sala-xss',
    title: 'Un mensaje con <script> no se ejecuta en la sala',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const payload = '<script>alert(1)</script>';
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: payload }, expectStatus: 200,
      });
      const html = await client.get('scopedTeacher', `/courses/${state.courseId}/sala`, { expectStatus: 200 });
      assert(!html.text.includes(payload),
        'el HTML de la sala contiene el <script> del mensaje sin escapar');
      assert(html.text.includes('\\u003cscript') || html.text.includes('&lt;script'),
        'el payload debería aparecer escapado (en el JSON embebido o en el HTML)');
    },
  },
  {
    id: 'sala-moderacion',
    title: 'La docente borra y silencia; el alumno no puede moderar',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Borrar lo AJENO es solo del docente. (Lo propio lo borra su autor: ver
      // 'sala-borrado-propio'. Este spec probaba el rechazo con el mensaje del propio alumno,
      // que desde el 2026-08-19 sí puede borrar — ahí ya no probaba lo que dice el título.)
      await client.delete('scopedStudent', `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeDocenteId}`, { expectStatus: 403 });
      await client.delete('scopedTeacher', `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeId}`, { expectStatus: 200 });

      const tras = await client.get('scopedTeacher', `/courses/${state.courseId}/sala/poll?since=0`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      const borrado = tras.json.mensajes.find(m => m.id === state.salaMensajeId);
      assert(borrado && borrado.borrado === true, 'el mensaje debería figurar como eliminado');
      assert(borrado.texto === 'Mensaje eliminado', 'no debería viajar el texto original al cliente');

      // Silenciar: el alumno sigue leyendo y sigue presente, pero no escribe (RN-13).
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/silenciar/${state.scopedStudentId}`, {
        body: { muted: true }, expectStatus: 200,
      });
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'no debería entrar' }, expectStatus: 403,
      });
      const mudo = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(mudo.json.puedoEscribir === false, 'el silenciado no debería poder escribir');
      assert(mudo.json.presencia.presentes === 1, 'el silenciado sigue contando como presente');
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/silenciar/${state.scopedStudentId}`, {
        body: { muted: false }, expectStatus: 200,
      });

      // Modo "solo yo escribo": corta al alumno, no a la docente.
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/config`, {
        body: { studentsCanWrite: false }, expectStatus: 200,
      });
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'tampoco' }, expectStatus: 403,
      });
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'la docente sí puede' }, expectStatus: 200,
      });
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/config`, {
        body: { studentsCanWrite: true }, expectStatus: 200,
      });
    },
  },
  {
    id: 'sala-adjuntos',
    title: 'La docente comparte imagen y archivo; el alumno los ve; borrarlos los saca del disco',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const base = `/courses/${state.courseId}/sala`;
      const json = { Accept: 'application/json' };

      // PNG de 1×1 válido. Tiene que ser una imagen DE VERDAD: sharp la decodifica para
      // validarla, así que un buffer de bytes cualquiera con nombre .png se rechaza (que es
      // justamente lo que queremos que haga).
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');

      const formCon = (campo, buf, nombre, tipo) => {
        const fd = new FormData();
        fd.append(campo, new Blob([buf], { type: tipo }), nombre);
        return fd;
      };

      // ── La docente comparte una imagen ────────────────────────────────────
      const img = await client.post('scopedTeacher', `${base}/adjuntos/imagen`, {
        form: formCon('imagen', png, 'pizarrón clase 1.png', 'image/png'),
        expectStatus: 201, headers: json,
      });
      assert(img.json.mensaje.kind === 'image', 'debería quedar como mensaje de tipo imagen');
      assert(img.json.mensaje.adjunto && img.json.mensaje.adjunto.url,
        'el mensaje debería traer la URL del adjunto');
      state.salaImagenId = img.json.mensaje.id;
      const urlImagen = img.json.mensaje.adjunto.url;

      // La URL apunta a la ruta autenticada de la sala, NO a /archivos ni a nada estático.
      // Es la garantía de que el archivo no quedó público: si esto cambia, el borrado deja
      // de significar algo y el test tiene que fallar.
      assert(urlImagen.startsWith(`${base}/archivos/`),
        `el adjunto debería servirse por la ruta de la sala, fue "${urlImagen}"`);

      // ── El alumno lo ve en su poll y puede bajarlo ────────────────────────
      const poll = await client.get('scopedStudent', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const enPoll = poll.json.mensajes.find(m => m.id === state.salaImagenId);
      assert(enPoll && enPoll.adjunto, 'el alumno debería ver la imagen en su poll');
      assert(enPoll.adjunto.peso && !/NaN|undefined/.test(enPoll.adjunto.peso),
        `el peso debería estar formateado, fue "${enPoll.adjunto.peso}"`);
      assert(!('path' in enPoll.adjunto),
        'la ruta en disco NUNCA debe viajar al cliente');

      const bajada = await client.get('scopedStudent', urlImagen, { expectStatus: 200 });
      assert(bajada.byteLength > 0, 'el archivo debería llegar con contenido');
      assert((bajada.headers.get('content-disposition') || '').startsWith('inline'),
        'una imagen se muestra en línea, no se fuerza la descarga');
      assert(bajada.headers.get('x-content-type-options') === 'nosniff',
        'falta el nosniff en la respuesta del archivo');

      // ── Quién NO puede ───────────────────────────────────────────────────
      // El alumno del curso SÍ comparte imágenes desde el 2026-08-19 (ver 'sala-imagen-alumno'),
      // pero no archivos: comparte fotos, no documentos (RN-A1).
      await client.post('scopedStudent', `${base}/adjuntos/archivo`, {
        form: formCon('archivo', Buffer.from('mio'), 'mio.txt', 'text/plain'),
        expectStatus: 403, headers: json,
      });
      // Preceptoría y dirección no suben NADA: entran a mirar la clase, no a dejar material.
      await client.post('salaPreceptor', `${base}/adjuntos/imagen`, {
        form: formCon('imagen', png, 'suya.png', 'image/png'),
        expectStatus: 403, headers: json,
      });
      // Un alumno de OTRA división no llega ni al archivo, aunque tenga la URL exacta.
      // Es el test que sostiene la decisión de no publicarlos en /public.
      await client.get('student', urlImagen, { expectStatus: 403, headers: json });

      // ── Archivo (no imagen) ──────────────────────────────────────────────
      const txt = Buffer.from('Trabajo práctico 3\nEjercicios 1 a 5.\n', 'utf8');
      const arch = await client.post('scopedTeacher', `${base}/adjuntos/archivo`, {
        form: formCon('archivo', txt, 'guía tp3.txt', 'text/plain'),
        expectStatus: 201, headers: json,
      });
      assert(arch.json.mensaje.kind === 'file', 'debería quedar como mensaje de tipo archivo');
      assert(arch.json.mensaje.adjunto.ext === 'TXT',
        `la card debería mostrar la extensión, fue "${arch.json.mensaje.adjunto.ext}"`);
      // El acento sobrevive al viaje por multipart (busboy decodifica en latin1 por defecto).
      assert(arch.json.mensaje.adjunto.nombre === 'guía tp3.txt',
        `el nombre debería conservar los acentos, fue "${arch.json.mensaje.adjunto.nombre}"`);

      const bajArch = await client.get('scopedStudent', arch.json.mensaje.adjunto.url, { expectStatus: 200 });
      assert((bajArch.headers.get('content-disposition') || '').startsWith('attachment'),
        'un .txt se descarga, no se abre en el navegador');

      // Los planos de AutoCAD comparten la puerta con el resto del material de clase (pedido
      // del 2026-08-29, para las materias técnicas) y salen por donde salen los documentos:
      // como descarga. Que VER_EN_LINEA no los nombre es deliberado — ningún navegador dibuja
      // un plano. Van los DOS formatos: el .dxf es texto plano y el .dwg binario, y es
      // justamente el de texto el que no puede terminar sirviéndose en línea.
      for (const [ext, mime, contenido] of [
        ['dwg', 'image/vnd.dwg', Buffer.from('AC1032\x00\x00\x00', 'binary')],
        ['dxf', 'image/vnd.dxf', Buffer.from('  0\nSECTION\n  2\nHEADER\n  0\nEOF\n', 'utf8')],
      ]) {
        const plano = await client.post('scopedTeacher', `${base}/adjuntos/archivo`, {
          form: formCon('archivo', contenido, `plano corte.${ext}`, mime),
          expectStatus: 201, headers: json,
        });
        assert(plano.json.mensaje.adjunto.ext === ext.toUpperCase(),
          `la card debería mostrar la extensión del plano, fue "${plano.json.mensaje.adjunto.ext}"`);
        const bajPlano = await client.get('scopedStudent', plano.json.mensaje.adjunto.url, { expectStatus: 200 });
        assert((bajPlano.headers.get('content-disposition') || '').startsWith('attachment'),
          `un plano .${ext} se descarga: no hay visor de AutoCAD en el navegador`);
      }

      // Extensión fuera de la lista: se rechaza con un mensaje que dice qué sí se puede.
      const malo = await client.post('scopedTeacher', `${base}/adjuntos/archivo`, {
        form: formCon('archivo', Buffer.from('MZ'), 'virus.exe', 'application/octet-stream'),
        expectStatus: 400, headers: json,
      });
      assert(/no se puede compartir/i.test(malo.json.error || ''),
        'debería explicar por qué se rechazó el archivo');

      // Un archivo que NO es una imagen, con nombre de imagen: lo caza sharp al decodificar,
      // no la extensión.
      await client.post('scopedTeacher', `${base}/adjuntos/imagen`, {
        form: formCon('imagen', Buffer.from('esto no es una imagen'), 'trucha.png', 'image/png'),
        expectStatus: 400, headers: json,
      });

      // ── Borrar: el archivo desaparece de verdad ──────────────────────────
      await client.delete('scopedTeacher', `${base}/mensajes/${state.salaImagenId}`, {
        expectStatus: 200, headers: json,
      });

      const trasBorrar = await client.get('scopedStudent', urlImagen, { expectStatus: 404, headers: json });
      assert(/elimin/i.test(trasBorrar.json?.error || ''),
        'el 404 debería decir que el archivo fue eliminado');

      const poll2 = await client.get('scopedStudent', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const borrada = poll2.json.mensajes.find(m => m.id === state.salaImagenId);
      assert(borrada && borrada.borrado === true, 'debería figurar como eliminada');
      assert(borrada.adjunto === null, 'un adjunto borrado no puede seguir mandando su URL');
      assert(borrada.texto === 'Imagen eliminada',
        `el hueco debería decir qué era, fue "${borrada.texto}"`);
    },
  },
  {
    id: 'sala-borrado-propio',
    title: 'El alumno borra lo suyo con la sala abierta; lo ajeno no (RN-B1)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const base = `/courses/${state.courseId}/sala`;
      const json = { Accept: 'application/json' };

      const id = state.salaMensajeAlumnoId;

      // El permiso lo manda el SERVIDOR mensaje por mensaje: la vista ya no decide "soy la
      // docente", así que lo que se prueba acá es exactamente lo que va a pintar el botón.
      const antes = await client.get('scopedStudent', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const mio = antes.json.mensajes.find(m => m.id === id);
      assert(mio && mio.puedoBorrar === true, 'el alumno debería poder borrar lo suyo con la sala abierta');
      const ajenoEnPoll = antes.json.mensajes.find(m => m.id === state.salaMensajeDocenteId);
      assert(ajenoEnPoll && ajenoEnPoll.puedoBorrar === false,
        'el alumno no debería recibir permiso de borrado sobre un mensaje ajeno');

      await client.delete('scopedStudent', `${base}/mensajes/${id}`, { expectStatus: 200, headers: json });

      const poll = await client.get('scopedStudent', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const borrado = poll.json.mensajes.find(m => m.id === id);
      assert(borrado && borrado.borrado === true, 'debería figurar como eliminado para todos');
      assert(borrado.texto === 'Mensaje eliminado', 'el texto original no puede viajar al cliente');
      assert(borrado.puedoBorrar === false, 'lo ya borrado no se vuelve a borrar');

      // Lo ajeno sigue siendo intocable, y el motivo se lee (no es un "acceso denegado" a secas).
      const ajeno = await client.delete('scopedStudent', `${base}/mensajes/${state.salaMensajeDocenteId}`, {
        expectStatus: 403, headers: json,
      });
      assert(/tus propios mensajes/i.test(ajeno.json?.error || ''),
        `el 403 debería explicar la regla, dijo "${ajeno.json?.error}"`);
    },
  },
  {
    id: 'sala-imagen-alumno',
    title: 'El alumno comparte una foto; el interruptor de la docente y el silencio la cortan',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const base = `/courses/${state.courseId}/sala`;
      const json = { Accept: 'application/json' };
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
      const forma = (nombre) => {
        const fd = new FormData();
        fd.append('imagen', new Blob([png], { type: 'image/png' }), nombre);
        return fd;
      };

      // ── El caso que abrió la feature: el alumno muestra la carpeta ────────
      const subida = await client.post('scopedStudent', `${base}/adjuntos/imagen`, {
        form: forma('mi carpeta.png'), expectStatus: 201, headers: json,
      });
      assert(subida.json.mensaje.kind === 'image', 'debería quedar como mensaje de tipo imagen');
      const idFoto = subida.json.mensaje.id;

      // La docente la ve, y el alumno puede sacarla él mismo si se equivocó (RN-B1 + adjunto).
      const vistaDocente = await client.get('scopedTeacher', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const laFoto = vistaDocente.json.mensajes.find(m => m.id === idFoto);
      assert(laFoto && laFoto.adjunto && laFoto.adjunto.url, 'la docente debería ver la foto del alumno');
      const urlFoto = laFoto.adjunto.url;

      // ── El interruptor de la docente (RN-A3) ─────────────────────────────
      await client.post('scopedTeacher', `${base}/config`, {
        body: { studentsCanShareImages: false }, expectStatus: 200, headers: json,
      });
      const cortado = await client.post('scopedStudent', `${base}/adjuntos/imagen`, {
        form: forma('otra.png'), expectStatus: 403, headers: json,
      });
      assert(/desactiv/i.test(cortado.json?.error || ''),
        `el 403 debería decir que la docente las desactivó, dijo "${cortado.json?.error}"`);

      // El botón se apaga solo del lado del alumno, y NO del lado de la docente: el
      // interruptor es "fotos de los alumnos", no "fotos".
      const estadoAlumno = await client.get('scopedStudent', `${base}/poll`, { expectStatus: 200, headers: json });
      assert(estadoAlumno.json.puedoCompartirImagen === false,
        'el estado tiene que apagar el botón del alumno sin recargar (RN-A6)');
      // Apagar las fotos NO calla a la clase: es todo el punto de que sea un interruptor
      // aparte y no un modo de "solo yo escribo". Se mira en el estado y no mandando un
      // mensaje: el bloque de la sala entero entra en un minuto y roomMessageLimiter deja 10.
      assert(estadoAlumno.json.puedoEscribir === true,
        'sin fotos el alumno tiene que seguir pudiendo escribir');

      const estadoDocente = await client.get('scopedTeacher', `${base}/poll`, { expectStatus: 200, headers: json });
      assert(estadoDocente.json.puedoCompartirImagen === true,
        'la docente comparte igual: el interruptor no es para ella');

      await client.post('scopedTeacher', `${base}/config`, {
        body: { studentsCanShareImages: true }, expectStatus: 200, headers: json,
      });

      // ── Silenciar apaga también las fotos ────────────────────────────────
      // Es el pedido explícito del usuario: al que se le sacó la palabra no puede seguir
      // hablando por imagen.
      await client.post('scopedTeacher', `${base}/silenciar/${state.scopedStudentId}`, {
        body: { muted: true }, expectStatus: 200, headers: json,
      });
      await client.post('scopedStudent', `${base}/adjuntos/imagen`, {
        form: forma('igual.png'), expectStatus: 403, headers: json,
      });
      await client.post('scopedTeacher', `${base}/silenciar/${state.scopedStudentId}`, {
        body: { muted: false }, expectStatus: 200, headers: json,
      });

      // ── El alumno saca su propia foto y el archivo se va del disco ───────
      await client.delete('scopedStudent', `${base}/mensajes/${idFoto}`, { expectStatus: 200, headers: json });
      await client.get('scopedStudent', urlFoto, { expectStatus: 404, headers: json });
    },
  },
  {
    id: 'sala-responder',
    title: 'Responder cita al mensaje original; borrarlo apaga la cita (RN-C, RN-B4)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const base = `/courses/${state.courseId}/sala`;
      const json = { Accept: 'application/json' };

      const original = await client.post('scopedTeacher', `${base}/mensajes`, {
        body: { text: 'Resuelvan el ejercicio 4 y muéstrenmelo' }, expectStatus: 200, headers: json,
      });
      const idOriginal = original.json.mensaje.id;

      const respuesta = await client.post('scopedStudent', `${base}/mensajes`, {
        body: { text: 'ya lo tengo', replyTo: idOriginal }, expectStatus: 200, headers: json,
      });
      const cita = respuesta.json.mensaje.respuesta;
      assert(cita, 'la respuesta debería viajar con su cita');
      assert(cita.id === idOriginal, 'la cita tiene que apuntar al mensaje original');
      assert(/Resuelvan el ejercicio 4/.test(cita.extracto),
        `la cita debería traer el texto citado, trajo "${cita.extracto}"`);
      assert(cita.autor && cita.autor.length > 0, 'la cita tiene que decir a quién se le contesta');
      assert(cita.borrado === false);

      // RN-C7: una cita imposible no rompe el envío, solo se pierde la cita. Los manda la
      // DOCENTE y no el alumno solo por cupo: roomMessageLimiter deja 10 mensajes por minuto
      // y por usuario, y el alumno ya gastó los suyos en los specs anteriores de este bloque.
      const sinCita = await client.post('scopedTeacher', `${base}/mensajes`, {
        body: { text: 'sin cita', replyTo: '000000000000000000000000' }, expectStatus: 200, headers: json,
      });
      assert(sinCita.json.mensaje.respuesta === null,
        'un replyTo inexistente tiene que salir sin cita, no con un error en la cara');
      const basura = await client.post('scopedTeacher', `${base}/mensajes`, {
        body: { text: 'tampoco', replyTo: 'no-es-un-id' }, expectStatus: 200, headers: json,
      });
      assert(basura.json.mensaje.respuesta === null, 'un id inválido tampoco puede romper el envío');

      // ── RN-B4: borrar el original apaga la cita en las respuestas ────────
      // Sin esto, la docente borra un mensaje y su texto sigue leyéndose en cada respuesta que
      // lo citaba, porque el snapshot está copiado en otro documento.
      await client.delete('scopedTeacher', `${base}/mensajes/${idOriginal}`, { expectStatus: 200, headers: json });

      const poll = await client.get('scopedStudent', `${base}/poll?since=0`, {
        expectStatus: 200, headers: json,
      });
      const laRespuesta = poll.json.mensajes.find(m => m.id === respuesta.json.mensaje.id);
      assert(laRespuesta, 'la respuesta debería seguir en la conversación');
      assert(laRespuesta.respuesta.borrado === true, 'la cita tiene que quedar marcada como eliminada');
      assert(!/ejercicio 4/i.test(laRespuesta.respuesta.extracto),
        `el texto borrado NO puede sobrevivir dentro de la cita, quedó "${laRespuesta.respuesta.extracto}"`);
    },
  },
  {
    id: 'sala-acceso',
    title: 'Quién entra a la sala y quién no (alumno ajeno, dirección, preceptoría)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // El alumno del curso, sí.
      await client.get('scopedStudent', `/courses/${state.courseId}/sala`, { expectStatus: 200 });
      // El alumno autoregistrado en OTRA división, no — ni con el link.
      await client.get('student', `/courses/${state.courseId}/sala`, { expectStatus: 403 });
      // Dirección, sí. Con ?modo=observacion, que es como se entra desde la tarjeta del
      // panel: sin el parámetro entraría VISIBLE y le arruinaría el escenario a
      // 'sala-observacion', que verifica justamente que no aparezca.
      await client.get('salaDirectivo', `/courses/${state.courseId}/sala?modo=observacion`, { expectStatus: 200 });
      // Preceptoría con la división a cargo, sí.
      await client.get('salaPreceptor', `/courses/${state.courseId}/sala`, { expectStatus: 200 });

      // Ni dirección ni preceptoría gestionan la sala: canWatchLive no concede canManage.
      for (const actor of ['salaDirectivo', 'salaPreceptor']) {
        await client.post(actor, `/courses/${state.courseId}/sala/abrir`,  { expectStatus: 403 });
        await client.post(actor, `/courses/${state.courseId}/sala/cerrar`, { expectStatus: 403 });
        await client.post(actor, `/courses/${state.courseId}/sala/config`, { body: { reactionsOn: false }, expectStatus: 403 });
        await client.post(actor, `/courses/${state.courseId}/sala/silenciar/${state.scopedStudentId}`, { body: { muted: true }, expectStatus: 403 });
        await client.delete(actor,  `/courses/${state.courseId}/sala/mensajes/${state.salaMensajeId}`, { expectStatus: 403 });
      }

      // Id malformado → 404, no 500.
      await client.get('scopedTeacher', '/courses/no-es-un-objectid/sala', { expectStatus: 404 });
      await client.get('scopedTeacher', '/courses/000000000000000000000000/sala', { expectStatus: 404 });
    },
  },
  {
    id: 'sala-observacion',
    title: 'Dirección entra sin aparecer, no puede escribir, y queda en auditoría',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const antes = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });

      await client.get('salaDirectivo', `/courses/${state.courseId}/sala?modo=observacion`, { expectStatus: 200 });

      const despues = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(despues.json.presencia.conectados.length === antes.json.presencia.conectados.length,
        'el ingreso en observación NO debe cambiar la lista de conectados que ve el curso');
      assert(!despues.json.presencia.conectados.some(c => c.rol === 'directivo'),
        'dirección no debería aparecer en la sala al entrar en observación');

      // En observación no se escribe: si pudiera, se revelaría igual pero de la peor manera.
      await client.post('salaDirectivo', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'no debería poder' }, expectStatus: 403,
      });

      // Silencioso para la clase, visible para la institución.
      const audit = await client.get('admin', '/admin/audit?action=room.observe', { expectStatus: 200 });
      assert(audit.text.includes('observó una sala en vivo'),
        'el ingreso en observación tiene que quedar registrado en /admin/audit');
    },
  },
  {
    id: 'sala-observacion-presentarse',
    title: 'Al presentarse, dirección aparece en la sala y puede escribir',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('salaDirectivo', `/courses/${state.courseId}/sala/presentarme`, { expectStatus: 200 });

      const visto = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll?since=0`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(visto.json.presencia.conectados.some(c => c.rol === 'directivo'),
        'después de presentarse, dirección debería aparecer entre los conectados');
      assert(visto.json.mensajes.some(m => m.kind === 'system' && /ingres/i.test(m.texto)),
        'debería haberse anunciado su ingreso con un mensaje de sistema');

      await client.post('salaDirectivo', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'buenas, sigo la clase' }, expectStatus: 200,
      });
    },
  },
  {
    id: 'preceptor-envivo-ingreso-visible',
    title: 'El preceptor entra a la vista de todos y no puede esconderse',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Con ?modo=observacion escrito a mano: para el preceptor se ignora (RN-26). Es el
      // test que impide que el modo silencioso se filtre a otro rol por la URL.
      await client.get('salaPreceptor', `/courses/${state.courseId}/sala?modo=observacion`, { expectStatus: 200 });

      const visto = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll?since=0`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(visto.json.presencia.conectados.some(c => c.rol === 'preceptor'),
        'el preceptor tiene que aparecer en la sala aunque pida modo observación');
      const avisos = visto.json.mensajes.filter(m => m.kind === 'system' && /preceptor/i.test(m.texto));
      assert(avisos.length === 1, `su ingreso debería anunciarse una sola vez, hubo ${avisos.length} avisos`);

      // Vuelve a entrar: no se duplica el aviso (si no, cada F5 llenaría el chat).
      await client.get('salaPreceptor', `/courses/${state.courseId}/sala`, { expectStatus: 200 });
      const otra = await client.get('scopedStudent', `/courses/${state.courseId}/sala/poll?since=0`, {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(otra.json.mensajes.filter(m => m.kind === 'system' && /preceptor/i.test(m.texto)).length === 1,
        'recargar la sala no debería volver a anunciar al preceptor');

      // Y puede hablar sin tener que presentarse.
      await client.post('salaPreceptor', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: '¿está Pérez en el aula?' }, expectStatus: 200,
      });
    },
  },
  {
    id: 'envivo-tarjetas',
    title: 'Los paneles de dirección y preceptoría muestran la clase en curso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const dir = await client.get('salaDirectivo', '/directivo/en-vivo/poll', {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      const sala = dir.json.salas.find(s => s.courseId === state.courseId);
      assert(sala, 'la sala abierta del curso de prueba debería aparecer en el panel de dirección');
      assert(sala.materia.includes(RUN_ID), 'la tarjeta debería nombrar la materia');
      assert(typeof sala.presentes === 'number' && typeof sala.total === 'number',
        'la tarjeta debería traer presentes y total');
      assert(typeof sala.docenteEnLinea === 'boolean',
        'la tarjeta tiene que decir si hay docente a cargo conectado, no dejarlo a la suposición');
      assert(sala.desdeMin >= 0 && Number.isFinite(sala.desdeMin), 'los minutos no pueden ser NaN');

      // Se busca NaN/Infinity como VALOR RENDERIZADO (entre tags, después de ":" o de "="),
      // no como subcadena suelta: "NaN" aparece de casualidad dentro de nombres propios y
      // "undefined" es una palabra del propio JavaScript del partial. Un assert que mire el
      // HTML entero da falsos positivos y hace desconfiar de todo el spec.
      const html = await client.get('salaDirectivo', '/directivo/en-vivo', { expectStatus: 200 });
      const basura = html.text.match(/(?:>|:\s*|=\s*"?)(NaN|Infinity)\b/);
      assert(!basura,
        `el panel no debería mostrar ${basura ? basura[1] : ''} — contexto: ` +
        (basura ? JSON.stringify(html.text.slice(Math.max(0, basura.index - 80), basura.index + 40)) : ''));

      // El preceptor ve la misma sala (su división está en el alcance) y entra visible.
      const pre = await client.get('salaPreceptor', '/preceptor/en-vivo/poll', {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(pre.json.salas.some(s => s.courseId === state.courseId),
        'la sala debería aparecer también en el panel de preceptoría');

      const preHtml = await client.get('salaPreceptor', '/preceptor/en-vivo', { expectStatus: 200 });
      assert(preHtml.text.includes("INGRESO = 'visible'"),
        'las tarjetas de preceptoría tienen que llevar al ingreso VISIBLE');
      assert(html.text.includes("INGRESO = 'observacion'"),
        'las tarjetas de dirección tienen que llevar al ingreso en observación');
    },
  },
  {
    // El bug que arregla (2026-08-17): el autocierre se evaluaba SOLO al pedir la sala de una
    // materia, así que una clase que terminaba y a cuya sala nadie volvía a entrar se quedaba
    // "en vivo" para siempre. En el espejo de producción había 40 salas abiertas sin un ping
    // desde hacía días, todas listadas como clases en curso en el panel de dirección.
    //
    // Verificado en rojo neutralizando el barrido de getOpenSessions: la sala envejecida
    // seguía apareciendo en el panel y closedAt seguía en null.
    id: 'envivo-barrido-salas-viejas',
    title: 'El panel cierra las salas que quedaron abiertas sin nadie adentro',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, env, state, assert }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const sesiones = mongo.db().collection('roomsessions');
        const sid = new ObjectId(state.salaSessionId);

        // Se la envejece como una clase de verdad que terminó: abierta hace rato y último
        // ping un minuto más allá del límite, con nadie adentro. `openedAt` se mueve TAMBIÉN,
        // y no es un detalle decorativo: con la apertura en el futuro de la última actividad
        // el cierre se fecha en `openedAt` (horaDeCierre no permite duración negativa), que
        // es una sesión que no puede existir.
        const { openedAt: apertura } = await sesiones.findOne({ _id: sid });
        const fin   = new Date(Date.now() - (AUTO_CLOSE_MS + 60 * 1000));
        const abrio = new Date(fin.getTime() - 40 * 60 * 1000);
        await sesiones.updateOne({ _id: sid }, { $set: { openedAt: abrio, lastActivityAt: fin } });

        try {
          const panel = await client.get('salaDirectivo', '/directivo/en-vivo/poll', {
            expectStatus: 200, headers: { Accept: 'application/json' },
          });
          assert(!panel.json.salas.some(s => s.courseId === state.courseId),
            'una sala sin actividad más allá del límite no puede seguir listada como clase en vivo');

          const doc = await sesiones.findOne({ _id: sid });
          assert(doc.closedAt, 'el panel tendría que haberla cerrado, no solo esconderla');
          assert(doc.autoClosed === true, 'tiene que quedar marcada como cierre automático');
          // La hora que se guarda es la de la última señal de vida, no la del barrido: si no,
          // el pie "Cerradas hoy" se llena de clases de la semana pasada.
          assert(Math.abs(new Date(doc.closedAt) - fin) < 1000,
            `el cierre debería fecharse en la última actividad (${fin.toISOString()}), ` +
            `quedó en ${new Date(doc.closedAt).toISOString()}`);
        } finally {
          // El escenario vuelve como estaba PASE LO QUE PASE: los specs de abajo siguen con
          // ESTA sesión abierta y con su transcripción intacta. En el `finally` porque un
          // assert que falla acá no puede además llevarse puestos a los que vienen después
          // —así fue como un fallo se convirtió en dos—.
          await sesiones.updateOne({ _id: sid }, {
            $set: { openedAt: apertura, closedAt: null, closedBy: null, autoClosed: false,
                    lastActivityAt: new Date() },
          });
          await mongo.db().collection('roommessages')
            .deleteMany({ session: sid, kind: 'system', text: /cerró automáticamente/ });
        }

        // La docente vuelve a la sala y pollea: la tarjeta tiene que reflejarlo.
        await client.get('scopedTeacher', `/courses/${state.courseId}/sala/poll`, {
          expectStatus: 200, headers: { Accept: 'application/json' },
        });

        const otraVez = await client.get('salaDirectivo', '/directivo/en-vivo/poll', {
          expectStatus: 200, headers: { Accept: 'application/json' },
        });
        const sala = otraVez.json.salas.find(s => s.courseId === state.courseId);
        assert(sala,
          'una sala con actividad reciente NO debe cerrarse: el barrido cierra las vacías, no todas');
        assert(sala.docenteEnLinea === true,
          'con la docente adentro, la tarjeta no puede mostrar el chip "sin docente"');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'envivo-forbidden',
    title: 'El docente y el alumno no entran a los paneles de clases en vivo',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      await client.get('scopedTeacher', '/directivo/en-vivo', { expectStatus: 403 });
      await client.get('scopedTeacher', '/preceptor/en-vivo', { expectStatus: 403 });
      await client.get('scopedStudent', '/directivo/en-vivo', { expectStatus: 403 });
      // El preceptor tampoco entra al panel de dirección: su pantalla es /preceptor/en-vivo.
      await client.get('salaPreceptor', '/directivo/en-vivo', { expectStatus: 403 });
    },
  },
  {
    id: 'preceptor-envivo-alcance',
    title: 'Sin divisiones asignadas, el preceptor no ve ninguna sala ni entra por URL',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es el test que separa a un preceptor de las salas del resto de la escuela: si el
      // filtro por alcance se rompe, se rompe acá y no en producción.
      const antes = await client.get('salaPreceptor', '/preceptor/en-vivo/poll', {
        expectStatus: 200, headers: { Accept: 'application/json' },
      });
      assert(antes.json.salas.length >= 1, 'con su división a cargo debería ver al menos una sala');

      try {
        await client.post('admin', `/admin/users/${state.salaPreceptorId}/divisions`, {
          body: { divisionIds: [], allDivisions: false }, expectStatus: 200,
        });

        const sin = await client.get('salaPreceptor', '/preceptor/en-vivo/poll', {
          expectStatus: 200, headers: { Accept: 'application/json' },
        });
        assert(sin.json.salas.length === 0,
          `sin alcance no debería ver ninguna sala, vio ${sin.json.salas.length}`);

        // Y filtrar la pantalla no alcanza: la URL directa también tiene que rebotar.
        await client.get('salaPreceptor', `/courses/${state.courseId}/sala`, { expectStatus: 403 });
      } finally {
        await client.post('admin', `/admin/users/${state.salaPreceptorId}/divisions`, {
          body: { divisionIds: [state.divisionId], allDivisions: false }, expectStatus: 200,
        });
      }
    },
  },
  {
    id: 'envivo-section-can-be-denied',
    title: 'El superadmin puede apagar las solapas configurables de cada panel',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state }) {
      // preceptor_envivo es la PRIMERA solapa configurable del panel de preceptoría (la otra,
      // el dashboard, va locked por ser el destino del redirect de "/"). Este spec verifica
      // que apagarla devuelve 403 en la ruta y no solo la esconde del menú.
      // 'directivo_actividades' viaja en esta misma lista y no en un spec aparte porque el
      // actor salaDirectivo recién existe a esta altura del run: los specs del panel directivo
      // que corren antes (~3100) usan el actor 'directivo', que no está en rolesSchoolId.
      const casos = [
        { rol: 'directivo', key: 'directivo_envivo', actor: 'salaDirectivo', url: '/directivo/en-vivo' },
        { rol: 'preceptor', key: 'preceptor_envivo', actor: 'salaPreceptor', url: '/preceptor/en-vivo' },
        { rol: 'directivo', key: 'directivo_actividades', actor: 'salaDirectivo', url: '/directivo/actividades-diarias' },
      ];
      for (const c of casos) {
        const toggle = (enabled) => client.post('superadmin', '/superadmin/roles/toggle', {
          body: { schoolId: state.rolesSchoolId, role: c.rol, key: c.key, enabled },
          expectStatus: 200,
        });
        // try/finally, igual que roles-toggle-hides-and-blocks: si un assert falla a mitad,
        // la solapa tiene que volver a habilitarse o los specs de abajo heredan el bloqueo.
        try {
          await toggle(false);
          await client.get(c.actor, c.url, { expectStatus: 403 });
        } finally {
          await toggle(true);
        }
      }
      // Y quedan repuestas: si el finally falló, los specs de abajo arrancarían bloqueados.
      for (const c of casos) await client.get(c.actor, c.url, { expectStatus: 200 });
    },
  },
  {
    id: 'sala-historial-y-export',
    title: 'Al cerrar, la clase queda archivada con su transcripción y su asistencia',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('scopedTeacher', `/courses/${state.courseId}/sala/cerrar`, { expectStatus: 200 });

      // Con la sala cerrada ya nadie escribe.
      await client.post('scopedStudent', `/courses/${state.courseId}/sala/mensajes`, {
        body: { text: 'tarde' }, expectStatus: 409,
      });

      const lista = await client.get('scopedTeacher', `/courses/${state.courseId}/sala/clases`, { expectStatus: 200 });
      assert(lista.text.includes('presentes'), 'el listado de clases debería mostrar los presentes');

      const detalle = await client.get('scopedTeacher', `/courses/${state.courseId}/sala/clases/${state.salaSessionId}`, { expectStatus: 200 });
      assert(detalle.text.includes('Asistencia'), 'el detalle debería mostrar la asistencia');
      // Un mensaje que NO fue borrado: 'presente 👋' es justo el que borra 'sala-moderacion',
      // así que ahí la transcripción muestra "Mensaje eliminado" y no serviría como prueba
      // de que el texto se conserva.
      assert(detalle.text.includes('la docente sí puede'),
        'el detalle debería mostrar el texto de los mensajes no borrados');
      assert(detalle.text.includes('Mensaje eliminado'), 'los borrados deberían figurar como tales');

      const csv = await client.get('scopedTeacher',
        `/courses/${state.courseId}/sala/clases/${state.salaSessionId}/export?tipo=asistencia`, { expectStatus: 200 });
      assert((csv.text || '').includes('Alumno;DNI;Estado'),
        'el CSV de asistencia debería traer su encabezado');

      const csvT = await client.get('scopedTeacher',
        `/courses/${state.courseId}/sala/clases/${state.salaSessionId}/export?tipo=transcripcion`, { expectStatus: 200 });
      assert((csvT.text || '').includes('Mensaje'), 'el CSV de transcripción debería traer su encabezado');

      // Una clase de otra materia no se lee cambiando el id en la URL.
      await client.get('scopedTeacher', `/courses/${state.courseId}/sala/clases/000000000000000000000000`, { expectStatus: 404 });
      await client.get('scopedTeacher', `/courses/${state.courseId}/sala/clases/no-es-un-id`, { expectStatus: 404 });

      // El aviso de la actividad quedó en la transcripción, como cualquier otro mensaje de
      // sistema (CA-09).
      assert(detalle.text.includes('creó la actividad'),
        'la transcripción debería conservar el aviso de la actividad creada en clase');
    },
  },
  {
    // specs/actividades-en-clase.spec.md — CA-07. Va DESPUÉS del cierre a propósito: es el
    // único momento del smoke en que la materia tiene la sala cerrada.
    id: 'sala-crear-actividad-sin-sala',
    title: 'Con la sala cerrada, crear "desde la clase" no rompe: crea la actividad y no avisa',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const titulo = `Consigna sin sala ${RUN_ID}`;
      await client.post('scopedTeacher', '/activities/create', {
        body: { courseId: state.courseId, title: titulo, type: 'tarea', fromRoom: '1' },
        expectStatus: 201,
      });

      // La clase ya archivada no puede haber recibido un aviso nuevo.
      const detalle = await client.get('scopedTeacher',
        `/courses/${state.courseId}/sala/clases/${state.salaSessionId}`, { expectStatus: 200 });
      assert(!detalle.text.includes(titulo),
        'no debería escribirse ningún aviso en una sala que ya está cerrada');
    },
  },
  {
    id: 'sala-purga',
    title: 'La purga borra los mensajes viejos y conserva sesión y asistencia',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state, assert }) {
      if (!state.salaSessionId) return;
      const { MongoClient, ObjectId } = require('mongodb');
      const { execFileSync } = require('child_process');
      const path = require('path');

      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const db  = mongo.db();
        const sid = new ObjectId(state.salaSessionId);

        const msgsAntes = await db.collection('roommessages').countDocuments({ session: sid });
        const presAntes = await db.collection('roompresences').countDocuments({ session: sid });
        assert(msgsAntes > 0 && presAntes > 0, 'la sesión de prueba debería tener mensajes y presencia');

        // Se la envejece: cerrada hace 4 meses (el corte son 3).
        const viejo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
        await db.collection('roomsessions').updateOne({ _id: sid }, { $set: { closedAt: viejo } });

        // --dry-run no borra nada.
        const raiz = path.join(__dirname, '..', '..');
        execFileSync('node', ['cleanup-rooms.js', '--dry-run'], { cwd: raiz, stdio: 'pipe' });
        assert(await db.collection('roommessages').countDocuments({ session: sid }) === msgsAntes,
          '--dry-run no debería borrar ningún mensaje');

        execFileSync('node', ['cleanup-rooms.js', '--si'], { cwd: raiz, stdio: 'pipe' });

        assert(await db.collection('roommessages').countDocuments({ session: sid }) === 0,
          'la purga debería haber borrado los mensajes de la clase vieja');
        assert(await db.collection('roomsessions').countDocuments({ _id: sid }) === 1,
          'la purga NO debe borrar la sesión');
        assert(await db.collection('roompresences').countDocuments({ session: sid }) === presAntes,
          'la purga NO debe tocar la asistencia: es el registro que se conserva');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'cleanup-salas-db',
    title: 'Limpieza: borra las salas de prueba',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state }) {
      if (!state.courseId) return;
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const cid = new ObjectId(state.courseId);
        await mongo.db().collection('roommessages').deleteMany({ course: cid });
        await mongo.db().collection('roompresences').deleteMany({ course: cid });
        await mongo.db().collection('roomsessions').deleteMany({ course: cid });
      } finally {
        await mongo.close();
      }
    },
  },
  {
    // La asistencia NO se borra en cascada al borrar la división (y está bien que no: es un
    // registro que se conserva). Pero la que crea el smoke es basura, y sin esto cada corrida
    // deja una toma huérfana con sus 20 marcas apuntando a un curso que ya no existe.
    id: 'cleanup-asistencia-db',
    title: 'Limpieza: borra las tomas de asistencia de prueba',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state }) {
      const divisiones = [state.divisionId, state.thirdDivisionId].filter(Boolean);
      if (!divisiones.length) return;
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const ids = { $in: divisiones.map(d => new ObjectId(d)) };
        await mongo.db().collection('attendancemarks').deleteMany({ division: ids });
        await mongo.db().collection('attendancesessions').deleteMany({ division: ids });
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'cleanup-sala-usuarios',
    title: 'Limpieza: el admin borra el directivo y el preceptor propios de la sala',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      if (state.salaDirectivoId) await client.post('admin', `/admin/users/${state.salaDirectivoId}/delete`, { expectStatus: 200 });
      if (state.salaPreceptorId) await client.post('admin', `/admin/users/${state.salaPreceptorId}/delete`, { expectStatus: 200 });
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
  // ── SOE — Servicio de Orientación Escolar ─────────────────────────────────
  // Cubren los criterios 14 a 23 de specs/soe-orientacion.spec.md. Lo que se prueba acá y
  // no en los unitarios son las RUTAS: quién recibe 200 y quién 403, y —lo más importante—
  // que el nivel 'resumen' no filtre texto clínico en el HTML que llega al navegador.
  {
    id: 'soe-crear-usuarios',
    title: 'SOE: el admin da de alta un usuario de orientación y un directivo de prueba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      const soeEmail = `smoke.soe.${RUN_ID}@test.local`;
      const dirEmail = `smoke.soedir.${RUN_ID}@test.local`;

      const soe = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke SOE ${RUN_ID}`, email: soeEmail, password: 'SmokeTest1234', role: 'soe', dni: dniSmoke(91) },
        expectStatus: 201,
      });
      state.soeId    = soe.json.user._id;
      state.soeEmail = soeEmail;

      // Un directivo propio: el de los specs de más arriba ya fue borrado en su limpieza.
      const dir = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke SOEDir ${RUN_ID}`, email: dirEmail, password: 'SmokeTest1234', role: 'directivo', dni: dniSmoke(92) },
        expectStatus: 201,
      });
      state.soeDirId    = dir.json.user._id;
      state.soeDirEmail = dirEmail;

      await client.post('soe',    '/login', { body: { email: soeEmail, password: 'SmokeTest1234' }, expectStatus: 200 });
      await client.post('soeDir', '/login', { body: { email: dirEmail, password: 'SmokeTest1234' }, expectStatus: 200 });
    },
  },
  {
    id: 'soe-panel-abre-y-redirige',
    title: 'SOE: el rol entra a /soe y "/" lo lleva ahí (criterio 14)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, assert }) {
      const panel = await client.get('soe', '/soe', { expectStatus: 200 });
      assert(/Orientaci[oó]n Escolar/i.test(panel.text || ''), 'el panel debería titularse Orientación Escolar');

      await client.get('soe', '/soe/alumnos', { expectStatus: 200 });
      await client.get('soe', '/soe/derivaciones', { expectStatus: 200 });
    },
  },
  {
    id: 'soe-otros-roles-403',
    title: 'SOE: alumno, docente, admin y directivo NO entran con la escuela en su default (criterios 14, 15 y 27)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client }) {
      // El default de School.soeAccess es 'none' para todos. Que el directivo esté listado
      // en config/sections.js no le abre nada: la puerta la abre la escuela, no el catálogo.
      //
      // El `admin` está en la lista desde el recorte del 2026-08-27 (decisión D5 de
      // specs/soe-derivacion-y-linea-de-tiempo.spec.md): antes podía llegar a 'completo'
      // configurándolo por escuela, y ahora NO puede desde ninguna pantalla. Acá se prueba
      // con la escuela en su default; que tampoco entre con el valor viejo escrito a mano en
      // Mongo lo cubre tests/unit/soeAcceso.test.js, que puede fabricar ese estado.
      for (const actor of ['scopedStudent', 'scopedTeacher', 'soeDir', 'admin']) {
        await client.get(actor, '/soe',              { expectStatus: 403 });
        await client.get(actor, '/soe/alumnos',      { expectStatus: 403 });
        await client.get(actor, '/soe/derivaciones', { expectStatus: 403 });
        await client.get(actor, '/soe/pedidos',      { expectStatus: 403 });
      }
    },
  },
  {
    id: 'soe-abrir-legajo',
    title: 'SOE: abre un legajo, y abrirlo dos veces no duplica (criterio 19)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.soeMotivo = `MOTIVO-CLINICO-${RUN_ID}`;

      await client.post('soe', `/soe/legajo/${state.scopedStudentId}/abrir`, {
        body: { motivo: state.soeMotivo, prioridad: 'alta' }, expectStatus: 302,
      });
      // Segunda vez: tiene que redirigir al que ya existe, no crear otro ni tirar 500.
      await client.post('soe', `/soe/legajo/${state.scopedStudentId}/abrir`, {
        body: { motivo: 'otro motivo distinto', prioridad: 'baja' }, expectStatus: 302,
      });

      const ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes(state.soeMotivo), 'el SOE debería ver el motivo que cargó');
      assert(!ficha.text.includes('otro motivo distinto'), 'el segundo intento no debería haber pisado el legajo');

      const resumen = await client.get('soe', '/soe', { expectStatus: 200 });
      const veces = (resumen.text.match(new RegExp(`/soe/legajo/${state.scopedStudentId}`, 'g')) || []).length;
      assert(veces === 1, `el alumno debería aparecer UNA vez en el resumen, aparece ${veces}`);
    },
  },
  {
    id: 'soe-alumno-fuera-de-alcance',
    title: 'SOE: no se puede abrir el legajo de quien no es alumno (criterio 18)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // El panel es de alumnos. Dejar abrir el "legajo" de un docente sería una forma
      // silenciosa de fichar al personal.
      await client.get('soe', `/soe/legajo/${state.scopedTeacherId}`, { expectStatus: 403 });
      await client.post('soe', `/soe/legajo/${state.scopedTeacherId}/abrir`, {
        body: { motivo: 'no debería entrar' }, expectStatus: 403,
      });
    },
  },
  {
    id: 'soe-seguimiento-y-derivacion',
    title: 'SOE: registra seguimiento, deriva y anota la devolución del servicio',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const ficha0 = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      state.soeCaseId = (ficha0.text.match(/\/soe\/legajo\/([a-f0-9]{24})\/situacion/) || [])[1];
      assert(state.soeCaseId, 'no se pudo leer el id del legajo desde la ficha');

      state.soeEntrada = `ENTREVISTA-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/entrada`, {
        body: { fecha: '2026-08-10', tipo: 'entrevista', animo: 'preocupante', texto: state.soeEntrada },
        expectStatus: 302,
      });

      state.soeDestino = `HOSPITAL-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/derivacion`, {
        body: { destino: state.soeDestino, tipo: 'salud_mental', motivo: 'Evaluación', fecha: '2026-08-12' },
        expectStatus: 302,
      });

      const conDeriv = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(conDeriv.text.includes(state.soeEntrada), 'la entrada del seguimiento debería verse');
      assert(conDeriv.text.includes(state.soeDestino), 'la derivación debería verse');
      // La fecha del hecho no puede correrse un día: es la trampa de zona horaria del
      // proyecto (un <input type="date"> llega como medianoche UTC y producción corre en UTC).
      assert(/10\/08|10 de ago/i.test(conDeriv.text), 'la entrada del 10/08 se está mostrando con otra fecha');

      state.soeRefId = (conDeriv.text.match(/\/derivacion\/([a-f0-9]{24})\/devolucion/) || [])[1];
      assert(state.soeRefId, 'no se pudo leer el id de la derivación');

      state.soeDevolucion = `DEVOLUCION-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/derivacion/${state.soeRefId}/devolucion`, {
        body: { fecha: '2026-08-15', texto: state.soeDevolucion }, expectStatus: 302,
      });

      const lista = await client.get('soe', '/soe/derivaciones', { expectStatus: 200 });
      assert(lista.text.includes(state.soeDestino), 'la derivación debería aparecer en /soe/derivaciones');
    },
  },
  {
    id: 'soe-repaso-del-legajo',
    title: 'SOE: la fecha de repaso vencida sube el legajo al resumen (criterios 32 a 38)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Una fecha ya pasada: el legajo tiene que aparecer en el panel de arriba de /soe.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/situacion`, {
        body: {
          motivo: state.soeMotivo, fortalezas: state.soeFortaleza || '',
          dificultades: state.soeDificultad || '', estrategias: state.soeEstrategia || '',
          prioridad: 'alta', estado: 'seguimiento', proximoRepaso: '2026-01-15',
        },
        expectStatus: 302,
      });

      let ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(/Había que verlo el/.test(ficha.text),
        'con la fecha vencida, la ficha debería avisar que había que verlo');
      // La fecha del hecho no puede correrse un día: es la trampa de zona horaria del
      // proyecto (un <input type="date"> llega como medianoche UTC y producción corre en UTC).
      assert(/15\/01|15 de ene/i.test(ficha.text), 'la fecha de repaso se está mostrando corrida');

      const resumen = await client.get('soe', '/soe', { expectStatus: 200 });
      assert(resumen.text.includes('Para volver a ver'),
        'el resumen debería listar los legajos con el repaso vencido');

      // Criterio 35: anotar una entrada SIN fecha no puede borrar el repaso que ya estaba.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/entrada`, {
        body: { fecha: '2026-08-20', tipo: 'nota', texto: `SIN-TOCAR-REPASO-${RUN_ID}`, proximoRepaso: '' },
        expectStatus: 302,
      });
      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(/Había que verlo el/.test(ficha.text),
        'anotar una entrada con el campo vacío borró la fecha de repaso');

      // Pero con fecha, sí la pisa.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/entrada`, {
        body: { fecha: '2026-08-20', tipo: 'nota', texto: `MUEVE-REPASO-${RUN_ID}`, proximoRepaso: '2099-03-04' },
        expectStatus: 302,
      });
      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      // Se mide por la FECHA y no por el rótulo: "Volver a verlo el" también es el label de
      // los dos formularios, así que buscarlo daría verde siempre. "Había que verlo el", en
      // cambio, existe solo en el chip de vencido.
      assert(/04\/03\/2099|4 de mar/i.test(ficha.text),
        'la entrada con fecha debería mover el repaso al futuro');
      assert(!/Había que verlo el/.test(ficha.text),
        'con la fecha en el futuro el chip no debería decir que ya venció');

      // Y el formulario de Situación sí la borra con el campo vacío.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/situacion`, {
        body: {
          motivo: state.soeMotivo, prioridad: 'alta', estado: 'seguimiento', proximoRepaso: '',
        },
        expectStatus: 302,
      });
      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(!/04\/03\/2099|4 de mar/i.test(ficha.text) && !/Había que verlo el/.test(ficha.text),
        'el formulario de Situación con el campo vacío tiene que borrar la fecha');
      const sinFecha = ficha.text.match(/id="s-repaso"[^>]*value="([^"]*)"/);
      assert(sinFecha && sinFecha[1] === '',
        'el input de Situación debería quedar vacío después de borrar la fecha');
    },
  },
  {
    id: 'soe-resumen-no-filtra-lo-clinico',
    title: 'SOE: el directivo en nivel "resumen" no recibe lo clínico en el HTML (criterios 15, 16 y 25)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD'],
    async run({ client, state, env, assert }) {
      await client.post('superadmin', '/login', {
        body: { email: env.SMOKE_SUPERADMIN_EMAIL, password: env.SMOKE_SUPERADMIN_PASSWORD },
        expectStatus: 200,
      });

      // Las fortalezas y las estrategias SÍ las ve el nivel resumen: son lo que sirve en el aula.
      state.soeFortaleza  = `FORTALEZA-${RUN_ID}`;
      state.soeDificultad = `DIFICULTAD-${RUN_ID}`;
      state.soeEstrategia = `ESTRATEGIA-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/situacion`, {
        body: {
          motivo: state.soeMotivo, fortalezas: state.soeFortaleza,
          dificultades: state.soeDificultad, estrategias: state.soeEstrategia,
          prioridad: 'alta', estado: 'seguimiento', proximoRepaso: '2026-09-15',
        },
        expectStatus: 302,
      });

      // La escuela del admin, que ya resolvió el spec 'roles-screen-loads'.
      const escuela = state.rolesSchoolId;
      assert(escuela, 'falta state.rolesSchoolId (lo deja el spec roles-screen-loads)');
      try {
        await client.post('superadmin', '/superadmin/roles/soe-access', {
          body: { schoolId: escuela, role: 'directivo', nivel: 'resumen' },
          expectStatus: 200,
        });

        const ficha = await client.get('soeDir', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });

        // Lo que SÍ tiene que ver.
        assert(ficha.text.includes(state.soeFortaleza),  'el resumen debería incluir las fortalezas');
        assert(ficha.text.includes(state.soeEstrategia), 'el resumen debería incluir las estrategias de aula');

        // La agenda del gabinete tampoco es del resumen (criterio 34): la fecha de repaso no
        // sobrevive al sanitizado, así que no puede estar ni como texto ni en un value=.
        assert(!/15\/09\/2026|Volver a verlo el|Había que verlo el/.test(ficha.text),
          'el nivel resumen recibió la fecha de repaso del legajo');

        // Lo que NO puede aparecer NUNCA en el HTML, ni escondido en un atributo.
        for (const secreto of [state.soeMotivo, state.soeDificultad, state.soeEntrada, state.soeDestino, state.soeDevolucion]) {
          assert(!ficha.text.includes(secreto), `el nivel resumen filtró texto clínico: ${secreto}`);
        }

        // Y no se le dibuja ningún formulario de escritura (criterio 25).
        assert(!/action="\/soe\/legajo\/[a-f0-9]{24}\/entrada"/.test(ficha.text),
          'el nivel resumen no debería dibujar el formulario de seguimiento');

        // La solapa Derivaciones nombra el destino de cada derivación, que es justo lo que
        // 'resumen' no puede saber. No la cierra config/sections.js (sectionGuard es
        // fail-open: solo deniega lo explícitamente denegado) sino requireCompleto.
        await client.get('soeDir', '/soe/derivaciones', { expectStatus: 403 });
        const home = await client.get('soeDir', '/soe', { expectStatus: 200 });
        assert(!home.text.includes(state.soeDestino),
          'el resumen del panel filtró el destino de la derivación');

        // Escribir, ni con el formulario a mano: solo el rol soe (criterio 17).
        await client.post('soeDir', `/soe/legajo/${state.soeCaseId}/entrada`, {
          body: { texto: 'no debería poder', tipo: 'nota' }, expectStatus: 403,
        });
        await client.post('superadmin', `/soe/legajo/${state.soeCaseId}/entrada`, {
          body: { texto: 'el superadmin tampoco', tipo: 'nota' }, expectStatus: 403,
        });
      } finally {
        // Se restaura SIEMPRE: este spec toca la configuración de una escuela real.
        await client.post('superadmin', '/superadmin/roles/soe-access', {
          body: { schoolId: escuela, role: 'directivo', nivel: 'none' },
        });
      }
    },
  },
  {
    id: 'soe-cerrar-y-reabrir',
    title: 'SOE: cerrar exige motivo y reabrir conserva la historia (criterio 20)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Sin motivo no cierra: un legajo cerrado sin decir por qué no le sirve a nadie.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/cerrar`, { body: { cierreMotivo: '' }, expectStatus: 302 });
      let ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(!ficha.text.includes('Reabrir legajo'), 'no debería haberse cerrado sin motivo');

      await client.post('soe', `/soe/legajo/${state.soeCaseId}/cerrar`, {
        body: { cierreMotivo: `CIERRE-${RUN_ID}` }, expectStatus: 302,
      });
      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes('Reabrir legajo'), 'el legajo debería figurar cerrado');
      assert(ficha.text.includes(state.soeEntrada), 'cerrar no puede borrar el seguimiento');

      await client.post('soe', `/soe/legajo/${state.soeCaseId}/reabrir`, { expectStatus: 302 });
      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes(state.soeEntrada), 'reabrir debe devolver la historia entera');
      assert(ficha.text.includes(state.soeDestino), 'reabrir debe devolver las derivaciones');
    },
  },
  // ── Derivación de Preceptoría al gabinete ─────────────────────────────────
  // Cubren los criterios 15 a 26 de specs/soe-derivacion-y-linea-de-tiempo.spec.md.
  //
  // Preceptor y alumno PROPIOS: los del bloque de preceptoría (state.preceptorId,
  // state.preceptorStudentId) ya los borró `cleanup-preceptor`, que corre mucho antes.
  {
    id: 'soe-deriv-crear-actores',
    title: 'Derivación: un preceptor con división a cargo y dos alumnos suyos',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // ⚠️ Materia PROPIA, y no la de la suite: `cleanup-course` corre unos specs más arriba
      // y deja `state.divisionId` sin ninguna. Sin materia no hay matrícula, y sin matrícula
      // el alumno queda FUERA del alcance del preceptor (routes/preceptor.js resuelve el
      // alcance contra Course.students — no existe User.division). El síntoma es un 403 al
      // derivar que parece un bug de permisos y es un problema de datos del test.
      const mat = await client.post('admin', '/admin/courses/create', {
        body: {
          name: `Materia Deriv ${RUN_ID}`, divisionId: state.divisionId,
          teacherId: state.scopedTeacherId, room: '303',
        },
        expectStatus: 201,
      });
      state.soeDerivCourseId = mat.json.course._id;

      const email = `smoke.soeprec.${RUN_ID}@test.local`;
      const res = await client.post('admin', '/admin/users/create', {
        body: {
          name: `Smoke Preceptor SOE ${RUN_ID}`, email, password: 'SmokeTest1234',
          role: 'preceptor', dni: dniSmoke(93),
          allDivisions: false, divisionIds: [state.divisionId],
        },
        expectStatus: 201,
      });
      state.soePrecId = res.json.user._id;
      await client.post('soePrec', '/login', { body: { email, password: 'SmokeTest1234' }, expectStatus: 200 });

      // Los alumnos se crean por la ruta del PROPIO preceptor: así quedan matriculados en
      // las materias de su división y, por lo tanto, dentro de su alcance sin trucos.
      for (const [clave, n] of [['soeDerivAlumnoId', 1], ['soeDerivAlumno2Id', 2]]) {
        const alu = await client.post('soePrec', `/preceptor/divisions/${state.divisionId}/students`, {
          body: {
            name: `Smoke Alumno Deriv ${n} ${RUN_ID}`,
            email: `smoke.soederiv${n}.${RUN_ID}@test.local`,
            password: 'SmokeTest1234', dni: dniSmoke(93 + n),
          },
          expectStatus: 201,
        });
        state[clave] = alu.json.user._id;
      }
    },
  },
  {
    id: 'soe-deriv-preceptor-deriva',
    title: 'Derivación: el preceptor deriva, y un segundo pedido no se duplica (criterios 15 y 17)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert, env }) {
      state.soeDerivMotivo = `DERIV-MOTIVO-${RUN_ID}`;

      await client.post('soePrec', `/preceptor/students/${state.soeDerivAlumnoId}/derivar-soe`, {
        body: { motivo: state.soeDerivMotivo, urgencia: 'alta' }, expectStatus: 302,
      });

      // Segunda vez con uno pendiente: no crea otro. Es la guarda de los dos preceptores de
      // turnos distintos derivando al mismo chico la misma semana.
      await client.post('soePrec', `/preceptor/students/${state.soeDerivAlumnoId}/derivar-soe`, {
        body: { motivo: 'SEGUNDO-PEDIDO-QUE-NO-VA', urgencia: 'baja' }, expectStatus: 302,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const pedidos = await mongo.db().collection('soerequests')
          .find({ student: new ObjectId(state.soeDerivAlumnoId) }).toArray();
        assert(pedidos.length === 1, `debería haber UN pedido, hay ${pedidos.length}`);
        assert(pedidos[0].motivo === state.soeDerivMotivo, 'el segundo intento no puede pisar el motivo del primero');
        assert(pedidos[0].urgencia === 'alta', 'ni la urgencia');
        assert(pedidos[0].estado === 'pendiente', 'el pedido nace pendiente');
        state.soePedidoId = pedidos[0]._id.toString();
      } finally {
        await mongo.close();
      }

      // Y la ficha del alumno le muestra en qué quedó.
      const ficha = await client.get('soePrec', `/preceptor/students/${state.soeDerivAlumnoId}`, { expectStatus: 200 });
      assert(ficha.text.includes(state.soeDerivMotivo), 'el preceptor debería ver el motivo que mandó');
      assert(ficha.text.includes('Esperando al gabinete'), 'debería ver que el pedido está pendiente');
    },
  },
  {
    id: 'soe-deriv-fuera-de-alcance',
    title: 'Derivación: no se puede derivar a un alumno de otra división (criterio 16)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert, env }) {
      // scopedStudent está en la escuela pero NO en la división de este preceptor. Sin la
      // guarda de alcance, conocer su _id alcanzaría para meterle una observación en su legajo.
      await client.post('soePrec', `/preceptor/students/${state.scopedStudentId}/derivar-soe`, {
        body: { motivo: `NO-DEBERIA-EXISTIR-${RUN_ID}`, urgencia: 'alta' }, expectStatus: 403,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const n = await mongo.db().collection('soerequests')
          .countDocuments({ student: new ObjectId(state.scopedStudentId) });
        assert(n === 0, 'el 403 no puede haber dejado el pedido creado igual');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'soe-deriv-preceptor-no-ve-el-legajo',
    title: 'Derivación: derivar NO le abre el legajo al preceptor (criterio 25)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El punto entero del recorte: el preceptor avisa, y ahí se termina lo que ve.
      await client.get('soePrec', `/soe/legajo/${state.soeDerivAlumnoId}`, { expectStatus: 403 });
      await client.get('soePrec', '/soe/pedidos', { expectStatus: 403 });

      // Su propia solapa sí, y ahí no puede haber nada del legajo.
      const mias = await client.get('soePrec', '/preceptor/soe', { expectStatus: 200 });
      assert(mias.text.includes(state.soeDerivMotivo), 'debería ver su propio pedido');
      assert(!mias.text.includes(state.soeMotivo),
        'no puede filtrarse el motivo de intervención de NINGÚN legajo');
    },
  },
  {
    id: 'soe-deriv-gabinete-toma',
    title: 'Derivación: el gabinete la toma, se abre el legajo y queda el hito firmado por el preceptor (criterios 19, 20 y 21)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert, env }) {
      const bandeja = await client.get('soe', '/soe/pedidos', { expectStatus: 200 });
      assert(bandeja.text.includes(state.soeDerivMotivo), 'el pedido debería estar en la bandeja del gabinete');

      state.soeDerivRespuesta = `RESPUESTA-AL-PRECEPTOR-${RUN_ID}`;
      await client.post('soe', `/soe/pedidos/${state.soePedidoId}/tomar`, {
        body: { respuesta: state.soeDerivRespuesta }, expectStatus: 302,
      });
      // Tomarlo de nuevo no puede empujar un segundo hito (dos pestañas abiertas, o el
      // celular reenviando el POST al recuperar la señal).
      await client.post('soe', `/soe/pedidos/${state.soePedidoId}/tomar`, {
        body: { respuesta: 'no debería aplicarse' }, expectStatus: 302,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const pedido = await mongo.db().collection('soerequests')
          .findOne({ _id: new ObjectId(state.soePedidoId) });
        assert(pedido.estado === 'tomada', `el pedido debería quedar tomada, quedó ${pedido.estado}`);
        assert(pedido.respuesta === state.soeDerivRespuesta, 'la respuesta del primer POST es la que vale');
        assert(pedido.soeCase, 'el pedido tiene que apuntar al legajo que abrió');

        const legajo = await mongo.db().collection('soecases')
          .findOne({ student: new ObjectId(state.soeDerivAlumnoId) });
        assert(legajo, 'tomar el pedido tiene que haber abierto el legajo');
        assert(String(legajo._id) === String(pedido.soeCase), 'y el pedido tiene que apuntar a ESE legajo');

        const hitos = (legajo.entries || []).filter(e => e.tipo === 'derivacion');
        assert(hitos.length === 1, `debería haber UN hito de derivación, hay ${hitos.length}`);
        assert(hitos[0].texto === state.soeDerivMotivo, 'el hito lleva el texto tal cual lo escribió el preceptor');
        // ⚠️ El corazón de la decisión D3: la firma es del PRECEPTOR, no del gabinete que lo
        // tomó. Es lo que deja la entrada inmutable — la ruta de edición solo permite la
        // propia entrada, y el preceptor no entra a este panel.
        assert(String(hitos[0].autor) === String(state.soePrecId),
          'el hito tiene que quedar firmado por el preceptor que derivó, no por el SOE');
      } finally {
        await mongo.close();
      }

      // Y el preceptor ve en qué quedó, más la respuesta. Nada más.
      const mias = await client.get('soePrec', '/preceptor/soe', { expectStatus: 200 });
      assert(mias.text.includes('Tomada por el gabinete'), 'el preceptor debería ver que se lo tomaron');
      assert(mias.text.includes(state.soeDerivRespuesta), 'y la respuesta que le dejaron');
      await client.get('soePrec', `/soe/legajo/${state.soeDerivAlumnoId}`, { expectStatus: 403 });
    },
  },
  {
    id: 'soe-deriv-descartar',
    title: 'Derivación: descartar exige motivo y no abre ningún legajo (criterios 18, 22, 23 y 24)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert, env }) {
      const { MongoClient, ObjectId } = require('mongodb');

      // Con el primero ya resuelto, el mismo alumno se puede volver a derivar: el índice
      // único es PARCIAL, solo choca entre pendientes (criterio 18).
      await client.post('soePrec', `/preceptor/students/${state.soeDerivAlumnoId}/derivar-soe`, {
        body: { motivo: `SEGUNDA-VUELTA-${RUN_ID}`, urgencia: 'media' }, expectStatus: 302,
      });

      // El que se va a descartar es el del segundo alumno, que no tiene legajo.
      const motivo2 = `DERIV-DESCARTE-${RUN_ID}`;
      await client.post('soePrec', `/preceptor/students/${state.soeDerivAlumno2Id}/derivar-soe`, {
        body: { motivo: motivo2, urgencia: 'baja' }, expectStatus: 302,
      });

      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const reqs = mongo.db().collection('soerequests');

        const segunda = await reqs.countDocuments({ student: new ObjectId(state.soeDerivAlumnoId) });
        assert(segunda === 2, `resuelto el primero, el segundo pedido sí se crea (hay ${segunda})`);

        const p2 = await reqs.findOne({ student: new ObjectId(state.soeDerivAlumno2Id) });
        assert(p2, 'debería existir el pedido del segundo alumno');

        // Sin respuesta no se descarta: un pedido descartado en silencio le enseña al
        // preceptor a no volver a avisar.
        await client.post('soe', `/soe/pedidos/${p2._id}/descartar`, {
          body: { respuesta: '' }, expectStatus: 302,
        });
        let vuelto = await reqs.findOne({ _id: p2._id });
        assert(vuelto.estado === 'pendiente', 'sin motivo no puede haber cambiado de estado');

        const explicacion = `NO-ABRO-PORQUE-${RUN_ID}`;
        await client.post('soe', `/soe/pedidos/${p2._id}/descartar`, {
          body: { respuesta: explicacion }, expectStatus: 302,
        });
        vuelto = await reqs.findOne({ _id: p2._id });
        assert(vuelto.estado === 'descartada', `debería quedar descartada, quedó ${vuelto.estado}`);
        assert(!vuelto.soeCase, 'descartar no puede dejar un legajo colgado');

        const legajo = await mongo.db().collection('soecases')
          .findOne({ student: new ObjectId(state.soeDerivAlumno2Id) });
        assert(!legajo, 'descartar NO puede abrir el legajo del alumno');

        const mias = await client.get('soePrec', '/preceptor/soe', { expectStatus: 200 });
        assert(mias.text.includes(explicacion), 'el preceptor tiene que leer por qué no se lo tomaron');
      } finally {
        await mongo.close();
      }
    },
  },
  {
    id: 'soe-entrada-no-se-puede-disfrazar-de-derivacion',
    title: 'SOE: el gabinete no puede fabricar a mano una derivación de Preceptoría (criterio 26)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, assert, env }) {
      // El <select> del formulario no ofrece 'derivacion', pero el POST se puede escribir a
      // mano. La lista blanca de la ruta es TIPOS_ENTRADA_MANUALES, así que el tipo se
      // descarta y la entrada cae en 'nota' — queda guardada, pero no disfrazada.
      const texto = `ENTRADA-DISFRAZADA-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/entrada`, {
        body: { texto, tipo: 'derivacion', fecha: '' }, expectStatus: 302,
      });

      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        const legajo = await mongo.db().collection('soecases')
          .findOne({ _id: new ObjectId(state.soeCaseId) });
        const entrada = (legajo.entries || []).find(e => e.texto === texto);
        assert(entrada, 'la entrada tiene que haberse guardado igual');
        assert(entrada.tipo === 'nota', `el tipo debería caer en 'nota', quedó '${entrada.tipo}'`);
      } finally {
        await mongo.close();
      }
    },
  },
  // ── Material del legajo y citaciones (2026-08-30) ───────────────────────────
  // Cubren los criterios 33 a 42 de specs/soe-adjuntos-y-agenda.spec.md.
  //
  // Van por HTTP y no en un unitario porque lo que se prueba acá es justamente lo que una
  // función pura no puede probar: que el archivo llega al disco, que la ruta que lo devuelve
  // revalida el permiso, y que un archivo rechazado no se lleva puesto el texto que la
  // persona acababa de escribir.
  {
    id: 'soe-material-adjunta-certificado',
    title: 'SOE: adjunta el certificado a la devolución y lo puede volver a abrir (criterios 33 y 34)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      assert(state.soeCaseId && state.soeRefId, 'faltan el legajo y la derivación de los specs anteriores');

      // El caso que motivó la feature: el chico vuelve del hospital con un papel.
      state.soeAdjTitulo = `CERTIFICADO-${RUN_ID}`;
      const fd = new FormData();
      fd.append('texto', `VOLVIO-CON-CERTIFICADO-${RUN_ID}`);
      fd.append('fecha', '2026-08-18');
      fd.append('archivo', new Blob(['%PDF-1.4 certificado de prueba'], { type: 'application/pdf' }), 'certificado medico.pdf');
      fd.append('adjuntoTitulo', state.soeAdjTitulo);
      fd.append('categoria', 'certificado');
      fd.append('origen', 'profesional');
      fd.append('adjuntoFecha', '2026-08-17');

      await client.post('soe', `/soe/legajo/${state.soeCaseId}/derivacion/${state.soeRefId}/devolucion`,
        { form: fd, expectStatus: 302 });

      const ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes(state.soeAdjTitulo), 'el certificado debería aparecer en la ficha');

      state.soeAdjId = (ficha.text.match(/\/adjunto\/([a-f0-9]{24})/) || [])[1];
      assert(state.soeAdjId, 'no se pudo leer el id del adjunto desde la ficha');

      // La ruta que lo devuelve: es la que hace que el archivo NO viva en /public.
      const archivo = await client.get('soe', `/soe/legajo/${state.soeCaseId}/adjunto/${state.soeAdjId}`,
        { expectStatus: 200 });
      assert(archivo.byteLength > 0, 'el archivo debería bajar con contenido');
      assert(archivo.headers.get('x-content-type-options') === 'nosniff',
        'falta nosniff: sin él el navegador puede adivinar el tipo y ejecutarlo como HTML');
      const dispo = archivo.headers.get('content-disposition') || '';
      assert(/certificado/i.test(decodeURIComponent(dispo)),
        `el Content-Disposition debería llevar el nombre real, llegó: ${dispo}`);
      // El PDF se muestra adentro del navegador; un .docx se descargaría.
      assert(dispo.startsWith('inline'), 'un PDF tendría que verse en línea');
    },
  },
  {
    id: 'soe-material-rechaza-y-no-pierde-el-texto',
    title: 'SOE: un archivo prohibido rebota con cartel y el texto se guarda igual (criterio 35)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const texto = `ENTREVISTA-CON-ARCHIVO-MALO-${RUN_ID}`;
      const fd = new FormData();
      fd.append('texto', texto);
      fd.append('tipo', 'entrevista');
      fd.append('fecha', '2026-08-19');
      // Un .svg es interpretable como HTML: es de los que nunca pueden entrar.
      fd.append('archivo', new Blob(['<svg onload="alert(1)"></svg>'], { type: 'image/svg+xml' }), 'ataque.svg');

      const res = await client.post('soe', `/soe/legajo/${state.soeCaseId}/entrada`,
        { form: fd, expectStatus: 302 });
      // El aviso viaja en el redirect, con el motivo CONCRETO: no es lo mismo "ese formato no
      // entra" que "pesa demasiado", y se resuelven de maneras distintas.
      assert(/adjunto=formato/.test(res.headers.get('location') || ''),
        `el redirect debería avisar el motivo, fue a: ${res.headers.get('location')}`);

      const ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}?adjunto=formato`,
        { expectStatus: 200 });
      // ⭐ Lo que importa: la entrevista NO se perdió por culpa del archivo.
      assert(ficha.text.includes(texto), 'el texto de la actuación tenía que guardarse igual');
      assert(!ficha.text.includes('ataque.svg'), 'el archivo prohibido no puede haber quedado');
      assert(/no se puede adjuntar/i.test(ficha.text), 'la ficha debería explicar por qué rebotó');
    },
  },
  {
    id: 'soe-material-enlace-solo-http',
    title: 'SOE: un enlace javascript: no queda guardado (criterio 36)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const marca = `ENLACE-MALO-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/adjunto`, {
        body: { anclaTipo: 'legajo', enlace: 'javascript:alert(1)', enlaceTitulo: marca },
        expectStatus: 302,
      });
      const ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(!ficha.text.includes(marca), 'un enlace javascript: no puede quedar en el legajo');
      assert(!ficha.text.includes('javascript:alert'), 'el esquema prohibido llegó al HTML');

      // Y uno bueno sí, con el https puesto solo.
      state.soeEnlace = `ENLACE-BUENO-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/adjunto`, {
        body: { anclaTipo: 'legajo', enlace: 'hospital.gob.ar/turnos', enlaceTitulo: state.soeEnlace },
        expectStatus: 302,
      });
      const ok = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ok.text.includes(state.soeEnlace), 'el enlace bueno debería estar');
      assert(ok.text.includes('https://hospital.gob.ar/turnos'), 'el enlace debería normalizarse a https');
    },
  },
  {
    id: 'soe-material-no-lo-abre-cualquiera',
    title: 'SOE: el certificado no se abre sin permiso (criterio 37)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Es la razón de ser de la ruta: un archivo en /public lo lee cualquiera con la URL.
      const url = `/soe/legajo/${state.soeCaseId}/adjunto/${state.soeAdjId}`;
      for (const actor of ['scopedStudent', 'scopedTeacher', 'soeDir', 'admin']) {
        await client.get(actor, url, { expectStatus: 403 });
      }
      // Un id que no existe no confirma ni desmiente nada: 404 parejo.
      await client.get('soe', `/soe/legajo/${state.soeCaseId}/adjunto/000000000000000000000000`,
        { expectStatus: 404 });
    },
  },
  {
    id: 'soe-material-baja-deja-rastro',
    title: 'SOE: dar de baja borra el archivo y deja el registro (criterio 38)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/adjunto/${state.soeAdjId}/eliminar`,
        { expectStatus: 302 });

      // 410 y no 404: el registro existe, el archivo no. Son dos cosas distintas y quien las
      // mire desde un log tiene que poder distinguirlas.
      await client.get('soe', `/soe/legajo/${state.soeCaseId}/adjunto/${state.soeAdjId}`,
        { expectStatus: 410 });

      const ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      // ⭐ El renglón sigue: un legajo del que se puede sacar material sin dejar rastro no es
      // un registro completo.
      assert(ficha.text.includes(state.soeAdjTitulo), 'el registro del adjunto tiene que quedar');
      assert(/Dado de baja el/.test(ficha.text), 'la ficha debería decir que se dio de baja');

      // Idempotente: dos clicks no son dos bajas.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/adjunto/${state.soeAdjId}/eliminar`,
        { expectStatus: 302 });
    },
  },
  {
    id: 'soe-citacion-registrar-la-ausencia',
    title: 'SOE: cita a la familia, la familia no viene, y queda registrado (criterio 39)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      state.soeCitaMotivo = `CITACION-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/citacion`, {
        // Una fecha ya pasada: tiene que aparecer resaltada como "sin registrar qué pasó".
        body: { dia: '2026-08-20', hora: '10:30', a: 'familia', motivo: state.soeCitaMotivo,
                lugar: 'Gabinete', medio: 'Cuaderno de comunicaciones' },
        expectStatus: 302,
      });

      let ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes(state.soeCitaMotivo), 'la citación debería verse en la ficha');
      // La fecha no puede correrse un día: es la trampa de zona horaria del proyecto.
      assert(/20\/08|20 de ago/i.test(ficha.text), 'la citación del 20/08 se muestra con otra fecha');
      assert(ficha.text.includes('10:30'), 'la hora tiene que mostrarse tal cual se cargó');
      assert(/no quedó anotado qué ocurrió|Sin registrar/i.test(ficha.text),
        'una citación vencida sin registrar tiene que avisar');

      state.soeCitaId = (ficha.text.match(/id="cita-([a-f0-9]{24})"/) || [])[1];
      assert(state.soeCitaId, 'no se pudo leer el id de la citación');

      // Registrar que la familia no vino. Aunque no haya venido, es parte del legajo.
      const notas = `NO-VINO-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/citacion/${state.soeCitaId}`, {
        body: { estado: 'ausente', notas }, expectStatus: 302,
      });

      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      assert(ficha.text.includes(notas), 'lo que se registró debería verse');
      assert(ficha.text.includes('No se presentó'), 'el estado debería ser "No se presentó"');
      assert(!/no quedó anotado qué ocurrió/i.test(ficha.text),
        'una vez registrada, la citación ya no puede pedir atención');
      // Y entra a la línea de tiempo, porque su día ya pasó (decisión D8 de la spec).
      assert(/Citación · La familia/.test(ficha.text), 'la citación debería ser un hito del hilo');
    },
  },
  {
    id: 'soe-citacion-reprogramar',
    title: 'SOE: reprogramar deja la vieja registrada y abre otra (criterios 40 y 41)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const motivo = `CITACION-A-MOVER-${RUN_ID}`;
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/citacion`, {
        body: { dia: '2026-08-21', hora: '09:00', a: 'alumno', motivo }, expectStatus: 302,
      });
      let ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      const ids = [...ficha.text.matchAll(/id="cita-([a-f0-9]{24})"/g)].map(m => m[1]);
      const citaId = ids.find(id => id !== state.soeCitaId);
      assert(citaId, 'no se pudo leer el id de la citación nueva');

      // Sin fecha no es reprogramar: no cambia nada y avisa.
      const sinFecha = await client.post('soe', `/soe/legajo/${state.soeCaseId}/citacion/${citaId}`, {
        body: { estado: 'reprogramada', nuevoDia: '' }, expectStatus: 302,
      });
      assert(/citacion=sinfecha/.test(sinFecha.headers.get('location') || ''),
        'reprogramar sin fecha debería volver con el aviso');

      // Con fecha: la vieja queda como fue, y se abre una nueva.
      await client.post('soe', `/soe/legajo/${state.soeCaseId}/citacion/${citaId}`, {
        body: { estado: 'reprogramada', nuevoDia: '2099-04-15', nuevaHora: '11:00' },
        expectStatus: 302,
      });

      ficha = await client.get('soe', `/soe/legajo/${state.scopedStudentId}`, { expectStatus: 200 });
      // ⭐ Las dos existen: pisar la fecha borraría que hubo una primera convocatoria, que es
      // justo el dato que se quiere conservar.
      assert(ficha.text.includes('Se pasó para otro día'), 'la citación vieja tiene que quedar registrada');
      assert(/15\/04\/2099|15 de abr/i.test(ficha.text), 'la citación nueva debería estar en su fecha');
      assert((ficha.text.match(new RegExp(motivo, 'g')) || []).length >= 2,
        'el motivo debería aparecer en las dos citaciones');
    },
  },
  {
    id: 'soe-agenda',
    title: 'SOE: la agenda muestra las tres fechas y solo la ve el nivel completo (criterio 42)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const agosto = await client.get('soe', '/soe/agenda?mes=2026-08', { expectStatus: 200 });
      assert(/agosto de 2026/i.test(agosto.text), 'el calendario debería estar en agosto de 2026');
      assert(agosto.text.includes('/soe/legajo/' + state.scopedStudentId),
        'la citación del alumno debería linkear a su legajo');

      // Un mes escrito a mano en la URL no puede romper la pantalla.
      await client.get('soe', '/soe/agenda?mes=2026-13', { expectStatus: 200 });
      await client.get('soe', '/soe/agenda?mes=cualquiera', { expectStatus: 200 });

      // Y el resumen del panel lo cuenta.
      const home = await client.get('soe', '/soe', { expectStatus: 200 });
      assert(/Citaciones/.test(home.text), 'el resumen debería nombrar las citaciones');

      for (const actor of ['scopedStudent', 'scopedTeacher', 'soeDir', 'admin']) {
        await client.get(actor, '/soe/agenda', { expectStatus: 403 });
      }
    },
  },
  {
    id: 'soe-cleanup',
    title: 'Limpieza: borra el legajo y los usuarios del SOE',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD', 'MONGODB_URI'],
    async run({ client, state, env }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      try {
        await mongo.connect();
        // No hay ruta para borrar un legajo (a propósito: un legajo se cierra, no se borra).
        // El smoke lo saca por la base, igual que hace con los audit logs. Tampoco la hay
        // para borrar un pedido de derivación, y por el mismo motivo.
        const alumnos = [state.scopedStudentId, state.soeDerivAlumnoId, state.soeDerivAlumno2Id]
          .filter(Boolean).map(id => new ObjectId(id));
        if (alumnos.length) {
          await mongo.db().collection('soecases').deleteMany({ student: { $in: alumnos } });
          await mongo.db().collection('soerequests').deleteMany({ student: { $in: alumnos } });
        }
      } finally {
        await mongo.close();
      }

      // Y los archivos que quedaron en disco. Borrar el legajo de la base no los toca: sin
      // esto, cada corrida del smoke deja un certificado de prueba en archivos/soe/ para
      // siempre. Un directorio por legajo (ver SOE_BASE en routes/soe.js) hace que sea un
      // solo rmdir.
      if (state.soeCaseId) {
        const fsp  = require('fs').promises;
        const path = require('path');
        const base = path.join(__dirname, '../../archivos/soe');
        for (const escuela of await fsp.readdir(base).catch(() => [])) {
          await fsp.rm(path.join(base, escuela, state.soeCaseId), { recursive: true, force: true })
            .catch(() => {});
        }
      }
      if (state.soeId)             await client.post('admin', `/admin/users/${state.soeId}/delete`,             { expectStatus: 200 });
      if (state.soeDirId)          await client.post('admin', `/admin/users/${state.soeDirId}/delete`,          { expectStatus: 200 });
      if (state.soeDerivAlumnoId)  await client.post('admin', `/admin/users/${state.soeDerivAlumnoId}/delete`,  { expectStatus: 200 });
      if (state.soeDerivAlumno2Id) await client.post('admin', `/admin/users/${state.soeDerivAlumno2Id}/delete`, { expectStatus: 200 });
      if (state.soePrecId)         await client.post('admin', `/admin/users/${state.soePrecId}/delete`,         { expectStatus: 200 });
      // La materia va DESPUÉS de los alumnos: `cleanup-users-and-division` no puede borrar la
      // división mientras tenga una materia adentro.
      if (state.soeDerivCourseId)  await client.post('admin', `/admin/courses/${state.soeDerivCourseId}/delete`, { expectStatus: 200 });
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
    // Los usuarios de Nivel 1 nacen SIN escuela (los crea el superadmin desde el
    // 2026-08-23, antes se autoregistraban), así que no hay ruta que los borre: el DELETE
    // del admin exige misma escuela. Y como el alumno elige curso desde su panel, además
    // de la cuenta hay que sacarlo de las materias REALES donde quedó inscripto — si no,
    // el docente ve un alumno de prueba en su lista de la base local.
    //
    // `fakePreceptorId`/`fakeJefeId` ya no se setean: desde que el registro está cerrado
    // esos specs no crean cuentas, solo comprueban el 403. Se dejan en la lista igual —
    // `filter(Boolean)` los saltea— para que la limpieza siga sirviendo si algún día se
    // reabre el registro y vuelven a nacer.
    id: 'cleanup-self-registered-db',
    title: 'Limpieza: borra los usuarios de Nivel 1 y su matrícula',
    requiresEnv: ['MONGODB_URI'],
    async run({ env, state }) {
      const { MongoClient, ObjectId } = require('mongodb');
      const ids = [state.teacherId, state.studentId, state.fakePreceptorId, state.fakeJefeId]
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
  // ═══════════════════════════════════════════════════════════════════════════
  // RECURSOS Y RESERVAS (módulo opcional por escuela — config/modulos.js)
  //
  // Lo que cubren y los unitarios no: que las TRES guardas encadenadas
  // (requireAdmin → requireModulo → requireSection) dejen pasar a quien tiene que pasar, y
  // que el cupo se descuente igual por las dos puertas que confirman una reserva — la del
  // docente autorizado, que entra directo, y la del administrativo, que aprueba.
  //
  // La aritmética del cupo y las repeticiones NO se prueban acá: viven en
  // tests/unit/cupoReservas.test.js y disponibilidadReservas.test.js, donde se puede lanzar
  // la carrera con Promise.all y fijar el `hoy`.
  //
  // ⚠️ ESTE BLOQUE CREA SUS PROPIOS DOCENTES en vez de reusar `scopedTeacher`. No es por
  // prolijidad: los specs de limpieza del curso base borran esas cuentas bastante antes del
  // final de la lista, y cualquier spec que las use después recibe un 302 a /login. Con
  // actores propios el bloque se puede mover de lugar sin que se rompa.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    id: 'recursos-setup',
    title: 'Se prende el módulo de recursos y se crean dos docentes de prueba',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const lista = await client.get('superadmin', '/superadmin/schools', { expectStatus: 200 });
      const ids = [...(lista.text || '').matchAll(/\/superadmin\/schools\/([a-f0-9]{24})\/edit/g)];
      assert(ids.length, 'no hay ninguna escuela contra la cual probar');

      // La escuela del admin de smoke es contra la que corre todo lo demás.
      const perfil = await client.get('admin', '/admin', { expectStatus: 200 });
      const propia = ids.map(m => m[1]).find(id => (perfil.text || '').includes(id));
      state.recSchoolId = propia || ids[0][1];

      // Se guarda el estado ANTERIOR para dejarlo como estaba: el smoke corre contra el
      // espejo del usuario y no puede prenderle (ni apagarle) módulos a su escuela real.
      const edit = await client.get('superadmin', `/superadmin/schools/${state.recSchoolId}/edit`, { expectStatus: 200 });
      state.recModuloEstabaPrendido = /data-id="recursos"[^>]*checked/.test(edit.text || '');

      await client.post('superadmin', `/superadmin/schools/${state.recSchoolId}/edit`, {
        body: { modules: { recursos: { enabled: true } } },
        expectStatus: 200,
      });

      // Dos docentes: uno pide y otro compite por el mismo módulo.
      for (const [n, actor] of [[1, 'recDocente'], [2, 'recDocente2']]) {
        const email = `rec.doc${n}.${RUN_ID}@example.com`;
        const alta = await client.post('admin', '/admin/users/create', {
          body: { name: `Smoke Recursos Doc${n} ${RUN_ID}`, email,
                  password: 'SmokeTest1234', role: 'teacher', dni: dniSmoke(60 + n) },
          expectStatus: 201,
        });
        state[`${actor}Id`] = alta.json.user._id;
        await client.post(actor, '/login', { body: { email, password: 'SmokeTest1234' }, expectStatus: 200 });
      }
    },
  },
  {
    id: 'recursos-modulo-apagado-cierra-la-puerta',
    title: 'Con el módulo apagado, /admin/recursos y /reservas contestan 403',
    requiresEnv: ['SMOKE_SUPERADMIN_EMAIL', 'SMOKE_SUPERADMIN_PASSWORD', 'SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es lo que NO se puede probar con el catálogo de solapas: requireModulo es fail-closed
      // y bloquea la RUTA, no solo el nav. Sin esto, apagar el módulo solo escondería el
      // botón y la URL escrita a mano seguiría funcionando.
      await client.post('superadmin', `/superadmin/schools/${state.recSchoolId}/edit`, {
        body: { modules: { recursos: { enabled: false } } },
        expectStatus: 200,
      });

      // Se MIDE primero y se vuelve a prender DESPUÉS, antes de cualquier assert: si un
      // assert cortara acá, el módulo quedaría apagado y los diez specs siguientes fallarían
      // en cascada por un motivo que no es el suyo.
      const admin  = await client.get('admin', '/admin/recursos');
      const docente = await client.get('recDocente', '/reservas');

      await client.post('superadmin', `/superadmin/schools/${state.recSchoolId}/edit`, {
        body: { modules: { recursos: { enabled: true } } },
        expectStatus: 200,
      });

      // ⚠️ El doc de escuela va cacheado 45s (middleware/cache.js), pero invalidateSchool()
      // limpia el worker que atendió el POST y el smoke corre contra un solo proceso: el
      // cambio se ve en el request siguiente. En producción, con 2 workers, puede tardar.
      assert(admin.status === 403, `/admin/recursos con el módulo apagado debería dar 403, dio ${admin.status}`);
      assert(docente.status === 403, `/reservas con el módulo apagado debería dar 403, dio ${docente.status}`);
    },
  },
  {
    id: 'recursos-horario-rechaza-la-grilla-con-hueco',
    title: 'El horario con un hueco se rechaza, y el completo se guarda',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const { PRESET_4118 } = require('../../services/recursos/horario');

      // Sin la franja del recreo quedan 10 minutos sin cubrir entre 2ª y 3ª hora. La pantalla
      // los dibujaría como contiguos y el docente llegaría 9:20 a una clase que arranca 9:30.
      const conHueco = PRESET_4118();
      conHueco.turnos[0].franjas.splice(2, 1);
      const malo = await client.post('admin', '/admin/recursos/horario', {
        body: { horario: JSON.stringify(conHueco) },
      });
      assert(malo.status === 400, `la grilla con hueco debería dar 400, dio ${malo.status}`);
      assert(/hueco/i.test(malo.json?.error || ''), `el error tiene que nombrar el hueco: ${malo.json?.error}`);

      // El bueno: los dos turnos de la escuela, 7 módulos de 40' y 2 recreos de 10'.
      // `confirmar` va en 'si' porque el espejo local puede tener reservas previas de una
      // corrida anterior; el guardado avisa antes de dejarlas sin módulo, y acá se acepta.
      await client.post('admin', '/admin/recursos/horario', {
        body: { horario: JSON.stringify(PRESET_4118()), confirmar: 'si' },
        expectStatus: 200,
      });
    },
  },
  {
    id: 'recursos-admin-crea-los-dos-recursos',
    title: 'El admin crea la sala (entera) y las netbooks (repartibles)',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const sala = await client.post('admin', '/admin/recursos/crear', {
        body: { name: `Sala Smoke ${RUN_ID}`, tipo: 'aula', capacidad: 20,
                divisible: 'off', requiereAutorizacion: 'on' },
        expectStatus: 200,
      });
      state.recSalaId = sala.json.id;

      const net = await client.post('admin', '/admin/recursos/crear', {
        body: { name: `Netbooks Smoke ${RUN_ID}`, tipo: 'equipamiento', capacidad: 30,
                divisible: 'on', maxPorPedido: 15, requiereAutorizacion: 'on' },
        expectStatus: 200,
      });
      state.recNetId = net.json.id;

      // Un recurso "repartible" de una sola unidad no es repartible: es exclusivo con un
      // nombre confuso, y elegiría el mecanismo de cupo equivocado.
      const absurdo = await client.post('admin', '/admin/recursos/crear', {
        body: { name: `Absurdo Smoke ${RUN_ID}`, capacidad: 1, divisible: 'on' },
      });
      assert(absurdo.status === 400, `un divisible de capacidad 1 debería dar 400, dio ${absurdo.status}`);
    },
  },
  {
    id: 'recursos-docente-pide-y-queda-pendiente',
    title: 'El docente sin autorizar pide la sala y su reserva queda pendiente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Una fecha futura que caiga en día de semana: dentro de dos semanas, corrida al lunes
      // si cae fin de semana. Se calcula con diaEscolar() y no con new Date() por lo de
      // siempre: producción corre en UTC y "hoy" a las 21:30 ya sería mañana.
      const { sumarDias, diaSemana } = require('../../services/recursos/disponibilidad');
      const { diaEscolar } = require('../../services/liveRoom');
      let f = sumarDias(diaEscolar(), 14);
      while (diaSemana(f) > 5) f = sumarDias(f, 1);
      state.recFecha = f;

      const r = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 3,
                fecha: state.recFecha, repeticion: 'unica', motivo: `Smoke ${RUN_ID}` },
        expectStatus: 200,
      });
      assert(r.json.creadas === 1, `debería crear 1, creó ${r.json.creadas}`);
      assert(r.json.pendientes === 1, 'sin autorización tiene que quedar PENDIENTE, no confirmada');
      assert(r.json.confirmadas === 0, 'no puede autoconfirmarse');

      // El mismo casillero otra vez es un clic repetido, no un choque: se saltea sin ruido.
      const otra = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 3,
                fecha: state.recFecha, repeticion: 'unica' },
        expectStatus: 200,
      });
      assert(otra.json.creadas === 0 && otra.json.omitidas.length === 1,
        'el pedido repetido tiene que omitirse, no duplicarse');
    },
  },
  {
    id: 'recursos-un-pendiente-no-bloquea-el-casillero',
    title: 'El pedido pendiente de uno no le cierra la puerta al otro docente',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es la contracara del índice parcial de models/Reserva.js: los pendientes no ocupan el
      // casillero. Si lo ocuparan, un pedido sin resolver le bloquearía el módulo a un
      // docente ya autorizado, que es exactamente lo que el diseño evita.
      const r = await client.post('recDocente2', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 3,
                fecha: state.recFecha, repeticion: 'unica' },
        expectStatus: 200,
      });
      assert(r.json.creadas === 1, `el segundo docente también tiene que poder pedir: ${JSON.stringify(r.json)}`);
      assert(r.json.pendientes === 1, 'y queda pendiente, como el primero');
    },
  },
  {
    id: 'recursos-admin-aprueba-y-autoriza',
    title: 'El admin aprueba el pedido y deja al docente autorizado para ese recurso',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const bandeja = await client.get('admin', '/admin/recursos/pedidos', { expectStatus: 200 });
      const filas = [...(bandeja.text || '').matchAll(/id="fila-([a-f0-9]{24})"/g)].map(m => m[1]);
      assert(filas.length >= 2, `los dos pedidos tienen que figurar en la bandeja, hay ${filas.length}`);

      // Se aprueba el del PRIMER docente. El del segundo queda pendiente sobre el mismo
      // casillero, que es lo que arma el spec siguiente.
      // Los dos se buscan POR NOMBRE, nunca por posición ni por descarte: la bandeja es la
      // de la escuela entera y puede tener pedidos de otras corridas o de uso real. Tomar
      // "el que no es el primero" aprobaría el pedido de un tercero y el spec mediría otra
      // cosa sin avisar.
      const bandejaTxt = bandeja.text || '';
      const porDocente = (n) => filas.find(id => {
        const fila = (bandejaTxt.split(`id="fila-${id}"`)[1] || '').split('</tr>')[0];
        return fila.includes(`Doc${n} ${RUN_ID}`);
      });
      const delPrimero = porDocente(1);
      state.recPedidoDoc2 = porDocente(2);
      assert(delPrimero, 'no se encontró el pedido del primer docente en la bandeja');
      assert(state.recPedidoDoc2, 'no se encontró el pedido del segundo docente en la bandeja');

      await client.post('admin', `/admin/recursos/pedidos/${delPrimero}/aprobar`, {
        body: { autorizar: 'si' }, expectStatus: 200,
      });

      // Un pedido ya resuelto no se puede volver a aprobar: si no, dos clics del
      // administrativo tomarían el cupo dos veces.
      const otra = await client.post('admin', `/admin/recursos/pedidos/${delPrimero}/aprobar`, {
        body: { autorizar: 'no' },
      });
      assert(otra.status === 404, `aprobar dos veces debería dar 404, dio ${otra.status}`);
    },
  },
  {
    id: 'recursos-el-perdedor-de-la-carrera-recibe-un-mensaje',
    title: 'Aprobar el segundo pedido del mismo módulo exclusivo da 409, no 500',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El casillero ya lo tiene el primer docente. Aprobar el segundo choca contra el índice
      // único parcial de models/Reserva.js. Lo que se está probando es que ese E11000 llegue
      // a la pantalla como una explicación y no como un 500 — es la peor cara del módulo.
      assert(state.recPedidoDoc2, 'hacía falta el pedido del segundo docente');
      const r = await client.post('admin', `/admin/recursos/pedidos/${state.recPedidoDoc2}/aprobar`, {
        body: { autorizar: 'no' },
      });
      assert(r.status === 409, `esperaba 409, dio ${r.status}`);
      assert(/otro docente/i.test(r.json?.error || ''),
        `el mensaje tiene que explicar qué pasó, dijo: ${r.json?.error}`);

      // Y el pedido perdedor tiene que SALIR de la bandeja. Ese módulo ya es de otro y no se
      // va a liberar solo: dejarlo pendiente lo devolvería mañana, y pasado, para siempre —
      // una fila que el administrativo no puede resolver y que le enseña a ignorar la bandeja.
      assert(r.json.resuelto === true, 'el pedido perdedor tiene que quedar rechazado');
      const despues = await client.get('admin', '/admin/recursos/pedidos', { expectStatus: 200 });
      assert(!(despues.text || '').includes(`id="fila-${state.recPedidoDoc2}"`),
        'el pedido rechazado no puede seguir en la bandeja');
    },
  },
  {
    id: 'recursos-el-alumno-no-entra',
    title: 'El alumno no puede ver ni pedir reservas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Reservar la sala de computación es una decisión institucional. El rol `student` no
      // está en app_reservas (config/sections.js) y la ruta lo tiene que rechazar igual,
      // aunque el nav nunca se lo haya ofrecido.
      const email = `rec.alumno.${RUN_ID}@example.com`;
      const alta = await client.post('admin', '/admin/users/create', {
        body: { name: `Smoke Recursos Alumno ${RUN_ID}`, email,
                password: 'SmokeTest1234', role: 'student', dni: dniSmoke(63) },
        expectStatus: 201,
      });
      state.recAlumnoId = alta.json.user._id;
      await client.post('recAlumno', '/login', { body: { email, password: 'SmokeTest1234' }, expectStatus: 200 });

      const ver = await client.get('recAlumno', '/reservas');
      assert(ver.status === 403, `/reservas para el alumno debería dar 403, dio ${ver.status}`);

      const pedir = await client.post('recAlumno', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 5, fecha: state.recFecha, repeticion: 'unica' },
      });
      assert(pedir.status === 403, `el alumno no puede pedir: esperaba 403, dio ${pedir.status}`);
    },
  },
  {
    id: 'recursos-autorizado-entra-directo',
    title: 'Ya autorizado, el docente reserva sin pasar por la bandeja',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Es lo que hace que el calendario "se autocomplete": el primer pedido pasa por una
      // persona y después el docente carga solo.
      const r = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 5,
                fecha: state.recFecha, repeticion: 'unica' },
        expectStatus: 200,
      });
      assert(r.json.confirmadas === 1, `tenía que entrar CONFIRMADA, quedó ${JSON.stringify(r.json)}`);
      assert(r.json.pendientes === 0, 'un docente autorizado no vuelve a la bandeja');

      // La sala ya reservada no acepta a otro en el mismo módulo: la guarda es el índice
      // único, y el que llega segundo lo ve como una fecha omitida, no como un error.
      const choque = await client.post('recDocente2', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'manana', modulo: 5,
                fecha: state.recFecha, repeticion: 'unica' },
        expectStatus: 200,
      });
      assert(choque.json.creadas === 0, 'la sala ocupada no puede aceptar una segunda reserva');
      assert(/reservado/i.test(choque.json.omitidas?.[0]?.motivo || ''),
        `tendría que decir que ya está reservado: ${JSON.stringify(choque.json.omitidas)}`);
    },
  },
  {
    id: 'recursos-la-serie-semanal-es-parcial',
    title: 'Una serie semanal crea las fechas libres y omite las tomadas',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Si pidió 4 martes y uno está tomado, se crean los otros 3 y se informa el que no.
      // Cancelar el pedido entero por un choque sería castigar al docente por algo que no
      // eligió, y obligarlo a volver a cargar tres fechas a mano.
      const { sumarDias } = require('../../services/recursos/disponibilidad');
      const hasta = sumarDias(state.recFecha, 21);

      const r = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'tarde', modulo: 7,
                fecha: state.recFecha, repeticion: 'semanal', hasta },
        expectStatus: 200,
      });
      assert(r.json.creadas === 4, `4 semanas seguidas: esperaba 4, creó ${r.json.creadas}`);
      state.recSerieFecha = state.recFecha;

      // Ahora el segundo docente pide las mismas 4: todas omitidas, ninguna creada.
      const choque = await client.post('recDocente2', '/reservas/pedir', {
        body: { recurso: state.recSalaId, turno: 'tarde', modulo: 7,
                fecha: state.recFecha, repeticion: 'semanal', hasta },
        expectStatus: 200,
      });
      assert(choque.json.creadas === 0, 'ninguna tendría que entrar');
      assert(choque.json.omitidas.length === 4, `esperaba 4 omitidas, hubo ${choque.json.omitidas.length}`);
    },
  },
  {
    id: 'recursos-netbooks-se-reparten',
    title: 'Dos pedidos de 15 netbooks entran los dos; pedir 25 se rechaza',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // El docente ya está autorizado en la SALA, pero no en las netbooks: la autorización es
      // por recurso, así que este pedido vuelve a quedar pendiente.
      const p1 = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recNetId, turno: 'tarde', modulo: 1,
                fecha: state.recFecha, repeticion: 'unica', unidades: 15 },
        expectStatus: 200,
      });
      assert(p1.json.pendientes === 1, 'la autorización es POR RECURSO: acá vuelve a pedir permiso');

      // La fila DE LAS NETBOOKS, buscada por el nombre del recurso. Tomar la primera de la
      // bandeja aprobaría el pedido de otro —la bandeja es la de la escuela entera— y el
      // spec mediría cualquier cosa menos el reparto del cupo.
      const bandeja = await client.get('admin', '/admin/recursos/pedidos', { expectStatus: 200 });
      const fila = (bandeja.text || '').split('id="fila-').find(f => f.includes(`Netbooks Smoke ${RUN_ID}`));
      assert(fila, 'el pedido de netbooks tiene que estar en la bandeja');
      const id = fila.slice(0, 24);
      await client.post('admin', `/admin/recursos/pedidos/${id}/aprobar`, {
        body: { unidades: 15, autorizar: 'si' }, expectStatus: 200,
      });

      // Quedan 15 de 30: el segundo docente se lleva la otra mitad. Es el reparto, y es lo
      // que un recurso exclusivo NO permitiría.
      const p2 = await client.post('recDocente2', '/reservas/pedir', {
        body: { recurso: state.recNetId, turno: 'tarde', modulo: 1,
                fecha: state.recFecha, repeticion: 'unica', unidades: 15 },
        expectStatus: 200,
      });
      assert(p2.json.creadas === 1, `el segundo tiene que poder pedir su mitad: ${JSON.stringify(p2.json)}`);

      // Pedir más que el tope del pedido se rechaza en la RUTA, no solo en el <input>: un
      // `max` de un formulario se edita con el inspector en dos segundos.
      const excedido = await client.post('recDocente', '/reservas/pedir', {
        body: { recurso: state.recNetId, turno: 'tarde', modulo: 2,
                fecha: state.recFecha, repeticion: 'unica', unidades: 25 },
      });
      assert(excedido.status === 400, `pedir 25 con tope 15 debería dar 400, dio ${excedido.status}`);
      assert(/entre 1 y 15/.test(excedido.json?.error || ''), `el error tiene que decir el tope: ${excedido.json?.error}`);
    },
  },
  {
    id: 'recursos-la-celda-divisible-dice-cuantas-quedan',
    title: 'El calendario de un recurso repartible muestra el cupo, no "ocupado"',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      // Una celda que dijera solo "ocupada" con 15 de 30 tomadas sería falsa, y el docente
      // que necesita 10 se iría creyendo que no hay.
      const g = await client.get('recDocente', `/reservas?recurso=${state.recNetId}&semana=${state.recFecha}`, { expectStatus: 200 });
      assert(/de 30/.test(g.text || ''), 'la celda tiene que decir cuántas de 30 quedan');
      assert(/libres/.test(g.text || ''), 'y la palabra "libres"');

      // Y la grilla tiene que traer los recreos: sin ellos, 2ª y 3ª hora se leen contiguas.
      assert(/Recreo/.test(g.text || ''), 'los recreos se pintan en la grilla');
    },
  },
  {
    id: 'recursos-cancelar-devuelve-el-cupo',
    title: 'Cancelar una reserva de netbooks devuelve las unidades al carro',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const mias = await client.get('recDocente2', '/reservas/mias', { expectStatus: 200 });

      // La fila de LAS NETBOOKS, no la primera de la lista: este docente tiene además una
      // reserva de la sala, y cancelar aquélla no devolvería ninguna unidad — el spec pasaría
      // a medir algo que no es el cupo.
      const filaNet = (mias.text || '').split('<tr').find(f => f.includes(`Netbooks Smoke ${RUN_ID}`));
      assert(filaNet, 'el docente tiene que ver su reserva de netbooks para poder cancelarla');
      const idNet = (filaNet.match(/cancelar\('([a-f0-9]{24})'/) || [])[1];
      assert(idNet, 'la fila de netbooks tiene que ofrecer el botón de cancelar');

      // Se cancela su reserva de 15 netbooks y se vuelve a pedir la misma cantidad. Si el
      // cupo no se devolviera, el segundo pedido no entraría: es el chequeo que atrapa el
      // olvido de llamar a devolver() en un camino de salida.
      const cancel = await client.post('recDocente2', `/reservas/${idNet}/cancelar`, { body: { serie: 'no' } });
      assert(cancel.status === 200, `no se pudo cancelar: ${cancel.status} ${JSON.stringify(cancel.json)}`);

      const otra = await client.post('recDocente2', '/reservas/pedir', {
        body: { recurso: state.recNetId, turno: 'tarde', modulo: 1,
                fecha: state.recFecha, repeticion: 'unica', unidades: 15 },
        expectStatus: 200,
      });
      assert(otra.json.creadas === 1,
        `las 15 canceladas tienen que volver al carro: ${JSON.stringify(otra.json)}`);
    },
  },
  {
    id: 'recursos-cancelar-la-serie-no-toca-lo-ajeno',
    title: 'Cancelar una serie cancela solo las propias y solo las futuras',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state, assert }) {
      const mias = await client.get('recDocente', '/reservas/mias', { expectStatus: 200 });
      // La de la serie es la única que ofrece el botón "Cancelar la serie".
      const m = (mias.text || '').match(/cancelar\('([a-f0-9]{24})', true\)/);
      assert(m, 'la reserva de una serie tiene que ofrecer cancelar la serie entera');

      const r = await client.post('recDocente', `/reservas/${m[1]}/cancelar`, { body: { serie: 'si' } });
      assert(r.status === 200, `esperaba 200, dio ${r.status}`);
      assert(r.json.canceladas === 4, `la serie eran 4 fechas, canceló ${r.json.canceladas}`);

      // El otro docente no puede cancelar lo que no es suyo.
      const mias2 = await client.get('recDocente', '/reservas/mias', { expectStatus: 200 });
      const propia = (mias2.text || '').match(/cancelar\('([a-f0-9]{24})', false\)/);
      if (propia) {
        const ajena = await client.post('recDocente2', `/reservas/${propia[1]}/cancelar`, { body: { serie: 'no' } });
        assert(ajena.status === 403, `cancelar la reserva de otro debería dar 403, dio ${ajena.status}`);
      }
    },
  },
  {
    id: 'recursos-limpieza',
    title: 'Limpieza: se dan de baja los recursos, las cuentas y se deja el módulo como estaba',
    requiresEnv: ['SMOKE_ADMIN_EMAIL', 'SMOKE_ADMIN_PASSWORD'],
    async run({ client, state }) {
      // Dar de baja cancela las reservas futuras por el camino normal (liberar), que es el que
      // devuelve el cupo. Sin eso quedarían casilleros ocupados por reservas de un recurso que
      // ya no existe — la fuga que describe models/SlotOcupacion.js.
      for (const id of [state.recSalaId, state.recNetId]) {
        if (id) await client.post('admin', `/admin/recursos/${id}/borrar`, {});
      }
      for (const id of [state.recDocenteId, state.recDocente2Id, state.recAlumnoId]) {
        if (id) await client.post('admin', `/admin/users/${id}/delete`, {});
      }
      // El smoke corre contra el espejo del usuario: si el módulo estaba apagado, se lo deja
      // apagado. Prenderle un módulo a su escuela real de rebote sería un efecto colateral.
      if (state.recSchoolId && state.recModuloEstabaPrendido === false) {
        await client.post('superadmin', `/superadmin/schools/${state.recSchoolId}/edit`, {
          body: { modules: { recursos: { enabled: false } } },
        });
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
          state.salaDirectivoId, state.salaPreceptorId,
          state.fakePreceptorId, state.dniNormalizedId, state.thirdDivisionId,
          state.joinCourseId, state.joinOtherCourseId, state.joinOtherDivisionId,
          state.dupConMateriaId, state.dupVaciaId, state.dupCourseId,
          state.dupMailViejaId, state.dupMailNuevaId,
          state.soeId, state.soeDirId,
          state.soePrecId, state.soeDerivAlumnoId, state.soeDerivAlumno2Id, state.soeDerivCourseId,
        ].filter(Boolean);
        const ids = idStrings.map(s => new ObjectId(s));

        // Los recursos de este bloque se dan de baja por la ruta (activo:false), que es lo
        // correcto para un recurso real —su historial de reservas tiene que sobrevivir— pero
        // deja dos filas muertas en el panel del admin por cada corrida. Acá SÍ se borran de
        // verdad, junto con lo que colgaba de ellos: son de prueba y no tienen historial que
        // preservar.
        const recursosSmoke = await client.db().collection('recursos')
          .find({ name: { $regex: RUN_ID } }).project({ _id: 1 }).toArray();
        if (recursosSmoke.length) {
          const rids = recursosSmoke.map(r => r._id);
          await client.db().collection('reservas').deleteMany({ recurso: { $in: rids } });
          await client.db().collection('slotocupacions').deleteMany({ recurso: { $in: rids } });
          await client.db().collection('recursoautorizacions').deleteMany({ recurso: { $in: rids } });
          await client.db().collection('recursos').deleteMany({ _id: { $in: rids } });
        }

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
