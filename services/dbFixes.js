// Catálogo de "arreglos directos a la base" del panel /superadmin/otros.
//
// Cada arreglo es un problema de integridad de datos que se puede diagnosticar (contar y
// mostrar a quién afecta) y, cuando existe una regla inequívoca para resolverlo, aplicar
// con un botón.
//
// Contrato de cada entrada:
//   id            slug único; viaja en la URL
//   titulo        qué problema resuelve, en una línea
//   descripcion   por qué es un problema y qué hace el arreglo
//   icono         material symbol de la tarjeta
//   severidad     'alta' | 'media' | 'baja' — solo tiñe la tarjeta
//   aplicable     true  → tiene aplicar() y muestra el botón
//                 false → SOLO diagnóstico: no existe una regla automática correcta.
//                         La tarjeta lo dice explícitamente en vez de ofrecer un botón
//                         que invente datos. Ver el comentario de 'usuarios-sin-dni'.
//   parametros    [] o lista de campos que el arreglo necesita para poder correr; la vista
//                 los pinta como <select> y los manda en el body del POST
//   diagnosticar() → { total, muestra: [{...}], nota? }
//                 `muestra` son hasta MUESTRA_MAX filas para la vista previa; nunca la
//                 lista completa, que puede ser de miles.
//   aplicar(params) → { afectados, mensaje }
//
// REGLA DE ORO de este archivo: un arreglo solo es `aplicable` si existe UNA respuesta
// correcta derivable de los datos. Si hace falta criterio humano (a qué curso va este
// alumno, cuál es el DNI de esta persona), el arreglo se queda en diagnóstico y deriva al
// panel que corresponda. Inventar el dato es peor que no arreglarlo.

const mongoose = require('mongoose');
const User     = require('../models/User');
const Course   = require('../models/Course');
const School   = require('../models/School');
const Division = require('../models/Division');

// Cuántas filas se mandan a la vista previa. El resto queda en el conteo.
const MUESTRA_MAX = 50;

// Los usuarios "huérfanos" son el núcleo de casi todos los arreglos de acá: cuentas creadas
// por el auto-registro público (POST /register), que hasta el 2026-07-30 no pedía ni escuela
// ni DNI. Sin escuela no aparecen en ningún panel, no se pueden matricular y no ven nada.
// El superadmin queda excluido a propósito: su school:null es legítimo.
const filtroSinEscuela = { school: null, role: { $ne: 'superadmin' } };

async function escuelasDisponibles() {
  const escuelas = await School.find().sort({ name: 1 }).select('_id name').lean();
  return escuelas.map(e => ({ value: e._id.toString(), label: e.name }));
}

