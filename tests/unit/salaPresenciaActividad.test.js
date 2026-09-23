// El alumno que sale de la sala a hacer la actividad no está ausente.
// Ver specs/sala-presencia-en-actividad.spec.md.
// Correr con: npm run test:unit
//
// EL RECLAMO (usuario, 2026-09-23): "los alumnos se van conectando y luego se retiran para
// hacer las actividades que planteó, pero cuando eso ocurre, al alumno figura como
// desconectado […] porque estuvo presente, y no quiero que por eso, siempre tenga ausente."
//
// La causa: el detalle de la actividad se abre en OTRA SOLAPA de la misma página de la
// materia, el poll de la sala se corta con la solapa fuera de vista, y a los 45 s el alumno
// caía en `ausentes` — la misma lista, el mismo gris y el mismo "sin conectarse" que el que
// nunca entró.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const live = require('../../services/liveRoom');
const {
  presenceSummary, huellaDePresencia, decidirLatido, minutosEnMateria, csvAsistencia,
  ONLINE_WINDOW_MS, STAFF_ONLINE_WINDOW_MS, VENTANA_EN_MATERIA_MS, LATIDO_ESCRITURA_MS,
} = live;
const SalaPresencia = require('../../public/js/salaPresencia');
const { sugerenciaDeSalas } = require('../../services/attendance');

