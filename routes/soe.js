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
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const fsp      = require('fs').promises;
const crypto   = require('crypto');

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

const acceso   = require('../services/soeAcceso');
const adjuntos = require('../services/soeAdjuntos');
const agenda   = require('../services/soeAgenda');
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

// La versión MIDDLEWARE de legajoEnScope, para las rutas que reciben un archivo.
//
// Existe por una razón concreta y no por prolijidad: multer escribe el archivo en disco antes
// de que corra el handler. Con la validación adentro del handler, el archivo de alguien que no
// tiene permiso ya está en el servidor cuando se le contesta 403 — y encima habría que saber
// en qué carpeta ponerlo sin haber resuelto todavía de qué legajo se trata. Poniendo la guarda
// en la cadena, ANTES de multer, las dos cosas se resuelven de una vez.
//
// Deja `req.soeLegajo` y `req.soeAlumno` listos para el handler, que así no repite la búsqueda.
async function cargarLegajo(req, res, next) {
  if (idMalo(req, res, 'Legajo no encontrado')) return;
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');
    req.soeLegajo = par.legajo;
    req.soeAlumno = par.alumno;
    next();
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
}

// Deja el snapshot de división al día. No es fuente de verdad (ver models/SoeCase.js): sirve
// para listar y filtrar sin joins, y se refresca cada vez que pasamos por acá igual.
const primeraDivision = (alumno) => (alumno.divisiones && alumno.divisiones.length
  ? oid(alumno.divisiones[0]) : null);

// ── El material del legajo en disco ──────────────────────────────────────────
//
// ⚠️ ESTOS ARCHIVOS NO VIVEN EN /public, Y ES LO MÁS IMPORTANTE DE TODO ESTE BLOQUE.
// Un certificado de salud mental servido por express.static es un certificado que lee
// cualquiera que tenga la URL —o que la adivine—, para siempre y sin dejar registro. Se
// sirven por GET /soe/legajo/:id/adjunto/:adjId, que vuelve a preguntar por el alcance del
// alumno y por el nivel de acceso, igual que la ficha. Mismo criterio que los adjuntos de la
// sala en vivo (routes/rooms.js:811), llevado al dato más sensible de la plataforma.
//
// Estructura: archivos/soe/{schoolId}/{caseId}/{archivo}. Un directorio por legajo: si algún
// día hay que exportar o dar de baja un legajo entero, es un solo rmdir.
const SOE_BASE = path.join(__dirname, '../archivos/soe');

// Nombre en disco sin relación con el que subió la persona. El visible viaja en
// `adjunto.nombre`, y separarlos evita de raíz los dos problemas del nombre original:
// colisiones ("certificado.pdf" de dos alumnos) y path traversal dentro del propio nombre.
const nombreEnDisco = (ext) =>
  Date.now().toString(36) + crypto.randomBytes(4).toString('hex') + ext;

// Busboy (multer) decodifica los headers multipart como latin1, pero los navegadores mandan
// el nombre del archivo en UTF-8: sin esto, "Certificación médica.pdf" llega como
// "CertificaciÃ³n mÃ©dica.pdf". Mismo arreglo que routes/rooms.js:61 y routes/activities.js:97.
const arreglarNombre = (s) => Buffer.from(String(s || ''), 'latin1').toString('utf8');

