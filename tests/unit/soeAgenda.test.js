// Tests de las citaciones y del calendario del gabinete (services/soeAgenda.js).
// Correr con: npm run test:unit
//
// Por qué acá y no en un smoke HTTP: casi todo lo que decide esta feature es una comparación
// de FECHAS, y por HTTP no se puede parar el reloj. Probar "la citación del martes pasado
// aparece resaltada" contra un servidor obligaría a esperar a que sea miércoles. Acá el día
// es un parámetro.
//
// ⭐ Y hay una segunda razón, más importante: la trampa de zona horaria del proyecto. Producción
// corre en UTC y la escuela vive en UTC−3. Media docena de estos tests existen para fijar que
// el día de una citación es TEXTO y no se convierte nunca a un instante.
//
// Cubren los criterios 13 a 30 de specs/soe-adjuntos-y-agenda.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ag = require('../../services/soeAgenda');

const cita = (dia, estado = 'programada', extra = {}) =>
  ({ _id: dia + estado, dia, estado, a: 'familia', motivo: 'Charlar', ...extra });

describe('el día y la hora son TEXTO', () => {
  test('⭐ una hora válida se guarda tal cual; una basura, se descarta (criterio 13)', () => {
    assert.strictEqual(ag.normalizarHora('14:30'), '14:30');
    assert.strictEqual(ag.normalizarHora('00:00'), '00:00');
    assert.strictEqual(ag.normalizarHora('23:59'), '23:59');
    // Nada de esto puede terminar guardado y después impreso en la ficha.
    for (const mala of ['24:00', '9:5', '14.30', '14:60', 'mañana', '', null, undefined, '2026-08-30T14:30']) {
      assert.strictEqual(ag.normalizarHora(mala), '', `debería descartar: ${mala}`);
    }
  });

  test('la hora vacía es legítima: se puede citar "a la mañana"', () => {
    assert.strictEqual(ag.normalizarHora(''), '');
    assert.ok(!ag.horaValida(''));
  });

  test('⭐ el orden de las citaciones sale de comparar strings, sin construir ninguna fecha', () => {
    // El orden lexicográfico de YYYY-MM-DD ES el orden cronológico. No hay conversión de por
    // medio, así que no hay nada que se pueda correr un día. Es el criterio de todo el
    // proyecto para fechas de calendario (services/actividadesDelDia.js).
    const lista = [cita('2026-09-10'), cita('2026-08-30'), cita('2026-09-02')];
    assert.deepStrictEqual(ag.ordenarCitaciones(lista).map(c => c.dia),
      ['2026-08-30', '2026-09-02', '2026-09-10']);
    assert.deepStrictEqual(ag.ordenarCitaciones(lista, { descendente: true }).map(c => c.dia),
      ['2026-09-10', '2026-09-02', '2026-08-30']);
  });

  test('dentro del mismo día, la que no tiene hora va primero', () => {
    // "El jueves a la mañana" es, en la práctica, antes que la de las 14:00.
    const lista = [
      cita('2026-09-02', 'programada', { hora: '14:00' }),
      cita('2026-09-02', 'confirmada', { hora: '' }),
      cita('2026-09-02', 'programada', { hora: '09:15' }),
    ];
    assert.deepStrictEqual(ag.ordenarCitaciones(lista).map(c => c.hora), ['', '09:15', '14:00']);
  });
});

