// Cupo automático de transmisiones — specs/transmision-cupo-automatico.spec.md.

const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../../media/cupo');
const { CUPO } = require('../../config/transmision');

const P = 160;   // presupuesto de prueba (Mbit/s)
const clase = (id, espectadores, uso30 = 10, desde = 0, extra = {}) => ({ id, espectadores, uso30, desde, ...extra });

test('CU-01 · admitir: entra mientras todo quede en calidad media bajo el 60 %; si no, no', () => {
  // 0.432 Mbit/s por alumno en 360p: 60 % de 160 = 96 Mbit/s ≈ 222 alumnos.
  const al = [clase('a', 100), clase('b', 100)];
  assert.strictEqual(C.admitir({ clases: al, nueva: { espectadores: 20 }, presupuesto: P }).entra, true);
  const r = C.admitir({ clases: al, nueva: { espectadores: 30 }, presupuesto: P });
  assert.deepStrictEqual([r.entra, r.motivo], [false, 'red']);
  // Las mediciones también frenan.
  const ok = { clases: [clase('a', 10)], nueva: { espectadores: 10 }, presupuesto: P };
  assert.strictEqual(C.admitir({ ...ok, medidas: { cpu: 75, perdida: 0, salidaMbps: 5 } }).motivo, 'procesador');
  assert.strictEqual(C.admitir({ ...ok, medidas: { cpu: 20, perdida: 0.04, salidaMbps: 5 } }).motivo, 'perdida');
  assert.strictEqual(C.admitir({ ...ok, medidas: { cpu: 20, perdida: 0, salidaMbps: 168 }, capacidad: 200 }).motivo, 'puerto');
  assert.strictEqual(C.admitir({ ...ok, medidas: { cpu: 20, perdida: 0, salidaMbps: 20 }, capacidad: 200 }).entra, true);
});

test('CU-08 · sin mediciones decide con la cuenta y lo deja anotado (RN-6)', () => {
  const r = C.admitir({ clases: [], nueva: { espectadores: 10 }, medidas: null, presupuesto: P });
  assert.deepStrictEqual([r.entra, r.motivo], [true, 'sin-mediciones']);
});

const pedido = (sessionId, tieneClase) => ({ sessionId, docente: sessionId, tieneClase });
const SI = { entra: true, motivo: '' }, NO = { entra: false, motivo: 'red' };

test('CU-02/03 · la lista: primero quien tiene clase ahora; entre ellos, quien tocó primero', () => {
  let estado = { cola: [], reserva: null };
  for (const [p, t] of [[pedido('sin-clase', false), 1000], [pedido('con-clase-1', true), 2000], [pedido('con-clase-2', true), 3000]]) {
    estado = C.pedirLugar({ estado, pedido: p, ahora: t, admision: NO }).estado;
  }
  assert.deepStrictEqual(C.ordenarCola(estado.cola).map(p => p.sessionId), ['con-clase-1', 'con-clase-2', 'sin-clase']);
  assert.strictEqual(C.posicion(estado.cola, 'sin-clase'), 3);
  // Con lugar, el que no es primero sigue esperando: no se cuela.
  const r = C.pedirLugar({ estado, pedido: pedido('sin-clase', false), ahora: 4000, admision: SI });
  assert.deepStrictEqual([r.entra, r.posicion, r.motivo], [false, 3, 'espera']);
  // El primero, con lugar, entra y sale de la lista.
  const r1 = C.pedirLugar({ estado: r.estado, pedido: pedido('con-clase-1', true), ahora: 4100, admision: SI });
  assert.strictEqual(r1.entra, true);
  assert.strictEqual(C.posicion(r1.estado.cola, 'con-clase-1'), 0);
  // RN-3: cuando a "sin-clase" le empieza el módulo, pasa adelante de los que no tienen.
  const r2 = C.pedirLugar({ estado: r1.estado, pedido: pedido('sin-clase', true), ahora: 4200, admision: NO });
  assert.strictEqual(r2.posicion, 1, 'ahora tiene clase y tocó antes que con-clase-2: va primero');
});

