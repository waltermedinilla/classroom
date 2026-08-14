// Tests de la matemática del gráfico de rate limit (public/js/ratelimit-chart.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Fase 2 de specs/monitor-ratelimit.spec.md. Lo que estos tests protegen es que el gráfico
// no MIENTA, que es la única forma en que una vista de monitoreo hace daño: si dibuja una
// curva tranquila cuando el cupo se está agotando, es peor que no tener nada.

const test   = require('node:test');
const assert = require('node:assert');

const {
  rellenarBuckets, topeEjeY, puntosSerie, pathArea, alturasTrafico, etiquetasEjeX,
} = require('../../public/js/ratelimit-chart');

const punto = (iso, over = {}) => ({
  t: new Date(iso), pasadas: 0, bloqueadas: 0, picoUsado: 0, picoIp: '', ...over,
});

// ── Huecos: el eje X tiene que ser tiempo, no un contador de índices ─────────

test('los buckets sin muestra se rellenan con ceros', () => {
  const serie = [
    punto('2026-08-13T10:00:00Z', { pasadas: 100 }),
    punto('2026-08-13T10:03:00Z', { pasadas: 200 }), // faltan 10:01 y 10:02
  ];
  const lleno = rellenarBuckets(serie, '2026-08-13T10:00:00Z', '2026-08-13T10:03:00Z', 1);

  assert.equal(lleno.length, 4, 'cuatro minutos de ventana son cuatro puntos');
  assert.deepEqual(lleno.map(p => p.pasadas), [100, 0, 0, 200]);
});

test('el hueco queda marcado como vacío, para no confundirlo con un cero real', () => {
  // "no hubo tráfico" y "el servidor estaba apagado" se dibujan igual si nadie los distingue
  const lleno = rellenarBuckets([punto('2026-08-13T10:00:00Z', { pasadas: 5 })],
    '2026-08-13T10:00:00Z', '2026-08-13T10:02:00Z', 1);

  assert.equal(lleno[0].vacio, false);
  assert.equal(lleno[1].vacio, true);
  assert.equal(lleno[2].vacio, true);
});

test('un hueco largo ocupa el ancho que le corresponde', () => {
  // Este es EL test del eje temporal: dos puntos separados por 3 horas no pueden quedar
  // uno al lado del otro como si fueran consecutivos.
  const serie = [
    punto('2026-08-13T10:00:00Z', { pasadas: 10 }),
    punto('2026-08-13T13:00:00Z', { pasadas: 10 }),
  ];
  const lleno = rellenarBuckets(serie, '2026-08-13T10:00:00Z', '2026-08-13T13:00:00Z', 60);

  assert.equal(lleno.length, 4, '4 buckets de 1 hora entre las 10 y las 13');
  assert.deepEqual(lleno.map(p => p.pasadas), [10, 0, 0, 10]);
});

test('rellenarBuckets respeta el tamaño de bucket del rango', () => {
  const lleno = rellenarBuckets([], '2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z', 15);
  assert.equal(lleno.length, 5, '10:00, 10:15, 10:30, 10:45 y 11:00');
});

test('rellenarBuckets tolera serie vacía o ausente', () => {
  assert.equal(rellenarBuckets([], '2026-08-13T10:00:00Z', '2026-08-13T10:02:00Z', 1).length, 3);
  assert.equal(rellenarBuckets(undefined, '2026-08-13T10:00:00Z', '2026-08-13T10:00:00Z', 1).length, 1);
});

// ── Eje Y ────────────────────────────────────────────────────────────────────

test('el eje llega hasta el límite, para que la altura se lea como % del cupo', () => {
  const serie = [punto('2026-08-13T10:00:00Z', { picoUsado: 3000 })];
  assert.equal(topeEjeY(serie, 12000), 12000);
});

test('si el pico supera el límite, el eje crece en vez de dibujar fuera del recuadro', () => {
  // Pasa de verdad: el cupo es POR WORKER, así que el consumo agregado puede pasarse del max
  const serie = [punto('2026-08-13T10:00:00Z', { picoUsado: 15000 })];
  const tope  = topeEjeY(serie, 12000);

  assert.ok(tope >= 15000, `el tope debería contener al pico, dio ${tope}`);
});

test('topeEjeY nunca devuelve cero (una división por cero deja el SVG en blanco)', () => {
  assert.ok(topeEjeY([], 0) > 0);
  assert.ok(topeEjeY([punto('2026-08-13T10:00:00Z')], 0) > 0);
});

// ── Coordenadas ──────────────────────────────────────────────────────────────

test('el valor máximo toca el techo del gráfico y el cero toca el piso', () => {
  const serie = [
    punto('2026-08-13T10:00:00Z', { picoUsado: 0 }),
    punto('2026-08-13T10:01:00Z', { picoUsado: 12000 }),
  ];
  const pts = puntosSerie(serie, 'picoUsado', { ancho: 100, alto: 40, tope: 12000 }).split(' ');

  assert.equal(pts[0], '0.0,40.0', 'cero va al piso (y = alto, porque el SVG crece hacia abajo)');
  assert.equal(pts[1], '100.0,0.0', 'el tope va al techo');
});

