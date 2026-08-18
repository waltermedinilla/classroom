// Qué materias dejaron actividad y cuándo. Dos pantallas se apoyan acá:
//
//   - "Actividades del día" (preceptor): un mes, una división, día por día.
//     Ver specs/actividades-en-clase.spec.md.
//   - "Actividades Diarias" (directivo): un rango de fechas, toda la escuela, entregado/pendiente.
//     Ver specs/directivo-actividades-diarias.spec.md.
//
// La regla de qué cuenta como actividad es UNA SOLA y vive acá. Si una de las dos pantallas
// necesita una variante, va como parámetro (como `campo`, más abajo), nunca como copia en otro
// archivo: dos copias es cómo las dos pantallas empiezan a contestar distinto sobre el mismo hecho.
//
// Qué cuenta como "la materia subió actividad ese día" (RN-05): que exista al menos un Activity
// de esa materia con `createdAt` en ese día escolar. NO se mira availableFrom ni dueDate — la
// pregunta del preceptor es "¿el docente dejó trabajo?", que es un hecho del día en que lo cargó,
// no de la fecha para la que lo programó.
//
// Y no importa por qué camino se creó: desde el botón de la sala en vivo o desde el + de la
// materia, cuentan igual (decisión del usuario, 2026-08-12).
//
// LA ZONA HORARIA NO SE DECIDE ACÁ. Todo lo que tenga que ver con "qué día es" sale de
// services/liveRoom.js (TZ, diaEscolar, hora), que es el único dueño de la zona de la escuela.
// Un segundo Intl.DateTimeFormat en este archivo es exactamente cómo vuelve el bug de las tres
// horas de más: producción corre en UTC, y una actividad cargada 21:30 de Buenos Aires caería en
// la celda del día siguiente.

const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Course   = require('../models/Course');
const live     = require('./liveRoom');

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIA_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const mesValido = (m) => typeof m === 'string' && MES_RE.test(m);
const diaValido = (d) => typeof d === 'string' && DIA_RE.test(d);

// Qué fecha de la actividad se mira. La del directivo lo elige por pantalla: "creación" contesta
// "¿el docente cargó trabajo?" y "entrega" contesta "¿qué le vence al alumno?". El calendario del
// preceptor no usa esto: siempre es createdAt (RN-05 de su spec).
//
// OJO: estos valores se interpolan como NOMBRE DE CAMPO en el $match y en el $dateToString, y la
// llave llega de la query string. Todo lo que entre tiene que pasar por campoValido primero.
const CAMPOS = { creacion: 'createdAt', entrega: 'dueDate' };
const campoValido = (c) => typeof c === 'string' && Object.hasOwn(CAMPOS, c);

// Tope del rango pedible. No es una regla de negocio, es un fusible: el aggregate se banca un año
// sin despeinarse, pero "desde 2015 hasta hoy" escrito a mano en la URL no tiene por qué colgar
// la pantalla de nadie.
const RANGO_MAX_DIAS = 366;

