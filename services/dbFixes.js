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
//   interactivo   true → además (o en vez) del botón masivo, la tarjeta deja resolver el
//                 problema GRUPO POR GRUPO, porque la decisión es humana: con qué cuenta se
//                 queda la persona y con qué correo. Requiere fusionar() y que diagnosticar()
//                 devuelva `grupos`. Ver 'docentes-dni-duplicado' y 'dni-duplicado-en-curso'.
//   fusionar(p)   resuelve UN grupo: { clave, keepId, sobrante, emailId } →
//                 { mensaje, schoolId, accion, conservada, sobrantes, correo, auditoria }
//   compositor    true → no es un problema con un contador, es una HERRAMIENTA: la tarjeta
//                 pinta un formulario propio (lo que hay que crear no está en la base, lo
//                 escribe la persona) y el resultado del diagnóstico son las OPCIONES de
//                 ese formulario, no una lista de afectados. Ver 'alta-masiva-materias'.
//   parametros    [] o lista de campos que el arreglo necesita para poder correr; la vista
//                 los pinta como <select> y los manda en el body del POST
//   diagnosticar() → { total, muestra: [{...}], nota?, opciones? }
//                 `muestra` son hasta MUESTRA_MAX filas para la vista previa; nunca la
//                 lista completa, que puede ser de miles.
//   previsualizar(params) → forma libre; lo que la tarjeta muestre antes de aplicar.
//                 Opcional: solo lo tienen los arreglos que reciben datos cargados a mano,
//                 donde ver el efecto ANTES de escribir vale más que un contador.
//   aplicar(params) → { afectados, mensaje, schoolId?, meta? }
//                 `schoolId` fija la escuela del evento de auditoría (el superadmin no
//                 tiene escuela propia: sin esto el admin de la escuela no ve el evento).
//
// REGLA DE ORO de este archivo: un arreglo solo es `aplicable` si existe UNA respuesta
// correcta derivable de los datos. Si hace falta criterio humano (a qué curso va este
// alumno, cuál es el DNI de esta persona), el arreglo se queda en diagnóstico y deriva al
// panel que corresponda. Inventar el dato es peor que no arreglarlo.
//
// Los `compositor` no son la excepción a esa regla sino la otra cara: ahí el criterio
// humano ES el input (la persona escribe qué materias van y a cargo de quién), y el
// arreglo se limita a repetirlo sobre los cursos elegidos sin deducir nada.

const mongoose     = require('mongoose');
// Fechas con la zona de la escuela: services/liveRoom.js es el unico duenio de la hora.
const live         = require('./liveRoom');
const { v4: uuidv4 } = require('uuid');
const User         = require('../models/User');
const Course       = require('../models/Course');
const School       = require('../models/School');
const Division     = require('../models/Division');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const Announcement = require('../models/Announcement');
const Subject      = require('../models/Subject');
const ActivityView = require('../models/ActivityView');
const Suggestion   = require('../models/Suggestion');
// Las cuatro colecciones que una fusión de alumnos NO mueve. Se importan para poder CONTARLAS
// y decirlo en el resultado: medido el 2026-09-12 sobre una copia de producción, una fusión
// típica deja atrás las asistencias, la fila de la bandeja y decenas de mensajes de sala, y
// hasta ahora el cartel de éxito no lo mencionaba. Ver specs/fusion-de-cuentas.spec.md.
const AttendanceMark    = require('../models/AttendanceMark');
const MessageRecipient  = require('../models/MessageRecipient');
const RoomMessage       = require('../models/RoomMessage');
const SoeCase           = require('../models/SoeCase');
// La DECISIÓN de una fusión (cuál se conserva, si la resuelve un botón y por qué no) vive
// afuera y sin base de datos, para poder probarla con objetos: services/fusionCuentas.js +
// tests/unit/fusionCuentas.test.js. Acá queda solo el trabajo con Mongo.
const fusion = require('./fusionCuentas');
// Lo que se le DICE a la persona cuya cuenta apaga una fusión (Fase 1b). Acá solo se escribe.
const avisoFusion      = require('./avisoFusion');
const Message          = require('../models/Message');

// ¿Existe el aviso de RN-13? Mientras fue false (hasta la Fase 1b, 2026-09-16), la acción masiva
// no tocaba las cuentas que alguien usó: apagarlas sin avisar dejaba a esa persona afuera de la
// cuenta por la que venía entrando. Ahora existe y va por dos lados —un mensaje a la cuenta que
// se conserva y el muro del login de la que se apaga—, así que esos grupos entran en el botón.
// El test de fusionCuentas sigue cubriendo los dos estados.
const AVISO_DE_FUSION_LISTO = true;

// Lo que escribe una fusión en la cuenta que apaga: deshabilitada Y marcada con a qué cuenta se
// unificó, en el MISMO update (RN-15). Separado en dos escrituras podría quedar una cuenta
// apagada sin marca, y esa persona volvería a ver "Contactá al administrador".
const apagarPorFusion = (keepId) => ({
  $set: { active: false, mergedInto: new mongoose.Types.ObjectId(String(keepId)), mergedAt: new Date() },
});

// El aviso a la cuenta que se conserva (RN-16): un envío de la mensajería del superadmin, con un
// solo destinatario. Devuelve true si salió.
//
// ⚠️ Se llama DESPUÉS de apagar y marcar, nunca antes. Si esto falla la cuenta queda apagada
// igual y el muro del login le dice al chico con qué correo entrar; al revés, un fallo dejaría
// un mensaje contando algo que no pasó. Por eso NO tira: devuelve false y quien llama lo informa.
async function avisarFusion({ actorId, conservada, correosApagadas, cuentasEnElGrupo }) {
  let envio = null;
  try {
    const { subject, body } = avisoFusion.mensajeDeFusion({
      correoConservada: conservada.email,
      correoApagada:    correosApagadas,
      cuentasEnElGrupo,
    });
    envio = await Message.create({
      subject, body,
      sender: actorId,
      allowReplies: true,   // aprobado: es la vía para decir "esa cuenta no era mía"
      audience: { userIds: [conservada.id] },
      recipientCount: 1,
    });
    await MessageRecipient.create({
      message: envio._id,
      user: conservada.id,
      roleAtSend: conservada.role || null,
      schoolAtSend: conservada.schoolId || null,
    });
    return true;
  } catch (err) {
    // Un envío sin destinatario ensucia el panel de mensajes: se va con su fila, como en
    // routes/messages.js.
    if (envio) await Message.deleteOne({ _id: envio._id }).catch(() => {});
    console.error('[fusion] no se pudo mandar el aviso a', String(conservada.id), '—', err.message);
    return false;
  }
}

// RN-13: una cuenta que alguien usó no se apaga en silencio, y Message.sender es obligatorio.
// Sin saber quién ejecuta, se frena ANTES de mover nada.
function exigirActorParaAvisar(actorId) {
  if (actorId) return;
  const err = new Error('No se puede apagar una cuenta que alguien usó sin avisarle, y para mandar el aviso hace falta saber quién hace la fusión.');
  err.status = 400;
  throw err;
}
// Módulo de Recursos y reservas. Se importan solo para el diagnóstico de abajo; la lógica del
// cupo vive entera en services/recursos/cupo.js, que es el único que lo escribe.
const Recurso      = require('../models/Recurso');
const cupoRecursos = require('./recursos/cupo');

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
// Desde la Fase 1 la implementación vive en services/fusionCuentas.js, que es donde está
// testeada. Se reexporta con este nombre porque lo usan los dos arreglos de DNI duplicado.
const normalizarDni = fusion.normalizarDni;

