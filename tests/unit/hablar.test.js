// "Hablar" en la sala en vivo: las reglas puras, las constantes, el catálogo y los esquemas.
//
// Ver specs/sala-hablar.spec.md. Cada test nombra el criterio de aceptación que cubre (CA-NN) o
// la decisión de diseño (H-N / R-N) cuando el criterio sale de ahí.
//
// Hablar NO es infraestructura nueva: es la transmisión (services/transmision.js,
// media/aforo.js) abierta solo con micrófono, más la voz de los alumnos. Por eso casi todo lo
// que se prueba acá son funciones que ya existen y que ganan un caso, o funciones nuevas al lado.
// Lo que necesita el proceso de medios levantado está en hablarMedios.test.js; lo que necesita
// base y rutas, en el smoke ('sala-hablar-*').

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const t     = require('../../services/transmision');
const aforo = require('../../media/aforo');
const cfg   = require('../../config/transmision');
const { MODULOS, moduloActivo, moduloActivoPara } = require('../../config/modulos');

const RAIZ = path.join(__dirname, '..', '..');

const DOCENTE = { _id: '507f1f77bcf86cd799439011', name: 'GOMEZ, Laura' };
const ANA     = { _id: '507f1f77bcf86cd799439021', name: 'PEREZ, Ana' };
const LUIS    = { _id: '507f1f77bcf86cd799439022', name: 'DIAZ, Luis' };

// Una sesión con la transmisión en el estado que se pida. Por defecto: al aire, solo voz.
const sala = (transmision = {}, mutedStudents = []) => ({
  _id: 's1',
  mutedStudents,
  transmision: { ...t.APAGADA, activa: true, micro: true, soloVoz: true, ...transmision },
});

const ctx = (o) => ({
  esGestor: false, esAlumno: false, esPersonal: false, userId: null, habilitado: false, ...o,
});
const gestor   = (o) => ctx({ esGestor: true, userId: DOCENTE._id, habilitado: true, ...o });
const alumno   = (o) => ctx({ esAlumno: true, userId: ANA._id, ...o });
const personal = (o) => ctx({ esPersonal: true, userId: LUIS._id, ...o });

// ── CA-01 / CA-02 · Quién puede hablar ───────────────────────────────────────

test('CA-01 · el docente habilitado puede hablar', () => {
  assert.strictEqual(t.puedeHablar(sala(), gestor()), true);
});

test('CA-01 · el docente NO habilitado en el módulo no puede hablar', () => {
  assert.strictEqual(t.puedeHablar(sala(), gestor({ habilitado: false })), false);
});

test('CA-01 · con "Solo yo hablo" el alumno NO puede hablar', () => {
  assert.strictEqual(t.puedeHablar(sala({ vozAbierta: false }), alumno()), false);
});

test('CA-01 · con "Todos pueden hablar" el alumno SÍ puede hablar', () => {
  assert.strictEqual(t.puedeHablar(sala({ vozAbierta: true }), alumno()), true);
});

test('CA-01 · RH-7: preceptor y dirección nunca hablan, ni con la voz abierta', () => {
  assert.strictEqual(t.puedeHablar(sala({ vozAbierta: true }), personal()), false);
  // Aunque vinieran "habilitados": el módulo por persona es para el que da clase.
  assert.strictEqual(t.puedeHablar(sala({ vozAbierta: true }), personal({ habilitado: true })), false);
});

test('CA-01 · sin la transmisión al aire nadie habla', () => {
  const apagada = sala({ activa: false, vozAbierta: true });
  assert.strictEqual(t.puedeHablar(apagada, gestor()), false);
  assert.strictEqual(t.puedeHablar(apagada, alumno()), false);
});

test('CA-01 · sin sesión, fail-closed', () => {
  assert.strictEqual(t.puedeHablar(null, gestor()), false);
  assert.strictEqual(t.puedeHablar(null, alumno()), false);
});

test('CA-02 · ⭐ el alumno silenciado NO habla aunque la voz esté abierta', () => {
  // Silenciar a alguien lo silencia entero: chat, fotos y voz (RN-5 de la transmisión).
  const s = sala({ vozAbierta: true }, [ANA._id]);
  assert.strictEqual(t.puedeHablar(s, alumno()), false);
  // Y el silencio es de ESA persona: un compañero sigue pudiendo.
  assert.strictEqual(t.puedeHablar(s, alumno({ userId: LUIS._id })), true);
});

