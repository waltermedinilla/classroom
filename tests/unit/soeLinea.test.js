// Tests de la línea de tiempo del legajo (services/soeLinea.js).
// Correr con: npm run test:unit
//
// Por qué acá y no en un smoke HTTP: `construirLinea` decide QUÉ actuaciones del gabinete se
// ven y en qué orden. Probarlo por HTTP obligaría a fabricar un legajo con entradas de hace
// seis meses, una derivación y su devolución tardía — todo eso es una tarde de setup para
// probar una función que no toca la base. Acá se arma el legajo a mano en tres líneas.
//
// Cubren los criterios 1 a 7 de specs/soe-derivacion-y-linea-de-tiempo.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { construirLinea } = require('../../services/soeLinea');
const { sanitizarLegajo, RESUMEN, COMPLETO } = require('../../services/soeAcceso');

const d = (iso) => new Date(`${iso}T12:00:00Z`);

// Un legajo con las cuatro clases de hito, tal como sale de sanitizarLegajo en nivel
// completo. Las fechas están salteadas a propósito: el orden de la línea no puede salir del
// orden en que están guardadas.
const LEGAJO = {
  _id: 'caso1',
  estado: 'abierto',
  prioridad: 'media',
  motivo: 'Faltas reiteradas desde marzo',
  openedAt: d('2026-03-01'),
  openedBy: 'soe1',
  entries: [
    { _id: 'e1', fecha: d('2026-03-12'), tipo: 'entrevista',  animo: 'bien',        texto: 'Se habló de la situación en casa', autor: 'soe1' },
    { _id: 'e2', fecha: d('2026-05-20'), tipo: 'observacion', animo: 'preocupante', texto: 'Aislado en el recreo',             autor: 'soe1' },
  ],
  referrals: [
    {
      _id: 'r1',
      destino: 'Hospital Zonal — Salud Mental',
      tipo: 'salud_mental',
      motivo: 'Evaluación',
      fecha: d('2026-03-20'),
      estado: 'en_tratamiento',
      devoluciones: [
        // Seis meses después de la derivación: es el caso que motiva el criterio 3.
        { _id: 'v1', fecha: d('2026-09-15'), texto: 'Empezó tratamiento semanal' },
      ],
    },
  ],
};

const fechas = (hitos) => hitos.map(h => h.fecha.toISOString().slice(0, 10));
const tipos  = (hitos) => hitos.map(h => h.tipo);

describe('construirLinea — qué hitos arma', () => {
  test('un hito por entrada, derivación y devolución, más el de apertura (criterio 1)', () => {
    const hitos = construirLinea(LEGAJO);
    // 2 entradas + 1 derivación + 1 devolución + 1 apertura = 5.
    assert.strictEqual(hitos.length, 5);
    assert.deepStrictEqual(
      tipos(hitos).slice().sort(),
      ['apertura', 'derivacion', 'devolucion', 'entrada', 'entrada'],
    );
  });

  test('la devolución tardía cae en SU fecha, no junto a la derivación (criterio 3)', () => {
    // Es el dato que la spec madre dice que hoy se pierde: el hospital contestó en
    // septiembre. Si el hito se dibujara adentro de la derivación, esa fecha desaparece
    // del hilo y queda pegada al 20 de marzo.
    const hitos = construirLinea(LEGAJO, { orden: 'cronologico' });
    const devolucion = hitos.find(h => h.tipo === 'devolucion');
    assert.strictEqual(devolucion.fecha.toISOString().slice(0, 10), '2026-09-15');
    // Y es el último de la línea, no el segundo.
    assert.strictEqual(hitos[hitos.length - 1].tipo, 'devolucion');
    // Conserva a qué derivación pertenece, para poder linkear al panel de gestión.
    assert.strictEqual(devolucion.refId, 'r1');
  });

  test('el legajo cerrado suma el hito de cierre; el abierto no (criterio 4)', () => {
    assert.strictEqual(construirLinea(LEGAJO).some(h => h.tipo === 'cierre'), false);

    const cerrado = {
      ...LEGAJO,
      estado: 'cerrado',
      closedAt: d('2026-11-30'),
      cierreMotivo: 'Alta del servicio',
    };
    const hito = construirLinea(cerrado).find(h => h.tipo === 'cierre');
    assert.ok(hito, 'el legajo cerrado tiene que dejar su hito');
    assert.match(hito.texto, /Alta del servicio/);
  });

  test('una entrada sin ánimo da un hito sin tinte, no un hito roto (criterio 6)', () => {
    // `animo` es null a propósito en el modelo: un acuerdo con docentes no dice nada sobre
    // cómo estaba el chico. La línea tiene que dibujarlo igual, sin color.
    const legajo = {
      ...LEGAJO,
      referrals: [],
      entries: [{ _id: 'e9', fecha: d('2026-04-01'), tipo: 'acuerdo_docente', animo: null, texto: 'Se acordó sentarlo adelante', autor: 'soe1' }],
    };
    const hito = construirLinea(legajo).find(h => h.tipo === 'entrada');
    assert.strictEqual(hito.animo, null);
    assert.ok(hito.titulo, 'igual tiene título');
    assert.ok(hito.icono,  'igual tiene ícono');
  });

  test('el hito de entrada conserva tipo, autor e ícono del catálogo', () => {
    const entrevista = construirLinea(LEGAJO).find(h => h.subtipo === 'entrevista');
    assert.strictEqual(entrevista.titulo, 'Entrevista');
    assert.strictEqual(entrevista.icono,  'record_voice_over');
    assert.strictEqual(entrevista.autor,  'soe1');
    assert.strictEqual(entrevista.animo,  'bien');
  });

  test('el hito de derivación nombra el destino y su estado actual', () => {
    const hito = construirLinea(LEGAJO).find(h => h.tipo === 'derivacion');
    assert.match(hito.titulo, /Hospital Zonal/);
    assert.strictEqual(hito.meta, 'En tratamiento');
    assert.strictEqual(hito.refId, 'r1');
  });
});

