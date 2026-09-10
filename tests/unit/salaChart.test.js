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

// ── El desglose del poll: el panel deja de adivinar (2026-09-10) ────────────
//
// Antes decía "probablemente una query nueva", que era una corazonada. Con el desglose se
// puede señalar la fase, y con el retraso del event loop se distingue "la base tarda" de "el
// proceso está saturado" — que llevan a arreglos OPUESTOS: índices contra CPU.

const lento = (o) => sano(Object.assign({
  msPorPoll: 78,
  desglose: { sesion: 12, presencia: 9, estado: 31, cuerpo: 2, resto: 24 },
  loopMs: 1.2, loopP99Ms: 8,
}, o));

test('⭐ con el event loop atrasado, el hallazgo es CPU y no la base', () => {
  const h = chart.diagnostico(lento({ loopP99Ms: 180, desglose: { sesion: 4, presencia: 3, estado: 8, cuerpo: 1, resto: 62 } }));
  assert.equal(h[0].nivel, 'alerta');
  assert.match(h[0].titulo, /proceso está saturado/i);
  assert.match(h[0].detalle, /no la base|CPU/i);
  assert.ok(!/índices/.test(h[0].detalle) || /no sirve/.test(h[0].detalle),
    'no puede recomendar índices cuando el cuello es CPU');
});

test('esperar más de lo que trabaja es un aviso, aunque el loop esté bien', () => {
  const h = chart.diagnostico(lento({ desglose: { sesion: 3, presencia: 2, estado: 5, cuerpo: 1, resto: 67 } }));
  const x = h.find(y => /esperando/i.test(y.titulo));
  assert.ok(x, `esperaba el aviso de espera, hubo: ${titulos(lento({}))}`);
  assert.equal(x.nivel, 'aviso');
});

test('⭐ si el tiempo es trabajo real, el panel NOMBRA la fase más cara', () => {
  // Es lo accionable: "31 ms se van en armar el estado" dice dónde mirar. "Probablemente una
  // query nueva" no decía nada.
  const h = chart.diagnostico(lento());
  const x = h.find(y => /se van en/i.test(y.titulo));
  assert.ok(x, `esperaba que nombrara la fase, hubo: ${titulos(lento())}`);
  assert.match(x.titulo, /armar el estado/i, 'la fase más cara de este caso');
  assert.match(x.detalle, /índices|query/i, 'y ahí sí corresponde hablar de la base');
});

test('con el cache caído, primero se arregla eso', () => {
  const h = chart.diagnostico(lento({ palancas: { ...sano().palancas, cache: { pct: 5 } } }));
  assert.ok(h.some(x => /cache no está ayudando/i.test(x.detalle) || /RN-1/.test(x.titulo)));
});

test('sin desglose no se diagnostica el tiempo: no se adivina', () => {
  const h = chart.diagnostico(sano({ msPorPoll: 78, desglose: null }));
  assert.ok(!h.some(x => /se van en|esperando|saturado/i.test(x.titulo)));
});

