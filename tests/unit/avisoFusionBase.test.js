// Tests de lo que el aviso de fusión ESCRIBE en la base (Fase 1b de specs/fusion-de-cuentas.spec.md).
// Correr con: npm run test:unit
//
// ── POR QUÉ ESTE ARCHIVO SÍ TOCA MONGO ─────────────────────────────────────────────────
// Lo que hay que probar es justo lo que no se ve con objetos: que la marca `mergedInto` caiga en
// el MISMO update que apaga la cuenta, que se cree un solo mensaje por grupo, y que apretar el
// botón dos veces no mande dos avisos.
//
// ⚠️ Y el botón masivo NO se puede probar con el smoke: `aplicar()` recorre TODOS los grupos de
// la base, así que contra el espejo local le deshabilitaría cuentas reales y les mandaría
// mensajes. Por eso usa una BASE APARTE (classroom-test-fusion) que se vacía antes de cada test
// y se borra al terminar — mismo patrón que tests/unit/cupoReservas.test.js.
//
// Cubre CA-04b.1 a CA-04b.6. El login (CA-04c) va por el smoke, que lo prueba por HTTP.

const test     = require('node:test');
const assert   = require('node:assert');
const mongoose = require('mongoose');

const User             = require('../../models/User');
const Message          = require('../../models/Message');
const MessageRecipient = require('../../models/MessageRecipient');
const Submission       = require('../../models/Submission');
const { getFix }       = require('../../services/dbFixes');

const URI = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/classroom-test-fusion';

const { ObjectId } = mongoose.Types;
const ESCUELA = new ObjectId();
let actorId;

test.before(async () => {
  await mongoose.connect(URI);
  await MessageRecipient.init();   // el índice único { message, user } es parte de lo que se prueba
});

test.after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test.beforeEach(async () => {
  // Cada test arma SOLO sus grupos: aplicar() es masivo, y un grupo sembrado por otro test lo
  // resolvería también y ensuciaría los conteos.
  await Promise.all([
    User.collection.deleteMany({}),
    Message.collection.deleteMany({}),
    MessageRecipient.collection.deleteMany({}),
    Submission.collection.deleteMany({}),
    // Acá y no al final de cada test: un test que falla a mitad de camino no llega a su limpieza,
    // y la materia que deja choca contra el índice único de `code` en el siguiente.
    mongoose.connection.collection('courses').deleteMany({}),
  ]);
  actorId = (await User.collection.insertOne({
    name: 'Superadmin de prueba', email: 'super@prueba.local', password: 'x',
    role: 'superadmin', school: null, active: true, createdAt: new Date('2025-01-01'),
  })).insertedId;
});

// ── Siembra ────────────────────────────────────────────────────────────────────
// Directo a la colección: acá no se prueba el alta, y el DNI repetido no entraría por la ruta.

let serie = 0;
async function cuenta({ role = 'student', dni, email, usada = false, conTrabajo = false, school = ESCUELA, activa = true }) {
  serie++;
  const { insertedId } = await User.collection.insertOne({
    name: `Cuenta ${serie}`, email, password: 'x', role, school, dni, active: activa,
    lastSeen: usada ? new Date('2026-08-17T12:00:00Z') : null,
    createdAt: new Date(2025, 0, serie),
  });
  if (conTrabajo) {
    // Una entrega alcanza para que services/fusionCuentas.js la trate como "la real".
    await Submission.collection.insertOne({
      student: insertedId, activity: new ObjectId(),
      name: 'tp.pdf', filename: 'tp.pdf', storagePath: 'x',
    });
  }
  return insertedId;
}

// Un par de alumnos: `real` con trabajo, `vacia` sin nada. `usada` dice si alguien entró a la vacía.
async function par(dni, { usada, school = ESCUELA } = {}) {
  const real  = await cuenta({ dni, email: `real.${dni}@gmail.com`, conTrabajo: true, school });
  const vacia = await cuenta({ dni, email: `padron.${dni}@familia.com`, usada, school });
  return { real, vacia, correoReal: `real.${dni}@gmail.com`, correoVacia: `padron.${dni}@familia.com` };
}

const fixAlumnos  = () => getFix('dni-duplicado-en-curso');
const fixDocentes = () => getFix('docentes-dni-duplicado');
const leer = (id) => User.findById(id).lean();
const mensajesPara = (id) => MessageRecipient.find({ user: id }).lean();