describe('cuándo una citación pide atención', () => {
  const HOY = '2026-08-30';

  test('⭐ pasó el día y nadie anotó qué pasó (criterio 14)', () => {
    // Es el agujero que esta feature vino a tapar: el gabinete cita a la familia, la familia
    // no viene, y no queda nada escrito. Al mes siguiente se vuelve a empezar.
    assert.strictEqual(ag.citacionSinRegistrar(cita('2026-08-25'), HOY), true);
    assert.strictEqual(ag.citacionSinRegistrar(cita('2026-08-25', 'confirmada'), HOY), true);
  });

  test('la de HOY todavía no pide nada: el día no terminó (criterio 15)', () => {
    // Resaltar en rojo a las 8 de la mañana la citación de las 11 sería mentir.
    assert.strictEqual(ag.citacionSinRegistrar(cita(HOY), HOY), false);
    assert.strictEqual(ag.citacionEsHoy(cita(HOY), HOY), true);
  });

  test('la que ya se registró no pide nada, aunque haya pasado hace meses', () => {
    for (const estado of ag.CITACION_RESUELTA) {
      assert.strictEqual(ag.citacionSinRegistrar(cita('2026-01-05', estado), HOY), false,
        `una citación ${estado} no debería seguir pidiendo atención`);
    }
  });

  test('la futura cuenta como próxima, no como pendiente', () => {
    assert.strictEqual(ag.citacionProxima(cita('2026-09-15'), HOY), true);
    assert.strictEqual(ag.citacionSinRegistrar(cita('2026-09-15'), HOY), false);
    // Y una cancelada no es "lo que viene", aunque su día no haya llegado.
    assert.strictEqual(ag.citacionProxima(cita('2026-09-15', 'cancelada'), HOY), false);
  });

  test('una fecha inválida no rompe ni inventa una alarma', () => {
    for (const mala of [null, undefined, '', 'ayer', '30/08/2026']) {
      assert.strictEqual(ag.citacionSinRegistrar(cita(mala), HOY), false);
      assert.strictEqual(ag.citacionProxima(cita(mala), HOY), false);
    }
    assert.strictEqual(ag.citacionSinRegistrar(cita('2026-08-25'), 'basura'), false);
  });

  test('reprogramada cuenta como RESUELTA y no como activa (criterio 16)', () => {
    // Pasar una citación para otro día cierra ésta y abre otra. Si siguiera activa, el legajo
    // tendría dos citaciones vivas para el mismo encuentro y el gabinete no sabría cuál mirar.
    assert.ok(ag.CITACION_RESUELTA.includes('reprogramada'));
    assert.ok(!ag.CITACION_ACTIVA.includes('reprogramada'));
    assert.strictEqual(ag.citacionActiva(cita('2026-09-15', 'reprogramada')), false);
  });
});

describe('qué citaciones entran a la línea de tiempo', () => {
  const HOY = '2026-08-30';

  test('⭐ la futura NO entra: es agenda, no historia (criterio 17)', () => {
    // Con el orden "lo último arriba", una citación para dentro de tres semanas se sentaría
    // por encima de todo lo que de verdad ocurrió, y el hilo se leería como si el futuro ya
    // hubiera sucedido.
    assert.strictEqual(ag.citacionEnLinea(cita('2026-09-20'), HOY), false);
    assert.strictEqual(ag.citacionEnLinea(cita('2026-09-20', 'confirmada'), HOY), false);
  });

  test('la de hoy y la ya pasada sí entran', () => {
    assert.strictEqual(ag.citacionEnLinea(cita(HOY), HOY), true);
    assert.strictEqual(ag.citacionEnLinea(cita('2026-08-01'), HOY), true);
  });

  test('la cancelada entra aunque su día no haya llegado (criterio 18)', () => {
    // Cancelar es algo que pasó, y es justamente lo que hay que poder leer el año que viene.
    assert.strictEqual(ag.citacionEnLinea(cita('2026-12-01', 'cancelada'), HOY), true);
    assert.strictEqual(ag.citacionEnLinea(cita('2026-12-01', 'reprogramada'), HOY), true);
  });

  test('sin `hoy` no entra ninguna pendiente: nunca inventa que un encuentro ocurrió', () => {
    // El comportamiento seguro ante un llamador que se olvidó del parámetro.
    assert.strictEqual(ag.citacionEnLinea(cita('2020-01-01'), null), false);
    // Pero las resueltas entran igual: no dependen de ninguna comparación de fechas.
    assert.strictEqual(ag.citacionEnLinea(cita('2020-01-01', 'realizada'), null), true);
  });
});