test('un valor por encima del tope se recorta y no se sale del recuadro', () => {
  const serie = [punto('2026-08-13T10:00:00Z', { picoUsado: 99999 })];
  const pts   = puntosSerie(serie, 'picoUsado', { ancho: 100, alto: 40, tope: 12000 });

  assert.ok(!pts.includes('-'), `ninguna coordenada puede ser negativa: ${pts}`);
});

test('con un solo punto se dibuja al centro, no en el borde', () => {
  const pts = puntosSerie([punto('2026-08-13T10:00:00Z', { picoUsado: 6000 })],
    'picoUsado', { ancho: 100, alto: 40, tope: 12000 });
  assert.equal(pts, '50.0,20.0');
});

test('sin puntos no se emite trazo (un polyline vacío es mejor que uno inválido)', () => {
  assert.equal(puntosSerie([], 'picoUsado', { ancho: 100, alto: 40, tope: 100 }), '');
  assert.equal(pathArea([], 'picoUsado', { ancho: 100, alto: 40, tope: 100 }), '');
});

test('el área cierra contra la base para poder rellenarse', () => {
  const serie = [
    punto('2026-08-13T10:00:00Z', { picoUsado: 6000 }),
    punto('2026-08-13T10:01:00Z', { picoUsado: 12000 }),
  ];
  const d = pathArea(serie, 'picoUsado', { ancho: 100, alto: 40, tope: 12000 });

  assert.ok(d.startsWith('M0,40'), `debería arrancar en la base: ${d}`);
  assert.ok(d.endsWith('L100,40 Z'), `debería cerrar contra la base: ${d}`);
});

// ── Barras de tráfico ────────────────────────────────────────────────────────

test('las barras usan su propia escala, no la del cupo', () => {
  // pasadas-por-bucket y cupo-consumido son magnitudes distintas: compartir eje aplastaría una
  const barras = alturasTrafico([
    punto('2026-08-13T10:00:00Z', { pasadas: 50 }),
    punto('2026-08-13T10:01:00Z', { pasadas: 100 }),
  ]);

  assert.equal(barras[1].alto, 1, 'el máximo de la serie llena la barra');
  assert.equal(barras[0].alto, 0.5);
});

test('los buckets con 429 quedan marcados para pintarlos distinto', () => {
  const barras = alturasTrafico([
    punto('2026-08-13T10:00:00Z', { pasadas: 10 }),
    punto('2026-08-13T10:01:00Z', { pasadas: 10, bloqueadas: 3 }),
  ]);

  assert.equal(barras[0].bloqueado, false);
  assert.equal(barras[1].bloqueado, true);
});

test('una serie toda en cero no divide por cero', () => {
  const barras = alturasTrafico([punto('2026-08-13T10:00:00Z'), punto('2026-08-13T10:01:00Z')]);
  barras.forEach(b => assert.equal(Number.isFinite(b.alto), true));
});

// ── Eje X ────────────────────────────────────────────────────────────────────

test('el eje de 1h se etiqueta con horas y el de 7d con días', () => {
  const serie = rellenarBuckets([], '2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z', 1);
  const hora  = etiquetasEjeX(serie, '1h');
  assert.ok(/\d{1,2}:\d{2}/.test(hora[0].label), `esperaba una hora, vino "${hora[0].label}"`);

  const semana = rellenarBuckets([], '2026-08-07T00:00:00Z', '2026-08-13T00:00:00Z', 60);
  const dia    = etiquetasEjeX(semana, '7d');
  assert.ok(!/\d{1,2}:\d{2}/.test(dia[0].label), `en 7d la hora no aporta: "${dia[0].label}"`);
});

test('el eje usa reloj de 24 horas, no "a. m." / "p. m."', () => {
  // es-AR devuelve 12h por defecto: en un eje de monitoreo "00:59" se lee mejor que
  // "12:59 a. m." y ocupa la mitad.
  const serie = rellenarBuckets([], '2026-08-13T02:00:00Z', '2026-08-13T03:00:00Z', 15);
  etiquetasEjeX(serie, '1h').forEach(m => {
    assert.ok(!/[ap]\.?\s?m\.?/i.test(m.label), `no debería traer am/pm: "${m.label}"`);
    assert.ok(/^\d{2}:\d{2}$/.test(m.label), `esperaba HH:MM, vino "${m.label}"`);
  });
});

test('las marcas del eje van de 0 a 1 y en orden', () => {
  const serie   = rellenarBuckets([], '2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z', 1);
  const marcas  = etiquetasEjeX(serie, '1h');
  const posiciones = marcas.map(m => m.pos);

  assert.equal(posiciones[0], 0);
  assert.equal(posiciones[posiciones.length - 1], 1);
  assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b));
});

test('etiquetasEjeX no explota con serie vacía ni con un solo punto', () => {
  assert.deepEqual(etiquetasEjeX([], '1h'), []);
  assert.equal(etiquetasEjeX([punto('2026-08-13T10:00:00Z')], '1h').length, 1);
});
