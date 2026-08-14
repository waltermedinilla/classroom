// Tests de la lógica pura de la telemetría del rate limit (services/rateLimitStats.js).
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Acá va solo lo que no toca Mongo: el truncado al minuto, los rangos, la agregación de las
// muestras y el resumen. El volcado y el endpoint se prueban por HTTP en tests/smoke/specs.js.
//
// Cubren los criterios 4, 5, 8 y 9 de specs/monitor-ratelimit.spec.md.
//
// EL CASO QUE NO SE PUEDE ROMPER: sumar los DOS workers de PM2 en un solo punto. Cada worker
// tiene su propio MemoryStore de express-rate-limit, así que la misma IP tiene dos contadores
// independientes; si la agregación no los suma (o los duplica), el gráfico miente.

const test   = require('node:test');
const assert = require('node:assert');

const {
  truncarAlMinuto, rangoValido, configDeRango, agregarSerie, resumirMuestras,
  registrarPaso, registrarBloqueo, _buffer, _reset,
} = require('../../services/rateLimitStats');

const muestra = (over = {}) => ({
  minuto: new Date('2026-08-13T10:00:00Z'), pid: 100,
  pasadas: 0, bloqueadas: 0, picoUsado: 0, picoIp: '', claves: 0, limite: 12000, ...over,
});

// ── Truncado al minuto ───────────────────────────────────────────────────────
// Sin truncar, cada muestra cae en su propio milisegundo y no hay nada que agrupar.

test('truncarAlMinuto borra segundos y milisegundos', () => {
  const t = truncarAlMinuto(new Date('2026-08-13T10:07:43.812Z'));
  assert.equal(t.toISOString(), '2026-08-13T10:07:00.000Z');
});

test('truncarAlMinuto no se lleva por delante el cambio de hora ni de día', () => {
  assert.equal(truncarAlMinuto(new Date('2026-08-13T10:59:59.999Z')).toISOString(),
    '2026-08-13T10:59:00.000Z');
  assert.equal(truncarAlMinuto(new Date('2026-08-13T23:59:30.000Z')).toISOString(),
    '2026-08-13T23:59:00.000Z');
});

test('truncarAlMinuto no muta la fecha que recibe', () => {
  const original = new Date('2026-08-13T10:07:43.812Z');
  truncarAlMinuto(original);
  assert.equal(original.toISOString(), '2026-08-13T10:07:43.812Z');
});

// ── Rangos ───────────────────────────────────────────────────────────────────

test('rangoValido acepta solo los cuatro rangos declarados', () => {
  ['1h', '6h', '24h', '7d'].forEach(r => assert.equal(rangoValido(r), true, r));
  ['30m', '1H', '', 'toString', undefined, null].forEach(r =>
    assert.equal(rangoValido(r), false, String(r)));
});

test('el bucket crece con la ventana, para no mandar 10080 puntos al navegador', () => {
  assert.equal(configDeRango('1h').bucketMin, 1);
  assert.equal(configDeRango('7d').bucketMin, 60);
  // 7 días en buckets de 1 hora = 168 puntos, un número que un SVG dibuja sin sufrir
  assert.equal(configDeRango('7d').ventanaMin / configDeRango('7d').bucketMin, 168);
});

test('un rango inválido cae en 1h en vez de romper', () => {
  assert.deepEqual(configDeRango('basura'), configDeRango('1h'));
});

// ── Agregación: el problema del cluster ──────────────────────────────────────

test('las muestras de los dos workers del mismo minuto se SUMAN en un punto', () => {
  const serie = agregarSerie([
    muestra({ pid: 100, pasadas: 300, bloqueadas: 1 }),
    muestra({ pid: 200, pasadas: 250, bloqueadas: 2 }),
  ], 1);

  assert.equal(serie.length, 1, 'los dos workers son el mismo instante, no dos puntos');
  assert.equal(serie[0].pasadas, 550);
  assert.equal(serie[0].bloqueadas, 3);
});

test('el pico se agrega con MÁXIMO, no con suma', () => {
  // Sumar los picos de dos workers daría 1900, un consumo que no le pasó a ninguna IP.
  const serie = agregarSerie([
    muestra({ pid: 100, picoUsado: 1100, picoIp: '1.1.1.1' }),
    muestra({ pid: 200, picoUsado: 800,  picoIp: '2.2.2.2' }),
  ], 1);

  assert.equal(serie[0].picoUsado, 1100);
  assert.equal(serie[0].picoIp, '1.1.1.1', 'la IP tiene que ser la del pico ganador');
});

