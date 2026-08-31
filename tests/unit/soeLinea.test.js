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

// ═════════════════════════════════════════════════════════════════════════════
// Las citaciones y el material (2026-08-30)
// ═════════════════════════════════════════════════════════════════════════════
//
// Cubren los criterios 26 a 30 de specs/soe-adjuntos-y-agenda.spec.md.

const HOY = '2026-08-30';

// El mismo legajo de arriba, más una citación pasada, una futura y cuatro papeles.
const CON_MATERIAL = {
  ...LEGAJO,
  citaciones: [
    { _id: 'c1', dia: '2026-04-10', hora: '10:30', a: 'familia',
      motivo: 'Charlar por las inasistencias', estado: 'realizada',
      notas: 'Vino la mamá. Se acordó traer el certificado.', lugar: 'Gabinete', creadaPor: 'soe1' },
    { _id: 'c2', dia: '2026-12-01', hora: '09:00', a: 'alumno',
      motivo: 'Seguimiento de fin de año', estado: 'programada', creadaPor: 'soe1' },
  ],
  adjuntos: [
    { _id: 'ad1', kind: 'archivo', ancla: { tipo: 'devolucion', id: 'v1' },
      titulo: 'Certificado', categoria: 'certificado', fecha: d('2026-09-15') },
    { _id: 'ad2', kind: 'archivo', ancla: { tipo: 'devolucion', id: 'v1' },
      titulo: 'Receta', categoria: 'receta', fecha: d('2026-09-16') },
    { _id: 'ad3', kind: 'enlace',  ancla: { tipo: 'entrada', id: 'e1' },
      titulo: 'Protocolo', categoria: 'informe', fecha: d('2026-03-12') },
    { _id: 'ad4', kind: 'archivo', ancla: { tipo: 'legajo', id: null },
      titulo: 'Informe general', categoria: 'informe', fecha: d('2026-06-01') },
  ],
};

describe('construirLinea — las citaciones', () => {
  test('la citación pasada entra al hilo y la futura no (criterio 26)', () => {
    const hitos = construirLinea(CON_MATERIAL, { hoy: HOY });
    const citas = hitos.filter(h => h.tipo === 'citacion');
    assert.strictEqual(citas.length, 1);
    assert.strictEqual(citas[0].fecha.toISOString().slice(0, 10), '2026-04-10');
  });

  test('⭐ el día se ubica en el hilo sin correrse por la zona horaria (criterio 27)', () => {
    // El día es TEXTO ('YYYY-MM-DD') y se convierte al MEDIODÍA UTC solo para poder ordenar.
    // A medianoche, formateado en la zona de la escuela (UTC−3), se vería como el 9.
    const [cita] = construirLinea(CON_MATERIAL, { hoy: HOY }).filter(h => h.tipo === 'citacion');
    assert.strictEqual(cita.fecha.toISOString(), '2026-04-10T12:00:00.000Z');
    // Y la HORA viaja aparte, como el texto literal que es: nunca se suma a la fecha.
    assert.strictEqual(cita.submeta, '10:30');
  });

  test('el motivo y lo que se conversó son dos campos distintos (criterio 28)', () => {
    // Mezclarlos en un solo párrafo es lo que hace que un legajo no se pueda releer.
    const [cita] = construirLinea(CON_MATERIAL, { hoy: HOY }).filter(h => h.tipo === 'citacion');
    assert.ok(cita.texto.includes('inasistencias'));
    assert.ok(cita.resultado.includes('Vino la mamá'));
    assert.strictEqual(cita.lugar, 'Gabinete');
  });

  test('sin `hoy` solo entran las YA RESUELTAS: nunca inventa que un encuentro ocurrió', () => {
    // El comportamiento seguro ante un llamador que se olvidó del parámetro. La citación
    // 'realizada' entra igual —no depende de ninguna comparación de fechas—, pero una
    // pendiente cuyo día pasó se queda afuera hasta que alguien diga qué día es hoy.
    const soloPendientes = {
      ...CON_MATERIAL,
      citaciones: [{ _id: 'c9', dia: '2020-01-01', a: 'familia', motivo: 'Vieja', estado: 'programada' }],
    };
    assert.strictEqual(construirLinea(soloPendientes).filter(h => h.tipo === 'citacion').length, 0);
    assert.strictEqual(construirLinea(CON_MATERIAL).filter(h => h.tipo === 'citacion').length, 1);
  });

  test('la citación se ordena entre los demás hitos por su fecha, no al final', () => {
    // El punto de la línea de tiempo es el RECORRIDO: la citación de abril va entre la
    // derivación de marzo y la observación de mayo.
    const cronologico = construirLinea(CON_MATERIAL, { hoy: HOY, orden: 'cronologico' });
    assert.deepStrictEqual(fechas(cronologico),
      ['2026-03-01', '2026-03-12', '2026-03-20', '2026-04-10', '2026-05-20', '2026-09-15']);
  });
});

describe('construirLinea — el material colgado de cada hito', () => {
  test('⭐ el certificado y la receta cuelgan de la DEVOLUCIÓN (criterio 29)', () => {
    // Es el caso que motivó la feature: el chico vuelve del hospital con un papel, y ese
    // papel pertenece al hito de "lo que dijeron allá".
    const hitos = construirLinea(CON_MATERIAL, { hoy: HOY });
    const devolucion = hitos.find(h => h.tipo === 'devolucion');
    assert.strictEqual(devolucion.adjuntos.length, 2);
    // Lo más nuevo primero, por la fecha DEL DOCUMENTO.
    assert.deepStrictEqual(devolucion.adjuntos.map(a => a.titulo), ['Receta', 'Certificado']);
  });

  test('cada hito recibe solo lo suyo, y siempre un array (criterio 30)', () => {
    const hitos = construirLinea(CON_MATERIAL, { hoy: HOY });
    // Que TODOS tengan el campo es lo que deja escribir `h.adjuntos.length` en la vista sin
    // un `if` por tipo de hito.
    for (const h of hitos) assert.ok(Array.isArray(h.adjuntos), `${h.tipo} sin adjuntos`);
    assert.strictEqual(hitos.find(h => h.subtipo === 'entrevista').adjuntos.length, 1);
    assert.strictEqual(hitos.find(h => h.tipo === 'derivacion').adjuntos.length, 0);
  });

  test('el material general del legajo NO va colgado de la apertura', () => {
    // Un informe cargado hoy aparecería dentro de la tarjeta de apertura, que está al fondo
    // del hilo por ser lo más viejo, y quedaría escondido justo el día que se subió. Ese
    // material vive en el panel "Material y documentación", que es un índice y no una
    // cronología.
    const apertura = construirLinea(CON_MATERIAL, { hoy: HOY }).find(h => h.tipo === 'apertura');
    assert.strictEqual(apertura.ancla, null);
    assert.deepStrictEqual(apertura.adjuntos, []);
  });

  test('en resumen no hay ni citaciones ni material que colgar', () => {
    // Otra vez sin ninguna regla propia: el sanitizado no le entrega los arrays.
    const enResumen = sanitizarLegajo(CON_MATERIAL, RESUMEN);
    assert.strictEqual(construirLinea(enResumen, { hoy: HOY }).length, 0);
  });

  test('un legajo sin adjuntos ni citaciones sigue armando la línea de siempre', () => {
    // El caso de los legajos que ya existen en producción: no tienen los arrays nuevos y no
    // necesitan migración.
    assert.strictEqual(construirLinea(LEGAJO, { hoy: HOY }).length, 5);
    assert.deepStrictEqual(construirLinea(LEGAJO, { hoy: HOY })[0].adjuntos, []);
  });
});