// Dos cuentas de alumno distintas con el mismo DNI dentro de la misma ESCUELA: siempre es la
// misma persona cargada dos veces (alta manual + importación del padrón, o registro público
// sobre una cuenta que ya existía). El docente la ve duplicada en la lista y en el gradebook,
// y las entregas quedan repartidas entre las dos.
//
// ⭐ HASTA EL 2026-09-12 ESTO AGRUPABA POR DIVISIÓN, y exigía que las dos cuentas estuvieran
// en materias de la MISMA. Medido sobre una copia de producción, así mostraba **3 grupos de
// 59**: en 41 de los 52 pares de alumnos la cuenta sobrante no tiene NINGUNA materia —viene
// del padrón y nunca se matriculó—, con lo cual los casos fáciles eran justo los invisibles.
// Ahora la clave es escuela + DNI, igual que en los docentes, y la división pasa a ser
// información de la ficha en vez de un filtro. Ver specs/fusion-de-cuentas.spec.md (RN-01).
//
// El ALCANCE de la transferencia cambió por el mismo motivo: era "las materias de esa
// división" y ahora es la unión de las materias de todas las cuentas del grupo. Antes, un
// duplicado que cursaba en dos divisiones dejaba sin mover las entregas de la otra.
//
// La DECISIÓN (cuál se conserva, si la puede resolver el botón) no vive acá sino en
// services/fusionCuentas.js, que no toca la base y tiene sus propios tests.
//
// Lo comparten diagnosticar(), aplicar() y fusionarAlumnos(), como en calcularMatriculaParcial().
// Devuelve { grupos: [{ clave, schoolId, dni, materias, cursos, cuentas, sugerida, conservar,
//                       sacar, ambigua, masiva }] }.
async function calcularDniDuplicados() {
  // TODOS los alumnos de la escuela con DNI, no solo los matriculados: las 41 cuentas que
  // este arreglo no veía no están en ningún curso, y ése era exactamente el problema.
  const alumnos = await User.find({ role: 'student', school: { $ne: null } })
    .select('_id name email dni school active lastSeen createdAt').lean();

  const porClave = new Map();
  for (const u of alumnos) {
    const dni = normalizarDni(u.dni);
    if (!dni) continue; // sin DNI no hay con qué comparar (ver 'usuarios-sin-dni')
    const clave = fusion.claveDeGrupo({ schoolId: u.school.toString(), dni });
    if (!porClave.has(clave)) porClave.set(clave, []);
    porClave.get(clave).push(u);
  }

  const candidatos = [...porClave.entries()].filter(([, us]) => us.length > 1);
  if (!candidatos.length) return { grupos: [] };

  const idsCandidatos = candidatos.flatMap(([, us]) => us.map(u => u._id));
  const esCandidato = new Set(idsCandidatos.map(String));

  // Las materias donde figura alguna de las cuentas en juego. Es el alcance de la
  // transferencia y de donde salen los contadores acotados de más abajo.
  const cursos = await Course.find({ students: { $in: idsCandidatos } })
    .select('_id name division school students').lean();

  const materiasDe   = new Map(); // userId → [Course]
  const divisionesDe = new Map(); // userId → Set(divisionId)
  for (const c of cursos) {
    for (const s of new Set((c.students || []).map(String))) {
      if (!esCandidato.has(s)) continue;
      if (!materiasDe.has(s)) materiasDe.set(s, []);
      materiasDe.get(s).push(c);
      if (c.division) {
        if (!divisionesDe.has(s)) divisionesDe.set(s, new Set());
        divisionesDe.get(s).add(c.division.toString());
      }
    }
  }

  const cursoIds = cursos.map(c => c._id);

  // ── Contadores ────────────────────────────────────────────────────────────
  // Un barrido por colección para TODAS las cuentas, nunca uno por cuenta: son pocas cuentas
  // pero miles de documentos.
  //
  // ⚠️ Y cada uno entra por un índice que existe, porque esto corre en CADA carga de
  // /superadmin/otros (diagnosticarTodos llama a todos los arreglos):
  //   · Submission      → { student, createdAt }
  //   · AttendanceMark  → { student, date }
  //   · MessageRecipient→ { user, ... }
  //   · ActivityView    → NO tiene índice por `student` solo; se acota por `activity`, que es
  //     el prefijo del único { activity, student }.
  //   · RoomMessage     → NO tiene índice por `author`, y son 103.159 documentos. Se acota por
  //     `course`, que sí lo tiene ({ course, createdAt }). Contar por autor a secas escanearía
  //     la colección entera cada vez que alguien abre el panel.
  const contarPorUsuario = async (Model, campo, extra = {}) => {
    const filas = await Model.aggregate([
      { $match: { [campo]: { $in: idsCandidatos }, ...extra } },
      { $group: { _id: `$${campo}`, n: { $sum: 1 } } },
    ]);
    return new Map(filas.map(f => [f._id.toString(), f.n]));
  };

  const actividades = cursoIds.length
    ? await Activity.find({ course: { $in: cursoIds } }).select('_id course grades.student').lean()
    : [];
  const actIds = actividades.map(a => a._id);

  const [entregas, asistencias, bandeja, aperturas, sala, comentarios, legajos] = await Promise.all([
    contarPorUsuario(Submission, 'student'),
    contarPorUsuario(AttendanceMark, 'student'),
    contarPorUsuario(MessageRecipient, 'user'),
    actIds.length ? contarPorUsuario(ActivityView, 'student', { activity: { $in: actIds } }) : new Map(),
    cursoIds.length ? contarPorUsuario(RoomMessage, 'author', { course: { $in: cursoIds } }) : new Map(),
    Announcement.aggregate([
      { $match: { 'comments.author': { $in: idsCandidatos } } },
      { $unwind: '$comments' },
      { $match: { 'comments.author': { $in: idsCandidatos } } },
      { $group: { _id: '$comments.author', n: { $sum: 1 } } },
    ]).then(f => new Map(f.map(x => [x._id.toString(), x.n]))),
    // El legajo del SOE va en la ficha porque cambia la decisión: la cuenta que tiene el
    // legajo es la que el gabinete viene siguiendo, y no se puede eliminar (RN-07). Son 3
    // documentos en toda la base, así que contarlos no cuesta nada.
    contarPorUsuario(SoeCase, 'student'),
  ]);

  // Las notas salen de `grades[]`, que no tiene índice propio: se recorren las actividades ya
  // traídas, como hacía la versión anterior.
  const notas = new Map();
  for (const a of actividades) {
    for (const g of (a.grades || [])) {
      const s = g.student?.toString();
      if (s && esCandidato.has(s)) notas.set(s, (notas.get(s) || 0) + 1);
    }
  }

  const divisiones = await Division.find().select('_id name').lean();
  const nombreDivision = new Map(divisiones.map(d => [d._id.toString(), d.name]));
  const escuelas = await School.find().select('_id name').lean();
  const nombreEscuela = new Map(escuelas.map(e => [e._id.toString(), e.name]));

  const g0 = (mapa, id) => mapa.get(id) || 0;

  const grupos = candidatos.map(([clave, us]) => {
    const [schoolId, dni] = clave.split('|');

    const cuentas = us.map(u => {
      const id = u._id.toString();
      const misCursos = materiasDe.get(id) || [];
      const misDivs = [...(divisionesDe.get(id) || [])];
      return {
        u,
        id,
        // La forma que espera services/fusionCuentas.js.
        activa: u.active !== false,
        lastSeen: u.lastSeen || null,
        createdAt: u.createdAt || null,
        materias: misCursos.length,
        divisiones: misDivs,
        trabajo: {
          entregas:    g0(entregas, id),
          notas:       g0(notas, id),
          aperturas:   g0(aperturas, id),
          asistencias: g0(asistencias, id),
          sala:        g0(sala, id),
          comentarios: g0(comentarios, id),
        },
        // Solo para la ficha: no entran en la decisión automática, pero sí en la humana.
        bandeja: g0(bandeja, id),
        legajo: g0(legajos, id),
        cursos: misDivs.map(d => nombreDivision.get(d) || 'otro curso')
          .sort((a, b) => a.localeCompare(b, 'es', { numeric: true })),
      };
    });

    const decision = fusion.clasificarGrupo(cuentas, { avisoDisponible: AVISO_DE_FUSION_LISTO });
    const porId = new Map(cuentas.map(c => [c.id, c]));
    const ordenadas = decision.orden.map(id => porId.get(id));

    // El alcance de la transferencia: la unión de las materias de todas las cuentas del grupo.
    const materias = [...new Map(
      cuentas.flatMap(c => materiasDe.get(c.id) || []).map(m => [m._id.toString(), m])
    ).values()];

    // Los cursos que toca el grupo, para el título de la tarjeta. Puede ser ninguno: las 41
    // cuentas del caso limpio no están en ningún curso, y el título igual tiene que decir algo.
    const cursosDelGrupo = [...new Set(cuentas.flatMap(c => c.cursos))]
      .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));

    return {
      clave,
      schoolId,
      escuela: nombreEscuela.get(schoolId) || 'escuela',
      dni,
      materias,
      cursos: cursosDelGrupo,
      cuentas: ordenadas,
      sugerida: porId.get(decision.sugeridaId),
      ambigua: decision.ambigua,
      masiva: decision.masiva,
      // `conservar` y `sacar` los sigue leyendo el botón masivo; ahora salen de la decisión
      // pura y valen null cuando ese grupo no es resoluble solo.
      conservar: decision.masiva.elegible ? porId.get(decision.masiva.keepId) : null,
      sacar: decision.masiva.elegible
        ? decision.masiva.deshabilitar.map(id => porId.get(id))
        : [],
    };
  });

  grupos.sort((a, b) =>
    // Primero lo que hay que mirar a mano: es lo que de verdad requiere a una persona.
    (Number(b.ambigua) - Number(a.ambigua)) ||
    a.escuela.localeCompare(b.escuela, 'es') ||
    a.dni.localeCompare(b.dni));

  // Los grupos YA RESUELTOS no se devuelven: la sobrante está deshabilitada y sin materias,
  // o sea que la decisión ya la tomó alguien. Mismo criterio que calcularDocentesDuplicados,
  // y por el mismo motivo: si no, el grupo queda reportado para siempre después de resolverlo
  // y el contador del panel miente (medido: 52 grupos, 11 de ellos ya hechos).
  //
  // Consecuencia buscada: fusionar() tampoco los encuentra, y contesta "ese grupo ya no
  // figura como duplicado". Es la respuesta correcta.
  return { grupos: grupos.filter(g => g.masiva.motivo !== fusion.MOTIVOS.YA_RESUELTO) };
}

// Forma presentable de un grupo de alumnos duplicados para la tarjeta interactiva.
//
// El bloque de la vista es UNO SOLO para todos los arreglos interactivos, así que el texto
// de cada cuenta se arma acá y no en el EJS: los números que hay que mirar para elegir no
// son los mismos para un docente (materias a cargo) que para un alumno (entregas y notas).
// Se manda solo lo que la tarjeta pinta — nunca el documento de usuario entero, que viaja
// como JSON al navegador en GET /:id/diagnostico.
// Lo que la tarjeta de una fusión caso por caso anticipa cuando alguna cuenta del grupo tiene uso
// registrado (RN-09: nada se hace sin que la pantalla lo haya dicho). Sin esto, apretar
// "Fusionar" mandaba un mensaje a nombre del superadmin que la tarjeta nunca había mencionado.
const AYUDA_AVISO = 'Si apagás una cuenta que alguien usó, la que se queda recibe un mensaje tuyo con ' +
                    'el correo con el que tiene que entrar, y el login de la apagada se lo dice.';

