// Telemetría de la sala en vivo: services/salaStats.js.
// Correr con: npm run test:unit
//
// Ver specs/monitor-sala-escala.spec.md. Cuatro bloques:
//   1. EL HISTOGRAMA DE ENTREGA — dónde cae cada demora y cómo sale el p95.
//   2. LOS CONTADORES — que `registrarPoll` sume lo que dice, sin tocar la base.
//   3. LA AGREGACIÓN — sumar los dos workers, y NO sumar el contexto.
//   4. EL RESUMEN Y LA CURVA — la efectividad de cada palanca y el eje "contra salas".

const test   = require('node:test');
const assert = require('node:assert');

const stats = require('../../services/salaStats');

// Una muestra cruda como la que guarda Mongo.
const muestra = (o) => Object.assign({
  minuto: new Date('2026-09-08T10:00:00Z'), pid: 1,
  polls: 0, msTotal: 0, bytesTotal: 0,
  cacheAciertos: 0, cacheFallos: 0,
  presenciaOmitida: 0, presenciaEnviada: 0,
  presenciaNoEscrita: 0, presenciaEscrita: 0,
  mensajesEntregados: 0, entregaMsTotal: 0, entregaMsMax: 0,
  ent2s: 0, ent4s: 0, ent8s: 0, ent20s: 0, entMas: 0,
  pollsAtrasados: 0, atrasoMax: 0,
  salasAbiertas: null, personasEnSalas: null,
}, o);

// ── 1. El histograma de entrega ─────────────────────────────────────────────

test('casilleroDeEntrega: cada demora cae donde corresponde', () => {
  assert.equal(stats.casilleroDeEntrega(0),      'ent2s');
  assert.equal(stats.casilleroDeEntrega(2000),   'ent2s', 'el borde es inclusivo');
  assert.equal(stats.casilleroDeEntrega(2001),   'ent4s');
  assert.equal(stats.casilleroDeEntrega(8000),   'ent8s', '8 s es el techo de lo NORMAL con RN-4');
  assert.equal(stats.casilleroDeEntrega(8001),   'ent20s');
  assert.equal(stats.casilleroDeEntrega(999999), 'entMas');
});

test('percentilEntrega: sin entregas devuelve null, no cero', () => {
  // Cero diría "llegan instantáneo"; null dice "no hubo mensajes". No es lo mismo.
  assert.equal(stats.percentilEntrega(muestra({})), null);
});

test('percentilEntrega: el p95 cae donde se acumula el 95%', () => {
  // 96 entregas rápidas y 4 lentas: el p95 tiene que quedar en el casillero rápido.
  const m = muestra({ ent2s: 96, entMas: 4 });
  assert.equal(stats.percentilEntrega(m).etiqueta, '≤ 2 s');

  // 90 rápidas y 10 lentas: ahora el 95% ya no entra en el primero.
  const lento = muestra({ ent2s: 90, entMas: 10 });
  assert.equal(stats.percentilEntrega(lento).etiqueta, '> 20 s');
  assert.equal(stats.percentilEntrega(lento).ms, null, 'el casillero abierto no tiene tope');
});

// ── 2. Los contadores ───────────────────────────────────────────────────────

test('registrarPoll: suma lo que dice y no toca la base', () => {
  stats._reset();
  stats.registrarPoll({
    ms: 3.5, bytes: 600,
    cacheAcierto: true, presenciaEnviada: false, presenciaEscrita: false,
    atraso: 2, entregasMs: [1500, 9000],
  });

  const b = [...stats._buffer().values()][0];
  assert.equal(b.polls, 1);
  assert.equal(b.msTotal, 3.5);
  assert.equal(b.bytesTotal, 600);
  assert.equal(b.cacheAciertos, 1);
  assert.equal(b.cacheFallos, 0);
  assert.equal(b.presenciaOmitida, 1, 'presenciaEnviada:false cuenta como omitida (RN-2 actuó)');
  assert.equal(b.presenciaNoEscrita, 1, 'presenciaEscrita:false cuenta como no escrita (RN-3 actuó)');
  assert.equal(b.pollsAtrasados, 1);
  assert.equal(b.atrasoMax, 2);
  assert.equal(b.mensajesEntregados, 2);
  assert.equal(b.entregaMsTotal, 10500);
  assert.equal(b.entregaMsMax, 9000);
  assert.equal(b.ent2s, 1, 'los 1500 ms van al casillero de 2 s');
  assert.equal(b.ent20s, 1, 'los 9000 ms van al de 20 s');
  stats._reset();
});

