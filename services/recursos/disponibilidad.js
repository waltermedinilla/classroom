// Qué está libre, qué se pide y en qué fechas. TODO PURO — no toca la base, no recibe `req`.
// Las funciones reciben las reservas ya leídas y devuelven la forma que pinta la pantalla.
//
// Es el archivo que concentra los tests del módulo: si la regla de repetición o el cálculo de
// una celda están mal, se ve acá y no hace falta levantar Mongo para descubrirlo.

const { diaValido } = require('../actividadesDelDia');
const { modulosDeClase } = require('./horario');

// Aritmética de días de calendario, en UTC puro. NO son instantes reales: son casilleros de
// almanaque, y el horario de verano no tiene nada que opinar. Es la misma técnica —y las
// mismas tres líneas— que services/actividadesDelDia.js:55; se repiten acá en vez de
// exportarlas de allá porque aquel archivo es sobre actividades, no un módulo de fechas, y
// convertirlo en uno arrastraría sus dependencias a todo el que necesite sumar un día.
const MS_DIA = 24 * 60 * 60 * 1000;
const aUTC = (dia) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const aDia = (ms)  => new Date(ms).toISOString().slice(0, 10);

const sumarDias = (dia, n) => aDia(aUTC(dia) + n * MS_DIA);
const diasEntre = (desde, hasta) => Math.round((aUTC(hasta) - aUTC(desde)) / MS_DIA);

// 1 = lunes … 7 = domingo. getUTCDay() da 0 para domingo, que rompería el orden de la grilla.
const diaSemana = (dia) => (new Date(aUTC(dia)).getUTCDay() + 6) % 7 + 1;

// El lunes de la semana de `dia`. Es el ancla del calendario semanal: la pantalla siempre
// muestra semanas completas para que el docente compare martes con martes.
const lunesDe = (dia) => sumarDias(dia, -(diaSemana(dia) - 1));