// ── CA-04b.1 ─────────────────────────────────────────────────────────────────

test('CA-04b.1: un grupo con la cuenta vacía USADA ya no espera: el botón lo resuelve', async () => {
  const p = await par('40111222', { usada: true });

  const antes = await fixAlumnos().diagnosticar();
  const tarjeta = antes.grupos.find(g => g.dni === '40111222');
  assert.ok(tarjeta, 'el grupo debería aparecer en el diagnóstico');
  assert.notStrictEqual(tarjeta.motivo, 'necesita-aviso',
    'con el aviso implementado, AVISO_DE_FUSION_LISTO tiene que estar prendido');
  assert.strictEqual(tarjeta.resolubleSola, true);

  await fixAlumnos().aplicar({}, { actorId });

  const vacia = await leer(p.vacia);
  assert.strictEqual(vacia.active, false, 'la vacía queda deshabilitada');
  assert.strictEqual(String(vacia.mergedInto), String(p.real), 'y marcada con a qué cuenta se unificó');
  assert.ok(vacia.mergedAt instanceof Date, 'con la fecha de la unificación');

  const real = await leer(p.real);
  assert.notStrictEqual(real.active, false, 'la real sigue activa');
  assert.ok(!real.mergedInto, 'y no lleva marca');
});

test('CA-04b.1 (RN-15): la cuenta vacía NUNCA usada también queda marcada', async () => {
  // La marca no depende de si hubo aviso: es la que le permite al login explicar qué pasó.
  const p = await par('40333444', { usada: false });
  await fixAlumnos().aplicar({}, { actorId });
  const vacia = await leer(p.vacia);
  assert.strictEqual(vacia.active, false);
  assert.strictEqual(String(vacia.mergedInto), String(p.real));
});

// ── CA-04b.2 y CA-04b.3 ──────────────────────────────────────────────────────

test('CA-04b.2: un mensaje por grupo con cuenta usada, dirigido solo a la conservada', async () => {
  const usada  = await par('40111222', { usada: true });
  const nunca  = await par('40333444', { usada: false });

  await fixAlumnos().aplicar({}, { actorId });

  assert.strictEqual(await Message.countDocuments(), 1, 'un solo envío: el del grupo con la cuenta usada');
  const m = await Message.findOne().lean();
  assert.strictEqual(String(m.sender), String(actorId), 'el remitente es quien apretó el botón');
  assert.strictEqual(m.allowReplies, true, 'aprobado: se puede responder');
  assert.strictEqual(m.recipientCount, 1);
  assert.deepStrictEqual(m.audience.userIds.map(String), [String(usada.real)]);

  const filas = await mensajesPara(usada.real);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].roleAtSend, 'student');
  assert.strictEqual(String(filas[0].schoolAtSend), String(ESCUELA));
  assert.strictEqual(filas[0].readAt, null, 'llega sin leer: es lo que prende el sobre');

  assert.strictEqual((await mensajesPara(usada.vacia)).length, 0, 'la apagada no recibe nada: no puede entrar a leerlo');
  assert.strictEqual((await mensajesPara(nunca.real)).length, 0, 'nadie usó la vacía: no hay a quién avisarle');
});

test('CA-04b.2 (grupo de 3): una sobrante usada que YA estaba apagada no hace mandar un aviso', async () => {
  // Hallado por la revisión del 2026-09-17. El botón apaga solo la del padrón (nadie la usó), y
  // el aviso salía igual, nombrando como "deshabilitada" a la que ya estaba apagada de antes.
  const real       = await cuenta({ dni: '42111222', email: 'real.42111222@gmail.com', conTrabajo: true });
  const yaApagada  = await cuenta({ dni: '42111222', email: 'vieja.42111222@hotmail.com', usada: true, activa: false });
  const padron     = await cuenta({ dni: '42111222', email: 'padron.42111222@familia.com' });

  await fixAlumnos().aplicar({}, { actorId });

  assert.strictEqual(await Message.countDocuments(), 0, 'nadie usó la cuenta que se apagó: no hay aviso');
  const apagadaAhora = await leer(padron);
  assert.strictEqual(apagadaAhora.active, false);
  assert.strictEqual(String(apagadaAhora.mergedInto), String(real));
  assert.ok(!(await leer(yaApagada)).mergedInto, 'la que ya estaba apagada no la tocó este botón');
});