describe('los eventos del calendario', () => {
  const HOY = '2026-08-30';

  // Un legajo con las tres clases de fecha que mira el gabinete.
  const LEGAJO = {
    _id: 'caso1',
    student: { _id: 'alu1', name: 'Ana' },
    division: { _id: 'div1', name: '3°1°' },
    estado: 'seguimiento',
    // Mediodía UTC, que es como los guarda la ruta: así el día de calendario es el mismo en
    // cualquier zona entre UTC−11 y UTC+11.
    proximoRepaso: new Date('2026-09-05T12:00:00Z'),
    citaciones: [cita('2026-09-02', 'programada', { hora: '14:30', lugar: 'Gabinete' })],
    referrals: [
      { _id: 'r1', destino: 'Hospital Zonal', estado: 'derivado',
        proximoSeguimiento: new Date('2026-08-20T12:00:00Z') },
    ],
  };

  test('las tres fechas del gabinete salen como tres eventos (criterio 19)', () => {
    const eventos = ag.eventosDelLegajo(LEGAJO, HOY);
    assert.deepStrictEqual(eventos.map(e => e.tipo).sort(), ['citacion', 'repaso', 'seguimiento']);
  });

  test('⭐ un Date guardado al mediodía UTC cae en SU día, no en el anterior (criterio 20)', () => {
    // La trampa de zona horaria del proyecto, entrando por la puerta del calendario.
    const eventos = ag.eventosDelLegajo(LEGAJO, HOY);
    assert.strictEqual(eventos.find(e => e.tipo === 'repaso').dia, '2026-09-05');
    assert.strictEqual(eventos.find(e => e.tipo === 'seguimiento').dia, '2026-08-20');
  });

  test('lo vencido queda marcado; lo que viene, no', () => {
    const eventos = ag.eventosDelLegajo(LEGAJO, HOY);
    assert.strictEqual(eventos.find(e => e.tipo === 'seguimiento').atencion, true);  // 20/08 < 30/08
    assert.strictEqual(eventos.find(e => e.tipo === 'repaso').atencion, false);      // 05/09 > 30/08
    assert.strictEqual(eventos.find(e => e.tipo === 'citacion').atencion, false);
    assert.strictEqual(ag.cuantosPidenAtencion(eventos), 1);
  });

  test('un legajo CERRADO no pide repaso, aunque le haya quedado la fecha (criterio 21)', () => {
    // Misma regla que legajoNecesitaRepaso de services/soeAcceso.js: cerrar no borra la fecha
    // —reabrirlo la devuelve tal cual— pero mientras está cerrado no molesta.
    const cerrado = { ...LEGAJO, estado: 'cerrado' };
    assert.ok(!ag.eventosDelLegajo(cerrado, HOY).some(e => e.tipo === 'repaso'));
    // La citación y el seguimiento sí siguen saliendo: son compromisos con gente de afuera.
    assert.strictEqual(ag.eventosDelLegajo(cerrado, HOY).length, 2);
  });

  test('un legajo sin ninguna fecha no produce eventos, y no rompe', () => {
    assert.deepStrictEqual(ag.eventosDelLegajo({ _id: 'x', estado: 'abierto' }, HOY), []);
    assert.deepStrictEqual(ag.eventosDelLegajo(null, HOY), []);
  });

  test('una citación con día inválido se descarta en vez de ensuciar el calendario', () => {
    const roto = { ...LEGAJO, citaciones: [cita('ayer')], proximoRepaso: null, referrals: [] };
    assert.deepStrictEqual(ag.eventosDelLegajo(roto, HOY), []);
  });
});

describe('la grilla del mes', () => {
  const HOY = '2026-08-30';

  const evento = (dia, tipo = 'citacion', extra = {}) => ({ dia, tipo, hora: '', atencion: false, ...extra });

  test('semanas completas de 7 celdas, con relleno en null (criterio 22)', () => {
    const cal = ag.armarCalendario('2026-09', [], HOY);
    assert.strictEqual(cal.mes, '2026-09');
    for (const semana of cal.semanas) assert.strictEqual(semana.length, 7);
    // Septiembre de 2026 tiene 30 días.
    assert.strictEqual(cal.semanas.flat().filter(Boolean).length, 30);
  });

  test('cada evento cae en su celda', () => {
    const cal = ag.armarCalendario('2026-09', [evento('2026-09-02'), evento('2026-09-02'), evento('2026-09-15')], HOY);
    const celdas = cal.semanas.flat().filter(c => c && c.eventos.length);
    assert.deepStrictEqual(celdas.map(c => c.dia), ['2026-09-02', '2026-09-15']);
    assert.strictEqual(celdas[0].eventos.length, 2);
  });

  test('⭐ un evento de otro mes NO se pinta (criterio 23)', () => {
    // Sin este filtro, el evento de octubre terminaría en una celda de relleno o —peor— en la
    // celda del mismo número de septiembre.
    const cal = ag.armarCalendario('2026-09', [evento('2026-10-02'), evento('2026-08-15')], HOY);
    assert.strictEqual(cal.semanas.flat().filter(c => c && c.eventos.length).length, 0);
  });

  test('el mes de hoy queda marcado y los vecinos se pueden navegar', () => {
    const cal = ag.armarCalendario('2026-08', [], HOY);
    assert.strictEqual(cal.anterior, '2026-07');
    assert.strictEqual(cal.siguiente, '2026-09');
    const hoy = cal.semanas.flat().find(c => c && c.esHoy);
    assert.strictEqual(hoy.dia, HOY);
    assert.strictEqual(hoy.numero, 30);
  });

  test('un mes basura cae en el mes actual en vez de romper', () => {
    // El valor llega de la query string y no es confiable.
    for (const malo of ['2026-13', 'agosto', '', null, '2026-8']) {
      const cal = ag.armarCalendario(malo, [], HOY);
      assert.ok(/^\d{4}-\d{2}$/.test(cal.mes), `mes inválido devolvió ${cal.mes}`);
    }
  });
});