test('registrarPoll: un atraso de cero NO cuenta como poll atrasado', () => {
  // En una sala sana el atraso es 0 casi siempre. Contarlo inflaría el porcentaje que
  // justamente sirve para detectar el problema.
  stats._reset();
  stats.registrarPoll({ ms: 1, bytes: 1, atraso: 0 });
  assert.equal([...stats._buffer().values()][0].pollsAtrasados, 0);
  stats._reset();
});

test('⚠️ registrarPoll nunca puede tirar: es telemetría en la ruta más caliente', () => {
  stats._reset();
  assert.doesNotThrow(() => stats.registrarPoll(undefined));
  assert.doesNotThrow(() => stats.registrarPoll({ entregasMs: null }));
  assert.doesNotThrow(() => stats.registrarPoll({ ms: NaN, bytes: 'no es un número' }));
  stats._reset();
});

// ── 3. La agregación ────────────────────────────────────────────────────────

test('agregarSerie: SUMA los dos workers del mismo minuto', () => {
  // Es el problema del cluster: graficar un worker suelto daría un diente de sierra sin
  // significado, porque el round-robin decide cuál contesta cada refresco.
  const serie = stats.agregarSerie([
    muestra({ pid: 1, polls: 100, msTotal: 300 }),
    muestra({ pid: 2, polls: 120, msTotal: 360 }),
  ], 1);

  assert.equal(serie.length, 1, 'los dos workers son UN punto');
  assert.equal(serie[0].polls, 220);
  assert.equal(serie[0].msPorPoll, 3, '660 ms / 220 polls');
});

test('⭐ agregarSerie: el CONTEXTO no se suma, se toma el máximo', () => {
  // `salasAbiertas` es un estado global de la escuela, no un contador de tráfico. Lo escribe
  // un solo worker; el otro trae null. Sumarlos daría el doble de salas de las que hay.
  const serie = stats.agregarSerie([
    muestra({ pid: 1, polls: 10, salasAbiertas: 12, personasEnSalas: 300 }),
    muestra({ pid: 2, polls: 10, salasAbiertas: null, personasEnSalas: null }),
  ], 1);

  assert.equal(serie[0].salasAbiertas, 12, 'NO 24');
  assert.equal(serie[0].personasEnSalas, 300);
  assert.equal(serie[0].polls, 20, 'pero los polls sí se suman');
});

test('agregarSerie: los máximos se toman como máximos, no se suman', () => {
  const serie = stats.agregarSerie([
    muestra({ pid: 1, polls: 1, atrasoMax: 3, entregaMsMax: 5000 }),
    muestra({ pid: 2, polls: 1, atrasoMax: 7, entregaMsMax: 2000 }),
  ], 1);
  assert.equal(serie[0].atrasoMax, 7);
  assert.equal(serie[0].entregaMsMax, 5000);
});

// ── 4. El resumen y la curva ────────────────────────────────────────────────

test('efectividad: sin ocasiones devuelve null, que NO es 0%', () => {
  // Sin salas abiertas la palanca no falló: no tuvo nada que hacer. Pintar 0% sería acusarla.
  assert.equal(stats.efectividad(0, 0), null);
  assert.equal(stats.efectividad(9, 1), 90);
  assert.equal(stats.efectividad(0, 5), 0, 'pero con ocasiones y ninguna acción sí es 0%');
});

