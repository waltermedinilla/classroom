// La frontera de seguridad del proceso de medios (media/servidor.js).
//
// Es EL test de la decisión D4: el SFU no consulta Mongo, no conoce roles, y lo único que
// decide si alguien puede transmitir es la firma del ticket que le dio Express. Si esta
// frontera se rompe, cualquiera con un WebSocket puede publicar audio y video en la sala de
// una escuela — así que se prueba de verdad, levantando el proceso y hablándole.
//
// Levanta el servidor en un puerto propio y con un rango UDP propio para no chocar con una
// instancia de desarrollo que esté corriendo.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const jwt  = require('jsonwebtoken');
const WebSocket = require('ws');

const PUERTO   = 4188;
const SECRETO  = 'secreto-de-prueba-no-usar-en-produccion';
const SESSION  = '507f1f77bcf86cd799439099';

let proc;

const ticket = (extra = {}) => jwt.sign({
  sid: SESSION, cid: 'c1', uid: 'u1', nom: 'GOMEZ, Ana', rol: 'teacher',
  emitir: false, video: false, ...extra,
}, SECRETO, { expiresIn: 60 });

// Abre un WebSocket, manda mensajes y devuelve las respuestas que lleguen.
//
// Se espera por TIPO y no por cantidad: el servidor puede intercalar avisos que no son la
// respuesta al mensaje que se mandó (por ejemplo un 'capaCambiada' si el aforo se movió).
// Contar mensajes hacía que el test fallara por un aviso legítimo, que es un falso positivo.
function hablar(mensajes, { hasta, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUERTO}/rtc`);
    const recibidos = [];
    const reloj = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout esperando "${hasta}". Llegaron: ${recibidos.map(r => r.t).join(', ') || 'nada'}`));
    }, timeout);

    ws.on('open', () => mensajes.forEach(m => ws.send(JSON.stringify(m))));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      recibidos.push(m);
      if (!hasta || hasta.includes(m.t)) {
        clearTimeout(reloj); ws.close(); resolve(recibidos);
      }
    });
    ws.on('error', (e) => { clearTimeout(reloj); reject(e); });
  });
}

const buscar = (rs, t) => rs.find(r => r.t === t);

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'media', 'servidor.js')], {
    env: {
      ...process.env,
      JWT_SECRET: SECRETO,
      MEDIA_PORT: String(PUERTO),
      MEDIA_WORKERS: '1',
      RTC_MIN_PORT: '41100',
      RTC_MAX_PORT: '41149',
    },
    stdio: 'ignore',
  });

  // Esperar a que conteste /health en vez de dormir un rato fijo: en una máquina lenta un
  // sleep corto deja el test colorado por un motivo que no es el que se está probando.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PUERTO}/health`);
      if (r.ok) return;
    } catch (e) { /* todavía no levantó */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('el proceso de medios no levantó a tiempo');
});

after(() => { if (proc) proc.kill(); });

// ── La API local ─────────────────────────────────────────────────────────────

test('contesta /health y /estado', async () => {
  const h = await (await fetch(`http://127.0.0.1:${PUERTO}/health`)).json();
  assert.strictEqual(h.status, 'ok');

  const e = await (await fetch(`http://127.0.0.1:${PUERTO}/estado`)).json();
  assert.strictEqual(e.espectadores, 0);
  assert.strictEqual(e.workers, 1);
});

// ── El ticket es la única puerta ─────────────────────────────────────────────

test('⭐ un ticket firmado con OTRO secreto es rechazado', async () => {
  const falso = jwt.sign({ sid: SESSION, uid: 'x', emitir: true }, 'otro-secreto', { expiresIn: 60 });
  const [r] = await hablar([{ t: 'hola', ticket: falso }], { hasta: ['error'] });
  assert.strictEqual(r.t, 'error');
  assert.match(r.error, /inválido|vencido/i);
});

test('⭐ un ticket VENCIDO es rechazado', async () => {
  const viejo = jwt.sign({ sid: SESSION, uid: 'x', emitir: true }, SECRETO, { expiresIn: -10 });
  const [r] = await hablar([{ t: 'hola', ticket: viejo }], { hasta: ['error'] });
  assert.strictEqual(r.t, 'error');
  // `recuperable` le dice al navegador que vuelva a Express a pedir otro, en vez de rendirse.
  assert.strictEqual(r.recuperable, true);
});

test('un ticket basura no tumba el proceso', async () => {
  const [r] = await hablar([{ t: 'hola', ticket: 'no-es-un-jwt' }], { hasta: ['error'] });
  assert.strictEqual(r.t, 'error');

  // Y el proceso sigue vivo, que es la mitad del test.
  const h = await (await fetch(`http://127.0.0.1:${PUERTO}/health`)).json();
  assert.strictEqual(h.status, 'ok');
});

test('un ticket válido entra y recibe las capacidades del router', async () => {
  const rs = await hablar([{ t: 'hola', ticket: ticket() }], { hasta: ['bienvenido'] });
  const r = buscar(rs, 'bienvenido');
  assert.ok(r, 'tiene que dar la bienvenida');
  assert.ok(r.rtpCapabilities?.codecs?.length, 'tiene que venir con los códecs del router');
  assert.strictEqual(r.emitir, false);
});

// ── Producir: lo que decide es el ticket, no lo que pida el navegador ───────

