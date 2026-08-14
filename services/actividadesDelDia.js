// "Actividades del día" de preceptoría: qué materias de un curso dejaron actividad cada día.
//
// Ver specs/actividades-en-clase.spec.md.
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

// El mes en curso, en la zona de la escuela.
const mesActual = () => live.diaEscolar().slice(0, 7);

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

module.exports = {
  // puras
  mesValido, diaValido, mesActual, mesAnterior, mesSiguiente, nombreDelMes, grillaDelMes,
  // con base
  materiasDeDivision, mesDeDivision, diaDeDivision,
};