test('los minutos se agrupan según el tamaño de bucket', () => {
  const serie = agregarSerie([
    muestra({ minuto: new Date('2026-08-13T10:00:00Z'), pasadas: 10 }),
    muestra({ minuto: new Date('2026-08-13T10:04:00Z'), pasadas: 20 }),
    muestra({ minuto: new Date('2026-08-13T10:05:00Z'), pasadas: 30 }), // ya es otro bucket
  ], 5);

  assert.equal(serie.length, 2);
  assert.equal(serie[0].pasadas, 30);
  assert.equal(serie[1].pasadas, 30);
});

test('la serie sale ordenada por tiempo aunque las muestras vengan desordenadas', () => {
  const serie = agregarSerie([
    muestra({ minuto: new Date('2026-08-13T10:05:00Z') }),
    muestra({ minuto: new Date('2026-08-13T10:01:00Z') }),
    muestra({ minuto: new Date('2026-08-13T10:03:00Z') }),
  ], 1);

  const tiempos = serie.map(p => p.t.toISOString());
  assert.deepEqual(tiempos, [...tiempos].sort());
});

test('agregarSerie no explota con lista vacía ni undefined', () => {
  assert.deepEqual(agregarSerie([], 1), []);
  assert.deepEqual(agregarSerie(undefined, 1), []);
});

// ── Resumen ──────────────────────────────────────────────────────────────────

test('el resumen suma los 429 y se queda con el bloqueo más reciente', () => {
  const r = resumirMuestras([
    muestra({ minuto: new Date('2026-08-13T10:01:00Z'), bloqueadas: 2 }),
    muestra({ minuto: new Date('2026-08-13T10:09:00Z'), bloqueadas: 5 }),
    muestra({ minuto: new Date('2026-08-13T10:05:00Z'), bloqueadas: 0 }),
  ]);

  assert.equal(r.bloqueadasTotal, 7);
  assert.equal(r.ultimoBloqueo.toISOString(), '2026-08-13T10:09:00.000Z',
    'el último bloqueo es el más reciente CON bloqueos, no la última muestra');
});

test('el resumen cuenta los workers que atendían A LA VEZ', () => {
  // Mismo minuto, dos pids: son los 2 workers de PM2 corriendo en paralelo.
  const r = resumirMuestras([muestra({ pid: 100 }), muestra({ pid: 200 }), muestra({ pid: 100 })]);
  assert.equal(r.workers, 2);
});

test('un reinicio del servidor no infla la cuenta de workers', () => {
  // El PID cambia en cada deploy. Contando los distintos del rango entero, un día con cuatro
  // deploys mostraría 5 "workers" — y como el texto de la vista dice que el techo efectivo es
  // esa cantidad de veces el cupo, el número engañaría justo sobre lo que hay que entender.
  const r = resumirMuestras([
    muestra({ minuto: new Date('2026-08-13T10:00:00Z'), pid: 100 }),
    muestra({ minuto: new Date('2026-08-13T10:05:00Z'), pid: 777 }), // reinicio: PID nuevo
    muestra({ minuto: new Date('2026-08-13T10:10:00Z'), pid: 999 }), // otro reinicio
  ]);

  assert.equal(r.workers, 1, 'nunca hubo más de un proceso atendiendo al mismo tiempo');
});

test('el límite sale de la muestra más reciente que lo tenga, no del valor de hoy', () => {
  // El `max` pasó por 400 → 1200 → 12000: dibujar el techo actual sobre datos viejos
  // los haría ver como si nunca se hubieran acercado al límite.
  const r = resumirMuestras([
    muestra({ minuto: new Date('2026-08-13T10:01:00Z'), limite: 1200 }),
    muestra({ minuto: new Date('2026-08-13T10:02:00Z'), limite: 12000 }),
  ]);
  assert.equal(r.limite, 12000);
});

test('sin bloqueos, ultimoBloqueo es null y no una fecha cualquiera', () => {
  const r = resumirMuestras([muestra({ pasadas: 500 })]);
  assert.equal(r.bloqueadasTotal, 0);
  assert.equal(r.ultimoBloqueo, null);
});

test('resumirMuestras tolera la lista vacía', () => {
  const r = resumirMuestras([]);
  assert.equal(r.bloqueadasTotal, 0);
  assert.equal(r.workers, 0);
  assert.equal(r.limite, null);
});

// ── Contadores en memoria ────────────────────────────────────────────────────

