// "Hablar" en el proceso de medios (media/servidor.js): pulsar para hablar, el tope de voces, la
// pulsación máxima y el cierre inmediato de las voces. Ver specs/sala-hablar.spec.md.
//
// Mismo método que mediaServidor.test.js: se levanta el proceso de verdad, en un puerto y un
// rango UDP propios, y se le habla por WebSocket. Los productores se crean con parámetros RTP
// armados a mano (Opus, como los que manda un navegador): mediasoup los acepta sin que el
// transporte esté conectado, así que se prueba todo el protocolo sin navegador.
//
// ⚠️ Lo que esto NO prueba es que viaje audio (la lección de D14 de la transmisión: la
// señalización no dice nada sobre el media). Eso son los CA-20 a 22, con getStats() en un
// navegador real.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const jwt  = require('jsonwebtoken');
const WebSocket = require('ws');

const PUERTO  = 4189;
const SECRETO = 'secreto-de-prueba-hablar-no-usar';
// La pulsación máxima real es 60 s. Acá se baja por entorno para poder esperarla.
const PULSACION_MS = 700;

let proc;
let sesiones = 0;
// Un id de sesión distinto por test: así un test no hereda las voces de otro.
const nuevaSesion = () => `507f1f77bcf86cd7994391${String(++sesiones).padStart(2, '0')}`;
let ssrc = 22220000;

const ticket = (sid, extra = {}) => jwt.sign({
  sid, cid: 'c1', uid: 'u', nom: 'ALUMNO, Prueba', rol: 'student',
  emitir: false, video: false, ...extra,
}, SECRETO, { expiresIn: 60 });

// Parámetros RTP de una voz en Opus, como los que manda mediasoup-client desde un navegador.
const opus = () => ({
  mid: '0',
  codecs: [{
    mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2,
    parameters: { useinbandfec: 1, usedtx: 1 }, rtcpFeedback: [],
  }],
  headerExtensions: [],
  encodings: [{ ssrc: ++ssrc }],
  rtcp: { cname: `prueba-${ssrc}`, reducedSize: true },
});

