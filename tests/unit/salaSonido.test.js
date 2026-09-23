// Sonido de aviso en el chat de la sala en vivo.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sonido-chat-sala.spec.md. Cubre la parte PURA de la feature —`evaluar()`,
// `politica()`, `preferencia()`, `leerPreferencia`/`guardarPreferencia`, las constantes del
// audio, `soportaAudio`— y los barridos de `views/partials/live-room.ejs` que no necesitan
// navegador (CA-48 a CA-51, CA-54, CA-54b, CA-58 parcial, CA-58b).
//
// ⚠️ Ninguno de estos tests usa `Date.now()` ni espera 12 s de verdad: `evaluar()` recibe
// `ahora` por parámetro justamente para eso (RN-24, RN-17). Salvo que el CA sea sobre el
// tiempo mínimo, dos evaluaciones encadenadas que esperan `true` en la segunda van separadas
// por más de ENFRIAMIENTO_MS — si no, el test estaría probando el enfriamiento sin querer.
//
// Este archivo REQUIERE `public/js/salaSonido.js`, que todavía no existe: hasta que se
// implemente, `require()` tira MODULE_NOT_FOUND y el archivo entero falla al cargar. Es la
// razón correcta de la falla (no hay ningún error de sintaxis en este archivo).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  evaluar, politica, preferencia, crearEstado,
  leerPreferencia, guardarPreferencia, soportaAudio,
  SONIDO_DE, SONIDO_DE_DEFAULT, PREFERENCIAS, PREFERENCIA_DEFAULT, CLAVE_LOCAL,
  ROLES_PERSONAL, ENFRIAMIENTO_MS, DURACION_MS, GANANCIA_MAX,
} = require('../../public/js/salaSonido');

const { POLL_MS, STAFF_ROLES } = require('../../services/liveRoom');

const raiz = path.join(__dirname, '..', '..');
// A LF: con core.autocrlf el checkout de Windows trae CRLF, y los barridos buscan '\n'.
const sala = fs.readFileSync(path.join(raiz, 'views/partials/live-room.ejs'), 'utf8').replace(/\r\n/g, '\n');

// ── Andamios ────────────────────────────────────────────────────────────────

const SESSION = 'S';

// La entrada base que fija el enunciado de los CA: politica todos/activa, preferencia
// "siempre", mirando, sin gestionar, origen poll, con un mensaje de otro (seq 11) sobre un
// estado con marca 10.
const baseEntrada = (overrides = {}) => ({
  origen:      'poll',
  sessionId:   SESSION,
  mensajes:    [msgOtro(11)],
  politica:    { activo: true, de: 'todos' },
  preferencia: 'siempre',
  mirando:     true,
  esGestor:    false,
  ahora:       1_000_000,
  ...overrides,
});

const baseEstado = (overrides = {}) => ({ sessionId: SESSION, marca: 10, ultimoSonido: null, ...overrides });

const msgOtro    = (seq, extra = {}) => ({ seq, kind: 'text', esMio: false, borrado: false, rol: 'student', ...extra });
const msgMio     = (seq, extra = {}) => ({ seq, kind: 'text', esMio: true,  borrado: false, rol: 'student', ...extra });
const msgSistema = (seq, extra = {}) => ({ seq, kind: 'system', esMio: false, borrado: false, rol: '', ...extra });
const msgBorrado = (seq, extra = {}) => ({ seq, kind: 'text', esMio: false, borrado: true,  rol: 'student', ...extra });
const msgImagen  = (seq, extra = {}) => ({ seq, kind: 'image', esMio: false, borrado: false, rol: 'student', ...extra });
const msgArchivo = (seq, extra = {}) => ({ seq, kind: 'file', esMio: false, borrado: false, rol: 'student', ...extra });
const msgDocente = (seq, extra = {}) => ({ seq, kind: 'text', esMio: false, borrado: false, rol: 'teacher', ...extra });

// ── A. Historial, marca y candidatos (RN-10, RN-11, RN-13, RN-14, RN-18) ─────

test('CA-01 (RN-14): con marca null la primera tanda es historial: no suena y fija la marca', () => {
  const estado = { sessionId: SESSION, marca: null, ultimoSonido: null };
  const mensajes = Array.from({ length: 100 }, (_, i) => msgOtro(i + 1));
  const r = evaluar(estado, baseEntrada({ mensajes }));
  assert.equal(r.sonar, false);
  assert.equal(r.estado.marca, 100);
});

test('CA-02 (RN-10, RN-11): un mensaje nuevo de otro suena y avanza la marca', () => {
  const r = evaluar(baseEstado(), baseEntrada());
  assert.equal(r.sonar, true);
  assert.equal(r.estado.marca, 11);
});

test('CA-03 (RN-11): un mensaje propio no suena', () => {
  const r = evaluar(baseEstado(), baseEntrada({ mensajes: [msgMio(11)] }));
  assert.equal(r.sonar, false);
});

test('CA-04 (RN-11): un mensaje de sistema no suena', () => {
  const r = evaluar(baseEstado(), baseEntrada({ mensajes: [msgSistema(11)] }));
  assert.equal(r.sonar, false);
});

