// Tests de la lógica pura de la sala en vivo (services/liveRoom.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Estas funciones se testean acá y no con un smoke HTTP porque dependen del PASO DEL TIEMPO:
// la ventana de "conectado ahora" y el autocierre a las 3 h necesitan poder inyectar el
// `now`, cosa que una request real no permite sin esperar tres horas.
//
// Cubren los criterios CA-01 a CA-06 de specs/sala-en-vivo.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  isOnline, presenceSummary, shouldAutoClose, sanitizeText, minutosPresente,
  hora, fechaDia, fechaLarga, fechaCorta, fechaHora, TZ,
  ONLINE_WINDOW_MS, STAFF_ONLINE_WINDOW_MS, AUTO_CLOSE_MS, MSG_MAX, POLL_MS,
  pesoLegible, etiquetaExt, textoAdjunto, csvTranscripcion,
  EXT_ARCHIVOS, MAX_ARCHIVO_BYTES,
} = require('../../services/liveRoom');

const AHORA = new Date('2026-08-06T14:30:00Z');
const haceMs = (ms) => new Date(AHORA.getTime() - ms);

// ── CA-01: ventana de "conectado ahora" ──────────────────────────────────────

test('isOnline: un ping de hace 10 s cuenta como conectado', () => {
  assert.strictEqual(isOnline(haceMs(10 * 1000), AHORA), true);
});

test('isOnline: un ping de hace 60 s ya no cuenta', () => {
  assert.strictEqual(isOnline(haceMs(60 * 1000), AHORA), false);
});

test('isOnline: el borde de 45 s es inclusivo', () => {
  assert.strictEqual(isOnline(haceMs(ONLINE_WINDOW_MS), AHORA), true);
  assert.strictEqual(isOnline(haceMs(ONLINE_WINDOW_MS + 1), AHORA), false);
});

test('isOnline: sin ping, o con una fecha basura, no rompe', () => {
  assert.strictEqual(isOnline(null, AHORA), false);
  assert.strictEqual(isOnline(undefined, AHORA), false);
  assert.strictEqual(isOnline('no es una fecha', AHORA), false);
});

test('isOnline: la ventana es un parámetro y por default es la de los alumnos', () => {
  assert.strictEqual(isOnline(haceMs(90 * 1000), AHORA), false);
  assert.strictEqual(isOnline(haceMs(90 * 1000), AHORA, STAFF_ONLINE_WINDOW_MS), true);
  assert.ok(STAFF_ONLINE_WINDOW_MS > ONLINE_WINDOW_MS,
    'la ventana del personal tiene que ser más tolerante que la de los alumnos');
});

// ── El docente que se va a otra solapa de su materia sigue en la sala ────────
//
// Reclamo del usuario (2026-08-13): la docente abre la sala, se va a Novedades o Actividades,
// y a los 45 s desaparecía de la sala para todos — que se lee como "cerró la clase". El latido
// del cliente pingea cada 20 s, pero con la pestaña del navegador en segundo plano Chrome lo
// baja a uno por minuto: por eso el personal se mide con una ventana de 3 minutos.
// Los tests van contra la CONSTANTE y no contra el número, para que ajustarla no los rompa.

test('presenceSummary: el docente sigue conectado con un ping de hace 90 s', () => {
  const r = presenceSummary(
    [presencia('prof', 'teacher', 90 * 1000), presencia('a1', 'student', 90 * 1000)],
    roster25, AHORA
  );
  assert.strictEqual(r.conectados.length, 1, 'solo la docente sigue en la sala');
  assert.strictEqual(r.conectados[0].rol, 'teacher');
  assert.strictEqual(r.presentes, 0, 'el alumno con el mismo ping sí se cae: su ventana es 45 s');
});

test('presenceSummary: pasada su propia ventana, el docente también se cae', () => {
  const r = presenceSummary(
    [presencia('prof', 'teacher', STAFF_ONLINE_WINDOW_MS + 1000)],
    roster25, AHORA
  );
  assert.strictEqual(r.conectados.length, 0,
    'la ventana larga es una tolerancia, no "siempre presente"');
});

test('presenceSummary: la tolerancia vale para todo el personal, no solo el docente', () => {
  const r = presenceSummary(
    [presencia('prec', 'preceptor', 90 * 1000), presencia('dir', 'directivo', 90 * 1000)],
    roster25, AHORA
  );
  assert.strictEqual(r.conectados.length, 2);
});

// ── CA-02: el docente aparece primero pero no suma a "presentes" ─────────────

const alumno = (n) => ({ _id: `a${n}`, name: `Alumno ${n}`, avatar: null });
const roster25 = Array.from({ length: 25 }, (_, i) => alumno(i + 1));