function presentarGruposAlumnos(grupos) {
  // El motivo por el que un grupo NO lo resuelve el botón, en las palabras de quien tiene que
  // decidir. "No se puede" sin el motivo obliga a la persona a adivinar qué mirar, que es
  // justamente lo que esta pantalla tiene que evitar.
  const PORQUE = {
    [fusion.MOTIVOS.DISPUTADA]:
      'Las dos cuentas tienen trabajo propio: esta la resolvés vos, mirando qué hay en cada una.',
    [fusion.MOTIVOS.SOBRANTE_CURSA]:
      'La cuenta que sobraría está cursando materias: deshabilitarla le sacaría ese acceso, así que va a mano.',
    [fusion.MOTIVOS.NECESITA_AVISO]:
      'Alguien usó la cuenta que sobraría (tiene conexiones registradas). No se apaga sin avisarle por la otra cuenta.',
    [fusion.MOTIVOS.SIN_DATOS]:
      'Ninguna de las dos tiene datos propios: no hay con qué deducir cuál es la real.',
    [fusion.MOTIVOS.YA_RESUELTO]:
      'Ya está resuelto: la cuenta sobrante está deshabilitada y sin materias.',
  };

  return grupos.map(g => {
    const sugeridaId = g.sugerida.id;
    // Puede no haber ningún curso: son las 41 cuentas del caso limpio, que no están
    // matriculadas en nada. El título tiene que decir algo igual.
    const donde = g.cursos.length ? g.cursos.join(', ') : 'sin curso';

    return {
      clave: g.clave,
      dni: g.dni,
      curso: donde,
      cursos: g.cursos,
      ambigua: g.ambigua,
      // Lo que la tarjeta necesita para no ofrecer un botón que no va a hacer nada.
      resolubleSola: g.masiva.elegible,
      motivo: g.masiva.motivo,
      icono: 'group',
      titulo: `DNI ${g.dni} · ${donde}`,
      ayuda: 'Elegí la cuenta que se queda: la otra le pasa sus entregas, sus notas, sus acuses '
           + 'de lectura y las materias donde figuraba.'
           + (g.cuentas.some(c => c.u.lastSeen) ? ' ' + AYUDA_AVISO : ''),
      aviso: g.masiva.elegible ? null : PORQUE[g.masiva.motivo] || null,
      sugeridaId,
      cuentas: g.cuentas.map(c => {
        const t = c.trabajo;
        return {
          id: c.id,
          nombre: c.u.name,
          email: c.u.email,
          entregas: t.entregas,
          notas: t.notas,
          materiasEn: c.materias,
          activa: c.activa,
          otrosCursos: c.cursos,
          // ⭐ CA-02 y CA-03: los números que hacen falta para elegir, incluidos los de las
          // colecciones que la fusión TODAVÍA no mueve. Mostrarlos sin decir eso sería peor
          // que no mostrarlos: parecería que se transfieren.
          detalle: [
            `${t.entregas} entrega(s)`,
            `${t.notas} nota(s)`,
            `${t.aperturas} apertura(s)`,
            c.materias ? `en ${c.materias} materia(s)` : 'sin materias',
            c.u.lastSeen
              ? 'último acceso ' + live.fechaCorta(c.u.lastSeen)
              : 'nunca se conectó',
            c.cursos.length ? 'cursa en ' + c.cursos.join(', ') : null,
          ].filter(Boolean).join(' · '),
          noSeTransfiere: [
            t.asistencias ? `${t.asistencias} asistencia(s)`      : null,
            c.bandeja     ? `${c.bandeja} mensaje(s) en bandeja`  : null,
            t.sala        ? `${t.sala} mensaje(s) de sala`        : null,
          ].filter(Boolean).join(' · '),
          chips: [
            c.id === sugeridaId  ? { tipo: 'sugerida', texto: 'sugerida' }             : null,
            !c.activa            ? { tipo: 'inactiva', texto: 'deshabilitada' }        : null,
            fusion.tieneTrabajoPropio(c) ? { tipo: 'datos', texto: 'con datos propios' } : null,
            // La diferencia que más importa al elegir: una cuenta sin materias no es la que
            // usa el chico, y una que sí las tiene no se puede apagar sin consecuencias.
            !c.materias          ? { tipo: 'inactiva', texto: 'sin materias' }         : null,
            c.u.lastSeen && !c.materias ? { tipo: 'inactiva', texto: 'pero se conectó' } : null,
            // El legajo del SOE cambia la decisión: es la cuenta que el gabinete sigue, y no
            // se puede eliminar (RN-07). Va como chip y no en el detalle para que no se pase
            // de largo leyendo una fila de números.
            c.legajo ? { tipo: 'datos', texto: 'con legajo del SOE' } : null,
          ].filter(Boolean),
        };
      }),
      // 'sacar' solo aparece si la cuenta que va a sobrar ESTÁ en algún curso, y entonces va
      // primera: ahí deshabilitar es lo que rompe algo.
      //
      // ⚠️ La condición mira las cuentas SOBRANTES, no todas. Mirar todas era un error que se
      // vio en la primera corrida contra datos reales: en el caso limpio la cuenta que se
      // conserva tiene 14 materias, así que "solo se saca de los cursos" salía primera y
      // preseleccionada... para una cuenta que no está en ningún curso. O sea que la opción
      // por omisión no hacía nada.
      opcionesSobrante: (g.cuentas.some(c => c.id !== sugeridaId && c.materias)
        ? [
            { value: 'sacar',        label: 'solo se saca de los cursos (la cuenta queda activa)' },
            { value: 'deshabilitar', label: 'se deshabilita (se puede revertir)' },
            { value: 'eliminar',     label: 'se elimina' },
          ]
        : [
            { value: 'deshabilitar', label: 'se deshabilita (se puede revertir)' },
            { value: 'eliminar',     label: 'se elimina' },
          ]),
    };
  });
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

// Los mismos grupos con lo que la tarjeta interactiva necesita para pintarse (ver
// presentarGruposAlumnos). Se AGREGA sobre lo que ya había: los campos crudos (titular,
// suplente, actividades…) siguen viajando porque son los que mira el smoke test.
function presentarGruposDocentes(grupos) {
  return grupos.map(g => ({
    ...g,
    icono: 'badge',
    titulo: `DNI ${g.dni} · ${g.escuela}`,
    ayuda: 'Elegí la cuenta que se queda: la otra le transfiere todo lo que tiene a cargo.'
         + (g.cuentas.some(c => c.ultimoAcceso) ? ' ' + AYUDA_AVISO : ''),
    aviso: null,
    cuentas: g.cuentas.map(c => ({
      ...c,
      detalle: [
        `${c.titular} materia(s) como titular`,
        `${c.suplente} como suplente`,
        `${c.actividades} actividad(es)`,
        `${c.novedades} novedad(es)`,
        c.ultimoAcceso
          ? 'último acceso ' + live.fechaCorta(c.ultimoAcceso)
          : 'nunca se conectó',
      ].join(' · '),
      chips: [
        c.id === g.sugeridaId    ? { tipo: 'sugerida', texto: 'sugerida' }      : null,
        !c.activa                ? { tipo: 'inactiva', texto: 'deshabilitada' } : null,
        (c.titular || c.suplente)? { tipo: 'datos',    texto: 'con materias' }  : null,
      ].filter(Boolean),
    })),
    opcionesSobrante: [
      { value: 'deshabilitar', label: 'se deshabilita (se puede revertir)' },
      { value: 'eliminar',     label: 'se elimina' },
    ],
  }));
}

// Deja a la cuenta conservada con el correo elegido, que puede ser el de otra cuenta del
// grupo. Va SIEMPRE al final de una fusión porque `User.email` es único global: para que la
// conservada se quede con el correo de la otra, ese correo tiene que estar libre primero.
//
//   - Si la cuenta que lo cede se eliminó, ya quedó libre y alcanza con asignarlo.
//   - Si sigue viva (deshabilitada, o simplemente sacada del curso), se INTERCAMBIAN: la
//     conservada toma el correo elegido y la otra se queda con el que soltó. Nadie pierde un
//     correo válido, no se inventa ninguno y se puede revertir haciendo el camino inverso.
//
// El intercambio pasa por un correo temporal porque el índice único no admite que las dos
// tengan el mismo valor ni por un instante. Si el proceso se cortara entre medio, la cuenta
// que cede queda con ese temporal —se ve a simple vista y se arregla desde el panel de
// administración—; la conservada nunca queda sin correo.
// ⚠️ Cada $set pasa por User.camposDeContacto() y no escribe `email` a secas: mover un correo
// de una cuenta a otra BORRA su verificación en las dos. Es la regla de oro de models/User.js, y
// éste es el lugar donde más silenciosamente se rompería — la marca verde de la cuenta que cede
// el correo terminaría certificando un correo que ya no es suyo.
async function pasarCorreo({ keepId, correoConservada, donanteId, correoDonante, donanteEliminado }) {
  const contacto = (email) => ({ $set: User.camposDeContacto({ email }) });
  if (donanteEliminado) {
    await User.updateOne({ _id: keepId }, contacto(correoDonante));
    return;
  }
  const temporal = `fusion-en-curso-${donanteId}@invalido.local`;
  await User.updateOne({ _id: donanteId }, contacto(temporal));
  await User.updateOne({ _id: keepId },    contacto(correoDonante));
  await User.updateOne({ _id: donanteId }, contacto(correoConservada));
}

// Pasa TODO lo que una cuenta de docente tiene a cargo a la cuenta que se conserva, y deja
// la sobrante deshabilitada o eliminada. Devuelve el detalle de lo movido.
//
// El orden importa: primero se transfiere y recién al final se toca la cuenta sobrante. Si
// algo falla en el medio, lo peor que queda es una transferencia parcial con las dos cuentas
// todavía vivas — nunca una cuenta borrada con materias apuntando a ella (que es exactamente
// el bug de las referencias colgadas que rompía /admin/courses).
async function fusionarDocentes({ clave, keepId, sobrante = 'deshabilitar', emailId = null, actorId = null }) {
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

  // Las sobrantes que alguien usó y que ESTA fusión apaga reciben aviso (RN-16). Una que ya
  // estaba apagada de antes se marca igual (queda unida a la conservada), pero no genera un
  // mensaje que diga "quedó deshabilitada" por algo que esta acción no hizo. Se chequea acá,
  // antes de transferir nada, que haya a nombre de quién mandarlo.
  const usadas = perdedor.filter(c => c.ultimoAcceso && c.activa);
  if (usadas.length) exigirActorParaAvisar(actorId);

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
    // Apagada Y marcada en el mismo update (RN-15): el login le dice con qué correo entrar.
    await User.updateMany({ _id: { $in: perdedorIds } }, apagarPorFusion(keepId));
  }

  // 6. El correo, siempre al final (ver pasarCorreo: el índice único obliga a liberarlo antes).
  const cuentaConservada = grupo.cuentas.find(c => c.id === keepId);
  const correoFinal = grupo.cuentas.find(c => c.id === correoDe).email;
  const correoCambiado = correoDe !== keepId;

  if (correoCambiado) {
    await pasarCorreo({
      keepId:           keep,
      correoConservada: cuentaConservada.email,
      donanteId:        correoDe, // siempre una de las sobrantes
      correoDonante:    correoFinal,
      donanteEliminado: accion === 'eliminar',
    });
  }

  const correo = {
    final: correoFinal,
    cambiado: correoCambiado,
    anterior: cuentaConservada.email,
    // Solo cuando la sobrante sigue viva: se quedó con el correo que soltó la conservada.
    intercambiadoCon: correoCambiado && accion !== 'eliminar' ? cuentaConservada.email : null,
  };

  // 7. El aviso, después del correo: tiene que nombrar los correos como QUEDARON (RN-16).
  const avisado = (accion === 'deshabilitar' && usadas.length)
    ? await avisarFusion({
        actorId,
        conservada: { id: keep, email: correoFinal, role: 'teacher', schoolId: grupo.schoolId },
        correosApagadas: usadas.map(c => correoQueQuedo(c.id, c.email, correo, correoDe)),
        cuentasEnElGrupo: grupo.cuentas.length,
      })
    : null;

  const movido = [
    resumen.titular     ? `${resumen.titular} materia(s) como titular` : null,
    resumen.suplente    ? `${resumen.suplente} como suplente`          : null,
    resumen.actividades ? `${resumen.actividades} actividad(es)`       : null,
    resumen.novedades   ? `${resumen.novedades} novedad(es)`           : null,
    resumen.comentarios ? `${resumen.comentarios} novedad(es) con comentarios suyos` : null,
    resumen.matriculas  ? `${resumen.matriculas} matrícula(s) sueltas quitadas`      : null,
  ].filter(Boolean);

  return {
    resumen,
    accion,
    schoolId: grupo.schoolId,
    conservada: cuentaConservada,
    sobrantes: perdedor,
    correo,
    auditoria: {
      materias_titular:  resumen.titular,
      materias_suplente: resumen.suplente,
      actividades:       resumen.actividades,
      novedades:         resumen.novedades,
      ...(avisado === null ? {} : { aviso: avisado ? 'enviado' : 'fallido' }),
    },
    mensaje:
      `Listo: ${cuentaConservada.nombre} (${correoFinal}) se queda con todo. ` +
      (movido.length ? `Se transfirió: ${movido.join(', ')}. ` : 'No había nada que transferir. ') +
      textoCorreo(correo) +
      (accion === 'eliminar'
        ? 'La cuenta sobrante se eliminó.'
        : 'La cuenta sobrante quedó deshabilitada' +
          (sobrante === 'eliminar'
            ? ' (no se pudo eliminar: tiene entregas propias, borrarla dejaría esas entregas sin dueño).'
            : '.')) +
      (avisado === null ? '' : ' ' + textoAviso(avisado)),
  };
}