// Content-Disposition con el nombre real del archivo. El `filename=` ASCII es el fallback
// para clientes viejos; `filename*` en UTF-8 es el que usan los navegadores y el que hace que
// "Certificación médica.pdf" se baje con su nombre. Mismo helper que routes/rooms.js:801 —
// duplicado a propósito, para no crear una dependencia entre dos routers por cuatro líneas.
function disposicion(tipo, nombre) {
  const ascii = String(nombre).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

// Resuelve la ruta en disco de un adjunto y verifica que caiga DENTRO de SOE_BASE.
// `adjunto.path` lo escribimos nosotros y nunca viene del cliente, pero el chequeo se hace
// igual: es una línea, y es la diferencia entre un bug de ese campo y servir /etc/passwd.
function rutaDeAdjunto(relativa) {
  if (!relativa) return null;
  const abs = path.resolve(SOE_BASE, relativa);
  return abs.startsWith(path.resolve(SOE_BASE) + path.sep) ? abs : null;
}

// El directorio de ESTE legajo, relativo a SOE_BASE. Sale de `req.soeLegajo`, que deja
// cargarLegajo — o sea, DESPUÉS de validar el alcance (ver el comentario de multer).
//
// La escuela se toma del LEGAJO y no del usuario: el documento es el dueño del archivo, y si
// alguna vez un legajo termina en manos de un usuario de otra escuela lo que hay que corregir
// es el permiso, no repartir sus archivos en dos carpetas.
const dirDelLegajo = (req) => path.join(
  String(req.soeLegajo.school || 'general'),
  String(req.soeLegajo._id),
);

// ⚠️ EL ORDEN IMPORTA Y ES LA MITIGACIÓN, no un detalle de estilo: multer corre ANTES que el
// handler, así que con la validación de alcance adentro del handler el archivo de alguien sin
// permiso YA ESTARÍA ESCRITO EN DISCO para cuando se contesta 403. Por eso `cargarLegajo` va
// antes de `conAdjunto` en cada ruta, y por eso el destino se resuelve desde req.soeLegajo.
// Es el mismo razonamiento de routes/rooms.js:589 y de middleware/image-upload.js.
const subidor = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(SOE_BASE, dirDelLegajo(req));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) =>
      cb(null, nombreEnDisco(adjuntos.extensionDe(file.originalname))),
  }),
  limits: { fileSize: adjuntos.MAX_ADJUNTO_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = adjuntos.extensionPermitida(file.originalname);
    // ⚠️ `cb(null, false)` y NUNCA `cb(err)`: abortar el cuerpo a mitad de subida mata el
    // pedido SIGUIENTE de ese mismo socket con un "fetch failed" que aparece en una pantalla
    // sin relación (la lección del 2026-08-24, en la memoria de subidas de imagen). Y para
    // que el descarte no sea silencioso —el otro error de aquel día— se anota el motivo acá y
    // el handler lo convierte en un cartel.
    if (!ok) req.adjuntoRechazado = 'formato';
    cb(null, ok);
  },
});

// Envuelve a multer para que un archivo demasiado grande no termine en el "File too large"
// en inglés de multer ni en un 500. Estas rutas son formularios clásicos con redirect (no
// fetch), así que el aviso viaja como query param y lo dibuja la ficha.
function conAdjunto(campo) {
  return (req, res, next) => {
    subidor.single(campo)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') req.adjuntoRechazado = 'grande';
      else req.adjuntoRechazado = 'error';
      // Se sigue igual: el resto del formulario (la entrevista que se acaba de escribir) NO
      // se pierde por culpa del archivo. Se guarda el texto y el cartel explica qué pasó con
      // el papel. Perder cuatro párrafos de una entrevista por un PDF de 25 MB sería el peor
      // de los dos males.
      next();
    });
  };
}

// Borra del disco el archivo que multer ya escribió. Se usa cuando el handler termina
// rechazando el formulario: sin esto quedaría un huérfano que no referencia ningún adjunto.
async function tirarArchivoSubido(req) {
  if (!req.file || !req.file.path) return;
  await fsp.unlink(req.file.path).catch(() => {});
}