test('los hallazgos vienen ordenados por gravedad', () => {
  const h = chart.diagnostico(lento({
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

// ── ⭐ Un PICO no es un ESTADO, y una muestra chica no es un dato (2026-09-11) ─
//
// El panel afirmó esto en producción:
//
//   "El proceso está saturado: el event loop se atrasa 338.17 ms
//    De los 59.99 ms del poll, 0.02 son esperando turno y no trabajando.
//    El cuello es CPU, no la base: acá no sirve tocar queries ni índices."
//
// ⚠️ Los dos números se contradicen: si solo 0,02 ms son espera, los otros 59,97 son TRABAJO, y
// el trabajo del poll son consultas a la base. La rama entraba solo por el pico del event loop e
// imprimía `resto` sin mirarlo nunca.

// Los números exactos que salieron en producción.
const elCasoReal = (o) => sano(Object.assign({
  msPorPoll: 59.99, loopMs: 30, loopP99Ms: 338.17,
  desglose: { sesion: 14.2, presencia: 15.3, estado: 28.4, cuerpo: 2.03, resto: 0.02 },
}, o));

test('⭐ un PICO del event loop sin cola NO se declara saturación', () => {
  const h = chart.diagnostico(elCasoReal());
  assert.ok(!h.some(x => /saturado/i.test(x.titulo)),
    `no hay cola que lo sostenga, hubo: ${titulos(elCasoReal())}`);

  const x = h.find(y => /pico/i.test(y.titulo));
  assert.ok(x, 'pero el pico tiene que verse: 338 ms pasaron de verdad');
  assert.equal(x.nivel, 'aviso', 'un minuto malo es aviso, no alerta');
  assert.match(x.detalle, /peor minuto/i, 'y tiene que decir que es UN minuto, no el estado');
});

test('⭐ y no puede desaconsejar mirar la base cuando el tiempo ES la base', () => {
  // Es la parte cara del error: "no sirve tocar queries ni índices" mandaba a buscar CPU justo
  // cuando 59,97 de los 59,99 ms eran consultas.
  const h = chart.diagnostico(elCasoReal());
  assert.ok(!h.some(x => /no sirve tocar queries/i.test(x.detalle || '')));

  const x = h.find(y => /se van en/i.test(y.titulo));
  assert.ok(x, `al contrario: tiene que nombrar la fase más cara, hubo: ${titulos(elCasoReal())}`);
  assert.match(x.titulo, /armar el estado/i);
});

test('la saturación de verdad —pico Y cola— sigue siendo alerta, y muestra el contraste', () => {
  const h = chart.diagnostico(elCasoReal({
    desglose: { sesion: 2, presencia: 1, estado: 2, cuerpo: 0, resto: 54.99 },
  }));
  assert.equal(h[0].nivel, 'alerta');
  assert.match(h[0].titulo, /saturado/i);
  assert.match(h[0].detalle, /54\.99 son esperando/, 'la espera que la sostiene');
  assert.match(h[0].detalle, /5 ms de trabajo real/, 'contra el trabajo, que es lo que la prueba');
});

test('⭐⭐ un pico con la escuela VACÍA se informa igual: es la medición del feriado', () => {
  // `loopP99Ms` no es un promedio sobre los polls —es el peor minuto del rango—, así que un día
  // sin nadie es justo el que dice si el proceso se traba SOLO. El corte por "no hay polls" lo
  // tapaba, y es la única medición que se puede hacer un feriado.
  const vacio = { polls: 0, loopMs: 28, loopP99Ms: 338.17 };
  const h = chart.diagnostico(vacio);

  const x = h.find(y => /pico/i.test(y.titulo));
  assert.ok(x, `no puede quedar tapado por "no hay nadie", hubo: ${titulos(vacio)}`);
  assert.match(x.detalle, /no hubo polls/i, 'y tiene que decir que nadie lo pagó');
  assert.ok(h.some(y => /nadie/i.test(y.titulo)), 'sin tapar que no hubo tráfico');
});

test('un día vacío y tranquilo sigue siendo un solo "no hay nadie"', () => {
  const h = chart.diagnostico({ polls: 0, loopMs: 0.4, loopP99Ms: 3 });
  assert.equal(h.length, 1);
  assert.equal(h[0].nivel, 'ok');
});

test('⭐ con pocos polls el panel se calla en vez de promediar', () => {
  // Un `pm2 reload` deja el cache del curso vacío, así que los primeros polls son todos fallos:
  // con la escuela vacía un puñado de polls fríos se queda con el promedio del rango entero.
  const h = chart.diagnostico(lento({ polls: 40 }));
  assert.ok(h.some(y => /poco para promediar/i.test(y.titulo)),
    `esperaba el corte por muestra chica, hubo: ${titulos(lento({ polls: 40 }))}`);
  assert.ok(!h.some(y => /se van en|esperando|saturado/i.test(y.titulo)),
    'y ningún hallazgo que dependa de un promedio');
});

test('⭐ pero la muestra chica NO tapa el pico del event loop', () => {
  const h = chart.diagnostico(lento({ polls: 40, loopP99Ms: 338.17 }));
  assert.ok(h.some(y => /pico/i.test(y.titulo)), 'el pico no es un promedio: vale igual');
  assert.ok(h.some(y => /poco para promediar/i.test(y.titulo)));
});

test('200 polls ya alcanzan: el piso no puede tapar datos reales', () => {
  // Es bajo a propósito: UNA persona en UNA sala aporta ~900 polls por hora.
  const h = chart.diagnostico(lento({ polls: 200 }));
  assert.ok(!h.some(y => /poco para promediar/i.test(y.titulo)));
  assert.ok(h.some(y => /se van en/i.test(y.titulo)), 'y el diagnóstico normal vuelve');
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

// ── Salas colgadas ──────────────────────────────────────────────────────────

test('⭐ varias salas abiertas sin nadie adentro se avisan', () => {
  // El autocierre solo barre cuando alguien abre el panel de dirección o preceptoría, así que
  // una clase que terminó y a la que nadie volvió sigue figurando "en vivo" en sus tarjetas.
  const h = chart.diagnostico(sano({ salasAbiertas: 3, sesionesSinCerrar: 6, salasColgadas: 3 }));
  const x = h.find(y => /quedaron abiertas/i.test(y.titulo));
  assert.ok(x, `esperaba el aviso de salas colgadas, hubo: ${titulos(sano({ salasColgadas: 3 }))}`);
  assert.equal(x.nivel, 'aviso', 'es un aviso, no una alerta: el servidor está bien');
  assert.match(x.detalle, /autocierre/i);
});

test('una o dos colgadas no molestan: es el ruido normal de una jornada', () => {
  assert.ok(!chart.diagnostico(sano({ salasColgadas: 2 })).some(y => /quedaron abiertas/i.test(y.titulo)));
  assert.ok(!chart.diagnostico(sano({ salasColgadas: 0 })).some(y => /quedaron abiertas/i.test(y.titulo)));
});

test('sin el dato de colgadas no se inventa un aviso', () => {
  assert.ok(!chart.diagnostico(sano({ salasColgadas: null })).some(y => /quedaron abiertas/i.test(y.titulo)));
});

// ── El veredicto de la curva: cuándo callarse (2026-09-10) ──────────────────

test('⭐⭐ una nube SIN patrón no da veredicto: dice que no se puede concluir', () => {
  // Medido en producción el 2026-09-10: el rango de 7 días decía "sube" sobre esto, que va
  // para abajo. Una pendiente sobre puntos dispersos es un número, no una conclusión.
  const c = chart.curvaPorSalas([
    { salas: 3,  msPorPoll: 113, minutos: 731 },
    { salas: 7,  msPorPoll: 934, minutos: 237 },
    { salas: 8,  msPorPoll: 469, minutos: 354 },
    { salas: 10, msPorPoll: 182, minutos: 55 },
    { salas: 12, msPorPoll: 177, minutos: 2 },
  ]);
  assert.equal(c.veredicto, 'disperso', `r2 fue ${c.r2}`);
  assert.ok(c.r2 < c.R2_MINIMO);
});

test('⭐ una curva PLANA sigue diciendo "plano", aunque su R² sea bajo', () => {
  // EL ERROR QUE ESTE TEST ATAJÓ: una curva de verdad plana tiene R² casi cero por
  // construcción —no hay varianza que explicar— así que el filtro de R² la marcaba como
  // "dispersa", que es justo lo contrario de lo que significa.
  const c = chart.curvaPorSalas([
    { salas: 5,  msPorPoll: 3.3, minutos: 4 },
    { salas: 15, msPorPoll: 3.4, minutos: 6 },
    { salas: 28, msPorPoll: 3.3, minutos: 3 },
  ]);
  assert.equal(c.veredicto, 'plano');
  assert.ok(c.dispersion < c.DISPERSION_PLANA, `dispersión ${c.dispersion}`);
});

test('una subida LIMPIA sí da veredicto, con el ajuste alto', () => {
  // Los datos reales de la última hora del 10/09.
  const c = chart.curvaPorSalas([
    { salas: 3, msPorPoll: 39.67, minutos: 66 },
    { salas: 4, msPorPoll: 46.71, minutos: 14 },
    { salas: 5, msPorPoll: 56.32, minutos: 24 },
    { salas: 6, msPorPoll: 78.34, minutos: 14 },
  ]);
  assert.equal(c.veredicto, 'sube');
  assert.ok(c.r2 > 0.9, `el ajuste tiene que ser alto: ${c.r2}`);
  assert.ok(c.porDiezSalas > 100);
});

test('el R² se calcula y viene entre 0 y 1', () => {
  const c = chart.curvaPorSalas([
    { salas: 3, msPorPoll: 10, minutos: 1 },
    { salas: 6, msPorPoll: 20, minutos: 1 },
    { salas: 9, msPorPoll: 30, minutos: 1 },
  ]);
  assert.ok(c.r2 >= 0 && c.r2 <= 1);
  assert.ok(c.r2 > 0.99, 'tres puntos perfectamente alineados: ajuste casi perfecto');
});