const RAIZ = path.join(__dirname, '..', '..');
// Con los finales de línea normalizados: git en Windows saca los archivos con CRLF, y los
// recortes de abajo buscan `\n}\n`. Sin esto el test pasa en una carpeta y falla en otra.
const leer = (...p) => fs.readFileSync(path.join(RAIZ, ...p), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (s) => s.replace(/\/\/.*$/gm, '');

const AHORA  = new Date('2026-09-23T14:30:00Z');   // 11:30 en la escuela
const haceMs = (ms) => new Date(AHORA.getTime() - ms);
const MIN    = 60 * 1000;

const alumno = (n) => ({ _id: `a${n}`, name: `Alumno ${n}`, avatar: null });
const roster = [alumno(1), alumno(2), alumno(3), alumno(4)];

// Una presencia de alumno: último ping de la SALA hace `msPing`, y opcionalmente un latido de
// la MATERIA hace `msMateria`.
const pres = (id, msPing, { rol = 'student', msMateria = null } = {}) => ({
  user: id, userName: `Alumno ${String(id).slice(1)}`, userRole: rol,
  firstSeenAt: haceMs(50 * MIN),
  lastPingAt:  haceMs(msPing),
  enMateriaAt: msMateria == null ? null : haceMs(msMateria),
  msPresente: 10 * MIN,
});

// ── Fase 1: "estuvo" no es "no entró" ────────────────────────────────────────

test('⭐ CA-1 EL RECLAMO: el que se fue a la actividad hace un minuto NO es ausente', () => {
  const r = presenceSummary([pres('a1', 60 * 1000)], roster, AHORA);

  assert.ok(r.estuvieron.some(e => e.id === 'a1'), 'tiene que figurar como que estuvo');
  assert.ok(!r.ausentes.some(a => a.id === 'a1'),
    'y NO en ausentes: esa lista es la de los que nunca entraron');
  assert.equal(r.presentes, 0, '"presentes" sigue queriendo decir "en la sala ahora" (D3)');
  assert.equal(r.asistieron, 1, 'pero asistió');
});

test('CA-2: el que no tiene presencia en la sesión es ausente y nada más', () => {
  const r = presenceSummary([pres('a1', 1000)], roster, AHORA);
  assert.deepEqual(r.ausentes.map(a => a.id), ['a2', 'a3', 'a4']);
  assert.ok(!r.estuvieron.some(e => e.id === 'a2'));
});

test('CA-3: el conectado ahora no se cuenta dos veces', () => {
  const r = presenceSummary([pres('a1', 1000), pres('a2', 5 * MIN)], roster, AHORA);
  assert.equal(r.presentes, 1);
  assert.deepEqual(r.estuvieron.map(e => e.id), ['a2']);
  assert.equal(r.asistieron, 2);
  assert.equal(r.total, 4);
});

test('CA-4: el personal con presencia vieja no aparece como "estuvo"', () => {
  const r = presenceSummary(
    [pres('prof', STAFF_ONLINE_WINDOW_MS + MIN, { rol: 'teacher' }),
     pres('prec', 10 * MIN, { rol: 'preceptor' })],
    roster, AHORA);
  assert.deepEqual(r.estuvieron, [], 'el personal no es asistencia');
  assert.equal(r.asistieron, 0);
});

test('RN-2: "se retiró" es la hora de la escuela del último ping de la sala', () => {
  // 14:29 UTC = 11:29 en la escuela. Un toLocaleTimeString daría la hora de la máquina.
  const r = presenceSummary([pres('a1', MIN)], roster, AHORA);
  assert.equal(r.estuvieron[0].seRetiro, '11:29');
});

test('RN-1: cada "estuvo" trae lo necesario para pintar su círculo', () => {
  const r = presenceSummary([pres('a1', MIN)], [{ _id: 'a1', name: 'Pérez, Ana', avatar: '/a.webp' }], AHORA);
  const e = r.estuvieron[0];
  assert.equal(e.nombre, 'Pérez, Ana');
  assert.equal(e.inicial, 'P');
  assert.equal(e.avatar, '/a.webp');
  assert.equal(e.enActividad, false);
});

test('una sala sin nadie y sin argumentos sigue sin explotar', () => {
  const r = presenceSummary();
  assert.deepEqual(r.estuvieron, []);
  assert.equal(r.asistieron, 0);
});

test('CA-5: la huella cambia cuando alguien pasa de "en la sala" a "estuvo"…', () => {
  const dentro = presenceSummary([pres('a1', 1000)], roster, AHORA);
  const fuera  = presenceSummary([pres('a1', ONLINE_WINDOW_MS + 5000)], roster, AHORA);
  assert.notEqual(huellaDePresencia(dentro), huellaDePresencia(fuera));
});

test('CA-5: …y NO cambia entre dos vueltas en que nadie cambió de estado', () => {
  // Si "se retiró" viajara como "hace N minutos", la huella se movería en cada poll y el
  // ahorro de RN-2 de sala-en-vivo-escala se perdería entero (RN-3).
  const antes   = presenceSummary([pres('a1', 2 * MIN)], roster, AHORA);
  const despues = presenceSummary([pres('a1', 2 * MIN)], roster, new Date(AHORA.getTime() + 8000));
  assert.equal(huellaDePresencia(antes), huellaDePresencia(despues));
});

// ── Fase 1: lo que ve la docente ─────────────────────────────────────────────

test('CA-7: el cartel suma "asistieron" solo cuando alguien se fue', () => {
  assert.equal(SalaPresencia.cartel({ presentes: 18, total: 25, asistieron: 18 }),
    'Sala abierta · 18 de 25 presentes', 'si nadie se fue, el cartel de siempre');
  assert.equal(SalaPresencia.cartel({ presentes: 18, total: 25, asistieron: 24 }),
    'Sala abierta · 18 en la sala · 24 de 25 asistieron');
  assert.equal(SalaPresencia.cartel({ presentes: 3, total: 25 }),
    'Sala abierta · 3 de 25 presentes', 'una respuesta sin `asistieron` no rompe el cartel');
});

test('CA-6: los títulos de los círculos dicen tres cosas distintas', () => {
  assert.equal(SalaPresencia.titulo({ nombre: 'Ana', seRetiro: '11:29', enActividad: false }),
    'Ana · estuvo · se retiró a las 11:29');
  assert.equal(SalaPresencia.titulo({ nombre: 'Ana', seRetiro: '11:29', enActividad: true }),
    'Ana · trabajando en la materia');
  assert.equal(SalaPresencia.titulo({ nombre: 'Ana' }, 'ausente'), 'Ana · no entró a la clase');
});

test('CA-6 / CA-7: el partial pinta con el módulo y no con textos sueltos', () => {
  // La lección del 11/09 (asistencia_preceptoria): un literal escrito a mano en el partial
  // vuelve vacuo al test que afirma lo contrario. Los textos viven en el módulo.
  const sala = leer('views', 'partials', 'live-room.ejs');
  assert.match(sala, /<script src="\/js\/salaPresencia\.js"><\/script>/);
  assert.ok(!sala.includes('sin conectarse'), 'el "sin conectarse" era el título del que estuvo Y del que no vino');
  assert.ok(!sala.includes('asistieron'), 'el cartel lo arma SalaPresencia.cartel()');
  const codigo = sinComentarios(sala);
  assert.match(codigo, /SalaPresencia\.cartel\(s\.presencia\)/);
  assert.match(codigo, /p\.estuvieron/, 'pintarPresencia tiene que dibujar a los que estuvieron');
});

test('RN-2 de escala: los contadores que viajan siempre incluyen `asistieron`', () => {
  const rooms = leer('routes', 'rooms.js');
  assert.match(rooms,
    /\{ presentes: presencia\.presentes, total: presencia\.total, asistieron: presencia\.asistieron \}/,
    'sin esto el cartel perdería el segundo número cada vez que la huella coincide');
});

// ── Fase 2: el latido del alumno fuera de la sala ────────────────────────────

test('CA-9 / RN-6: sin presencia en la sesión, el latido no escribe nada', () => {
  const d = decidirLatido(null, AHORA);
  assert.equal(d.escribir, false, 'estar en la clase empieza por entrar a la clase');
});

test('RN-5: el primer latido escribe y todavía no acredita', () => {
  const d = decidirLatido({ enMateriaAt: null }, AHORA);
  assert.equal(d.escribir, true);
  assert.equal(d.acreditar, 0);
});

test('CA-10: dos latidos seguidos escriben una sola vez', () => {
  assert.equal(decidirLatido({ enMateriaAt: haceMs(20 * 1000) }, AHORA).escribir, false);
  assert.equal(decidirLatido({ enMateriaAt: haceMs(LATIDO_ESCRITURA_MS) }, AHORA).escribir, true);
});

test('RN-5: acredita el tiempo real entre latidos', () => {
  assert.equal(decidirLatido({ enMateriaAt: haceMs(60 * 1000) }, AHORA).acreditar, 60 * 1000);
});

test('⭐ CA-11: un hueco de 10 minutos NO se acredita entero', () => {
  // La misma regla que decidirPing: un hueco más largo que la ventana es tiempo en que NO
  // estaba. Sin el tope, el que cierra la compu y vuelve a los 40 minutos sumaría 40.
  const d = decidirLatido({ enMateriaAt: haceMs(10 * MIN) }, AHORA);
  assert.equal(d.acreditar, VENTANA_EN_MATERIA_MS);
});

test('un reloj corregido hacia atrás no acredita negativo', () => {
  const d = decidirLatido({ enMateriaAt: new Date(AHORA.getTime() + MIN) }, AHORA);
  assert.ok(d.acreditar >= 0);
});

test('⚠️ el cliente late más espaciado que la ventana de escritura, y dentro de la de "en la actividad"', () => {
  // Si el cliente latiera más seguido que LATIDO_ESCRITURA_MS, la mitad de los pedidos
  // serían al pedo; si latiera MÁS espaciado que la ventana de escritura por poco, un latido
  // con jitter se saltearía y el siguiente escribiría recién a los 2 minutos.
  assert.ok(SalaPresencia.LATIDO_ALUMNO_MS > LATIDO_ESCRITURA_MS,
    'la ventana de escritura tiene que ser más corta que el intervalo del cliente');
  assert.ok(SalaPresencia.LATIDO_ALUMNO_MS * 2 < VENTANA_EN_MATERIA_MS,
    'tiene que caber más de un latido perdido dentro de la ventana de "en la actividad"');
  assert.equal(VENTANA_EN_MATERIA_MS, STAFF_ONLINE_WINDOW_MS, 'RN-7: la ventana del personal');
});

test('CA-13: latido hace 2 min → "en la actividad"; hace 4 min → "estuvo"', () => {
  const r2 = presenceSummary([pres('a1', 20 * MIN, { msMateria: 2 * MIN })], roster, AHORA);
  assert.equal(r2.estuvieron[0].enActividad, true);
  const r4 = presenceSummary([pres('a1', 20 * MIN, { msMateria: 4 * MIN })], roster, AHORA);
  assert.equal(r4.estuvieron[0].enActividad, false);
});

test('CA-8: el latido de la materia NO lo vuelve "presente en la sala"', () => {
  const r = presenceSummary([pres('a1', 20 * MIN, { msMateria: 10 * 1000 })], roster, AHORA);
  assert.equal(r.presentes, 0, 'el "N de M presentes" no se infla con el latido (D3/D4)');
  assert.equal(r.asistieron, 1);
});

test('CA-8 / CA-14 / RN-6: registrarLatido actualiza SOLO sus campos, sin upsert y sin tocar la sesión', () => {
  const src = sinComentarios(leer('services', 'liveRoom.js'));
  const ini = src.indexOf('async function registrarLatido');
  assert.ok(ini > 0, 'registrarLatido tiene que existir');
  const cuerpo = src.slice(ini, src.indexOf('\n}\n', ini));

  assert.ok(!/upsert/.test(cuerpo), 'sin upsert: el latido no crea presencias (RN-6)');
  assert.ok(!/lastPingAt\s*:/.test(cuerpo), 'no toca lastPingAt (D4)');
  assert.ok(!/msPresente/.test(cuerpo), 'no toca msPresente (D4)');
  assert.ok(!/RoomSession/.test(cuerpo), 'no toca la sesión: no la mantiene viva (D5)');
  assert.match(cuerpo, /enMateriaAt/);
  assert.match(cuerpo, /msEnMateria/);
});

test('RN-8: la ruta del latido tiene limiter propio y solo la usa el alumno', () => {
  const rooms = sinComentarios(leer('routes', 'rooms.js'));
  assert.match(rooms, /router\.post\('\/:id\/sala\/latido', roomLatidoLimiter,/);
  const ini = rooms.indexOf("router.post('/:id/sala/latido'");
  const cuerpo = rooms.slice(ini, rooms.indexOf('\n});', ini));
  assert.match(cuerpo, /!req\.esAlumno \|\| req\.esGestor/, 'docente y personal no laten por acá');
  assert.match(cuerpo, /409/, 'con la sala cerrada no escribe nada');
  assert.match(cuerpo, /status\(204\)/);
});

test('RN-4 / P2: el navegador late solo si es alumno, con la sala abierta, fuera de vista y la pestaña al frente', () => {
  const base = { alumno: true, abierta: true, salaALaVista: false, pestanaOculta: false };
  assert.equal(SalaPresencia.debeLatir(base), true);
  assert.equal(SalaPresencia.debeLatir({ ...base, alumno: false }), false, 'el personal tiene su propio latido');
  assert.equal(SalaPresencia.debeLatir({ ...base, abierta: false }), false);
  assert.equal(SalaPresencia.debeLatir({ ...base, salaALaVista: true }), false, 'con la sala a la vista ya pollea');
  assert.equal(SalaPresencia.debeLatir({ ...base, pestanaOculta: true }), false,
    'P2: la pestaña de fondo no es "está trabajando"');
});

test('RN-4: el partial arranca el latido del alumno con la regla del módulo', () => {
  const codigo = sinComentarios(leer('views', 'partials', 'live-room.ejs'));
  assert.match(codigo, /SalaPresencia\.debeLatir\(/);
  assert.match(codigo, /BASE \+ '\/latido'/);
  assert.match(codigo, /setInterval\(latirAlumno, SalaPresencia\.LATIDO_ALUMNO_MS\)/);
});

// ── Historial y CSV (RN-11) ──────────────────────────────────────────────────

test('minutosEnMateria: un documento viejo sin el campo da null, no 0', () => {
  // No se inventa un dato que no se midió (mismo criterio que msPresente).
  assert.equal(minutosEnMateria({}), null);
  assert.equal(minutosEnMateria({ msEnMateria: 0 }), 0);
  assert.equal(minutosEnMateria({ msEnMateria: 12 * MIN }), 12);
});

test('CA-19: el CSV de la clase trae los minutos en la materia, vacío si no se midió', () => {
  const csv = csvAsistencia(
    [{ _id: 'a1', name: 'Ana', dni: '1' }, { _id: 'a2', name: 'Beto', dni: '2' }, { _id: 'a3', name: 'Caro', dni: '3' }],
    [{ ...pres('a1', 30 * MIN), msEnMateria: 25 * MIN },
     { user: 'a2', firstSeenAt: haceMs(50 * MIN), lastPingAt: haceMs(40 * MIN), pings: 30 }]);
  const filas = csv.replace(/^﻿/, '').split('\r\n');
  assert.match(filas[0], /Minutos en la materia \(fuera de la sala\)$/);
  assert.match(filas[1], /^Ana;1;Presente;.*;10;25$/);
  assert.match(filas[2], /^Beto;2;Presente;.*;2;$/, 'documento viejo: celda vacía');
  assert.match(filas[3], /^Caro;3;Ausente;;;0;$/);
});

// ── Fase 3: la sugerencia a preceptoría ──────────────────────────────────────

const sesion = (id, materia) => ({ _id: id, course: { name: materia } });

test('⭐ CA-16: el que estuvo en una clase de hoy, ya terminada, se sugiere con su horario', () => {
  const m = sugerenciaDeSalas(
    [sesion('s1', 'Matemática')],
    [{ user: 'a1', userRole: 'student', session: 's1',
       firstSeenAt: new Date('2026-09-23T11:05:00Z'), lastPingAt: new Date('2026-09-23T11:40:00Z') }],
    AHORA);
  const s = m.get('a1');
  assert.ok(s, 'ES EL CASO QUE HOY SE PIERDE: solo se sugería a los conectados ahora');
  assert.equal(s.ahora, false);
  assert.equal(s.materia, 'Matemática');
  assert.equal(s.detalle, 'estuvo en Matemática, 08:05 – 08:40');
});

test('Fase 3: el conectado ahora se sigue sugiriendo como antes', () => {
  const m = sugerenciaDeSalas([sesion('s1', 'Lengua')],
    [{ user: 'a1', userRole: 'student', session: 's1', firstSeenAt: haceMs(20 * MIN), lastPingAt: haceMs(5000) }],
    AHORA);
  assert.equal(m.get('a1').ahora, true);
  assert.equal(m.get('a1').detalle, 'está ahora en Lengua');
});

test('Fase 3: el que está haciendo la actividad cuenta como "ahora"', () => {
  const m = sugerenciaDeSalas([sesion('s1', 'Lengua')],
    [{ user: 'a1', userRole: 'student', session: 's1', firstSeenAt: haceMs(40 * MIN),
       lastPingAt: haceMs(30 * MIN), enMateriaAt: haceMs(MIN) }],
    AHORA);
  assert.equal(m.get('a1').ahora, true);
});

test('Fase 3: "hasta" es lo último que se supo de él, en la sala o en la materia', () => {
  const m = sugerenciaDeSalas([sesion('s1', 'Historia')],
    [{ user: 'a1', userRole: 'student', session: 's1',
       firstSeenAt: new Date('2026-09-23T11:00:00Z'), lastPingAt: new Date('2026-09-23T11:10:00Z'),
       enMateriaAt: new Date('2026-09-23T11:50:00Z') }],
    AHORA);
  assert.equal(m.get('a1').detalle, 'estuvo en Historia, 08:00 – 08:50');
});

test('Fase 3: con dos clases, gana la de ahora; si no, la más reciente', () => {
  const pr = (s, desde, hasta) => ({ user: 'a1', userRole: 'student', session: s,
    firstSeenAt: new Date(desde), lastPingAt: new Date(hasta) });
  const dos = [sesion('s1', 'Matemática'), sesion('s2', 'Biología')];

  const ahora = sugerenciaDeSalas(dos,
    [pr('s1', '2026-09-23T11:00:00Z', '2026-09-23T11:40:00Z'), pr('s2', haceMs(5 * MIN), haceMs(3000))], AHORA);
  assert.equal(ahora.get('a1').materia, 'Biología');

  const reciente = sugerenciaDeSalas(dos,
    [pr('s2', '2026-09-23T11:00:00Z', '2026-09-23T11:40:00Z'), pr('s1', '2026-09-23T12:00:00Z', '2026-09-23T12:40:00Z')], AHORA);
  assert.equal(reciente.get('a1').materia, 'Matemática');
});

test('Fase 3: una clase CERRADA nunca es "ahora", aunque el último ping sea de hace segundos', () => {
  // La docente cierra la sala y preceptoría mira enseguida: el alumno polleó hace 10 s, pero
  // decir "está ahora en Lengua" de una clase que ya terminó es mentirle al preceptor.
  const m = sugerenciaDeSalas([{ ...sesion('s1', 'Lengua'), closedAt: haceMs(5000) }],
    [{ user: 'a1', userRole: 'student', session: 's1', firstSeenAt: haceMs(30 * MIN), lastPingAt: haceMs(10000) }],
    AHORA);
  assert.equal(m.get('a1').ahora, false);
  assert.match(m.get('a1').detalle, /^estuvo en Lengua, /);
});

test('Fase 3: el personal no se sugiere', () => {
  const m = sugerenciaDeSalas([sesion('s1', 'Lengua')],
    [{ user: 'p', userRole: 'teacher', session: 's1', firstSeenAt: haceMs(MIN), lastPingAt: haceMs(1000) }],
    AHORA);
  assert.equal(m.size, 0);
});

test('CA-17: la búsqueda de salas de hoy sale de diaEscolar(), no de un Date local', () => {
  const src = sinComentarios(leer('services', 'attendance.js'));
  const ini = src.indexOf('async function sugerenciasDeSalas');
  assert.ok(ini > 0, 'sugerenciasDeSalas tiene que existir');
  const cuerpo = src.slice(ini, src.indexOf('\n}\n', ini));
  assert.match(cuerpo, /diaEscolar\(/);
  assert.ok(!/setHours|toISOString|toLocaleDateString/.test(cuerpo),
    'producción corre en UTC: un Date local fecha mal las clases de la noche');
});

test('RN-10: RoomSession tiene el índice que usa la búsqueda de salas de hoy', () => {
  const RoomSession = require('../../models/RoomSession');
  const indices = RoomSession.schema.indexes().map(([campos]) => JSON.stringify(campos));
  assert.ok(indices.includes(JSON.stringify({ school: 1, division: 1, openedAt: -1 })),
    `índices: ${indices.join(' ')}`);
});

test('Fase 3: la grilla muestra el detalle y no solo la materia', () => {
  const vista = sinComentarios(leer('views', 'preceptor', 'asistencia-toma.ejs'));
  assert.match(vista, /esc\(a\.detalle \|\| a\.materia\)/);
  assert.match(vista, /estuvieron hoy en una clase en vivo/,
    'si alguno no está ahora, el título no puede decir "están en clase ahora"');
});
