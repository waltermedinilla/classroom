// Los permisos de una materia, como funciones puras. Ver services/cursoPermisos.js.
// Correr con: npm run test:unit
//
// POR QUÉ EXISTE ESTE ARCHIVO (2026-09-08). Las reglas eran métodos del schema, y eso obligaba
// a tener un documento de Mongoose hidratado para preguntarlas. El poll de la sala resolvía el
// curso entero —cuatro queries, 11,4 ms medidos— cada 4 segundos por persona solo para poder
// llamarlas. Al mudarlas acá, el poll puede leer el curso de un cache como objeto plano.
//
// Lo que estos tests tienen que garantizar es UNA cosa por encima de todas: que la regla dé
// exactamente lo mismo sobre un objeto plano que sobre un documento. Si eso se rompe, no se
// rompe "el rendimiento": se rompe el permiso, y del lado peligroso — el intento fallido de
// hacerlo con `Course.hydrate()` devolvía `canManage: false` SIN LANZAR NINGÚN ERROR, o sea
// que la docente perdía su propia sala en silencio.
//
// Cuatro bloques:
//   1. LAS REGLAS — cada una, sobre objetos planos.
//   2. ⭐ EQUIVALENCIA — la función pura y el método del schema, sobre los MISMOS datos.
//   3. ⭐ EL CURSO POPULADO Y PLANO — la forma exacta que sale de un `.lean()` con populate,
//      que es lo que se guarda en el cache. Es el caso que `hydrate` rompía.
//   4. EL CACHE — que guarde, que expire y que se pueda invalidar.

const test     = require('node:test');
const assert   = require('node:assert');
const mongoose = require('mongoose');

const permisos = require('../../services/cursoPermisos');
const Course   = require('../../models/Course');
const { courseCache, invalidateCourse, invalidateAll } = require('../../middleware/cache');

const id = () => new mongoose.Types.ObjectId();

// El curso como objeto PLANO, que es lo que devuelve un `.lean()`.
const plano = ({ owner = id(), coTeachers = [], students = [], school = null, division = null }) =>
  ({ _id: id(), name: 'Materia', owner, coTeachers, students, school, division });

// ── 1. Las reglas ───────────────────────────────────────────────────────────

test('esDocente: el dueño y los co-docentes, nadie más', () => {
  const duenio = id(), co = id(), ajeno = id();
  const c = plano({ owner: duenio, coTeachers: [co] });

  assert.equal(permisos.esDocente(c, duenio), true);
  assert.equal(permisos.esDocente(c, co),     true);
  assert.equal(permisos.esDocente(c, ajeno),  false);
  assert.equal(permisos.esDocente(c, null),   false, 'sin usuario no concede nada');
  assert.equal(permisos.esDocente(null, duenio), false, 'sin curso tampoco');
});

test('esDocente tolera un owner colgado (docente borrado)', () => {
  // populate('owner') devuelve null cuando el usuario ya no existe. Sin la guarda esto tiraba
  // un TypeError y se llevaba puesta toda ruta que preguntara el permiso: la materia se volvía
  // inaccesible para TODO el mundo, no solo para el borrado.
  const c = plano({ owner: null });
  assert.doesNotThrow(() => permisos.esDocente(c, id()));
  assert.equal(permisos.esDocente(c, id()), false);
});

test('puedeGestionar: el admin de LA MISMA escuela sí, el de otra no', () => {
  const escuela = id(), otra = id();
  const c = plano({ owner: id(), school: escuela });

  assert.equal(permisos.puedeGestionar(c, { _id: id(), role: 'admin', school: escuela }), true);
  assert.equal(permisos.puedeGestionar(c, { _id: id(), role: 'admin', school: otra }),    false);
  assert.equal(permisos.puedeGestionar(c, { _id: id(), role: 'admin' }),                  false,
    'un admin sin escuela cargada no puede gestionar nada');
});

test('puedeGestionar: el superadmin llega a todas (no tiene escuela)', () => {
  const c = plano({ owner: id(), school: id() });
  assert.equal(permisos.puedeGestionar(c, { _id: id(), role: 'superadmin' }), true);
});