// Arma el adjunto que vino en un formulario —el archivo, el enlace, o los dos— y lo empuja al
// array plano del legajo con su ancla. Devuelve cuántos se agregaron.
//
// Vive acá, compartida por las cinco rutas que aceptan material (la entrada del seguimiento,
// la derivación, la devolución, la citación y el alta suelta), porque el olvido de alguna de
// las validaciones en una de ellas ES el bug: es exactamente lo que pasó con las imágenes en
// agosto, cuando la entrega del alumno tenía su propia lista y se quedó atrás.
function adjuntarDelFormulario(req, legajo, ancla, usuario) {
  const tipo = adjuntos.ANCLAS.includes(ancla.tipo) ? ancla.tipo : 'legajo';
  const anclaFinal = { tipo, id: ancla.id || null };

  const categoria = deLista(req.body.categoria, adjuntos.CATEGORIAS, 'otro');
  const origen    = deLista(req.body.origen,    adjuntos.ORIGENES,   'gabinete');
  // La fecha del documento. Sin ella, hoy: es lo que pasa cuando se sube el papel el mismo
  // día que llega, que es la mitad de los casos.
  const cuando    = fecha(req.body.adjuntoFecha) || new Date();
  const descripcion = txt(req.body.adjuntoDescripcion, 1000);

  let agregados = 0;

  if (req.file) {
    const original = arreglarNombre(req.file.originalname);
    legajo.adjuntos.push({
      kind: 'archivo',
      ancla: anclaFinal,
      // El título por defecto es el nombre del archivo: obligar a escribirlo sería fricción
      // en el momento exacto en que la persona está apurada, con el papel en la mano.
      titulo: txt(req.body.adjuntoTitulo, 200) || original.slice(0, 200) || 'Archivo',
      categoria, origen, descripcion,
      fecha: cuando,
      nombre: original.slice(0, 300),
      // Relativo a SOE_BASE: la base puede mudarse de disco sin reescribir la colección.
      path: path.relative(SOE_BASE, req.file.path),
      ext:  adjuntos.extensionDe(original),
      size: req.file.size || 0,
      subidoPor: usuario,
    });
    agregados++;
  }

  const url = adjuntos.normalizarEnlace(req.body.enlace);
  if (url) {
    legajo.adjuntos.push({
      kind: 'enlace',
      ancla: anclaFinal,
      titulo: txt(req.body.enlaceTitulo, 200) || adjuntos.dominioDe(url) || 'Enlace',
      categoria, origen, descripcion,
      fecha: cuando,
      url,
      subidoPor: usuario,
    });
    agregados++;
  }

  return agregados;
}

// El sufijo del redirect cuando el archivo rebotó. Los tres motivos dicen cosas distintas y
// se resuelven de tres maneras distintas: no es lo mismo "ese formato no entra" que "pesa
// demasiado". Un cartel único mandaría a investigar a la capa equivocada.
const avisoDeAdjunto = (req) => (req.adjuntoRechazado ? `?adjunto=${req.adjuntoRechazado}` : '');

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

    // Las citaciones que vienen y las que quedaron sin registrar. Mismo criterio y mismo
    // nivel que los dos bloques de arriba: cada renglón dice a qué familia se citó y para
    // qué, que es lectura de nivel completo.
    //
    // ⚠️ Se arman con `abiertos` y NO con `legajos`: un legajo cerrado no puede tener una
    // citación viva. Cerrarlo no borra la fecha (reabrirlo la devuelve tal cual), pero
    // mientras está cerrado no molesta a nadie — la misma regla que `legajoNecesitaRepaso`.
    const hoyDia = agenda.hoyEscolar();
    const citaciones = !completo ? [] : abiertos.flatMap(l =>
      (l.citaciones || [])
        .filter(c => agenda.citacionSinRegistrar(c, hoyDia) || agenda.citacionProxima(c, hoyDia))
        .map(c => ({
          student:  l.student,
          division: l.division,
          citacion: c,
          sinRegistrar: agenda.citacionSinRegistrar(c, hoyDia),
        })));
    // Lo que quedó sin registrar arriba de todo; después, lo que viene, del día más cercano
    // al más lejano. Es el orden de una bandeja: lo que se pasó de fecha no puede quedar
    // abajo para siempre.
    citaciones.sort((a, b) => (Number(b.sinRegistrar) - Number(a.sinRegistrar))
      || String(a.citacion.dia).localeCompare(String(b.citacion.dia))
      || String(a.citacion.hora || '').localeCompare(String(b.citacion.hora || '')));

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
      citaciones,
      agenda,
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
        // Dos números y no uno: "lo que viene" es agenda y "lo que quedó sin registrar" es
        // una deuda. Sumados en una sola tarjeta, la deuda desaparece adentro del total.
        citaciones:   citaciones.filter(c => !c.sinRegistrar).length,
        citacionesSinRegistrar: citaciones.filter(c => c.sinRegistrar).length,
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

