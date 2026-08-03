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

const mongoose     = require('mongoose');
const User         = require('../models/User');
const Course       = require('../models/Course');
const School       = require('../models/School');
const Division     = require('../models/Division');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const Announcement = require('../models/Announcement');

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

// DNI normalizado para COMPARAR dos cuentas. El índice único { school, dni } del modelo
// compara el string crudo, así que "12.345.678", "12345678" y "012345678" conviven en la
// base sin que Mongo se queje — y son la misma persona. Devuelve '' si no queda ningún
// dígito (DNI vacío, "-", "s/d"): esos no se comparan con nadie.
//
// NO es normalizeDni() de services/dni.js, a propósito: aquél valida un DNI que se está
// cargando (rechaza los que no tienen entre 7 y 9 dígitos) y no saca los ceros a la
// izquierda. Acá hay que comparar lo que YA está guardado, incluida la data vieja fuera de
// rango — descartarla haría que un duplicado real pase desapercibido.
function normalizarDni(dni) {
  if (dni == null) return '';
  return String(dni).replace(/\D/g, '').replace(/^0+/, '');
}

// Dos cuentas de alumno distintas con el mismo DNI dentro del mismo curso: siempre es la
// misma persona cargada dos veces (alta manual + importación, o registro público sobre una
// cuenta que ya existía). El docente la ve duplicada en la lista y en el gradebook, y las
// entregas quedan repartidas entre las dos.
//
// "Curso" acá es la División (1°1°, 2°3°…), no la materia: el duplicado se busca entre
// TODOS los alumnos de todas las materias de la división, porque una misma persona puede
// estar con una cuenta en Matemática y con la otra en Historia del mismo curso.
//
// Lo comparten diagnosticar() y aplicar(), como en calcularMatriculaParcial().
// Devuelve { grupos: [{ divisionId, dni, materias, conservar, sacar, ambigua }] }.
async function calcularDniDuplicados() {
  const cursos = await Course.find().select('_id name division students').lean();

  // Solo alumnos: un docente que quedó dentro de students[] por un error viejo no es un
  // duplicado de alumno, y sacarlo del curso no es lo que este arreglo tiene que hacer.
  const idsEnCursos = [...new Set(cursos.flatMap(c => (c.students || []).map(String)))];
  const alumnos = await User.find({ _id: { $in: idsEnCursos }, role: 'student' })
    .select('_id name email dni active lastSeen createdAt').lean();
  const porId = new Map(alumnos.map(a => [a._id.toString(), a]));

  const porDivision = new Map();
  for (const c of cursos) {
    const k = c.division?.toString();
    if (!k) continue; // materia sin división: no pertenece a ningún curso
    if (!porDivision.has(k)) porDivision.set(k, []);
    porDivision.get(k).push(c);
  }

  const crudos = [];
  for (const [divisionId, materias] of porDivision) {
    const porDni = new Map(); // dni normalizado → Map(studentId → user)
    for (const mat of materias) {
      for (const s of new Set((mat.students || []).map(String))) {
        const u = porId.get(s);
        if (!u) continue;
        const dni = normalizarDni(u.dni);
        if (!dni) continue; // sin DNI no hay con qué comparar (ver 'usuarios-sin-dni')
        if (!porDni.has(dni)) porDni.set(dni, new Map());
        porDni.get(dni).set(s, u);
      }
    }
    for (const [dni, cuentas] of porDni) {
      if (cuentas.size < 2) continue;
      crudos.push({ divisionId, dni, materias, cuentas: [...cuentas.values()] });
    }
  }

  if (!crudos.length) return { grupos: [] };

  // Qué cuenta tiene trabajo hecho en el curso: es lo único que decide cuál se conserva.
  // Se mide sobre las dos fuentes donde vive, porque una nota puede existir sin entrega
  // (el docente califica en papel y la carga) y una entrega sin nota (todavía sin corregir).
  const materiaIds = [...new Set(crudos.flatMap(g => g.materias.map(m => m._id.toString())))]
    .map(id => new mongoose.Types.ObjectId(id));
  const alumnoIds = [...new Set(crudos.flatMap(g => g.cuentas.map(u => u._id.toString())))];
  const esCandidato = new Set(alumnoIds);

  const actividades = await Activity.find({ course: { $in: materiaIds } })
    .select('_id course grades.student').lean();
  const cursoDeActividad = new Map(actividades.map(a => [a._id.toString(), a.course.toString()]));

  const trabajo = new Map(); // `${studentId}|${courseId}` → cuántas señales de actividad
  const sumar = (studentId, courseId) => {
    const k = studentId + '|' + courseId;
    trabajo.set(k, (trabajo.get(k) || 0) + 1);
  };

  for (const a of actividades) {
    for (const g of (a.grades || [])) {
      const s = g.student?.toString();
      if (s && esCandidato.has(s)) sumar(s, a.course.toString());
    }
  }

  const entregas = await Submission.find({
    activity: { $in: actividades.map(a => a._id) },
    student:  { $in: alumnoIds.map(id => new mongoose.Types.ObjectId(id)) },
  }).select('activity student').lean();
  for (const e of entregas) {
    const courseId = cursoDeActividad.get(e.activity.toString());
    if (courseId) sumar(e.student.toString(), courseId);
  }

  const grupos = crudos.map(g => {
    const cuentas = g.cuentas.map(u => {
      const id = u._id.toString();
      return {
        u,
        trabajos: g.materias.reduce(
          (acc, m) => acc + (trabajo.get(id + '|' + m._id.toString()) || 0), 0),
        materiasEn: g.materias.filter(m => (m.students || []).some(s => s.toString() === id)).length,
      };
    });

    const conTrabajo = cuentas.filter(c => c.trabajos > 0);

    // DOS cuentas con entregas o notas propias = las dos tienen datos que se perderían de
    // vista al desmatricular una. Cuál es la buena y qué se hace con el trabajo de la otra
    // lo decide una persona: el grupo queda marcado como ambiguo y aplicar() lo saltea.
    if (conTrabajo.length > 1) {
      return { ...g, cuentas, conservar: null, sacar: [], ambigua: true };
    }

    // Si hay exactamente una con trabajo, esa es la real y las demás están vacías en este
    // curso. Si ninguna tiene trabajo, ninguna tiene nada que perder: se conserva la que
    // más "vive" — habilitada, en más materias, con conexión más reciente y más antigua.
    const conservar = conTrabajo.length === 1
      ? conTrabajo[0]
      : [...cuentas].sort((a, b) =>
          (b.u.active !== false) - (a.u.active !== false) ||
          b.materiasEn - a.materiasEn ||
          (b.u.lastSeen ? new Date(b.u.lastSeen) : 0) - (a.u.lastSeen ? new Date(a.u.lastSeen) : 0) ||
          new Date(a.u.createdAt || 0) - new Date(b.u.createdAt || 0)
        )[0];

    return {
      ...g,
      cuentas,
      conservar,
      sacar: cuentas.filter(c => c !== conservar),
      ambigua: false,
    };
  });

  return { grupos };
}