const presencia = (userId, role, msDesdeUltimoPing, msDesdeIngreso = 60 * 60 * 1000) => ({
  user: userId,
  userName: userId === 'prof' ? 'Prof. Gómez' : `Alumno ${String(userId).slice(1)}`,
  userRole: role,
  firstSeenAt: haceMs(msDesdeIngreso),
  lastPingAt:  haceMs(msDesdeUltimoPing),
  pings: 10,
});

test('presenceSummary: cuenta solo alumnos y pone al docente primero', () => {
  const presences = [
    presencia('a1', 'student', 5 * 1000),
    presencia('a2', 'student', 5 * 1000),
    presencia('a3', 'student', 5 * 1000),
    presencia('a4', 'student', 5 * 60 * 1000),   // se desconectó hace 5 min
    presencia('prof', 'teacher', 5 * 1000),
  ];

  const r = presenceSummary(presences, roster25, AHORA);

  assert.strictEqual(r.presentes, 3, 'la docente no suma al conteo de alumnos presentes');
  assert.strictEqual(r.total, 25);
  assert.strictEqual(r.conectados[0].rol, 'teacher', 'la docente va primera en la fila');
  assert.strictEqual(r.conectados[0].etiqueta, 'Docente');
  assert.strictEqual(r.conectados.length, 4, '3 alumnos + la docente');
  // El que dejó de pollear sigue existiendo, pero del lado de los ausentes.
  assert.ok(r.ausentes.some(a => a.id === 'a4'));
  assert.strictEqual(r.ausentes.length, 22);
});

test('presenceSummary: el preceptor también es personal, no alumno presente', () => {
  const r = presenceSummary(
    [presencia('a1', 'student', 1000), presencia('prec', 'preceptor', 1000)],
    roster25, AHORA
  );
  assert.strictEqual(r.presentes, 1);
  assert.strictEqual(r.conectados[0].rol, 'preceptor');
  assert.strictEqual(r.conectados[0].etiqueta, 'Preceptoría');
});

test('presenceSummary: las iniciales salen en mayúscula y toleran nombres vacíos', () => {
  const r = presenceSummary([presencia('a1', 'student', 1000)], [alumno(1)], AHORA);
  assert.strictEqual(r.conectados[0].inicial, 'A');
  const vacio = presenceSummary([], [{ _id: 'x', name: '' }], AHORA);
  assert.strictEqual(vacio.ausentes[0].inicial, '—');
});

// ── CA-03: materia sin alumnos ──────────────────────────────────────────────

test('presenceSummary: una materia sin alumnos da 0 de 0, sin NaN', () => {
  const r = presenceSummary([], [], AHORA);
  assert.strictEqual(r.presentes, 0);
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.conectados, []);
  assert.deepStrictEqual(r.ausentes, []);
  assert.ok(!Number.isNaN(r.presentes) && !Number.isNaN(r.total));
});

test('presenceSummary: sin argumentos no explota', () => {
  const r = presenceSummary();
  assert.strictEqual(r.presentes, 0);
  assert.strictEqual(r.total, 0);
});

// ── CA-04: autocierre ───────────────────────────────────────────────────────

test('shouldAutoClose: a las 2 h 59 min todavía no', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS - 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

test('shouldAutoClose: a las 3 h 01 min sí', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS + 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), true);
});

