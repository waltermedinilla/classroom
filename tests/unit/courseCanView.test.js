// Tests de Course.canView() — la regla de "¿puede VER esta materia?".
// Correr con: npm run test:unit
//
// Por qué existe este archivo. La pregunta estaba respondida por separado en tres lugares y
// DOS se la habían olvidado: la pantalla del curso devolvía 403 al que no pertenece, pero
// `GET /courses/:id/data` y `GET /announcements/course/:id` solo pedían estar logueado.
// Verificado el 2026-08-30 contra la base real: un alumno de una materia podía leer el
// listado completo de otra —docente y 33 alumnos, con nombre y CORREO— pidiendo la URL a
// mano, y así con las 578 materias de la escuela.
//
// El arreglo no fue repetir el chequeo una tercera vez sino mudarlo al modelo. Estos tests
// fijan la regla ahí, que es donde ahora la leen los tres endpoints.

const test   = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const Course = require('../../models/Course');

const id = () => new mongoose.Types.ObjectId();

// Arma un curso SIN tocar la base: hydrate crea un documento con los métodos del esquema.
function curso({ owner, coTeachers = [], students = [], school = null }) {
  return Course.hydrate({
    _id: id(), name: 'Materia', owner, coTeachers, students, school,
  });
}

test('el docente dueño puede ver su materia', () => {
  const docente = id();
  assert.strictEqual(curso({ owner: docente }).canView({ _id: docente, role: 'teacher' }), true);
});

test('el co-docente puede ver la materia', () => {
  const co = id();
  const c = curso({ owner: id(), coTeachers: [co] });
  assert.strictEqual(c.canView({ _id: co, role: 'teacher' }), true);
});

test('el alumno matriculado puede ver la materia', () => {
  const alumno = id();
  const c = curso({ owner: id(), students: [alumno] });
  assert.strictEqual(c.canView({ _id: alumno, role: 'student' }), true);
});

test('⭐ un alumno de OTRA materia NO puede verla', () => {
  // El caso exacto de la fuga: un alumno cualquiera pidiendo una materia ajena.
  const c = curso({ owner: id(), students: [id(), id()] });
  assert.strictEqual(c.canView({ _id: id(), role: 'student' }), false);
});

test('⭐ un docente NO puede ver la materia de otro docente', () => {
  const c = curso({ owner: id(), students: [id()] });
  assert.strictEqual(c.canView({ _id: id(), role: 'teacher' }), false);
});

test('funciona con students POPULADO, no solo con ids crudos', () => {
  // Las rutas traen el curso con .populate('students'), así que los elementos son
  // documentos y no ObjectIds. Si canView solo supiera comparar ids crudos, rechazaría
  // al alumno que SÍ pertenece — un fallo mucho peor que el que vino a arreglar.
  //
  // Acá el método se invoca sobre un objeto plano en vez de con hydrate(): hydrate castea
  // el array contra el esquema (`[ObjectId]`) y con documentos populados lo descarta
  // entero, dejando `students` en undefined. Eso es una limitación de cómo se FABRICA el
  // caso de prueba, no del código: en una ruta real el populate devuelve documentos de
  // verdad. Llamando al método directo se prueba exactamente esa forma.
  const alumno = id();
  const populado = {
    students: [{ _id: alumno, name: 'Ana', email: 'a@a.com' }],
    canManage: () => false,
  };
  assert.strictEqual(Course.prototype.canView.call(populado, { _id: alumno, role: 'student' }), true);
  assert.strictEqual(Course.prototype.canView.call(populado, { _id: id(), role: 'student' }), false);
});

test('el superadmin ve cualquier materia', () => {
  assert.strictEqual(curso({ owner: id() }).canView({ _id: id(), role: 'superadmin' }), true);
});

test('el admin ve las materias de SU escuela, no las de otra', () => {
  const escuela = id();
  const propia = curso({ owner: id(), school: escuela });
  const ajena  = curso({ owner: id(), school: id() });
  assert.strictEqual(propia.canView({ _id: id(), role: 'admin', school: escuela }), true);
  assert.strictEqual(ajena.canView({ _id: id(), role: 'admin', school: escuela }), false);
});

test('sin usuario, no se ve nada', () => {
  const c = curso({ owner: id(), students: [id()] });
  assert.strictEqual(c.canView(null), false);
  assert.strictEqual(c.canView(undefined), false);
});

test('una materia sin alumnos no rompe', () => {
  // students ausente (no solo vacío): pasa cuando la query no lo trae en el select.
  const c = Course.hydrate({ _id: id(), name: 'X', owner: id() });
  assert.strictEqual(c.canView({ _id: id(), role: 'student' }), false);
});
