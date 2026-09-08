// El panel de la sala en vivo: public/js/sala-chart.js.
// Correr con: npm run test:unit
//
// ⭐ LO QUE IMPORTA ACÁ ES `diagnostico()`. Los gráficos son gráficos; el diagnóstico es la
// traducción de los contadores a "qué está interfiriendo", que es lo que el usuario pidió
// poder ver de un vistazo. Es una regla, y las reglas se testean.
//
// Ver specs/monitor-sala-escala.spec.md, la tabla de diagnóstico de los síntomas.

const test   = require('node:test');
const assert = require('node:assert');

const chart = require('../../public/js/sala-chart.js');

// Un resumen sano, como el que devuelve services/salaStats.js.
const sano = (o) => Object.assign({
  polls: 5000, msPorPoll: 3.4, bytesPorPoll: 600,
  salasAbiertas: 12, personasEnSalas: 300,
  palancas: {
    cache:      { pct: 95, queriesAhorradas: 19000, msAhorrados: 54150 },
    presencia:  { pct: 90, bytesAhorrados: 15777000 },
    escrituras: { pct: 74, escriturasAhorradas: 7400 },
  },
  entrega: { mensajes: 120, promMs: 3200, maxMs: 7000, p95: { etiqueta: '≤ 8 s', ms: 8000 } },
  atraso:  { max: 1, pctPollsAtrasados: 3, muyAtrasados: 0, pctMuyAtrasados: 0, umbral: 10 },
}, o);

const nivelesDe = (r) => chart.diagnostico(r).map(h => h.nivel);
const titulos   = (r) => chart.diagnostico(r).map(h => h.titulo).join(' | ');

// ── El diagnóstico ──────────────────────────────────────────────────────────

test('una sala sana no dispara ningún hallazgo', () => {
  const h = chart.diagnostico(sano());
  assert.equal(h.length, 1);
  assert.equal(h[0].nivel, 'ok');
});

test('sin polls dice que no hay nadie, y eso NO es una alerta', () => {
  // Es la diferencia entre "la sala está rota" y "es domingo". Un panel que pinte rojo cuando
  // no hay clase enseña a ignorarlo.
  const h = chart.diagnostico({ polls: 0 });
  assert.equal(h.length, 1);
  assert.equal(h[0].nivel, 'ok');
  assert.match(h[0].titulo, /nadie/i);
});

test('⭐ el atraso REPETIDO es ALERTA: es la firma del congelamiento', () => {
  // Un navegador congelado sigue polleando cada 4-8 s con el mismo `since` viejo, así que
  // aporta decenas de polls muy atrasados por minuto. Lo que delata es la REPETICIÓN.
  const h = chart.diagnostico(sano({
    atraso: { max: 25, pctPollsAtrasados: 88, muyAtrasados: 600, pctMuyAtrasados: 12, umbral: 10 },
  }));
  assert.equal(h[0].nivel, 'alerta');
  assert.match(h[0].titulo, /12% de los polls/);
  assert.match(h[0].detalle, /cursor no está avanzando/i);
});

test('⭐⭐ un PICO suelto de atraso NO es alerta: es una reconexión', () => {
  // LA CORRECCIÓN DEL 2026-09-08, traída por los primeros datos reales. Un pico de 101
  // mensajes de atraso resultó ser UNA reconexión —bajó solo a 6, 4 y 1 en los minutos
  // siguientes— y con el máximo suelto se leía igual que un congelamiento.
  const h = chart.diagnostico(sano({
    atraso: { max: 101, pctPollsAtrasados: 13, muyAtrasados: 1, pctMuyAtrasados: 0.6, umbral: 10 },
  }));
  assert.ok(!h.some(x => x.nivel === 'alerta'),
    `un pico suelto no puede ser alerta: ${titulos(sano({ atraso: { max: 101, muyAtrasados: 1, pctMuyAtrasados: 0.6 } }))}`);
  assert.ok(h.some(x => /reconexion|reconexión/i.test(x.titulo)), 'pero sí se informa');
});

test('un atraso de 1 o 2 no dice nada: es lo normal entre que alguien escribe y el poll llega', () => {
  assert.deepEqual(nivelesDe(sano({
    atraso: { max: 2, pctPollsAtrasados: 10, muyAtrasados: 0, pctMuyAtrasados: 0, umbral: 10 },
  })), ['ok']);
});

test('⭐ una entrega por encima de 20 s es ALERTA', () => {
  const h = chart.diagnostico(sano({
    entrega: { mensajes: 50, promMs: 25000, maxMs: 60000, p95: { etiqueta: '> 20 s', ms: null } },
  }));
  assert.equal(h[0].nivel, 'alerta');
  assert.match(h[0].titulo, /tardan más de 20 s/i);
});

test('una entrega en 8 s NO es un hallazgo: es el ritmo lento de RN-4', () => {
  // Es el falso positivo más fácil de cometer en este panel: 8 s parece mucho y es lo normal.
  assert.deepEqual(nivelesDe(sano({
    entrega: { mensajes: 50, promMs: 5000, maxMs: 8000, p95: { etiqueta: '≤ 8 s', ms: 8000 } },
  })), ['ok']);
});

test('sin mensajes entregados no se diagnostica la entrega', () => {
  assert.deepEqual(nivelesDe(sano({ entrega: { mensajes: 0, p95: null } })), ['ok']);
});

test('⭐ una palanca caída es ALERTA y dice qué mirar', () => {
  const h = chart.diagnostico(sano({
    palancas: { ...sano().palancas, cache: { pct: 4, queriesAhorradas: 10, msAhorrados: 10 } },
  }));
  assert.equal(h[0].nivel, 'alerta');
  assert.match(h[0].titulo, /RN-1/);
  assert.match(h[0].detalle, /TTL|invalida/i);
});

