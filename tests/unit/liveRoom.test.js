// Tests de la lógica pura de la sala en vivo (services/liveRoom.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Estas funciones se testean acá y no con un smoke HTTP porque dependen del PASO DEL TIEMPO:
// la ventana de "conectado ahora" y el autocierre por inactividad necesitan poder inyectar el
// `now`, cosa que una request real no permite sin quedarse esperando media hora.
//
// Cubren los criterios CA-01 a CA-06 de specs/sala-en-vivo.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  isOnline, presenceSummary, huellaDePresencia, shouldAutoClose, horaDeCierre, gestorEnLinea,
  sanitizeText, minutosPresente, decidirPing,
  hora, fechaDia, fechaLarga, fechaCorta, fechaHora, TZ,
  ONLINE_WINDOW_MS, STAFF_ONLINE_WINDOW_MS, AUTO_CLOSE_MS, MSG_MAX, POLL_MS, PING_WINDOW_MS,
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

test('shouldAutoClose: un minuto antes del límite todavía no', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS - 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

test('shouldAutoClose: un minuto después del límite sí', () => {
  const s = { closedAt: null, lastActivityAt: haceMs(AUTO_CLOSE_MS + 60 * 1000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), true);
});

// Lo que mide el autocierre es SALA VACÍA, no duración de la clase: cualquiera adentro
// refresca lastActivityAt con su poll de 4 s. Si esto se rompiera, una clase larga se cortaría
// sola por la mitad — que es justo el miedo que mantenía la ventana en 3 horas.
test('shouldAutoClose: una clase de 3 horas con gente adentro NO se cierra', () => {
  const s = { closedAt: null, openedAt: haceMs(3 * 60 * 60 * 1000), lastActivityAt: haceMs(4000) };
  assert.strictEqual(shouldAutoClose(s, AHORA), false);
});

// El número puede ajustarse, pero no hasta volver al problema que este cambio arregla: una
// ventana de horas deja el panel de dirección lleno de clases que ya terminaron.
test('la ventana de autocierre está entre la presencia del personal y una hora', () => {
  assert.ok(AUTO_CLOSE_MS > STAFF_ONLINE_WINDOW_MS * 5, 'tiene que tolerar un recreo largo');
  assert.ok(AUTO_CLOSE_MS <= 60 * 60 * 1000, 'más de una hora vuelve a llenar el panel de fantasmas');
});

// ── Hora real de cierre de una sala que se cerró sola ────────────────────────

test('horaDeCierre: el cierre automático usa la última señal de vida, no el ahora', () => {
  const fin = haceMs(2 * 60 * 60 * 1000);
  const s   = { openedAt: haceMs(3 * 60 * 60 * 1000), lastActivityAt: fin };
  assert.strictEqual(horaDeCierre(s, AHORA, { auto: true }).getTime(), fin.getTime());
});

test('horaDeCierre: el cierre a mano es el momento del botón', () => {
  const s = { openedAt: haceMs(90 * 60 * 1000), lastActivityAt: haceMs(60 * 60 * 1000) };
  assert.strictEqual(horaDeCierre(s, AHORA).getTime(), AHORA.getTime());
  assert.strictEqual(horaDeCierre(s, AHORA, { auto: false }).getTime(), AHORA.getTime());
});

test('horaDeCierre: nunca queda antes de la apertura (duración negativa)', () => {
  const abrio = haceMs(60 * 60 * 1000);
  const s = { openedAt: abrio, lastActivityAt: haceMs(90 * 60 * 1000) };
  assert.strictEqual(horaDeCierre(s, AHORA, { auto: true }).getTime(), abrio.getTime());
});

test('horaDeCierre: sin lastActivityAt cae en openedAt; con basura, en el ahora', () => {
  const abierta = haceMs(5 * 60 * 60 * 1000);
  assert.strictEqual(
    horaDeCierre({ openedAt: abierta }, AHORA, { auto: true }).getTime(), abierta.getTime());
  assert.strictEqual(
    horaDeCierre({ lastActivityAt: 'cualquier cosa' }, AHORA, { auto: true }).getTime(),
    AHORA.getTime());
  assert.strictEqual(horaDeCierre(null, AHORA, { auto: true }).getTime(), AHORA.getTime());
});

// ── Sala abierta ≠ docente dando clase ──────────────────────────────────────
//
// Es lo que pinta el chip ámbar de las tarjetas de dirección y preceptoría.

test('gestorEnLinea: la titular con un ping de hace 90 s cuenta', () => {
  const pres = [{ user: 'prof', userRole: 'teacher', lastPingAt: haceMs(90 * 1000) }];
  assert.strictEqual(gestorEnLinea(pres, ['prof'], AHORA), true);
});

test('gestorEnLinea: pasada la ventana del personal, ya no', () => {
  const pres = [{ user: 'prof', userRole: 'teacher',
                  lastPingAt: haceMs(STAFF_ONLINE_WINDOW_MS + 1000) }];
  assert.strictEqual(gestorEnLinea(pres, ['prof'], AHORA), false);
});

test('gestorEnLinea: el suplente también es docente a cargo', () => {
  const pres = [{ user: 'sup', userRole: 'teacher', lastPingAt: haceMs(1000) }];
  assert.strictEqual(gestorEnLinea(pres, ['prof', 'sup'], AHORA), true);
});

// El caso que motivó el chip: la clase terminó, la docente se fue, y el preceptor entró a
// mirar. La sala sigue abierta y con alguien adentro, pero nadie está dictando.
test('gestorEnLinea: preceptoría y alumnos adentro no alcanzan', () => {
  const pres = [
    { user: 'prec', userRole: 'preceptor', lastPingAt: haceMs(1000) },
    { user: 'a1',   userRole: 'student',   lastPingAt: haceMs(1000) },
  ];
  assert.strictEqual(gestorEnLinea(pres, ['prof'], AHORA), false);
});

test('gestorEnLinea: sin presencias, sin gestores o sin argumentos no rompe', () => {
  assert.strictEqual(gestorEnLinea([], ['prof'], AHORA), false);
  assert.strictEqual(gestorEnLinea([{ user: 'prof', lastPingAt: haceMs(1000) }], [], AHORA), false);
  assert.strictEqual(gestorEnLinea(undefined, undefined, AHORA), false);
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

// ── RN-2: la huella de la presencia ─────────────────────────────────────────
//
// El bloque de presencia son 4.981 bytes medidos y viajaba en CADA poll, quince veces por
// minuto y por persona, para decir casi siempre lo mismo. La huella es lo que le permite al
// servidor contestar "es la que ya tenés". Ver specs/sala-en-vivo-escala.spec.md.

test('huellaDePresencia: el mismo contenido da la misma huella', () => {
  const r1 = presenceSummary([presencia('a1', 'student', 1000)], [alumno(1), alumno(2)], AHORA);
  const r2 = presenceSummary([presencia('a1', 'student', 2000)], [alumno(1), alumno(2)], AHORA);
  // Ping distinto, MISMO resultado visible: la huella no puede moverse por algo que no se ve.
  assert.deepEqual(r1, r2);
  assert.equal(huellaDePresencia(r1), huellaDePresencia(r2));
});

test('huellaDePresencia: es estable entre llamadas y mide 16 hex', () => {
  const r = presenceSummary([presencia('a1', 'student', 1000)], roster25, AHORA);
  const h = huellaDePresencia(r);
  assert.equal(h, huellaDePresencia(r), 'dos veces la misma entrada, la misma salida');
  assert.match(h, /^[0-9a-f]{16}$/);
});

test('huellaDePresencia: cambia si se conecta alguien', () => {
  const solo  = presenceSummary([presencia('a1', 'student', 1000)], roster25, AHORA);
  const dos   = presenceSummary([presencia('a1', 'student', 1000), presencia('a2', 'student', 1000)], roster25, AHORA);
  assert.notEqual(huellaDePresencia(solo), huellaDePresencia(dos));
});

test('huellaDePresencia: cambia si se desconecta alguien', () => {
  const dentro = presenceSummary([presencia('a1', 'student', 1000)], roster25, AHORA);
  const fuera  = presenceSummary([presencia('a1', 'student', ONLINE_WINDOW_MS + 5000)], roster25, AHORA);
  assert.notEqual(huellaDePresencia(dentro), huellaDePresencia(fuera));
});

test('⭐ huellaDePresencia: cambia si a un alumno le cambia el NOMBRE', () => {
  // ES EL CASO QUE DECIDIÓ EL DISEÑO. La tentación era hacer la huella con la lista de ids,
  // que es más barata. Pero el roster sale del cache de cursos (RN-1): si la huella solo
  // mirara ids, renombrar a un alumno no la movería y esa pantalla mostraría el nombre viejo
  // PARA SIEMPRE, porque el servidor nunca volvería a mandar la lista.
  //
  // Hasheando el contenido, esto es correcto por construcción y no hay que acordarse de nada.
  const antes   = presenceSummary([presencia('a1', 'student', 1000)], [alumno(1)], AHORA);
  const rebautizado = [{ _id: 'a1', name: 'Otro Nombre', avatar: null }];
  const despues = presenceSummary([presencia('a1', 'student', 1000)], rebautizado, AHORA);

  assert.equal(antes.presentes, despues.presentes, 'los contadores no cambian…');
  assert.notEqual(huellaDePresencia(antes), huellaDePresencia(despues), '…pero la huella sí');
});

test('huellaDePresencia: cambia si se matricula un alumno nuevo', () => {
  const chico = presenceSummary([], [alumno(1), alumno(2)], AHORA);
  const grande = presenceSummary([], [alumno(1), alumno(2), alumno(3)], AHORA);
  assert.notEqual(huellaDePresencia(chico), huellaDePresencia(grande));
});

test('huellaDePresencia: el orden importa (la fila se pinta en ese orden)', () => {
  const a = presenceSummary([], [alumno(1), alumno(2)], AHORA);
  const b = presenceSummary([], [alumno(2), alumno(1)], AHORA);
  assert.notEqual(huellaDePresencia(a), huellaDePresencia(b));
});

test('huellaDePresencia: tolera null sin romper', () => {
  // La sala cerrada arma su propio bloque vacío; que esto no explote es la red de seguridad.
  assert.doesNotThrow(() => huellaDePresencia(null));
  assert.match(huellaDePresencia(null), /^[0-9a-f]{16}$/);
});

// ── RN-2: el cableado, en las dos puntas ────────────────────────────────────

test('RN-2: el navegador manda la huella y solo repinta si vinieron las listas', () => {
  const fs   = require('node:fs');
  const path = require('node:path');
  const sala = fs.readFileSync(
    path.join(__dirname, '..', '..', 'views', 'partials', 'live-room.ejs'), 'utf8');
  const codigo = sala.replace(/\/\/.*$/gm, '');

  assert.match(codigo, /pv=.\s*\+\s*encodeURIComponent\(presenciaVer\)/,
    'el poll tiene que mandar la huella como `pv`');
  assert.match(codigo, /if\s*\(s\.presencia\s*&&\s*s\.presencia\.conectados\)/,
    'solo se repinta cuando el servidor mandó las listas');
  // Guardar la huella ANTES de pintar dejaría al navegador diciendo que tiene algo que nunca
  // llegó a mostrar, y el servidor no se lo mandaría nunca más.
  const bloque = codigo.slice(codigo.indexOf('if (s.presencia && s.presencia.conectados)'));
  assert.ok(bloque.indexOf('pintarPresencia(') < bloque.indexOf('presenciaVer ='),
    'la huella se guarda DESPUÉS de pintar');
});

test('RN-2: el servidor manda los contadores siempre, y las listas solo si cambiaron', () => {
  const fs   = require('node:fs');
  const path = require('node:path');
  const rooms = fs.readFileSync(
    path.join(__dirname, '..', '..', 'routes', 'rooms.js'), 'utf8');

  assert.match(rooms, /function presenciaParaCliente\(presencia, vista\)/,
    'la decisión vive en una función sola');
  assert.match(rooms, /\{ presentes: presencia\.presentes, total: presencia\.total \}/,
    'sin cambios se mandan igual los contadores del cartel "N de M presentes"');
  assert.match(rooms, /req\.query\.pv \|\| null/,
    'la ruta del poll tiene que leer la huella del navegador');

  // El render inicial NO pasa huella: siempre manda todo. Es lo que garantiza que una pestaña
  // recién abierta reciba la fila entera.
  assert.match(rooms, /const estado = await estadoDeSala\(req, session\);/,
    'el render inicial no manda huella');
});

// ── RN-3: cuándo se escribe la presencia, y cuánto tiempo acredita ──────────
//
// Se escribía en CADA poll —dos writes, la presencia y el lastActivityAt de la sesión—, o sea
// quince veces por minuto y por persona. A 930 personas son ~465 escrituras por segundo para
// sostener un dato cuya única exigencia es la ventana de 45 s.
//
// ⚠️ Y acá vive además el arreglo de una REGRESIÓN: el tiempo de permanencia se calculaba como
// `pings × POLL_MS`, una cuenta que suponía que un ping vale siempre 4 segundos. La cadencia
// adaptativa de RN-4 la rompió el mismo día en que se desplegó.

test('decidirPing: quien recién entra se escribe, y todavía no estuvo nada', () => {
  const d = decidirPing(null, AHORA);
  assert.equal(d.escribir, true, 'hay que crear el documento');
  assert.equal(d.acreditar, 0, 'acaba de llegar: no acumuló permanencia');
});

test('decidirPing: con el ping fresco NO se escribe', () => {
  for (const ms of [0, 4000, 8000, PING_WINDOW_MS - 1]) {
    const d = decidirPing({ lastPingAt: haceMs(ms) }, AHORA);
    assert.equal(d.escribir, false, `con un ping de hace ${ms} ms no hay nada que actualizar`);
    assert.equal(d.acreditar, 0);
  }
});

test('decidirPing: el borde de la ventana es inclusivo', () => {
  assert.equal(decidirPing({ lastPingAt: haceMs(PING_WINDOW_MS - 1) }, AHORA).escribir, false);
  assert.equal(decidirPing({ lastPingAt: haceMs(PING_WINDOW_MS) }, AHORA).escribir, true);
});

test('decidirPing: acredita el tiempo REAL transcurrido, no una unidad fija', () => {
  assert.equal(decidirPing({ lastPingAt: haceMs(15000) }, AHORA).acreditar, 15000);
  assert.equal(decidirPing({ lastPingAt: haceMs(30000) }, AHORA).acreditar, 30000);
});

test('⭐ decidirPing: un hueco más largo que la ventana de conectado NO se acredita entero', () => {
  // Es LA regla que sostiene el número de asistencia, y está escrita en models/RoomPresence.js:
  // un alumno que entra al principio, se va y vuelve al final tiene que dar dos minutos, no la
  // clase entera. Un hueco mayor a ONLINE_WINDOW_MS es, por definición, tiempo en el que la
  // persona NO estaba conectada.
  const d = decidirPing({ lastPingAt: haceMs(10 * 60 * 1000) }, AHORA);
  assert.equal(d.escribir, true);
  assert.equal(d.acreditar, ONLINE_WINDOW_MS, 'se acredita el tope, no los 10 minutos');
});

test('decidirPing: un reloj corregido hacia atrás no acredita negativo', () => {
  const d = decidirPing({ lastPingAt: new Date(AHORA.getTime() + 60000) }, AHORA);
  assert.ok(d.acreditar >= 0, `acreditó ${d.acreditar}`);
});

test('⚠️ la ventana de escritura tiene que ser MENOR que la de conectado, con holgura', () => {
  // Si se acercaran, alguien podría caerse de la lista de conectados por no haber alcanzado a
  // escribir todavía. Va contra las constantes, no contra los números.
  assert.ok(PING_WINDOW_MS < ONLINE_WINDOW_MS / 2,
    `PING_WINDOW_MS (${PING_WINDOW_MS}) tiene que dejar al menos 2 escrituras dentro de ${ONLINE_WINDOW_MS}`);
});

// ── minutosPresente y la regresión de RN-4 ──────────────────────────────────

test('minutosPresente: usa msPresente cuando está', () => {
  assert.equal(minutosPresente({ msPresente: 40 * 60000, pings: 7 }), 40,
    'el tiempo acumulado manda sobre el conteo de pings');
});

test('minutosPresente: los documentos VIEJOS siguen con la cuenta de antes', () => {
  // Sin msPresente (documentos anteriores al 2026-09-08) vale pings × POLL_MS. No se migran:
  // migrarlos sería inventar un dato que nunca se midió.
  assert.equal(minutosPresente({ pings: 600 }), 40);
  assert.equal(minutosPresente({}), 1, 'nunca menos de 1 minuto');
});

test('minutosPresente: un documento NUEVO recién creado dice 1 minuto, no cae al respaldo', () => {
  // msPresente en 0 es un valor legítimo (acaba de entrar), distinto de "no existe el campo".
  assert.equal(minutosPresente({ msPresente: 0, pings: 1 }), 1);
});

test('⭐ LA REGRESIÓN: 40 minutos de clase dan 40, pollee a 4 s o a 8 s', () => {
  // Con la cuenta vieja (`pings × POLL_MS`) una clase silenciosa —donde RN-4 afloja a 8 s—
  // reportaba LA MITAD del tiempo real, en el CSV de asistencia que usa la escuela.
  const CLASE_MIN = 40;

  const simular = (cadenciaMs) => {
    let previo = null, msPresente = 0, escrituras = 0, polls = 0;
    for (let t = 0; t <= CLASE_MIN * 60000; t += cadenciaMs) {
      polls++;
      const ahora = new Date(AHORA.getTime() + t);
      const d = decidirPing(previo, ahora);
      if (d.escribir) { msPresente += d.acreditar; escrituras++; previo = { lastPingAt: ahora }; }
    }
    return { polls, escrituras, minutos: minutosPresente({ msPresente }) };
  };

  const rapido = simular(4000);
  const lento  = simular(8000);

  assert.ok(Math.abs(rapido.minutos - CLASE_MIN) <= 1,
    `a 4 s reportó ${rapido.minutos} de ${CLASE_MIN}`);
  assert.ok(Math.abs(lento.minutos - CLASE_MIN) <= 1,
    `a 8 s reportó ${lento.minutos} de ${CLASE_MIN} — ES LA REGRESIÓN QUE ESTE ARREGLO CIERRA`);

  // Y la cuenta vieja, para que quede constancia de por qué se cambió:
  assert.equal(Math.round(rapido.polls * POLL_MS / 60000), 40, 'la cuenta vieja acertaba a 4 s');
  assert.equal(Math.round(lento.polls  * POLL_MS / 60000), 20, 'y erraba por la mitad a 8 s');

  // ⭐ EL INVARIANTE DE RN-3, que es más fuerte que "escribe menos": las escrituras dependen
  // del TIEMPO, no del ritmo del poll. La misma clase escribe lo mismo se pollee a 4 s o a 8 s.
  //
  // De ahí sale que el ahorro NO sea un número fijo: a 4 s recorta ~75% y a 8 s ~50%, porque la
  // ventana es de tiempo absoluto. Confundir eso lleva a prometer un ahorro que no aparece.
  assert.equal(rapido.escrituras, lento.escrituras,
    `las escrituras no pueden depender de la cadencia: ${rapido.escrituras} a 4 s vs ${lento.escrituras} a 8 s`);

  const esperadas = Math.round(CLASE_MIN * 60000 / (PING_WINDOW_MS + 1000));
  assert.ok(Math.abs(rapido.escrituras - esperadas) <= 3,
    `~una escritura por ventana: ${rapido.escrituras}, esperadas ~${esperadas}`);
  assert.ok(rapido.escrituras < rapido.polls / 3,
    `y a 4 s eso es recortar de verdad: ${rapido.escrituras} de ${rapido.polls} polls`);
});