test('registrarPaso acumula y se queda con la IP del pico', (t) => {
  _reset();
  t.after(_reset);

  const next = () => {};
  registrarPaso({ ip: '1.1.1.1', rateLimit: { limit: 12000, used: 50,  remaining: 11950 } }, {}, next);
  registrarPaso({ ip: '2.2.2.2', rateLimit: { limit: 12000, used: 900, remaining: 11100 } }, {}, next);
  registrarPaso({ ip: '3.3.3.3', rateLimit: { limit: 12000, used: 100, remaining: 11900 } }, {}, next);

  const b = [..._buffer().values()][0];
  assert.equal(b.pasadas, 3);
  assert.equal(b.picoUsado, 900);
  assert.equal(b.picoIp, '2.2.2.2', 'la IP guardada es la del mayor consumo, no la última');
  assert.equal(b.ips.size, 3);
  assert.equal(b.limite, 12000);
});

test('registrarPaso llama a next() siempre, incluso sin req.rateLimit', () => {
  _reset();
  let llamado = 0;
  registrarPaso({ ip: '1.1.1.1' }, {}, () => { llamado++; });          // ruta exenta del limiter
  registrarPaso({ ip: '1.1.1.1', rateLimit: { used: 1 } }, {}, () => { llamado++; });

  assert.equal(llamado, 2, 'la telemetría nunca puede cortar la cadena de middlewares');
  // Sin rateLimit no se cuenta nada: esa request no consumió cupo
  assert.equal([..._buffer().values()][0].pasadas, 1);
  _reset();
});

test('registrarPaso no rompe si el request viene raro', () => {
  _reset();
  assert.doesNotThrow(() => registrarPaso({}, {}, () => {}));
  assert.doesNotThrow(() => registrarPaso({ rateLimit: null }, {}, () => {}));
  _reset();
});

// ── El 429 de verdad, con express montado ────────────────────────────────────
// Criterio 3 de la spec. No se puede provocar contra el server real (12000 requests), así
// que se replica el montaje de server.js con un cupo de 3.
//
// Este test cubre dos cosas que se rompen juntas y en silencio:
//   1) que el `handler` cuente el bloqueo — un middleware posterior NUNCA vería estas
//      requests, porque el limiter responde sin llamar a next();
//   2) que el cuerpo del 429 siga siendo el mismo — definir `handler` DESACTIVA el envío
//      automático de `message`, así que un descuido acá le cambia el error a la escuela
//      entera sin que falle nada más.

test('el handler del limiter cuenta el 429 y conserva el mensaje de siempre', async (t) => {
  const express   = require('express');
  const rateLimit = require('express-rate-limit');
  const stats     = require('../../services/rateLimitStats');

  const MSG = { error: 'Demasiadas peticiones. Intentá de nuevo en 15 minutos.' };
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: MSG,
    handler: (req, res, _next, options) => {
      stats.registrarBloqueo(req);
      res.status(options.statusCode).json(MSG);
    },
  }));
  app.use(stats.registrarPaso);
  app.get('/', (req, res) => res.json({ ok: true }));

  stats._reset();
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => { server.close(); stats._reset(); });

  const url = `http://127.0.0.1:${server.address().port}/`;
  const codigos = [];
  let ultimoCuerpo = null;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url);
    codigos.push(res.status);
    ultimoCuerpo = await res.json();
  }

  assert.deepEqual(codigos, [200, 200, 200, 429, 429], 'las 3 primeras pasan, las siguientes rebotan');
  assert.deepEqual(ultimoCuerpo, MSG, 'el cuerpo del 429 no puede cambiar al agregar el handler');

  const b = [...stats._buffer().values()][0];
  assert.equal(b.pasadas, 3);
  assert.equal(b.bloqueadas, 2, 'los 429 solo se pueden contar desde el handler');
  assert.ok(b.picoIp, 'debería quedar registrada la IP que agotó el cupo');
});

test('registrarBloqueo cuenta los 429 aparte de las pasadas', () => {
  _reset();
  registrarPaso({ ip: '1.1.1.1', rateLimit: { limit: 12000, used: 10 } }, {}, () => {});
  registrarBloqueo({ ip: '9.9.9.9', rateLimit: { limit: 12000, used: 12001 } });
  registrarBloqueo({ ip: '9.9.9.9', rateLimit: { limit: 12000, used: 12002 } });

  const b = [..._buffer().values()][0];
  assert.equal(b.pasadas, 1);
  assert.equal(b.bloqueadas, 2);
  assert.equal(b.picoIp, '9.9.9.9', 'quien se comió el cupo es el que hay que poder señalar');
  _reset();
});