test('CA-09 · ⭐ al alumno NO se le pregunta el módulo: se le pregunta a quien abre la voz', () => {
  // D10 de la transmisión, aplicado a Hablar: si se midiera sobre el alumno, cada chico tendría
  // que estar en la lista de habilitados para poder contestarle a su profesora.
  const s = sala({ vozAbierta: true });
  assert.strictEqual(t.puedeHablar(s, alumno({ habilitado: false })), true);
});

// ── CA-03 · El tope de voces (RH-4) ──────────────────────────────────────────

test('CA-03 · el tope es docente + 2 alumnos', () => {
  assert.strictEqual(cfg.MAX_VOCES, 3);
});

test('CA-03 · con 0 o 1 alumnos hablando entra otro; con 2 ya no', () => {
  assert.strictEqual(aforo.hayLugar(0, false), true);
  assert.strictEqual(aforo.hayLugar(1, false), true);
  assert.strictEqual(aforo.hayLugar(2, false), false);
  assert.strictEqual(aforo.hayLugar(3, false), false);
});

test('CA-03 · ⭐ el lugar del docente está reservado: nunca queda afuera por el tope', () => {
  assert.strictEqual(aforo.hayLugar(0, true), true);
  assert.strictEqual(aforo.hayLugar(2, true), true);
  assert.strictEqual(aforo.hayLugar(50, true), true);
});

test('CA-03 · basura no abre el cupo', () => {
  // Sin dato o negativo = nadie hablando todavía. Un conteo desbocado (Infinity) = lleno: nunca
  // puede abrir 30 micrófonos.
  assert.strictEqual(aforo.hayLugar(undefined, false), true, 'sin dato = nadie hablando');
  assert.strictEqual(aforo.hayLugar(-5, false), true);
  assert.strictEqual(aforo.hayLugar(Infinity, false), false);
});

// ── CA-04 / CA-05 · El costo ─────────────────────────────────────────────────

test('CA-04 · el gobernador cuenta el PEOR caso por oyente: 3 voces × 50 kbps', () => {
  // 50 y no los 40 que decía la spec: medido el 2026-09-23 con getStats(), una voz a 24 kbps
  // pesa ~51 kbps en la red si el navegador ignora el ptime de 60 (con él, ~33).
  assert.strictEqual(cfg.VOZ_KBPS_POR_VOZ, 50);
  const esperado = cfg.MAX_VOCES * cfg.VOZ_KBPS_POR_VOZ / 1000;
  assert.ok(Math.abs(cfg.mbpsDeCapa('voz') - esperado) < 1e-9,
    `mbpsDeCapa('voz') debería ser ${esperado}, fue ${cfg.mbpsDeCapa('voz')}`);
});

test('CA-04 · ⭐ la escuela entera (450) escuchando usa menos de la mitad del presupuesto', () => {
  // En el PEOR caso: tres voces a la vez en todas las aulas y navegadores que ignoran el ptime.
  const mbps = aforo.consumoMbps(450, 'voz');
  assert.ok(mbps > 0, 'la voz tiene que costar algo: si da 0 el gobernador no la ve');
  assert.ok(mbps < cfg.PRESUPUESTO_MBPS * 0.45,
    `450 oyentes usan ${mbps} Mbit/s de ${cfg.PRESUPUESTO_MBPS}`);
});

test('CA-04 · ⭐ voz NO entra en la escalera de video: capaPermitida nunca la devuelve', () => {
  // Si 'voz' entrara en CAPAS, el gobernador podría "degradar" una clase con pantalla a solo
  // voz, que es otra feature y otro módulo.
  assert.ok(!cfg.CAPAS.some(c => c.id === 'voz'), 'CAPAS es la escalera de video');
  for (let n = 0; n <= 6000; n += 7) {
    assert.notStrictEqual(aforo.capaPermitida(n), 'voz', `con ${n} espectadores devolvió 'voz'`);
  }
});

