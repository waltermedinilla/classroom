// "Cómo viene": la foto objetiva del alumno, armada con datos que la plataforma YA tiene.
//
// El SOE cruza tres cosas para entender a un chico: qué pasa en su casa (eso lo carga a
// mano en el legajo), qué ve el docente (idem), y cómo viene en la escuela — que es
// justamente lo que la plataforma sabe y hasta ahora nadie le mostraba junto: asistencia,
// notas, entregas y desde cuándo no se conecta.
//
// TODO acá es de SOLO LECTURA. No inventa un "índice de riesgo" ni pinta un semáforo con
// una fórmula: muestra los números y deja el juicio donde corresponde, que es en la persona
// del gabinete. Un número que dice "alumno en riesgo: 7,3" invita a dejar de mirar al chico.
//
// Ver specs/soe-orientacion.spec.md, solapa "Cómo viene".

const mongoose  = require('mongoose');
const Course    = require('../models/Course');
const Activity  = require('../models/Activity');
const Submission = require('../models/Submission');
const AttendanceMark = require('../models/AttendanceMark');

const { diaEscolar, resumen, porcentajeAsistencia } = require('./attendance');
const { esVisibleParaAlumno } = require('../public/js/visibilidadActividad');

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// La ventana corta. 30 días es lo que separa "faltó una semana por una angina" de "hace un
// mes que no viene", que son dos conversaciones distintas.
const DIAS_VENTANA = 30;

// Corre `n` días hacia atrás sobre una clave de día escolar ("YYYY-MM-DD"). Se hace sobre
// la clave y no sobre un Date para no reintroducir el bug de zona horaria: producción corre
// en UTC y diaEscolar() ya resuelve el día en la zona de la escuela.
function diaMenos(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
}

// ── Asistencia ───────────────────────────────────────────────────────────────
// Una sola query, cubierta por el índice { student: 1, date: -1 } que ya existe en
// AttendanceMark. Se traen todas las marcas del alumno y se parten en JS: son ~200 por año
// escolar, no vale la pena una segunda ida a la base para el corte de 30 días.
async function asistenciaDelAlumno(studentId, hoy) {
  const marcas = await AttendanceMark.find({ student: studentId })
    .select('status date')
    .sort({ date: -1 })
    .lean();

  const desde = diaMenos(hoy, DIAS_VENTANA);
  const recientes = marcas.filter(m => m.date >= desde);

  const armar = (lista) => {
    const r = resumen(lista);
    // `sinMarcar` son planillas todavía abiertas: no son ni presente ni ausente, y contarlas
    // como ausencia le pondría al chico faltas que nadie puso.
    return { ...r, porcentaje: porcentajeAsistencia(r) };
  };

  return {
    ventana: DIAS_VENTANA,
    ultimos30: armar(recientes),
    ciclo:     armar(marcas),
    ultimaFalta: (marcas.find(m => m.status === 'ausente') || {}).date || null,
  };
}

// ── Notas y entregas ─────────────────────────────────────────────────────────
//
// El promedio usa la MISMA fórmula que el panel directivo (routes/directivo.js:467):
// normalizado a 0-10 sobre el puntaje máximo de cada actividad, y descartando las
// devoluciones escritas sin nota (`grades.points: null`), que no son notas y romperían
// el promedio hacia abajo.
async function rendimientoDelAlumno(studentId, courseIds) {
  if (!courseIds.length) return { materias: [], promedioGeneral: null };

  const filas = await Activity.aggregate([
    { $match: { course: { $in: courseIds.map(oid) }, points: { $ne: null, $gt: 0 } } },
    { $unwind: '$grades' },
    { $match: { 'grades.student': oid(studentId), 'grades.points': { $ne: null } } },
    { $project: {
        course: 1,
        normalized: { $multiply: [{ $divide: ['$grades.points', '$points'] }, 10] },
    } },
    { $group: { _id: '$course', suma: { $sum: '$normalized' }, notas: { $sum: 1 } } },
  ]);

  const porCurso = new Map(filas.map(f => [f._id.toString(), {
    promedio: Math.round((f.suma / f.notas) * 10) / 10,
    notas:    f.notas,
  }]));

  const totalNotas = filas.reduce((a, f) => a + f.notas, 0);
  const totalSuma  = filas.reduce((a, f) => a + f.suma, 0);

  return {
    porCurso,
    promedioGeneral: totalNotas ? Math.round((totalSuma / totalNotas) * 10) / 10 : null,
  };
}