test('resumir: la efectividad de cada palanca y lo que estimó ahorrar', () => {
  const r = stats.resumir([
    muestra({ polls: 100, msTotal: 350, bytesTotal: 60000,
              cacheAciertos: 95, cacheFallos: 5,
              presenciaOmitida: 90, presenciaEnviada: 10,
              presenciaNoEscrita: 75, presenciaEscrita: 25 }),
  ]);

  assert.equal(r.polls, 100);
  assert.equal(r.msPorPoll, 3.5);
  assert.equal(r.palancas.cache.pct, 95);
  assert.equal(r.palancas.presencia.pct, 90);
  assert.equal(r.palancas.escrituras.pct, 75);

  // Los ahorros son el conteo × el costo unitario medido, no un número guardado.
  assert.equal(r.palancas.cache.queriesAhorradas, 95 * stats.COSTOS.cargarSalaQueries);
  assert.equal(r.palancas.presencia.bytesAhorrados, 90 * stats.COSTOS.presenciaBytes);
  assert.equal(r.palancas.escrituras.escriturasAhorradas, 75 * stats.COSTOS.presenciaEscrituras);
  assert.ok(r.costos.medidoEl, 'el resumen lleva la fecha de la medición: es una estimación');
});

test('resumir: sin muestras no explota y no inventa números', () => {
  const r = stats.resumir([]);
  assert.equal(r.polls, 0);
  assert.equal(r.msPorPoll, 0);
  assert.equal(r.palancas.cache.pct, null);
  assert.equal(r.entrega.p95, null);
});

test('⭐ porCantidadDeSalas: descarta los minutos con la escuela casi vacía', () => {
  // Con 1 sala abierta el costo por poll no significa nada y ensucia la curva que decide si
  // hay que rediseñar (decisión 3 de la spec).
  const curva = stats.porCantidadDeSalas([
    muestra({ salasAbiertas: 1,  polls: 10, msTotal: 500 }),   // se descarta
    muestra({ salasAbiertas: 10, polls: 100, msTotal: 300 }),
    muestra({ salasAbiertas: 10, polls: 100, msTotal: 340 }),
    muestra({ salasAbiertas: 25, polls: 250, msTotal: 800 }),
  ], 3);

  assert.equal(curva.length, 2, 'quedan los grupos de 10 y de 25 salas');
  assert.equal(curva[0].salas, 10);
  assert.equal(curva[0].minutos, 2, 'los dos minutos con 10 salas se agrupan');
  assert.equal(curva[0].msPorPoll, 3.2, '640 ms / 200 polls');
  assert.equal(curva[1].salas, 25);
  assert.ok(curva[0].salas < curva[1].salas, 'viene ordenada por cantidad de salas');
});

test('porCantidadDeSalas: los minutos sin polls no entran', () => {
  const curva = stats.porCantidadDeSalas([muestra({ salasAbiertas: 10, polls: 0 })], 3);
  assert.equal(curva.length, 0, 'dividir por cero polls daría NaN en el gráfico');
});

// ── 5. Reconexión vs cursor trabado (corrección del 2026-09-08) ─────────────
//
// Los primeros datos reales mostraron que las dos cosas se veían IGUAL: una persona que se
// reconecta y se baja 101 mensajes atrasados daba el mismo `atrasoMax` que un navegador
// congelado, y su edad arruinaba el promedio de entrega (24 minutos).

test('⭐ un mensaje viejo NO cuenta como entrega lenta: es un reenganche', () => {
  stats._reset();
  stats.registrarPoll({
    ms: 1, bytes: 1,
    // Uno fresco y dos que ya estaban ahí de antes.
    entregasMs: [3000, stats.ENTREGA_MAX_MS + 1, 30 * 60 * 1000],
  });
  const b = [...stats._buffer().values()][0];

  assert.equal(b.mensajesEntregados, 1, 'solo el fresco cuenta como entrega');
  assert.equal(b.entregaMsTotal, 3000, 'y el promedio no se contamina con los viejos');
  assert.equal(b.mensajesDeReenganche, 2, 'los otros dos van a su propio contador');
  stats._reset();
});