describe('construirLinea — orden', () => {
  test('por defecto lo más reciente arriba (criterio 2, decisión D7)', () => {
    assert.deepStrictEqual(
      fechas(construirLinea(LEGAJO)),
      ['2026-09-15', '2026-05-20', '2026-03-20', '2026-03-12', '2026-03-01'],
    );
  });

  test('cronológico invierte el hilo, como el Screenshot_5 (criterio 2)', () => {
    assert.deepStrictEqual(
      fechas(construirLinea(LEGAJO, { orden: 'cronologico' })),
      ['2026-03-01', '2026-03-12', '2026-03-20', '2026-05-20', '2026-09-15'],
    );
  });

  test('un orden desconocido cae en el default, no rompe', () => {
    assert.deepStrictEqual(
      fechas(construirLinea(LEGAJO, { orden: 'vertical' })),
      fechas(construirLinea(LEGAJO)),
    );
  });
});

describe('construirLinea — confidencialidad por construcción', () => {
  test('el legajo sanitizado en resumen no tiene con qué armar la línea (criterio 5)', () => {
    // La función NO tiene ninguna regla de confidencialidad propia, y es a propósito
    // (decisión D6): recibe el legajo ya sanitizado, y en nivel resumen ese objeto no trae
    // entries ni referrals. Si mañana vuelve un nivel intermedio, esto sigue valiendo sin
    // que haya que acordarse de tocar soeLinea.js.
    const enResumen = sanitizarLegajo(LEGAJO, RESUMEN);
    assert.strictEqual(construirLinea(enResumen).length, 0);

    // Y el mismo legajo en completo sí arma la línea entera: la diferencia la hace el
    // sanitizado, no esta función.
    assert.strictEqual(construirLinea(sanitizarLegajo(LEGAJO, COMPLETO)).length, 5);
  });

  test('sin legajo devuelve lista vacía (criterio 7)', () => {
    // Es el caso real del alumno sin legajo abierto: la ficha se dibuja igual.
    assert.deepStrictEqual(construirLinea(null),      []);
    assert.deepStrictEqual(construirLinea(undefined), []);
    assert.deepStrictEqual(construirLinea({}),        []);
  });

  test('un legajo con los arrays ausentes no explota', () => {
    const pelado = { _id: 'c2', openedAt: d('2026-02-01'), motivo: '' };
    const hitos = construirLinea(pelado);
    assert.strictEqual(hitos.length, 1);
    assert.strictEqual(hitos[0].tipo, 'apertura');
  });
});