// El párrafo del correo dentro del mensaje final de una fusión. Es idéntico para docentes y
// para alumnos, y es la parte que la persona vuelve a leer para chequear que no se le fue
// el correo institucional a la cuenta equivocada.
function textoCorreo(correo) {
  if (!correo.cambiado) return '';
  return `El correo pasó de ${correo.anterior} a ${correo.final}` +
    (correo.intercambiadoCon ? ` (la otra cuenta se quedó con ${correo.intercambiadoCon}). ` : '. ');
}

// El correo con el que quedó una cuenta sobrante después de la fusión. Si fue la que le prestó
// el correo a la conservada, ahora tiene el que la conservada soltó; si no, el suyo. Es el que
// el aviso tiene que nombrar: el chico lo va a reconocer como "la otra", y es el que la cuenta
// apagada tiene hoy.
function correoQueQuedo(id, correoOriginal, correo, correoDe) {
  return (correo.intercambiadoCon && String(id) === String(correoDe)) ? correo.intercambiadoCon : correoOriginal;
}

// El renglón del aviso en el cartel de una fusión. `avisado` es null cuando no hacía falta
// (nadie había usado la cuenta apagada).
function textoAviso(avisado) {
  if (avisado === null) return '';
  return avisado
    ? 'Alguien había usado la cuenta que se apagó: la que queda recibió un mensaje con el correo con el que tiene que entrar, y el login de la apagada se lo dice.'
    : 'Alguien había usado la cuenta que se apagó, y NO se pudo mandarle el mensaje a la que queda. El login de la apagada igual le dice con qué correo entrar.';
}

