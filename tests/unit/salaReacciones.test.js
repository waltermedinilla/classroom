// Sala en vivo: reaccionar con un emoji sin escribir.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sala-reacciones.spec.md. Lo que se prueba acá:
//
//   1. PERMISOS — la matriz de `puedeReaccionar`, que es pura: recibe un contexto plano, no
//      `req`, así que se prueba sin base ni servidor. El caso que motivó todo es el primero:
//      con la palabra apagada, el alumno NO escribe y SÍ reacciona.
//   2. LA VENTANA — la guarda que impide que una reacción caiga en el hueco entre dos polls.
//   3. EL MARCADO — que el botón salga del permiso que manda el servidor (y no de una regla
//      recableada en la vista), y que reaccionar no vuelva a descargar la conversación entera.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  puedeReaccionar, puedeEscribir, EMOJIS, POLL_MS, VENTANA_REACCIONES_MS,
} = require('../../services/liveRoom');

const raiz = path.join(__dirname, '..', '..');
const sala = fs.readFileSync(path.join(raiz, 'views/partials/live-room.ejs'), 'utf8');

// ── Andamios ────────────────────────────────────────────────────────────────

const ALUMNO  = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTRO    = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DOCENTE = 'cccccccccccccccccccccccc';

const sesion = (settings = {}, mudos = []) => ({
  _id: 'sesion1',
  closedAt: null,
  settings: { studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true, ...settings },
  mutedStudents: mudos,
});

const cerrada = () => ({ ...sesion(), closedAt: new Date() });

const alumno    = { esGestor: false, esAlumno: true,  modo: 'visible',     userId: ALUMNO };
const docente   = { esGestor: true,  esAlumno: false, modo: 'visible',     userId: DOCENTE };
const preceptor = { esGestor: false, esAlumno: false, modo: 'visible',     userId: OTRO };
const directivo = { esGestor: false, esAlumno: false, modo: 'observacion', userId: OTRO };

// Los mensajes se distinguen por `authorRole`, que es el snapshot que ya guarda cada uno.
const deDocente   = (extra = {}) => ({ _id: 'm1', kind: 'text', author: DOCENTE, authorRole: 'teacher', ...extra });
const dePreceptor = (extra = {}) => ({ _id: 'm2', kind: 'text', author: OTRO,    authorRole: 'preceptor', ...extra });
const deAlumno    = (extra = {}) => ({ _id: 'm3', kind: 'text', author: OTRO,    authorRole: 'student', ...extra });
const mio         = (extra = {}) => ({ _id: 'm4', kind: 'text', author: ALUMNO,  authorRole: 'student', ...extra });
const delSistema  = (extra = {}) => ({ _id: 'm5', kind: 'system', author: DOCENTE, authorRole: '', ...extra });
const adjunto     = (extra = {}) => ({ _id: 'm6', kind: 'image', author: DOCENTE, authorRole: 'teacher', ...extra });

// ── 1. Permisos ─────────────────────────────────────────────────────────────

test('CA-1 y CA-2: con la palabra apagada el alumno NO escribe y SÍ reacciona', () => {
  // Es el pedido entero en dos líneas. Si alguna vez `puedeReaccionar` volviera a apoyarse en
  // `puedeEscribir`, este test es el que lo caza: el interruptor de la palabra apagaría justo
  // lo que la feature viene a resolver.
  const soloDocente = sesion({ studentsCanWrite: false });
  assert.equal(puedeEscribir(soloDocente, alumno), false, 'la palabra sigue apagada');
  assert.equal(puedeReaccionar(soloDocente, deDocente(), alumno), true,
    'con la sala en "solo docente", el emoji es la única vía que le queda al alumno');
});

