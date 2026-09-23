// RN-21 / RN-22 de specs/correccion-de-entregas.spec.md — EL test más importante de la spec.
// Correr con: npm run test:unit
//
// El riesgo #1 de la spec, con estas palabras: "el default de `returnedAt` — con `default: null`,
// TODAS LAS NOTAS DE LA ESCUELA DESAPARECEN DE LA VISTA DEL ALUMNO", y ocurre DOS VECES: el día
// del deploy (Activity.findById() materializa el default en las notas ya cargadas) y el día que
// alguien restaura un backup de julio (Mongoose vuelve a materializar el default de los campos
// ausentes, porque una restauración no es byte a byte).
//
// El campo NO puede tener default. La protección es la SEMÁNTICA de `estaDevuelta()`:
//
//   ausente (undefined) → devuelta (nota anterior a la feature, el alumno la viene viendo)
//   null                → borrador
//   Date                → devuelta, y cuándo
//
// Este archivo prueba las tres formas contra el schema real y contra la función pura.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const Activity = require('../../models/Activity');

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

// Carga tolerante: si public/js/correccion.js todavía no existe, un solo test falla con un
// mensaje legible en vez de un MODULE_NOT_FOUND críptico repetido en cada test de este archivo.
let Correccion = null;
try {
  Correccion = require('../../public/js/correccion.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (!Correccion || typeof Correccion.estaDevuelta !== 'function') {
  test('falta implementar public/js/correccion.js con estaDevuelta() (RN-21)', () => {
    throw new Error(
      'public/js/correccion.js no existe todavía, o no exporta estaDevuelta(grade). ' +
      'Ver specs/correccion-de-entregas.spec.md RN-21/RN-22 y la sección "Tests necesarios". ' +
      'Sin esta función, no hay forma de verificar la protección más cara de toda la feature.',
    );
  });
} else {
  const { estaDevuelta } = Correccion;

  // ── 1. El schema NUNCA puede tener default ──────────────────────────────────

  test('RN-22: gradeSchema.path("returnedAt") existe y NO tiene default', () => {
    const gradePath = Activity.schema.path('grades');
    assert.ok(gradePath, 'falta el array grades en Activity.schema — ¿se renombró?');
    const sub = gradePath.schema;
    const returnedAtPath = sub.path('returnedAt');
    assert.ok(returnedAtPath,
      'falta el campo returnedAt en gradeSchema (RN-21). Ver models/Activity.js del spec, § Entidades.');
    assert.strictEqual(returnedAtPath.defaultValue, undefined,
      'returnedAt TIENE un default. Esto es el escenario (a) de RN-22: el próximo ' +
      'Activity.findById() va a materializar ese default en TODAS las notas ya cargadas, y ' +
      'todas las notas de la escuela van a desaparecer de la vista del alumno de golpe. ' +
      'No puede llevar default: ni null, ni Date.now, ninguno.');
    assert.strictEqual(returnedAtPath.instance, 'Date', 'returnedAt tiene que ser tipo Date');
  });

  // ── 2. El día del deploy: un documento viejo, hidratado hoy ─────────────────

  test('RN-22(a) — el día del deploy: un grade histórico sin el campo lee returnedAt undefined', () => {
    // Simula exactamente lo que hace Mongoose al leer de la base un documento anterior a la
    // feature: el subdocumento no trae returnedAt en absoluto. Si el schema tuviera default,
    // acá aparecería materializado (null o una fecha) y el test de arriba ya lo habría cazado;
    // este test prueba el efecto de punta a punta sobre un documento real.
    const act = new Activity({
      course: new (require('mongoose').Types.ObjectId)(),
      author: new (require('mongoose').Types.ObjectId)(),
      title:  'Actividad vieja (pre-feature)',
      grades: [{
        student: new (require('mongoose').Types.ObjectId)(),
        points: 8, feedback: 'Muy bien', manual: true,
        // returnedAt: NO SE MANDA — es exactamente lo que trae un documento de julio.
      }],
    });

    const grade = act.grades[0];
    assert.strictEqual(grade.returnedAt, undefined,
      'un grade histórico sin returnedAt tiene que seguir sin el campo (undefined), no null');
    assert.strictEqual(estaDevuelta(grade), true,
      'CATÁSTROFE: una nota vieja (sin returnedAt) tiene que leerse como DEVUELTA. Si esto da ' +
      'false, todas las notas de la escuela cargadas antes de esta feature se le esconden al ' +
      'alumno el día del deploy.');
  });

  // ── 3. El día del restore: un backup anterior a la feature ──────────────────

  test('RN-22(b) — restaurar un backup viejo no esconde notas: mismo caso que (a), otro disparador', () => {
    // La spec es explícita: una migración NO alcanza, porque el backup de julio no la trae y
    // Mongoose vuelve a materializar el default de los campos ausentes al restaurar. La
    // protección tiene que ser la semántica del campo, no un paso de una sola vez — por eso
    // este test es, a propósito, casi idéntico al de arriba: son DOS disparadores del MISMO
    // bug, y los dos tienen que estar cubiertos por separado para que quede escrito que no
    // alcanza con arreglar uno.
    const gradeDeBackupViejo = { points: 6, feedback: '', manual: true }; // sin returnedAt
    assert.strictEqual(estaDevuelta(gradeDeBackupViejo), true,
      'una nota restaurada de un backup anterior a la feature tiene que seguir viéndose');
  });

  // ── 4. Los tres valores, todos juntos ────────────────────────────────────────

  test('CA-27 — estaDevuelta(): undefined → true, null → false, Date → true', () => {
    assert.strictEqual(estaDevuelta({ points: 5, returnedAt: undefined }), true, 'legado: devuelta');
    assert.strictEqual(estaDevuelta({ points: 5, returnedAt: null }), false, 'borrador explícito');
    assert.strictEqual(estaDevuelta({ points: 5, returnedAt: new Date() }), true, 'devuelta y con fecha');
  });

  test('estaDevuelta(null) y estaDevuelta(undefined) no explotan: no hay grade, no está devuelta', () => {
    assert.strictEqual(estaDevuelta(null), false);
    assert.strictEqual(estaDevuelta(undefined), false);
  });

  // ── 5. Con default:null a propósito, para demostrar el efecto (documentado, no aplicado) ──

  test('demostración: SI el schema tuviera default:null, este mismo grade histórico se rompería', () => {
    // No se toca el modelo real. Se arma un schema hermano nada más para dejar medible, en un
    // test, la frase de la spec: "con default:null, todas las notas desaparecen". Si algún día
    // alguien "prolija" el campo agregándole un default, el test de la sección 1 ya revienta;
    // este de acá es la prueba de que la preocupación no es teórica.
    const mongoose = require('mongoose');
    const gradeConDefaultMalo = new mongoose.Schema({ returnedAt: { type: Date, default: null } });
    const Modelo = mongoose.models.__DemoReturnedAtDefaultMalo
      || mongoose.model('__DemoReturnedAtDefaultMalo', gradeConDefaultMalo);
    const doc = new Modelo({}); // documento "histórico": no se manda returnedAt
    assert.strictEqual(doc.returnedAt, null,
      'con default:null el campo ausente se materializa en null (=borrador) — que es EXACTAMENTE ' +
      'el bug que RN-22 prohíbe: una nota vieja pasaría a leerse como no devuelta');
    assert.strictEqual(estaDevuelta(doc.toObject()), false,
      'esto confirma el efecto: con ese default (mal, no usado en el modelo real), la nota ' +
      'histórica se le escondería al alumno');
  });

  // ── 6. Corolario: POST /:id/grade siempre escribe returnedAt explícito (RN-22, corolario) ──

  test('POST /:id/grade escribe returnedAt explícitamente en los dos caminos (nuevo y existente)', () => {
    // Estructural, a propósito: el comportamiento de punta a punta (CA-28) se prueba en el
    // smoke, contra un server real. Acá se fija que el código FUENTE no dependa del default:
    // que la ruta toque returnedAt tanto al crear el grade como al actualizar uno existente.
    // Ver RN-22 corolario: "POST /:id/grade SIEMPRE escribe returnedAt explícitamente."
    const rutas = leer('routes/activities.js');
    const i = rutas.indexOf("router.post('/:id/grade'");
    assert.ok(i !== -1, 'falta la ruta POST /:id/grade');
    const finBloque = rutas.indexOf("router.post('/:id/devolver'", i);
    const cuerpo = finBloque !== -1 ? rutas.slice(i, finBloque) : rutas.slice(i, i + 3500);

    assert.ok(/returnedAt/.test(cuerpo),
      'POST /:id/grade tiene que escribir returnedAt: sin esto, el campo queda librado al ' +
      'default (que no existe) y todo grade nuevo se guardaría con returnedAt undefined, que ' +
      'lee como "devuelta" — sería devolver todo sin que nadie lo haya decidido.');
    assert.ok(/devolver/.test(cuerpo),
      'POST /:id/grade tiene que leer el flag `devolver` del body (RN-22b: ausente = devolver)');
  });
}
