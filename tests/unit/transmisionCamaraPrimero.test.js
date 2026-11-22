// La transmisión arranca con la cámara y la pantalla se comparte desde un botón chico dentro del
// cuadro: "pantalla grande, cámara chica". Ver specs/transmision-camara-primero.spec.md.
//
// Todo lo que se puede probar sin navegador ni mediasoup corriendo: dónde va cada pista
// (CA-1), cuánto cuesta la cámara chica (CA-2), que el 'bienvenido' diga la fuente (CA-3) y
// lo que pintan las vistas (CA-4 y CA-5).

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');
const ejs      = require('ejs');

const { ubicarPistas } = require('../../public/js/transmision-pistas');
const aforo = require('../../media/aforo');
const sfu   = require('../../media/sfu');
const { CAMARA_CHICA_MBPS, PRESUPUESTO_MBPS, CAPAS } = require('../../config/transmision');

const raiz = path.join(__dirname, '..', '..');
const CAM  = { fuente: 'camara',   id: 'c' };
const PAN  = { fuente: 'pantalla', id: 'p' };

// ── CA-1 · ubicarPistas ──────────────────────────────────────────────────────

test('CA-1 · solo cámara: la cámara va grande y no hay chica', () => {
  assert.deepStrictEqual(ubicarPistas([CAM]), { grande: CAM, chica: null });
});

test('CA-1 · solo pantalla: la pantalla va grande', () => {
  assert.deepStrictEqual(ubicarPistas([PAN]), { grande: PAN, chica: null });
});

test('CA-1 · ⭐ cámara + pantalla: pantalla grande, cámara chica, en cualquier orden', () => {
  assert.deepStrictEqual(ubicarPistas([CAM, PAN]), { grande: PAN, chica: CAM });
  assert.deepStrictEqual(ubicarPistas([PAN, CAM]), { grande: PAN, chica: CAM });
});

test('CA-1 · ninguna pista: los dos cuadros vacíos', () => {
  assert.deepStrictEqual(ubicarPistas([]), { grande: null, chica: null });
  assert.deepStrictEqual(ubicarPistas(undefined), { grande: null, chica: null });
});

test('CA-1 · una pista sin fuente (cliente viejo) va al cuadro grande, nunca se pierde', () => {
  const vieja = { fuente: '', id: 'x' };
  assert.deepStrictEqual(ubicarPistas([vieja]), { grande: vieja, chica: null });
});

// ── CA-2 · el gobernador cuenta la cámara chica ──────────────────────────────

test('CA-2 · la cámara chica es la capa baja del simulcast', () => {
  assert.strictEqual(CAMARA_CHICA_MBPS, 0.125);
});

test('CA-2 · en la mejor capa, cada espectador con pantalla + cámara suma la cámara chica', () => {
  const mejor = CAPAS[0];
  assert.strictEqual(mejor.id, '360p');
  const esperado = 30 * mejor.mbps + 30 * CAMARA_CHICA_MBPS;
  assert.ok(Math.abs(aforo.consumoMbps(30, '360p', 30) - esperado) < 1e-9);
  // Sin pantalla + cámara, el número de siempre.
  assert.ok(Math.abs(aforo.consumoMbps(30, '360p') - 30 * mejor.mbps) < 1e-9);
});

test('CA-2 · en 180p y en solo audio la cámara chica no se manda y no cuesta', () => {
  assert.strictEqual(aforo.consumoMbps(30, '180p', 30), aforo.consumoMbps(30, '180p'));
  assert.strictEqual(aforo.consumoMbps(30, 'audio', 30), aforo.consumoMbps(30, 'audio'));
});

test('CA-2 · el borde de 360p baja cuando todos tienen pantalla + cámara', () => {
  // 0,432 × n + 0,125 × n ≤ 96  →  n ≤ 172
  assert.strictEqual(aforo.capaPermitida(172, 172), '360p');
  assert.strictEqual(aforo.capaPermitida(173, 173), '180p');
  // Sin pantalla el borde sigue en 222 (aforo.test.js).
  assert.strictEqual(aforo.capaPermitida(222, 0), '360p');
});

test('CA-2 · ⭐ sigue siendo monótona con la cámara chica', () => {
  const orden = ['360p', '180p', 'audio', null];
  let peor = 0;
  for (let n = 0; n <= 5000; n++) {
    const i = orden.indexOf(aforo.capaPermitida(n, n));
    assert.ok(i >= peor, `con ${n} espectadores mejoró la capa`);
    peor = i;
  }
});

test('CA-2 · decidir() pasa la cámara chica a la cuenta y al consumo', () => {
  const d = aforo.decidir(173, { clases: 6, conPantallaYCamara: 173 });
  assert.strictEqual(d.capa, '180p');
  assert.ok(d.mbps <= PRESUPUESTO_MBPS);
});

// ── planDeVideo: qué recibe cada consumidor ──────────────────────────────────