test('CA-3 y CA-4: el alumno reacciona a los mensajes del personal, no a los de la clase', () => {
  assert.equal(puedeReaccionar(sesion(), deDocente(),   alumno), true,  'al del docente, sí');
  assert.equal(puedeReaccionar(sesion(), dePreceptor(), alumno), true,  'al de preceptoría también: es personal');
  assert.equal(puedeReaccionar(sesion(), deAlumno(),    alumno), false, 'al de un compañero, no');
  assert.equal(puedeReaccionar(sesion(), mio(),         alumno), false, 'al propio, tampoco');
});

test('CA-5: un aviso del sistema no es de nadie y no recibe emojis', () => {
  assert.equal(puedeReaccionar(sesion(), delSistema(), alumno),  false);
  assert.equal(puedeReaccionar(sesion(), delSistema(), docente), false, 'ni siquiera la docente');
});

test('D2: los adjuntos del docente también son "lo que sube el docente"', () => {
  assert.equal(puedeReaccionar(sesion(), adjunto(), alumno), true);
});

test('CA-6: para la docente y el personal no cambió nada — reaccionan a cualquier mensaje', () => {
  assert.equal(puedeReaccionar(sesion(), deAlumno(), docente),   true);
  assert.equal(puedeReaccionar(sesion(), deAlumno(), preceptor), true);
  assert.equal(puedeReaccionar(sesion({ studentsCanWrite: false }), deAlumno(), docente), true,
    'su propio interruptor no la alcanza a ella');
});

test('CA-7: silenciar a alguien lo silencia entero, también para reaccionar', () => {
  const conMudo = sesion({}, [ALUMNO]);
  assert.equal(puedeReaccionar(conMudo, deDocente(), alumno), false, 'el silenciado no reacciona');
  assert.equal(puedeReaccionar(conMudo, deDocente(), { ...alumno, userId: OTRO }), true,
    'y el resto de la clase sigue igual');
});

test('CA-8 y CA-9: el interruptor de la docente manda, y una sesión vieja se comporta como prendida', () => {
  const apagadas = sesion({ reactionsOn: false });
  assert.equal(puedeReaccionar(apagadas, deDocente(), alumno),  false);
  assert.equal(puedeReaccionar(apagadas, deDocente(), docente), false, 'apagadas es para todos');

  // `!== false` y no `=== true`: la trampa que ya se cobró una vez con studentsCanShareImages.
  const vieja = { _id: 's', closedAt: null, settings: {}, mutedStudents: [] };
  assert.equal(puedeReaccionar(vieja, deDocente(), alumno), true,
    'una sala abierta antes del despliegue no tiene el campo y tiene que seguir funcionando');
});

test('CA-11 y CA-2 de la sala: ni lo borrado ni la sala cerrada reciben reacciones', () => {
  assert.equal(puedeReaccionar(sesion(), deDocente({ deletedAt: new Date() }), alumno), false,
    'colgarle emojis al hueco sería devolver lo que la moderación sacó');
  assert.equal(puedeReaccionar(cerrada(), deDocente(), alumno),  false);
  assert.equal(puedeReaccionar(cerrada(), deDocente(), docente), false);
  assert.equal(puedeReaccionar(null,      deDocente(), docente), false, 'sin sala no hay nada');
});

test('CA-15: mirar sin aparecer implica no dejar rastro', () => {
  assert.equal(puedeReaccionar(sesion(), deDocente(), directivo), false);
});

test('la paleta es cerrada y entra en un celular', () => {
  assert.ok(EMOJIS.length > 0 && EMOJIS.length <= 12,
    'más de 12 no entra en dos filas en 360 px; la lista cerrada es lo que valida el POST');
  assert.equal(new Set(EMOJIS).size, EMOJIS.length, 'sin repetidos: el toggle se vuelve ambiguo');
});

// ── 2. La ventana ───────────────────────────────────────────────────────────

