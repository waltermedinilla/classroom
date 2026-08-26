// Tests de la grilla horaria (services/recursos/horario.js).
// Correr con: npm run test:unit
//
// Todo puro: generar la grilla, validarla y consultarla. No hay base ni HTTP de por medio, y
// por eso se puede probar el caso que en una pantalla no se ve — una grilla con un hueco de
// diez minutos que nadie nota hasta que un docente reserva "3ª hora" y llega a las 9:20.
//
// Cubre los criterios CA-01 a CA-06 de specs/recursos-reservas.spec.md.

const test   = require('node:test');
const assert = require('node:assert');

const {
  generarFranjas, correrTurno, PRESET_4118, validarHorario,
  turnoDe, modulosDeClase, moduloDe, horarioCargado,
  aMinutos, aHHMM, horaValida,
} = require('../../services/recursos/horario');

// ── CA-01: la grilla real de la escuela ─────────────────────────────────────
//
// El horario que dictó el usuario: 7 módulos de 40' y 2 recreos de 10', con el patrón
// 2 módulos · recreo · 2 módulos · recreo · 3 módulos. Cierra CLAVADO contra el rango
// (7×40 + 2×10 = 300 min = 5 h), y eso es lo que permite que la validación de continuidad
// sea estricta en vez de perdonar diferencias.

test('generarFranjas reproduce el turno mañana de la escuela, exacto', () => {
  const f = generarFranjas({ desde: '08:00', hasta: '13:00', recreosDespuesDe: [2, 4] });

  assert.strictEqual(f.length, 9, 'siete módulos y dos recreos');
  assert.strictEqual(f.filter(x => x.tipo === 'clase').length, 7);
  assert.strictEqual(f.filter(x => x.tipo === 'recreo').length, 2);

  assert.deepStrictEqual(
    f.map(x => `${x.desde}-${x.hasta}`),
    ['08:00-08:40', '08:40-09:20', '09:20-09:30', '09:30-10:10', '10:10-10:50',
     '10:50-11:00', '11:00-11:40', '11:40-12:20', '12:20-13:00'],
  );
  // La última franja tiene que morir justo en el fin del turno. Si no, la validación de
  // continuidad va a fallar y la escuela no va a poder guardar su propio horario.
  assert.strictEqual(f[f.length - 1].hasta, '13:00');
});

test('el turno tarde es el mismo patrón corrido seis horas', () => {
  const p = PRESET_4118();
  const [manana, tarde] = p.turnos;

  assert.strictEqual(tarde.desde, '14:00');
  assert.strictEqual(tarde.hasta, '19:00');
  assert.strictEqual(tarde.franjas.length, manana.franjas.length);

  // correrTurno tiene que dar exactamente lo mismo que generar el turno de cero: es el
  // botón "copiar del anterior", y si difiriera, copiar produciría un horario distinto del
  // que se ve al generarlo.
  const copiado = correrTurno(manana, 6 * 60, { id: 'tarde', label: 'Turno Tarde' });
  assert.deepStrictEqual(
    copiado.franjas.map(f => `${f.desde}-${f.hasta}`),
    tarde.franjas.map(f => `${f.desde}-${f.hasta}`),
  );
});

test('el recreo que no entra completo antes del fin del turno no se agrega', () => {
  // 08:00 a 09:30 con módulos de 40' entran dos (8:00-8:40 y 8:50-9:30) con un recreo de 10
  // en el medio. Después del segundo NO queda lugar para otro recreo: no tiene que aparecer
  // uno colgando fuera de horario.
  const f = generarFranjas({ desde: '08:00', hasta: '09:30', recreosDespuesDe: [1, 2] });
  assert.strictEqual(f[f.length - 1].tipo, 'clase');
  assert.strictEqual(f[f.length - 1].hasta, '09:30');
});

// ── CA-02: el preset se valida a sí mismo ───────────────────────────────────
test('el horario que ofrece la pantalla pasa su propia validación', () => {
  const { ok, errores } = validarHorario(PRESET_4118());
  assert.strictEqual(ok, true, 'el preset no puede nacer inválido: ' + errores.join(' | '));
});

// ── CA-03: huecos y superposiciones ─────────────────────────────────────────
//
// Es el motivo por el que los recreos viven EN la grilla. Sin la franja del recreo, entre
// 2ª y 3ª hora queda un agujero de 10 minutos que la pantalla dibuja como si fueran
// contiguas.

test('sacar el recreo deja un hueco y se rechaza, diciendo dónde', () => {
  const h = PRESET_4118();
  h.turnos[0].franjas.splice(2, 1);          // fuera el recreo de 09:20-09:30

  const { ok, errores } = validarHorario(h);
  assert.strictEqual(ok, false);
  assert.match(errores[0], /hueco/i);
  assert.match(errores[0], /09:20/);
  assert.match(errores[0], /09:30/);
});

test('dos franjas superpuestas se rechazan', () => {
  const h = PRESET_4118();
  h.turnos[0].franjas[1].desde = '08:30';    // 2ª hora arranca antes de que termine la 1ª

  const { ok, errores } = validarHorario(h);
  assert.strictEqual(ok, false);
  assert.ok(errores.some(e => /superpone/i.test(e)), errores.join(' | '));
});