test('el borde del reenganche es la ventana de conectado', () => {
  // No es un número libre: un mensaje más viejo que ONLINE_WINDOW_MS se escribió cuando esa
  // persona NO estaba conectada, por la definición que usa toda la app.
  const { ONLINE_WINDOW_MS } = require('../../services/liveRoom');
  assert.equal(stats.ENTREGA_MAX_MS, ONLINE_WINDOW_MS);

  stats._reset();
  stats.registrarPoll({ ms: 1, bytes: 1, entregasMs: [stats.ENTREGA_MAX_MS] });
  assert.equal([...stats._buffer().values()][0].mensajesEntregados, 1, 'el borde es inclusivo');
  stats._reset();
});

test('⭐ pollsMuyAtrasados es lo que separa la reconexión del congelamiento', () => {
  stats._reset();
  // Una reconexión: UN poll muy atrasado.
  stats.registrarPoll({ ms: 1, bytes: 1, atraso: 101 });
  // Y muchos polls normales.
  for (let i = 0; i < 99; i++) stats.registrarPoll({ ms: 1, bytes: 1, atraso: 0 });

  const b = [...stats._buffer().values()][0];
  assert.equal(b.atrasoMax, 101, 'el pico se guarda igual, sirve de contexto');
  assert.equal(b.pollsMuyAtrasados, 1, 'pero solo UN poll lo cruzó');
  assert.equal(b.polls, 100);
  stats._reset();
});

test('un cursor congelado deja MUCHOS polls muy atrasados', () => {
  stats._reset();
  // El mismo navegador polleando 30 veces sin avanzar.
  for (let i = 0; i < 30; i++) stats.registrarPoll({ ms: 1, bytes: 1, atraso: 40 + i });
  for (let i = 0; i < 70; i++) stats.registrarPoll({ ms: 1, bytes: 1, atraso: 0 });

  const b = [...stats._buffer().values()][0];
  assert.equal(b.pollsMuyAtrasados, 30, 'ésta es la señal, no el máximo');

  const r = stats.resumir([{ ...b, minuto: new Date(), pid: 1 }]);
  assert.equal(r.atraso.pctMuyAtrasados, 30);
  assert.ok(r.atraso.pctMuyAtrasados >= 2, 'y cruza el umbral que dispara la alerta');
  stats._reset();
});

test('un atraso por debajo del umbral no cuenta como muy atrasado', () => {
  stats._reset();
  stats.registrarPoll({ ms: 1, bytes: 1, atraso: stats.ATRASO_GRAVE - 1 });
  const b = [...stats._buffer().values()][0];
  assert.equal(b.pollsAtrasados, 1, 'sí cuenta como atrasado…');
  assert.equal(b.pollsMuyAtrasados, 0, '…pero no como MUY atrasado');
  stats._reset();
});

test('resumir expone los reenganches y el porcentaje de muy atrasados', () => {
  const r = stats.resumir([muestra({
    polls: 200, mensajesEntregados: 10, entregaMsTotal: 20000, ent2s: 10,
    mensajesDeReenganche: 101, pollsMuyAtrasados: 1, atrasoMax: 101, pollsAtrasados: 26,
  })]);
  assert.equal(r.entrega.mensajes, 10);
  assert.equal(r.entrega.reenganches, 101);
  assert.equal(r.entrega.promMs, 2000, 'el promedio es de las entregas de verdad');
  assert.equal(r.atraso.max, 101);
  assert.equal(r.atraso.muyAtrasados, 1);
  assert.equal(r.atraso.pctMuyAtrasados, 0.5);
  assert.equal(r.atraso.umbral, stats.ATRASO_GRAVE);
});