test('CU-04 · reserva de 3 minutos; si no la usa, pasa al siguiente y él vuelve a la lista', () => {
  let estado = { cola: [], reserva: null };
  estado = C.pedirLugar({ estado, pedido: pedido('a', true), ahora: 0, admision: NO }).estado;
  estado = C.pedirLugar({ estado, pedido: pedido('b', true), ahora: 100, admision: NO }).estado;
  // Se libera lugar: reserva para "a".
  const r = C.reservarSiHayLugar({ estado: { cola: C.anotar(C.anotar(estado.cola, pedido('a', true), 1000), pedido('b', true), 1000) }, ahora: 1000, hayLugar: true });
  assert.deepStrictEqual([r.nueva.sessionId, r.nueva.hasta], ['a', 1000 + CUPO.RESERVA_MS]);
  // "b" pide con lugar mientras "a" tiene la reserva: espera.
  const rb = C.pedirLugar({ estado: r, pedido: pedido('b', true), ahora: 2000, admision: SI });
  assert.strictEqual(rb.entra, false);
  // "a" toca dentro de los 3 minutos: entra.
  const ra = C.pedirLugar({ estado: { cola: C.anotar(rb.estado.cola, pedido('a', true), 2000), reserva: rb.estado.reserva }, pedido: pedido('a', true), ahora: 2000, admision: SI });
  assert.strictEqual(ra.entra, true);
  assert.strictEqual(ra.estado.reserva, null);
  // Si la reserva vence sin usarse, se borra, y el siguiente puede recibir otra.
  const vencida = C.limpiar({ cola: [{ ...pedido('a', true), pedidoAt: 0, vistoAt: 1000 + CUPO.RESERVA_MS }], reserva: { sessionId: 'a', hasta: 1000 + CUPO.RESERVA_MS }, ahora: 1000 + CUPO.RESERVA_MS + 1 });
  assert.strictEqual(vencida.reserva, null);
  assert.strictEqual(vencida.cola.length, 1, 'vuelve a la lista, no lo echa');
  // Un pedido que nadie renueva en 30 s se cae (pestaña cerrada).
  assert.strictEqual(C.limpiar({ cola: [{ ...pedido('x', false), vistoAt: 0 }], ahora: CUPO.ESPERA_TTL_MS + 1 }).cola.length, 0);
});

test('CU-05 · al pasarse, baja primero quien menos usa la sala; nadie queda afuera', () => {
  // 4 clases de 70 alumnos en media = 121 Mbit/s > 75 % de 160 (120).
  const clases = [clase('mucho', 70, 25, 1), clase('poco', 70, 2, 1), clase('medio', 70, 10, 1), clase('nuevo', 70, 10, 5)];
  const capas = C.capasPorClase(clases, { presupuesto: P });
  assert.strictEqual(capas.poco, '180p', 'el que menos usa baja primero');
  assert.strictEqual(capas.mucho, '360p');
  assert.ok(Object.values(capas).every(c => ['360p', '180p', 'audio'].includes(c)), 'nadie queda sin capa');
  // Con mucha más gente, el siguiente en bajar es el que empezó más tarde entre los que empatan en uso.
  const mas = clases.map(c => ({ ...c, espectadores: 90 }));
  const capas2 = C.capasPorClase(mas, { presupuesto: P });
  assert.deepStrictEqual([capas2.poco, capas2.nuevo], ['180p', '180p']);
  assert.strictEqual(capas2.medio, '360p');
  // Todo entra → todas en media.
  assert.deepStrictEqual(Object.values(C.capasPorClase([clase('a', 20), clase('b', 20)], { presupuesto: P })), ['360p', '360p']);
});

test('CU-06 · histéresis: con carga estable cerca del límite, nadie salta de calidad', () => {
  // En el borde: 120 Mbit/s exactos ≈ 75 %. Con 3 alumnos menos entra en media, pero no hay
  // 10 puntos de margen: el que estaba en baja se queda en baja.
  const base = [clase('a', 69, 20), clase('b', 69, 1), clase('c', 69, 20), clase('d', 69, 20)];
  const previas = { a: '360p', b: '180p', c: '360p', d: '360p' };
  const capas = C.capasPorClase(base, { presupuesto: P, previas });
  assert.strictEqual(capas.b, '180p');
  // Si la gente se va de verdad (queda bajo 65 %), vuelve a media.
  const pocos = base.map(c => ({ ...c, espectadores: 40 }));
  assert.strictEqual(C.capasPorClase(pocos, { presupuesto: P, previas }).b, '360p');
});