test('las franjas tienen que llegar hasta el fin del turno', () => {
  const h = PRESET_4118();
  h.turnos[0].franjas.pop();                 // sin la 7ª hora, la mañana termina 12:20

  const { ok, errores } = validarHorario(h);
  assert.strictEqual(ok, false);
  assert.ok(errores.some(e => /12:20/.test(e) && /13:00/.test(e)), errores.join(' | '));
});

test('dos turnos que se pisan se rechazan', () => {
  // Si se pisaran, un mismo instante caería en dos casilleros distintos y "la sala está
  // ocupada a las 12:30" dejaría de tener una sola respuesta.
  const h = PRESET_4118();
  h.turnos[1].desde = '12:00';
  h.turnos[1].franjas = generarFranjas({ desde: '12:00', hasta: '19:00', recreosDespuesDe: [] });

  const { ok, errores } = validarHorario(h);
  assert.strictEqual(ok, false);
  assert.ok(errores.some(e => /superponen/i.test(e)), errores.join(' | '));
});

// ── CA-04: el `orden` de los módulos ────────────────────────────────────────
//
// `orden` es lo que guarda cada reserva. Un salto o un repetido convierte a "3ª hora" en
// algo ambiguo y deja reservas apuntando a nada.

test('los módulos se numeran 1,2,3… sin saltos', () => {
  const h = PRESET_4118();
  h.turnos[0].franjas.filter(f => f.tipo === 'clase')[3].orden = 9;

  const { ok, errores } = validarHorario(h);
  assert.strictEqual(ok, false);
  assert.ok(errores.some(e => /sin saltos|mismo número/i.test(e)), errores.join(' | '));
});

test('los recreos no llevan orden y no cuentan para la numeración', () => {
  const turno = PRESET_4118().turnos[0];
  const clases = modulosDeClase(turno);

  assert.deepStrictEqual(clases.map(f => f.orden), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(turno.franjas.filter(f => f.tipo === 'recreo').every(f => f.orden === null));
});

// ── CA-05: consultar la grilla ──────────────────────────────────────────────
//
// moduloDe() es lo que convierte un {turno, modulo} llegado del navegador en algo que
// existe. Sin esto, un POST armado a mano reservaría la "9ª hora" de un turno de siete.

test('moduloDe encuentra el módulo real y rechaza el inventado', () => {
  const h = PRESET_4118();

  const tercera = moduloDe(h, 'manana', 3);
  assert.strictEqual(tercera.desde, '09:30');
  assert.strictEqual(tercera.hasta, '10:10');

  assert.strictEqual(moduloDe(h, 'manana', 9), null, 'la 9ª hora no existe');
  assert.strictEqual(moduloDe(h, 'manana', 0), null);
  assert.strictEqual(moduloDe(h, 'noche', 1), null, 'el turno noche no existe');
  assert.strictEqual(moduloDe(h, 'manana', 'borrame'), null);
});

test('un recreo NO se puede pedir como módulo', () => {
  // El recreo de 09:20 está en la grilla pero no es reservable. Como no tiene `orden`,
  // moduloDe() no lo puede devolver por ningún número.
  const h = PRESET_4118();
  const ordenes = modulosDeClase(turnoDe(h, 'manana')).map(f => f.orden);
  for (const o of ordenes) {
    assert.notStrictEqual(moduloDe(h, 'manana', o).tipo, 'recreo');
  }
});

test('horarioCargado distingue el horario usable del vacío', () => {
  assert.strictEqual(horarioCargado(null), false);
  assert.strictEqual(horarioCargado({ turnos: [] }), false);
  assert.strictEqual(horarioCargado({ turnos: [{ id: 'x', franjas: [] }] }), false);
  // Un turno con SOLO recreos tampoco sirve: no hay nada que reservar.
  assert.strictEqual(
    horarioCargado({ turnos: [{ id: 'x', franjas: [{ tipo: 'recreo' }] }] }), false,
  );
  assert.strictEqual(horarioCargado(PRESET_4118()), true);
});

// ── CA-06: las horas son strings y ordenan solas ────────────────────────────
test('aMinutos y aHHMM son inversas, y el cero adelante no es cosmético', () => {
  assert.strictEqual(aMinutos('08:40'), 520);
  assert.strictEqual(aHHMM(520), '08:40');
  assert.strictEqual(aHHMM(aMinutos('09:30')), '09:30');

  // Sin el cero adelante, '9:30' > '10:10' como string: la comparación lexicográfica que usa
  // toda la validación diría que la 3ª hora empieza después de la 4ª.
  assert.ok('09:30' < '10:10', 'con cero adelante, orden de string = orden de tiempo');
});

test('horaValida rechaza lo que no es una hora', () => {
  assert.ok(horaValida('00:00') && horaValida('23:59'));
  assert.ok(!horaValida('24:00'));
  assert.ok(!horaValida('8:40'), 'sin cero adelante no vale: rompería el orden');
  assert.ok(!horaValida('08:60'));
  assert.ok(!horaValida(''));
  assert.ok(!horaValida(null));
});