// Alumnos que figuran en ALGUNAS materias de una división pero no en todas.
//
// Se calcula una sola vez y lo comparten diagnosticar() y aplicar(): recorrer las 419
// materias dos veces por request sería tirar trabajo a la basura.
//
// Criterio: dentro de una división, si un alumno está inscripto en al menos una materia
// pero no en todas, le faltan las demás. La matrícula es por curso completo — el alumno
// cursa todas las materias de su año, no una selección.
//
// Devuelve { faltantes: Map<courseId, Set<studentId>>, porAlumno: Map<studentId, [...]> }.
async function calcularMatriculaParcial() {
  const cursos = await Course.find()
    .select('_id name division students')
    .lean();

  // Solo alumnos: si un docente quedó cargado dentro de students[] por un error viejo, no
  // es a él a quien hay que completarle la matrícula.
  const idsEnCursos = [...new Set(cursos.flatMap(c => (c.students || []).map(String)))];
  const alumnos = await User.find({ _id: { $in: idsEnCursos }, role: 'student' })
    .select('_id name email').lean();
  const esAlumno = new Map(alumnos.map(a => [a._id.toString(), a]));

  const porDivision = new Map();
  for (const c of cursos) {
    const k = c.division?.toString();
    if (!k) continue; // materia sin división: no hay "curso completo" que completar
    if (!porDivision.has(k)) porDivision.set(k, []);
    porDivision.get(k).push(c);
  }

  // Alumnos que figuran en materias de MÁS DE UNA división. Casi siempre es un error de
  // carga (aparecen en "1° 1° + 4° 4°", cursos de años distintos), y son justamente los
  // que NO se pueden completar automáticamente: no hay forma de saber cuál es su curso
  // real, y completarlos en todos los que figuran los metería en 20 o 30 materias,
  // empeorando el problema en vez de arreglarlo. Se los excluye acá y se los reporta en
  // el arreglo 'alumnos-en-varios-cursos' para que se resuelvan a mano.
  const divisionesPorAlumno = new Map();
  for (const c of cursos) {
    const d = c.division?.toString();
    if (!d) continue;
    for (const s of (c.students || [])) {
      const k = s.toString();
      if (!esAlumno.has(k)) continue;
      if (!divisionesPorAlumno.has(k)) divisionesPorAlumno.set(k, new Set());
      divisionesPorAlumno.get(k).add(d);
    }
  }
  const enVariasDivisiones = new Set(
    [...divisionesPorAlumno.entries()].filter(([, ds]) => ds.size > 1).map(([id]) => id)
  );

  const faltantes = new Map(); // courseId → Set(studentId)
  const porAlumno = new Map(); // studentId → [{ divisionId, tiene, total }]

  for (const [divisionId, materias] of porDivision) {
    const total = materias.length;
    if (total < 2) continue; // con una sola materia no existe la matrícula "parcial"

    const cuantas = new Map(); // studentId → en cuántas materias de esta división está
    for (const mat of materias) {
      for (const s of (mat.students || [])) {
        const k = s.toString();
        if (!esAlumno.has(k)) continue;
        if (enVariasDivisiones.has(k)) continue; // ambiguo: se resuelve a mano
        cuantas.set(k, (cuantas.get(k) || 0) + 1);
      }
    }

    for (const [studentId, tiene] of cuantas) {
      if (tiene >= total) continue; // matrícula completa: no se toca
      if (!porAlumno.has(studentId)) porAlumno.set(studentId, []);
      porAlumno.get(studentId).push({ divisionId, tiene, total });

      // Las materias de la división donde este alumno NO figura son las que hay que sumar.
      // Las que ya tiene se saltean acá mismo: es lo que garantiza que no se dupliquen ni
      // se toquen las materias donde ya viene cursando y puede tener entregas y notas.
      for (const mat of materias) {
        const yaEsta = (mat.students || []).some(s => s.toString() === studentId);
        if (yaEsta) continue;
        const key = mat._id.toString();
        if (!faltantes.has(key)) faltantes.set(key, new Set());
        faltantes.get(key).add(studentId);
      }
    }
  }

  return { faltantes, porAlumno, esAlumno, enVariasDivisiones, divisionesPorAlumno };
}