test('CU-07 · el presupuesto se achica solo con pérdida sostenida, y nunca se agranda', () => {
  const hist = [0, 5, 10, 15, 20, 25, 30].map(s => ({ t: s * 1000, perdida: 0.08, salidaMbps: 60 + s }));
  assert.strictEqual(C.achique({ historial: hist, presupuesto: P, ahora: 30000 }), 90);
  // Una medición buena en el medio corta el "sostenido".
  const cortado = hist.map((m, i) => (i === 3 ? { ...m, perdida: 0.01 } : m));
  assert.strictEqual(C.achique({ historial: cortado, presupuesto: P, ahora: 30000 }), null);
  // Si se sostuvo más que el presupuesto, no hay nada que achicar (y nunca se agranda).
  assert.strictEqual(C.achique({ historial: hist.map(m => ({ ...m, salidaMbps: 200 })), presupuesto: P, ahora: 30000 }), null);
  // Poco rato no alcanza.
  assert.strictEqual(C.achique({ historial: hist.slice(-2), presupuesto: P, ahora: 30000 }), null);
});

// ── La parte de la plataforma ───────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const leer = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');
const T = require('../../services/transmisionCupo');

test('D4 · "tiene clase ahora": desde 10 minutos antes del módulo hasta que termina', () => {
  const grilla = { dias: [1, 2, 3, 4, 5], turnos: [{ id: 't', label: 'Tarde', franjas: [
    { orden: 1, tipo: 'clase', label: '1ª', desde: '13:45', hasta: '14:25' },
    { orden: 2, tipo: 'clase', label: '2ª', desde: '14:25', hasta: '15:05' } ] }] };
  const course = { name: 'Taller', horarioClases: [{ dia: 4, turno: 't', orden: 1 }, { dia: 4, turno: 't', orden: 2 }] };
  // Jueves 26/11/2026. Hora argentina = UTC − 3.
  const en = (hhmm) => new Date(`2026-11-26T${hhmm}:00-03:00`);
  assert.strictEqual(T.tieneClaseAhora({ course, grilla, ahora: en('13:30') }), false);
  assert.strictEqual(T.tieneClaseAhora({ course, grilla, ahora: en('13:36') }), true, '10 min antes');
  assert.strictEqual(T.tieneClaseAhora({ course, grilla, ahora: en('15:00') }), true);
  assert.strictEqual(T.tieneClaseAhora({ course, grilla, ahora: en('15:05') }), false, 'ya terminó');
  assert.strictEqual(T.tieneClaseAhora({ course, grilla, ahora: new Date('2026-11-27T14:00:00-03:00') }), false, 'viernes no tiene');
  assert.strictEqual(T.tieneClaseAhora({ course, grilla: null, ahora: en('14:00') }), false, 'sin grilla');
});

test('D3 · el mensaje de espera dice el lugar, y con reserva, los minutos', () => {
  assert.match(T.mensajeDeEspera({ posicion: 2 }), /Estás 2\.º en la lista/);
  assert.match(T.mensajeDeEspera({ posicion: 1, reservaHasta: Date.now() + 170000 }), /¡Ya hay lugar! Tenés 3 minutos reservados/);
});

test('RN-1/RN-6 · las rutas preguntan el lugar ANTES de prender, y sin medios deciden como antes', () => {
  const r = leer('routes', 'rooms.js');
  const abrir = r.slice(r.indexOf("router.post('/:id/sala/transmision/abrir'"), r.indexOf("router.post('/:id/sala/transmision/cupo'"));
  assert.ok(abrir.indexOf('medios.pedirLugar(pedido)') > 0 && abrir.indexOf('medios.pedirLugar(pedido)') < abrir.indexOf('tx.abrir('), 'el cupo va antes de prender');
  assert.match(abrir, /if \(lugar && !lugar\.entra\)/, 'sin respuesta del proceso de medios (null) sigue como antes');
  assert.match(abrir, /if \(!soloVoz && CUPO_ACTIVO\)/, 'Hablar no pasa por el cupo; TX_CUPO=0 lo apaga');
  assert.match(r, /medios\.pedirLugar\(\{ \.\.\.pedido, consultar: true \}\)/, 'la renovación nunca admite');
  const m = leer('media', 'servidor.js');
  assert.match(m, /if \(datos\.consultar\) \{/);
  assert.match(m, /liberarCupo\(String\(sessionId\)\)/, 'cerrar la transmisión libera el lugar');
  assert.match(leer('config', 'audit-actions.js'), /'tx\.espera'/);
  assert.match(leer('routes', 'superadmin.js'), /router\.get\('\/monitor\/transmisiones'/);
});
