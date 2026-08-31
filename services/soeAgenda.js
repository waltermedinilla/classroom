// La agenda del gabinete: las citaciones y el calendario donde caen.
//
// Qué problema resuelve. El gabinete cita a la familia por teléfono, lo anota en un cuaderno,
// y el día que la madre no aparece no queda nada escrito: ni que se la citó, ni para cuándo,
// ni que faltó. Al mes siguiente se vuelve a empezar. Una citación es una ACTUACIÓN del
// legajo como cualquier otra —tiene fecha, motivo, un resultado y papeles— y por eso vive
// adentro del legajo y no en una agenda aparte.
//
// El calendario suma, además, las otras dos fechas que el gabinete ya tenía sueltas: cuándo
// volver a ver a un chico (`SoeCase.proximoRepaso`) y cuándo volver a preguntarle a un
// servicio externo (`referrals[].proximoSeguimiento`). Las tres son "algo que hay que hacer
// tal día", y hasta ahora vivían en tres pantallas distintas.
//
// ── LA REGLA DE FECHAS DE ESTE ARCHIVO, que es la que hay que entender antes de tocarlo ──
//
// Una citación NO se guarda como un instante (un `Date`). Se guarda como un día de calendario
// ('YYYY-MM-DD') más una hora literal ('HH:MM'), exactamente igual que models/Reserva.js.
// El motivo es la trampa de zona horaria del proyecto: producción corre en UTC, la escuela
// vive en UTC−3, y un `new Date('2026-09-02T14:30')` interpretado en el servidor mueve la
// citación de las 14:30 a las 11:30 —o al día anterior si es temprano— sin que nadie se
// entere. Con un día y una hora que son TEXTO no hay nada que convertir y nada que se corra.
//
// La única conversión que ocurre acá es la contraria —un `Date` guardado (proximoRepaso,
// proximoSeguimiento) a su día de calendario— y la hace `diaEscolar()` de
// services/liveRoom.js, que es el único dueño de la hora en todo el proyecto. No se duplica
// acá ni se reemplaza por `toISOString().slice(0,10)`: eso daría el día UTC, que a partir de
// las 21:00 de la escuela ya es el día siguiente.
//
// Salvo esa conversión y `hoy()`, todo lo demás es PURO y recibe el día como parámetro, para
// que los tests puedan pararse en cualquier fecha sin tocar el reloj de la máquina.
//
// Ver specs/soe-adjuntos-y-agenda.spec.md.

const { diaEscolar } = require('./liveRoom');
const { grillaDelMes, mesValido, diaValido, mesActual, mesAnterior, mesSiguiente, nombreDelMes } =
  require('./actividadesDelDia');

// ── A quién se cita ──────────────────────────────────────────────────────────
//
// No es lo mismo citar a la madre que citar al chico, y no es un detalle administrativo: son
// dos actuaciones distintas del gabinete y el legajo tiene que poder distinguirlas cuando
// alguien lo lea el año que viene.
const CITADOS = ['familia', 'alumno', 'familia_y_alumno', 'docentes', 'equipo', 'externo'];

const CITADO_LABELS = {
  familia:          'La familia',
  alumno:           'El alumno',
  familia_y_alumno: 'La familia y el alumno',
  docentes:         'Los docentes',
  equipo:           'El equipo de la escuela',
  externo:          'Un profesional externo',
};

const CITADO_ICONS = {
  familia:          'family_restroom',
  alumno:           'person',
  familia_y_alumno: 'groups',
  docentes:         'co_present',
  equipo:           'diversity_3',
  externo:          'stethoscope',
};

// ── En qué estado está ───────────────────────────────────────────────────────
const ESTADOS_CITACION = [
  'programada', 'confirmada', 'realizada', 'ausente', 'reprogramada', 'cancelada',
];

const ESTADO_CITACION_LABELS = {
  programada:   'Citada',
  confirmada:   'Confirmada',
  realizada:    'Se presentó',
  ausente:      'No se presentó',
  reprogramada: 'Se pasó para otro día',
  cancelada:    'Cancelada',
};

const ESTADO_CITACION_COLORS = {
  programada:   '#1a73e8',
  confirmada:   '#137333',
  realizada:    '#137333',
  ausente:      '#ea4335',
  reprogramada: '#ea8600',
  cancelada:    '#5f6368',
};