test('⭐ un espectador NO puede producir aunque lo pida', async () => {
  // Es el ataque más obvio: abrir el WebSocket como alumno y mandar `producir`. Lo único que
  // lo separa de publicar audio en la sala es esta comprobación.
  const rs = await hablar([
    { t: 'hola', ticket: ticket({ emitir: false }) },
    { t: 'producir', kind: 'audio', transportId: 'x', rtpParameters: {} },
  ], { hasta: ['error'] });

  const err = buscar(rs, 'error');
  assert.ok(err, 'tiene que contestar error');
  assert.match(err.error, /permiso/i);
});

test('⭐ quien puede emitir AUDIO no puede colar VIDEO', async () => {
  // Es exactamente el caso del alumno con la palabra: el docente le abre el micrófono, y la
  // cámara es un permiso APARTE (D7). El ticket lo lleva en un campo propio.
  const rs = await hablar([
    { t: 'hola', ticket: ticket({ emitir: true, video: false }) },
    { t: 'producir', kind: 'video', transportId: 'x', rtpParameters: {} },
  ], { hasta: ['error'] });

  const err = buscar(rs, 'error');
  assert.ok(err);
  assert.match(err.error, /video/i);
});

// ── Orden de los mensajes ────────────────────────────────────────────────────

test('sin saludar no se puede hacer nada', async () => {
  const [r] = await hablar([{ t: 'crearTransporte' }], { hasta: ['error'] });
  assert.strictEqual(r.t, 'error');
  assert.match(r.error, /saludo/i);
});

test('un mensaje desconocido no rompe la conexión', async () => {
  const rs = await hablar([
    { t: 'hola', ticket: ticket() },
    { t: 'inventado' },
  ], { hasta: ['error'] });
  assert.ok(buscar(rs, 'error'), 'tiene que contestar error y seguir conectado');
});

test('un json roto se contesta con error y no cierra el proceso', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PUERTO}/rtc`);
    ws.on('open', () => ws.send('{esto no es json'));
    ws.on('message', (d) => {
      assert.strictEqual(JSON.parse(d).t, 'error');
      ws.close(); resolve();
    });
    ws.on('error', reject);
  });
  const h = await (await fetch(`http://127.0.0.1:${PUERTO}/health`)).json();
  assert.strictEqual(h.status, 'ok');
});

// ── Transporte real ──────────────────────────────────────────────────────────

test('se crea un transporte WebRTC con candidatos ICE de verdad', async () => {
  const rs = await hablar([
    { t: 'hola', ticket: ticket() },
    { t: 'crearTransporte', proposito: 'recibir' },
  ], { hasta: ['transporte'] });

  const tr = buscar(rs, 'transporte');
  assert.ok(tr, 'tiene que contestar con el transporte');
  assert.ok(tr.parametros.id);
  assert.ok(tr.parametros.iceCandidates.length > 0, 'sin candidatos ICE no hay conexión posible');
  assert.ok(tr.parametros.dtlsParameters);

  // D11: se ofrecen los dos caminos, UDP primero y TCP como red para las redes que bloquean UDP.
  const protocolos = new Set(tr.parametros.iceCandidates.map(c => c.protocol));
  assert.ok(protocolos.has('udp'), 'tiene que haber candidatos UDP');
  assert.ok(protocolos.has('tcp'), 'tiene que haber candidatos TCP (la red de D11)');
});

test('⭐⭐ ningún candidato ICE anuncia 0.0.0.0 (el bug que no da síntoma)', async () => {
  // EL BUG QUE ESTE TEST EXISTE PARA QUE NO VUELVA, encontrado el 2026-08-31 probando en el
  // navegador:
  //
  // Escuchando en 0.0.0.0 sin `announcedIp`, mediasoup anuncia **0.0.0.0** como dirección del
  // candidato — y nadie en el mundo puede conectarse a 0.0.0.0. Lo brutal es cómo se ve: la
  // señalización anda perfecto, el transporte se crea, el productor se crea, el simulcast
  // reporta sus capas, la app dice "transmitiendo"… y `packetsSent` se queda en 0 PARA SIEMPRE,
  // sin un error en ningún log.
  //
  // Los otros 11 tests de este archivo pasaban con el bug puesto, porque todos miran la
  // señalización y la señalización estaba bien. Este mira la única cosa que lo delata.
  const rs = await hablar([
    { t: 'hola', ticket: ticket() },
    { t: 'crearTransporte', proposito: 'recibir' },
  ], { hasta: ['transporte'] });

  const tr = buscar(rs, 'transporte');
  for (const c of tr.parametros.iceCandidates) {
    const dir = c.address || c.ip;
    assert.notStrictEqual(dir, '0.0.0.0',
      'un candidato con 0.0.0.0 hace que la transmisión parezca funcionar y no viaje ni un byte');
    assert.notStrictEqual(dir, '::', 'lo mismo con la dirección comodín de IPv6');
    assert.ok(dir, 'todo candidato tiene que traer una dirección');
  }
});

// ── El estado que alimenta al gobernador ─────────────────────────────────────

test('un espectador conectado se cuenta en /estado', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PUERTO}/rtc`);
  await new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hola', ticket: ticket() })));
    ws.on('message', () => res());
    ws.on('error', rej);
  });

  const e = await (await fetch(`http://127.0.0.1:${PUERTO}/estado`)).json();
  assert.strictEqual(e.espectadores, 1);
  assert.strictEqual(e.clases, 1);

  // Y al irse, deja de contarse: un alumno que cierra la pestaña no sigue ocupando puerto.
  ws.close();
  await new Promise(r => setTimeout(r, 600));
  const e2 = await (await fetch(`http://127.0.0.1:${PUERTO}/estado`)).json();
  assert.strictEqual(e2.espectadores, 0);
});