const FIXES = [
  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'matricula-parcial',
    titulo: 'Alumnos matriculados en solo algunas materias de su curso',
    descripcion:
      'Quedaron así por las altas viejas: figuran en una o dos materias del curso en vez de en ' +
      'todas, así que no ven la mayoría de sus tareas. El arreglo los inscribe en las materias ' +
      'que les faltan del mismo curso. Las materias donde YA están no se tocan: no se duplican ' +
      'ni se pierden sus entregas ni sus notas.',
    icono: 'playlist_add_check',
    severidad: 'alta',
    aplicable: true,
    parametros: [],

    async diagnosticar() {
      const { faltantes, porAlumno, esAlumno, enVariasDivisiones } = await calcularMatriculaParcial();

      const inscripciones = [...faltantes.values()].reduce((acc, set) => acc + set.size, 0);
      const divisiones = await Division.find().select('_id name').lean();
      const nombreDivision = Object.fromEntries(divisiones.map(d => [d._id.toString(), d.name]));

      const filas = [...porAlumno.entries()].map(([studentId, casos]) => {
        const u = esAlumno.get(studentId);
        const detalle = casos
          .map(c => `${nombreDivision[c.divisionId] || 'curso'}: ${c.tiene}/${c.total}`)
          .join(', ');
        const aSumar = casos.reduce((acc, c) => acc + (c.total - c.tiene), 0);
        return {
          principal: u ? u.name : '(usuario borrado)',
          secundario: u ? u.email : '',
          extra: `${detalle} → +${aSumar}`,
          fecha: null,
          _orden: aSumar,
        };
      }).sort((a, b) => b._orden - a._orden);

      return {
        total: porAlumno.size,
        muestra: filas.slice(0, MUESTRA_MAX),
        nota: porAlumno.size
          ? `Se van a crear ${inscripciones} inscripción(es) nuevas en ${faltantes.size} materia(s). ` +
            'Las materias donde el alumno ya figura quedan intactas: no se duplican ni se pierden ' +
            'sus entregas ni sus notas. ' +
            (enVariasDivisiones.size
              ? `Quedan excluidos ${enVariasDivisiones.size} alumno(s) que aparecen en más de un curso — ` +
                'esos son ambiguos y se revisan en el arreglo de abajo.'
              : '')
          : null,
      };
    },

    async aplicar() {
      const { faltantes } = await calcularMatriculaParcial();
      if (!faltantes.size) return { afectados: 0, mensaje: 'No había matrículas incompletas.' };

      const ahora = new Date();
      const ops = [];
      let inscripciones = 0;

      for (const [courseId, studentIds] of faltantes) {
        for (const studentId of studentIds) {
          inscripciones++;
          ops.push({
            updateOne: {
              filter: { _id: new mongoose.Types.ObjectId(courseId) },
              update: {
                // $addToSet y no $push: aunque el cálculo ya excluye a los que están, esto
                // hace la operación idempotente si se la corre dos veces seguidas.
                $addToSet: { students: new mongoose.Types.ObjectId(studentId) },
                // enrollmentDates = ahora: routes/activities.js lo usa para NO mostrarle al
                // alumno las tareas que vencieron antes de que se lo incorporara. Sin esto,
                // al completarle la matrícula le aparecerían como pendientes todas las
                // tareas atrasadas del año.
                $set: { [`enrollmentDates.${studentId}`]: ahora },
              },
            },
          });
        }
      }

      const r = await Course.bulkWrite(ops, { ordered: false });
      return {
        afectados: r.modifiedCount ?? inscripciones,
        mensaje: `${inscripciones} inscripción(es) agregadas en ${faltantes.size} materia(s). ` +
                 'Las tareas que vencieron antes de hoy no les van a figurar como pendientes.',
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'alumnos-en-varios-cursos',
    titulo: 'Alumnos que figuran en más de un curso',
    descripcion:
      'Aparecen en materias de dos o más cursos a la vez (por ejemplo 1° 1° y 4° 4°), que casi ' +
      'siempre es un error de carga. Son los que el arreglo anterior deja afuera: hay que ' +
      'sacarlos del curso que no corresponde desde el panel de administración.',
    icono: 'call_split',
    severidad: 'media',
    // SIN arreglo automático: no hay ninguna señal en los datos que diga cuál de los dos
    // cursos es el correcto. Elegir uno al azar y desmatricular del otro podría borrar
    // entregas y notas legítimas. Es el caso típico de "esto lo decide una persona".
    aplicable: false,
    parametros: [],

    async diagnosticar() {
      const { enVariasDivisiones, divisionesPorAlumno, esAlumno } = await calcularMatriculaParcial();
      const divisiones = await Division.find().select('_id name').lean();
      const nombreDivision = Object.fromEntries(divisiones.map(d => [d._id.toString(), d.name]));

      const filas = [...enVariasDivisiones].map(studentId => {
        const u = esAlumno.get(studentId);
        const cursos = [...(divisionesPorAlumno.get(studentId) || [])]
          .map(d => nombreDivision[d] || '?')
          .sort();
        return {
          principal: u ? u.name : '(usuario borrado)',
          secundario: u ? u.email : '',
          extra: cursos.join(' + '),
          fecha: null,
          _n: cursos.length,
        };
      }).sort((a, b) => b._n - a._n || a.principal.localeCompare(b.principal, 'es'));

      return {
        total: enVariasDivisiones.size,
        muestra: filas.slice(0, MUESTRA_MAX),
        nota: enVariasDivisiones.size
          ? 'Revisalos desde el perfil de cada alumno en el panel de administración: ahí se ve ' +
            'en qué materias está y se lo puede sacar de las que no corresponden. Una vez que ' +
            'quede en un solo curso, el arreglo de arriba le completa la matrícula.'
          : null,
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'usuarios-sin-escuela',
    titulo: 'Cuentas sin escuela asignada',
    descripcion:
      'Se registraron por el formulario público cuando todavía no pedía escuela. Con school:null ' +
      'no figuran en ningún panel, no se las puede matricular y quien entra con ellas no ve nada. ' +
      'El arreglo las asigna a la escuela que elijas, sin tocar ningún otro campo.',
    icono: 'domain_disabled',
    severidad: 'alta',
    aplicable: true,
    parametros: [
      { name: 'schoolId', label: 'Asignar a la escuela', tipo: 'select', opciones: escuelasDisponibles },
    ],

    async diagnosticar() {
      const total = await User.countDocuments(filtroSinEscuela);
      const muestra = await User.find(filtroSinEscuela)
        .select('name email role createdAt')
        .sort({ createdAt: -1 })
        .limit(MUESTRA_MAX)
        .lean();
      const porRol = await User.aggregate([
        { $match: filtroSinEscuela },
        { $group: { _id: '$role', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]);
      return {
        total,
        muestra: muestra.map(u => ({
          principal: u.name,
          secundario: u.email,
          extra: u.role,
          fecha: u.createdAt,
        })),
        nota: porRol.length
          ? 'Por rol: ' + porRol.map(r => `${r.n} ${r._id}`).join(', ') + '.'
          : null,
      };
    },

    async aplicar({ schoolId }) {
      if (!schoolId) return { afectados: 0, mensaje: 'No elegiste ninguna escuela.' };
      const escuela = await School.findById(schoolId).select('name');
      if (!escuela) return { afectados: 0, mensaje: 'Esa escuela no existe.' };

      // updateMany y no un save() por documento: son cientos de cuentas y no hay hooks
      // del modelo que dependan de este campo (el pre-save solo hashea la contraseña).
      const r = await User.updateMany(filtroSinEscuela, { $set: { school: escuela._id } });
      return {
        afectados: r.modifiedCount,
        mensaje: `${r.modifiedCount} cuenta(s) asignadas a ${escuela.name}. ` +
                 'Ya aparecen en el panel de administración y se las puede matricular.',
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'usuarios-sin-dni',
    titulo: 'Cuentas sin DNI',
    descripcion:
      'El DNI es obligatorio desde el 30/07/2026, pero estas cuentas son anteriores. No rompen nada ' +
      '(la validación vive en las rutas de alta y edición, no en el modelo), pero quedan incompletas ' +
      'y el dato se les va a pedir la próxima vez que alguien las edite.',
    icono: 'fingerprint',
    severidad: 'media',
    // SIN arreglo automático, deliberadamente: el DNI de una persona no se puede deducir de
    // ningún otro campo. Se probó extraerlo del email y los únicos casos con dígitos son
    // fechas de nacimiento (martinezgomez...22012013@gmail.com), no documentos. Generar un
    // número sería corromper la base con datos falsos que después nadie sabría distinguir
    // de los reales. Se completan a mano desde el perfil de cada usuario.
    aplicable: false,
    parametros: [],

    async diagnosticar() {
      const filtro = { $or: [{ dni: null }, { dni: { $exists: false } }] };
      const total = await User.countDocuments(filtro);
      const muestra = await User.find(filtro)
        .select('name email role school')
        .sort({ role: 1, name: 1 })
        .limit(MUESTRA_MAX)
        .lean();
      const sinEscuela = await User.countDocuments({ ...filtro, school: null });
      return {
        total,
        muestra: muestra.map(u => ({
          principal: u.name,
          secundario: u.email,
          extra: u.role,
          fecha: null,
        })),
        nota: sinEscuela === total
          ? 'Son exactamente las mismas cuentas del arreglo anterior: todas están sin escuela. ' +
            'Conviene asignarles escuela primero, para que aparezcan en el panel y se les pueda cargar el DNI.'
          : `${sinEscuela} de ellas además están sin escuela.`,
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'alumnos-sin-matricular',
    titulo: 'Alumnos activos sin ninguna materia',
    descripcion:
      'Cuentas de alumno habilitadas que no figuran en ninguna materia: entran al sistema y ven ' +
      'el dashboard vacío. Puede ser que se hayan registrado solos y nadie los matriculó todavía.',
    icono: 'person_off',
    severidad: 'alta',
    // SIN arreglo automático: matricular exige saber A QUÉ CURSO va cada alumno, y ese dato
    // no está en ningún lado (no tienen división, ni DNI que cruzar contra un padrón).
    // Inscribirlos a todos en un curso elegido a dedo sería meter alumnos donde no van.
    // El camino correcto es el alta con Curso del panel de administración o de preceptoría,
    // que matricula uno por uno con criterio.
    aplicable: false,
    parametros: [],

    async diagnosticar() {
      const matriculados = new Set(
        (await Course.find().distinct('students')).map(String)
      );
      const alumnos = await User.find({ role: 'student', active: true })
        .select('name email dni school createdAt')
        .lean();
      const sueltos = alumnos.filter(a => !matriculados.has(a._id.toString()));
      const sinEscuela = sueltos.filter(a => !a.school).length;

      return {
        total: sueltos.length,
        muestra: sueltos
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, MUESTRA_MAX)
          .map(a => ({
            principal: a.name,
            secundario: a.email,
            extra: a.dni ? `DNI ${a.dni}` : 'sin DNI',
            fecha: a.createdAt,
          })),
        nota: sinEscuela
          ? `${sinEscuela} de ellos tampoco tienen escuela, así que ni siquiera aparecen en el panel ` +
            'de administración para poder matricularlos. Ese arreglo va primero.'
          : 'Todos tienen escuela: se los puede matricular desde el panel de administración o de preceptoría.',
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'preceptores-sin-cursos',
    titulo: 'Preceptores sin cursos a cargo',
    descripcion:
      'Tienen el rol pero el alcance vacío, así que al entrar no ven ningún curso ni alumno. ' +
      'El arreglo les da acceso a TODOS los cursos de su escuela (equivale a tildar "Todos los ' +
      'cursos" en su perfil). Si preferís acotarlos, asignáselos uno por uno desde su perfil.',
    icono: 'badge',
    severidad: 'media',
    aplicable: true,
    parametros: [],

    async diagnosticar() {
      const filtro = { role: 'preceptor', allDivisions: { $ne: true }, assignedDivisions: { $size: 0 } };
      const total = await User.countDocuments(filtro);
      const muestra = await User.find(filtro)
        .select('name email school')
        .sort({ name: 1 })
        .limit(MUESTRA_MAX)
        .lean();

      // Sin escuela, "todos los cursos de su escuela" no resuelve nada: el middleware corta
      // antes por falta de escuela. Vale avisarlo para que no parezca que el arreglo falló.
      const sinEscuela = await User.countDocuments({ ...filtro, school: null });
      return {
        total,
        muestra: muestra.map(u => ({
          principal: u.name,
          secundario: u.email,
          extra: u.school ? 'con escuela' : 'SIN escuela',
          fecha: null,
        })),
        nota: sinEscuela
          ? `${sinEscuela} no tienen escuela asignada: a esos el arreglo no les cambia nada hasta que la tengan.`
          : null,
      };
    },

    async aplicar() {
      const filtro = { role: 'preceptor', allDivisions: { $ne: true }, assignedDivisions: { $size: 0 } };
      const r = await User.updateMany(filtro, { $set: { allDivisions: true } });
      return {
        afectados: r.modifiedCount,
        mensaje: `${r.modifiedCount} preceptor(es) ahora ven todos los cursos de su escuela.`,
      };
    },
  },
];

const getFix = (id) => FIXES.find(f => f.id === id) || null;

// Resuelve los parámetros de un arreglo para poder pintarlos (las opciones de un select
// pueden depender de la base, como la lista de escuelas).
async function resolverParametros(fix) {
  const params = [];
  for (const p of fix.parametros || []) {
    params.push({
      ...p,
      opciones: typeof p.opciones === 'function' ? await p.opciones() : (p.opciones || []),
    });
  }
  return params;
}

// Diagnostica todos los arreglos en paralelo, para la grilla de tarjetas.
async function diagnosticarTodos() {
  return Promise.all(FIXES.map(async (fix) => {
    try {
      const d = await fix.diagnosticar();
      return {
        id: fix.id, titulo: fix.titulo, descripcion: fix.descripcion,
        icono: fix.icono, severidad: fix.severidad, aplicable: fix.aplicable,
        parametros: await resolverParametros(fix),
        total: d.total, muestra: d.muestra, nota: d.nota || null,
        error: null,
      };
    } catch (err) {
      // Un arreglo que rompe no debe tumbar la pantalla entera: el resto sigue siendo útil.
      return {
        id: fix.id, titulo: fix.titulo, descripcion: fix.descripcion,
        icono: fix.icono, severidad: fix.severidad, aplicable: fix.aplicable,
        parametros: [], total: null, muestra: [], nota: null,
        error: err.message,
      };
    }
  }));
}

module.exports = { FIXES, getFix, diagnosticarTodos, diagnosticarUno: (id) => getFix(id)?.diagnosticar() };