// ── Agenda: GET /soe/agenda ──────────────────────────────────────────────────
//
// El calendario del gabinete. Junta las TRES fechas que hasta ahora vivían en tres pantallas
// distintas —la citación a la familia, el "volver a ver a este chico" y el "volver a
// preguntarle al hospital"— en un solo mes de pared.
//
// requireCompleto por el mismo motivo que /soe/derivaciones y /soe/pedidos: cada renglón
// nombra a un alumno con legajo y dice para qué se citó a su familia. El nivel 'resumen' está
// definido como "sabe que hay un seguimiento en curso, sin saber de qué se trata".
router.get('/agenda', requireCompleto, async (req, res) => {
  try {
    const hoy = agenda.hoyEscolar();
    const mes = agenda.mesValido(req.query.mes) ? req.query.mes : hoy.slice(0, 7);

    const filtro = { school: res.locals.user.school };
    if (!req.soeAlcance.todas) filtro.division = { $in: req.soeAlcance.divisionIds.map(oid) };

    // Se traen TODOS los legajos del alcance con los campos que tienen fecha, y no una query
    // por cada clase de evento. Son decenas por escuela, no miles, y el $or de tres ramas
    // sobre arrays embebidos costaría más de leer que de ejecutar. La proyección deja afuera
    // lo pesado y lo clínico: entries[] no se toca, ni siquiera para descartarla.
    const legajos = await SoeCase.find(filtro)
      .select('student division estado prioridad proximoRepaso citaciones ' +
              'referrals._id referrals.destino referrals.estado referrals.proximoSeguimiento')
      .populate('student', 'name avatar')
      .populate('division', 'name')
      .lean();

    const eventos = legajos.flatMap(l => agenda.eventosDelLegajo(l, hoy));

    res.render('soe/agenda', {
      activePage: 'agenda',
      calendario: agenda.armarCalendario(mes, eventos, hoy),
      // La lista de abajo mira 21 días para adelante: es el horizonte con el que se organiza
      // una semana de entrevistas sin que la lista se vuelva ilegible.
      proximos: agenda.proximos(eventos, hoy, 21),
      atencion: agenda.cuantosPidenAtencion(eventos),
      hoy,
      agenda,
      acceso,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── El archivo de un adjunto: GET /soe/legajo/:id/adjunto/:adjId ─────────────
//
// ⚠️ `:id` ACÁ ES EL ID DEL LEGAJO, no el del alumno. Es la convención de todas las subrutas
// de /soe/legajo (la ficha, que es `/legajo/:id` a secas, sí usa el del alumno).
//
// Esta ruta es el motivo por el que los adjuntos no viven en /public: revalida el alcance del
// alumno contra las divisiones ACTUALES —no contra el snapshot del legajo— y exige nivel
// completo, así que la URL de un certificado no sirve de nada en manos de otra persona.
//
// Va ANTES del `router.use(requireEscrituraSoe)` de más abajo: un directivo con acceso
// completo lee el legajo entero y tiene que poder abrir sus papeles, aunque no pueda escribir
// una coma.
router.get('/legajo/:id/adjunto/:adjId', requireCompleto, async (req, res) => {
  if (idMalo(req, res, 'Archivo no encontrado')) return;
  if (!mongoose.isValidObjectId(req.params.adjId)) {
    return res.status(404).send('Archivo no encontrado');
  }
  try {
    const par = await legajoEnScope(req, req.params.id);
    if (!par) return res.status(403).send('Acceso denegado');

    const adj = par.legajo.adjuntos.id(req.params.adjId);
    if (!adj || adj.kind !== 'archivo') return res.status(404).send('Archivo no encontrado');
    // Dado de baja: el registro sigue en el legajo, el archivo ya no está. 410 y no 404
    // porque son dos cosas distintas y el que las mira desde un log tiene que poder
    // distinguirlas.
    if (adj.eliminadoEl) return res.status(410).send('Este archivo fue dado de baja');

    const abs = rutaDeAdjunto(adj.path);
    // El documento existe pero el archivo no: pasa con un restore parcial o con un borrado a
    // mano en el servidor. 404 con el motivo, no un 500.
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).send('El archivo ya no está disponible');
    }

    // ⚠️ Toda apertura de un adjunto se audita, TAMBIÉN la del propio SOE — al revés que la
    // lectura de la ficha. Un certificado médico abierto es un hecho puntual y raro, no el
    // trabajo diario del gabinete: no llena la auditoría de ruido, y es exactamente el evento
    // que la escuela va a querer poder reconstruir si alguna vez hay una pregunta.
    logAudit(req, 'soe.attachment_view',
      [{ type: 'user', id: par.alumno._id, name: par.alumno.name }],
      { categoria: adj.categoria, nombre: adj.nombre });

    const enLinea = adjuntos.seVeEnLinea(adj.ext);
    // nosniff es obligatorio acá: sin él un navegador podría adivinar el tipo de un archivo
    // subido y ejecutarlo como HTML. La lista cerrada de extensiones ya lo impide; las dos
    // defensas cuestan una línea entre las dos.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition',
      disposicion(enLinea ? 'inline' : 'attachment', adj.nombre || 'archivo'));
    // `private` y corto: es material de salud de un menor. Que no quede en ninguna caché
    // compartida, y que en la del navegador dure lo que dura mirarlo.
    res.setHeader('Cache-Control', 'private, no-store');

    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(500).send('Error al abrir el archivo');
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
    // `hoy` decide qué citaciones ya entran al hilo: las que todavía no llegaron son agenda y
    // no historia (ver services/soeAgenda.js). Se calcula acá, en la ruta, porque
    // construirLinea es pura y no mira el reloj.
    const hoy   = agenda.hoyEscolar();
    const linea = construirLinea(visto, { orden, hoy });

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
      hoy,
      indicadores,
      autores: new Map(autores.map(a => [a._id.toString(), a])),
      nivel,
      acceso,
      adjuntos,
      agenda,
      // El índice de material del legajo: TODOS los papeles, ordenados por la fecha del
      // documento, incluidos los dados de baja (que se dibujan apagados). Es la otra lectura
      // que necesita el gabinete además de la cronológica — "¿qué tenemos de este chico?".
      // Sale del legajo YA SANITIZADO: en nivel resumen `visto.adjuntos` no existe y esto
      // queda en [] sin ninguna regla de confidencialidad propia que mantener al día.
      material: adjuntos.ordenarAdjuntos((visto && visto.adjuntos) || []),
      // Los avisos que puede traer el redirect. Listas blancas cerradas: los valores vienen
      // de la URL y terminan en la pantalla.
      avisoAdjunto: ['formato', 'grande', 'error', 'vacio'].includes(req.query.adjunto)
        ? req.query.adjunto : null,
      avisoCitacion: ['incompleta', 'sinfecha'].includes(req.query.citacion)
        ? req.query.citacion : null,
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

// Una entrada del seguimiento, con el material que la acompañe.
//
// `cargarLegajo` va ANTES de `conAdjunto` a propósito: multer escribe en disco antes del
// handler, así que la validación de alcance tiene que estar en la cadena y no adentro (ver el
// comentario de `subidor` más arriba).
router.post('/legajo/:id/entrada', cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    const texto = txt(req.body.texto, 4000);
    if (!texto) {
      // Sin texto no hay actuación, y un papel colgado de una actuación que no existe no
      // tiene dónde vivir: se tira el archivo que multer ya escribió.
      await tirarArchivoSubido(req);
      return res.redirect(`/soe/legajo/${alumno._id}#linea`);
    }

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

    // El material que vino con la entrevista: el certificado que trajeron, la foto de la
    // libreta, el enlace al informe. Se cuelga de ESTA entrada, cuyo _id ya existe (mongoose
    // lo asigna en el push, antes del save).
    const nuevaEntrada = legajo.entries[legajo.entries.length - 1];
    adjuntarDelFormulario(req, legajo,
      { tipo: 'entrada', id: nuevaEntrada._id }, res.locals.user._id);

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
      { tipo: req.body.tipo || 'nota', adjuntos: req.file ? 1 : 0 });

    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#linea`);
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

// Una derivación externa, con la nota o el formulario con el que se derivó.
router.post('/legajo/:id/derivacion', cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    const destino = txt(req.body.destino, 200);
    if (!destino) {
      await tirarArchivoSubido(req);
      return res.redirect(`/soe/legajo/${alumno._id}#derivaciones`);
    }

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

    // La nota de derivación, el formulario del hospital, el turno que ya dieron.
    const nuevaDerivacion = legajo.referrals[legajo.referrals.length - 1];
    adjuntarDelFormulario(req, legajo,
      { tipo: 'derivacion', id: nuevaDerivacion._id }, res.locals.user._id);

    await legajo.save();

    logAudit(req, 'soe.referral_add',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { destino, tipo: req.body.tipo || 'otro' });

    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#derivaciones`);
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

// ⭐ Una devolución: lo que dijo el lugar al que se lo derivó, y AHORA TAMBIÉN EL PAPEL QUE
// LO RESPALDA — el certificado, la receta, el informe con el que el chico volvió.
//
// Es el caso que motivó toda esta feature. Hasta acá el legajo podía decir "empezó
// tratamiento, trajo una receta"; el año que viene esa frase no sirve para nada. Con el papel
// colgado del mismo hito, sirve.
router.post('/legajo/:id/derivacion/:refId/devolucion',
  cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    const ref = legajo.referrals.id(req.params.refId);
    if (!ref) {
      await tirarArchivoSubido(req);
      return res.status(404).send('Derivación no encontrada');
    }

    const texto = txt(req.body.texto, 2000);
    // ⚠️ El papel PUEDE VENIR SOLO. Antes de esto la devolución exigía texto, y con el
    // certificado adjunto es habitual que no haya nada más que decir que lo que dice el
    // papel: obligar a escribir "adjunto certificado" para poder guardar el certificado es
    // fricción pura, y la alternativa —descartar el archivo en silencio porque el texto vino
    // vacío— es exactamente el bug de las novedades de agosto.
    const hayPapel = !!req.file || !!adjuntos.normalizarEnlace(req.body.enlace);
    if (texto || hayPapel) {
      ref.devoluciones.push({
        fecha: fecha(req.body.fecha) || new Date(),
        // El schema exige texto. Cuando solo vino el papel, se deja dicho eso mismo: es más
        // honesto que una cadena vacía y se lee bien en la línea de tiempo.
        texto: texto || 'Se recibió documentación del servicio.',
        registradoPor: res.locals.user._id,
      });
      const nuevaDevolucion = ref.devoluciones[ref.devoluciones.length - 1];
      adjuntarDelFormulario(req, legajo,
        { tipo: 'devolucion', id: nuevaDevolucion._id }, res.locals.user._id);

      // Si estaba esperando respuesta, ya la tuvo. No se toca ningún otro estado: que el
      // lugar conteste no significa que el chico haya empezado el tratamiento.
      if (ref.estado === 'sin_respuesta') ref.estado = 'en_tratamiento';
      await legajo.save();

      logAudit(req, 'soe.referral_update',
        [{ type: 'user', id: alumno._id, name: alumno.name }],
        { devolucion: true, destino: ref.destino, adjuntos: req.file ? 1 : 0 });
    } else {
      await tirarArchivoSubido(req);
    }
    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#derivaciones`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Material: archivos y enlaces ─────────────────────────────────────────────

// ¿El ancla que dice el formulario existe de verdad en este legajo?
//
// Se verifica contra el documento y no se confía en el `<input type="hidden">`: un ancla
// inventada dejaría el papel colgado de una actuación inexistente, o sea invisible en la
// línea de tiempo aunque el archivo esté guardado. Cuando no resuelve, el material cae en el
// legajo (`tipo: 'legajo'`), que es el cajón general: se sigue viendo en el panel de material
// y no se pierde nada — lo único que se pierde es la asociación que no era válida.
function anclaValida(legajo, tipo, id) {
  const suelto = { tipo: 'legajo', id: null };
  if (!adjuntos.ANCLAS.includes(tipo) || tipo === 'legajo') return suelto;
  if (!mongoose.isValidObjectId(id)) return suelto;

  if (tipo === 'entrada'    && legajo.entries.id(id))    return { tipo, id };
  if (tipo === 'derivacion' && legajo.referrals.id(id))  return { tipo, id };
  if (tipo === 'citacion'   && legajo.citaciones.id(id)) return { tipo, id };
  if (tipo === 'devolucion') {
    // La devolución vive dos niveles adentro (referrals[].devoluciones[]), así que es la
    // única que hay que buscar recorriendo.
    for (const r of legajo.referrals) if (r.devoluciones.id(id)) return { tipo, id };
  }
  return suelto;
}

// Sumar material a una actuación que YA EXISTE. Es el camino del papel que llega después:
// la entrevista fue en marzo y el certificado lo trajeron en mayo.
router.post('/legajo/:id/adjunto', cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    const ancla = anclaValida(legajo, req.body.anclaTipo, req.body.anclaId);
    const cuantos = adjuntarDelFormulario(req, legajo, ancla, res.locals.user._id);

    if (!cuantos) {
      // Ni archivo ni enlace. Si multer ya había anotado por qué rebotó el archivo, ese
      // motivo manda: es más específico que "no mandaste nada".
      const motivo = req.adjuntoRechazado || 'vacio';
      return res.redirect(`/soe/legajo/${alumno._id}?adjunto=${motivo}#material`);
    }

    await legajo.save();

    logAudit(req, 'soe.attachment_add',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { ancla: ancla.tipo, categoria: req.body.categoria || 'otro', archivo: !!req.file });

    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#material`);
  } catch (err) {
    await tirarArchivoSubido(req);
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Dar de baja un adjunto: BORRA EL ARCHIVO DEL DISCO y deja el registro.
//
// ⚠️ Acá NO rige la regla de "solo lo propio" que sí rige para las entradas del seguimiento, y
// la diferencia es deliberada. Aquélla protege la firma profesional de lo que alguien
// escribió: reescribir la entrevista que anotó otra persona borra su palabra. Esto es otra
// cosa —sacar un papel de una carpeta— y el caso que lo justifica es concreto y grave: alguien
// sube por error el certificado de OTRO chico, y quien está de guardia ese día tiene que poder
// sacarlo ya, no cuando vuelva de licencia la colega que lo subió.
//
// Lo que no se pierde es el rastro: quién lo había subido, quién lo dio de baja y cuándo
// quedan en el legajo, y el hecho va a la auditoría.
router.post('/legajo/:id/adjunto/:adjId/eliminar', cargarLegajo, async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    if (!mongoose.isValidObjectId(req.params.adjId)) {
      return res.status(404).send('Material no encontrado');
    }
    const adj = legajo.adjuntos.id(req.params.adjId);
    if (!adj) return res.status(404).send('Material no encontrado');

    // Idempotente: dos clicks en el botón no pueden convertirse en dos bajas distintas.
    if (adj.eliminadoEl) return res.redirect(`/soe/legajo/${alumno._id}#material`);

    adj.eliminadoEl  = new Date();
    adj.eliminadoPor = res.locals.user._id;

    // El archivo se borra DESPUÉS de guardar: si el save falla, el legajo sigue apuntando a un
    // archivo que existe, que es el orden recuperable. Al revés quedaría un adjunto vigente
    // sin archivo, o sea un 404 en la cara del gabinete sin explicación.
    await legajo.save();

    if (adj.kind === 'archivo') {
      const abs = rutaDeAdjunto(adj.path);
      // Se traga el error a propósito: si el archivo ya no estaba, la baja igual tiene que
      // completarse. Un archivo huérfano no le hace daño a nadie; un adjunto que la persona
      // creyó haber dado de baja y sigue abriéndose, sí.
      if (abs) await fsp.unlink(abs).catch(() => {});
    }

    logAudit(req, 'soe.attachment_delete',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { titulo: adj.titulo, categoria: adj.categoria });

    res.redirect(`/soe/legajo/${alumno._id}#material`);
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// ── Citaciones ───────────────────────────────────────────────────────────────

// Citar. El día y la hora son TEXTO y no se convierten nunca a un instante: ver la regla de
// fechas del encabezado de services/soeAgenda.js.
router.post('/legajo/:id/citacion', cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    const dia    = String(req.body.dia || '').trim();
    const motivo = txt(req.body.motivo, 500);
    if (!agenda.diaValido(dia) || !motivo) {
      await tirarArchivoSubido(req);
      return res.redirect(`/soe/legajo/${alumno._id}?citacion=incompleta#citaciones`);
    }

    legajo.citaciones.push({
      dia,
      hora:   agenda.normalizarHora(req.body.hora),
      a:      deLista(req.body.a, agenda.CITADOS, 'familia'),
      motivo,
      lugar:  txt(req.body.lugar, 200),
      medio:  txt(req.body.medio, 200),
      estado: 'programada',
      creadaPor: res.locals.user._id,
    });

    const nueva = legajo.citaciones[legajo.citaciones.length - 1];
    adjuntarDelFormulario(req, legajo, { tipo: 'citacion', id: nueva._id }, res.locals.user._id);

    // Citar a la familia es empezar a seguir al chico, igual que derivarlo.
    if (legajo.estado === 'abierto') legajo.estado = 'seguimiento';

    await legajo.save();

    logAudit(req, 'soe.appointment_add',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { dia, a: req.body.a || 'familia' });

    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#citaciones`);
  } catch (err) {
    await tirarArchivoSubido(req);
    logDeRuta(err, res);
    res.status(500).send('Error del servidor');
  }
});

// Registrar qué pasó con una citación: vino, no vino, se canceló, se pasó para otro día.
//
// Reprogramar CIERRA ésta y abre una nueva, en vez de mover la fecha de la misma. No es un
// capricho: la citación a la que la familia no pudo venir y la del jueves siguiente son dos
// convocatorias distintas, y pisar la fecha borraría del legajo que hubo una primera. Es
// exactamente el dato que se quiere conservar cuando, tres meses después, hay que reconstruir
// cuántas veces se llamó a esta familia.
router.post('/legajo/:id/citacion/:citId', cargarLegajo, conAdjunto('archivo'), async (req, res) => {
  try {
    const alumno = req.soeAlumno;
    const legajo = req.soeLegajo;

    if (!mongoose.isValidObjectId(req.params.citId)) {
      await tirarArchivoSubido(req);
      return res.status(404).send('Citación no encontrada');
    }
    const cita = legajo.citaciones.id(req.params.citId);
    if (!cita) {
      await tirarArchivoSubido(req);
      return res.status(404).send('Citación no encontrada');
    }

    const antes  = cita.estado;
    const estado = deLista(req.body.estado, agenda.ESTADOS_CITACION, cita.estado);
    const nuevoDia = String(req.body.nuevoDia || '').trim();

    // Reprogramar sin decir para cuándo no es reprogramar: se deja la citación como estaba y
    // el formulario vuelve con el aviso.
    if (estado === 'reprogramada' && !agenda.diaValido(nuevoDia)) {
      await tirarArchivoSubido(req);
      return res.redirect(`/soe/legajo/${alumno._id}?citacion=sinfecha#citaciones`);
    }

    cita.estado = estado;
    if (req.body.notas !== undefined) cita.notas = txt(req.body.notas, 2000);
    if (agenda.CITACION_RESUELTA.includes(estado)) {
      cita.resueltaPor = res.locals.user._id;
      cita.resueltaEl  = new Date();
    }

    if (estado === 'reprogramada') {
      legajo.citaciones.push({
        dia:    nuevoDia,
        hora:   agenda.normalizarHora(req.body.nuevaHora),
        a:      cita.a,
        motivo: cita.motivo,
        lugar:  cita.lugar,
        medio:  cita.medio,
        estado: 'programada',
        creadaPor: res.locals.user._id,
      });
    }

    // El acta firmada, la constancia de que la familia se notificó, la foto del cuaderno de
    // comunicaciones. Va colgada de ESTA citación aunque el estado sea 'reprogramada': el
    // papel pertenece al encuentro que se registró, no al que todavía no ocurrió.
    adjuntarDelFormulario(req, legajo, { tipo: 'citacion', id: cita._id }, res.locals.user._id);

    await legajo.save();

    logAudit(req, 'soe.appointment_update',
      [{ type: 'user', id: alumno._id, name: alumno.name }],
      { de: antes, a: cita.estado, ...(estado === 'reprogramada' ? { nuevoDia } : {}) });

    res.redirect(`/soe/legajo/${alumno._id}${avisoDeAdjunto(req)}#citaciones`);
  } catch (err) {
    await tirarArchivoSubido(req);
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