test('puedeGestionar: el alumno y el preceptor, NO', () => {
  const alumno = id();
  const c = plano({ owner: id(), students: [alumno], school: id() });
  assert.equal(permisos.puedeGestionar(c, { _id: alumno, role: 'student' }), false);
  assert.equal(permisos.puedeGestionar(c, { _id: id(), role: 'preceptor' }), false);
});

test('puedeMirarEnVivo: dirección entra a su escuela, no a otra', () => {
  const escuela = id();
  const c = plano({ owner: id(), school: escuela });
  assert.equal(permisos.puedeMirarEnVivo(c, { _id: id(), role: 'directivo', school: escuela }), true);
  assert.equal(permisos.puedeMirarEnVivo(c, { _id: id(), role: 'directivo', school: id() }),    false);
});

test('⭐ puedeMirarEnVivo: el preceptor SIN alcance no entra (fail-closed)', () => {
  // Nunca vale la convención "vacío = todas". El rol se puede asignar por caminos que no
  // preguntan por divisiones, y en todos ellos el usuario queda sin alcance: si vacío
  // significara "todas", esos caminos entregarían las salas de la escuela entera.
  const division = id();
  const c = plano({ owner: id(), school: id(), division });
  const preceptor = { _id: id(), role: 'preceptor', school: id() };

  assert.equal(permisos.puedeMirarEnVivo(c, preceptor, []),           false);
  assert.equal(permisos.puedeMirarEnVivo(c, preceptor),               false, 'sin el argumento tampoco');
  assert.equal(permisos.puedeMirarEnVivo(c, preceptor, [id()]),       false, 'con otra división, no');
  assert.equal(permisos.puedeMirarEnVivo(c, preceptor, [division]),   true,  'con la suya, sí');
});

test('puedeMirarEnVivo NO alcanza para gestionar', () => {
  // La separación es el punto: mirar una clase no puede abrir la gestión de las 419 materias.
  const escuela = id();
  const c = plano({ owner: id(), school: escuela });
  const directivo = { _id: id(), role: 'directivo', school: escuela };

  assert.equal(permisos.puedeMirarEnVivo(c, directivo), true);
  assert.equal(permisos.puedeGestionar(c, directivo),   false);
});

// ── 2. ⭐ Equivalencia entre la función pura y el método del schema ──────────

test('⭐ la función pura y el método del schema dan lo MISMO', () => {
  // Es lo que permite que las ~60 llamadas que ya existían no se toquen: los métodos ahora
  // delegan acá. Si esto se rompe, se rompen las dos formas de preguntar a la vez.
  const duenio = id(), co = id(), alumno = id(), escuela = id(), division = id();
  const campos = { _id: id(), name: 'M', owner: duenio, coTeachers: [co],
                   students: [alumno], school: escuela, division };

  const doc = Course.hydrate({ ...campos });
  const obj = { ...campos };

  const gente = [
    { _id: duenio, role: 'teacher' },
    { _id: co,     role: 'teacher' },
    { _id: alumno, role: 'student' },
    { _id: id(),   role: 'admin',      school: escuela },
    { _id: id(),   role: 'admin',      school: id() },
    { _id: id(),   role: 'superadmin' },
    { _id: id(),   role: 'directivo',  school: escuela },
    { _id: id(),   role: 'preceptor',  school: escuela },
  ];

  for (const u of gente) {
    assert.equal(doc.canManage(u), permisos.puedeGestionar(obj, u),
      `canManage difiere para ${u.role}`);
    assert.equal(doc.canView(u), permisos.puedeVer(obj, u),
      `canView difiere para ${u.role}`);
    assert.equal(doc.canWatchLive(u, [division]), permisos.puedeMirarEnVivo(obj, u, [division]),
      `canWatchLive difiere para ${u.role}`);
    assert.equal(doc.isTeacher(u._id), permisos.esDocente(obj, u._id),
      `isTeacher difiere para ${u.role}`);
  }
});

// ── 3. ⭐ El curso POPULADO Y PLANO: la forma que se cachea ──────────────────