// Las que TODAVÍA ESPERAN algo. La diferencia con las resueltas es la que hace sonar la
// alarma: una citación programada cuyo día ya pasó es una citación de la que nadie registró
// qué pasó, y es exactamente el agujero por el que hoy se pierde el dato.
const CITACION_ACTIVA = ['programada', 'confirmada'];

// Las que ya no esperan nada. `reprogramada` está acá y no arriba a propósito: pasar una
// citación para otro día CIERRA ésta y se carga otra. Si siguiera activa, el legajo tendría
// dos citaciones vivas para el mismo encuentro y el gabinete no sabría cuál mirar.
const CITACION_RESUELTA = ['realizada', 'ausente', 'reprogramada', 'cancelada'];

// Las dos que cuentan como "el encuentro pasó": son las que la ficha muestra con lo que se
// conversó, y las únicas de las que tiene sentido colgar un acta firmada.
const CITACION_OCURRIO = ['realizada', 'ausente'];

// ── Horas ────────────────────────────────────────────────────────────────────
//
// 'HH:MM' de 00:00 a 23:59, o '' — una citación sin hora es legítima ("el jueves, a la
// mañana"). Nunca se convierte a un instante: se guarda y se muestra tal cual.
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const horaValida = (h) => typeof h === 'string' && HORA_RE.test(h);
const normalizarHora = (h) => (horaValida(String(h || '').trim()) ? String(h).trim() : '');

// ── Preguntas sobre una citación ─────────────────────────────────────────────
//
// Todas reciben `hoy` como 'YYYY-MM-DD'. La comparación de strings alcanza y sobra: el orden
// lexicográfico de YYYY-MM-DD ES el orden cronológico, y no hay ninguna conversión de por
// medio que pueda correr un día. Es el mismo criterio de services/actividadesDelDia.js.

const citacionActiva = (c) => !!c && CITACION_ACTIVA.includes(c.estado);

// ⭐ La que evita el agujero: pasó el día y nadie anotó qué pasó. Se resalta en la ficha, en
// la agenda y en el resumen del panel, igual que una derivación sin respuesta.
const citacionSinRegistrar = (c, hoy) =>
  citacionActiva(c) && diaValido(c && c.dia) && diaValido(hoy) && c.dia < hoy;

// Las que vienen: de hoy en adelante y todavía activas.
const citacionProxima = (c, hoy) =>
  citacionActiva(c) && diaValido(c && c.dia) && diaValido(hoy) && c.dia >= hoy;

const citacionEsHoy = (c, hoy) => citacionActiva(c) && !!c && c.dia === hoy;

// Del día más cercano al más lejano, y dentro del día por hora. La citación sin hora va
// primero: es la de "a la mañana", que en la práctica es antes que las que tienen hora puesta.
function ordenarCitaciones(citaciones, { descendente = false } = {}) {
  const orden = (c) => `${c && c.dia ? c.dia : ''} ${c && c.hora ? c.hora : ''}`;
  const lista = (citaciones || []).filter(Boolean).slice()
    .sort((a, b) => orden(a).localeCompare(orden(b)));
  return descendente ? lista.reverse() : lista;
}

// ¿Esta citación entra en la LÍNEA DE TIEMPO del legajo?
//
// Solo si ya ocurrió (el día pasó o es hoy) o si se resolvió de alguna forma. Una citación
// programada para dentro de tres semanas es AGENDA, no historia: metida en la línea con el
// orden "lo último arriba" se sentaría arriba de todo, empujando abajo lo que de verdad pasó
// y haciendo que el hilo se lea como si el futuro ya hubiera sucedido.
//
// La citación cancelada SÍ entra aunque su día no haya llegado: cancelarla es algo que pasó,
// y es justamente lo que hay que poder leer el año que viene.
function citacionEnLinea(c, hoy) {
  if (!c) return false;
  if (CITACION_RESUELTA.includes(c.estado)) return true;
  return diaValido(c.dia) && diaValido(hoy) && c.dia <= hoy;
}