test('una palanca sin ocasiones (pct null) NO se acusa', () => {
  // pct null es "no tuvo nada que hacer", distinto de 0%.
  assert.deepEqual(nivelesDe(sano({
    palancas: { cache: { pct: null }, presencia: { pct: null }, escrituras: { pct: null } },
  })), ['ok']);
});

test('⭐ el ms por poll alto CON el cache sano apunta a una query nueva', () => {
  // Es la lectura cruzada que un número suelto no da: si las palancas andan, el tiempo viene
  // de otro lado.
  const h = chart.diagnostico(sano({ msPorPoll: 45 }));
  assert.ok(h.some(x => /query nueva/i.test(x.detalle)),
    `esperaba el hallazgo de la query nueva, hubo: ${titulos(sano({ msPorPoll: 45 }))}`);
});

test('el ms por poll alto CON el cache caído no acusa a una query nueva', () => {
  // Ahí el tiempo SÍ se explica por la palanca, y decir las dos cosas confundiría.
  const r = sano({ msPorPoll: 45, palancas: { ...sano().palancas, cache: { pct: 5 } } });
  assert.ok(!chart.diagnostico(r).some(x => /query nueva/i.test(x.detalle)));
});

test('los hallazgos vienen ordenados por gravedad', () => {
  const h = chart.diagnostico(sano({
    msPorPoll: 45,                                                                    // aviso
    atraso: { max: 30, pctPollsAtrasados: 90, muyAtrasados: 500, pctMuyAtrasados: 9 }, // alerta
  }));
  assert.equal(h[0].nivel, 'alerta', 'lo grave va primero');
  assert.ok(h.length >= 2);
});

test('el "todo bien" no aparece cuando hay algo que decir', () => {
  // Una reconexión informada es un hallazgo `ok`, pero no es "todo bien": el resumen no tiene
  // que taparlo ni duplicarse con él.
  const h = chart.diagnostico(sano({
    atraso: { max: 40, pctPollsAtrasados: 5, muyAtrasados: 2, pctMuyAtrasados: 0.4, umbral: 10 },
  }));
  const resumenes = h.filter(x => /como dice la spec/i.test(x.titulo));
  assert.equal(resumenes.length, 1, 'el resumen general sigue estando una sola vez');
  assert.equal(h[0].nivel, 'ok');
});

// ── Los gráficos ────────────────────────────────────────────────────────────

test('puntosDe: el eje Y arranca en CERO', () => {
  // Un eje que arranca en el mínimo hace que 3,1 → 3,4 ms se vea como un salto enorme, y este
  // gráfico existe justamente para distinguir "subió un poco" de "se disparó".
  const { points, tope } = chart.puntosDe(
    [{ msPorPoll: 3.1 }, { msPorPoll: 3.4 }], 'msPorPoll', 300, 90);
  assert.equal(tope, 3.4);
  const ys = points.split(' ').map(p => Number(p.split(',')[1]));
  assert.ok(ys[0] > 0 && ys[0] < 90, 'el primer punto no toca ni el piso ni el techo');
  assert.equal(ys[1], 0, 'el máximo toca el techo');
});

test('puntosDe: sin serie no rompe', () => {
  assert.deepEqual(chart.puntosDe([], 'msPorPoll'), { points: '', tope: 0 });
  assert.deepEqual(chart.puntosDe(null, 'msPorPoll'), { points: '', tope: 0 });
});

test('⭐ curvaPorSalas: una curva PLANA dice que la sala escala', () => {
  // Es la pregunta del usuario: "¿el costo por poll se mantiene a medida que suben las salas?"
  const c = chart.curvaPorSalas([
    { salas: 5,  msPorPoll: 3.3, minutos: 4 },
    { salas: 15, msPorPoll: 3.4, minutos: 6 },
    { salas: 28, msPorPoll: 3.3, minutos: 3 },
  ]);
  assert.equal(c.veredicto, 'plano');
  assert.ok(Math.abs(c.porDiezSalas) < 1, `pendiente por 10 salas: ${c.porDiezSalas}`);
});

test('⭐ curvaPorSalas: una curva que SUBE avisa que hay que rediseñar', () => {
  const c = chart.curvaPorSalas([
    { salas: 5,  msPorPoll: 3,  minutos: 4 },
    { salas: 15, msPorPoll: 9,  minutos: 6 },
    { salas: 28, msPorPoll: 18, minutos: 3 },
  ]);
  assert.equal(c.veredicto, 'sube');
  assert.ok(c.porDiezSalas >= 3, `cada 10 salas agregan ${c.porDiezSalas} ms`);
});

test('curvaPorSalas: con un punto o ninguno no inventa una pendiente', () => {
  assert.equal(chart.curvaPorSalas([]).veredicto, 'sin-datos');
  assert.equal(chart.curvaPorSalas([{ salas: 10, msPorPoll: 3 }]).veredicto, 'sin-datos');
});

// ── Formato ─────────────────────────────────────────────────────────────────

test('los números grandes se leen cortos y en español', () => {
  assert.equal(chart.corto(950), '950');
  assert.equal(chart.corto(41000), '41,0 mil');
  assert.equal(chart.corto(2400000), '2,4 M');
  assert.equal(chart.bytesCortos(1536), '1,5 KB');
  assert.equal(chart.bytesCortos(15 * 1024 * 1024), '15,0 MB');
  assert.equal(chart.tiempoCorto(468000), '7,8 min');
  assert.equal(chart.tiempoCorto(250), '250 ms');
});
