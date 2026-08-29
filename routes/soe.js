// Panel del Servicio de Orientación Escolar — /soe
//
// El gabinete lleva, por alumno, un LEGAJO: qué le pasa, con qué cuenta, cómo se lo contiene
// en el aula, el seguimiento a lo largo del tiempo y las derivaciones a servicios externos
// con lo que esos lugares van devolviendo.
//
// Dos guardas distintas, y conviene no mezclarlas (ver middleware/soe.js):
//   requireSoe            → ¿entra al panel, y cuánto del legajo se le arma? (School.soeAccess)
//   loadSoeScope + scope  → ¿sobre qué alumnos? (divisiones asignadas, o toda la escuela)
//   requireEscrituraSoe   → escribir, SOLO el rol `soe`. Ni el superadmin.
//
// Un directivo con nivel 'completo' entra, lee todo y no puede tocar una coma. Un preceptor
// con nivel 'resumen' ve las fortalezas y las estrategias de aula, y nada de lo clínico.
//
// Las escrituras son POST de formulario con redirect, no fetch: la ficha es una pantalla de
// formularios largos que se completa muchas veces desde el teléfono, y un POST clásico no
// se pierde si la conexión se corta a mitad de camino.
//
// Ver specs/soe-orientacion.spec.md.

const express  = require('express');
const mongoose = require('mongoose');

const User       = require('../models/User');
const Course     = require('../models/Course');
const Division   = require('../models/Division');
const SoeCase    = require('../models/SoeCase');
const SoeRequest = require('../models/SoeRequest');

const { requireAuth }  = require('../middleware/auth');
const { sectionGuard } = require('../middleware/sections');
const {
  requireSoe, requireEscrituraSoe, loadSoeScope, alumnoEnScope,
} = require('../middleware/soe');
const { logAudit }  = require('../middleware/audit');
const { logDeRuta } = require('../middleware/route-log');
const { idMalo }    = require('../middleware/objectId');

const acceso = require('../services/soeAcceso');
const { construirLinea } = require('../services/soeLinea');
const { indicadoresDeAlumno } = require('../services/soeIndicadores');
// diaEscolar resuelve el día en la zona de la escuela (producción corre en UTC).
const { diaEscolar } = require('../services/liveRoom');

const router = express.Router();

// sectionGuard va ANTES de loadSoeScope para no pagar la query de divisiones en un request
// que va a terminar en 403 — misma razón que en routes/preceptor.js.
router.use(requireAuth, requireSoe, sectionGuard('soe'), loadSoeScope);

const oid = (id) => new mongoose.Types.ObjectId(id.toString());