// Dos (o más) cuentas de DOCENTE con el mismo DNI en la misma escuela: es la misma persona
// cargada dos veces — típicamente la cuenta vieja con su mail personal más la institucional
// creada después (@escuelasanjose.edu.ar). Una se queda con todas las materias y la otra
// entra y no ve nada, así que el docente termina usando la que "funciona" sin saber por qué.
//
// A diferencia del resto de este archivo, acá NO hay una regla automática: cuál de las dos
// cuentas se conserva es una decisión de la escuela (el mail institucional puede ser el
// correcto aunque las materias estén en el otro). Por eso este arreglo no tiene aplicar():
// muestra las cuentas con sus números y la persona elige, grupo por grupo, desde la tarjeta.
//
// El agrupamiento es por escuela + DNI normalizado: el índice único { school, dni } compara
// el string crudo, así que "12.345.678" y "12345678" conviven sin que Mongo se queje. Entre
// escuelas distintas NO se agrupa: un docente puede trabajar legítimamente en dos.
//
// Se ignoran las cuentas ya deshabilitadas Y sin materias: son el resto de una fusión
// anterior. Si no, el grupo quedaría reportado para siempre después de resolverlo.
async function calcularDocentesDuplicados() {
  const docentes = await User.find({ role: 'teacher' })
    .select('_id name email dni school active lastSeen createdAt').lean();

  const porClave = new Map(); // `${schoolId}|${dni}` → [user]
  for (const u of docentes) {
    if (!u.school) continue;  // sin escuela no hay contra qué agrupar (ver 'usuarios-sin-escuela')
    const dni = normalizarDni(u.dni);
    if (!dni) continue;       // sin DNI no hay con qué comparar (ver 'usuarios-sin-dni')
    const clave = `${u.school.toString()}|${dni}`;
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave).push(u);
  }

  const candidatos = [...porClave.entries()].filter(([, us]) => us.length > 1);
  if (!candidatos.length) return { grupos: [] };

  // Un solo barrido por colección para todas las cuentas en juego: son pocas cuentas pero
  // 419 materias y miles de actividades, así que no conviene contar de a una.
  const ids = candidatos.flatMap(([, us]) => us.map(u => u._id));
  const contar = async (Model, campo) => {
    const filas = await Model.aggregate([
      { $match: { [campo]: { $in: ids } } },
      { $group: { _id: `$${campo}`, n: { $sum: 1 } } },
    ]);
    return new Map(filas.map(f => [f._id.toString(), f.n]));
  };
  const [titular, actividades, novedades] = await Promise.all([
    contar(Course, 'owner'),
    contar(Activity, 'author'),
    contar(Announcement, 'author'),
  ]);
  // coTeachers es un array: el $group de arriba no sirve, hay que desarmarlo.
  const suplenteFilas = await Course.aggregate([
    { $match: { coTeachers: { $in: ids } } },
    { $unwind: '$coTeachers' },
    { $match: { coTeachers: { $in: ids } } },
    { $group: { _id: '$coTeachers', n: { $sum: 1 } } },
  ]);
  const suplente = new Map(suplenteFilas.map(f => [f._id.toString(), f.n]));

  const escuelas = await School.find().select('_id name').lean();
  const nombreEscuela = Object.fromEntries(escuelas.map(e => [e._id.toString(), e.name]));

  const grupos = [];
  for (const [clave, us] of candidatos) {
    const [schoolId, dni] = clave.split('|');

    const cuentas = us.map(u => {
      const id = u._id.toString();
      return {
        id,
        nombre: u.name,
        email: u.email,
        dniCrudo: u.dni,
        activa: u.active !== false,
        titular:     titular.get(id)     || 0,
        suplente:    suplente.get(id)    || 0,
        actividades: actividades.get(id) || 0,
        novedades:   novedades.get(id)   || 0,
        ultimoAcceso: u.lastSeen || null,
        creada: u.createdAt || null,
      };
    });

    // Restos de una fusión anterior: deshabilitadas y sin nada a cargo. No son un duplicado
    // pendiente — la decisión ya se tomó.
    const vivas = cuentas.filter(c => c.activa || c.titular || c.suplente);
    if (vivas.length < 2) continue;

    // Sugerencia (no decisión): la cuenta con más trabajo real encima. Empatadas, la que
    // se conectó más recientemente; si tampoco, la más antigua. La persona puede elegir
    // otra — el caso típico es quedarse con el mail institucional aunque esté vacío.
    const peso = c => c.titular * 100 + c.suplente * 50 + c.actividades + c.novedades;
    const sugerida = [...cuentas].sort((a, b) =>
      peso(b) - peso(a) ||
      (b.activa === a.activa ? 0 : b.activa ? 1 : -1) ||
      new Date(b.ultimoAcceso || 0) - new Date(a.ultimoAcceso || 0) ||
      new Date(a.creada || 0) - new Date(b.creada || 0)
    )[0];

    grupos.push({
      clave,
      schoolId,
      escuela: nombreEscuela[schoolId] || 'escuela',
      dni,
      cuentas: cuentas.sort((a, b) => peso(b) - peso(a)),
      sugeridaId: sugerida.id,
    });
  }

  grupos.sort((a, b) => a.escuela.localeCompare(b.escuela, 'es') || a.dni.localeCompare(b.dni));
  return { grupos };
}