// Fusiona dos (o más) cuentas de ALUMNO que son la misma persona dentro de un curso.
//
// La diferencia con los docentes no es el mecanismo sino qué se transfiere: un alumno no
// tiene materias a cargo, tiene entregas, notas, acuses de lectura y su matrícula. Y una
// diferencia que sí importa: entregas, notas y acuses tienen un índice único por
// {actividad, alumno}, así que si las DOS cuentas entregaron la misma tarea no se pueden
// juntar. En ese caso lo de la cuenta sobrante se deja donde está y se informa: pisarlo
// sería borrar una entrega real de un alumno.
//
// El orden es el mismo que en fusionarDocentes y por la misma razón: primero se transfiere,
// después se toca la cuenta sobrante, y el correo al final. Si algo falla en el medio lo
// peor que queda es una transferencia parcial con las dos cuentas todavía vivas.
async function fusionarAlumnos({ clave, keepId, sobrante = 'deshabilitar', emailId = null, actorId = null }) {
  const { grupos } = await calcularDniDuplicados();
  const grupo = grupos.find(g => g.clave === clave);
  if (!grupo) {
    throw new Error('Ese grupo ya no figura como duplicado (puede que alguien lo haya resuelto recién). Actualizá la página.');
  }

  const idDe = c => c.u._id.toString();
  const conservada = grupo.cuentas.find(c => idDe(c) === keepId);
  if (!conservada) throw new Error('La cuenta elegida no pertenece a este grupo.');
  if (!['sacar', 'deshabilitar', 'eliminar'].includes(sobrante)) {
    throw new Error('Qué hacer con la cuenta sobrante solo puede ser "sacar", "deshabilitar" o "eliminar".');
  }
  // Con qué correo queda la cuenta conservada. Es una decisión aparte, igual que en los
  // docentes: lo habitual es quedarse con la cuenta que tiene las entregas pero con el
  // correo institucional, que está en la otra.
  const correoDe = emailId || keepId;
  const donante = grupo.cuentas.find(c => idDe(c) === correoDe);
  if (!donante) throw new Error('El correo elegido no pertenece a ninguna cuenta de este grupo.');

  const keep        = new mongoose.Types.ObjectId(keepId);
  const perdedores  = grupo.cuentas.filter(c => idDe(c) !== keepId);
  const perdedorIds = perdedores.map(c => c.u._id);
  const perdedorSet = new Set(perdedores.map(idDe));
  const materiaIds  = grupo.materias.map(m => m._id);

  // Las sobrantes que alguien usó y que ESTA fusión apaga reciben aviso (RN-16). Una que ya
  // estaba apagada de antes se marca igual, pero no genera mensaje. `sacar` no apaga, así que
  // no hay nada que avisar; con 'eliminar' puede terminar apagando (si tiene entregas o legajo),
  // y eso se sabe recién al final, así que también exige saber quién hace la fusión. Se chequea
  // acá, antes de transferir nada.
  const usadas = perdedores.filter(c => c.u.lastSeen && c.u.active !== false);
  if (usadas.length && sobrante !== 'sacar') exigirActorParaAvisar(actorId);

  const resumen = {
    materias: 0, entregas: 0, notas: 0, aperturas: 0,
    comentarios: 0, sugerencias: 0, conflictos: 0, desmatriculadas: 0,
  };

  // 1. Las materias del curso donde figuraba SOLO la cuenta sobrante pasan a la conservada:
  //    si no, al sacar la otra el alumno perdería el acceso a esas materias.
  //
  //    Se HEREDA la fecha de inscripción de la cuenta sobrante en vez de poner "ahora":
  //    routes/activities.js la usa para no mostrarle las tareas que vencieron antes de su
  //    alta, así que con la fecha de hoy le desaparecerían de la vista las tareas viejas del
  //    curso, incluidas las que esa misma persona ya entregó. Si la sobrante no tenía fecha
  //    (las altas viejas no la llevan y se leen como "siempre estuvo"), tampoco se le pone
  //    una a la conservada: es exactamente el mismo significado.
  const materiasFrescas = await Course.find({ _id: { $in: materiaIds } })
    .select('_id students enrollmentDates').lean();
  for (const mat of materiasFrescas) {
    const enMateria = (mat.students || []).map(s => s.toString());
    if (enMateria.includes(keepId)) continue;
    const desdeLaOtra = perdedores.map(idDe).find(id => enMateria.includes(id));
    if (!desdeLaOtra) continue;
    const heredada = (mat.enrollmentDates || {})[desdeLaOtra];
    await Course.updateOne({ _id: mat._id }, {
      $addToSet: { students: keep },
      ...(heredada ? { $set: { [`enrollmentDates.${keepId}`]: heredada } } : {}),
    });
    resumen.materias++;
  }

  const actividades = await Activity.find({ course: { $in: materiaIds } })
    .select('_id grades').lean();
  const actIds = actividades.map(a => a._id);

  if (actIds.length) {
    // 2. Entregas. El índice único { activity, student } no admite dos entregas del mismo
    //    alumno en la misma actividad: las que chocan se quedan en la cuenta sobrante.
    const yaEntregadas = new Set(
      (await Submission.find({ activity: { $in: actIds }, student: keep }).select('activity').lean())
        .map(s => s.activity.toString())
    );
    const entregasSobrantes = await Submission.find({
      activity: { $in: actIds }, student: { $in: perdedorIds },
    }).select('_id activity').lean();
    // Se descartan las que chocan con una entrega de la conservada Y, si el duplicado es de
    // tres cuentas, las que chocarían entre ellas: solo una puede quedarse con la actividad.
    const tomadas = new Set(yaEntregadas);
    const moverEntregas = [];
    for (const s of entregasSobrantes) {
      const k = s.activity.toString();
      if (tomadas.has(k)) { resumen.conflictos++; continue; }
      tomadas.add(k);
      moverEntregas.push(s._id);
    }
    if (moverEntregas.length) {
      resumen.entregas = (await Submission.updateMany(
        { _id: { $in: moverEntregas } }, { $set: { student: keep } })).modifiedCount;
    }

    // 3. Notas. grades[] tiene como máximo una entrada por alumno y actividad, así que rige
    //    el mismo criterio: si la conservada ya tiene nota ahí, la de la otra no se toca.
    const ops = [];
    for (const a of actividades) {
      const suyas = (a.grades || []).filter(g => perdedorSet.has(g.student?.toString()));
      if (!suyas.length) continue;
      if ((a.grades || []).some(g => g.student?.toString() === keepId)) {
        resumen.conflictos += suyas.length;
        continue;
      }
      // Tres cuentas duplicadas con nota en la misma actividad: solo la primera puede pasar,
      // el resto chocaría contra la que acaba de pasar.
      resumen.conflictos += suyas.length - 1;
      ops.push({
        updateOne: {
          filter: { _id: a._id },
          update: { $set: { 'grades.$[g].student': keep } },
          arrayFilters: [{ 'g.student': suyas[0].student }],
        },
      });
      resumen.notas++;
    }
    if (ops.length) await Activity.bulkWrite(ops, { ordered: false });

    // 4. Acuses de lectura: mismo índice único, mismo criterio.
    const yaVistas = new Set(
      (await ActivityView.find({ activity: { $in: actIds }, student: keep }).select('activity').lean())
        .map(v => v.activity.toString())
    );
    const vistasSobrantes = await ActivityView.find({
      activity: { $in: actIds }, student: { $in: perdedorIds },
    }).select('_id activity').lean();
    const vistasTomadas = new Set(yaVistas);
    const moverVistas = [];
    for (const v of vistasSobrantes) {
      const k = v.activity.toString();
      if (vistasTomadas.has(k)) continue; // el acuse ya está registrado para la conservada
      vistasTomadas.add(k);
      moverVistas.push(v._id);
    }
    if (moverVistas.length) {
      resumen.aperturas = (await ActivityView.updateMany(
        { _id: { $in: moverVistas } }, { $set: { student: keep } })).modifiedCount;
    }
  }

  // 5. Comentarios en novedades y sugerencias enviadas. No tienen unicidad, van todos: sin
  //    esto, borrar la cuenta sobrante dejaría referencias colgadas a un usuario inexistente.
  resumen.comentarios = (await Announcement.updateMany(
    { 'comments.author': { $in: perdedorIds } },
    { $set: { 'comments.$[c].author': keep } },
    { arrayFilters: [{ 'c.author': { $in: perdedorIds } }] },
  )).modifiedCount;
  resumen.sugerencias = (await Suggestion.updateMany(
    { user: { $in: perdedorIds } }, { $set: { user: keep } })).modifiedCount;

  // 6. Se saca a la sobrante de las materias de ESTE curso. Si además se la va a eliminar,
  //    de todas: una cuenta borrada dentro de students[] es una referencia colgada, que es
  //    justo lo que rompía /admin/courses.
  const alcance = sobrante === 'eliminar' ? {} : { _id: { $in: materiaIds } };
  resumen.desmatriculadas = (await Course.updateMany(
    { ...alcance, students: { $in: perdedorIds } },
    {
      $pull:  { students: { $in: perdedorIds } },
      // Sin esto quedaría una fecha de inscripción huérfana en el Map, que volvería a
      // aplicarse si alguna vez se rematricula a esa cuenta.
      $unset: Object.fromEntries(perdedores.map(c => [`enrollmentDates.${idDe(c)}`, ''])),
    },
  )).modifiedCount;

  // 7. Recién ahora la cuenta sobrante. Si le quedaron entregas (las que chocaron, o las de
  //    otro curso) no se borra aunque lo pidan: borrarla dejaría `Submission.student` colgado.
  //
  //    Y tampoco si tiene legajo del SOE, por dos motivos distintos: `SoeCase.student` es
  //    `required` y no se borra en cascada, así que el legajo quedaría sin dueño —imposible de
  //    abrir o cerrar—, y ese legajo es lo más irreemplazable del sistema. Hay que cerrarlo
  //    desde /soe antes. Mismo criterio que POST /admin/users/:id/delete.
  const conEntregas = await Submission.countDocuments({ student: { $in: perdedorIds } });
  const conLegajo   = await SoeCase.countDocuments({ student: { $in: perdedorIds } });
  const noSeBorra   = conEntregas > 0 || conLegajo > 0;
  const accion = (sobrante === 'eliminar' && noSeBorra) ? 'deshabilitar' : sobrante;
  if (accion === 'eliminar') {
    // Los acuses de lectura que quedaron (los que chocaron) se van con la cuenta: son un
    // contador de "quién abrió la tarea", no un dato del alumno que valga conservar suelto.
    await ActivityView.deleteMany({ student: { $in: perdedorIds } });
    await User.deleteMany({ _id: { $in: perdedorIds } });
  } else if (accion === 'deshabilitar') {
    // Apagada Y marcada en el mismo update (RN-15): el login le dice con qué correo entrar.
    await User.updateMany({ _id: { $in: perdedorIds } }, apagarPorFusion(keepId));
  }

  // 8. El correo, al final (ver pasarCorreo).
  const correoFinal = donante.u.email;
  const correoCambiado = correoDe !== keepId;
  if (correoCambiado) {
    await pasarCorreo({
      keepId:           keep,
      correoConservada: conservada.u.email,
      donanteId:        correoDe,
      correoDonante:    correoFinal,
      donanteEliminado: accion === 'eliminar',
    });
  }

  const correo = {
    final: correoFinal,
    cambiado: correoCambiado,
    anterior: conservada.u.email,
    intercambiadoCon: correoCambiado && accion !== 'eliminar' ? conservada.u.email : null,
  };

  // 9. El aviso, después del correo: tiene que nombrar los correos como QUEDARON (RN-16).
  const avisado = (accion === 'deshabilitar' && usadas.length)
    ? await avisarFusion({
        actorId,
        conservada: { id: keep, email: correoFinal, role: 'student', schoolId: grupo.schoolId },
        correosApagadas: usadas.map(c => correoQueQuedo(idDe(c), c.u.email, correo, correoDe)),
        cuentasEnElGrupo: grupo.cuentas.length,
      })
    : null;

  const movido = [
    resumen.entregas    ? `${resumen.entregas} entrega(s)`               : null,
    resumen.notas       ? `${resumen.notas} nota(s)`                     : null,
    resumen.aperturas   ? `${resumen.aperturas} acuse(s) de lectura`     : null,
    resumen.materias    ? `${resumen.materias} materia(s) del curso`     : null,
    resumen.comentarios ? `${resumen.comentarios} novedad(es) con comentarios suyos` : null,
    resumen.sugerencias ? `${resumen.sugerencias} sugerencia(s)`         : null,
  ].filter(Boolean);

  const destino = {
    sacar:        'La otra cuenta quedó fuera del curso, pero sigue activa: si no la usa nadie, conviene deshabilitarla desde el panel de administración.',
    deshabilitar: 'La otra cuenta quedó deshabilitada' +
      (sobrante === 'eliminar'
        ? ' (no se pudo eliminar: ' + (conLegajo
            ? 'tiene un legajo del SOE, que quedaría sin dueño. Cerralo desde /soe primero'
            : 'le quedan entregas propias, borrarla las dejaría sin dueño') + ').'
        : '.'),
    eliminar:     'La otra cuenta se eliminó.',
  }[accion];

  // Lo que la fusión NO mueve y queda en la cuenta sobrante. Se cuenta DESPUÉS de todo, así
  // que es el estado final y no una estimación.
  //
  // ⭐ Por qué se informa en vez de moverse: cada una necesita su propia regla de choque y no
  // la de las entregas. En asistencia, las dos cuentas tienen marca en la MISMA toma (la
  // melliza junta un `ausente` con source 'cierre', que no decidió nadie), así que fusionar no
  // es mover sino elegir una y borrar la otra — al revés de una entrega, donde no se destruye
  // nada. Y la bandeja choca contra su índice único { message, user } en 51 de 52 grupos
  // medidos, porque los envíos van por rol y las dos mellizas recibieron el mismo mensaje.
  // Mientras esa decisión no esté tomada, el cartel al menos deja de ocultar el hueco.
  const [quedaAsistencias, quedaBandeja, quedaSala] = await Promise.all([
    AttendanceMark.countDocuments({ student: { $in: perdedorIds } }),
    MessageRecipient.countDocuments({ user: { $in: perdedorIds } }),
    RoomMessage.countDocuments({ author: { $in: perdedorIds } }),
  ]);
  const atras = [
    quedaAsistencias ? `${quedaAsistencias} marca(s) de asistencia` : null,
    quedaBandeja     ? `${quedaBandeja} mensaje(s) en su bandeja`   : null,
    quedaSala        ? `${quedaSala} mensaje(s) de sala`            : null,
  ].filter(Boolean);
  // Con 'eliminar' la cuenta ya no existe, así que esos documentos no "siguen en la otra
  // cuenta": quedaron sin dueño. Los de asistencia y sala se siguen leyendo igual porque
  // guardan el nombre como snapshot; la fila de la bandeja aparece como "Usuario eliminado".
  const textoAtras = !atras.length ? ''
    : accion === 'eliminar'
      ? `Quedó sin dueño, porque la fusión todavía no lo mueve: ${atras.join(', ')}. `
      : `Sigue en la otra cuenta, porque la fusión todavía no lo mueve: ${atras.join(', ')}. `;

  return {
    resumen,
    accion,
    schoolId: grupo.schoolId,
    conservada: { id: keepId, nombre: conservada.u.name, email: correoFinal },
    sobrantes: perdedores.map(c => ({ id: idDe(c), nombre: c.u.name, email: c.u.email })),
    correo,
    // Lo que NO se movió va al evento de auditoría además del cartel: dentro de seis meses,
    // "a este chico le falta media asistencia" se contesta mirando acá.
    auditoria: {
      // Desde la Fase 1 un grupo puede abarcar varias divisiones, o ninguna: el duplicado se
      // busca por escuela + DNI y no por curso.
      curso:       grupo.cursos.length ? grupo.cursos.join(', ') : 'sin curso',
      entregas:    resumen.entregas,
      notas:       resumen.notas,
      materias:    resumen.materias,
      conflictos:  resumen.conflictos,
      sin_mover_asistencias: quedaAsistencias,
      sin_mover_bandeja:     quedaBandeja,
      sin_mover_sala:        quedaSala,
      ...(avisado === null ? {} : { aviso: avisado ? 'enviado' : 'fallido' }),
    },
    mensaje:
      `Listo: ${conservada.u.name} (${correoFinal}) se queda con ` +
      (grupo.cursos.length ? `el curso ${grupo.cursos.join(', ')}` : 'la cuenta') + '. ' +
      (movido.length ? `Se transfirió: ${movido.join(', ')}. ` : 'No había nada que transferir. ') +
      (resumen.conflictos
        ? `${resumen.conflictos} entrega(s) o nota(s) se quedaron en la otra cuenta porque la ` +
          'conservada ya tenía la suya en esa misma actividad: revisalas antes de dar de baja la cuenta. '
        : '') +
      textoAtras +
      textoCorreo(correo) +
      destino +
      (avisado === null ? '' : ' ' + textoAviso(avisado)),
  };
}