const MS_DIA = 24 * 60 * 60 * 1000;
const aUTC   = (dia) => { const [y, m, d] = dia.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const aDia   = (ms)  => new Date(ms).toISOString().slice(0, 10);

// Días de diferencia entre dos fechas de calendario. En UTC puro: no son instantes reales, son
// casilleros de almanaque, y el horario de verano no tiene nada que opinar acá.
const diasEntre = (desde, hasta) => Math.round((aUTC(hasta) - aUTC(desde)) / MS_DIA);

// Un rango sirve si las dos puntas son fechas de verdad, no está dado vuelta y no es absurdo.
// La comparación de strings YYYY-MM-DD alcanza: es orden lexicográfico = orden cronológico.
function rangoValido(desde, hasta) {
  if (!diaValido(desde) || !diaValido(hasta)) return false;
  if (desde > hasta) return false;
  return diasEntre(desde, hasta) <= RANGO_MAX_DIAS;
}

// El mes en curso, en la zona de la escuela.
const mesActual = () => live.diaEscolar().slice(0, 7);

// El día de hoy, de punta a punta. Es el rango con el que abre la solapa del directivo.
function rangoDeHoy() {
  const hoy = live.diaEscolar();
  return { desde: hoy, hasta: hoy };
}

// La semana ESCOLAR: lunes a viernes de la semana en curso. No es la semana calendario —
// el fin de semana no tiene actividad que mirar y ensucia el rango.
//
// El caso que rompe una resta hecha a ojo es el DOMINGO: getUTCDay() lo devuelve 0, y restarle
// 0 - 1 lo mandaría al lunes de la semana SIGUIENTE. Un directivo que abre la solapa un domingo
// tiene que ver la semana que pasó, no una vacía.
function rangoDeSemana(hoy = live.diaEscolar()) {
  const ms  = aUTC(hoy);
  const dow = new Date(ms).getUTCDay();          // 0 = domingo … 6 = sábado
  const alLunes = (dow === 0 ? 6 : dow - 1);     // cuántos días atrás quedó el lunes
  const lunes = ms - alLunes * MS_DIA;
  return { desde: aDia(lunes), hasta: aDia(lunes + 4 * MS_DIA) };
}

// Aritmética de calendario pura: sin zonas horarias de por medio. Qué día de la semana cae el
// 1° de agosto de 2026 no depende de dónde esté parado el servidor.
const partes = (mes) => mes.split('-').map(Number);

function mesVecino(mes, delta) {
  const [y, m] = partes(mes);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const mesAnterior  = (mes) => mesVecino(mes, -1);
const mesSiguiente = (mes) => mesVecino(mes, 1);

// "agosto de 2026". Va con timeZone UTC a propósito: la fecha que se le pasa es una fecha de
// calendario armada en UTC, no un instante real, y formatearla en otra zona la correría un día.
const F_MES = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function nombreDelMes(mes) {
  const [y, m] = partes(mes);
  return F_MES.format(new Date(Date.UTC(y, m - 1, 1)));
}

// La grilla del mes tal como se pinta: semanas de 7 celdas, de DOMINGO a SÁBADO (el formato del
// calendario de pared que pidió el usuario). Las celdas de relleno van en null.
function grillaDelMes(mes) {
  const [y, m]    = partes(mes);
  const offset    = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0 = domingo
  const diasDelMes = new Date(Date.UTC(y, m, 0)).getUTCDate();   // día 0 del mes siguiente

  const celdas = new Array(offset).fill(null);
  for (let d = 1; d <= diasDelMes; d++) {
    celdas.push({ numero: d, dia: `${mes}-${String(d).padStart(2, '0')}` });
  }
  while (celdas.length % 7) celdas.push(null);

  const semanas = [];
  for (let i = 0; i < celdas.length; i += 7) semanas.push(celdas.slice(i, i + 7));
  return semanas;
}

// Ventana UTC HOLGADA (±1 día) para el $match. El recorte fino lo hace el bucketing con timezone
// ($dateToString) o el filtro exacto con diaEscolar, según el caso. Es lo que evita tener que
// calcular a mano el desfasaje de la zona —y su cambio por horario de verano— para armar el rango:
// el rango solo tiene que ser lo bastante ancho como para no dejar nada afuera.
function ventana(desdeY, desdeM, desdeD, hastaY, hastaM, hastaD) {
  const desde = new Date(Date.UTC(desdeY, desdeM, desdeD));
  const hasta = new Date(Date.UTC(hastaY, hastaM, hastaD));
  return { $gte: desde, $lt: hasta };
}

const ventanaDelMes = (mes) => {
  const [y, m] = partes(mes);
  return ventana(y, m - 1, 0, y, m, 2);   // del día 0 (= último de anterior) al 1 del siguiente +1
};

const ventanaDelDia = (dia) => {
  const [y, m, d] = dia.split('-').map(Number);
  return ventana(y, m - 1, d - 1, y, m - 1, d + 2);
};

// Ídem para un rango arbitrario: un día de más en cada punta. Lo que sobra lo descarta después el
// $match sobre el día ya bucketeado con timezone.
const ventanaDeRango = (desde, hasta) => ({
  $gte: new Date(aUTC(desde) - MS_DIA),
  $lt:  new Date(aUTC(hasta) + 2 * MS_DIA),
});

// Las materias del curso, ordenadas por nombre, con su docente titular.
// Es el DENOMINADOR de toda la pantalla: "5 de 9 materias" sale de acá.
async function materiasDeDivision(divisionId) {
  return Course.find({ division: oid(divisionId) })
    .select('name owner')
    .populate('owner', 'name')
    .sort({ name: 1 })
    .lean();
}

// Resumen del mes: por cada día, cuántas materias distintas subieron y cuántas actividades hubo.
// Devuelve `porDia` como objeto indexado por 'YYYY-MM-DD' — la vista lo consulta celda por celda.
async function mesDeDivision(divisionId, mes) {
  const materias = await materiasDeDivision(divisionId);
  const ids      = materias.map(m => m._id);
  const salida   = { mes, totalMaterias: materias.length, porDia: {} };
  if (!ids.length) return salida;

  const filas = await Activity.aggregate([
    { $match: { course: { $in: ids }, createdAt: ventanaDelMes(mes) } },
    // Primer $group: una entrada por (día, materia) — así el segundo cuenta MATERIAS DISTINTAS y
    // no actividades. Una materia que subió tres tareas el martes sigue siendo una materia.
    { $group: {
        _id: {
          dia:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: live.TZ } },
          curso: '$course',
        },
        n: { $sum: 1 },
    } },
    { $group: { _id: '$_id.dia', materias: { $sum: 1 }, actividades: { $sum: '$n' } } },
  ]);

  // La ventana del $match es holgada a propósito: acá se descartan los días que se colaron de los
  // meses vecinos.
  filas
    .filter(f => typeof f._id === 'string' && f._id.startsWith(mes + '-'))
    .forEach(f => { salida.porDia[f._id] = { materias: f.materias, actividades: f.actividades }; });

  return salida;
}