// Pasa TODO lo que una cuenta de docente tiene a cargo a la cuenta que se conserva, y deja
// la sobrante deshabilitada o eliminada. Devuelve el detalle de lo movido.
//
// El orden importa: primero se transfiere y recién al final se toca la cuenta sobrante. Si
// algo falla en el medio, lo peor que queda es una transferencia parcial con las dos cuentas
// todavía vivas — nunca una cuenta borrada con materias apuntando a ella (que es exactamente
// el bug de las referencias colgadas que rompía /admin/courses).
async function fusionarDocentes({ clave, keepId, sobrante = 'deshabilitar', emailId = null }) {
  const { grupos } = await calcularDocentesDuplicados();
  const grupo = grupos.find(g => g.clave === clave);
  if (!grupo) {
    throw new Error('Ese grupo ya no figura como duplicado (puede que alguien lo haya resuelto recién). Actualizá la página.');
  }
  if (!grupo.cuentas.some(c => c.id === keepId)) {
    throw new Error('La cuenta elegida no pertenece a este grupo.');
  }
  if (!['deshabilitar', 'eliminar'].includes(sobrante)) {
    throw new Error('Qué hacer con la cuenta sobrante solo puede ser "deshabilitar" o "eliminar".');
  }
  // Con qué correo queda la cuenta conservada. Son dos decisiones distintas a propósito: el
  // caso más común es quedarse con la cuenta que YA tiene las materias (así no se mueve
  // nada) pero con el correo institucional, que hoy está en la otra.
  const correoDe = emailId || keepId;
  if (!grupo.cuentas.some(c => c.id === correoDe)) {
    throw new Error('El correo elegido no pertenece a ninguna cuenta de este grupo.');
  }

  const keep     = new mongoose.Types.ObjectId(keepId);
  const perdedor = grupo.cuentas.filter(c => c.id !== keepId);
  const perdedorIds = perdedor.map(c => new mongoose.Types.ObjectId(c.id));

  const resumen = { titular: 0, suplente: 0, actividades: 0, novedades: 0, comentarios: 0, matriculas: 0 };

  // 1. Materias donde la cuenta sobrante es titular → pasan a la que se conserva. Si la que
  //    se conserva ya figuraba como suplente en esa materia, se la saca de ahí: quedaría
  //    listada dos veces en la solapa Personas (misma regla que POST /courses/:id/assign-teacher).
  const comoTitular = await Course.find({ owner: { $in: perdedorIds } }).select('_id coTeachers').lean();
  for (const c of comoTitular) {
    await Course.updateOne(
      { _id: c._id },
      { $set: { owner: keep }, $pull: { coTeachers: keep } },
    );
    resumen.titular++;
  }

  // 2. Materias donde es suplente → la reemplaza la que se conserva, salvo que esa ya sea
  //    titular o suplente (ahí solo se saca a la sobrante, sin duplicar).
  const comoSuplente = await Course.find({ coTeachers: { $in: perdedorIds } })
    .select('_id owner coTeachers').lean();
  for (const c of comoSuplente) {
    const yaEsta = c.owner?.toString() === keepId
      || (c.coTeachers || []).some(t => t.toString() === keepId);
    await Course.updateOne({ _id: c._id }, { $pull: { coTeachers: { $in: perdedorIds } } });
    if (!yaEsta) await Course.updateOne({ _id: c._id }, { $addToSet: { coTeachers: keep } });
    resumen.suplente++;
  }

  // 3. Autoría de actividades y novedades. Sin esto, borrar la cuenta sobrante dejaría
  //    `author` apuntando a un usuario inexistente — la misma clase de referencia colgada
  //    que tiraba 500 el panel de materias.
  resumen.actividades = (await Activity.updateMany({ author: { $in: perdedorIds } }, { $set: { author: keep } })).modifiedCount;
  resumen.novedades   = (await Announcement.updateMany({ author: { $in: perdedorIds } }, { $set: { author: keep } })).modifiedCount;
  resumen.comentarios = (await Announcement.updateMany(
    { 'comments.author': { $in: perdedorIds } },
    { $set: { 'comments.$[c].author': keep } },
    { arrayFilters: [{ 'c.author': { $in: perdedorIds } }] },
  )).modifiedCount;

  // 4. Un docente no debería estar dentro de students[], pero pasa con las cargas viejas:
  //    ahí no se transfiere nada, se saca. Inscribir a la cuenta buena como alumna de su
  //    propia materia sería peor que el problema original.
  resumen.matriculas = (await Course.updateMany(
    { students: { $in: perdedorIds } },
    { $pull: { students: { $in: perdedorIds } } },
  )).modifiedCount;

  // 5. Recién ahora la cuenta sobrante. Si tiene entregas propias (fue alumna alguna vez)
  //    no se borra aunque lo pidan: borrarla dejaría `Submission.student` colgado.
  const conEntregas = await Submission.countDocuments({ student: { $in: perdedorIds } });
  const accion = (sobrante === 'eliminar' && conEntregas === 0) ? 'eliminar' : 'deshabilitar';
  if (accion === 'eliminar') {
    await User.deleteMany({ _id: { $in: perdedorIds } });
  } else {
    await User.updateMany({ _id: { $in: perdedorIds } }, { $set: { active: false } });
  }

  // 6. El correo. Va ÚLTIMO porque `User.email` es único global: para que la conservada se
  //    quede con el correo de la otra, ese correo tiene que estar libre primero.
  //
  //    - Si la sobrante se eliminó, ya quedó libre y alcanza con asignarlo.
  //    - Si sigue viva (deshabilitada), se INTERCAMBIAN: la conservada toma el correo
  //      institucional y la deshabilitada se queda con el personal. Nadie pierde un correo
  //      válido, no se inventa ninguno y se puede revertir haciendo el camino inverso.
  //
  //    El intercambio pasa por un correo temporal porque el índice único no admite que las
  //    dos tengan el mismo valor ni por un instante. Si el proceso se cortara entre medio,
  //    la cuenta deshabilitada queda con ese temporal — se ve a simple vista y se arregla
  //    a mano desde el panel de administración; la conservada nunca queda sin correo.
  const cuentaConservada = grupo.cuentas.find(c => c.id === keepId);
  const correoFinal = grupo.cuentas.find(c => c.id === correoDe).email;
  const correoCambiado = correoDe !== keepId;

  if (correoCambiado) {
    const donante = grupo.cuentas.find(c => c.id === correoDe); // siempre una de las sobrantes
    if (accion === 'eliminar') {
      await User.updateOne({ _id: keep }, { $set: { email: correoFinal } });
    } else {
      const temporal = `fusion-en-curso-${donante.id}@invalido.local`;
      await User.updateOne({ _id: donante.id }, { $set: { email: temporal } });
      await User.updateOne({ _id: keep },       { $set: { email: correoFinal } });
      await User.updateOne({ _id: donante.id }, { $set: { email: cuentaConservada.email } });
    }
  }

  return {
    resumen,
    accion,
    forzadoDeshabilitar: sobrante === 'eliminar' && accion === 'deshabilitar',
    conservada: cuentaConservada,
    sobrantes: perdedor,
    correo: {
      final: correoFinal,
      cambiado: correoCambiado,
      anterior: cuentaConservada.email,
      // Solo cuando la sobrante sigue viva: se quedó con el correo que soltó la conservada.
      intercambiadoCon: correoCambiado && accion !== 'eliminar' ? cuentaConservada.email : null,
    },
  };
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
    id: 'dni-duplicado-en-curso',
    titulo: 'Dos alumnos con el mismo DNI en un curso',
    descripcion:
      'Es la misma persona cargada dos veces (alta manual + importación, o registro público ' +
      'sobre una cuenta que ya existía): el docente la ve repetida en la lista y en el ' +
      'gradebook. El arreglo saca del curso la cuenta vacía y conserva la que tiene las ' +
      'entregas y las notas. NO borra ninguna cuenta ni ninguna entrega. Si las dos tienen ' +
      'trabajo hecho, el caso se deja para revisar a mano.',
    icono: 'group_remove',
    severidad: 'alta',
    aplicable: true,
    parametros: [],

    async diagnosticar() {
      const { grupos } = await calcularDniDuplicados();
      const divisiones = await Division.find().select('_id name').lean();
      const nombreDivision = Object.fromEntries(divisiones.map(d => [d._id.toString(), d.name]));

      const ambiguos = grupos.filter(g => g.ambigua).length;
      const cuentasASacar = grupos.reduce((acc, g) => acc + g.sacar.length, 0);

      const filas = grupos.map(g => {
        const curso = nombreDivision[g.divisionId] || 'curso';
        const etiqueta = c => `${c.u.name} (${c.u.email})`;
        return {
          principal: `${curso} · DNI ${g.dni}`,
          secundario: g.ambigua
            ? g.cuentas.map(c => `${etiqueta(c)} — ${c.trabajos} entrega(s)/nota(s)`).join('  ·  ')
            : `Se conserva ${etiqueta(g.conservar)}` +
              `${g.conservar.trabajos ? ` — ${g.conservar.trabajos} entrega(s)/nota(s)` : ' — sin trabajo cargado'}` +
              `  ·  Se saca del curso ${g.sacar.map(etiqueta).join(', ')}`,
          extra: g.ambigua ? 'revisar a mano' : `−${g.sacar.length} cuenta(s)`,
          fecha: null,
          _orden: g.ambigua ? 1 : 0,
        };
      }).sort((a, b) => b._orden - a._orden || a.principal.localeCompare(b.principal, 'es'));

      return {
        total: grupos.length,
        muestra: filas.slice(0, MUESTRA_MAX),
        nota: grupos.length
          ? `Se van a sacar ${cuentasASacar} cuenta(s) de las materias del curso donde están duplicadas. ` +
            'Las cuentas NO se borran: quedan sin ese curso y se las puede deshabilitar o eliminar ' +
            'después desde el panel de administración. Tampoco se toca nada fuera de ese curso. ' +
            (ambiguos
              ? `${ambiguos} caso(s) quedan afuera porque las dos cuentas tienen entregas o notas propias: ` +
                'ahí hay que decidir con qué cuenta se queda el alumno antes de sacar la otra.'
              : '')
          : null,
      };
    },

    async aplicar() {
      const { grupos } = await calcularDniDuplicados();
      const resolubles = grupos.filter(g => !g.ambigua);
      if (!resolubles.length) {
        return {
          afectados: 0,
          mensaje: grupos.length
            ? 'No se aplicó nada: los duplicados que quedan tienen entregas o notas en las dos ' +
              'cuentas y hay que resolverlos a mano.'
            : 'No había DNI duplicados en ningún curso.',
        };
      }

      const ops = [];
      let cuentas = 0;
      for (const g of resolubles) {
        for (const c of g.sacar) {
          const sid = c.u._id.toString();
          cuentas++;
          for (const mat of g.materias) {
            // Solo las materias donde esta cuenta figura: no tiene sentido mandar un update
            // por cada materia del curso cuando la duplicada estaba en una sola.
            if (!(mat.students || []).some(s => s.toString() === sid)) continue;
            ops.push({
              updateOne: {
                filter: { _id: mat._id },
                update: {
                  // $pull saca TODAS las apariciones, así que también limpia el caso del
                  // mismo alumno cargado dos veces en el array de una misma materia.
                  $pull:  { students: new mongoose.Types.ObjectId(sid) },
                  // Sin esto quedaría una fecha de inscripción huérfana en el Map, que
                  // volvería a aplicarse si alguna vez se rematricula a esa cuenta.
                  $unset: { [`enrollmentDates.${sid}`]: '' },
                },
              },
            });
          }
        }
      }

      await Course.bulkWrite(ops, { ordered: false });
      const cursos = new Set(resolubles.map(g => g.divisionId)).size;
      return {
        afectados: cuentas,
        mensaje: `${cuentas} cuenta(s) duplicada(s) sacadas de ${ops.length} materia(s) en ` +
                 `${cursos} curso(s). Las cuentas siguen existiendo y no se borró ninguna ` +
                 'entrega ni nota: si además hay que darlas de baja, se hace desde el panel de administración.',
      };
    },
  },

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'docentes-dni-duplicado',
    titulo: 'Dos docentes con el mismo DNI',
    descripcion:
      'La misma persona con dos cuentas en la escuela: la vieja con su mail personal y la ' +
      'institucional creada después. Las materias quedan colgadas de una sola, así que si ' +
      'entra por la otra no ve nada. Elegí con cuál se queda y el arreglo le pasa a esa todo ' +
      'lo de la otra: materias como titular y como suplente, actividades, novedades y ' +
      'comentarios. La cuenta sobrante queda deshabilitada (o eliminada, si lo pedís).',
    icono: 'person_search',
    severidad: 'alta',
    // Sin botón único: cuál cuenta se conserva no se puede deducir de los datos (el mail
    // institucional puede ser el correcto aunque esté vacío). Ver la REGLA DE ORO de arriba.
    // En vez de quedarse en diagnóstico, la tarjeta trae la elección adentro: un grupo por
    // duplicado, con los números de cada cuenta y un botón propio.
    aplicable: false,
    interactivo: true,
    parametros: [],

    async diagnosticar() {
      const { grupos } = await calcularDocentesDuplicados();
      const cuentasDeMas = grupos.reduce((acc, g) => acc + g.cuentas.length - 1, 0);
      const conMateriasRepartidas = grupos.filter(
        g => g.cuentas.filter(c => c.titular || c.suplente).length > 1
      ).length;

      return {
        total: grupos.length,
        grupos,
        muestra: grupos.slice(0, MUESTRA_MAX).map(g => ({
          principal: `DNI ${g.dni} · ${g.escuela}`,
          secundario: g.cuentas
            .map(c => `${c.nombre} (${c.email}) — ${c.titular} materia(s) como titular` +
                      `${c.suplente ? `, ${c.suplente} como suplente` : ''}` +
                      `${c.activa ? '' : ' · deshabilitada'}`)
            .join('  ·  '),
          extra: `${g.cuentas.length} cuentas`,
          fecha: null,
        })),
        nota: grupos.length
          ? `${cuentasDeMas} cuenta(s) de más. Elegí abajo, grupo por grupo, con cuál se queda cada ` +
            'docente: lo de la otra se transfiere y no se pierde nada. ' +
            (conMateriasRepartidas
              ? `Ojo con ${conMateriasRepartidas} caso(s): las dos cuentas tienen materias a cargo, ` +
                'así que la fusión le mueve a la elegida las materias de la otra (los alumnos y las ' +
                'entregas de esas materias no se tocan).'
              : 'En todos los casos una sola de las cuentas tiene materias.')
          : null,
      };
    },

    // No hay aplicar(): la resolución es grupo por grupo desde POST /superadmin/otros/:id/fusionar.
    fusionar: fusionarDocentes,
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
      'el dashboard vacío. Puede ser que se hayan registrado solos y nadie los matriculó todavía. ' +
      'Desde el 31/07/2026 se resuelve solo: al entrar, el alumno elige su curso una sola vez y ' +
      'queda inscripto en todas sus materias. Esta lista se vacía sola a medida que van entrando.',
    icono: 'person_off',
    severidad: 'alta',
    // SIN arreglo automático: matricular exige saber A QUÉ CURSO va cada alumno, y ese dato
    // no está en ningún lado (no tienen división, ni DNI que cruzar contra un padrón).
    // Inscribirlos a todos en un curso elegido a dedo sería meter alumnos donde no van.
    //
    // El dato que falta lo tiene el alumno, y desde el 2026-07-31 se lo pedimos a él: elige
    // su curso una sola vez desde su panel (services/selfEnroll.js). Por eso este arreglo
    // sigue siendo solo diagnóstico incluso ahora — el que aporta el dato es el alumno, no
    // un botón del superadmin. Las otras dos vías siguen siendo el alta con Curso del panel
    // de administración y la de preceptoría.
    aplicable: false,
    parametros: [],

    async diagnosticar() {
      const matriculados = new Set(
        (await Course.find().distinct('students')).map(String)
      );
      const alumnos = await User.find({ role: 'student', active: true })
        .select('name email dni school createdAt lastSeen')
        .lean();
      const sueltos = alumnos.filter(a => !matriculados.has(a._id.toString()));
      const sinEscuela = sueltos.filter(a => !a.school).length;
      // Nadie que no se haya conectado nunca pudo haber elegido su curso: separarlos explica
      // por qué el número no baja solo tan rápido como uno esperaría.
      const nuncaEntraron = sueltos.filter(a => !a.lastSeen).length;

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
        nota: sueltos.length
          ? (sinEscuela
              ? `${sinEscuela} de ellos tampoco tienen escuela, así que ni siquiera aparecen en el panel ` +
                'de administración para poder matricularlos. Ese arreglo va primero. '
              : 'Todos tienen escuela: se los puede matricular desde el panel de administración o de preceptoría. ') +
            (nuncaEntraron
              ? `${nuncaEntraron} nunca se conectaron: hasta que entren no pueden elegir su curso, ` +
                'así que a esos hay que matricularlos a mano o esperar a que entren.'
              : 'Todos se conectaron alguna vez, así que ya pueden elegir su curso desde su panel.')
          : null,
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
        interactivo: fix.interactivo === true,
        parametros: await resolverParametros(fix),
        total: d.total, muestra: d.muestra, nota: d.nota || null,
        // Solo los arreglos interactivos lo traen: es el detalle que la tarjeta necesita
        // para dejar elegir (ver 'docentes-dni-duplicado').
        grupos: d.grupos || [],
        error: null,
      };
    } catch (err) {
      // Un arreglo que rompe no debe tumbar la pantalla entera: el resto sigue siendo útil.
      return {
        id: fix.id, titulo: fix.titulo, descripcion: fix.descripcion,
        icono: fix.icono, severidad: fix.severidad, aplicable: fix.aplicable,
        interactivo: fix.interactivo === true,
        parametros: [], total: null, muestra: [], nota: null, grupos: [],
        error: err.message,
      };
    }
  }));
}

module.exports = { FIXES, getFix, diagnosticarTodos, diagnosticarUno: (id) => getFix(id)?.diagnosticar() };