test('CA-04b (RN-11, D10): el aviso "creó la actividad" no suena ni siendo gestor ni con de:todos', () => {
  const msg = msgSistema(11, { actividad: { id: 'a1', url: '/courses/x?actividad=a1' } });
  const r1 = evaluar(baseEstado(), baseEntrada({ mensajes: [msg] }));
  assert.equal(r1.sonar, false);
  const r2 = evaluar(baseEstado(), baseEntrada({
    mensajes: [msg], esGestor: true, politica: { activo: true, de: 'todos' },
  }));
  assert.equal(r2.sonar, false, 'ni gestionando ni con la categoría "todos" tiene que sonar');
});

test('CA-05 (RN-11): un mensaje borrado no suena', () => {
  const r = evaluar(baseEstado(), baseEntrada({ mensajes: [msgBorrado(11)] }));
  assert.equal(r.sonar, false);
});

test('CA-06 (RN-11): una imagen o un archivo de otro suenan igual que el texto', () => {
  const rImagen = evaluar(baseEstado(), baseEntrada({ mensajes: [msgImagen(11)] }));
  assert.equal(rImagen.sonar, true);
  const rArchivo = evaluar(baseEstado(), baseEntrada({ mensajes: [msgArchivo(11)] }));
  assert.equal(rArchivo.sonar, true);
});

test('CA-07 (RN-11): sin mensajes no hay nada que evaluar, sea cual sea el resto de la entrada', () => {
  const r = evaluar(baseEstado(), baseEntrada({
    mensajes: [], esGestor: true, preferencia: 'siempre', mirando: false,
    politica: { activo: true, de: 'todos' },
  }));
  assert.equal(r.sonar, false);
});

test('CA-08 (RN-13): una tanda con varios mensajes nuevos suena UNA sola vez', () => {
  const mensajes = [11, 12, 13, 14, 15].map(seq => msgOtro(seq));
  const r = evaluar(baseEstado(), baseEntrada({ mensajes }));
  assert.equal(r.sonar, true);
  assert.equal(typeof r.sonar, 'boolean', 'un solo booleano, no un contador');
  assert.equal(r.estado.marca, 15);
});

test('CA-09 (RN-10): un repintado con seq ≤ marca no suena; sumar uno nuevo sí', () => {
  const estado = { sessionId: SESSION, marca: 50, ultimoSonido: null };
  const repintado = Array.from({ length: 50 }, (_, i) => msgOtro(i + 1));
  const r1 = evaluar(estado, baseEntrada({ mensajes: repintado }));
  assert.equal(r1.sonar, false);
  const conNuevo = [...repintado, msgOtro(51)];
  const r2 = evaluar(estado, baseEntrada({ mensajes: conNuevo }));
  assert.equal(r2.sonar, true);
});

test('CA-10 (RN-14): un cambio de sesión resetea la marca; después la sesión nueva sigue igual', () => {
  const estado = { sessionId: 'A', marca: 30, ultimoSonido: null };
  const historialDeB = evaluar(estado, baseEntrada({ sessionId: 'B', mensajes: [msgOtro(5), msgOtro(6)] }));
  assert.equal(historialDeB.sonar, false, 'la primera tanda de la sesión nueva es su historial');
  const nuevoEnB = evaluar(historialDeB.estado, baseEntrada({ sessionId: 'B', mensajes: [msgOtro(7)] }));
  assert.equal(nuevoEnB.sonar, true);
});

test('CA-11 (RN-14): con sessionId null la sala está cerrada, no suena y el estado queda vacío', () => {
  const estado = { sessionId: 'A', marca: 30, ultimoSonido: 500_000 };
  const r = evaluar(estado, baseEntrada({ sessionId: null, mensajes: [] }));
  assert.equal(r.sonar, false);
  assert.equal(r.estado.sessionId, null);
  assert.equal(r.estado.marca, null);
});

test('CA-12 (RN-18): la marca avanza también con la política apagada', () => {
  const r1 = evaluar(baseEstado(), baseEntrada({ politica: { activo: false, de: 'todos' } }));
  assert.equal(r1.sonar, false);
  assert.equal(r1.estado.marca, 11, 'la marca tiene que avanzar aunque no suene');
  // Prender la política a mitad de clase no hace sonar lo que ya pasó: los mismos mensajes ya
  // están por debajo de la marca nueva.
  const r2 = evaluar(r1.estado, baseEntrada({ politica: { activo: true, de: 'todos' } }));
  assert.equal(r2.sonar, false);
});

// ── B. politica() y preferencia() (RN-03, RN-19) ─────────────────────────────

test('CA-13 (RN-03): politica() se lee con === true; la ausencia y cualquier otra cosa son apagado', () => {
  assert.equal(politica(undefined).activo, false);
  assert.equal(politica({}).activo, false);
  assert.equal(politica({ sonido: 'true' }).activo, false);
  assert.equal(politica({ sonido: 1 }).activo, false);
  assert.equal(politica({ studentsCanWrite: true, reactionsOn: true }).activo, false);
  assert.equal(politica({ sonido: true }).activo, true);
});

test('CA-14 (RN-03): una categoría fuera de SONIDO_DE cae al default', () => {
  assert.equal(politica({ sonido: true, sonidoDe: 'cualquiera' }).de, SONIDO_DE_DEFAULT);
});