// Detalle de UN día: las materias partidas en las que subieron y las que no.
// La suma de las dos listas siempre da el total de materias del curso (CA-14).
async function diaDeDivision(divisionId, dia) {
  const materias = await materiasDeDivision(divisionId);
  const ids      = materias.map(m => m._id);
  const salida   = { dia, totalMaterias: materias.length, subieron: [], noSubieron: [] };
  if (!ids.length) return salida;

  const actividades = await Activity.find({ course: { $in: ids }, createdAt: ventanaDelDia(dia) })
    .select('title type course author createdAt')
    .populate('author', 'name')
    .sort({ createdAt: 1 })
    .lean();

  // El corte exacto lo hace diaEscolar, no el rango: el rango solo acota cuánto se trae.
  const porCurso = new Map();
  actividades
    .filter(a => live.diaEscolar(a.createdAt) === dia)
    .forEach(a => {
      const key = String(a.course);
      if (!porCurso.has(key)) porCurso.set(key, []);
      porCurso.get(key).push({
        titulo: a.title,
        tipo:   a.type,
        hora:   live.hora(a.createdAt),
        autor:  a.author?.name || '',
      });
    });

  materias.forEach(m => {
    const fila  = { materia: m.name, docente: m.owner?.name || '' };
    const lista = porCurso.get(String(m._id));
    if (lista) salida.subieron.push({ ...fila, actividades: lista });
    else       salida.noSubieron.push(fila);
  });

  return salida;
}

// ── Solapa "Actividades Diarias" del directivo ───────────────────────────────
// Ver specs/directivo-actividades-diarias.spec.md.
//
// La diferencia con lo de arriba no es solo el rango: acá el universo es TODA LA ESCUELA, no una
// división. El $in pasa de ~10 materias a potencialmente cientos. Se apoya en el prefijo `course`
// de los índices que ya existen ({course,availableFrom} y {course,dueDate}); no se agrega ninguno
// porque construir un índice es un cambio en la base de producción.

// Las materias del alcance, con su curso y su docente titular. Es el DENOMINADOR: una materia sin
// una sola actividad TIENE que aparecer igual, porque es exactamente la que dirección busca.
async function materiasDeEscuela(school, divisionId) {
  const filtro = { school: oid(school) };
  if (divisionId) filtro.division = oid(divisionId);

  return Course.find(filtro)
    .select('name division owner')
    .populate('division', 'name')
    .populate('owner', 'name active')
    .lean();
}

// Una fila por materia, con cuántas actividades tuvo en el rango y cuándo fue la última.
// `campo` elige contra qué fecha se mide: 'creacion' (createdAt) o 'entrega' (dueDate).
//
// Con campo='entrega', las actividades sin fecha límite (dueDate: null, que es el default del
// schema) no matchean ninguna ventana y no cuentan. Es la respuesta correcta a "¿qué vence esta
// semana?", pero hace que un mismo docente pueda figurar Entregado en creación y Pendiente en
// entrega — por eso la vista lo avisa (RN-03).
async function rangoDeEscuela({ school, desde, hasta, campo = 'creacion', divisionId = null }) {
  const campoDb  = CAMPOS[campoValido(campo) ? campo : 'creacion'];
  const materias = await materiasDeEscuela(school, divisionId);
  if (!materias.length) return [];

  const filas = await Activity.aggregate([
    { $match: { course: { $in: materias.map(m => m._id) }, [campoDb]: ventanaDeRango(desde, hasta) } },
    // Mismo truco de dos $group que mesDeDivision: el primero lleva cada actividad a su día en la
    // zona de la escuela, y recién ahí se puede recortar el rango exacto. Sin este paso habría que
    // calcular a mano el desfasaje de la zona —y su cambio por horario de verano— para armar el
    // $match, que es justo lo que no queremos hacer.
    { $group: {
        _id: {
          curso: '$course',
          dia:   { $dateToString: { format: '%Y-%m-%d', date: `$${campoDb}`, timezone: live.TZ } },
        },
        n: { $sum: 1 },
    } },
    { $match: { '_id.dia': { $gte: desde, $lte: hasta } } },   // el recorte fino, extremos incluidos
    { $group: { _id: '$_id.curso', actividades: { $sum: '$n' }, ultima: { $max: '$_id.dia' } } },
  ]);

  const porCurso = new Map(filas.map(f => [String(f._id), f]));

  return materias.map(m => {
    const f = porCurso.get(String(m._id));
    return {
      courseId:      String(m._id),
      materia:       m.name,
      divisionId:    m.division ? String(m.division._id) : '',
      division:      m.division?.name || '',
      docente:       m.owner?.name || '',
      docenteActivo: m.owner ? m.owner.active !== false : true,
      actividades:   f ? f.actividades : 0,
      ultima:        f ? f.ultima : null,
    };
  }).sort((a, b) => a.division.localeCompare(b.division, 'es') || a.materia.localeCompare(b.materia, 'es'));
}

module.exports = {
  // puras
  mesValido, diaValido, mesActual, mesAnterior, mesSiguiente, nombreDelMes, grillaDelMes,
  CAMPOS, campoValido, rangoValido, rangoDeHoy, rangoDeSemana, RANGO_MAX_DIAS,
  // con base
  materiasDeDivision, mesDeDivision, diaDeDivision,
  materiasDeEscuela, rangoDeEscuela,
};