describe('lo que viene', () => {
  const HOY = '2026-08-30';
  const evento = (dia, atencion = false) => ({ dia, tipo: 'citacion', hora: '', atencion });

  test('⭐ la lista incluye lo VENCIDO, no solo lo futuro (criterio 24)', () => {
    // Una agenda que solo mira para adelante es la que deja atrás al chico del que nadie se
    // acordó. Lo vencido es justamente lo que hay que ver.
    const lista = ag.proximos([evento('2026-08-10', true), evento('2026-09-01')], HOY, 14);
    assert.deepStrictEqual(lista.map(e => e.dia), ['2026-08-10', '2026-09-01']);
  });

  test('lo que ya pasó y NO pide nada queda afuera', () => {
    const lista = ag.proximos([evento('2026-08-10', false), evento('2026-09-01')], HOY, 14);
    assert.deepStrictEqual(lista.map(e => e.dia), ['2026-09-01']);
  });

  test('la ventana corta a los N días', () => {
    const lista = ag.proximos([evento('2026-09-05'), evento('2026-12-01')], HOY, 14);
    assert.deepStrictEqual(lista.map(e => e.dia), ['2026-09-05']);
    assert.strictEqual(ag.sumarDias(HOY, 14), '2026-09-13');
  });

  test('sumar días cruza el fin de mes y el fin de año sin corrimientos', () => {
    // Aritmética de casilleros de almanaque, en UTC puro: el horario de verano no tiene nada
    // que opinar acá.
    assert.strictEqual(ag.sumarDias('2026-08-31', 1), '2026-09-01');
    assert.strictEqual(ag.sumarDias('2026-12-31', 1), '2027-01-01');
    assert.strictEqual(ag.sumarDias('2028-02-28', 1), '2028-02-29');  // bisiesto
    assert.strictEqual(ag.sumarDias('2026-09-01', -1), '2026-08-31');
  });

  test('un `hoy` inválido devuelve lista vacía en vez de una fecha imposible', () => {
    assert.deepStrictEqual(ag.proximos([evento('2026-09-01')], 'basura', 14), []);
  });
});

describe('catálogos', () => {
  test('cada estado de citación tiene etiqueta y color', () => {
    for (const e of ag.ESTADOS_CITACION) {
      assert.ok(ag.ESTADO_CITACION_LABELS[e], `falta la etiqueta de ${e}`);
      assert.ok(ag.ESTADO_CITACION_COLORS[e], `falta el color de ${e}`);
    }
  });

  test('activas y resueltas parten el conjunto en dos, sin superponerse (criterio 25)', () => {
    // Un estado que quedara en las dos listas —o en ninguna— haría que una citación fuera y
    // no fuera una deuda al mismo tiempo.
    const union = [...ag.CITACION_ACTIVA, ...ag.CITACION_RESUELTA].sort();
    assert.deepStrictEqual(union, ag.ESTADOS_CITACION.slice().sort());
    for (const e of ag.CITACION_ACTIVA) {
      assert.ok(!ag.CITACION_RESUELTA.includes(e), `${e} está en las dos listas`);
    }
  });

  test('cada tipo de citado y cada tipo de evento tienen etiqueta e ícono', () => {
    for (const c of ag.CITADOS) {
      assert.ok(ag.CITADO_LABELS[c], `falta la etiqueta de ${c}`);
      assert.ok(ag.CITADO_ICONS[c],  `falta el ícono de ${c}`);
    }
    for (const t of ag.TIPOS_EVENTO) {
      assert.ok(ag.EVENTO_LABELS[t], `falta la etiqueta de ${t}`);
      assert.ok(ag.EVENTO_ICONS[t],  `falta el ícono de ${t}`);
      assert.ok(ag.EVENTO_COLORS[t], `falta el color de ${t}`);
    }
  });

  test('citar a la familia y citar al alumno son cosas distintas', () => {
    // No es un detalle administrativo: son dos actuaciones distintas del gabinete, y el
    // legajo tiene que poder distinguirlas cuando alguien lo lea el año que viene.
    assert.ok(ag.CITADOS.includes('familia'));
    assert.ok(ag.CITADOS.includes('alumno'));
    assert.ok(ag.CITADOS.includes('familia_y_alumno'));
  });
});

describe('el reloj', () => {
  test('hoyEscolar devuelve un día de calendario bien formado', () => {
    // Es la única función del archivo que mira el reloj. Todas las demás reciben el día como
    // parámetro, para poder testearse paradas en cualquier fecha.
    assert.ok(ag.diaValido(ag.hoyEscolar()));
  });
});