// ── El calendario ────────────────────────────────────────────────────────────
//
// Tres clases de evento, que son las tres fechas que el gabinete tiene que mirar:
//
//   citacion    → un encuentro que el gabinete convocó.
//   repaso      → "volver a ver a este chico" (SoeCase.proximoRepaso).
//   seguimiento → "volver a preguntarle al hospital" (referrals[].proximoSeguimiento).
const TIPOS_EVENTO = ['citacion', 'repaso', 'seguimiento'];

const EVENTO_LABELS = {
  citacion:    'Citación',
  repaso:      'Volver a verlo',
  seguimiento: 'Preguntar al servicio',
};

const EVENTO_ICONS = {
  citacion:    'event',
  repaso:      'event_repeat',
  seguimiento: 'contact_support',
};

const EVENTO_COLORS = {
  citacion:    '#1a73e8',
  repaso:      '#0d7377',
  seguimiento: '#9334e6',
};

// Un `Date` guardado a su día de calendario en la zona de la escuela. Ver la regla de fechas
// del encabezado: `toISOString().slice(0,10)` daría el día UTC y correría las fechas de la
// tardecita al día siguiente.
const diaDe = (fecha) => (fecha ? diaEscolar(new Date(fecha)) : null);

// Los eventos de UN legajo. Recibe el legajo tal como sale de la base (lean) más los datos
// del alumno ya resueltos, y devuelve los renglones planos que pinta el calendario.
//
// ⚠️ Recibe el legajo COMPLETO y no el sanitizado, y por eso esta función NO se llama nunca
// desde una pantalla de nivel 'resumen': la agenda entera es de nivel completo (ver
// requireCompleto en routes/soe.js). Es la misma regla que /soe/derivaciones, que también
// nombra el destino de una derivación.
function eventosDelLegajo(legajo, hoy) {
  if (!legajo) return [];
  const eventos = [];

  const base = {
    caseId:   legajo._id,
    student:  legajo.student,
    division: legajo.division,
    estadoLegajo: legajo.estado,
  };

  for (const c of (legajo.citaciones || [])) {
    if (!c || !diaValido(c.dia)) continue;
    eventos.push({
      ...base,
      tipo:    'citacion',
      dia:     c.dia,
      hora:    c.hora || '',
      estado:  c.estado,
      titulo:  CITADO_LABELS[c.a] || 'Citación',
      detalle: c.motivo || '',
      lugar:   c.lugar || '',
      citacionId: c._id,
      // Pasó el día y nadie dijo qué pasó: es lo que se resalta.
      atencion: citacionSinRegistrar(c, hoy),
    });
  }

  // El repaso del legajo. Un legajo cerrado no pide nada, aunque le haya quedado la fecha
  // puesta — misma regla que `legajoNecesitaRepaso` de services/soeAcceso.js.
  const diaRepaso = diaDe(legajo.proximoRepaso);
  if (diaRepaso && legajo.estado !== 'cerrado') {
    eventos.push({
      ...base,
      tipo:    'repaso',
      dia:     diaRepaso,
      hora:    '',
      estado:  null,
      titulo:  'Volver a verlo',
      detalle: '',
      lugar:   '',
      atencion: diaValido(hoy) && diaRepaso <= hoy,
    });
  }

  for (const r of (legajo.referrals || [])) {
    const diaSeg = diaDe(r && r.proximoSeguimiento);
    if (!diaSeg) continue;
    eventos.push({
      ...base,
      tipo:    'seguimiento',
      dia:     diaSeg,
      hora:    '',
      estado:  r.estado,
      titulo:  r.destino || 'Servicio externo',
      detalle: '',
      lugar:   '',
      refId:   r._id,
      atencion: diaValido(hoy) && diaSeg <= hoy,
    });
  }

  return eventos;
}

// El orden con el que se leen: por día, y dentro del día lo que tiene hora después de lo que
// no la tiene (una citación "a la mañana" va antes que la de las 14:00), y las citaciones
// antes que los recordatorios, que no tienen horario.
const PESO_TIPO = { citacion: 0, repaso: 1, seguimiento: 2 };
function ordenarEventos(eventos) {
  return (eventos || []).slice().sort((a, b) =>
    String(a.dia).localeCompare(String(b.dia))
    || (PESO_TIPO[a.tipo] ?? 9) - (PESO_TIPO[b.tipo] ?? 9)
    || String(a.hora || '').localeCompare(String(b.hora || '')));
}

