// Tests de los TEXTOS del aviso de fusión de cuentas (services/avisoFusion.js).
// Correr con: npm run test:unit
//
// Qué se protege. Cuando una fusión apaga una cuenta que alguien usó, la persona se entera por
// dos lados (RN-16 y RN-17 de specs/fusion-de-cuentas.spec.md): un mensaje en la cuenta que se
// conserva, y un muro en el login de la que se apagó. Este archivo prueba lo que esos dos
// lados DICEN, sin base de datos. Lo que se escribe en Mongo lo prueba
// tests/unit/avisoFusionBase.test.js, y el login de punta a punta el smoke.
//
// El caso real detrás: el 2026-08-31 una docente no podía entrar después de un reseteo de
// contraseña, y las dos pantallas contestaban que todo había salido bien. Eran dos cuentas con
// el mismo DNI. El muro existe para que eso no se repita con los chicos cuya cuenta se apaga.

const test   = require('node:test');
const assert = require('node:assert');

const {
  enmascararCorreo,
  textoLoginDeshabilitada,
  mensajeDeFusion,
  TEXTO_DESHABILITADA,
} = require('../../services/avisoFusion');

// ── CA-04c.5 — el enmascarado ─────────────────────────────────────────────────

test('CA-04c.5: deja la primera letra y el dominio entero', () => {
  assert.strictEqual(enmascararCorreo('lautaro.g@gmail.com'), 'l••••@gmail.com');
  // El dominio va completo a propósito: es lo que distingue "mi gmail" de "la institucional".
  assert.strictEqual(enmascararCorreo('ana@escuelasanjose.edu.ar'), 'a••••@escuelasanjose.edu.ar');
});

test('CA-04c.5: la cantidad de puntos no delata el largo del usuario', () => {
  assert.strictEqual(enmascararCorreo('ab@x.com'), 'a••••@x.com');
  assert.strictEqual(enmascararCorreo('abcdefghijk@x.com'), 'a••••@x.com');
});

test('CA-04c.5: un usuario de una sola letra no se revela entero', () => {
  const r = enmascararCorreo('z@gmail.com');
  assert.strictEqual(r, '••••@gmail.com');
  assert.ok(!r.includes('z'), 'con "primera letra + ••••" una cuenta de una letra quedaría a la vista');
});

test('CA-04c.5: un valor sin @ o vacío no rompe', () => {
  assert.strictEqual(enmascararCorreo('sin-arroba'), '••••');
  assert.strictEqual(enmascararCorreo(''), '••••');
  assert.strictEqual(enmascararCorreo(null), '••••');
  assert.strictEqual(enmascararCorreo(undefined), '••••');
});

test('CA-04c.5: normaliza mayúsculas y espacios como el login', () => {
  // El índice de email es lowercase: " Lautaro@Gmail.com " es el mismo correo.
  assert.strictEqual(enmascararCorreo(' Lautaro@Gmail.com '), 'l••••@gmail.com');
});

// ── CA-04c.1 y CA-04c.3 — qué dice el login de una cuenta deshabilitada ─────

test('el texto genérico es el de siempre, palabra por palabra', () => {
  // Es el que ven hoy todas las cuentas deshabilitadas que NO vienen de una fusión. Cambiarlo
  // de paso sería un cambio que nadie pidió.
  assert.strictEqual(TEXTO_DESHABILITADA, 'Tu cuenta está deshabilitada. Contactá al administrador.');
});

test('CA-04c.1: con la conservada activa dice que se unificó y con qué correo entrar', () => {
  const t = textoLoginDeshabilitada({ email: 'lautaro.g@gmail.com', active: true });
  assert.match(t, /se unificó/);
  assert.match(t, /mismo DNI/);
  assert.ok(t.includes('l••••@gmail.com'), `debería traer el correo enmascarado — dice: ${t}`);
});

test('CA-04c.1: NUNCA trae el correo completo de la conservada', () => {
  const t = textoLoginDeshabilitada({ email: 'lautaro.g@gmail.com', active: true });
  assert.ok(!t.includes('lautaro.g@gmail.com'), 'el muro lo ve cualquiera que acierte la contraseña');
  assert.ok(!t.includes('lautaro'), 'ni siquiera el usuario sin el dominio');
});

test('CA-04c.3: sin cuenta conservada, el texto genérico', () => {
  // Cuenta deshabilitada a mano (sin marca), o marca que apunta a una cuenta que ya no existe.
  assert.strictEqual(textoLoginDeshabilitada(null), TEXTO_DESHABILITADA);
  assert.strictEqual(textoLoginDeshabilitada(undefined), TEXTO_DESHABILITADA);
});

test('CA-04c.3: con la conservada TAMBIÉN deshabilitada, el texto genérico', () => {
  // Mandarlo a una cuenta que tampoco lo deja entrar es peor que no decirle nada.
  assert.strictEqual(textoLoginDeshabilitada({ email: 'x@gmail.com', active: false }), TEXTO_DESHABILITADA);
});

test('CA-04c.3: una conservada sin correo no genera un muro con "••••" suelto', () => {
  assert.strictEqual(textoLoginDeshabilitada({ email: '', active: true }), TEXTO_DESHABILITADA);
});

test('una conservada sin el campo active cuenta como activa (así se lee en todo el proyecto)', () => {
  // `active` tiene default true, y las cuentas viejas pueden no tenerlo escrito: el resto del
  // código compara `active === false`, nunca `active === true`.
  assert.match(textoLoginDeshabilitada({ email: 'x@gmail.com' }), /se unificó/);
});