test('shouldAutoClose: una sesión ya cerrada nunca se vuelve a cerrar', () => {
  const s = { closedAt: haceMs(1000), lastActivityAt: haceMs(AUTO_CLOSE_MS * 10) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

test('shouldAutoClose: sin lastActivityAt usa openedAt', () => {
  const s = { closedAt: null, openedAt: haceMs(AUTO_CLOSE_MS + 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), true);
});

test('shouldAutoClose: sin sesión devuelve false, no rompe', () => {
  assert.strictEqual(shouldAutoClose(null, AHORA), false);
  assert.strictEqual(shouldAutoClose(undefined, AHORA), false);
});

// ── CA-05: normalización del texto ──────────────────────────────────────────

test('sanitizeText: corta en el máximo', () => {
  assert.strictEqual(sanitizeText('x'.repeat(800)).length, MSG_MAX);
});

test('sanitizeText: solo espacios queda vacío', () => {
  assert.strictEqual(sanitizeText('   '), '');
  assert.strictEqual(sanitizeText('\n\n\t  \n'), '');
});

test('sanitizeText: colapsa cascadas de Enter a un renglón en blanco', () => {
  assert.strictEqual(sanitizeText('hola\n\n\n\n\n\nchau'), 'hola\n\nchau');
});

test('sanitizeText: normaliza saltos de Windows', () => {
  assert.strictEqual(sanitizeText('a\r\nb'), 'a\nb');
});

test('sanitizeText: entradas que no son string devuelven vacío', () => {
  assert.strictEqual(sanitizeText(null), '');
  assert.strictEqual(sanitizeText(undefined), '');
  assert.strictEqual(sanitizeText(42), '');
  assert.strictEqual(sanitizeText({}), '');
});

test('sanitizeText: conserva emojis enteros', () => {
  assert.strictEqual(sanitizeText('presente 👋 profe'), 'presente 👋 profe');
});

// ── CA-06: el texto NO se escapa acá ────────────────────────────────────────

test('sanitizeText: no escapa HTML — de eso se encarga la vista con <%= %>', () => {
  const payload = '<script>alert(1)</script>';
  assert.strictEqual(sanitizeText(payload), payload);
});

// ── Permanencia estimada ────────────────────────────────────────────────────

test('minutosPresente: sale de los pings, no de la resta de fechas', () => {
  // 15 pings × 4 s = 60 s = 1 minuto.
  assert.strictEqual(minutosPresente({ pings: 15 }), 1);
  // 150 pings × 4 s = 600 s = 10 minutos.
  assert.strictEqual(minutosPresente({ pings: 150 }), 10);
  assert.strictEqual(POLL_MS, 4000, 'si cambia POLL_MS, estos números cambian');
});

test('minutosPresente: quien entró y se fue enseguida cuenta 1, no 0', () => {
  assert.strictEqual(minutosPresente({ pings: 1 }), 1);
  assert.strictEqual(minutosPresente({}), 1);
  assert.strictEqual(minutosPresente(null), 1);
});

// ── Hora de la sala ─────────────────────────────────────────────────────────
//
// El bug: la hora la formateaba cada navegador con su propia zona horaria, así que el mismo
// mensaje se veía a una hora distinta en cada máquina del aula. Ahora la arma el servidor con
// la zona fija de la escuela. Estos tests fijan ESE contrato: para un mismo instante, siempre
// la misma hora, sin importar el reloj de quien mira.

// 17:05 UTC = 14:05 en Buenos Aires (UTC−3, sin horario de verano).
const INSTANTE = new Date('2026-08-06T17:05:00Z');

test('hora: el mismo instante da siempre la misma hora, no la del que mira', () => {
  assert.strictEqual(TZ, 'America/Argentina/Buenos_Aires');
  assert.strictEqual(hora(INSTANTE), '14:05');
  // Da igual cómo llegue el instante: Date, ISO o milisegundos son el mismo momento.
  assert.strictEqual(hora(INSTANTE.toISOString()), '14:05');
  assert.strictEqual(hora(INSTANTE.getTime()), '14:05');
});

test('hora: medianoche es 00:xx y no 24:xx', () => {
  assert.strictEqual(hora(new Date('2026-08-07T03:10:00Z')), '00:10');
});

test('hora: cruzar la medianoche también cambia el día', () => {
  // 02:30 UTC del 7 todavía son las 23:30 del 6 en la escuela.
  const cruce = new Date('2026-08-07T02:30:00Z');
  assert.strictEqual(hora(cruce), '23:30');
  assert.strictEqual(fechaCorta(cruce), '06/08/2026');
});

test('fechas: día, larga y corta, todas en la zona de la escuela', () => {
  assert.strictEqual(fechaDia(INSTANTE),   'jueves, 6 de agosto');
  assert.strictEqual(fechaLarga(INSTANTE), 'jueves, 6 de agosto de 2026');
  assert.strictEqual(fechaCorta(INSTANTE), '06/08/2026');
  assert.strictEqual(fechaHora(INSTANTE),  '06/08/2026, 14:05:00');
});

test('fechas: una fecha nula o basura devuelve vacío, no "Invalid Date"', () => {
  for (const f of [hora, fechaDia, fechaLarga, fechaCorta, fechaHora]) {
    assert.strictEqual(f(null), '');
    assert.strictEqual(f(undefined), '');
    assert.strictEqual(f('no es una fecha'), '');
  }
});

// ── Adjuntos de la sala ─────────────────────────────────────────────────────
//
// Los adjuntos se agregaron después de la spec original (que los excluía a propósito). Lo
// que se testea acá es lo que se imprime: el peso y la extensión salen a la card que ve la
// clase y al CSV que se lleva la docente, así que un formato roto se ve enseguida pero un
// "NaN" o un "Invalid" tarda en aparecer, porque solo pasa con datos de borde.

test('pesoLegible: KB abajo del mega, MB con coma decimal arriba', () => {
  assert.strictEqual(pesoLegible(1024 * 840), '840 KB');
  assert.strictEqual(pesoLegible(1.4 * 1024 * 1024), '1,4 MB');
  assert.strictEqual(pesoLegible(20 * 1024 * 1024), '20,0 MB');
});

test('pesoLegible: un archivo chiquito no dice "0 KB" ni redondea a cero', () => {
  assert.strictEqual(pesoLegible(1), '1 KB');
  assert.strictEqual(pesoLegible(900), '1 KB');
});

test('pesoLegible: sin dato devuelve "0 KB", nunca NaN', () => {
  for (const v of [null, undefined, 0, -5, 'muchos', NaN, Infinity]) {
    const r = pesoLegible(v);
    assert.ok(!/NaN|Infinity|undefined/.test(r), `pesoLegible(${String(v)}) devolvió "${r}"`);
  }
  assert.strictEqual(pesoLegible(null), '0 KB');
});

test('etiquetaExt: la extensión sube a mayúsculas y pierde el punto', () => {
  assert.strictEqual(etiquetaExt('.docx'), 'DOCX');
  assert.strictEqual(etiquetaExt('.pdf'),  'PDF');
});

test('etiquetaExt: sin extensión dice ARCHIVO, no queda vacía', () => {
  // La card tiene un recuadro fijo para esto: vacío se vería como un error de la pantalla.
  assert.strictEqual(etiquetaExt(''), 'ARCHIVO');
  assert.strictEqual(etiquetaExt(null), 'ARCHIVO');
});

test('textoAdjunto: la transcripción nombra el archivo, con tipo y peso', () => {
  assert.strictEqual(
    textoAdjunto({ kind: 'image', attachment: { name: 'pizarron.webp', bytes: 245760 } }),
    '[Imagen] pizarron.webp (240 KB)');
  assert.strictEqual(
    textoAdjunto({ kind: 'file', attachment: { name: 'guía tp3.pdf', bytes: 1024 * 1024 } }),
    '[Archivo] guía tp3.pdf (1,0 MB)');
});

test('textoAdjunto: un mensaje de texto no es un adjunto y devuelve vacío', () => {
  assert.strictEqual(textoAdjunto({ kind: 'text', text: 'hola' }), '');
  assert.strictEqual(textoAdjunto({ kind: 'system', text: 'abrió la sala' }), '');
  assert.strictEqual(textoAdjunto(null), '');
});

test('csvTranscripcion: un adjunto deja constancia en el CSV, no una fila vacía', () => {
  // Sin esto, una clase donde la docente compartió el material se exporta como si hubiera
  // estado callada: el registro mentiría por omisión.
  const csv = csvTranscripcion([
    { seq: 1, kind: 'text',  authorName: 'DOCENTE, Ana', authorRole: 'teacher',
      text: 'buen día', createdAt: new Date('2026-08-06T17:05:00Z') },
    { seq: 2, kind: 'image', authorName: 'DOCENTE, Ana', authorRole: 'teacher',
      text: '', attachment: { name: 'pizarron.webp', bytes: 245760 },
      createdAt: new Date('2026-08-06T17:06:00Z') },
    { seq: 3, kind: 'file',  authorName: 'DOCENTE, Ana', authorRole: 'teacher',
      text: '', attachment: { name: 'tp3.pdf', bytes: 1024 * 1024 },
      createdAt: new Date('2026-08-06T17:07:00Z'), deletedAt: new Date() },
  ]);

  assert.ok(csv.includes('[Imagen] pizarron.webp (240 KB)'));
  assert.ok(csv.includes('[Archivo] tp3.pdf (1,0 MB)'));
  // El eliminado se incluye MARCADO, igual que un mensaje de texto borrado (RN-12).
  assert.ok(csv.includes('Eliminado'));
  assert.ok(!/NaN|undefined/.test(csv), 'el CSV no puede tener NaN ni undefined');
});

test('extensiones aceptadas: nada ejecutable ni interpretable como HTML', () => {
  // La lista cerrada es la primera defensa de la ruta que sirve los archivos. Que esto sea
  // un test y no un comentario es lo que impide que alguien agregue '.html' de buena fe.
  for (const prohibida of ['.exe', '.bat', '.cmd', '.sh', '.js', '.html', '.htm', '.svg', '.php']) {
    assert.ok(!EXT_ARCHIVOS.includes(prohibida), `${prohibida} no puede estar permitida`);
  }
  assert.ok(EXT_ARCHIVOS.includes('.pdf'));
  assert.ok(EXT_ARCHIVOS.every(e => e.startsWith('.') && e === e.toLowerCase()),
    'las extensiones se comparan en minúscula y con punto');
});

test('el techo de los archivos es 20 MB, el mismo que las entregas', () => {
  assert.strictEqual(MAX_ARCHIVO_BYTES, 20 * 1024 * 1024);
});