// La grilla del mes con los eventos ya repartidos en sus celdas.
//
// `grillaDelMes` viene de services/actividadesDelDia.js: semanas de 7 celdas de domingo a
// sábado, con null en el relleno. Se reutiliza y no se reescribe porque es exactamente el
// mismo calendario de pared que ya usan Preceptoría y Dirección, y dos calendarios que se
// dibujan distinto en la misma plataforma es una molestia gratuita.
function armarCalendario(mes, eventos, hoy) {
  const elMes = mesValido(mes) ? mes : mesActual();
  const porDia = new Map();
  for (const e of ordenarEventos(eventos)) {
    if (!e || !diaValido(e.dia)) continue;
    if (!e.dia.startsWith(elMes)) continue;   // el mes vecino no se pinta
    if (!porDia.has(e.dia)) porDia.set(e.dia, []);
    porDia.get(e.dia).push(e);
  }

  const semanas = grillaDelMes(elMes).map(semana => semana.map(celda => (celda ? {
    ...celda,
    esHoy:   celda.dia === hoy,
    pasado:  diaValido(hoy) && celda.dia < hoy,
    eventos: porDia.get(celda.dia) || [],
  } : null)));

  return {
    mes:       elMes,
    nombre:    nombreDelMes(elMes),
    anterior:  mesAnterior(elMes),
    siguiente: mesSiguiente(elMes),
    semanas,
  };
}

// Aritmética de días de calendario, en UTC puro: no son instantes reales, son casilleros de
// almanaque. Las mismas tres líneas que services/actividadesDelDia.js:53 y
// services/recursos/disponibilidad.js:15 — se repiten por el motivo que documenta aquel
// archivo (ninguno de los dos es un módulo de fechas, y convertirlo en uno arrastraría sus
// dependencias a todo el que necesite sumar un día).
const MS_DIA = 24 * 60 * 60 * 1000;
const aUTC = (dia) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const aDia = (ms)  => new Date(ms).toISOString().slice(0, 10);
const sumarDias = (dia, n) => aDia(aUTC(dia) + n * MS_DIA);

// "Lo que viene": la lista corta que va arriba del calendario y en el resumen del panel.
// Incluye lo VENCIDO (los eventos anteriores a hoy que siguen pidiendo algo), porque una
// agenda que solo mira para adelante es la que deja atrás al chico del que nadie se acordó.
function proximos(eventos, hoy, dias = 14) {
  if (!diaValido(hoy)) return [];
  const hasta = sumarDias(hoy, dias);
  return ordenarEventos(eventos).filter(e =>
    diaValido(e.dia) && e.dia <= hasta && (e.dia >= hoy || e.atencion));
}

// Cuántos piden atención hoy. Es el número de la tarjeta del resumen.
const cuantosPidenAtencion = (eventos) => (eventos || []).filter(e => e && e.atencion).length;

// El día de hoy en la zona de la escuela. La única función de este archivo que mira el reloj:
// todas las demás lo reciben como parámetro para poder testearse paradas en cualquier fecha.
const hoyEscolar = () => diaEscolar();

module.exports = {
  // catálogos
  CITADOS, CITADO_LABELS, CITADO_ICONS,
  ESTADOS_CITACION, ESTADO_CITACION_LABELS, ESTADO_CITACION_COLORS,
  CITACION_ACTIVA, CITACION_RESUELTA, CITACION_OCURRIO,
  TIPOS_EVENTO, EVENTO_LABELS, EVENTO_ICONS, EVENTO_COLORS,
  // horas
  horaValida, normalizarHora,
  // preguntas
  citacionActiva, citacionSinRegistrar, citacionProxima, citacionEsHoy, citacionEnLinea,
  ordenarCitaciones,
  // calendario
  eventosDelLegajo, ordenarEventos, armarCalendario, proximos, cuantosPidenAtencion,
  sumarDias, diaDe, hoyEscolar,
  // reexportadas para que la ruta y la vista no tengan que importar de dos lados
  diaValido, mesValido, mesActual,
};