/* ─── Alta masiva de materias ──────────────────────────────────────────────
   Todo lo de acá abajo es del arreglo 'alta-masiva-materias'. Recordar el vocabulario
   del modelo, que va al revés del de la escuela:
     Division = el "curso" de la escuela (1°1°, 2°3°)
     Course   = la MATERIA dictada dentro de ese curso, con su docente y su aula
   Así que "meter un grupo de materias en un grupo de cursos" es crear un Course por cada
   par (Division elegida × materia escrita), salteando los que ya existen.            */

// Un dato mal cargado no es una falla del servidor: la ruta usa este `status` para
// devolver 400 con el mensaje tal cual, en vez de un 500 genérico.
function errorDeCarga(mensaje) {
  const err = new Error(mensaje);
  err.status = 400;
  return err;
}

// Nombre normalizado para decidir SI LA MATERIA YA EXISTE en el curso: sin tildes, sin
// mayúsculas y con los espacios colapsados. Comparar el string crudo haría que
// "Educación Física" y "Educacion fisica" convivan como dos materias distintas en el
// mismo curso — justo el duplicado que hubo que consolidar a mano.
function claveMateria(nombre) {
  return String(nombre || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Todo lo que el formulario necesita para pintarse. Los cursos y los docentes se mandan
// con su escuela: la vista filtra por la escuela elegida sin volver al servidor.
async function opcionesAltaMasiva() {
  const [escuelas, divisiones, docentes, usadas, catalogo, porDivision] = await Promise.all([
    School.find().sort({ name: 1 }).select('_id name').lean(),
    Division.find().sort({ name: 1 }).select('_id name school').lean(),
    // `$ne: false` y no `true`: las cuentas viejas pueden no tener el campo.
    User.find({ role: 'teacher', active: { $ne: false } }).sort({ name: 1 }).select('_id name email school').lean(),
    Course.distinct('name'),
    Subject.find().select('name').lean(),
    Course.aggregate([{ $group: { _id: '$division', n: { $sum: 1 } } }]),
  ]);

  const cuantasMaterias = Object.fromEntries(porDivision.map(d => [String(d._id), d.n]));

  // Sugerencias del campo "nombre": las materias que ya se dictan MÁS el catálogo de
  // Subject (el mismo datalist que ofrece el alta de a una). Escribir el nombre igual que
  // el que ya está en uso es lo que evita duplicados nuevos.
  const nombres = [...new Set(
    [...usadas, ...catalogo.map(s => s.name)].map(n => String(n || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'es'));

  return {
    escuelas: escuelas.map(e => ({ id: String(e._id), nombre: e.name })),
    cursos: divisiones.map(d => ({
      id: String(d._id),
      nombre: d.name,
      escuela: String(d.school || ''),
      materias: cuantasMaterias[String(d._id)] || 0,
    })),
    docentes: docentes.map(t => ({
      id: String(t._id), nombre: t.name, email: t.email, escuela: String(t.school || ''),
    })),
    nombres,
  };
}

// Valida lo cargado y arma el plan: qué se crea en cada curso y qué ya estaba.
// Lo comparten previsualizar() y aplicar() — el plan se recalcula contra la base en el
// momento de aplicar, así que una pestaña vieja no puede crear sobre un estado que cambió.
async function planearAltaMasiva({ divisionIds, materias } = {}) {
  const ids = [...new Set((Array.isArray(divisionIds) ? divisionIds : []).map(String).filter(Boolean))];
  if (!ids.length) throw errorDeCarga('Elegí al menos un curso.');
  if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    throw errorDeCarga('Hay un curso inválido en la selección. Recargá la página.');
  }

  const divisiones = await Division.find({ _id: { $in: ids } }).select('_id name school').lean();
  if (divisiones.length !== ids.length) {
    throw errorDeCarga('Alguno de los cursos elegidos ya no existe. Recargá la página.');
  }

  // Una tanda va toda a la misma escuela: el docente y la materia se validan contra ella.
  const escuelas = new Set(divisiones.map(d => String(d.school || '')));
  if (escuelas.size > 1) throw errorDeCarga('Los cursos elegidos son de escuelas distintas: hacé una tanda por escuela.');
  const schoolId = divisiones[0].school;
  if (!schoolId) throw errorDeCarga('Los cursos elegidos no tienen escuela asignada.');

  // Filas del todo vacías = alguien agregó una fila y no la usó; se ignoran en silencio.
  // Una fila a medio llenar, en cambio, es un error que hay que avisar.
  const filas = (Array.isArray(materias) ? materias : [])
    .map(m => ({
      nombre:    String(m?.nombre    || '').replace(/\s+/g, ' ').trim(),
      docenteId: String(m?.docenteId || '').trim(),
      aula:      String(m?.aula      || '').trim(),
    }))
    .filter(m => m.nombre || m.docenteId || m.aula);

  if (!filas.length) throw errorDeCarga('No cargaste ninguna materia.');

  const sinNombre = filas.find(m => !m.nombre);
  if (sinNombre) throw errorDeCarga('Hay una materia sin nombre.');
  const sinDocente = filas.find(m => !m.docenteId);
  if (sinDocente) throw errorDeCarga(`Falta elegir quién está a cargo de "${sinDocente.nombre}".`);

  // Dos filas con el mismo nombre crearían la materia duplicada en cada curso de la tanda.
  const vistas = new Set();
  for (const m of filas) {
    const clave = claveMateria(m.nombre);
    if (vistas.has(clave)) throw errorDeCarga(`"${m.nombre}" está cargada dos veces en la lista.`);
    vistas.add(clave);
  }

  // Mismo criterio que POST /admin/courses/create: el docente tiene que existir y ser de
  // la escuela. No se exige role 'teacher' — una materia a cargo de un directivo es válida
  // y el formulario ya ofrece solo docentes.
  const docenteIds = [...new Set(filas.map(m => m.docenteId))];
  if (docenteIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    throw errorDeCarga('Hay un docente inválido en la lista. Recargá la página.');
  }
  const docentes = await User.find({ _id: { $in: docenteIds }, school: schoolId }).select('_id name email').lean();
  const porDocenteId = new Map(docentes.map(d => [String(d._id), d]));
  for (const m of filas) {
    const docente = porDocenteId.get(m.docenteId);
    if (!docente) throw errorDeCarga(`El docente elegido para "${m.nombre}" no existe o no es de esta escuela.`);
    m.docente = docente;
  }

  // Lo que ya está cargado en esos cursos: es lo que NO se toca.
  const existentes = await Course.find({ division: { $in: divisiones.map(d => d._id) } })
    .select('_id name division').lean();
  const presentesPorCurso = new Map(); // divisionId → Map(clave → nombre tal como está)
  for (const c of existentes) {
    const k = String(c.division);
    if (!presentesPorCurso.has(k)) presentesPorCurso.set(k, new Map());
    presentesPorCurso.get(k).set(claveMateria(c.name), c.name);
  }

  const plan = divisiones
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }))
    .map(d => {
      const presentes = presentesPorCurso.get(String(d._id)) || new Map();
      const crear    = [];
      const intactas = [];
      for (const m of filas) {
        const yaEsta = presentes.get(claveMateria(m.nombre));
        if (yaEsta !== undefined) intactas.push({ nombre: m.nombre, comoEsta: yaEsta });
        else crear.push(m);
      }
      return { id: String(d._id), nombre: d.name, crear, intactas };
    });

  return {
    schoolId,
    plan,
    totalCrear:    plan.reduce((acc, p) => acc + p.crear.length,    0),
    totalIntactas: plan.reduce((acc, p) => acc + p.intactas.length, 0),
  };
}