// ── CA-04b.3 — el mensaje a la cuenta que se conserva ─────────────────────────

const MENSAJE = mensajeDeFusion({
  correoConservada: 'lautaro.g@gmail.com',
  correoApagada:    'lautaro.gonzalez@escuelasanjose.edu.ar',
});

test('CA-04b.3: el asunto es el aprobado', () => {
  assert.strictEqual(MENSAJE.subject, 'Tus dos cuentas quedaron unificadas');
});

test('CA-04b.3: el cuerpo nombra los DOS correos completos', () => {
  // Acá sí van completos: lo lee el dueño, ya logueado en su cuenta.
  assert.ok(MENSAJE.body.includes('lautaro.g@gmail.com'), 'falta el correo con el que entra');
  assert.ok(MENSAJE.body.includes('lautaro.gonzalez@escuelasanjose.edu.ar'), 'falta el de la cuenta apagada');
});

test('CA-04b.3: dice con cuál entrar ANTES de nombrar la que se apagó', () => {
  // Si el chico lee una sola línea, que sea la que le dice qué hacer.
  const i = MENSAJE.body.indexOf('lautaro.g@gmail.com');
  const j = MENSAJE.body.indexOf('lautaro.gonzalez@escuelasanjose.edu.ar');
  assert.ok(i >= 0 && j >= 0 && i < j);
});

test('CA-04b.3: dice que no se borró nada e invita a responder', () => {
  assert.match(MENSAJE.body, /No se borró nada/);
  assert.match(MENSAJE.body, /respondé este mensaje/);
});

test('una sola cuenta apagada va en singular', () => {
  assert.match(MENSAJE.body, /La otra \(lautaro\.gonzalez@escuelasanjose\.edu\.ar\) quedó deshabilitada y ya no deja entrar\./);
});

test('varias cuentas apagadas van en plural, y cada correo aparece', () => {
  // Un grupo de tres cuentas donde se apagan dos que alguien usó. "La otra (a y b) quedó" era lo
  // que decía antes de la revisión del 2026-09-17.
  const m = mensajeDeFusion({
    correoConservada: 'real@gmail.com',
    correoApagada:    ['padron@familia.com', 'vieja@hotmail.com'],
  });
  assert.match(m.body, /Las otras \(padron@familia\.com y vieja@hotmail\.com\) quedaron deshabilitadas y ya no dejan entrar\./);
  assert.ok(!/La otra \(/.test(m.body));
});

test('grupo de 3 donde se avisa por UNA: dice cuántas cuentas eran, sin llamarla "la otra"', () => {
  // Segunda pasada de la revisión (2026-09-17): con tres cuentas y una sola apagada por esta
  // acción, el texto decía "Tenías dos cuentas… La otra (x)", y eran tres.
  const m = mensajeDeFusion({
    correoConservada: 'real@gmail.com', correoApagada: 'padron@familia.com', cuentasEnElGrupo: 3,
  });
  assert.match(m.body, /^Tenías 3 cuentas en la plataforma con tu mismo DNI\./);
  assert.match(m.body, /Se deshabilitó padron@familia\.com, que ya no deja entrar\./);
  assert.ok(!/La otra/.test(m.body));
});

test('con dos cuentas el texto es el aprobado, se pase o no la cantidad', () => {
  const con = mensajeDeFusion({ correoConservada: 'real@gmail.com', correoApagada: 'p@f.com', cuentasEnElGrupo: 2 });
  const sin = mensajeDeFusion({ correoConservada: 'real@gmail.com', correoApagada: 'p@f.com' });
  assert.deepStrictEqual(con, sin);
  assert.match(con.body, /^Tenías dos cuentas en la plataforma con tu mismo DNI\./);
});

test('una lista de un solo correo es lo mismo que el correo suelto', () => {
  const lista = mensajeDeFusion({ correoConservada: 'real@gmail.com', correoApagada: ['padron@familia.com'] });
  const suelto = mensajeDeFusion({ correoConservada: 'real@gmail.com', correoApagada: 'padron@familia.com' });
  assert.deepStrictEqual(lista, suelto);
});

test('el mensaje es texto plano: sin marcas de negrita', () => {
  // La mensajería no interpreta Markdown: un "**correo**" llegaría con los asteriscos a la vista.
  assert.ok(!MENSAJE.body.includes('*'));
});

test('el mensaje entra en los límites del modelo Message', () => {
  // models/Message.js: subject maxlength 120, body maxlength 2000. Con correos largos de verdad.
  const largo = mensajeDeFusion({
    correoConservada: 'a'.repeat(60) + '@' + 'b'.repeat(60) + '.com',
    correoApagada:    'c'.repeat(60) + '@' + 'd'.repeat(60) + '.com',
  });
  assert.ok(largo.subject.length <= 120);
  assert.ok(largo.body.length <= 2000);
});

test('mensajeDeFusion exige los dos correos', () => {
  // Un aviso sin el correo con el que entrar es exactamente el aviso que no sirve.
  assert.throws(() => mensajeDeFusion({ correoConservada: '', correoApagada: 'x@y.com' }));
  assert.throws(() => mensajeDeFusion({ correoConservada: 'x@y.com' }));
  assert.throws(() => mensajeDeFusion({ correoConservada: 'x@y.com', correoApagada: [] }));
});