test('planDeVideo · la cámara sola va en la capa del gobernador', () => {
  assert.deepStrictEqual(aforo.planDeVideo({ fuente: 'camara', hayPantalla: false, capa: '360p' }),
    { pausar: false, capa: 1 });
  assert.deepStrictEqual(aforo.planDeVideo({ fuente: 'camara', hayPantalla: false, capa: '180p' }),
    { pausar: false, capa: 0 });
});

test('planDeVideo · ⭐ la cámara chica va en la capa baja, y solo en la mejor capa', () => {
  assert.deepStrictEqual(aforo.planDeVideo({ fuente: 'camara', hayPantalla: true, capa: '360p' }),
    { pausar: false, capa: 0 });
  assert.deepStrictEqual(aforo.planDeVideo({ fuente: 'camara', hayPantalla: true, capa: '180p' }),
    { pausar: true, capa: 0 });
});

test('planDeVideo · la pantalla nunca se pausa salvo en solo audio', () => {
  assert.strictEqual(aforo.planDeVideo({ fuente: 'pantalla', hayPantalla: true, capa: '180p' }).pausar, false);
  assert.strictEqual(aforo.planDeVideo({ fuente: 'pantalla', hayPantalla: true, capa: 'audio' }).pausar, true);
  assert.strictEqual(aforo.planDeVideo({ fuente: 'camara', hayPantalla: false, capa: 'audio' }).pausar, true);
});

// ── CA-3 · el 'bienvenido' manda la fuente ───────────────────────────────────

test('CA-3 · describirProductores incluye la fuente y omite los cerrados', () => {
  const prod = (id, kind, fuente, closed = false) => ({ id, kind, closed, appData: { fuente } });
  const sala = { productores: new Map([
    ['1', prod('1', 'audio', 'micro')],
    ['2', prod('2', 'video', 'camara')],
    ['3', prod('3', 'video', 'pantalla', true)],
    ['4', { id: '4', kind: 'video', closed: false, appData: {} }],
  ]) };
  assert.deepStrictEqual(sfu.describirProductores(sala), [
    { id: '1', kind: 'audio', fuente: 'micro' },
    { id: '2', kind: 'video', fuente: 'camara' },
    { id: '4', kind: 'video', fuente: '' },
  ]);
});

test('CA-3 · el servidor de medios usa describirProductores en el bienvenido', () => {
  const src = fs.readFileSync(path.join(raiz, 'media', 'servidor.js'), 'utf8');
  assert.match(src, /productores:\s*sfu\.describirProductores\(cx\.sala\)/);
});

// ── CA-4 · la vista ──────────────────────────────────────────────────────────

const parcial = path.join(raiz, 'views', 'partials', 'transmision.ejs');
const render = (esGestor) => ejs.render(fs.readFileSync(parcial, 'utf8'),
  { course: { _id: 'abc' }, sala: null, esGestor, esAlumno: !esGestor }, { filename: parcial });

test('CA-4 · el docente tiene el cuadro chico y el botón chico adentro del cuadro', () => {
  const html = render(true);
  // Entre la apertura de #txCuadro y su cartel #txSinVideo: es decir, adentro del cuadro.
  const desde = html.indexOf('id="txCuadro"');
  const hasta = html.indexOf('id="txSinVideo"');
  const adentro = html.slice(desde, hasta);
  assert.ok(desde > -1 && hasta > desde);
  assert.ok(adentro.includes('id="txVideoChico"'), 'falta el cuadro chico');
  assert.ok(adentro.includes('id="txPantallaChico"'), 'el botón chico tiene que estar dentro del cuadro');
});

test('CA-4 · el alumno tiene el cuadro chico pero NO el botón', () => {
  const html = render(false);
  assert.ok(html.includes('id="txVideoChico"'));
  assert.ok(!html.includes('id="txPantallaChico"'));
});

test('CA-4 · el script de pistas se carga antes que transmision.js', () => {
  const html = render(true);
  const a = html.indexOf('/js/transmision-pistas.js');
  const b = html.indexOf('/js/transmision.js"');
  assert.ok(a > -1 && b > -1 && a < b);
});

test('CA-4 · en "Hablar" (solo voz) el botón chico también se esconde', () => {
  assert.match(fs.readFileSync(parcial, 'utf8'), /\.tx-solovoz #txPantallaChico/);
});

// ── CA-5 · Transmitir arranca con la cámara ──────────────────────────────────

test('CA-5 · el botón Transmitir pide cámara y no pantalla', () => {
  const src = fs.readFileSync(path.join(raiz, 'views', 'partials', 'live-room.ejs'), 'utf8');
  assert.match(src, /'\/transmision\/abrir', \{ micro: true, pantalla: false, camara: true \}/);
  assert.match(src, /empezarAEmitir\(\{ micro: true, pantalla: false, camara: true \}\)/);
  assert.doesNotMatch(src, /'\/transmision\/abrir', \{ micro: true, pantalla: true/);
});