test('CA-20 (RN-19): preferencia() cae al default con cualquier valor inválido', () => {
  assert.equal(PREFERENCIA_DEFAULT, 'siempre', 'D10: "siempre" es el default para no depender de que cada alumno entre a un menú');
  assert.ok(PREFERENCIAS.includes('siempre') && PREFERENCIAS.includes('si_no_miro') && PREFERENCIAS.includes('silencio'));
  assert.equal(preferencia(undefined), PREFERENCIA_DEFAULT);
  assert.equal(preferencia(''), PREFERENCIA_DEFAULT);
  assert.equal(preferencia('fuerte'), PREFERENCIA_DEFAULT);
});

// ── C. La categoría rige para la clase, no para quien gestiona (RN-12, D8) ──

test('CA-15 (RN-12): con "docente" y sin gestionar, solo suena el personal', () => {
  const de = { activo: true, de: 'docente' };
  const rStudent   = evaluar(baseEstado(), baseEntrada({ politica: de, mensajes: [msgOtro(11, { rol: 'student' })] }));
  assert.equal(rStudent.sonar, false);
  const rTeacher   = evaluar(baseEstado(), baseEntrada({ politica: de, mensajes: [msgOtro(11, { rol: 'teacher' })] }));
  assert.equal(rTeacher.sonar, true);
  const rPreceptor = evaluar(baseEstado(), baseEntrada({ politica: de, mensajes: [msgOtro(11, { rol: 'preceptor' })] }));
  assert.equal(rPreceptor.sonar, true);
});

test('CA-16 (RN-12, D8): para quien gestiona, "docente" no filtra a los alumnos', () => {
  const r = evaluar(baseEstado(), baseEntrada({
    politica: { activo: true, de: 'docente' }, esGestor: true,
    mensajes: [msgOtro(11, { rol: 'student' })],
  }));
  assert.equal(r.sonar, true);
});

test('CA-16b (RN-12, D8): ser gestor no saltea los otros filtros', () => {
  const de = { activo: true, de: 'docente' };
  const propio = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: true, mensajes: [msgMio(11)] }));
  assert.equal(propio.sonar, false);
  const sistema = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: true, mensajes: [msgSistema(11)] }));
  assert.equal(sistema.sonar, false);
  const borrado = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: true, mensajes: [msgBorrado(11)] }));
  assert.equal(borrado.sonar, false);
});

test('CA-16c (RN-12, RN-23, D8): quien gestiona también respeta la política apagada y su propio silencio', () => {
  const msg = [msgOtro(11, { rol: 'student' })];
  const apagada = evaluar(baseEstado(), baseEntrada({
    esGestor: true, mensajes: msg, politica: { activo: false, de: 'docente' },
  }));
  assert.equal(apagada.sonar, false, 'quien gestiona tampoco escucha con el sonido de la clase apagado');
  const silenciada = evaluar(baseEstado(), baseEntrada({ esGestor: true, mensajes: msg, preferencia: 'silencio' }));
  assert.equal(silenciada.sonar, false, 'su propia campana manda');
});

test('CA-16d (RN-12, D8): la misma tanda suena para los dos, y una tanda solo del alumno no para quien no gestiona', () => {
  const de = { activo: true, de: 'docente' };
  const dosMensajes = [msgOtro(11, { rol: 'student' }), msgDocente(12)];
  const rGestor  = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: true,  mensajes: dosMensajes }));
  const rComun   = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: false, mensajes: dosMensajes }));
  assert.equal(rGestor.sonar, true);
  assert.equal(rComun.sonar, true, 'suena por el mensaje de la docente');

  const soloAlumno = [msgOtro(11, { rol: 'student' })];
  const rGestor2 = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: true,  mensajes: soloAlumno }));
  const rComun2  = evaluar(baseEstado(), baseEntrada({ politica: de, esGestor: false, mensajes: soloAlumno }));
  assert.equal(rGestor2.sonar, true);
  assert.equal(rComun2.sonar, false);
});

// ── D. La regla final (RN-23, D6) ────────────────────────────────────────────

test('CA-17 (RN-23): con la preferencia en silencio, no suena pase lo que pase', () => {
  const combos = [
    { esGestor: true,  politica: { activo: true, de: 'todos' },   mirando: false },
    { esGestor: false, politica: { activo: true, de: 'docente' }, mirando: true },
  ];
  for (const combo of combos) {
    const r = evaluar(baseEstado(), baseEntrada({ ...combo, preferencia: 'silencio' }));
    assert.equal(r.sonar, false);
  }
});

test('CA-18 (RN-23): "solo si no miro" depende de estar mirando', () => {
  const mirando = evaluar(baseEstado(), baseEntrada({ preferencia: 'si_no_miro', mirando: true }));
  assert.equal(mirando.sonar, false);
  const noMirando = evaluar(baseEstado(), baseEntrada({ preferencia: 'si_no_miro', mirando: false }));
  assert.equal(noMirando.sonar, true);
});

test('CA-19 (RN-23): "siempre" suena con la sala mirada', () => {
  const r = evaluar(baseEstado(), baseEntrada({ preferencia: 'siempre', mirando: true }));
  assert.equal(r.sonar, true);
});