test('CA-04b.3: el mensaje nombra el correo con el que entrar y el de la cuenta apagada', async () => {
  const p = await par('40111222', { usada: true });
  await fixAlumnos().aplicar({}, { actorId });
  const m = await Message.findOne().lean();
  assert.strictEqual(m.subject, 'Tus dos cuentas quedaron unificadas');
  assert.ok(m.body.includes(p.correoReal), `falta ${p.correoReal} — dice: ${m.body}`);
  assert.ok(m.body.includes(p.correoVacia), `falta ${p.correoVacia} — dice: ${m.body}`);
});

// ── CA-04b.4 ─────────────────────────────────────────────────────────────────

test('CA-04b.4: aplicar dos veces no deshabilita de nuevo ni manda un segundo aviso', async () => {
  await par('40111222', { usada: true });
  const primera = await fixAlumnos().aplicar({}, { actorId });
  assert.strictEqual(primera.afectados, 1);

  const segunda = await fixAlumnos().aplicar({}, { actorId });
  assert.strictEqual(segunda.afectados, 0);
  assert.strictEqual(await Message.countDocuments(), 1, 'el chico no puede recibir el aviso dos veces');
  assert.strictEqual(await MessageRecipient.countDocuments(), 1);
});

// ── CA-04b.6 ─────────────────────────────────────────────────────────────────

test('CA-04b.6: el resultado del botón dice cuántos avisos salieron', async () => {
  await par('40111222', { usada: true });
  await par('40333444', { usada: false });
  const r = await fixAlumnos().aplicar({}, { actorId });
  assert.strictEqual(r.afectados, 2);
  assert.strictEqual(r.meta.avisos_enviados, 1);
  assert.strictEqual(r.meta.avisos_fallidos, 0);
  assert.match(r.mensaje, /aviso/i, `el cartel debería mencionar el aviso — dice: ${r.mensaje}`);
});

test('CA-04b.6: si el mensaje falla, la cuenta queda apagada y marcada igual, y se informa', async () => {
  // Orden de RN-16: primero apagar y marcar, después avisar. Al revés, un fallo dejaría un
  // mensaje que dice algo que no pasó. Con este orden, el muro del login cubre el hueco.
  const p = await par('40111222', { usada: true });
  const original = Message.create;
  Message.create = async () => { throw new Error('se cayó la base justo acá'); };
  let r;
  try {
    r = await fixAlumnos().aplicar({}, { actorId });
  } finally {
    Message.create = original;
  }

  const vacia = await leer(p.vacia);
  assert.strictEqual(vacia.active, false);
  assert.strictEqual(String(vacia.mergedInto), String(p.real));
  assert.strictEqual(r.meta.avisos_enviados, 0);
  assert.strictEqual(r.meta.avisos_fallidos, 1);
  assert.match(r.mensaje, /no se pudo/i, `el cartel tiene que decir que un aviso no salió — dice: ${r.mensaje}`);
  assert.strictEqual(await MessageRecipient.countDocuments(), 0, 'sin mensaje no queda una fila de bandeja suelta');
});

test('sin saber quién aplica, no se apaga ninguna cuenta usada', async () => {
  // Message.sender es obligatorio: sin actor no hay aviso posible, y RN-13 dice que una cuenta
  // usada no se apaga en silencio. Se frena ANTES de tocar nada.
  const p = await par('40111222', { usada: true });
  await assert.rejects(() => fixAlumnos().aplicar({}, {}));
  assert.notStrictEqual((await leer(p.vacia)).active, false);
});

// ── CA-04b.5 — la fusión caso por caso ───────────────────────────────────────

const grupoDe = async (fix, dni) => (await fix.diagnosticar()).grupos.find(g => g.dni === dni);

test('CA-04b.5: fusionar alumnos con "deshabilitar" marca y avisa', async () => {
  const p = await par('40555666', { usada: true });
  const g = await grupoDe(fixAlumnos(), '40555666');

  await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'deshabilitar', actorId });

  const vacia = await leer(p.vacia);
  assert.strictEqual(vacia.active, false);
  assert.strictEqual(String(vacia.mergedInto), String(p.real));
  const filas = await mensajesPara(p.real);
  assert.strictEqual(filas.length, 1, 'la conservada recibe el aviso');
});