test('CA-04 · la escalera de video no cambió (regresión de los bordes de la transmisión)', () => {
  assert.strictEqual(aforo.capaPermitida(222), '360p');
  assert.strictEqual(aforo.capaPermitida(223), '180p');
  assert.strictEqual(aforo.capaPermitida(815), '180p');
  assert.strictEqual(aforo.capaPermitida(816), 'audio');
  assert.strictEqual(aforo.capaPermitida(4750), 'audio');
  assert.strictEqual(aforo.capaPermitida(4751), null);
});

test('CA-05 · ⭐ al alumno se le muestra el consumo TÍPICO: 11 MB por hora', () => {
  assert.strictEqual(cfg.VOZ_KBPS_TIPICO, 24);
  assert.strictEqual(aforo.estimarMB('voz', 60), 11);
});

test('CA-05 · Hablar es varias veces más barato que la transmisión más baja con video', () => {
  // Sin el > 0 esto pasaría con una capa desconocida, que estimarMB cuenta como 0.
  assert.ok(aforo.estimarMB('voz', 60) > 0, 'la voz tiene que tener un costo estimado');
  assert.ok(aforo.estimarMB('voz', 60) * 5 < aforo.estimarMB('180p', 60));
});

// ── CA-05b · El ticket (D4: la única puerta al proceso de medios) ────────────

test('CA-05b · el docente en "Hablar" emite SIN video', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ soloVoz: true }), gestor()),
    { emitir: true, video: false });
});

test('CA-05b · el docente en la transmisión completa emite CON video (sin cambios)', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ soloVoz: false, pantalla: true }), gestor()),
    { emitir: true, video: true });
});

test('CA-05b · el docente no habilitado no emite', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala(), gestor({ habilitado: false })),
    { emitir: false, video: false });
});

test('CA-05b · ⭐ el alumno con la voz abierta recibe emitir "audio", nunca video', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ vozAbierta: true }), alumno()),
    { emitir: 'audio', video: false });
});

test('CA-05b · con "Solo yo hablo" el alumno solo escucha', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ vozAbierta: false }), alumno()),
    { emitir: false, video: false });
});

test('CA-05b · ⭐ el alumno silenciado solo escucha, con la voz abierta o no', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ vozAbierta: true }, [ANA._id]), alumno()),
    { emitir: false, video: false });
});

test('CA-05b · preceptor y dirección solo escuchan', () => {
  assert.deepStrictEqual(t.datosDelTicket(sala({ vozAbierta: true }), personal()),
    { emitir: false, video: false });
});

test('CA-05b · el alumno con la palabra (D7) sigue como hoy: emite, y video solo con permiso', () => {
  const conPalabra = sala({ soloVoz: false, palabra: ANA._id, palabraCamara: false });
  assert.deepStrictEqual(t.datosDelTicket(conPalabra, alumno()), { emitir: true, video: false });
  const conCamara = sala({ soloVoz: false, palabra: ANA._id, palabraCamara: true });
  assert.deepStrictEqual(t.datosDelTicket(conCamara, alumno()), { emitir: true, video: true });
});

// ── CA-06 · Sesiones viejas y el estado del poll ─────────────────────────────

test('CA-06 · el default (APAGADA) trae los dos campos nuevos en false', () => {
  assert.strictEqual(t.APAGADA.soloVoz, false);
  assert.strictEqual(t.APAGADA.vozAbierta, false);
});

test('CA-06 · ⭐ una sesión guardada ANTES de Hablar se comporta como "Solo yo hablo"', () => {
  // R7 de la transmisión: una sala abierta en el momento del deploy lee los campos nuevos como
  // undefined. Tiene que quedar cerrada a los alumnos, no abierta.
  const vieja = { _id: 's1', mutedStudents: [], transmision: { activa: true, micro: true } };
  assert.strictEqual(t.puedeHablar(vieja, alumno()), false);
  const e = t.estadoParaCliente(vieja, alumno());
  assert.strictEqual(e.vozAbierta, false);
  assert.strictEqual(e.soloVoz, false);
  assert.strictEqual(e.puedoHablar, false);
});