// Entregas: cuántas hizo, cuántas llegaron tarde y cuántas le quedan pendientes.
//
// "Pendiente" se calcula con la MISMA regla de visibilidad que ve el alumno
// (public/js/visibilidadActividad.js): una actividad programada para el mes que viene no es
// una deuda suya. Si esto usara otro criterio, el legajo le contaría al chico pendientes que
// su propia pantalla no le muestra.
async function entregasDelAlumno(studentId, courseIds, ahora) {
  if (!courseIds.length) {
    return { entregadas: 0, tardias: 0, pendientes: 0, pendientesVencidas: 0, porCurso: new Map() };
  }

  const actividades = await Activity.find({ course: { $in: courseIds } })
    .select('_id course dueDate availableFrom visibleOverride')
    .lean();

  const visibles = actividades.filter(a => esVisibleParaAlumno(a, ahora));
  const subs = await Submission.find({
    student: studentId,
    activity: { $in: visibles.map(a => a._id) },
  }).select('activity firstSubmittedAt createdAt').lean();

  const entregaPorActividad = new Map(subs.map(s => [s.activity.toString(), s]));

  const porCurso = new Map();
  const acumular = (courseId, campo) => {
    const k = courseId.toString();
    if (!porCurso.has(k)) porCurso.set(k, { entregadas: 0, tardias: 0, pendientes: 0 });
    porCurso.get(k)[campo] += 1;
  };

  let entregadas = 0, tardias = 0, pendientes = 0, pendientesVencidas = 0;

  for (const act of visibles) {
    const sub = entregaPorActividad.get(act._id.toString());
    if (sub) {
      entregadas += 1;
      acumular(act.course, 'entregadas');
      // firstSubmittedAt es la PRIMERA entrega: un reenvío posterior no convierte en tardía
      // una entrega que llegó a tiempo (ni al revés).
      const cuando = sub.firstSubmittedAt || sub.createdAt;
      if (act.dueDate && cuando && new Date(cuando) > new Date(act.dueDate)) {
        tardias += 1;
        acumular(act.course, 'tardias');
      }
    } else {
      pendientes += 1;
      acumular(act.course, 'pendientes');
      if (act.dueDate && new Date(act.dueDate) < ahora) pendientesVencidas += 1;
    }
  }

  return { entregadas, tardias, pendientes, pendientesVencidas, porCurso };
}

// ── El armado completo ───────────────────────────────────────────────────────
async function indicadoresDeAlumno(studentId, ahora = new Date()) {
  const cursos = await Course.find({ students: studentId })
    .select('_id name division')
    .sort({ name: 1 })
    .lean();
  const courseIds = cursos.map(c => c._id);

  const [asistencia, rendimiento, entregas] = await Promise.all([
    asistenciaDelAlumno(studentId, diaEscolar(ahora)),
    rendimientoDelAlumno(studentId, courseIds),
    entregasDelAlumno(studentId, courseIds, ahora),
  ]);

  // Una fila por materia con todo junto: es como lo lee una persona ("en Matemática viene
  // con 4 y debe tres trabajos"), no como lo devuelve la base.
  const materias = cursos.map(c => {
    const k = c._id.toString();
    const notas   = rendimiento.porCurso ? rendimiento.porCurso.get(k) : null;
    const entrega = entregas.porCurso.get(k) || { entregadas: 0, tardias: 0, pendientes: 0 };
    return {
      _id: c._id,
      nombre: c.name,
      promedio: notas ? notas.promedio : null,
      notas:    notas ? notas.notas : 0,
      ...entrega,
    };
  });

  return {
    asistencia,
    materias,
    promedioGeneral: rendimiento.promedioGeneral,
    entregas: {
      entregadas: entregas.entregadas,
      tardias: entregas.tardias,
      pendientes: entregas.pendientes,
      pendientesVencidas: entregas.pendientesVencidas,
    },
    cantidadMaterias: cursos.length,
  };
}

module.exports = { indicadoresDeAlumno, DIAS_VENTANA, diaMenos };