test('CA-04b.5: con intercambio de correo, el aviso y la marca usan el correo FINAL', async () => {
  // La conservada se queda con el correo de la otra (emailId). El chico tiene que leer el
  // correo con el que entra DESPUÉS del intercambio, no el que tenía al empezar.
  const p = await par('40777888', { usada: true });
  const g = await grupoDe(fixAlumnos(), '40777888');

  await fixAlumnos().fusionar({
    clave: g.clave, keepId: String(p.real), emailId: String(p.vacia), sobrante: 'deshabilitar', actorId,
  });

  const real  = await leer(p.real);
  const vacia = await leer(p.vacia);
  assert.strictEqual(real.email, p.correoVacia, 'precondición: se intercambiaron los correos');
  assert.strictEqual(vacia.email, p.correoReal);

  const m = await Message.findOne().lean();
  const conQueEntra = m.body.indexOf(p.correoVacia);
  const laApagada   = m.body.indexOf(p.correoReal);
  assert.ok(conQueEntra >= 0, `debería decir que entra con ${p.correoVacia} — dice: ${m.body}`);
  assert.ok(laApagada > conQueEntra, 'y nombrar después a la apagada con el correo que le quedó');
});

test('CA-04b.5: "sacar" no marca (la cuenta sigue activa) y no avisa', async () => {
  const p = await par('40999000', { usada: true });
  const g = await grupoDe(fixAlumnos(), '40999000');
  await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'sacar', actorId });
  const vacia = await leer(p.vacia);
  assert.notStrictEqual(vacia.active, false);
  assert.ok(!vacia.mergedInto);
  assert.strictEqual(await Message.countDocuments(), 0);
});

test('CA-04b.5: "eliminar" no deja marca (no queda cuenta que explicar)', async () => {
  const p = await par('41222333', { usada: true });
  const g = await grupoDe(fixAlumnos(), '41222333');
  await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'eliminar', actorId });
  assert.strictEqual(await leer(p.vacia), null, 'la vacía no tenía nada y se eliminó: no hay documento donde marcar');
  assert.strictEqual(await User.countDocuments({ mergedInto: p.real }), 0);
});

test('CA-04b.5: una fusión que apaga una cuenta usada sin saber quién la hizo se frena antes de mover nada', async () => {
  const p = await par('41444555', { usada: true });
  const g = await grupoDe(fixAlumnos(), '41444555');
  await assert.rejects(() => fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'deshabilitar' }));
  assert.notStrictEqual((await leer(p.vacia)).active, false);
});

test('CA-04b.5: fusionar docentes con "deshabilitar" marca y avisa', async () => {
  const titular  = await cuenta({ role: 'teacher', dni: '20111222', email: 'docente.inst@escuela.edu.ar' });
  const personal = await cuenta({ role: 'teacher', dni: '20111222', email: 'docente.personal@gmail.com', usada: true });
  const g = await grupoDe(fixDocentes(), '20111222');
  assert.ok(g, 'el grupo de docentes debería aparecer');

  await fixDocentes().fusionar({ clave: g.clave, keepId: String(titular), sobrante: 'deshabilitar', actorId });

  const apagada = await leer(personal);
  assert.strictEqual(apagada.active, false);
  assert.strictEqual(String(apagada.mergedInto), String(titular));
  const filas = await mensajesPara(titular);
  assert.strictEqual(filas.length, 1);
  assert.strictEqual(filas[0].roleAtSend, 'teacher');
  const m = await Message.findById(filas[0].message).lean();
  assert.ok(m.body.includes('docente.inst@escuela.edu.ar') && m.body.includes('docente.personal@gmail.com'));
});

// Segunda pasada de la revisión (2026-09-17): la regla "el aviso es por las cuentas que ESTA acción
// apaga" se había aplicado al botón masivo y no a la fusión caso por caso. Con una sobrante que
// ya estaba apagada, que alguien usó y que todavía figura en materias (el grupo NO está resuelto:
// sale como "sobrante cursando"), fusionarla mandaba "La otra (…) quedó deshabilitada" por algo
// que esta acción no hizo. La marca sí se escribe: la fusión la une a la conservada, y así su
// login explica qué pasó.