test('CA-06 · el poll trae soloVoz, vozAbierta y puedoHablar calculado en el servidor', () => {
  const e = t.estadoParaCliente(sala({ vozAbierta: true }), alumno());
  assert.strictEqual(e.soloVoz, true);
  assert.strictEqual(e.vozAbierta, true);
  assert.strictEqual(e.puedoHablar, true);

  const mudo = t.estadoParaCliente(sala({ vozAbierta: true }, [ANA._id]), alumno());
  assert.strictEqual(mudo.puedoHablar, false, 'el botón no puede prometer lo que el ticket niega');
});

test('CA-06 · la transmisión apagada devuelve la MISMA forma, con los campos nuevos', () => {
  const e = t.estadoParaCliente(null, alumno());
  assert.strictEqual(e.activa, false);
  assert.ok('vozAbierta' in e && 'soloVoz' in e && 'puedoHablar' in e,
    'una forma sola, siempre: el cliente no tiene que preguntar si el campo existe');
});

// ── H3 / H5 · Constantes ─────────────────────────────────────────────────────

test('H3 · la pulsación se corta sola al minuto', () => {
  // Esta suite corre sin la variable de entorno: se prueba el default.
  if (process.env.MAX_PULSACION_MS) return;
  assert.strictEqual(cfg.MAX_PULSACION_MS, 60000);
});

test('H5 · Opus afinado para voz: 24 kbps', () => {
  assert.strictEqual(cfg.VOZ_MAX_BITRATE, 24000);
});

test('H5 · ⭐ paquetes de 60 ms: las cabeceras bajan a un tercio (medido)', () => {
  assert.strictEqual(cfg.VOZ_PTIME, 60);
  const cliente = fs.readFileSync(path.join(RAIZ, 'public', 'js', 'transmision.js'), 'utf8');
  assert.match(cliente, /opusPtime:\s*60/, 'el cliente tiene que pedir el mismo ptime');
});

// ── H11 · El módulo propio ───────────────────────────────────────────────────

const escuela = (modules) => ({ _id: 'esc1', name: 'Escuela San José', modules });

test('H11 · el catálogo declara hablar como módulo de DOS ejes, sin solapas propias', () => {
  const h = MODULOS.find(m => m.id === 'hablar');
  assert.ok(h, 'hablar tiene que estar en el catálogo');
  assert.strictEqual(h.alcance, 'escuela+persona');
  assert.deepStrictEqual(h.secciones, []);
  assert.strictEqual(h.localsKey, 'hablarEnabled');
});

test('H11 · transmision sigue en el catálogo, independiente', () => {
  const tx = MODULOS.find(m => m.id === 'transmision');
  assert.ok(tx);
  assert.strictEqual(tx.alcance, 'escuela+persona');
});

test('H11 · se despliega APAGADO para todas las escuelas', () => {
  assert.strictEqual(moduloActivo(escuela(undefined), 'hablar'), false);
  assert.strictEqual(moduloActivoPara(escuela(undefined), DOCENTE, 'hablar'), false);
});

test('H11 · prender la escuela no reparte la voz: con lista vacía no habla nadie', () => {
  const s = escuela({ hablar: { enabled: true, alcance: 'lista', personas: [] } });
  assert.strictEqual(moduloActivo(s, 'hablar'), true);
  assert.strictEqual(moduloActivoPara(s, DOCENTE, 'hablar'), false);
});

test('H11 · el docente de la lista puede, el de afuera no', () => {
  const s = escuela({ hablar: { enabled: true, alcance: 'lista', personas: [DOCENTE._id] } });
  assert.strictEqual(moduloActivoPara(s, DOCENTE, 'hablar'), true);
  assert.strictEqual(moduloActivoPara(s, LUIS, 'hablar'), false);
});

test('H11 · ⭐ los dos módulos son independientes: tener Hablar no da video, y al revés', () => {
  const soloHablar = escuela({ hablar: { enabled: true, alcance: 'todos', personas: [] } });
  assert.strictEqual(moduloActivoPara(soloHablar, DOCENTE, 'hablar'), true);
  assert.strictEqual(moduloActivoPara(soloHablar, DOCENTE, 'transmision'), false);

  const soloVideo = escuela({ transmision: { enabled: true, alcance: 'todos', personas: [] } });
  assert.strictEqual(moduloActivoPara(soloVideo, DOCENTE, 'hablar'), false);
});

// ── Esquemas (sin base: se leen los paths del schema) ────────────────────────

