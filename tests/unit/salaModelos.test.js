// Revisión de los modelos de la sala (2026-11-22). Tres errores encontrados y corregidos:
//
//  1. "Abrir sala" con doble toque (o docente y co-docente a la vez) podía crear DOS sesiones
//     abiertas de la misma materia: el chat quedaba partido y una nunca se cerraba.
//  2. Cerrar la sala miraba una lectura vieja de la sesión para decidir si cortaba la
//     transmisión: si empezó a transmitir después de esa lectura, quedaba viva.
//  3. Cerrar la sala transmitiendo guardaba el registro histórico con 0 espectadores.
//
// Estos tests corren SIN Mongo: se reemplazan los métodos del modelo por dobles en memoria.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const RoomSession = require('../../models/RoomSession');
const RoomMessage = require('../../models/RoomMessage');
const Transmision = require('../../models/Transmision');
const mediaClient = require('../../services/mediaClient');
const live = require('../../services/liveRoom');
const tx   = require('../../services/transmision');

const originales = [];
function doblar(obj, metodo, fn) {
  originales.push([obj, metodo, obj[metodo]]);
  obj[metodo] = fn;
}
afterEach(() => { while (originales.length) { const [o, m, f] = originales.pop(); o[m] = f; } });

// Una "colección" de sesiones en memoria, suficiente para openSession.
function baseEnMemoria() {
  const sesiones = [];
  let n = 0;
  const primera = (curso) => sesiones
    .filter(s => String(s.course) === String(curso) && s.closedAt === null)
    .sort((a, b) => a.orden - b.orden)[0] || null;
  doblar(RoomSession, 'findOne', (q) => ({
    sort: async () => primera(q.course),
    then: (ok, mal) => Promise.resolve(primera(q.course)).then(ok, mal),
  }));
  doblar(RoomSession, 'create', async (d) => {
    const s = { ...d, _id: 'ses' + (++n), orden: n, closedAt: null, lastSeq: 0 };
    sesiones.push(s);
    return s;
  });
  doblar(RoomSession, 'deleteOne', async (q) => {
    const i = sesiones.findIndex(s => s._id === q._id && s.lastSeq === (q.lastSeq ?? s.lastSeq));
    if (i > -1) sesiones.splice(i, 1);
  });
  doblar(RoomSession, 'findByIdAndUpdate', async (id) => {
    const s = sesiones.find(x => x._id === id);
    if (!s) return null;
    s.lastSeq += 1;
    return { lastSeq: s.lastSeq };
  });
  doblar(RoomMessage, 'create', async (m) => m);
  return sesiones;
}

const curso   = { _id: 'curso1', school: 'esc1', division: 'div1' };
const docente = { _id: 'u1', name: 'Docente Prueba' };

test('dos "Abrir sala" a la vez dejan UNA sola sesión abierta', async () => {
  const sesiones = baseEnMemoria();
  // Se simula la carrera: los dos leen "no hay abierta" antes de que el otro cree la suya.
  const findOne = RoomSession.findOne;
  let lecturas = 0;
  RoomSession.findOne = (q) => (lecturas++ < 2 ? { sort: async () => null } : findOne(q));

  const [a, b] = await Promise.all([
    live.openSession(curso, docente),
    live.openSession(curso, { _id: 'u2', name: 'Co-docente' }),
  ]);

  const abiertas = sesiones.filter(s => s.closedAt === null);
  assert.strictEqual(abiertas.length, 1, 'tiene que quedar una sola sesión abierta');
  assert.strictEqual(String(a.session._id), String(b.session._id), 'los dos tienen que terminar en la misma');
  assert.strictEqual([a.creada, b.creada].filter(Boolean).length, 1, 'solo una cuenta como creada');
});