// ── E. La preferencia local (RN-19) ──────────────────────────────────────────

test('CA-21 (RN-19): leerPreferencia y guardarPreferencia nunca tiran, y funcionan con un storage sano', () => {
  const rompeAlLeer = { getItem() { throw new Error('bloqueado'); }, setItem() {} };
  assert.equal(leerPreferencia(rompeAlLeer), 'siempre');

  const rompeAlEscribir = { getItem() { return null; }, setItem() { throw new Error('bloqueado'); } };
  assert.equal(guardarPreferencia(rompeAlEscribir, 'silencio'), false);

  const datos = {};
  const sano = {
    getItem: (k) => (k in datos ? datos[k] : null),
    setItem: (k, v) => { datos[k] = v; },
  };
  assert.equal(guardarPreferencia(sano, 'silencio'), true);
  assert.equal(leerPreferencia(sano), 'silencio');
  assert.ok(CLAVE_LOCAL in datos, `guardarPreferencia tiene que usar la clave "${CLAVE_LOCAL}"`);
  assert.ok(!/[a-f0-9]{24}/.test(CLAVE_LOCAL), 'la clave no puede llevar un id de curso: vale para todas las salas');
});

// ── F. El tiempo mínimo de 12 s (RN-17, D9) ──────────────────────────────────

test('CA-22 (RN-17, D9): ENFRIAMIENTO_MS es 12000 y está atado a POLL_MS del servidor', () => {
  assert.equal(ENFRIAMIENTO_MS, 12000);
  assert.equal(ENFRIAMIENTO_MS, POLL_MS * 3,
    'si cambia la cadencia del poll, este test tiene que obligar a revisar el tiempo mínimo');
});

test('CA-22b (RN-17, D9): el borde de los 12 s es inclusivo', () => {
  const t = 1_000_000;
  const sono = evaluar(baseEstado(), baseEntrada({ ahora: t }));
  assert.equal(sono.sonar, true);
  const antesDelBorde = evaluar(sono.estado, baseEntrada({ mensajes: [msgOtro(12)], ahora: t + 11999 }));
  assert.equal(antesDelBorde.sonar, false);
  const enElBorde = evaluar(antesDelBorde.estado, baseEntrada({ mensajes: [msgOtro(13)], ahora: t + 12000 }));
  assert.equal(enElBorde.sonar, true);
});

test('CA-22c (RN-17, D9): lo que cae dentro del tiempo mínimo no se guarda para después', () => {
  const t = 1_000_000;
  const sono = evaluar(baseEstado(), baseEntrada({ ahora: t }));
  const dentro = evaluar(sono.estado, baseEntrada({ mensajes: [msgOtro(12)], ahora: t + 5000 }));
  assert.equal(dentro.sonar, false);
  const sinNuevosTrasElTiempo = evaluar(dentro.estado, baseEntrada({ mensajes: [], ahora: t + 13000 }));
  assert.equal(sinNuevosTrasElTiempo.sonar, false,
    'sin mensajes nuevos no puede haber un aviso diferido que suene solo al cumplirse el tiempo');
});

test('CA-22d (RN-17, D9): se mide desde el último aviso, no desde el último mensaje', () => {
  const t = 1_000_000;
  const sono = evaluar(baseEstado(), baseEntrada({ ahora: t }));
  assert.equal(sono.estado.ultimoSonido, t);
  const r5 = evaluar(sono.estado, baseEntrada({ mensajes: [msgOtro(12)], ahora: t + 5000 }));
  assert.equal(r5.sonar, false);
  assert.equal(r5.estado.ultimoSonido, t, 'un aviso que no sonó no puede mover la ventana');
  const r10 = evaluar(r5.estado, baseEntrada({ mensajes: [msgOtro(13)], ahora: t + 10000 }));
  assert.equal(r10.sonar, false);
  assert.equal(r10.estado.ultimoSonido, t);
  const r12 = evaluar(r10.estado, baseEntrada({ mensajes: [msgOtro(14)], ahora: t + 12000 }));
  assert.equal(r12.sonar, true);
});

test('CA-22e (RN-17, D9): el tiempo mínimo sobrevive al cambio de sesión', () => {
  const t = 1_000_000;
  const sonoEnA = evaluar(baseEstado(), baseEntrada({ ahora: t }));
  assert.equal(sonoEnA.sonar, true);
  const primeraDeB = evaluar(sonoEnA.estado, baseEntrada({
    sessionId: 'B', mensajes: [msgOtro(1), msgOtro(2)], ahora: t + 1000,
  }));
  assert.equal(primeraDeB.sonar, false, 'la primera tanda de la sesión nueva es su historial');
  const nuevoEnB5 = evaluar(primeraDeB.estado, baseEntrada({
    sessionId: 'B', mensajes: [msgOtro(3)], ahora: t + 5000,
  }));
  assert.equal(nuevoEnB5.sonar, false, 'el tiempo mínimo sigue corriendo desde el aviso de la sesión anterior');
  const nuevoEnB12 = evaluar(nuevoEnB5.estado, baseEntrada({
    sessionId: 'B', mensajes: [msgOtro(4)], ahora: t + 12000,
  }));
  assert.equal(nuevoEnB12.sonar, true);
});