test('H11 · School.modules.hablar con los mismos tres campos que transmision', () => {
  const School = require('../../models/School');
  const en = School.schema.path('modules.hablar.enabled');
  const al = School.schema.path('modules.hablar.alcance');
  const pe = School.schema.path('modules.hablar.personas');
  assert.ok(en && al && pe, 'faltan campos de modules.hablar en el schema');
  assert.strictEqual(en.defaultValue, false);
  assert.strictEqual(al.defaultValue, 'lista');
  assert.deepStrictEqual(al.enumValues, ['todos', 'lista']);
});

test('CA-06 · RoomSession.transmision gana soloVoz y vozAbierta, en false por defecto', () => {
  const RoomSession = require('../../models/RoomSession');
  const sv = RoomSession.schema.path('transmision.soloVoz');
  const va = RoomSession.schema.path('transmision.vozAbierta');
  assert.ok(sv && va, 'faltan transmision.soloVoz / transmision.vozAbierta');
  assert.strictEqual(sv.defaultValue, false);
  assert.strictEqual(va.defaultValue, false);
});

test('H9 · el registro Transmision guarda cuánto se usó la voz, no qué dijo nadie', () => {
  const Transmision = require('../../models/Transmision');
  for (const campo of ['soloVoz', 'vozAbiertaSegundos', 'alumnosQueHablaron',
                       'pulsacionesRechazadasPorTope']) {
    assert.ok(Transmision.schema.path(campo), `falta el campo ${campo}`);
  }
});

test('H9 · las cuatro acciones de auditoría existen, con etiqueta en castellano', () => {
  const { ACTIONS } = require('../../config/audit-actions');
  for (const a of ['voz.start', 'voz.stop', 'voz.abrir_alumnos', 'voz.cerrar_alumnos']) {
    assert.ok(ACTIONS[a], `falta la acción ${a}`);
    assert.ok(ACTIONS[a].label, `la acción ${a} no tiene etiqueta`);
  }
});

// ── R5 · El deploy recarga el proceso de medios ──────────────────────────────

test('R5 · ⭐ el deploy recarga TAMBIÉN classroom-media', () => {
  // Confirmado en el VPS el 2026-09-23: la app estaba en v1.0.107 y classroom-media en
  // v1.0.98, con 12 días sin reiniciarse. Con Hablar prendido, un cambio al SFU quedaría sin
  // desplegar y nadie se enteraría.
  const server = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8');
  const inicio = server.indexOf('const deployCmd = [');
  assert.ok(inicio >= 0, 'no encontré deployCmd en server.js');
  const bloque = server.slice(inicio, server.indexOf('];', inicio));
  assert.match(bloque, /pm2 reload classroom-media/,
    'el deployCmd tiene que recargar classroom-media, no solo classroom');
  assert.match(bloque, /pm2 reload classroom --update-env/,
    'y seguir recargando la app, como hoy');
});

// ── CA-23 / H5 · Lo que viaja al navegador ───────────────────────────────────

test('CA-23 · ⭐ la sala NO trae el bundle de mediasoup con un <script>: se carga al tocar', () => {
  // 231 KB que hoy baja cada alumno al abrir la sala con el módulo prendido, lo use o no.
  const partial = fs.readFileSync(path.join(RAIZ, 'views', 'partials', 'transmision.ejs'), 'utf8');
  assert.doesNotMatch(partial, /<script[^>]+mediasoup-client\.bundle\.js/,
    'el bundle tiene que cargarse bajo demanda, no en el render de la sala');

  const cliente = fs.readFileSync(path.join(RAIZ, 'public', 'js', 'transmision.js'), 'utf8');
  assert.match(cliente, /mediasoup-client\.bundle\.js/,
    'el cliente tiene que saber cargarlo cuando se toca Escuchar o Hablar');
});

test('H5 · el cliente produce la voz con Opus mono a 24 kbps y 0 paquetes al soltar', () => {
  const cliente = fs.readFileSync(path.join(RAIZ, 'public', 'js', 'transmision.js'), 'utf8');
  assert.match(cliente, /opusStereo:\s*false/);
  assert.match(cliente, /opusMaxAverageBitrate/);
  assert.match(cliente, /zeroRtpOnPause:\s*true/,
    'sin esto un alumno con el botón suelto sigue mandando paquetes');
});