test('abrir con una sala ya abierta devuelve esa, sin crear otra', async () => {
  const sesiones = baseEnMemoria();
  const primera = await live.openSession(curso, docente);
  const segunda = await live.openSession(curso, docente);
  assert.strictEqual(sesiones.length, 1);
  assert.strictEqual(segunda.creada, false);
  assert.strictEqual(String(segunda.session._id), String(primera.session._id));
});

test('todas las búsquedas de "la sala abierta" eligen la misma (la primera creada)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raiz = path.join(__dirname, '..', '..');
  const rooms = fs.readFileSync(path.join(raiz, 'routes', 'rooms.js'), 'utf8');
  const acts  = fs.readFileSync(path.join(raiz, 'routes', 'activities.js'), 'utf8');
  assert.match(rooms, /async function sesionAbierta\(courseId\) \{\n  const session = await live\.primeraAbierta\(courseId\);/);
  // Cualquier findOne de "abierta de esta materia" tiene que ir ordenado por _id.
  for (const [nombre, src] of [['rooms.js', rooms], ['activities.js', acts]]) {
    const sueltos = src.match(/findOne\(\{ course: [^}]+, closedAt: null \}\)(?!\.sort\(\{ _id: 1 \}\))/g) || [];
    assert.deepStrictEqual(sueltos, [], `${nombre}: búsqueda de sala abierta sin orden`);
  }
  // Y hay un índice que la sirve sin recorrer las clases viejas.
  const idx = RoomSession.schema.indexes().map(([k]) => JSON.stringify(k));
  assert.ok(idx.includes(JSON.stringify({ course: 1, closedAt: 1, _id: 1 })));
});

test('cerrar la sala corta la transmisión según la base, no según una lectura vieja', async () => {
  const vieja = { _id: 'ses9', course: 'curso1', closedAt: null, transmision: { activa: false } };
  const ahora = { ...vieja, closedAt: new Date(), transmision: { activa: true } };
  doblar(RoomSession, 'findOneAndUpdate', async () => ahora);
  doblar(RoomSession, 'findByIdAndUpdate', async () => ({ lastSeq: 1 }));
  doblar(RoomSession, 'updateOne', async () => ({}));
  doblar(RoomMessage, 'create', async (m) => m);
  doblar(mediaClient, 'datosDeSala', async () => ({ pico: 23, alumnosQueHablaron: 4, rechazadasPorTope: 1 }));
  let cerroMedios = false;
  doblar(mediaClient, 'cerrarSala', async () => { cerroMedios = true; });
  let registro = null;
  doblar(Transmision, 'findOneAndUpdate', async (q, u) => { if (u.$set) registro = u.$set; });

  await live.closeSession(vieja, docente);

  assert.ok(registro, 'tiene que cerrar el registro de la transmisión');
  assert.strictEqual(registro.cerradaPor, 'cierre-sala');
  assert.strictEqual(registro.picoEspectadores, 23, 'con los espectadores que dio el proceso de video');
  assert.strictEqual(registro.alumnosQueHablaron, 4);
  assert.ok(cerroMedios, 'y avisarle al proceso de video');
});

test('sin proceso de video, el registro se cierra igual y no pisa nada', () => {
  assert.deepStrictEqual(tx.metricasDeMedios(null), {});
  assert.deepStrictEqual(tx.metricasDeMedios({ pico: 5 }),
    { picoEspectadores: 5, alumnosQueHablaron: 0, pulsacionesRechazadasPorTope: 0 });
});

test('los diseños que aceptan User y RoomSession son los mismos', () => {
  const User = require('../../models/User');
  const deUser = User.schema.path('salaDiseno').enumValues;
  const deSesion = RoomSession.schema.path('settings.diseno').enumValues;
  assert.deepStrictEqual([...deSesion].sort(), [...deUser].sort());
  const { DISENOS } = require('../../config/salaDisenos');
  const ids = (Array.isArray(DISENOS) ? DISENOS : Object.values(DISENOS)).map(d => d.id).sort();
  assert.deepStrictEqual([...deSesion].sort(), ids);
});