test('⭐ EL CASO QUE hydrate ROMPÍA: curso populado y plano, la docente gestiona', () => {
  // Esta es EXACTAMENTE la forma que sale de
  //   Course.findById(id).populate('students').populate('division').populate('owner').lean()
  // y que se guarda en el cache: `owner` y `division` son objetos con _id, y `students` es un
  // array de objetos con _id.
  //
  // `Course.hydrate()` sobre esto devolvía `students: undefined`, `owner: null` y
  // `canManage: false` — sin lanzar ningún error. El síntoma habría sido "Acceso denegado en
  // mi propia materia", intermitente según qué worker atendiera.
  const duenio = id(), alumno = id(), escuela = id(), division = id();
  const cacheado = {
    _id: id(), name: 'Ciencias Naturales',
    owner:    { _id: duenio, name: 'PREVITERA, MARIA ELENA' },
    division: { _id: division, name: '3ro 2da' },
    students: [{ _id: alumno, name: 'ABRAHAM GIMENEZ, BIANCA', avatar: null, dni: '12345678' }],
    coTeachers: [], school: escuela,
  };

  assert.equal(permisos.puedeGestionar(cacheado, { _id: duenio, role: 'teacher' }), true,
    'LA DOCENTE TIENE QUE PODER GESTIONAR SU PROPIA SALA');
  assert.equal(permisos.esDocente(cacheado, duenio), true);
  assert.equal(permisos.puedeVer(cacheado, { _id: alumno, role: 'student' }), true,
    'el alumno matriculado la ve, aunque venga como objeto populado y no como id');
  assert.equal(permisos.puedeMirarEnVivo(cacheado, { _id: id(), role: 'preceptor' }, [division]), true,
    'la división populada se compara igual que un id crudo');
  assert.equal(permisos.puedeGestionar(cacheado, { _id: id(), role: 'teacher' }), false,
    'y un docente ajeno sigue sin entrar');
});

test('la misma regla, con los campos CRUDOS (sin populate)', () => {
  // El otro extremo: ids sueltos. Las dos formas conviven en la app según la query, así que la
  // regla tiene que dar lo mismo con las dos.
  const duenio = id(), alumno = id(), division = id();
  const crudo = { _id: id(), owner: duenio, coTeachers: [], students: [alumno],
                  school: id(), division };

  assert.equal(permisos.puedeGestionar(crudo, { _id: duenio, role: 'teacher' }), true);
  assert.equal(permisos.puedeVer(crudo, { _id: alumno, role: 'student' }), true);
  assert.equal(permisos.puedeMirarEnVivo(crudo, { _id: id(), role: 'preceptor' }, [division]), true);
});

// ── 4. El cache ─────────────────────────────────────────────────────────────

test('courseCache guarda, devuelve y se invalida por id', () => {
  const cid = id();
  const curso = plano({ owner: id() });

  courseCache.set(String(cid), curso);
  assert.strictEqual(courseCache.get(String(cid)), curso, 'devuelve el MISMO objeto');

  invalidateCourse(cid);
  assert.equal(courseCache.get(String(cid)), undefined, 'invalidado por ObjectId');

  courseCache.set(String(cid), curso);
  invalidateCourse(String(cid));
  assert.equal(courseCache.get(String(cid)), undefined, 'y por string también');
});

test('invalidateAll también vacía el cache de cursos', () => {
  // Se llama después de restaurar un backup: los _id cacheados pueden ya no existir en la base
  // reemplazada. Si el curso quedara afuera de esa limpieza, la sala serviría datos de la base
  // vieja hasta que expire el TTL.
  const cid = id();
  courseCache.set(String(cid), plano({ owner: id() }));
  invalidateAll();
  assert.equal(courseCache.get(String(cid)), undefined);
});

test('el cache del curso tiene el mismo TTL corto que los otros', () => {
  // 45 s no es un número libre: es por-worker, así que es la ventana en la que un cambio de
  // matrícula puede seguir sirviéndose viejo desde el OTRO worker. Subirlo alarga esa ventana.
  assert.equal(courseCache.ttlMs, 45 * 1000);
});