test('CA-04b.5: fusionar alumnos no avisa por una sobrante que YA estaba apagada, pero la marca', async () => {
  const real  = await cuenta({ dni: '45111222', email: 'real.45111222@gmail.com', conTrabajo: true });
  const vieja = await cuenta({ dni: '45111222', email: 'vieja.45111222@hotmail.com', usada: true, activa: false });
  await mongoose.connection.collection('courses').insertOne({ name: 'Materia de prueba', code: 'PRUEBA-A', school: ESCUELA, students: [vieja] });
  const g = await grupoDe(fixAlumnos(), '45111222');
  assert.ok(g, 'precondición: la apagada todavía cursa, así que el grupo no figura como resuelto');

  await fixAlumnos().fusionar({ clave: g.clave, keepId: String(real), sobrante: 'deshabilitar', actorId });

  assert.strictEqual(await Message.countDocuments(), 0, 'esta fusión no apagó a nadie que se estuviera usando');
  const doc = await leer(vieja);
  assert.strictEqual(doc.active, false);
  assert.strictEqual(String(doc.mergedInto), String(real), 'queda unida a la conservada: el login lo explica');
});

test('CA-04b.5: fusionar docentes no avisa por una sobrante que YA estaba apagada, pero la marca', async () => {
  const titular = await cuenta({ role: 'teacher', dni: '22111222', email: 'nueva.inst@escuela.edu.ar' });
  const vieja   = await cuenta({ role: 'teacher', dni: '22111222', email: 'vieja.personal@gmail.com', usada: true, activa: false });
  // Apagada pero todavía titular de una materia: por eso el grupo sigue apareciendo.
  await mongoose.connection.collection('courses').insertOne({ name: 'Materia de prueba', code: 'PRUEBA-D', school: ESCUELA, owner: vieja, students: [] });
  const g = await grupoDe(fixDocentes(), '22111222');
  assert.ok(g, 'precondición: el grupo de docentes aparece');

  await fixDocentes().fusionar({ clave: g.clave, keepId: String(titular), sobrante: 'deshabilitar', actorId });

  assert.strictEqual(await Message.countDocuments(), 0);
  assert.strictEqual(String((await leer(vieja)).mergedInto), String(titular));
});

test('CA-04b.5: fusionar docentes con "eliminar" no deja marca', async () => {
  const titular  = await cuenta({ role: 'teacher', dni: '20333444', email: 'otro.inst@escuela.edu.ar' });
  const personal = await cuenta({ role: 'teacher', dni: '20333444', email: 'otro.personal@gmail.com', usada: true });
  const g = await grupoDe(fixDocentes(), '20333444');
  await fixDocentes().fusionar({ clave: g.clave, keepId: String(titular), sobrante: 'eliminar', actorId });
  assert.strictEqual(await leer(personal), null, 'la sobrante no tenía entregas: se eliminó');
  assert.strictEqual(await User.countDocuments({ mergedInto: titular }), 0);
  assert.strictEqual(await Message.countDocuments(), 0, 'no queda cuenta apagada que explicar');
});

test('CA-04b.5: fusionar docentes con intercambio de correo avisa con los correos FINALES', async () => {
  const titular  = await cuenta({ role: 'teacher', dni: '20555666', email: 'titular.inst@escuela.edu.ar' });
  const personal = await cuenta({ role: 'teacher', dni: '20555666', email: 'titular.personal@gmail.com', usada: true });
  const g = await grupoDe(fixDocentes(), '20555666');

  await fixDocentes().fusionar({
    clave: g.clave, keepId: String(titular), emailId: String(personal), sobrante: 'deshabilitar', actorId,
  });

  assert.strictEqual((await leer(titular)).email, 'titular.personal@gmail.com', 'precondición: se intercambiaron');
  const apagada = await leer(personal);
  assert.strictEqual(apagada.email, 'titular.inst@escuela.edu.ar');
  assert.strictEqual(String(apagada.mergedInto), String(titular));

  const m = await Message.findOne().lean();
  const conQueEntra = m.body.indexOf('titular.personal@gmail.com');
  const laApagada   = m.body.indexOf('titular.inst@escuela.edu.ar');
  assert.ok(conQueEntra >= 0 && laApagada > conQueEntra, `dice: ${m.body}`);
});