test('CA-14: la ventana de reacciones aguanta el poll MÁS LENTO', () => {
  // El intervalo real entre dos polls no es POLL_MS: en reposo la cadencia se afloja al doble
  // (RN-4 de specs/sala-en-vivo-escala.spec.md). Si la ventana quedara por debajo de ESE
  // número, una reacción caería en el hueco entre dos vueltas y no la vería nadie —y el
  // síntoma sería "a veces la reacción no aparece", que es de los peores de diagnosticar.
  const pollLento = POLL_MS * 2;
  assert.ok(VENTANA_REACCIONES_MS > pollLento,
    `la ventana (${VENTANA_REACCIONES_MS} ms) tiene que superar al poll lento (${pollLento} ms)`);
  assert.ok(VENTANA_REACCIONES_MS >= pollLento * 2,
    'y con margen para una vuelta perdida, no justo al borde');
});

// ── 3. El marcado ───────────────────────────────────────────────────────────

test('el botón de reaccionar sale del permiso que manda el servidor', () => {
  // Mismo criterio que "borrar" y que el botón de la cámara: la regla vive en un solo lado. Con
  // una copia en la vista, alcanza con que una de las dos quede vieja para ofrecer un botón que
  // contesta 403.
  assert.match(sala, /m\.puedoReaccionar/,
    'el "+" tiene que colgar de lo que dice el mensaje, no de una regla recableada acá');
  assert.ok(!/authorRole|STAFF_ROLES/.test(sala),
    'la vista no puede decidir por su cuenta si un mensaje es del docente');
});

test('existe el selector, es UNO SOLO y vive fuera del chat', () => {
  assert.match(sala, /id="lrPicker"/, 'el selector tiene que existir: sin él no se crea ninguna reacción');
  assert.match(sala, /data-elegir-emoji/, 'y sus caritas tienen que ser elegibles');

  // Uno por burbuja serían 1.200 botones con 100 mensajes en pantalla. Y adentro del chat, el
  // innerHTML del repintado se lo llevaría puesto.
  const chat = sala.slice(sala.indexOf('id="lrChat"'));
  assert.ok(chat.indexOf('id="lrPicker"') === -1 || chat.indexOf('id="lrPicker"') > chat.indexOf('</div>'),
    'el selector no puede vivir adentro del chat');
  assert.match(sala, /cerrarPicker\(\);\s*chat\.innerHTML = ''/,
    'antes de vaciar el chat hay que devolver el selector a su casa');
});

test('RN-6: reaccionar no vuelve a descargar la conversación entera', () => {
  // Acá había un repintarTodo(), que pide los 100 últimos mensajes. Con el botón a la vista de
  // treinta chicos, cada carita costaría una descarga entera del chat por cada persona.
  const i = sala.indexOf('async function reaccionar(');
  assert.ok(i > 0, 'la función que manda la reacción tiene que existir');
  const cuerpo = sala.slice(i, sala.indexOf('\n  }', i));
  assert.ok(!/repintarTodo/.test(cuerpo),
    'reaccionar tiene que repintar SOLO ese mensaje: la respuesta del POST ya lo trae');
  assert.match(cuerpo, /aplicarReacciones/);
});

test('las reacciones que llegan por el poll se aplican', () => {
  // Sin esto, la reacción de un compañero no llega nunca: el cursor del poll va por `seq` y una
  // reacción no crea ningún mensaje. Es la mitad que faltaba de la feature.
  assert.match(sala, /aplicarReacciones\(s\.reacciones\)/,
    'el poll tiene que aplicar el bloque de reacciones que manda el servidor');
});

test('el interruptor de la docente está cableado en los dos sentidos', () => {
  assert.match(sala, /id="lrReacciones"/, 'el botón tiene que existir: reactionsOn no tenía ninguno');
  assert.match(sala, /reactionsOn: !permitidas/, 'y tiene que mandar el valor contrario al actual');
  assert.match(sala, /reaccionesVistas !== reaccionesOn/,
    'al cambiar el interruptor hay que repintar: el permiso viaja adentro de cada mensaje');
});
