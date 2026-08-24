// Tests del cierre del registro público (services/registroPublico.js + routes/auth.js).
// Correr con: npm run test:unit
//
// Por qué acá y no solo en el smoke: el smoke prueba la puerta contra el servidor real, y
// eso está bien, pero necesita Mongo, credenciales y diez minutos. Lo que se fija acá es la
// propiedad que hace que el cierre sea un cierre de verdad: **las guardas contestan ANTES
// de tocar la base**. El router se monta en un Express pelado, SIN conexión a Mongo: si
// alguna de estas rutas intentara consultar algo, el test colgaría o tiraría, en vez de
// contestar 403. Es la forma más barata de que nadie reintroduzca un `await User...` arriba
// de la guarda sin enterarse.
//
// Ver también los specs `registro-publico-cerrado` y `registro-cerrado-gana-a-la-validacion`
// en tests/smoke/specs.js.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path   = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const {
  REGISTRO_ABIERTO, INVITACION_ABIERTA, MENSAJE_CERRADO, rechazarAlta,
} = require('../../services/registroPublico');

// JWT_SECRET: routes/auth.js lo lee al firmar, pero ninguna de las rutas de acá llega a
// firmar nada. Se setea igual para que el require no dependa del .env de la máquina.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-registro-publico';

describe('services/registroPublico — los flags', () => {
  test('las dos puertas están cerradas', () => {
    // Si alguien reabre una, que sea a sabiendas: este test es el que se lo va a decir.
    assert.strictEqual(REGISTRO_ABIERTO, false,
      'el auto-registro de /register debe estar cerrado (pedido del usuario, 2026-08-23)');
    assert.strictEqual(INVITACION_ABIERTA, false,
      'el alta por enlace de invitación debe estar cerrada: dejaba elegir rol, incluido soe');
  });

  test('el mensaje dice a quién pedirle la cuenta', () => {
    // El que rebota tiene que salir sabiendo qué hacer, no solo que no puede.
    assert.match(MENSAJE_CERRADO, /administra/i);
  });

  test('rechazarAlta contesta 403 y se declara', () => {
    let status = null, payload = null;
    const res = { status(c) { status = c; return this; }, json(b) { payload = b; return this; } };
    rechazarAlta(res);
    assert.strictEqual(status, 403, '403 y no 404: la ruta existe, la decisión es nuestra');
    assert.strictEqual(payload.registroCerrado, true,
      'el cuerpo tiene que declarar el motivo: es lo que mira el front y lo que asertan los smoke');
    assert.strictEqual(payload.error, MENSAJE_CERRADO);
  });
});

describe('routes/auth — las puertas de alta, sin base de datos', () => {
  let server, base;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../../views'));
    // Sin checkUser: res.locals.user queda undefined, que es exactamente el estado de
    // alguien sin sesión — el único que puede llegar a estas rutas.
    app.use(require('../../routes/auth'));

    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  test('GET /register manda al login en vez de pintar el formulario', async () => {
    const r = await fetch(`${base}/register`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/login');
  });

  test('POST /register no da de alta, ni con un cuerpo válido y completo', async () => {
    const r = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Colado', email: 'colado@example.com', password: 'Test12345678',
        role: 'student', dni: '12345678',
      }),
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).registroCerrado, true);
  });

  test('POST /register corta antes de validar el DNI (orden de las guardas)', async () => {
    // Sin DNI el 400 de normalizeDni() estaría a la vuelta de la esquina. Que igual conteste
    // 403 es lo que prueba que la puerta cerrada se evalúa primero y que la ruta ni siquiera
    // empieza a procesar el alta.
    const r = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sin DNI', email: 'sindni@example.com', password: 'Test12345678', role: 'student' }),
    });
    assert.strictEqual(r.status, 403);
  });

  test('POST /register/invite/:token tampoco da de alta, ni pidiendo un rol privilegiado', async () => {
    // `directivo` y `soe` estaban en la lista blanca de esta ruta: cualquiera con el enlace
    // se auto-asignaba el rol que abre el legajo psicopedagógico. Ese es el agujero que
    // cierra el flag, y este es el caso que lo fija.
    const r = await fetch(`${base}/register/invite/deadbeef`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Colado SOE', email: 'colado.soe@example.com', password: 'Test12345678',
        role: 'soe', dni: '87654321',
      }),
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await r.json()).registroCerrado, true);
  });

  test('GET /register/invite/:token avisa que el registro está cerrado y no nombra escuela', async () => {
    // Contesta 200 con la pantalla: es una URL que la gente abre desde un mensaje viejo, y
    // un 403 crudo no le explicaría nada. Lo que no puede hacer es seguir revelando a qué
    // institución pertenece el enlace — para eso ni se consulta la base.
    const r = await fetch(`${base}/register/invite/deadbeef`);
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.match(html, /Registro cerrado/);
    assert.doesNotMatch(html, /Enlace inválido/,
      'con el registro cerrado no corresponde el texto de enlace vencido: no venció, se cerró');
  });
});