// ── RN-09 — la tarjeta avisa ANTES de apretar que va a salir un mensaje ───────
// Sugerencia de la revisión del 2026-09-17: el botón masivo ya lo anticipaba, la fusión caso por
// caso mandaba un mensaje a nombre del superadmin sin haberlo dicho.

test('RN-09: la tarjeta de alumnos anticipa el mensaje si alguna cuenta del grupo se usó', async () => {
  await par('44111222', { usada: true });
  await par('44333444', { usada: false });
  // Sin ningún uso registrado en el grupo no hay a quién avisarle: la tarjeta no lo menciona.
  await User.collection.updateMany({ dni: '44333444' }, { $set: { lastSeen: null } });

  const { grupos } = await fixAlumnos().diagnosticar();
  const conUso = grupos.find(g => g.dni === '44111222');
  const sinUso = grupos.find(g => g.dni === '44333444');
  assert.match(conUso.ayuda, /recibe un mensaje tuyo/, `dice: ${conUso.ayuda}`);
  assert.ok(!/mensaje/.test(sinUso.ayuda), `dice: ${sinUso.ayuda}`);
});

test('RN-09: la tarjeta de docentes anticipa el mensaje si alguna cuenta del grupo se usó', async () => {
  await cuenta({ role: 'teacher', dni: '21111222', email: 'uno@escuela.edu.ar' });
  await cuenta({ role: 'teacher', dni: '21111222', email: 'uno@gmail.com', usada: true });
  const { grupos } = await fixDocentes().diagnosticar();
  const g = grupos.find(x => x.dni === '21111222');
  assert.match(g.ayuda, /recibe un mensaje tuyo/, `dice: ${g.ayuda}`);
});

test('RN-09: la tarjeta de docentes no menciona el mensaje si ninguna cuenta se usó', async () => {
  await cuenta({ role: 'teacher', dni: '21333444', email: 'dos@escuela.edu.ar' });
  await cuenta({ role: 'teacher', dni: '21333444', email: 'dos@gmail.com' });
  const { grupos } = await fixDocentes().diagnosticar();
  const g = grupos.find(x => x.dni === '21333444');
  assert.ok(!/mensaje/.test(g.ayuda), `dice: ${g.ayuda}`);
});

// ── CA-04b.6 — lo que queda escrito de una fusión caso por caso ───────────────
// routes/dbFixes.js vuelca `r.auditoria` entero en el evento `user.merge`: probar `auditoria` es
// probar lo que queda en la auditoría.

test('CA-04b.6: la fusión caso por caso deja "aviso: enviado" y lo dice en el cartel', async () => {
  const p = await par('43111222', { usada: true });
  const g = await grupoDe(fixAlumnos(), '43111222');
  const r = await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'deshabilitar', actorId });
  assert.strictEqual(r.auditoria.aviso, 'enviado');
  assert.match(r.mensaje, /recibió un mensaje/, `dice: ${r.mensaje}`);
});

test('CA-04b.6: si el aviso de una fusión caso por caso falla, queda "aviso: fallido" y la cuenta apagada igual', async () => {
  const p = await par('43333444', { usada: true });
  const g = await grupoDe(fixAlumnos(), '43333444');
  const original = Message.create;
  Message.create = async () => { throw new Error('se cayó la base justo acá'); };
  let r;
  try {
    r = await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'deshabilitar', actorId });
  } finally {
    Message.create = original;
  }
  assert.strictEqual(r.auditoria.aviso, 'fallido');
  assert.match(r.mensaje, /NO se pudo/, `dice: ${r.mensaje}`);
  const vacia = await leer(p.vacia);
  assert.strictEqual(vacia.active, false);
  assert.strictEqual(String(vacia.mergedInto), String(p.real));
});

test('CA-04b.6: una fusión que no apaga nada usado no menciona ningún aviso', async () => {
  const p = await par('43555666', { usada: false });
  const g = await grupoDe(fixAlumnos(), '43555666');
  const r = await fixAlumnos().fusionar({ clave: g.clave, keepId: String(p.real), sobrante: 'deshabilitar', actorId });
  assert.ok(!('aviso' in r.auditoria));
  assert.ok(!/aviso|mensaje/i.test(r.mensaje.replace(/mensaje\(s\) de sala|mensaje\(s\) en su bandeja/g, '')),
    `dice: ${r.mensaje}`);
});