// Los formularios mandan strings. Estas dos normalizan antes de que lleguen al schema, para
// que un campo vacío quede en '' o null y no en la string "undefined".
const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// ⚠️ Un <input type="date"> manda "2026-08-18", y `new Date("2026-08-18")` es MEDIANOCHE
// UTC. Producción corre en UTC y las vistas imprimen con fmt en la zona de la escuela
// (UTC−3): esa fecha se vería como el 17. Es la trampa de zona horaria del proyecto.
//
// Se fija el mediodía UTC: así el día del calendario es el mismo en cualquier zona entre
// UTC−11 y UTC+11, que las cubre todas las que le importan a la escuela. Un valor con hora
// (los que no vienen de un input date) se respeta tal cual.
const fecha = (v) => {
  if (!v) return null;
  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(soloDia ? `${v}T12:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// El camino inverso: un Date a "YYYY-MM-DD" en la zona de la escuela, para precargar los
// <input type="date"> del formulario de edición sin que la fecha se corra un día.
const paraInput = (d) => (d ? diaEscolar(new Date(d)) : '');
// Lista blanca cerrada: nunca se confía en el <select> del cliente. El enum del schema lo
// atajaría igual, pero un valor inesperado tiene que morir acá y no en un ValidationError.
const deLista = (v, lista, porDefecto) => (lista.includes(v) ? v : porDefecto);

// El legajo del alumno + la validación de alcance, que es lo que toda ruta con :studentId
// necesita hacer primero. Devuelve null si el alumno no existe o no le corresponde a este
// usuario — la ruta contesta 403 sin distinguir cuál de las dos cosas fue, para no confirmar
// la existencia de un alumno de otra escuela.
async function alumnoYLegajo(req, studentId) {
  const alumno = await alumnoEnScope(req, studentId);
  if (!alumno) return null;
  const legajo = await SoeCase.findOne({ student: alumno._id });
  return { alumno, legajo };
}

// Ídem pero entrando por el id del LEGAJO (las rutas de escritura, que lo tienen a mano).
// Vuelve a validar el alcance contra el alumno: el legajo guarda un snapshot de división
// que puede haber quedado viejo, y la autorización nunca se decide con ese snapshot.
async function legajoEnScope(req, caseId) {
  const legajo = await SoeCase.findById(caseId);
  if (!legajo) return null;
  const alumno = await alumnoEnScope(req, legajo.student);
  return alumno ? { alumno, legajo } : null;
}

// Deja el snapshot de división al día. No es fuente de verdad (ver models/SoeCase.js): sirve
// para listar y filtrar sin joins, y se refresca cada vez que pasamos por acá igual.
const primeraDivision = (alumno) => (alumno.divisiones && alumno.divisiones.length
  ? oid(alumno.divisiones[0]) : null);

// Guarda de nivel COMPLETO, para las pantallas que muestran el destino de una derivación.
//
// ⚠️ No alcanza con dejar `preceptor`/`teacher` fuera de `roles` en config/sections.js:
// sectionGuard solo puede DENEGAR lo explícitamente denegado (es fail-open), así que una
// solapa que el rol no tiene en el catálogo igual contesta 200 si se escribe la URL a mano.
// El nivel 'resumen' está definido justamente como "sabe que hay una derivación en curso,
// pero no a dónde": sin esta guarda, /soe/derivaciones lo desmiente en una tabla.
const requireCompleto = (req, res, next) => {
  if (res.locals.soeNivel !== acceso.COMPLETO) {
    return res.status(403).send('Acceso denegado');
  }
  next();
};

// ── Resumen: GET /soe ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const ahora = new Date();
    const completo = res.locals.soeNivel === acceso.COMPLETO;
    const filtro = { school: res.locals.user.school };
    if (!req.soeAlcance.todas) filtro.division = { $in: req.soeAlcance.divisionIds.map(oid) };

    const legajos = await SoeCase.find(filtro)
      .populate('student', 'name avatar dni')
      .populate('division', 'name')
      .sort({ updatedAt: -1 })
      .lean();

    const abiertos = legajos.filter(l => l.estado !== 'cerrado');

    // Ordenados por prioridad y después por última novedad: lo urgente arriba, y dentro de
    // lo urgente, lo que se movió recién.
    const PESO = { alta: 0, media: 1, baja: 2 };
    abiertos.sort((a, b) => (PESO[a.prioridad] - PESO[b.prioridad])
      || (new Date(b.lastEntryAt || b.updatedAt) - new Date(a.lastEntryAt || a.updatedAt)));

    // Las derivaciones que piden acción hoy: sin respuesta, el chico no fue, o se pasó la
    // fecha en que había que volver a preguntar.
    //
    // Solo para nivel COMPLETO: esta lista nombra el destino de cada derivación, y el nivel
    // 'resumen' está definido como "sabe que hay una derivación en curso, sin saber a dónde".
    // Se corta acá y no en la vista: lo que se manda al render termina en el HTML apenas
    // alguien agregue un <%= mañana.
    const pendientes = [];
    if (completo) {
      for (const l of legajos) {
        for (const r of (l.referrals || [])) {
          if (acceso.derivacionNecesitaAtencion(r, ahora)) {
            pendientes.push({ legajo: l, referral: r });
          }
        }
      }
    }

    // Los legajos a los que hay que volver a mirar hoy. Misma idea y mismo panel que las
    // derivaciones de arriba, pero para el chico al que se acompaña SIN derivarlo a ningún
    // lado: ese es el que se enfriaba en silencio.
    //
    // Solo nivel COMPLETO (criterio 34): la fecha no sobrevive al sanitizado en 'resumen',
    // así que la lista quedaría vacía igual — se corta acá para que la tarjeta tampoco se
    // dibuje y no mienta un 0.
    //
    // Se arma con los campos justos y no con el legajo crudo: la tabla solo necesita el
    // alumno, el curso, la prioridad y las dos fechas.
    const repasos = !completo ? [] : abiertos
      .filter(l => acceso.legajoNecesitaRepaso(l, ahora))
      .map(l => ({
        student:       l.student,
        division:      l.division,
        prioridad:     l.prioridad,
        proximoRepaso: l.proximoRepaso,
        lastEntryAt:   l.lastEntryAt,
      }));

    // Los pedidos de Preceptoría sin atender. Es el aviso: el rol `soe` aterriza en esta
    // pantalla (server.js redirige "/" acá), así que es donde tiene que enterarse de que
    // alguien le derivó un chico. Solo el CONTEO — el motivo, que es una observación sobre
    // un menor, se lee en /soe/pedidos y no en una tarjeta de resumen.
    //
    // Solo nivel COMPLETO, por el mismo criterio que las derivaciones de arriba.
    const pedidosSinAtender = !completo ? 0 : await SoeRequest.countDocuments({
      school: res.locals.user.school,
      estado: 'pendiente',
      ...(req.soeAlcance.todas ? {} : { division: { $in: req.soeAlcance.divisionIds.map(oid) } }),
    });

    // Misma regla que la ficha: el legajo llega a la vista SOLO por el sanitizado, nunca
    // crudo. Acá la lista no dibuja nada clínico, pero mandar el documento entero deja el
    // motivo y las entrevistas a un `<%=` de distancia de terminar en el HTML. `student` y
    // `division` vienen populados y pasan derecho: son los que arman el link y la columna.
    const paraLaVista = abiertos.map(l => ({
      ...acceso.sanitizarLegajo(l, res.locals.soeNivel),
      student:  l.student,
      division: l.division,
      updatedAt: l.updatedAt,
    }));

    res.render('soe/index', {
      activePage: 'resumen',
      legajos: paraLaVista,
      cerrados: legajos.filter(l => l.estado === 'cerrado').length,
      pendientes,
      repasos,
      totales: {
        // "Activos" y no "abiertos": tiene que coincidir con lo que lista la tabla de abajo,
        // que son todos los no cerrados. Contar solo estado === 'abierto' daba la tarjeta en
        // 0 con un legajo listado justo debajo — pasó apenas se derivó al primer alumno, que
        // es cuando el estado salta solo a 'seguimiento'.
        activos:     abiertos.length,
        seguimiento: legajos.filter(l => l.estado === 'seguimiento').length,
        derivacionesActivas: legajos.filter(l => acceso.tieneDerivacionActiva(l.referrals)).length,
        atencion: pendientes.length,
        repasos:  repasos.length,
        pedidos:  pedidosSinAtender,
        // La tarjeta de "piden atención" solo se dibuja en nivel completo: en resumen
        // siempre valdría 0 y mentiría por omisión.
        veDerivaciones: completo,
      },
      acceso,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Alumnos: GET /soe/alumnos ────────────────────────────────────────────────
//
// Buscador primero: una escuela tiene cientos de alumnos y volcarlos todos es una pantalla
// inservible. Sin búsqueda se muestran únicamente los que ya tienen legajo.
router.get('/alumnos', async (req, res) => {
  try {
    const q = txt(req.query.q, 80);
    const divisionId = mongoose.isValidObjectId(req.query.division) ? req.query.division : null;

    const divisiones = await Division.find({
      school: res.locals.user.school,
      ...(req.soeAlcance.todas ? {} : { _id: { $in: req.soeAlcance.divisionIds.map(oid) } }),
    }).select('name').sort({ name: 1 }).lean();

    let alumnos = [];
    if (q || divisionId) {
      // El universo de alumnos alcanzables: los inscriptos en materias de las divisiones del
      // alcance. Es la misma resolución que usa el resto del proyecto (no existe
      // User.division), acotada por la división elegida si la hay.
      const divisionesBuscadas = divisionId
        ? [divisionId]
        : divisiones.map(d => d._id.toString());

      const cursos = await Course.find({ division: { $in: divisionesBuscadas.map(oid) } })
        .select('students division').lean();
      const ids = [...new Set(cursos.flatMap(c => (c.students || []).map(String)))];

      const filtro = { _id: { $in: ids }, role: 'student', school: res.locals.user.school };
      if (q) {
        // Escapado antes de armar la RegExp: un "(" en el buscador reventaría la query.
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filtro.$or = [{ name: new RegExp(esc, 'i') }, { dni: new RegExp(esc, 'i') }];
      }

      alumnos = await User.find(filtro)
        .select('name dni avatar active')
        .sort({ name: 1 })
        .limit(100)
        .lean();
    }

    const conLegajo = await SoeCase.find({
      student: { $in: alumnos.map(a => a._id) },
    }).select('student estado prioridad').lean();
    const legajoPorAlumno = new Map(conLegajo.map(l => [l.student.toString(), l]));

    res.render('soe/alumnos', {
      activePage: 'alumnos',
      q, divisionId, divisiones, alumnos, legajoPorAlumno,
      busco: !!(q || divisionId),
      acceso,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Derivaciones: GET /soe/derivaciones ──────────────────────────────────────
//
// Todas las derivaciones de la escuela en una sola lista. Es la pantalla que evita que un
// chico se pierda en el hueco entre "se lo derivó" y "el lugar nunca contestó".
router.get('/derivaciones', requireCompleto, async (req, res) => {
  try {
    const ahora  = new Date();
    const filtro = { school: res.locals.user.school, 'referrals.0': { $exists: true } };
    if (!req.soeAlcance.todas) filtro.division = { $in: req.soeAlcance.divisionIds.map(oid) };

    const legajos = await SoeCase.find(filtro)
      .populate('student', 'name avatar')
      .populate('division', 'name')
      .lean();

    const filas = [];
    for (const l of legajos) {
      for (const r of (l.referrals || [])) {
        filas.push({
          legajo: l,
          referral: r,
          atencion: acceso.derivacionNecesitaAtencion(r, ahora),
          activa: !acceso.DERIVACION_TERMINADA.includes(r.estado),
        });
      }
    }
    // Las que piden acción arriba; después, las activas; al final las cerradas.
    filas.sort((a, b) => (Number(b.atencion) - Number(a.atencion))
      || (Number(b.activa) - Number(a.activa))
      || (new Date(b.referral.fecha) - new Date(a.referral.fecha)));

    res.render('soe/derivaciones', { activePage: 'derivaciones', filas, acceso });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Pedidos de Preceptoría: GET /soe/pedidos ─────────────────────────────────
//
// La bandeja del gabinete: lo que le derivó Preceptoría y todavía no resolvió, más el
// historial de lo ya resuelto.
//
// requireCompleto por el mismo motivo que /soe/derivaciones: el motivo que escribe el
// preceptor es una observación sobre un menor ("se peleó en el recreo", "la madre no
// aparece"), no un dato de aula. No es algo que un nivel intermedio deba leer.
router.get('/pedidos', requireCompleto, async (req, res) => {
  try {
    const filtro = { school: res.locals.user.school };
    if (!req.soeAlcance.todas) filtro.division = { $in: req.soeAlcance.divisionIds.map(oid) };

    const todos = await SoeRequest.find(filtro)
      .populate('student', 'name avatar dni')
      .populate('division', 'name')
      .populate('solicitadaPor', 'name')
      .populate('resueltaPor', 'name')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    // Los pendientes con el orden de bandeja (urgente primero, y dentro de cada urgencia lo
    // más viejo arriba); los resueltos con el orden natural de un historial, lo último
    // primero.
    const pendientes = acceso.ordenarPedidos(todos.filter(p => p.estado === 'pendiente'));
    const resueltos  = todos.filter(p => p.estado !== 'pendiente');

    res.render('soe/pedidos', {
      activePage: 'pedidos',
      pendientes,
      resueltos,
      acceso,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── La ficha: GET /soe/legajo/:id ────────────────────────────────────────────
router.get('/legajo/:id', async (req, res) => {
  if (idMalo(req, res, 'Alumno no encontrado')) return;
  try {
    const par = await alumnoYLegajo(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');

    const { alumno, legajo } = par;
    const nivel = res.locals.soeNivel;

    // El sanitizado es la ÚNICA puerta por la que el legajo llega a la vista. Nunca se pasa
    // el documento crudo, ni "porque el .ejs igual no lo dibuja": lo que se manda al render
    // termina en el HTML si alguien agrega un <%= mañana.
    const visto = acceso.sanitizarLegajo(legajo, nivel);

    // Los indicadores son datos de la escuela (asistencia, notas, entregas), no del legajo:
    // los ve cualquiera que tenga acceso al panel, con legajo abierto o sin él.
    const indicadores = await indicadoresDeAlumno(alumno._id);

    // La línea de tiempo: todas las actuaciones en un solo hilo cronológico. Se arma sobre
    // el legajo YA SANITIZADO, nunca sobre el crudo — es lo que hace que la línea no pueda
    // abrir una puerta nueva a lo clínico (ver services/soeLinea.js).
    //
    // El orden por defecto es "lo último arriba"; el botón de la vista lo invierte del lado
    // del navegador, sin recargar. El query param existe para poder linkear la vista
    // cronológica y para que la preferencia funcione con JS apagado.
    const orden = req.query.orden === 'cronologico' ? 'cronologico' : 'reciente';
    const linea = construirLinea(visto, { orden });

    // Quién firmó cada hito, resuelto de una sola vez. Sale de la LÍNEA y no solo de
    // `entries`: las derivaciones y las devoluciones también tienen autor, y sin ellos el
    // hilo mostraría media firma. `filter(Boolean)` porque los hitos de apertura y cierre de
    // un legajo viejo pueden no tener a nadie.
    const autores = await User.find({
      _id: { $in: [...new Set(linea.map(h => h.autor).filter(Boolean).map(String))] },
    }).select('name avatar').lean();

    // ⚠️ Solo la lectura AJENA se audita. La del propio SOE es su trabajo diario y llenaría
    // la auditoría de ruido hasta volverla inútil; la de un directivo o un superadmin es
    // justamente el evento que hay que poder revisar después.
    if (res.locals.user.role !== 'soe') {
      logAudit(req, 'soe.view_case',
        [{ type: 'user', id: alumno._id, name: alumno.name }],
        { nivel });
    }

    res.render('soe/legajo', {
      activePage: 'alumnos',
      alumno,
      legajo: visto,
      linea,
      orden,
      indicadores,
      autores: new Map(autores.map(a => [a._id.toString(), a])),
      nivel,
      acceso,
      paraInput,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── A partir de acá, TODO es escritura: solo el rol `soe` ────────────────────
router.use(requireEscrituraSoe);

// El pedido de Preceptoría + la validación de alcance. Devuelve null si no existe o si el
// alumno no le corresponde a este usuario: la ruta contesta 403 sin distinguir cuál de las
// dos cosas fue, igual que legajoEnScope.
//
// Revalida contra el alumno y NO contra el snapshot `pedido.division`: si al chico lo
// cambiaron de curso entre que lo derivaron y hoy, el que tiene que atenderlo es el gabinete
// del curso nuevo. Es la misma regla que en el resto del panel.
async function pedidoEnScope(req, pedidoId) {
  const pedido = await SoeRequest.findById(pedidoId);
  if (!pedido) return null;
  const alumno = await alumnoEnScope(req, pedido.student);
  return alumno ? { alumno, pedido } : null;
}

// Tomar el pedido: se abre el legajo (si no lo tenía) y lo que escribió el preceptor entra
// como primer hito de la línea de tiempo.
router.post('/pedidos/:id/tomar', async (req, res) => {
  if (idMalo(req, res, 'Pedido no encontrado')) return;
  try {
    const par = await pedidoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, pedido } = par;

    // Idempotente: tomar dos veces el mismo pedido no puede duplicar el hito en el legajo.
    // Pasa de verdad — el gabinete abre la bandeja en dos pestañas, o el celular reenvía el
    // POST al recuperar la señal.
    if (pedido.estado !== 'pendiente') return res.redirect('/soe/pedidos');

    let legajo = await SoeCase.findOne({ student: alumno._id });
    if (!legajo) {
      legajo = await SoeCase.create({
        student:   alumno._id,
        school:    res.locals.user.school,
        division:  primeraDivision(alumno),
        motivo:    `Derivado por Preceptoría: ${txt(pedido.motivo, 400)}`,
        // La urgencia que puso el preceptor arranca siendo la prioridad del legajo. El
        // gabinete la cambia después si no coincide con lo que ve.
        prioridad: deLista(pedido.urgencia, acceso.PRIORIDADES, 'media'),
        openedBy:  res.locals.user._id,
        openedAt:  new Date(),
      });
    }

    // ⚠️ El hito va firmado por EL PRECEPTOR (`pedido.solicitadaPor`), no por el SOE que lo
    // tomó. No es un detalle estético: la ruta de edición de entradas solo deja tocar la
    // PROPIA entrada, y el preceptor no entra a este panel — así que la entrada queda
    // inmutable para todo el mundo. Es lo que el preceptor dijo, no lo que el gabinete
    // interpretó, y tiene que poder leerse dentro de un año tal como se escribió.
    legajo.entries.push({
      fecha: pedido.createdAt || new Date(),
      tipo:  'derivacion',
      animo: null,
      texto: txt(pedido.motivo, 4000),
      autor: pedido.solicitadaPor,
    });
    legajo.lastEntryAt = legajo.entries.reduce(
      (max, e) => (!max || new Date(e.fecha) > new Date(max) ? e.fecha : max), null);
    // Tomar un pedido es, por definición, empezar a seguir al chico.
    if (legajo.estado === 'abierto') legajo.estado = 'seguimiento';
    await legajo.save();

    pedido.estado      = 'tomada';
    pedido.resueltaPor = res.locals.user._id;
    pedido.resueltaEl  = new Date();
    pedido.soeCase     = legajo._id;
    pedido.respuesta   = txt(req.body.respuesta, 500);
    await pedido.save();

    logAudit(req, 'soe.request_take',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { urgencia: pedido.urgencia });

    res.redirect(`/soe/legajo/${alumno._id}#linea`);
  } catch (err) {
    // Choque del índice único de SoeCase: alguien abrió el legajo en paralelo. No es un
    // error para el usuario — se vuelve a la bandeja y el pedido sigue pendiente.
    if (err && err.code === 11000) return res.redirect('/soe/pedidos');
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Descartar el pedido: no se abre ningún legajo y no se toca el que hubiera.
router.post('/pedidos/:id/descartar', async (req, res) => {
  if (idMalo(req, res, 'Pedido no encontrado')) return;
  try {
    const par = await pedidoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, pedido } = par;

    if (pedido.estado !== 'pendiente') return res.redirect('/soe/pedidos');

    // La respuesta es OBLIGATORIA acá y opcional al tomar: un pedido que se descarta sin
    // decir por qué le enseña al preceptor a no volver a derivar. Es el único texto del
    // gabinete que él llega a leer.
    const respuesta = txt(req.body.respuesta, 500);
    if (!respuesta) return res.redirect('/soe/pedidos');

    pedido.estado      = 'descartada';
    pedido.resueltaPor = res.locals.user._id;
    pedido.resueltaEl  = new Date();
    pedido.respuesta   = respuesta;
    await pedido.save();

    logAudit(req, 'soe.request_drop',
      [{ type: 'user', id: alumno._id, name: alumno.name }], {});

    res.redirect('/soe/pedidos');
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Abrir el legajo. IDEMPOTENTE: si ya existe, redirige al que hay en vez de crear otro.
// El índice único de SoeCase es la última red (dos clicks simultáneos llegarían los dos
// acá antes de que ninguno guarde), no la primera.
router.post('/legajo/:id/abrir', async (req, res) => {
  if (idMalo(req, res, 'Alumno no encontrado')) return;
  try {
    const alumno = await alumnoEnScope(req, req.params.id);
    if (!alumno) return res.status(403).send('Acceso denegado');

    const existente = await SoeCase.findOne({ student: alumno._id });
    if (existente) return res.redirect(`/soe/legajo/${alumno._id}`);

    const legajo = await SoeCase.create({
      student:   alumno._id,
      school:    res.locals.user.school,
      division:  primeraDivision(alumno),
      motivo:    txt(req.body.motivo, 500),
      prioridad: deLista(req.body.prioridad, acceso.PRIORIDADES, 'media'),
      openedBy:  res.locals.user._id,
      openedAt:  new Date(),
    });

    logAudit(req, 'soe.case_open',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { prioridad: legajo.prioridad });

    res.redirect(`/soe/legajo/${alumno._id}`);
  } catch (err) {
    // Choque del índice único: alguien ganó la carrera. No es un error para el usuario.
    if (err && err.code === 11000) return res.redirect(`/soe/legajo/${req.params.id}`);
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// La situación: fortalezas, dificultades, estrategias, prioridad y estado.
router.post('/legajo/:id/situacion', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    legajo.motivo       = txt(req.body.motivo, 500);
    legajo.fortalezas   = txt(req.body.fortalezas, 1000);
    legajo.dificultades = txt(req.body.dificultades, 1000);
    legajo.estrategias  = txt(req.body.estrategias, 2000);

    // Este formulario es el EDITOR COMPLETO del legajo: el campo vacío borra la fecha de
    // repaso, igual que cualquier otro campo de acá. En el formulario de una entrada del
    // seguimiento la regla es la contraria, y es a propósito (criterio 35).
    legajo.proximoRepaso = fecha(req.body.proximoRepaso);
    legajo.prioridad    = deLista(req.body.prioridad, acceso.PRIORIDADES, legajo.prioridad);

    // El estado se cambia acá salvo 'cerrado', que tiene su propia ruta porque exige motivo.
    const estado = deLista(req.body.estado, ['abierto', 'seguimiento'], null);
    if (estado) legajo.estado = estado;
    legajo.division = primeraDivision(alumno) || legajo.division;

    await legajo.save();
    res.redirect(`/soe/legajo/${alumno._id}`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Una entrada del seguimiento.
router.post('/legajo/:id/entrada', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const texto = txt(req.body.texto, 4000);
    if (!texto) return res.redirect(`/soe/legajo/${alumno._id}#linea`);

    // La fecha del HECHO. Si no la cargan, hoy — pero el campo está en el formulario porque
    // las entrevistas se anotan después, no en el momento.
    const cuando = fecha(req.body.fecha) || new Date();

    legajo.entries.push({
      fecha: cuando,
      // ⚠️ Contra TIPOS_ENTRADA_MANUALES, NO contra TIPOS_ENTRADA. El enum del modelo acepta
      // además 'derivacion', que es el hito que empuja POST /soe/pedidos/:id/tomar con el
      // texto del preceptor. Validar acá contra el enum completo dejaría que el gabinete
      // fabrique a mano una derivación de Preceptoría que nunca existió, y la línea de tiempo
      // la mostraría igual de firme que la real. Un tipo fuera de la lista cae en 'nota'.
      tipo:  deLista(req.body.tipo, acceso.TIPOS_ENTRADA_MANUALES, 'nota'),
      animo: deLista(req.body.animo, acceso.ANIMOS, null),
      texto,
      autor: res.locals.user._id,
    });

    // lastEntryAt ordena la lista del panel sin abrir cada legajo. Se recalcula sobre TODAS
    // las entradas y no se pisa con `cuando`: cargar hoy una entrevista de hace un mes no
    // debería mandar el legajo al fondo de la lista ni traerlo al frente.
    legajo.lastEntryAt = legajo.entries.reduce(
      (max, e) => (!max || new Date(e.fecha) > new Date(max) ? e.fecha : max), null);

    // El repaso, si vino. Acá vacío significa "no cambies nada" y NO "borrala": es el campo
    // que más se va a dejar en blanco —se anota una entrevista sin querer tocar la agenda—
    // y que anotar una observación borrara la fecha sería una pérdida de dato silenciosa.
    // Para sacarla está el formulario de Situación (criterio 35).
    const repaso = fecha(req.body.proximoRepaso);
    if (repaso) legajo.proximoRepaso = repaso;

    await legajo.save();

    logAudit(req, 'soe.entry_add',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { tipo: req.body.tipo || 'nota' });

    res.redirect(`/soe/legajo/${alumno._id}#linea`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Editar una entrada. Solo la propia: dos personas del gabinete pueden compartir un legajo a
// lo largo de los años, y reescribir la entrevista que anotó otro borra su firma profesional.
router.post('/legajo/:id/entrada/:entryId/editar', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const entrada = legajo.entries.id(req.params.entryId);
    if (!entrada) return res.status(404).send('Entrada no encontrada');
    if (String(entrada.autor) !== String(res.locals.user._id)) {
      return res.status(403).send('Solo se puede editar la propia entrada');
    }

    const texto = txt(req.body.texto, 4000);
    if (texto) {
      entrada.texto = texto;
      entrada.animo = deLista(req.body.animo, acceso.ANIMOS, entrada.animo);
      entrada.fecha = fecha(req.body.fecha) || entrada.fecha;
      entrada.editedAt = new Date();
      await legajo.save();
    }
    res.redirect(`/soe/legajo/${alumno._id}#linea`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Una derivación externa.
router.post('/legajo/:id/derivacion', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const destino = txt(req.body.destino, 200);
    if (!destino) return res.redirect(`/soe/legajo/${alumno._id}#derivaciones`);

    legajo.referrals.push({
      destino,
      tipo:     deLista(req.body.tipo, acceso.TIPOS_DERIVACION, 'otro'),
      motivo:   txt(req.body.motivo, 1000),
      fecha:    fecha(req.body.fecha) || new Date(),
      contacto: txt(req.body.contacto, 200),
      estado:   'derivado',
      proximoSeguimiento: fecha(req.body.proximoSeguimiento),
      creadaPor: res.locals.user._id,
    });
    // Derivar es, por definición, entrar en seguimiento.
    if (legajo.estado === 'abierto') legajo.estado = 'seguimiento';

    await legajo.save();

    logAudit(req, 'soe.referral_add',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { destino, tipo: req.body.tipo || 'otro' });

    res.redirect(`/soe/legajo/${alumno._id}#derivaciones`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Cambiar el estado de una derivación (o su próximo seguimiento).
router.post('/legajo/:id/derivacion/:refId', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const ref = legajo.referrals.id(req.params.refId);
    if (!ref) return res.status(404).send('Derivación no encontrada');

    const anterior = ref.estado;
    ref.estado = deLista(req.body.estado, acceso.ESTADOS_DERIVACION, ref.estado);
    if (req.body.proximoSeguimiento !== undefined) {
      ref.proximoSeguimiento = fecha(req.body.proximoSeguimiento);
    }
    await legajo.save();

    logAudit(req, 'soe.referral_update',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { de: anterior, a: ref.estado });

    res.redirect(`/soe/legajo/${alumno._id}#derivaciones`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Una devolución: lo que dijo el lugar al que se lo derivó. Es el dato que hoy se pierde.
router.post('/legajo/:id/derivacion/:refId/devolucion', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const ref = legajo.referrals.id(req.params.refId);
    if (!ref) return res.status(404).send('Derivación no encontrada');

    const texto = txt(req.body.texto, 2000);
    if (texto) {
      ref.devoluciones.push({
        fecha: fecha(req.body.fecha) || new Date(),
        texto,
        registradoPor: res.locals.user._id,
      });
      // Si estaba esperando respuesta, ya la tuvo. No se toca ningún otro estado: que el
      // lugar conteste no significa que el chico haya empezado el tratamiento.
      if (ref.estado === 'sin_respuesta') ref.estado = 'en_tratamiento';
      await legajo.save();

      logAudit(req, 'soe.referral_update',
        [{ type: 'user', id: alumno._id, name: alumno.name }],
        { devolucion: true, destino: ref.destino });
    }
    res.redirect(`/soe/legajo/${alumno._id}#derivaciones`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Cerrar. Exige motivo: un legajo que se cierra sin decir por qué no le sirve a nadie el año
// que viene. No borra NADA — entradas y derivaciones quedan, y reabrir las devuelve.
router.post('/legajo/:id/cerrar', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    const motivo = txt(req.body.cierreMotivo, 500);
    if (!motivo) return res.redirect(`/soe/legajo/${alumno._id}`);

    legajo.estado       = 'cerrado';
    legajo.closedBy     = res.locals.user._id;
    legajo.closedAt     = new Date();
    legajo.cierreMotivo = motivo;
    await legajo.save();

    logAudit(req, 'soe.case_close',
      [{ type: 'user', id: alumno._id, name: alumno.name }], { motivo });

    res.redirect(`/soe/legajo/${alumno._id}`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

router.post('/legajo/:id/reabrir', async (req, res) => {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    const { alumno, legajo } = par;

    legajo.estado   = 'seguimiento';
    legajo.closedBy = null;
    legajo.closedAt = null;
    // cierreMotivo NO se borra: es parte de la historia. Se vuelve a escribir al cerrar.
    await legajo.save();

    logAudit(req, 'soe.case_open',
      [{ type: 'user', id: alumno._id, name: alumno.name }], { reapertura: true });

    res.redirect(`/soe/legajo/${alumno._id}`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

module.exports = router;