test('CA-22f (RN-17, RN-22, D9): el latido y el poll comparten el tiempo mínimo', () => {
  const t = 1_000_000;
  const latido = evaluar(baseEstado(), baseEntrada({ origen: 'latido', esGestor: true, ahora: t }));
  assert.equal(latido.sonar, true);
  const pollDespues = evaluar(latido.estado, baseEntrada({
    origen: 'poll', esGestor: true, mensajes: [msgOtro(12)], ahora: t + 4000,
  }));
  assert.equal(pollDespues.sonar, false);
});

test('CA-22g (RN-23, D9): con la política apagada o en silencio, ultimoSonido no se actualiza', () => {
  const apagada = evaluar(baseEstado(), baseEntrada({ politica: { activo: false, de: 'todos' } }));
  assert.equal(apagada.sonar, false);
  assert.equal(apagada.estado.ultimoSonido, null);
  const prendida = evaluar(apagada.estado, baseEntrada({
    mensajes: [msgOtro(12)], politica: { activo: true, de: 'todos' },
  }));
  assert.equal(prendida.sonar, true, 'al prender el sonido, el primer mensaje nuevo suena sin esperar 12 s');

  const enSilencio = evaluar(baseEstado(), baseEntrada({ preferencia: 'silencio' }));
  assert.equal(enSilencio.sonar, false);
  assert.equal(enSilencio.estado.ultimoSonido, null);
});

// ── G. El latido de quien gestiona (RN-22) ───────────────────────────────────

test('CA-23 (RN-22): el latido nunca decide que la sesión cambió', () => {
  const estado = Object.freeze({ sessionId: 'A', marca: 10, ultimoSonido: null });
  const r = evaluar(estado, baseEntrada({ origen: 'latido', sessionId: 'B', mensajes: [msgOtro(11)] }));
  assert.equal(r.sonar, false);
  assert.equal(r.estado, estado, 'el estado devuelto tiene que ser exactamente el mismo objeto, sin copiar');
});

test('CA-24 (RN-22): el latido hace sonar; la marca evita el doble aviso también en el poll siguiente', () => {
  const t = 1_000_000;
  const estado0 = { sessionId: SESSION, marca: 10, ultimoSonido: null };
  const msg = msgOtro(11);
  const r1 = evaluar(estado0, baseEntrada({ origen: 'latido', esGestor: true, mensajes: [msg], ahora: t }));
  assert.equal(r1.sonar, true, 'el latido con un mensaje nuevo tiene que sonar');
  const r2 = evaluar(r1.estado, baseEntrada({ origen: 'latido', esGestor: true, mensajes: [msg], ahora: t + 20000 }));
  assert.equal(r2.sonar, false, 'el mismo mensaje (cursor sin avanzar) no puede sonar dos veces');
  const r3 = evaluar(r2.estado, baseEntrada({ origen: 'poll', esGestor: true, mensajes: [msg], ahora: t + 40000 }));
  assert.equal(r3.sonar, false, 'al volver a la sala, lo ya sonado por el latido no vuelve a sonar');
});

// ── H. Inmutabilidad y guardas contra el servidor (RN-24, RN-12, RN-25, RN-27) ──

test('CA-25 (RN-24): evaluar no muta el estado recibido', () => {
  const estado = Object.freeze({ sessionId: SESSION, marca: 10, ultimoSonido: null });
  assert.doesNotThrow(() => evaluar(estado, baseEntrada()));
});

test('CA-26 (RN-12): ROLES_PERSONAL es exactamente STAFF_ROLES del servidor', () => {
  assert.deepStrictEqual(ROLES_PERSONAL, STAFF_ROLES,
    'si alguien suma un rol de personal en el servidor, este test tiene que fallar');
});

test('CA-27 (RN-25): límites del audio', () => {
  assert.ok(DURACION_MS <= 300, `DURACION_MS (${DURACION_MS}) tiene que ser ≤ 300 ms`);
  assert.ok(GANANCIA_MAX <= 0.2, `GANANCIA_MAX (${GANANCIA_MAX}) tiene que ser ≤ 0.2`);
});

test('CA-28 (RN-27): soportaAudio detecta AudioContext y su alias de Safari', () => {
  assert.equal(soportaAudio({}), false);
  assert.equal(soportaAudio({ AudioContext: function () {} }), true);
  assert.equal(soportaAudio({ webkitAudioContext: function () {} }), true);
});

// ── I. Extra: crearEstado (soporte de RN-14, sin un CA propio) ───────────────

test('crearEstado(sessionId, mensajes) arranca con la marca en el mayor seq ya pintado, sin sonar', () => {
  const conHistorial = crearEstado('S1', [msgOtro(1), msgOtro(2), msgOtro(3)]);
  assert.deepStrictEqual(conHistorial, { sessionId: 'S1', marca: 3, ultimoSonido: null });
  const sinHistorial = crearEstado('S2', []);
  assert.deepStrictEqual(sinHistorial, { sessionId: 'S2', marca: null, ultimoSonido: null });
});

// ── J. Barridos de views/partials/live-room.ejs (sin navegador) ─────────────