// Inscribe en cada materia recién creada a los alumnos de su curso.
//
// "Los alumnos del curso" no es un campo de Division: es la unión de los alumnos de las
// materias que ese curso YA tenía. Por eso un curso sin materias previas queda vacío —
// no hay de dónde sacarlos, y ahí la matrícula se hace desde el panel de administración.
async function matricularCursoCompleto(creados) {
  const nuevasPorCurso = new Map(); // divisionId → [courseId]
  for (const c of creados) {
    const k = String(c.division);
    if (!nuevasPorCurso.has(k)) nuevasPorCurso.set(k, []);
    nuevasPorCurso.get(k).push(c._id);
  }

  const nuevos = new Set(creados.map(c => String(c._id)));
  const previas = await Course.find({
    division: { $in: [...nuevasPorCurso.keys()].map(id => new mongoose.Types.ObjectId(id)) },
  }).select('_id division students').lean();

  const alumnosPorCurso = new Map(); // divisionId → Set(studentId)
  for (const c of previas) {
    if (nuevos.has(String(c._id))) continue; // recién creada: todavía no tiene a nadie
    const k = String(c.division);
    if (!alumnosPorCurso.has(k)) alumnosPorCurso.set(k, new Set());
    for (const s of (c.students || [])) alumnosPorCurso.get(k).add(String(s));
  }

  // Solo alumnos: si un docente quedó dentro de students[] por un error viejo, no es a él
  // a quien hay que arrastrar a las materias nuevas.
  const candidatos = [...new Set([...alumnosPorCurso.values()].flatMap(set => [...set]))];
  const alumnos = new Set(
    (await User.find({ _id: { $in: candidatos }, role: 'student' }).select('_id').lean())
      .map(u => String(u._id))
  );

  const ahora = new Date();
  const ops   = [];
  let inscripciones = 0;
  let sinAlumnos    = 0;

  for (const [divisionId, courseIds] of nuevasPorCurso) {
    const ids = [...(alumnosPorCurso.get(divisionId) || new Set())].filter(id => alumnos.has(id));
    if (!ids.length) { sinAlumnos++; continue; }
    for (const courseId of courseIds) {
      inscripciones += ids.length;
      ops.push({
        updateOne: {
          filter: { _id: courseId },
          update: {
            $addToSet: { students: { $each: ids.map(id => new mongoose.Types.ObjectId(id)) } },
            // enrollmentDates = ahora, igual que en 'matricula-parcial': routes/activities.js
            // lo usa para no mostrarle al alumno las tareas vencidas antes de su alta.
            $set: Object.fromEntries(ids.map(id => [`enrollmentDates.${id}`, ahora])),
          },
        },
      });
    }
  }

  if (ops.length) await Course.bulkWrite(ops, { ordered: false });
  return { inscripciones, sinAlumnos };
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
      'gradebook, y la mayoría de las veces el chico entra por la cuenta vacía y no ve nada. ' +
      'Caso por caso podés elegir con qué cuenta se queda y con qué correo: la otra le pasa sus ' +
      'entregas, sus notas, sus acuses de lectura y sus materias. El botón de abajo resuelve de ' +
      'una vez los casos obvios —la cuenta duplicada está vacía y sin materias— ' +
      'deshabilitándola, sin tocar correos y sin borrar ninguna cuenta. Si alguien había entrado ' +
      'a esa cuenta, se le avisa con qué correo tiene que entrar.',
    icono: 'group_remove',
    severidad: 'alta',
    // Las dos vías conviven a propósito: la masiva para los duplicados vacíos, que son la
    // mayoría y no tienen nada que decidir, y la elección grupo por grupo para el resto
    // (ver la REGLA DE ORO de arriba: con qué correo queda el alumno no está en los datos).
    aplicable: true,
    interactivo: true,
    parametros: [],

    async diagnosticar() {
      const { grupos } = await calcularDniDuplicados();

      const resolubles = grupos.filter(g => g.masiva.elegible);
      const cuentasADeshabilitar = resolubles.reduce((acc, g) => acc + g.masiva.deshabilitar.length, 0);
      // Los casos donde apretar el botón además manda un aviso (Fase 1b). Se dice ANTES de
      // apretar: nada se hace sin que la pantalla lo haya dicho (RN-09).
      const conAviso = resolubles.filter(g => g.masiva.avisar.length).length;
      // Por qué quedan afuera los que quedan afuera. Es el número que evita la pregunta
      // "¿y los otros 25?" cada vez que alguien aprieta el botón.
      const porMotivo = {};
      for (const g of grupos) {
        if (g.masiva.elegible) continue;
        porMotivo[g.masiva.motivo] = (porMotivo[g.masiva.motivo] || 0) + 1;
      }

      const filas = grupos.map(g => {
        const etiqueta = c => `${c.u.name} (${c.u.email})`;
        const donde = g.cursos.length ? g.cursos.join(', ') : 'sin curso';
        const trabajoDe = c => c.trabajo.entregas + c.trabajo.notas;
        return {
          principal: `DNI ${g.dni} · ${donde}`,
          secundario: g.masiva.elegible
            ? `Se conserva ${etiqueta(g.conservar)}` +
              `${trabajoDe(g.conservar) ? ` — ${trabajoDe(g.conservar)} entrega(s)/nota(s)` : ' — sin trabajo cargado'}` +
              `  ·  Se deshabilita ${g.sacar.map(etiqueta).join(', ')}`
            : g.cuentas.map(c => `${etiqueta(c)} — ${trabajoDe(c)} entrega(s)/nota(s), ` +
                `${c.materias} materia(s)`).join('  ·  '),
          extra: g.masiva.elegible ? `−${g.masiva.deshabilitar.length} cuenta(s)` : g.masiva.motivo,
          fecha: null,
          _orden: g.masiva.elegible ? 0 : 1,
        };
      }).sort((a, b) => b._orden - a._orden || a.principal.localeCompare(b.principal, 'es'));

      return {
        total: grupos.length,
        // Los que NO puede resolver el botón, primero: son los que de verdad necesitan que
        // alguien mire. Se pintan hasta MUESTRA_MAX bloques para no hacer una página de miles
        // de formularios; al resolver los de arriba y recargar, aparecen los siguientes.
        grupos: presentarGruposAlumnos(
          [...grupos].sort((a, b) =>
            (Number(a.masiva.elegible) - Number(b.masiva.elegible)) ||
            a.dni.localeCompare(b.dni))
        ).slice(0, MUESTRA_MAX),
        muestra: filas.slice(0, MUESTRA_MAX),
        nota: grupos.length
          ? 'Abajo está cada caso por separado: elegí la cuenta que se queda, con qué correo y qué ' +
            'pasa con la otra. ' +
            (cuentasADeshabilitar
              ? `Si preferís resolver de una vez los ${resolubles.length} caso(s) obvios, "Aplicar arreglo" ` +
                `deshabilita ${cuentasADeshabilitar} cuenta(s) duplicada(s) que no tienen materias, ni ` +
                'entregas, ni notas. Conserva la que tiene el trabajo hecho, no toca ningún correo y ' +
                'NO borra ninguna cuenta: deshabilitar se revierte. ' +
                (conAviso
                  ? `En ${conAviso} de esos casos alguien había entrado a la cuenta que se apaga: la que ` +
                    'se conserva recibe un mensaje tuyo con el correo con el que tiene que entrar, y el ' +
                    'login de la apagada se lo dice. '
                  : '')
              : '') +
            (porMotivo[fusion.MOTIVOS.DISPUTADA]
              ? `${porMotivo[fusion.MOTIVOS.DISPUTADA]} caso(s) quedan afuera del botón porque las dos ` +
                'cuentas tienen trabajo propio: esos van sí o sí uno por uno, y van primeros en la lista. '
              : '') +
            (porMotivo[fusion.MOTIVOS.NECESITA_AVISO]
              ? `${porMotivo[fusion.MOTIVOS.NECESITA_AVISO]} caso(s) quedan afuera porque alguien usó la ` +
                'cuenta que sobraría: apagarla sin avisarle la dejaría afuera de la plataforma sin ' +
                'entender por qué. Se resuelven a mano hasta que exista el aviso automático. '
              : '') +
            (porMotivo[fusion.MOTIVOS.SOBRANTE_CURSA]
              ? `${porMotivo[fusion.MOTIVOS.SOBRANTE_CURSA]} caso(s) quedan afuera porque la cuenta ` +
                'sobrante está cursando materias. '
              : '') +
            (grupos.length > MUESTRA_MAX
              ? `Se muestran los primeros ${MUESTRA_MAX} de ${grupos.length}: al resolverlos y recargar aparecen los siguientes.`
              : '')
          : null,
      };
    },

    // El botón masivo DESHABILITA las cuentas duplicadas vacías. RN-12 de
    // specs/fusion-de-cuentas.spec.md, decidido por el usuario el 2026-09-12: ninguna
    // resolución automática elimina una cuenta.
    //
    // ⭐ Hasta la Fase 1 este botón las "sacaba del curso", y contra los datos reales eso no
    // habría hecho nada: las 41 cuentas sobrantes no están en ningún curso. Deshabilitar sí
    // resuelve el problema de verdad, porque `rosterDeDivision()` excluye las cuentas
    // inactivas — la melliza sale de la nómina de asistencia y deja de juntar un `ausente`
    // por día lectivo.
    //
    // Desde la Fase 1b (2026-09-16) entran también los grupos donde alguien USÓ la cuenta que se
    // apaga, con aviso: la cuenta queda marcada con a qué cuenta se unificó (el login se lo dice)
    // y la que se conserva recibe un mensaje de quien apretó el botón (`actorId`).
    async aplicar(_params = {}, { actorId = null } = {}) {
      const { grupos } = await calcularDniDuplicados();
      const resolubles = grupos.filter(g => g.masiva.elegible);
      if (!resolubles.length) {
        return {
          afectados: 0,
          mensaje: grupos.length
            ? `Hay ${grupos.length} duplicado(s), pero ninguno se puede resolver solo: cada tarjeta ` +
              'de abajo dice por qué (las dos cuentas con trabajo propio, o la sobrante cursando).'
            : 'No había DNI duplicados en ninguna escuela.',
        };
      }

      // RN-13: sin saber quién aplica no hay aviso posible, y una cuenta usada no se apaga en
      // silencio. Se frena antes de tocar ninguna.
      if (resolubles.some(g => g.masiva.avisar.length)) exigirActorParaAvisar(actorId);

      // Grupo por grupo y no un solo update: cada cuenta apagada lleva la marca de SU conservada.
      // Las cuentas elegibles no están en ningún curso (si estuvieran, el motivo sería
      // SOBRANTE_CURSA), así que no hay matrícula que limpiar.
      let afectados = 0, avisosEnviados = 0, avisosFallidos = 0;
      for (const g of resolubles) {
        if (!g.masiva.deshabilitar.length) continue;
        const r = await User.updateMany(
          // `active: { $ne: false }`: si otra pestaña la apagó recién, no se la vuelve a marcar
          // ni se le manda un segundo aviso.
          { _id: { $in: g.masiva.deshabilitar.map(id => new mongoose.Types.ObjectId(id)) }, active: { $ne: false } },
          apagarPorFusion(g.masiva.keepId),
        );
        afectados += r.modifiedCount;
        if (!r.modifiedCount || !g.masiva.avisar.length) continue;

        // Después de apagar y marcar, nunca antes (ver avisarFusion). La acción masiva no toca
        // correos, así que los correos son los de siempre.
        const porId = new Map(g.cuentas.map(c => [c.id, c]));
        const conservada = porId.get(g.masiva.keepId);
        const salio = await avisarFusion({
          actorId,
          conservada: { id: conservada.u._id, email: conservada.u.email, role: 'student', schoolId: g.schoolId },
          correosApagadas: g.masiva.avisar.map(a => porId.get(a.porqueSeDeshabilito).u.email),
          cuentasEnElGrupo: g.cuentas.length,
        });
        if (salio) avisosEnviados++; else avisosFallidos++;
      }

      return {
        afectados,
        schoolId: resolubles[0].schoolId,
        meta: { grupos: resolubles.length, avisos_enviados: avisosEnviados, avisos_fallidos: avisosFallidos },
        mensaje: `${afectados} cuenta(s) duplicada(s) deshabilitada(s) en ` +
                 `${resolubles.length} caso(s). No se borró ninguna cuenta ni ningún dato, y se ` +
                 'puede revertir volviendo a habilitarlas desde el panel de administración. ' +
                 'La cuenta que se conserva quedó intacta, con su correo y su trabajo.' +
                 (avisosEnviados
                   ? ` Se mandaron ${avisosEnviados} aviso(s) a quienes habían usado la cuenta que se ` +
                     'apagó: les llega un mensaje en la que se conserva con el correo con el que tienen ' +
                     'que entrar, y el login de la apagada también se lo dice.'
                   : '') +
                 (avisosFallidos
                   ? ` ${avisosFallidos} aviso(s) no se pudo mandar: esas cuentas quedaron apagadas ` +
                     'igual, y el login de la apagada les dice con qué correo entrar.'
                   : ''),
      };
    },

    // Resolución caso por caso desde POST /superadmin/otros/:id/fusionar, con elección de
    // cuenta y de correo. Es la misma puerta que usan los docentes duplicados.
    fusionar: fusionarAlumnos,
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
      const { grupos: crudos } = await calcularDocentesDuplicados();
      const grupos = presentarGruposDocentes(crudos);
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

  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'alta-masiva-materias',
    titulo: 'Cargar un grupo de materias en varios cursos',
    descripcion:
      'El alta de a una (Administración → Materias) sirve para el día a día, pero al armar el ciclo ' +
      'lectivo hay que repetir la misma grilla de materias en decenas de cursos. Elegí los cursos, ' +
      'escribí las materias con su docente a cargo y el aula, y se crean en todos de una sola vez. ' +
      'La materia que YA exista en un curso se deja como está: no se pisa el docente, ni el aula, ni ' +
      'los alumnos, ni el código con el que se unen.',
    icono: 'library_add',
    severidad: 'baja',
    aplicable: true,
    compositor: true,
    parametros: [],

    // El "diagnóstico" de un compositor son las opciones del formulario: no hay nada que
    // contar, porque lo que se va a crear todavía no está en la base.
    async diagnosticar() {
      const opciones = await opcionesAltaMasiva();
      const materias = await Course.countDocuments();
      return {
        total: 0,
        muestra: [],
        opciones,
        nota:
          `Hay ${opciones.cursos.length} curso(s) y ${materias} materia(s) cargadas. ` +
          'Esto solo crea lo que falta: nada de lo que ya está se modifica ni se borra.',
      };
    },

    // Vista previa antes de escribir: con decenas de cursos por tanda, el conteo de una
    // tarjeta no alcanza para darse cuenta de que uno se equivocó de docente o de curso.
    async previsualizar(body) {
      const { plan, totalCrear, totalIntactas } = await planearAltaMasiva(body || {});
      return {
        totalCrear,
        totalIntactas,
        cursos: plan.map(p => ({
          nombre:   p.nombre,
          crear:    p.crear.map(m => ({ nombre: m.nombre, docente: m.docente.name, aula: m.aula })),
          intactas: p.intactas,
        })),
      };
    },

    async aplicar(body) {
      const { schoolId, plan, totalCrear, totalIntactas } = await planearAltaMasiva(body || {});

      // Por omisión SÍ se matricula: una materia nueva y vacía en un curso que ya tiene
      // alumnos deja a todo el curso con matrícula parcial (ver 'matricula-parcial'), o sea
      // que se estaría creando el problema que el arreglo de más arriba viene a resolver.
      const matricular = body?.matricular !== false;

      if (!totalCrear) {
        return {
          afectados: 0,
          schoolId,
          mensaje: `No se creó ninguna materia: las ${totalIntactas} ya existían en esos cursos y quedaron como estaban.`,
        };
      }

      // El `code` lo genera el default del modelo, pero insertMany no reintenta ante una
      // colisión del índice único: en una tanda de cientos, un choque tumbaría ese
      // documento. Se generan acá contra los que ya existen y contra los de esta misma tanda.
      const usados = new Set((await Course.find().select('code').lean()).map(c => c.code));
      const nuevoCodigo = () => {
        let code;
        do { code = uuidv4().slice(0, 6).toUpperCase(); } while (usados.has(code));
        usados.add(code);
        return code;
      };

      const docs = [];
      for (const p of plan) {
        for (const m of p.crear) {
          docs.push({
            name:     m.nombre,
            room:     m.aula || '',
            code:     nuevoCodigo(),
            division: new mongoose.Types.ObjectId(p.id),
            school:   schoolId,
            owner:    m.docente._id,
          });
        }
      }

      const creados = await Course.insertMany(docs);
      const cursosTocados = plan.filter(p => p.crear.length).length;

      let inscripciones = 0;
      let sinAlumnos    = 0;
      if (matricular) {
        const r = await matricularCursoCompleto(creados);
        inscripciones = r.inscripciones;
        sinAlumnos    = r.sinAlumnos;
      }

      return {
        afectados: creados.length,
        schoolId,
        meta: { cursos: cursosTocados, creadas: creados.length, intactas: totalIntactas, inscripciones },
        mensaje:
          `Se crearon ${creados.length} materia(s) en ${cursosTocados} curso(s). ` +
          (totalIntactas
            ? `${totalIntactas} ya existían y quedaron como estaban (mismo docente, misma aula, mismos alumnos). `
            : '') +
          (matricular
            ? (inscripciones
                ? `Se agregaron ${inscripciones} inscripción(es): los alumnos de cada curso ya ven las materias nuevas. ` +
                  'Las tareas que venzan antes de hoy no les van a figurar como pendientes. '
                : 'No había alumnos que inscribir. ') +
              (sinAlumnos
                ? `${sinAlumnos} curso(s) quedaron sin alumnos porque no tenían ninguna materia previa de donde tomarlos.`
                : '')
            : 'No se inscribió a nadie: las materias nuevas quedan vacías.'),
      };
    },
  },
  /* ─────────────────────────────────────────────────────────────────────── */
  {
    id: 'ocupacion-descuadrada',
    titulo: 'Netbooks (u otro recurso repartible) ocupadas por nadie',
    descripcion:
      'El cupo de un recurso que se reparte entre varios docentes se lleva en un contador aparte ' +
      '(models/SlotOcupacion.js), porque "no pasarse de 30" es una suma y una suma no cabe en un ' +
      'índice. Ese contador es un dato DERIVADO: la verdad son las reservas confirmadas. Si algún ' +
      'camino de salida —cancelar, rechazar, editar la cantidad, dar de baja el recurso— dejara de ' +
      'devolver lo que tomó, el contador quedaría alto para siempre: el recurso figuraría ocupado y ' +
      'no lo tendría nadie. El arreglo lo recalcula sumando las reservas confirmadas.',
    icono: 'exposure',
    severidad: 'media',
    aplicable: true,
    parametros: [],

    async diagnosticar() {
      const { diferencias } = await cupoRecursos.recalcular({ aplicar: false });
      if (!diferencias.length) return { total: 0, muestra: [], nota: null };

      const ids = [...new Set(diferencias.map(d => d.recurso))];
      const recursos = await Recurso.find({ _id: { $in: ids } }).select('name capacidad').lean();
      const nombre = Object.fromEntries(recursos.map(r => [r._id.toString(), r.name]));

      const filas = diferencias
        .sort((a, b) => Math.abs(b.guardado - b.real) - Math.abs(a.guardado - a.real))
        .map(d => ({
          principal: nombre[d.recurso] || '(recurso borrado)',
          secundario: `${d.date} · ${d.turno} · módulo ${d.modulo}`,
          extra: `figura ${d.guardado}, en realidad hay ${d.real}`,
          fecha: null,
        }));

      return {
        total: diferencias.length,
        muestra: filas.slice(0, MUESTRA_MAX),
        nota:
          'Cada fila es un casillero (recurso × día × módulo) donde el contador y las reservas no ' +
          'coinciden. Aplicar el arreglo pone el contador en el número real; no toca ninguna reserva.',
      };
    },

    async aplicar() {
      const { diferencias } = await cupoRecursos.recalcular({ aplicar: true });
      return {
        afectados: diferencias.length,
        mensaje: diferencias.length
          ? `${diferencias.length} casillero(s) recalculados desde las reservas confirmadas. ` +
            'El cupo que estaba retenido vuelve a estar disponible.'
          : 'No había ningún casillero descuadrado.',
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
        compositor: fix.compositor === true,
        parametros: await resolverParametros(fix),
        total: d.total, muestra: d.muestra, nota: d.nota || null,
        // Solo los arreglos interactivos lo traen: es el detalle que la tarjeta necesita
        // para dejar elegir (ver 'docentes-dni-duplicado').
        grupos: d.grupos || [],
        // Solo los compositores: lo que necesita su formulario para pintarse
        // (ver 'alta-masiva-materias').
        opciones: d.opciones || null,
        error: null,
      };
    } catch (err) {
      // Un arreglo que rompe no debe tumbar la pantalla entera: el resto sigue siendo útil.
      return {
        id: fix.id, titulo: fix.titulo, descripcion: fix.descripcion,
        icono: fix.icono, severidad: fix.severidad, aplicable: fix.aplicable,
        interactivo: fix.interactivo === true,
        compositor: fix.compositor === true,
        parametros: [], total: null, muestra: [], nota: null, grupos: [], opciones: null,
        error: err.message,
      };
    }
  }));
}

module.exports = { FIXES, getFix, diagnosticarTodos, diagnosticarUno: (id) => getFix(id)?.diagnosticar() };
