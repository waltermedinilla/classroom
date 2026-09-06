// El gobernador de ancho de banda (media/aforo.js).
//
// Es el componente que puede tirar abajo la plataforma entera si se equivoca hacia arriba, así
// que se prueba a lo bruto: los cuatro bordes con su valor exacto y ±1, y la monotonía sobre
// 5.000 valores consecutivos.
//
// Los números salen de config/transmision.js. Si algún día cambia el presupuesto, estos tests
// van a fallar por diseño: los bordes están escritos a mano justamente para que un cambio de
// constante no pase inadvertido.

const { test } = require('node:test');
const assert   = require('node:assert');

const aforo = require('../../media/aforo');
const { PRESUPUESTO_MBPS, MAX_CLASES } = require('../../config/transmision');

// ── Los bordes ───────────────────────────────────────────────────────────────
//
// 360p: 0,432 Mbit/s × n ≤ 96   →  n ≤ 222
// 180p: 0,157 Mbit/s × n ≤ 128  →  n ≤ 815
// audio: 0,032 Mbit/s × n ≤ 152 →  n ≤ 4750

test('el presupuesto es el que dice la spec', () => {
  assert.strictEqual(PRESUPUESTO_MBPS, 160);
});

test('borde de 360p: 222 entra, 223 ya no', () => {
  assert.strictEqual(aforo.capaPermitida(222), '360p');
  assert.strictEqual(aforo.capaPermitida(223), '180p');
});

test('borde de 180p: 815 entra, 816 ya no', () => {
  assert.strictEqual(aforo.capaPermitida(815), '180p');
  assert.strictEqual(aforo.capaPermitida(816), 'audio');
});

test('borde de audio: 4750 entra, 4751 se rechaza', () => {
  assert.strictEqual(aforo.capaPermitida(4750), 'audio');
  assert.strictEqual(aforo.capaPermitida(4751), null);
});

test('con nadie mirando se da la mejor capa', () => {
  assert.strictEqual(aforo.capaPermitida(0), '360p');
  assert.strictEqual(aforo.capaPermitida(1), '360p');
});

// ── ⭐ La conclusión que ordena toda la feature ──────────────────────────────

test('⭐ la escuela ENTERA entra, en 180p, con más de la mitad del puerto libre', () => {
  // 450 alumnos es toda la matrícula de la 4-118 mirando al mismo tiempo — un escenario que en
  // la práctica no va a pasar nunca. Este test es el que documenta que el rechazo del último
  // escalón es una red de seguridad y no un límite operativo.
  const d = aforo.decidir(450, { clases: 15 });
  assert.strictEqual(d.capa, '180p');
  assert.ok(d.mbps > 70 && d.mbps < 72, `esperaba ~70,7 Mbit/s y dio ${d.mbps}`);
  assert.ok(d.ocupacion > 43 && d.ocupacion < 45, `esperaba ~44 % y dio ${d.ocupacion}`);
});

test('un aula de 30 en 360p entra holgada', () => {
  const d = aforo.decidir(30, { clases: 1 });
  assert.strictEqual(d.capa, '360p');
  assert.ok(d.mbps > 12.9 && d.mbps < 13.1, `esperaba ~13 Mbit/s y dio ${d.mbps}`);
  assert.strictEqual(d.motivo, '', 'la mejor capa no está degradada');
});

// ── Monotonía: el bug que este diseño existe para no tener ──────────────────

test('⭐ monótona sobre 5.000 valores: más gente nunca devuelve mejor calidad', () => {
  const rango = { '360p': 3, '180p': 2, audio: 1, null: 0 };
  let anterior = Infinity;
  for (let n = 0; n <= 5000; n++) {
    const r = rango[String(aforo.capaPermitida(n))];
    assert.ok(r <= anterior, `en ${n} espectadores la calidad SUBIÓ, y eso hace parpadear la escuela`);
    anterior = r;
  }
});

test('nunca se excede el presupuesto sin rechazar', () => {
  for (let n = 0; n <= 4750; n++) {
    const capa = aforo.capaPermitida(n);
    if (!capa) continue;
    assert.ok(aforo.consumoMbps(n, capa) <= PRESUPUESTO_MBPS,
      `con ${n} espectadores en ${capa} se pasa del presupuesto`);
  }
});

// ── La degradación se explica, no se hace en silencio ───────────────────────

test('la capa degradada viene con motivo y con un mensaje en castellano', () => {
  const d = aforo.decidir(300, { clases: 10 });
  assert.strictEqual(d.capa, '180p');
  assert.strictEqual(d.motivo, 'aforo');
  assert.match(d.mensaje, /calidad baja/i);
  assert.match(d.mensaje, /300/, 'el mensaje dice el número, que es el dato que falta siempre');
});

test('en solo audio el mensaje aclara que se cortaron las cámaras', () => {
  const d = aforo.decidir(1000, { clases: 12 });
  assert.strictEqual(d.capa, 'audio');
  assert.match(d.mensaje, /cámaras/i);
});

test('el rechazo por aforo se distingue del de la red de seguridad', () => {
  const porAforo = aforo.decidir(5000, { clases: 5 });
  assert.strictEqual(porAforo.capa, null);
  assert.strictEqual(porAforo.motivo, 'aforo');

  const porRed = aforo.decidir(10, { clases: MAX_CLASES + 1 });
  assert.strictEqual(porRed.capa, null);
  assert.strictEqual(porRed.motivo, 'red-de-seguridad');
});

test('la red de seguridad manda aunque sobre presupuesto', () => {
  // 10 espectadores no consumen nada, pero 21 clases abiertas es un desborde raro.
  const d = aforo.decidir(10, { clases: MAX_CLASES + 1 });
  assert.strictEqual(d.capa, null);
});

test('justo en el tope de clases todavía se deja pasar', () => {
  const d = aforo.decidir(10, { clases: MAX_CLASES });
  assert.strictEqual(d.capa, '360p');
});

// ── Lo que ve el alumno antes de tocar "Ver la clase" ───────────────────────

test('estimarMB da el número que decide si un chico gasta sus datos', () => {
  // 180p una hora: 0,157 Mbit/s × 3600 s / 8 = ~70 MB. Es el número del cartel de D12.
  assert.strictEqual(aforo.estimarMB('180p', 60), 71);
  assert.strictEqual(aforo.estimarMB('audio', 60), 14);
  assert.strictEqual(aforo.estimarMB('360p', 60), 194);
});

test('estimarMB no revienta con basura', () => {
  assert.strictEqual(aforo.estimarMB('720p', 60), 0, 'una capa que no existe no consume');
  assert.strictEqual(aforo.estimarMB('180p', -5), 0);
  assert.strictEqual(aforo.estimarMB('180p', undefined), 0);
});

// ── Entradas raras: esto corre en el camino caliente ────────────────────────

test('valores basura no tumban el gobernador', () => {
  assert.strictEqual(aforo.capaPermitida(-1), '360p');
  assert.strictEqual(aforo.capaPermitida(undefined), '360p');
  assert.strictEqual(aforo.capaPermitida(NaN), '360p');
  assert.strictEqual(aforo.consumoMbps('abc', '180p'), 0);
});