// Una conexión que queda abierta, con los mensajes guardados para poder esperarlos por tipo.
class Cliente {
  constructor() {
    this.recibidos = [];
    this.esperas = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${PUERTO}/rtc`);
    this.abierto = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.recibidos.push(m);
      this.esperas = this.esperas.filter(e => {
        if (!e.cumple(m)) return true;
        clearTimeout(e.reloj); e.resolve(m); return false;
      });
    });
  }

  async mandar(m) { await this.abierto; this.ws.send(JSON.stringify(m)); }

  // Espera un mensaje de alguno de los tipos pedidos que cumpla el filtro. Mira también lo que
  // ya llegó y todavía nadie consumió.
  esperar(tipos, filtro = () => true, timeout = 5000) {
    const lista = [].concat(tipos);
    const cumple = (m) => lista.includes(m.t) && filtro(m);
    const i = this.recibidos.findIndex(m => cumple(m) && !m._visto);
    if (i >= 0) { this.recibidos[i]._visto = true; return Promise.resolve(this.recibidos[i]); }
    return new Promise((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error(
        `timeout esperando ${lista.join('|')}. Llegaron: ${this.recibidos.map(r => r.t).join(', ') || 'nada'}`,
      )), timeout);
      this.esperas.push({ cumple: (m) => { if (!cumple(m)) return false; m._visto = true; return true; },
                          resolve, reloj });
    });
  }

  // ¿Llegó un mensaje así en los próximos `ms`? Para afirmar que algo NO pasa.
  async llega(tipos, filtro, ms = 600) {
    try { await this.esperar(tipos, filtro, ms); return true; } catch (e) { return false; }
  }

  cerrar() { try { this.ws.close(); } catch (e) {} }
}

const abiertos = [];

// Saluda con un ticket y espera la bienvenida.
async function entrar(sid, datos) {
  const c = new Cliente();
  abiertos.push(c);
  await c.mandar({ t: 'hola', ticket: ticket(sid, datos) });
  c.bienvenida = await c.esperar(['bienvenido', 'error']);
  return c;
}

// Entra, crea un transporte de envío y produce una voz. Devuelve la respuesta de `producir`.
async function entrarYProducir(sid, datos) {
  const c = await entrar(sid, datos);
  await c.mandar({ t: 'crearTransporte', proposito: 'enviar' });
  const tr = await c.esperar('transporte');
  c.transportId = tr.parametros.id;
  await c.mandar({ t: 'producir', kind: 'audio', transportId: c.transportId, rtpParameters: opus() });
  c.produccion = await c.esperar(['produciendo', 'error']);
  return c;
}

const alumnoVoz = (sid, uid, nom) => entrarYProducir(sid, { uid, nom, rol: 'student', emitir: 'audio' });
const docente   = (sid) => entrarYProducir(sid, { uid: 'doc', nom: 'GOMEZ, Laura', rol: 'teacher', emitir: true, video: false });

async function hablar(c) { await c.mandar({ t: 'hablar' }); return c.esperar(['hablarOk', 'lleno', 'error']); }
async function callar(c) { await c.mandar({ t: 'callar' }); return c.esperar(['callado', 'error']); }

async function cerrarVoces(cuerpo) {
  const r = await fetch(`http://127.0.0.1:${PUERTO}/cerrar-voces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'media', 'servidor.js')], {
    env: {
      ...process.env,
      JWT_SECRET: SECRETO,
      MEDIA_PORT: String(PUERTO),
      MEDIA_WORKERS: '1',
      RTC_MIN_PORT: '41150',
      RTC_MAX_PORT: '41199',
      MAX_PULSACION_MS: String(PULSACION_MS),
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PUERTO}/health`);
      if (r.ok) return;
    } catch (e) { /* todavía no levantó */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('el proceso de medios no levantó a tiempo');
});

after(() => {
  for (const c of abiertos) c.cerrar();
  if (proc) proc.kill();
});

// ── El ticket de voz ─────────────────────────────────────────────────────────

test('RH-3 · ⭐ un ticket emitir:"audio" puede producir audio, y nace PAUSADO', async () => {
  const a = await alumnoVoz(nuevaSesion(), 'a1', 'PEREZ, Ana');
  assert.strictEqual(a.produccion.t, 'produciendo',
    `el alumno con la voz abierta tiene que poder producir — llegó: ${JSON.stringify(a.produccion)}`);
  assert.strictEqual(a.produccion.kind, 'audio');
  // H3: soltado = 0 paquetes. El micrófono del alumno solo manda mientras aprieta.
  assert.strictEqual(a.produccion.pausado, true, 'la voz del alumno tiene que nacer pausada');
});

test('RH-3 · ⭐ un ticket emitir:"audio" NO puede colar video', async () => {
  const sid = nuevaSesion();
  const a = await entrar(sid, { uid: 'a1', emitir: 'audio' });
  await a.mandar({ t: 'crearTransporte', proposito: 'enviar' });
  const tr = await a.esperar('transporte');
  await a.mandar({ t: 'producir', kind: 'video', transportId: tr.parametros.id, rtpParameters: {} });
  const r = await a.esperar(['error', 'produciendo']);
  assert.strictEqual(r.t, 'error');
  assert.match(r.error, /video/i);
});

test('RH-3 · un ticket de solo escucha sigue sin poder producir (regresión)', async () => {
  const c = await entrarYProducir(nuevaSesion(), { uid: 'o1', emitir: false });
  assert.strictEqual(c.produccion.t, 'error');
  assert.match(c.produccion.error, /permiso/i);
});

test('H3 · la voz del docente NO nace pausada: él no pulsa, habla', async () => {
  const d = await docente(nuevaSesion());
  assert.strictEqual(d.produccion.t, 'produciendo');
  assert.notStrictEqual(d.produccion.pausado, true);
});

// ── CA-14 / CA-15 · El tope ──────────────────────────────────────────────────

test('CA-14 · ⭐ con dos alumnos hablando, el tercero recibe "lleno"; el docente no cuenta', async () => {
  const sid = nuevaSesion();
  await docente(sid);
  const a = await alumnoVoz(sid, 'a1', 'PEREZ, Ana');
  const b = await alumnoVoz(sid, 'b1', 'DIAZ, Luis');
  const c = await alumnoVoz(sid, 'c1', 'SOSA, Eva');

  assert.strictEqual((await hablar(a)).t, 'hablarOk');
  assert.strictEqual((await hablar(b)).t, 'hablarOk');
  const lleno = await hablar(c);
  assert.strictEqual(lleno.t, 'lleno', 'con docente + 2 alumnos hablando no entra un tercero');
  assert.ok(lleno.mensaje, '"lleno" tiene que traer el mensaje para mostrarle al alumno');
});

test('CA-15 · al soltar uno, el siguiente entra', async () => {
  const sid = nuevaSesion();
  const a = await alumnoVoz(sid, 'a1', 'PEREZ, Ana');
  const b = await alumnoVoz(sid, 'b1', 'DIAZ, Luis');
  const c = await alumnoVoz(sid, 'c1', 'SOSA, Eva');

  await hablar(a); await hablar(b);
  assert.strictEqual((await hablar(c)).t, 'lleno');
  assert.strictEqual((await callar(a)).t, 'callado');
  assert.strictEqual((await hablar(c)).t, 'hablarOk', 'al soltar A tiene que haber lugar para C');
});

test('CA-15 · pedir hablar dos veces no ocupa dos lugares', async () => {
  // El doble toque y el reintento son lo normal en un celular.
  const sid = nuevaSesion();
  const a = await alumnoVoz(sid, 'a1', 'PEREZ, Ana');
  const b = await alumnoVoz(sid, 'b1', 'DIAZ, Luis');
  assert.strictEqual((await hablar(a)).t, 'hablarOk');
  assert.strictEqual((await hablar(a)).t, 'hablarOk');
  assert.strictEqual((await hablar(b)).t, 'hablarOk', 'A ocupa UN lugar aunque haya apretado dos veces');
});

test('CA-14 · el tope es por sala: dos salas llenas no se pisan', async () => {
  const s1 = nuevaSesion(); const s2 = nuevaSesion();
  const a = await alumnoVoz(s1, 'a1', 'A'); const b = await alumnoVoz(s1, 'b1', 'B');
  await hablar(a); await hablar(b);
  const d = await alumnoVoz(s2, 'd1', 'D');
  assert.strictEqual((await hablar(d)).t, 'hablarOk');
});

test('hablar sin haber producido una voz es un error, no un lugar ocupado', async () => {
  const sid = nuevaSesion();
  const o = await entrar(sid, { uid: 'o1', emitir: 'audio' });
  const r = await hablar(o);
  assert.strictEqual(r.t, 'error');
  // Que sea el error de ESTE caso y no el de un mensaje que el servidor no conoce.
  assert.doesNotMatch(r.error, /desconocido/i);
});

// ── CA-19 · El indicador ─────────────────────────────────────────────────────

test('CA-19 · ⭐ todos en la sala reciben "hablando" al empezar y al terminar cada pulsación', async () => {
  const sid = nuevaSesion();
  const d = await docente(sid);
  const oyente = await entrar(sid, { uid: 'o1', emitir: false });
  const a = await alumnoVoz(sid, 'a1', 'PEREZ, Ana');

  await hablar(a);
  const on = await oyente.esperar('hablando', m => m.uid === 'a1' && m.on === true);
  assert.strictEqual(on.nom, 'PEREZ, Ana', 'el nombre sale del ticket: nadie habla de forma anónima');
  await d.esperar('hablando', m => m.uid === 'a1' && m.on === true);

  await callar(a);
  await oyente.esperar('hablando', m => m.uid === 'a1' && m.on === false);
  await d.esperar('hablando', m => m.uid === 'a1' && m.on === false);
});

test('CA-19 · el "lleno" no se anuncia a la sala: solo el que habla de verdad', async () => {
  const sid = nuevaSesion();
  const oyente = await entrar(sid, { uid: 'o1', emitir: false });
  const a = await alumnoVoz(sid, 'a1', 'A'); const b = await alumnoVoz(sid, 'b1', 'B');
  const c = await alumnoVoz(sid, 'c1', 'C');
  await hablar(a); await hablar(b);
  // Sin esto el test pasaría con un servidor que no anuncia nada nunca.
  await oyente.esperar('hablando', m => m.uid === 'a1' && m.on === true);
  assert.strictEqual((await hablar(c)).t, 'lleno');
  assert.strictEqual(await oyente.llega('hablando', m => m.uid === 'c1' && m.on === true), false);
});

// ── CA-16 · La pulsación máxima ──────────────────────────────────────────────

test('CA-16 · ⭐ una pulsación que pasa el máximo se corta sola y libera el lugar', async () => {
  // Es la defensa contra el touchend perdido: un micrófono de un chico abierto sin que lo sepa.
  const sid = nuevaSesion();
  const oyente = await entrar(sid, { uid: 'o1', emitir: false });
  const a = await alumnoVoz(sid, 'a1', 'A'); const b = await alumnoVoz(sid, 'b1', 'B');
  const c = await alumnoVoz(sid, 'c1', 'C');
  await hablar(a); await hablar(b);

  const corte = await a.esperar('teCallaron', () => true, PULSACION_MS * 4);
  assert.strictEqual(corte.motivo, 'tiempo');
  await oyente.esperar('hablando', m => m.uid === 'a1' && m.on === false);
  // B también se cortó a esta altura (empezó casi a la vez), así que C entra seguro.
  assert.strictEqual((await hablar(c)).t, 'hablarOk');
});

test('CA-16 · soltar a tiempo NO dispara el corte', async () => {
  const sid = nuevaSesion();
  const a = await alumnoVoz(sid, 'a1', 'A');
  assert.strictEqual((await hablar(a)).t, 'hablarOk');
  assert.strictEqual((await callar(a)).t, 'callado');
  assert.strictEqual(await a.llega('teCallaron', () => true, PULSACION_MS * 2), false,
    'un timer viejo no puede cortar una pulsación que ya terminó');
});

// ── CA-17 · Cerrar la voz en el acto (H8) ────────────────────────────────────

test('CA-17 · ⭐ /cerrar-voces calla a los alumnos de ESA sala y no toca al docente ni a otra sala', async () => {
  const s1 = nuevaSesion(); const s2 = nuevaSesion();
  const d = await docente(s1);
  const a = await alumnoVoz(s1, 'a1', 'A');
  const b = await alumnoVoz(s1, 'b1', 'B');
  const otra = await alumnoVoz(s2, 'x1', 'X');
  await hablar(a);

  const r = await cerrarVoces({ sessionId: s1 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, cerradas: 2 });

  // El que estaba hablando se entera de por qué se cortó; el otro, de que se cerró la voz.
  const corte = await a.esperar('teCallaron');
  assert.strictEqual(corte.motivo, 'voz-cerrada');
  const modo = await b.esperar('modoVoz');
  assert.strictEqual(modo.abierta, false);

  // Ya no pueden volver a producir con el ticket viejo: para hablar de nuevo, ticket nuevo.
  await b.mandar({ t: 'producir', kind: 'audio', transportId: b.transportId, rtpParameters: opus() });
  const otraVez = await b.esperar(['error', 'produciendo']);
  assert.strictEqual(otraVez.t, 'error');
  assert.match(otraVez.error, /permiso/i);

  // El docente sigue al aire: quien llega tarde lo encuentra entre los productores.
  const tarde = await entrar(s1, { uid: 't1', emitir: false });
  const ids = tarde.bienvenida.productores.map(p => p.id);
  assert.ok(ids.includes(d.produccion.id), 'la voz del docente no se cierra con las de los alumnos');
  assert.ok(!ids.includes(a.produccion.id) && !ids.includes(b.produccion.id),
    'las voces de los alumnos tienen que haberse cerrado');

  // Y la otra sala, intacta.
  assert.strictEqual((await hablar(otra)).t, 'hablarOk');
});

test('CA-17 · /cerrar-voces sobre una sala sin voces contesta 0, no un error', async () => {
  const r = await cerrarVoces({ sessionId: nuevaSesion() });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, cerradas: 0 });
});

test('CA-17 · /cerrar-voces con un cuerpo roto contesta 400 y el proceso sigue vivo', async () => {
  const r = await cerrarVoces('{esto no es json');
  assert.strictEqual(r.status, 400);
  const h = await (await fetch(`http://127.0.0.1:${PUERTO}/health`)).json();
  assert.strictEqual(h.status, 'ok');
});