test('CA-48 (RN-33): salaSonido.js se carga junto a salaPoll.js, antes del <style>, sin mover el hermano del script en línea', () => {
  const iScript = sala.indexOf('<script src="/js/salaSonido.js">');
  assert.ok(iScript > 0, 'falta <script src="/js/salaSonido.js"> en el partial');
  const iPoll  = sala.indexOf('<script src="/js/salaPoll.js">');
  const iStyle = sala.indexOf('<style>');
  assert.ok(iScript < iStyle, 'salaSonido.js tiene que cargarse antes del <style> inicial');
  assert.ok(Math.abs(iScript - iPoll) < 300, 'salaSonido.js tiene que estar junto a salaPoll.js, arriba de todo');
  assert.match(sala, /<\/div>\s*\n\s*<script>\s*\n\(function \(\) \{/,
    'el <script> en línea tiene que seguir teniendo <div class="lr-wrap"> como hermano anterior (aLaVista())');
});

test('CA-49 (RN-25): sin new Audio() ni archivos .mp3/.wav/.ogg', () => {
  const salaSonidoSrc = fs.readFileSync(path.join(raiz, 'public/js/salaSonido.js'), 'utf8');
  assert.ok(!/new Audio\(/.test(salaSonidoSrc), 'salaSonido.js no puede usar new Audio(): es WebAudio generado');
  assert.ok(!/\.(mp3|wav|ogg)/i.test(salaSonidoSrc), 'salaSonido.js no puede nombrar un archivo de audio');
  assert.ok(!/new Audio\(/.test(sala));
  assert.ok(!/\.(mp3|wav|ogg)/i.test(sala));
});

test('CA-50 (RN-34): salaSonido.js no hace ningún request', () => {
  const salaSonidoSrc = fs.readFileSync(path.join(raiz, 'public/js/salaSonido.js'), 'utf8');
  assert.ok(!/fetch\(/.test(salaSonidoSrc), 'salaSonido.js no puede contener fetch(');
  assert.ok(!/XMLHttpRequest/.test(salaSonidoSrc), 'salaSonido.js no puede contener XMLHttpRequest');
});

test('CA-51 (RN-31): los tres iconos de la campana son spans literales, no elegidos en JS', () => {
  for (const icono of ['notifications_active', 'notifications_paused', 'notifications_off']) {
    assert.match(sala, new RegExp(`<span class="material-symbols-outlined">${icono}</span>`),
      `falta el span literal para "${icono}" en el partial`);
  }
  const iScriptEnLinea = sala.indexOf('<script>\n(function () {');
  assert.ok(iScriptEnLinea > 0);
  const js = sala.slice(iScriptEnLinea);
  assert.ok(!/notifications_(active|paused|off)/.test(js),
    'el JS no puede elegir el nombre del icono de la campana: el barrido de iconos no lo vería');
});

test('CA-54 (RN-16): en pollear(), evaluar corre después del descarte y usa d.mensajes', () => {
  const iPollear = sala.indexOf('async function pollear(');
  assert.ok(iPollear > 0, 'tiene que existir la función pollear()');
  const iDescartar = sala.indexOf('if (d.descartar) return;', iPollear);
  assert.ok(iDescartar > iPollear, 'pollear() tiene que seguir descartando las respuestas atrasadas');
  const iEvaluar = sala.indexOf('evaluar(', iPollear);
  assert.ok(iEvaluar > 0, 'pollear() tiene que llamar a evaluar()');
  assert.ok(iEvaluar > iDescartar,
    'evaluar() tiene que llamarse DESPUÉS de "if (d.descartar) return;": una respuesta vieja no puede sonar');
  const cuerpoPollear = sala.slice(iPollear, sala.indexOf('\n  }', iEvaluar) + 4);
  assert.match(cuerpoPollear, /evaluar\([^)]*d\.mensajes/s,
    'evaluar() tiene que recibir d.mensajes (lo que se pinta), nunca s.mensajes (la respuesta cruda)');
});

test('CA-54b (RN-12, RN-22, D8): pollear() y latir() mandan esGestor sin mirar el rol del usuario, y usan el mismo objeto de estado de sonido', () => {
  const iPollear = sala.indexOf('async function pollear(');
  const iLatir   = sala.indexOf('async function latir(');
  assert.ok(iPollear > 0 && iLatir > 0);
  const cuerpoPollear = sala.slice(iPollear, sala.indexOf('\n  }', iPollear) + 4);
  const cuerpoLatir   = sala.slice(iLatir, sala.indexOf('\n  }', iLatir) + 4);
  assert.match(cuerpoPollear, /esGestor:\s*GESTOR/, 'pollear() tiene que mandar esGestor: GESTOR');
  assert.match(cuerpoLatir, /esGestor:\s*true/, 'latir() tiene que mandar esGestor: true (RN-22: solo late quien gestiona)');
  assert.match(cuerpoLatir, /origen:\s*'latido'/, 'latir() tiene que marcar origen: "latido"');
  assert.ok(!/\.role\b|\.rol\b/.test(cuerpoPollear + cuerpoLatir),
    'esGestor no puede derivarse del rol del usuario: ya viaja resuelto como GESTOR');

  // RN-17 (D9): el tiempo mínimo es POR PÁGINA, no por función que llama a evaluar(). Si
  // pollear() y latir() usaran cada uno su propia variable de estado, cada uno tendría su
  // propio enfriamiento y su propia marca — CA-22f y CA-24 (el latido y el poll comparten el
  // tiempo mínimo y la marca) dejarían de valer en la pantalla real, aunque evaluar() en sí
  // siga siendo correcta. Se verifica por texto (nombre de variable + una sola creación de
  // estado) porque este archivo no ejecuta el partial.
  assert.match(cuerpoPollear, /SalaSonido\.evaluar\(\s*sonido\s*,/,
    'pollear() tiene que llamar a evaluar(sonido, …)');
  assert.match(cuerpoLatir, /SalaSonido\.evaluar\(\s*sonido\s*,/,
    'latir() tiene que llamar a evaluar(sonido, …): el mismo nombre de variable que pollear()');
  assert.match(cuerpoPollear, /\bsonido\s*=\s*oido\.estado/,
    'pollear() tiene que reasignar "sonido" con lo que devuelve evaluar()');
  assert.match(cuerpoLatir, /\bsonido\s*=\s*oido\.estado/,
    'latir() tiene que reasignar "sonido" con lo que devuelve evaluar()');
  const creaciones = sala.match(/\bSalaSonido\.crearEstado\(/g) || [];
  assert.equal(creaciones.length, 1,
    `tiene que haber un solo SalaSonido.crearEstado() en todo el partial (hay ${creaciones.length}): ` +
    'dos crearían dos estados de sonido independientes, uno para pollear() y otro para latir()');
});

test('CA-58 (RN-21, D7) — barrido: la pestaña oculta sigue sin pollear', () => {
  // RN-21 dice explícitamente "lo que hace el código, y sigue haciendo": esta parte del
  // criterio no depende de la feature nueva y ya pasa hoy. La parte de red (que en el
  // navegador no salga ningún /poll con la pestaña oculta) queda para verificación manual.
  const iEvento = sala.indexOf("addEventListener('visibilitychange'");
  assert.ok(iEvento > 0);
  const bloque = sala.slice(iEvento, iEvento + 300);
  assert.match(bloque, /document\.hidden/);
  assert.match(bloque, /detener\(\)/);
});

test('CA-58b (RN-30, D7): la segunda opción de la campana no promete la pestaña oculta, y la línea de ayuda es la de quien gestiona en la del docente y la de quien no gestiona en la del alumno', () => {
  assert.match(sala, /Solo si no tengo la sala al frente/,
    'el texto tiene que hablar de "al frente" (ventana), no de la pestaña');
  assert.ok(!/pesta.a/i.test(
    (sala.match(/Solo si no tengo la sala al frente[^<]*/) || [''])[0]),
    'el texto de la opción no puede nombrar la pestaña: a quien no gestiona no le sirve');

  // La línea de ayuda de abajo depende de `esGestor` (D7): quien gestiona escucha también con
  // la pestaña oculta o en otra solapa (por el latido, RN-22); a quien no gestiona no se le
  // puede prometer eso porque su poll se detiene entero con la pestaña oculta (RN-21). El
  // partial no se renderiza acá (no hay motor de plantillas en este archivo de unit): se
  // verifica el condicional `if (esGestor) {…} else {…}` tal cual queda escrito, que es lo
  // que decide qué línea ve cada rol cuando el servidor sí lo renderiza.
  const iCampana = sala.indexOf('id="lrCampanaMenu"');
  assert.ok(iCampana > 0, 'no se encontró el menú de la campana');
  const iIf = sala.indexOf('<% if (esGestor) { %>', iCampana);
  assert.ok(iIf > 0, 'la ayuda de la campana tiene que ramificar con esGestor');
  const iElse = sala.indexOf('<% } else { %>', iIf);
  const iFin  = sala.indexOf('<% } %>', iElse);
  assert.ok(iElse > iIf && iFin > iElse, 'tiene que haber un if/else completo');
  const ramaDeQuienGestiona   = sala.slice(iIf, iElse);   // la del DOCENTE
  const ramaDeQuienNoGestiona = sala.slice(iElse, iFin);  // la del ALUMNO

  assert.match(ramaDeQuienGestiona, /También suena si estás en otra solapa de la materia o con la pestaña oculta/,
    'la rama de quien gestiona (la que ve el docente) tiene que prometer la otra solapa y la pestaña oculta');
  assert.match(ramaDeQuienNoGestiona, /Suena si la sala está abierta detrás de otra ventana/,
    'la rama de quien no gestiona (la que ve el alumno) tiene que hablar de otra ventana');
  // Ojo: la rama del alumno SÍ puede nombrar "pestaña" (RN-21/D7: "si cambiás de pestaña, la
  // sala se pausa y te ponés al día al volver") — lo que no puede es PROMETER que suena con la
  // pestaña oculta, que es justo lo que dice la rama del docente y esta NO.
  assert.ok(!/suena.{0,40}pesta.a oculta|pesta.a oculta.{0,40}suena/is.test(ramaDeQuienNoGestiona),
    'a quien no gestiona (el alumno) no se le puede prometer que suena con la pestaña oculta');
});

test('CA-59b (RN-32): las opciones de los menús de sonido tienen 44 px de blanco táctil', () => {
  // Pedido del usuario el 2026-09-23, tras verlo en el celular: con 38 px quedaban por debajo
  // de lo recomendado para tocar con el dedo.
  const regla = (sala.match(/\.lr-menu button \{[^}]*\}/) || [''])[0];
  assert.ok(regla, 'no se encontró la regla .lr-menu button');
  const alto = (regla.match(/min-height:\s*(\d+)px/) || [])[1];
  assert.ok(Number(alto) >= 44, `min-height de las opciones: ${alto} px, tiene que ser al menos 44`);
});

// ── K. Guarda de la inversión (RN-03) ────────────────────────────────────────

test('Guarda de la inversión: la única lectura de settings.sonido es politica()', () => {
  const archivos = [
    'services/liveRoom.js', 'routes/rooms.js', 'models/RoomSession.js',
    'views/partials/live-room.ejs', 'public/js/salaSonido.js',
  ];
  for (const rel of archivos) {
    const abs = path.join(raiz, rel);
    // public/js/salaSonido.js todavía no existe: eso ya lo cazan CA-49/CA-50/CA-51 de acá
    // arriba (y el require() del principio de este archivo). Acá solo importa que NINGÚN
    // archivo existente copie la lectura invertida de sus vecinos.
    if (!fs.existsSync(abs)) continue;
    const txt = fs.readFileSync(abs, 'utf8');
    assert.ok(!/sonido\s*!==\s*false/.test(txt),
      `${rel} no puede leer "sonido" con !== false: la ausencia tiene que ser APAGADO (RN-03), no permiso`);
  }
});

// ── L. Guarda de "una sola fuente" para la categoría por defecto (RN-09) ─────

test('RN-09: el settings hardcodeado a mano en course.ejs usa SONIDO_DE_DEFAULT, no "docente" suelto', () => {
  // views/course.ejs no puede hacer require() de un módulo del navegador dentro de una
  // plantilla EJS, así que RN-09 documenta que escribe la categoría a mano
  // (`sonidoDe: 'docente'`). Este test es la única atadura entre esa constante escrita a mano
  // y SONIDO_DE_DEFAULT: si el default cambia en salaSonido.js y nadie toca course.ejs, el
  // estado inicial de la solapa (antes del primer poll) quedaría con la categoría vieja.
  const courseEjs = fs.readFileSync(path.join(raiz, 'views/course.ejs'), 'utf8');
  const m = courseEjs.match(/sonidoDe:\s*'([^']+)'/);
  assert.ok(m, 'no se encontró "sonidoDe: \'...\'" en course.ejs (el settings de la sala cerrada, RN-09)');
  assert.equal(m[1], SONIDO_DE_DEFAULT,
    `course.ejs escribió sonidoDe: '${m[1]}' a mano; tiene que ser igual a SONIDO_DE_DEFAULT ('${SONIDO_DE_DEFAULT}')`);
});

// ── M. Nuevo pedido del usuario (2026-09-22/23): la vuelta con lo acumulado ──

test('Nuevo (D7, RN-13, RN-15): al volver de la pestaña oculta con varios mensajes acumulados, suena UNA sola vez', () => {
  // No es la carga inicial de la página: esa es CA-01 (marca null, primera tanda = historial,
  // no suena; ese comportamiento no se toca acá, lo sigue decidiendo el usuario). Acá la
  // pantalla YA tenía una marca —venía viendo la sala— y la pestaña estuvo oculta un rato: con
  // la pestaña oculta el poll se detiene entero (RN-21) y no evalúa nada mientras tanto. Al
  // volver a primer plano, la PRIMERA tanda que el poll trae de nuevo llega con todo lo
  // acumulado de una sola vez, en una sola llamada a evaluar() (RN-16: se evalúa d.mensajes,
  // lo que se pinta, nunca uno por mensaje) — mecánicamente es el mismo camino que CA-08
  // (RN-13: "una tanda suena UNA vez"), pero acá se nombra el escenario explícito porque es el
  // que pidió el usuario.
  const estadoConLaSalaYaVista = { sessionId: SESSION, marca: 10, ultimoSonido: null };
  const acumuladosMientrasEstabaOculta = [11, 12, 13, 14, 15, 16].map(seq => msgOtro(seq));
  const r = evaluar(estadoConLaSalaYaVista, baseEntrada({ mensajes: acumuladosMientrasEstabaOculta, mirando: true }));
  assert.equal(r.sonar, true, 'la tanda acumulada al volver tiene que sonar');
  assert.equal(typeof r.sonar, 'boolean', 'un solo booleano por tanda, no uno por cada mensaje acumulado');
  assert.equal(r.estado.marca, 16, 'la marca tiene que quedar en el mayor seq de lo acumulado');

  // El poll siguiente, ya al día (sin mensajes nuevos), no puede volver a sonar por lo mismo.
  const r2 = evaluar(r.estado, baseEntrada({ mensajes: [], ahora: r.estado.ultimoSonido + 20000 }));
  assert.equal(r2.sonar, false, 'lo que ya sonó al volver no puede sonar otra vez en el poll siguiente');
});