// ─────────────────────────────────────────────────────────────────────────────
// Mostrar un día 'YYYY-MM-DD'
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ Estos NO pueden salir de `fmt` de services/liveRoom.js, y la diferencia importa.
// Aquéllos formatean INSTANTES en la zona de la escuela; esto es una fecha de CALENDARIO. Un
// `new Date('2026-08-25')` es la medianoche UTC, y formatearla en America/Argentina la
// muestra como el 24 a las 21:00 — o sea, el día anterior. Es el mismo bug de las tres horas,
// entrando por la puerta de al lado.
//
// La salida es armar el instante en UTC y formatearlo en UTC: las dos mitades se cancelan y
// queda el día que dice el string. Es el criterio que ya usan views/preceptor/actividades.ejs
// y views/directivo/actividades-diarias.ejs, y la excepción que tests/unit/zonaHoraria.test.js
// admite explícitamente (una zona declarada a mano es deliberada, no un olvido).
//
// Van con Intl.DateTimeFormat y no con toLocaleDateString por lo de siempre: el formatter se
// construye una sola vez y esto corre 70 veces por grilla.
const comoFecha   = (dia) => new Date(String(dia) + 'T00:00:00Z');
const F_DIA_CORTO = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const F_DIA_LARGO = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
const F_DIA_NUM   = new Intl.DateTimeFormat('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });

const diaCorto = (dia) => (diaValido(dia) ? F_DIA_CORTO.format(comoFecha(dia)) : '');
const diaLargo = (dia) => (diaValido(dia) ? F_DIA_LARGO.format(comoFecha(dia)) : '');
const diaNum   = (dia) => (diaValido(dia) ? F_DIA_NUM.format(comoFecha(dia))   : '');

// ─────────────────────────────────────────────────────────────────────────────
// Las repeticiones
// ─────────────────────────────────────────────────────────────────────────────

// "Cada 15 días" es un pedido explícito del usuario, no una variante genérica: hay materias
// que usan la sala una semana sí y una no.
const REPETICIONES = [
  { id: 'unica',      label: 'Solo esta fecha',  pasoDias: 0  },
  { id: 'semanal',    label: 'Todas las semanas', pasoDias: 7  },
  { id: 'quincenal',  label: 'Cada 15 días',      pasoDias: 14 },
];
const REPETICION_BY_ID = Object.fromEntries(REPETICIONES.map(r => [r.id, r]));

// Nadie reserva el laboratorio hasta 2030 con un clic. Los dos topes son independientes: el
// horizonte protege el calendario y el de fechas protege la operación de escritura.
const HORIZONTE_MAX_DIAS = 365;
const MAX_FECHAS_SERIE   = 45;   // ~un cuatrimestre de clases semanales

// Expande una repetición en las fechas concretas que se van a crear.
//
// ⚠️ La repetición se MATERIALIZA (ver models/Reserva.js): esto devuelve una lista de días y
// después se crea una Reserva por cada uno. No se guarda la regla. Es lo que permite que el
// índice único siga vigilando y que cancelar un solo martes no exija inventar excepciones.
//
// Devuelve { fechas: [String], error: String|null }. Nunca lanza por datos del usuario.
function expandirSerie({ desde, repeticion = 'unica', hasta = null, dias = [1, 2, 3, 4, 5] }) {
  if (!diaValido(desde)) return { fechas: [], error: 'La fecha no es válida.' };

  const regla = REPETICION_BY_ID[repeticion];
  if (!regla) return { fechas: [], error: 'Esa repetición no existe.' };

  const dow = diaSemana(desde);
  if (!dias.map(Number).includes(dow)) {
    return { fechas: [], error: 'Ese día la escuela no tiene actividad.' };
  }

  if (regla.pasoDias === 0) return { fechas: [desde], error: null };

  if (!diaValido(hasta)) return { fechas: [], error: 'Elegí hasta qué fecha se repite.' };
  if (hasta < desde)     return { fechas: [], error: 'La fecha final es anterior a la inicial.' };
  if (diasEntre(desde, hasta) > HORIZONTE_MAX_DIAS) {
    return { fechas: [], error: 'No se puede reservar con más de un año de anticipación.' };
  }

  const fechas = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, regla.pasoDias)) {
    fechas.push(f);
    if (fechas.length > MAX_FECHAS_SERIE) {
      return { fechas: [], error: `Son más de ${MAX_FECHAS_SERIE} fechas. Acortá el período.` };
    }
  }
  // Como el paso es múltiplo de 7, todas las fechas caen el mismo día de la semana que la
  // primera: no hace falta volver a filtrar por `dias`.
  return { fechas, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// El estado de una celda del calendario
// ─────────────────────────────────────────────────────────────────────────────

// Qué mostrar en un casillero (recurso × día × turno × módulo), dadas las reservas que caen
// ahí. `reservas` son las de ESE casillero, ya filtradas por quien llama.
//
// La celda dice cosas distintas según el recurso, y no es cosmético:
//   exclusivo  → libre / ocupada. Una sola reserva manda.
//   divisible  → "18 de 30 libres". Una celda que dijera solo "ocupada" con 12 tomadas sería
//                falsa, y el docente que necesita 10 se iría creyendo que no hay.
function estadoCelda({ recurso, reservas = [], userId = null }) {
  const confirmadas = reservas.filter(r => r.status === 'confirmada');
  const pendientes  = reservas.filter(r => r.status === 'pendiente');

  const tomadas = confirmadas.reduce((n, r) => n + (r.unidades || 1), 0);
  const capacidad = recurso.divisible ? (recurso.capacidad || 1) : 1;
  const libres = Math.max(0, capacidad - tomadas);

  const mias = confirmadas.filter(r => userId && String(r.docente?._id || r.docente) === String(userId));
  const miPendiente = pendientes.some(r => userId && String(r.docente?._id || r.docente) === String(userId));

  return {
    divisible:   !!recurso.divisible,
    capacidad,
    tomadas,
    libres,
    // El único criterio de "no se puede pedir más acá". Sirve igual para los dos tipos: en un
    // recurso exclusivo la capacidad es 1, así que una reserva confirmada lo agota.
    completo:    libres <= 0,
    confirmadas,
    pendientes,
    esMia:       mias.length > 0,
    tengoPendiente: miPendiente,
  };
}

// Cuánto puede pedir un docente en este casillero. Es el tope que muestra el formulario, y el
// mismo número que revalida la ruta — el `max` de un <input> se edita con el inspector.
//
// `maxPorPedido` topea el PEDIDO, no el otorgamiento: el administrativo puede pasarlo al
// aprobar, porque es su decisión y queda auditada.
function maximoPedible(recurso, celda) {
  if (!recurso.divisible) return 1;
  const tope = recurso.maxPorPedido || recurso.capacidad || 1;
  return Math.max(0, Math.min(tope, celda.libres));
}

// ¿Esta fecha ya pasó? Reservar ayer no es un error de permisos, es un error de sentido, y
// tiene que decirlo así. `hoy` se recibe SIEMPRE de afuera (diaEscolar() de liveRoom.js, que
// es el único dueño de la hora) para que esta función siga siendo pura y testeable.
const esPasado = (dia, hoy) => diaValido(dia) && diaValido(hoy) && dia < hoy;

// Los días que se pintan en una semana, con su nombre. Solo los que la escuela tiene
// actividad: una escuela sin sábado no muestra una columna vacía de sábado.
function diasDeSemana(lunes, dias = [1, 2, 3, 4, 5]) {
  return dias.map(Number).filter(d => d >= 1 && d <= 6).sort((a, b) => a - b)
    .map(d => ({ dow: d, date: sumarDias(lunes, d - 1) }));
}

// Las filas de la grilla semanal: todas las franjas del turno, recreos incluidos. El recreo se
// pinta en gris y sin botón — está para que se entienda por qué 2ª termina 9:20 y 3ª arranca
// 9:30, no para reservarse.
const filasDeTurno = (turno) =>
  (turno?.franjas || []).slice().sort((a, b) => String(a.desde).localeCompare(String(b.desde)));

module.exports = {
  sumarDias, diasEntre, diaSemana, lunesDe,
  diaCorto, diaLargo, diaNum,
  REPETICIONES, REPETICION_BY_ID, HORIZONTE_MAX_DIAS, MAX_FECHAS_SERIE,
  expandirSerie,
  estadoCelda, maximoPedible, esPasado,
  diasDeSemana, filasDeTurno,
  modulosDeClase,
};
