const express     = require('express');
const multer      = require('multer');
const tar         = require('tar');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const crypto      = require('crypto');
const { pipeline } = require('stream');
const rateLimit   = require('express-rate-limit');
const logger      = require('../config/logger');
const { requireAuth }       = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superadmin');
const { invalidateAll }     = require('../middleware/cache');
const { logAudit }          = require('../middleware/audit');
const {
  getMaintenanceState, getPendingState, readRawState, restoreRawState,
  setMaintenanceOn, setMaintenancePending, setMaintenanceOff, SYSTEM_OWNER_EMAIL,
} = require('../config/maintenance');
const {
  normalizeIdleMinutes, normalizeMaxWait, countActiveUsers, listActiveUsers,
  minutesAgo, deadlineOf, ACTIVITY_LIST_MAX, IDLE_DEFAULT_MIN,
} = require('../services/maintenanceWindow');
const {
  analizarCarpetas, comprimirArbol, gsDisponible, sharpDisponible, TIPOS_COMPRIMIBLES,
} = require('../services/backupCompressor');
const {
  normalizarDestino, leerDestino, leerPassword, tienePasswordGuardada,
  puedeGuardarPassword, guardarDestino, olvidarDestino, DestinoInvalido, MODOS,
} = require('../config/ftpDestino');
const {
  probarConexion, enviarBackup, limpiarParcial, mensajeDeError,
} = require('../services/backupFtp');

const School       = require('../models/School');
const User         = require('../models/User');
const Course       = require('../models/Course');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const Announcement = require('../models/Announcement');
const Suggestion    = require('../models/Suggestion');
const Division      = require('../models/Division');
const Subject       = require('../models/Subject');
const RoomSession   = require('../models/RoomSession');
const RoomMessage   = require('../models/RoomMessage');
const RoomPresence  = require('../models/RoomPresence');
const AttendanceSession = require('../models/AttendanceSession');
const AttendanceMark    = require('../models/AttendanceMark');
const { logDeRuta } = require('../middleware/route-log');

const router = express.Router();

// Mismas rutas base que routes/activities.js / routes/admin.js / routes/announcements.js
// (no hay un config compartido para esto en el proyecto; se repite el patrón existente).
//
// Overrideables por env var con el mismo criterio que MAINTENANCE_FILE en
// config/maintenance.js: es lo único que permite testear el armado del backup contra un
// árbol de fixtures de unos KB en vez de los ~900 MB reales del servidor. En producción
// no se setean nunca.
const ARCHIVOS_BASE = process.env.BACKUP_ARCHIVOS_BASE || path.join(__dirname, '../public/archivos');
const ENTREGAS_BASE = process.env.BACKUP_ENTREGAS_BASE || path.join(__dirname, '../archivos/entregas');

// Backups de seguridad pre-restore: persisten en disco (no en /tmp) para no perderse
// ante un reinicio del servidor. Nunca se commitean (ver .gitignore).
const BACKUPS_DIR = path.join(__dirname, '../backups');

// Directorio compartido para subidas de restore en preview. Vive en el filesystem
// (no en memoria) a propósito: en PM2 cluster cada worker tiene su propia memoria,
// pero TODOS comparten el mismo disco — así el POST /preview puede atender un worker
// distinto al POST /restore sin perder el archivo subido.
const UPLOADS_DIR = path.join(os.tmpdir(), 'classroom-backup-uploads');

const BACKUP_FORMAT_VERSION = '1.0';
const UPLOAD_TTL_MS = 30 * 60 * 1000; // 30 min

// Tope de subida del restore. El backup crece con los adjuntos y las entregas (ya pasó
// los 500 MB del tope original), así que el default es amplio y queda configurable por
// si en algún momento hace falta apretarlo. multer escribe a disco a medida que recibe,
// no acumula en memoria: el límite real es el espacio libre en os.tmpdir().
const MAX_UPLOAD_MB = Number(process.env.BACKUP_MAX_UPLOAD_MB) || 4096; // 4 GB

// Todas las colecciones que entran en el backup. Un solo array evita repetir la lista
// en el dump, el restore y el cálculo de "diff" del preview.
//
// `optional: true` marca las colecciones que NACIERON DESPUÉS de que se congeló el formato
// 1.0. Un backup viejo, perfectamente sano, no las trae — y eso no lo invalida: significa
// "en esa fecha esto no existía", no "el archivo está roto". Sin esta marca el preview las
// exigía a todas y rechazaba con 400 cualquier backup anterior, incluidos los pre-restore
// que el propio /restore genera como red de seguridad.
//
// Las NO opcionales se siguen exigiendo, y ese es el punto: un backup truncado al que le
// falte `users` tiene que seguir siendo rechazado, porque restaurarlo vaciaría la tabla de
// usuarios en silencio. La marca distingue "todavía no existía" de "falta y no debería".
//
// Al agregar una colección nueva: va acá con optional: true, y se queda así.
const COLLECTIONS = [
  { name: 'schools',       model: School },
  { name: 'users',         model: User },
  { name: 'courses',       model: Course },
  { name: 'activities',    model: Activity },
  { name: 'submissions',   model: Submission },
  { name: 'announcements', model: Announcement },
  { name: 'suggestions',   model: Suggestion },
  { name: 'divisions',     model: Division },
  { name: 'subjects',      model: Subject },
  // Sala en vivo. Van las tres juntas y no se separan: una transcripción sin su sesión no
  // se puede fechar ni atribuir a una materia, y la asistencia sin la sesión no dice de qué
  // clase es. Ojo: esta lista es el ÚNICO lugar que decide qué se respalda — el backup no es
  // un mongodump. Una colección que no esté acá no se guarda y nadie se entera hasta que
  // hace falta restaurarla.
  { name: 'roomsessions',  model: RoomSession,  optional: true },
  { name: 'roommessages',  model: RoomMessage,  optional: true },
  { name: 'roompresences', model: RoomPresence, optional: true },
  // Asistencia de preceptoría. También van juntas: una marca sin su toma no se puede fechar
  // ni atribuir a un curso. Es de las colecciones que MÁS caro sale perder — la asistencia es
  // justamente lo que se consulta meses después, y no se purga nunca.
  { name: 'attendancesessions', model: AttendanceSession, optional: true },
  { name: 'attendancemarks',    model: AttendanceMark,    optional: true },
];

// Colecciones que el backup NO trae, separadas por si se pueden tolerar o no. La usan el
// preview (para avisar) y el restore (para loguear), así el aviso y lo que después pasa de
// verdad salen del mismo cálculo y no se pueden desincronizar.
function collectionsMissingFrom(manifest) {
  const present = manifest?.collections || {};
  const missing = COLLECTIONS.filter(c => !(c.name in present));
  return {
    required: missing.filter(c => !c.optional).map(c => c.name),
    optional: missing.filter(c =>  c.optional).map(c => c.name),
  };
}

// Doble capa de autorización: superadmin (rol) + el email específico (SYSTEM_OWNER_EMAIL,
// compartido con el middleware de mantenimiento). Backup/restore/mantenimiento son las
// operaciones más sensibles del sistema — no alcanza con el chequeo de rol solo, por si
// en el futuro se crea otro superadmin.
function requireBackupAccess(req, res, next) {
  if (res.locals.user?.email !== SYSTEM_OWNER_EMAIL) {
    return res.status(403).send('Acceso denegado');
  }
  next();
}

router.use(requireAuth, requireSuperAdmin, requireBackupAccess);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de filesystem
// ─────────────────────────────────────────────────────────────────────────────

// Cuenta archivos y bytes de un directorio recursivamente. Usado tanto para las stats
// de la pantalla ("qué se va a incluir") como para la metadata del manifest.
function getDirStats(dir) {
  let count = 0, sizeBytes = 0;
  if (!fs.existsSync(dir)) return { count, sizeBytes };
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else { count++; sizeBytes += fs.statSync(full).size; }
    }
  };
  walk(dir);
  return { count, sizeBytes };
}

// Copia un directorio completo a destino y devuelve sus stats. Si el origen no existe
// (ej. archivos/entregas/ vacío en una escuela nueva), crea el destino vacío igual —
// así el tar siempre tiene la carpeta "files/entregas" aunque no haya nada adentro.
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  return getDirStats(dest);
}

// Deja `dest` apuntando al contenido de `src` con un enlace, en vez de copiarlo. El tar se
// arma con `follow: true`, así que empaqueta el contenido real y el .tar.gz sale idéntico
// al que producía copyDir — mismas rutas `files/archivos/...`, backups intercambiables.
//
// Existe porque copiar los archivos al staging es la parte más cara del backup con
// diferencia: medido sobre la base real, 909 MB copiados a os.tmpdir() para después
// empaquetarlos y borrarlos. En producción os.tmpdir() es /tmp, que en Ubuntu moderno es
// tmpfs — o sea RAM. Con el enlace el staging pesa lo que pesan los JSON de la BD.
//
// Verificado antes de usarlo: fs.rmSync(staging, { recursive: true }) borra el ENLACE, no
// el destino (lstat lo ve como symlink y lo desenlaza). Si algún día se cambia la limpieza
// del staging por otra cosa, hay que volver a verificar eso — seguir el enlace acá
// significaría borrar public/archivos y archivos/entregas del servidor.
function linkDir(src, dest) {
  // Origen inexistente (ej. entregas/ vacío en una escuela nueva): carpeta real vacía, para
  // que el tar igual tenga la entrada y el restore no encuentre un hueco donde esperaba algo.
  if (!fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  fs.symlinkSync(path.resolve(src), dest, process.platform === 'win32' ? 'junction' : 'dir');
}

// Mueve un archivo entre dos ubicaciones que pueden estar en filesystems distintos
// (ej. os.tmpdir() vs BACKUPS_DIR dentro del repo — en producción suelen ser mounts
// distintos, ahí fs.renameSync tira EXDEV: "cross-device link not permitted"). rename()
// es atómico y no copia bytes cuando ambos paths están en el mismo device, así que se
// intenta primero y solo se cae a copiar+borrar si hace falta cruzar de filesystem.
function moveFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// Reemplaza un directorio completo con el contenido extraído del backup. Usa cpSync
// (no rename) porque el extractDir puede estar en otro filesystem/unidad que el destino
// (relevante en Windows dev; en Linux prod ambos suelen estar en el mismo disco pero
// cpSync funciona igual en cualquier caso, a costo de una copia extra).
function replaceDir(extractedSubdir, targetDir) {
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.existsSync(extractedSubdir)) fs.cpSync(extractedSubdir, targetDir, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generación del backup (compartida entre /download y el pre-restore de seguridad)
// ─────────────────────────────────────────────────────────────────────────────

// Nivel de gzip deliberadamente bajo. Medido sobre la base real: el contenido son JPEG,
// PNG y PDF, que ya vienen comprimidos, así que el gzip por defecto (nivel 6) baja 909 MB
// a 848 MB — un 6,6% — a cambio de 20 s de CPU en cada backup. El nivel 1 consigue
// prácticamente el mismo tamaño por una fracción del costo, y con el tar saliendo en
// streaming la CPU es justamente lo que marca el ritmo de la descarga.
const GZIP_LEVEL = { level: 1 };

// Contenido del backup listo para empaquetar: los JSON de cada colección + el manifest +
// los dos árboles de archivos bajo `files/`. Devuelve el directorio de staging; el caller
// decide si lo empaqueta a un archivo (createBackupTarball) o lo streamea (GET /download),
// y es SIEMPRE responsable de borrarlo después.
//
// `comprimir` ({ imagenes, pdf }) reencodea los archivos YA COPIADOS al staging, nunca los
// originales del servidor. Por defecto no comprime nada, y eso es deliberado: el backup de
// seguridad pre-restore usa esta misma función y tiene que guardar los archivos tal cual
// están — es la red de seguridad, no el lugar para ahorrar espacio.
async function buildBackupStaging(generatedByEmail, { comprimir = null } = {}) {
  const createdAt  = new Date();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-backup-staging-'));

  try {
    const dbDir = path.join(stagingDir, 'db');
    fs.mkdirSync(dbDir);

    const collectionsMeta = {};
    for (const { name, model } of COLLECTIONS) {
      const docs = await model.find({}).lean();
      fs.writeFileSync(path.join(dbDir, `${name}.json`), JSON.stringify(docs));
      collectionsMeta[name] = docs.length;
    }

    const filesDir = path.join(stagingDir, 'files');
    fs.mkdirSync(filesDir);

    let compresion = null;
    let archivosMeta, entregasMeta;

    if (comprimir && (comprimir.imagenes || comprimir.pdf)) {
      // Comprimir REESCRIBE los archivos, así que este camino sí necesita una copia propia:
      // tocar los originales del servidor sería destruir la calidad de lo que está en línea.
      copyDir(ARCHIVOS_BASE, path.join(filesDir, 'archivos'));
      copyDir(ENTREGAS_BASE, path.join(filesDir, 'entregas'));

      // Comprimir DESPUÉS de copiar y ANTES de empaquetar. Los nombres y extensiones no
      // cambian (ver services/backupCompressor.js), así que el restore no necesita saber
      // que esto pasó: las rutas guardadas en Mongo siguen apuntando a donde tienen que ir.
      compresion = await comprimirArbol(filesDir, comprimir);

      // Las stats se recalculan recién ahora, para que el manifest declare el peso REAL de
      // lo que quedó adentro y no el de antes de comprimir.
      archivosMeta = getDirStats(path.join(filesDir, 'archivos'));
      entregasMeta = getDirStats(path.join(filesDir, 'entregas'));
    } else {
      // Camino normal, el de todos los días: no se copia un solo byte. El staging apunta a
      // los originales y el tar los sigue. Las stats se miden sobre el origen porque es
      // literalmente lo mismo que va a entrar al paquete.
      linkDir(ARCHIVOS_BASE, path.join(filesDir, 'archivos'));
      linkDir(ENTREGAS_BASE, path.join(filesDir, 'entregas'));
      archivosMeta = getDirStats(ARCHIVOS_BASE);
      entregasMeta = getDirStats(ENTREGAS_BASE);
    }

    const manifest = {
      version:     BACKUP_FORMAT_VERSION,
      createdAt:   createdAt.toISOString(),
      appVersion:  require('../package.json').version,
      generatedBy: generatedByEmail,
      collections: collectionsMeta,
      files: { archivos: archivosMeta, entregas: entregasMeta },
      // Campo OPCIONAL. La versión del formato sigue siendo 1.0 a propósito: subirla haría
      // que POST /preview rechace todos los backups ya generados (los pre-restore de
      // backups/ y los que el dueño tenga descargados). Un backup viejo simplemente no
      // trae esta clave, y la pantalla de restore la muestra solo si está.
      compresion,
    };
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
    return { stagingDir, manifest, stamp };
  } catch (err) {
    // El caller no llegó a recibir el path, así que no puede limpiarlo él.
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

// Empaqueta el backup a un .tar.gz en disco y devuelve su ruta. Lo usa el backup de
// seguridad que /restore genera antes de pisar nada: ese SÍ necesita un archivo, porque
// termina guardado en backups/. La descarga del dueño no pasa por acá — streamea.
async function createBackupTarball(generatedByEmail, opts = {}) {
  const { stagingDir, manifest, stamp } = await buildBackupStaging(generatedByEmail, opts);
  try {
    const tarPath = path.join(os.tmpdir(), `classroom-backup-${stamp}.tar.gz`);
    await tar.c(
      { gzip: GZIP_LEVEL, cwd: stagingDir, file: tarPath, follow: true },
      ['manifest.json', 'db', 'files'],
    );
    return { tarPath, manifest, stamp };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pantalla + stats
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.render('superadmin/backup', { activePage: 'backup' });
});

// GET /superadmin/backup/stats — contadores en vivo para la card "qué se va a incluir"
router.get('/stats', async (req, res) => {
  try {
    const collections = {};
    for (const { name, model } of COLLECTIONS) {
      collections[name] = await model.countDocuments();
    }
    res.json({
      collections,
      files: {
        archivos: getDirStats(ARCHIVOS_BASE),
        entregas: getDirStats(ENTREGAS_BASE),
      },
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /superadmin/backup/file-stats — desglose por tipo de archivo, para el modal que
// decide qué comprimir. Separado de /stats porque ese devuelve contadores de colecciones
// y este recorre el disco (cacheado 60s dentro del servicio).
router.get('/file-stats', async (req, res) => {
  try {
    const desglose = await analizarCarpetas([
      { dir: ARCHIVOS_BASE, label: 'Adjuntos y avatares' },
      { dir: ENTREGAS_BASE, label: 'Entregas de alumnos' },
    ]);
    res.json({
      ...desglose,
      // La pantalla necesita saber por qué un tipo no se puede comprimir en ESTE servidor:
      // sharp y Ghostscript son binarios del sistema y pueden no estar instalados.
      herramientas: {
        imagenes: sharpDisponible(),
        pdf:      await gsDisponible(),
      },
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Descarga de backup
// ─────────────────────────────────────────────────────────────────────────────

// Traduce ?comprimir=imagenes,pdf a { imagenes: true, pdf: true }. Filtra contra la lista
// blanca del servicio: lo que venga en la query nunca se usa como clave directa.
//
// Acepta también un array, porque el envío por FTP manda la opción en un body JSON
// (["imagenes","pdf"]) y no en la query string. Es la misma decisión, tomada en dos
// pantallas distintas: conviene que la valide un solo lugar.
function parseComprimir(pedido) {
  const pedidos = (Array.isArray(pedido) ? pedido : String(pedido || '').split(','))
    .map(s => String(s).trim()).filter(Boolean);
  if (!pedidos.length) return null;
  const opciones = {};
  for (const id of TIPOS_COMPRIMIBLES) {
    if (pedidos.includes(id)) opciones[id] = true;
  }
  return Object.keys(opciones).length ? opciones : null;
}

// El .tar.gz se STREAMEA a medida que se arma; no se materializa en disco primero.
//
// Antes esta ruta escribía el paquete completo en os.tmpdir() y recién ahí lo mandaba con
// res.download(). Con la base real eso pedía 1,76 GB de espacio temporal (909 MB copiados
// + 848 MB de paquete) y dejaba al navegador 23 s sin recibir un solo byte. En producción
// os.tmpdir() es /tmp sobre tmpfs, o sea RAM del servidor, compartida además con el otro
// stack que vive en esa máquina.
//
// Streameando, el pico de disco temporal es el de los JSON de la BD (unos pocos MB) y los
// primeros bytes salen casi de inmediato, así que ningún proxy intermedio ve la conexión
// callada el tiempo suficiente como para cortarla.
router.get('/download', async (req, res) => {
  const comprimir = parseComprimir(req.query.comprimir);

  // Sin esto, comprimir 346 imágenes + 247 PDFs (varios minutos de CPU) choca contra el
  // timeout por defecto del socket y el navegador recibe una descarga cortada a la mitad.
  // El backup ya era la request más larga del sistema; con compresión lo es bastante más.
  req.setTimeout(0);
  res.setTimeout(0);

  let stagingDir = null;
  const limpiarStaging = () => {
    if (!stagingDir) return;
    const dir = stagingDir;
    stagingDir = null; // idempotente: 'close' y 'error' pueden dispararse los dos
    fs.rm(dir, { recursive: true, force: true }, () => {});
  };

  try {
    const built = await buildBackupStaging(res.locals.user.email, { comprimir });
    stagingDir  = built.stagingDir;

    // Nombre distinto cuando se comprimió: al restaurarlo, este backup reemplaza los
    // archivos del servidor por las versiones más livianas. Conviene poder distinguirlo
    // de un backup íntegro de un vistazo, sin abrirlo.
    const filename = comprimir
      ? `classroom-backup-comprimido-${built.stamp}.tar.gz`
      : `classroom-backup-${built.stamp}.tar.gz`;

    // Log ANTES de streamear al cliente: si la transferencia se corta, el backup igual se
    // generó. No queremos ausencia de log por un fallo de red.
    logAudit(req, 'system.backup_create', [],
      {
        archivo:  filename,
        version:  built.manifest?.version || '',
        ...(built.manifest?.collections ? {
          usuarios: built.manifest.collections.users || 0,
          cursos:   built.manifest.collections.courses || 0,
        } : {}),
        ...(built.manifest?.compresion ? {
          comprimido: Object.keys(comprimir).join(', '),
          ahorroBytes:
            (built.manifest.compresion.imagenes.antes + built.manifest.compresion.pdf.antes) -
            (built.manifest.compresion.imagenes.despues + built.manifest.compresion.pdf.despues),
        } : {}),
      },
    );

    // El manifest completo viaja en un header porque ya se conoce ANTES del primer byte del
    // paquete: el modal de compresión lo lee para mostrar cuánto se ahorró de verdad.
    res.setHeader('X-Backup-Manifest', encodeURIComponent(JSON.stringify(built.manifest)));
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Sin Content-Length (el tamaño final no se sabe hasta terminar de comprimir): la
    // respuesta sale chunked. Eso es lo que hace que una descarga interrumpida se vea como
    // interrumpida, en vez de como un .tar.gz truncado que parece completo. En un backup,
    // esa diferencia importa más que la barra de progreso que se pierde.

    const paquete = tar.c(
      { gzip: GZIP_LEVEL, cwd: built.stagingDir, follow: true },
      ['manifest.json', 'db', 'files'],
    );

    // pipeline y no .pipe(): se encarga de destruir las dos puntas ante cualquier final.
    // Con .pipe() pelado, un cliente que abandona la descarga a los 5 s deja al tar leyendo
    // y comprimiendo los 900 MB restantes contra un socket muerto, y ante un error del tar
    // el navegador recibiría una descarga cortada que igual parece terminada.
    pipeline(paquete, res, (err) => {
      limpiarStaging();
      if (!err) return;
      // ECONNRESET / ERR_STREAM_PREMATURE_CLOSE = el cliente cortó. Es normal (cerró la
      // pestaña, canceló la descarga) y no tiene por qué ensuciar el log de errores.
      if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err.code)) return;
      logger.error('backup: fallo al empaquetar', { error: err.message, code: err.code });
    });
  } catch (err) {
    limpiarStaging();
    if (!res.headersSent) {
      logDeRuta(err, res);
      res.status(500).json({ error: err.message || 'Error al generar el backup' });
    } else {
      res.destroy(err);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Envío del backup por FTP a otra máquina (típicamente la PC del dueño, por Tailscale)
// ─────────────────────────────────────────────────────────────────────────────
//
// Existe porque bajar ~850 MB por el navegador a través del Funnel es la parte frágil del
// backup: cualquier corte obliga a empezar de cero y el dueño se entera tarde. Empujando
// el paquete directo por el túnel de Tailscale, la transferencia va de máquina a máquina y
// esta pantalla solo mira el progreso.
//
// Recordatorio de la dirección de la flecha (ver services/backupFtp.js): este servidor es
// el CLIENTE. La PC que recibe tiene que estar corriendo un servidor FTP.

// Arma el destino efectivo mezclando lo que vino del formulario con lo guardado en disco.
// Sirve a los dos botones: "Probar conexión" (datos tipeados, todavía sin guardar) y
// "Enviar backup ahora" (formulario vacío, todo desde la configuración guardada).
function resolverDestinoDeRequest(body = {}) {
  const tipeoHost = body.host !== undefined && body.host !== null && String(body.host).trim() !== '';
  const base = tipeoHost ? normalizarDestino(body) : leerDestino();

  if (!base) {
    throw new DestinoInvalido(
      'Todavía no hay ningún destino FTP configurado. Completá los datos de la PC que va a recibir el backup.',
    );
  }

  const tipeada = typeof body.password === 'string' ? body.password : '';
  if (tipeada) return { ...base, password: tipeada };

  // La contraseña guardada SOLO se reusa contra el mismo servidor para el que se guardó.
  // Si el dueño cambió el host, el usuario o el puerto, está apuntando a otra máquina y
  // mandarle igual la credencial de la anterior sería filtrarla por un error de tipeo.
  const guardado = leerDestino();
  const mismoServidor = guardado
    && guardado.host === base.host
    && guardado.puerto === base.puerto
    && guardado.usuario === base.usuario;

  if (!mismoServidor) {
    throw new DestinoInvalido('Escribí la contraseña del servidor FTP (es un destino distinto al guardado).');
  }

  const { hay, password } = leerPassword();
  if (!hay) {
    throw new DestinoInvalido('Escribí la contraseña del servidor FTP (no hay ninguna guardada).');
  }
  if (password === null) {
    throw new DestinoInvalido(
      'La contraseña guardada no se puede descifrar. Suele pasar cuando cambió JWT_SECRET en el ' +
      'servidor: escribila de nuevo y volvé a guardarla.',
    );
  }
  return { ...base, password };
}

// GET /superadmin/backup/ftp/config — el destino guardado. La contraseña NUNCA vuelve al
// navegador, ni cifrada: la pantalla solo necesita saber si hay una guardada o no.
router.get('/ftp/config', (req, res) => {
  res.json({
    destino:              leerDestino(),
    tienePassword:        tienePasswordGuardada(),
    puedeGuardarPassword: puedeGuardarPassword(),
    modos:                MODOS,
  });
});

router.post('/ftp/config', (req, res) => {
  try {
    // Los tres casos que el formulario puede pedir, y por qué el tercero importa:
    //   guardarPassword false             → borrar la guardada
    //   guardarPassword true + campo lleno→ guardar esa
    //   guardarPassword true + campo VACÍO→ no tocar nada
    // El tercero es el que evita el accidente más probable: el navegador no rellena los
    // campos password, así que guardar el destino después de cambiar solo la carpeta
    // llegaría con el campo vacío y borraría la contraseña sin que nadie lo pidiera.
    const opciones = {};
    if (req.body.guardarPassword === false) opciones.password = null;
    else if (req.body.guardarPassword === true && String(req.body.password || '')) {
      opciones.password = String(req.body.password);
    }

    const destino = guardarDestino(req.body, opciones);

    logAudit(req, 'system.backup_ftp_config', [], {
      destino:  `${destino.host}:${destino.puerto}${destino.directorio}`,
      usuario:  destino.usuario,
      modo:     destino.modo,
      contrasena_guardada: tienePasswordGuardada(),
    });

    res.json({ ok: true, destino, tienePassword: tienePasswordGuardada() });
  } catch (err) {
    if (err instanceof DestinoInvalido) return res.status(400).json({ error: err.message });
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo guardar el destino FTP' });
  }
});

router.delete('/ftp/config', (req, res) => {
  olvidarDestino();
  logAudit(req, 'system.backup_ftp_config', [], { olvidado: true });
  res.json({ ok: true });
});

// Abrir conexiones salientes a un host arbitrario es la parte de esta feature con más
// filo: aunque solo la alcanza el dueño, un limitador la deja lejos de poder usarse para
// tantear puertos ajenos. 20 pruebas cada 10 minutos es holgado para una persona.
const probarFtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas pruebas de conexión seguidas. Esperá unos minutos.' },
});

// POST /superadmin/backup/ftp/probar — verifica que se pueda LOGUEAR y ESCRIBIR.
// Probar solo el login sería engañoso: IIS crea el sitio FTP en modo lectura por defecto,
// y descubrirlo recién a los 800 MB transferidos sería la peor forma de enterarse.
router.post('/ftp/probar', probarFtpLimiter, async (req, res) => {
  let destino;
  try {
    destino = resolverDestinoDeRequest(req.body);
  } catch (err) {
    if (err instanceof DestinoInvalido) return res.status(400).json({ error: err.message });
    logDeRuta(err, res);
    return res.status(500).json({ error: 'No se pudo preparar la prueba' });
  }

  try {
    const resultado = await probarConexion(destino);
    res.json({ ok: true, host: destino.host, puerto: destino.puerto, ...resultado });
  } catch (err) {
    // 502 y no 400: la request estaba bien formada, lo que falló es la máquina del otro
    // lado. El mensaje ya viene traducido a algo accionable (ver services/backupFtp.js).
    logger.warn('backup FTP: falló la prueba de conexión', {
      host: destino.host, puerto: destino.puerto, modo: destino.modo,
      error: err.message, code: err.code,
    });
    res.status(502).json({ error: mensajeDeError(err, destino) });
  }
});

// Tope bajo a propósito, mismo criterio que el de /restore: protege más contra el
// doble-clic y el bug que contra el abuso. NO hay lock entre workers de PM2 y es
// deliberado: dos envíos simultáneos son caros pero inofensivos (el nombre lleva
// timestamp, no se pisan), mientras que un lock trabado por un proceso muerto dejaría al
// dueño sin poder mandar el backup justo el día que lo necesita.
const enviarFtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados envíos por FTP en la última hora. Esperá un rato.' },
});

// POST /superadmin/backup/ftp/enviar — arma el backup y lo empuja al destino.
//
// Responde con un stream NDJSON (un evento JSON por línea) en vez de un JSON al final:
// el envío puede durar una hora y el dueño necesita ver que avanza. Consecuencia a tener
// presente: los headers salen ANTES de saber si va a funcionar, así que un fallo posterior
// viaja como evento `fin` con ok:false y no como status HTTP. Todo lo que se puede validar
// antes de ese punto se valida antes, y ESO sí sale como 400.
router.post('/ftp/enviar', enviarFtpLimiter, async (req, res) => {
  // Mismo motivo que en /download, multiplicado: acá el tiempo total es el del empaquetado
  // MÁS el de la transferencia por un enlace hogareño.
  req.setTimeout(0);
  res.setTimeout(0);

  let destino;
  try {
    destino = resolverDestinoDeRequest(req.body);
  } catch (err) {
    if (err instanceof DestinoInvalido) return res.status(400).json({ error: err.message });
    logDeRuta(err, res);
    return res.status(500).json({ error: 'No se pudo preparar el envío' });
  }

  const comprimir = parseComprimir(req.body.comprimir);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no'); // por si algún día hay un nginx adelante
  res.flushHeaders();

  const escribir = (evento) => {
    if (res.writableEnded) return;
    res.write(JSON.stringify(evento) + '\n');
    // app.use(compression()) es global: sin este flush los eventos quedarían esperando en
    // el buffer de zlib y el progreso llegaría todo junto al final, que es justo lo que
    // esta ruta existe para evitar. `res.flush` lo agrega ese middleware; si algún día la
    // respuesta deja de pasar por él, el guard hace que esto siga siendo válido.
    if (typeof res.flush === 'function') res.flush();
  };

  const ac       = new AbortController();
  const arranque = Date.now();
  let stagingDir = null, latido = null, paquete = null, nombre = null, bytes = 0;

  const limpiarStaging = () => {
    clearInterval(latido);
    if (!stagingDir) return;
    const dir = stagingDir;
    stagingDir = null; // idempotente: puede llamarse desde el catch y desde el finally
    fs.rm(dir, { recursive: true, force: true }, () => {});
  };

  // El dueño cerró la pestaña o apretó "Cancelar": se corta el FTP y el empaquetado. Sin
  // esto el servidor seguiría comprimiendo y subiendo cientos de MB que ya nadie espera.
  res.on('close', () => {
    if (res.writableEnded) return;
    ac.abort();
    if (paquete) paquete.destroy();
  });

  try {
    escribir({ tipo: 'estado', mensaje: comprimir ? 'Armando y comprimiendo el backup…' : 'Armando el backup…' });

    const built = await buildBackupStaging(res.locals.user.email, { comprimir });
    stagingDir  = built.stagingDir;
    nombre = comprimir
      ? `classroom-backup-comprimido-${built.stamp}.tar.gz`
      : `classroom-backup-${built.stamp}.tar.gz`;

    // Log ANTES de transferir, mismo criterio que GET /download: el hecho auditable es que
    // se generó un backup y que salió del servidor hacia otra máquina. Si la transferencia
    // se corta a la mitad, esos bytes salieron igual y tienen que estar registrados.
    logAudit(req, 'system.backup_ftp', [], {
      archivo: nombre,
      destino: `${destino.host}:${destino.puerto}${destino.directorio}`,
      modo:    destino.modo,
      ...(comprimir ? { comprimido: Object.keys(comprimir).join(', ') } : {}),
    });

    // Estimación para la barra de progreso: el .tar.gz pesa casi lo mismo que los archivos
    // que mete adentro, porque son JPEG/PNG/PDF ya comprimidos y el gzip va en nivel 1.
    const estimadoBytes = (built.manifest?.files?.archivos?.sizeBytes || 0)
                        + (built.manifest?.files?.entregas?.sizeBytes || 0);

    escribir({
      tipo: 'inicio', archivo: nombre, host: destino.host, puerto: destino.puerto,
      directorio: destino.directorio, estimadoBytes,
    });

    // Latido cada 2 s. No es cosmético: entre este servidor y el navegador hay un proxy
    // (Tailscale Funnel) que corta las conexiones calladas, y con un enlace lento el
    // contador de bytes puede tardar bastante en moverse.
    latido = setInterval(() => escribir({ tipo: 'progreso', bytes, ms: Date.now() - arranque }), 2000);

    // El paquete se streamea directo al socket FTP: nunca toca el disco del servidor.
    paquete = tar.c(
      { gzip: GZIP_LEVEL, cwd: built.stagingDir, follow: true },
      ['manifest.json', 'db', 'files'],
    );

    const resultado = await enviarBackup({
      destino, nombre, origen: paquete,
      onProgress: (b) => { bytes = b; },
      senal: ac.signal,
    });

    clearInterval(latido);
    escribir({ tipo: 'fin', ok: true, bytes, remoto: resultado.remoto, ms: Date.now() - arranque });
  } catch (err) {
    clearInterval(latido);
    const cancelado = ac.signal.aborted;

    if (!cancelado) {
      logger.error('backup FTP: falló el envío', {
        host: destino.host, archivo: nombre, bytes, error: err.message, code: err.code,
      });
    }
    escribir(cancelado
      ? { tipo: 'fin', ok: false, cancelado: true, error: 'Envío cancelado', bytes }
      : { tipo: 'fin', ok: false, error: mensajeDeError(err, destino), bytes });

    // El .part que quedó del lado del destino se limpia en una conexión nueva, sin esperarlo:
    // la respuesta ya terminó y que la limpieza falle no cambia nada para el dueño (el
    // archivo se ve, dice ".part" y se borra a mano).
    if (nombre && bytes > 0) limpiarParcial(destino, nombre).catch(() => {});
  } finally {
    limpiarStaging();
    if (!res.writableEnded) res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview de un backup subido (sin aplicar nada todavía)
// ─────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const uploadTar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + '.part'),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(tar\.gz|tgz)$/i.test(file.originalname));
  },
});

// POST /superadmin/backup/preview — sube el .tar.gz, lee SOLO el manifest (sin
// desempaquetar db/ ni files/, que pueden pesar mucho) y devuelve el diff contra la BD actual.
router.post('/preview', (req, res, next) => {
  uploadTar.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `El archivo supera los ${MAX_UPLOAD_MB} MB` });
      return res.status(400).json({ error: err.message || 'Error al subir el archivo' });
    }
    next();
  });
}, async (req, res) => {
  const cleanupOnError = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    if (!req.file) return res.status(400).json({ error: 'Subí un archivo .tar.gz válido' });

    const token      = crypto.randomBytes(16).toString('hex');
    const tarPath    = path.join(UPLOADS_DIR, `${token}.tar.gz`);
    moveFileSync(req.file.path, tarPath);

    // Extrae ÚNICAMENTE manifest.json (sin tocar db/ ni files/) para que el preview
    // sea instantáneo aunque el backup pese cientos de MB.
    const extractDir = path.join(UPLOADS_DIR, `${token}-manifest`);
    fs.mkdirSync(extractDir, { recursive: true });
    try {
      await tar.x({ file: tarPath, cwd: extractDir, filter: (p) => p === 'manifest.json' });
    } catch {
      // Archivo corrupto o que no es un .tar.gz real (ej. un .txt renombrado) — mensaje
      // claro en vez del error crudo de la librería tar.
      fs.unlink(tarPath, () => {});
      fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'El archivo no es un .tar.gz válido o está corrupto' });
    }

    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.unlink(tarPath, () => {});
      fs.rmSync(extractDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'El archivo no tiene un manifest.json válido — ¿es un backup generado por este sistema?' });
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.rmSync(extractDir, { recursive: true, force: true });

    if (manifest.version !== BACKUP_FORMAT_VERSION) {
      fs.unlink(tarPath, () => {});
      return res.status(400).json({ error: `Versión de backup incompatible (${manifest.version || 'desconocida'}, se esperaba ${BACKUP_FORMAT_VERSION})` });
    }
    // Solo las obligatorias frenan el restore. Las opcionales ausentes (colecciones que no
    // existían cuando se generó ese backup) se toleran y se avisan más abajo — ver COLLECTIONS.
    const missing = collectionsMissingFrom(manifest);
    if (missing.required.length) {
      fs.unlink(tarPath, () => {});
      return res.status(400).json({ error: `El backup está incompleto, le falta: ${missing.required.join(', ')}` });
    }

    // Guarda el manifest como sidecar en disco (no en memoria) — el POST /restore
    // posterior puede caer en otro worker de PM2 y necesita poder releerlo.
    fs.writeFileSync(path.join(UPLOADS_DIR, `${token}.manifest.json`), JSON.stringify(manifest));

    // Limpieza de garantía a los 30 min, sin depender de que alguien vuelva a pedir el token.
    setTimeout(() => {
      fs.unlink(tarPath, () => {});
      fs.unlink(path.join(UPLOADS_DIR, `${token}.manifest.json`), () => {});
    }, UPLOAD_TTL_MS);

    // `missing: true` es lo que la vista usa para marcar la fila como "se va a vaciar" en vez
    // de mostrar un 0 indistinguible de una colección que estaba vacía de verdad.
    const diff = {};
    for (const { name, model } of COLLECTIONS) {
      const inBackup = name in manifest.collections;
      diff[name] = {
        current: await model.countDocuments(),
        backup:  inBackup ? manifest.collections[name] : 0,
        ...(inBackup ? {} : { missing: true }),
      };
    }

    res.json({ previewToken: token, manifest, diff, willEmpty: missing.optional });
  } catch (err) {
    cleanupOnError();
    logDeRuta(err, res);
    res.status(500).json({ error: err.message || 'Error al leer el backup' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Restauración
// ─────────────────────────────────────────────────────────────────────────────

// Deliberadamente muy restrictivo: es una operación rara y destructiva, no algo que
// deba poder reintentarse en loop (protege más contra un doble-click / bug que contra abuso).
const restoreLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de restauración. Esperá una hora antes de volver a intentar.' },
});

router.post('/restore', restoreLimiter, async (req, res) => {
  const { previewToken, confirmedText } = req.body;
  const log = [];

  if (confirmedText !== 'RESTAURAR') {
    return res.status(400).json({ error: 'Escribí "RESTAURAR" para confirmar' });
  }
  if (!previewToken) {
    return res.status(400).json({ error: 'Falta el token de preview' });
  }

  const tarPath      = path.join(UPLOADS_DIR, `${previewToken}.tar.gz`);
  const manifestPath = path.join(UPLOADS_DIR, `${previewToken}.manifest.json`);
  if (!fs.existsSync(tarPath) || !fs.existsSync(manifestPath)) {
    return res.status(400).json({ error: 'El preview expiró o no existe. Subí el archivo de nuevo.' });
  }

  // El manifest ya pasó la validación del preview; acá se relee solo para poder distinguir
  // en el log "esto se vació porque el backup no la traía" de "esto se restauró vacío".
  //
  // Va con try propio y ANTES de tocar nada: este handler es async y express 4 no atrapa el
  // throw de una promesa rechazada, así que un sidecar a medio escribir (disco lleno durante
  // el preview) dejaría la request colgada sin respuesta en vez de dar un error. Y colgada
  // justo acá sería con el modo mantenimiento ya prendido.
  let ausentesDelBackup;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ausentesDelBackup = new Set(collectionsMissingFrom(manifest).optional);
  } catch {
    return res.status(400).json({ error: 'No se pudo leer el preview de este backup. Subí el archivo de nuevo.' });
  }

  // Activa mantenimiento automáticamente durante la restauración, salvo que YA esté
  // activo (ej. lo prendió manualmente el dueño antes) — en ese caso no lo tocamos,
  // ni al empezar ni al terminar, para no apagar algo que no prendimos nosotros.
  //
  // Se guarda el estado CRUDO, no solo un booleano: si había una ventana de mantenimiento
  // EN ESPERA, `alreadyInMaintenance` da false (una espera no bloquea) y el finally la
  // borraría. Con el snapshot, el restore la interrumpe con un bloqueo real y al terminar
  // la espera sigue viva, esperando a que la plataforma se vacíe.
  const previousState = readRawState();
  const alreadyInMaintenance = !!getMaintenanceState();
  if (!alreadyInMaintenance) {
    setMaintenanceOn({
      message: 'Estamos restaurando una copia de seguridad. Volvemos en un momento.',
      activatedBy: res.locals.user.email,
      reason: 'restore',
    });
  }

  let extractDir;
  try {
    // 1. Backup de seguridad del estado ACTUAL antes de tocar nada. Si esto falla,
    // se aborta — nunca restauramos sin poder volver atrás.
    const safety = await createBackupTarball(res.locals.user.email);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const safetyDest = path.join(BACKUPS_DIR, `pre-restore-${safety.stamp}.tar.gz`);
    moveFileSync(safety.tarPath, safetyDest);
    log.push(`Backup de seguridad generado: ${path.basename(safetyDest)}`);

    // 2. Extrae el backup a restaurar completo (ahora sí, db/ + files/)
    extractDir = path.join(UPLOADS_DIR, `${previewToken}-extract`);
    fs.mkdirSync(extractDir, { recursive: true });
    await tar.x({ file: tarPath, cwd: extractDir });
    log.push('Backup a restaurar descomprimido');

    // 3. Reemplaza cada colección: borra todo lo actual, inserta lo del backup.
    //
    // Una colección que el backup no trae se VACÍA, no se deja como está. Un restore es un
    // viaje a una fecha, y en esa fecha esa colección no existía. Dejarla intacta sería un
    // restore a medias: las sesiones de sala de hoy quedarían apuntando a cursos, divisiones
    // y usuarios que este mismo restore acaba de borrar, y esas refs son `required`.
    for (const { name, model } of COLLECTIONS) {
      const filePath = path.join(extractDir, 'db', `${name}.json`);
      const docs = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
      await model.deleteMany({});
      if (docs.length) await model.insertMany(docs, { ordered: false });
      log.push(ausentesDelBackup.has(name)
        ? `Vaciado ${name}: el backup es anterior a esta colección`
        : `Restaurado ${name}: ${docs.length} documento(s)`);
    }

    // 4. Reemplaza los archivos físicos
    replaceDir(path.join(extractDir, 'files', 'archivos'), ARCHIVOS_BASE);
    replaceDir(path.join(extractDir, 'files', 'entregas'), ENTREGAS_BASE);
    log.push('Archivos físicos restaurados (adjuntos, novedades, avatares, entregas)');

    // 5. El cache de usuario/escuela puede tener _id que ya no existen o cambiaron.
    invalidateAll();
    log.push('Cache de usuarios/escuelas invalidado');

    logAudit(req, 'system.restore', [],
      {
        safety_backup: path.basename(safetyDest),
        ...(ausentesDelBackup.size ? { vaciadas: [...ausentesDelBackup].join(', ') } : {}),
      },
    );

    res.json({ ok: true, log, safetyBackup: path.basename(safetyDest), vaciadas: [...ausentesDelBackup] });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: err.message || 'Error durante la restauración', log });
  } finally {
    fs.unlink(tarPath, () => {});
    fs.unlink(manifestPath, () => {});
    if (extractDir) fs.rm(extractDir, { recursive: true, force: true }, () => {});
    if (!alreadyInMaintenance) restoreRawState(previousState);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Modo mantenimiento (Caso A: la app sigue viva, la bloqueamos a propósito)
// ─────────────────────────────────────────────────────────────────────────────

// Estado completo de la pantalla: qué hay activo, qué hay en espera, y cuánta gente está
// trabajando ahora mismo. `state` conserva exactamente su significado anterior (solo el
// mantenimiento que BLOQUEA) — la vista y el smoke test viejo la siguen leyendo igual.
router.get('/maintenance-status', async (req, res) => {
  const pending     = getPendingState();
  const idleMinutes = pending ? normalizeIdleMinutes(pending.idleMinutes) : IDLE_DEFAULT_MIN;

  // El estado tiene que poder verse aunque la base esté rara: si el conteo falla, la
  // pantalla muestra el estado igual y el semáforo queda en "no se pudo consultar".
  let activity = null;
  try {
    const { count } = await countActiveUsers({ idleMinutes });
    activity = { count, ready: count === 0, idleMinutes };
  } catch {
    activity = null;
  }

  res.json({ state: getMaintenanceState(), pending, activity });
});

// Semáforo en vivo. Lo llama el panel cada 10 s mientras la sección está a la vista: dos
// queries sobre el índice {lastSeen:1} que ya existe (models/User.js). Mismo patrón (y
// menos frecuencia) que /superadmin/monitor/stats, que poll-ea cada 5 s.
router.get('/maintenance/activity', async (req, res) => {
  const idleMinutes = normalizeIdleMinutes(req.query.idleMinutes);
  const now = new Date();

  try {
    const [{ count, byRole }, users] = await Promise.all([
      countActiveUsers({ idleMinutes, now }),
      listActiveUsers({ idleMinutes, now, limit: ACTIVITY_LIST_MAX }),
    ]);
    const pending  = getPendingState();
    const deadline = pending ? deadlineOf(pending) : null;

    res.json({
      now:       now.toISOString(),
      idleMinutes,
      count,
      ready:     count === 0,
      byRole,
      users,
      truncated: count > users.length,
      active:    !!getMaintenanceState(),
      pending:   pending ? {
        requestedAt:   pending.requestedAt,
        waitedMinutes: minutesAgo(pending.requestedAt, now),
        deadline:      deadline ? deadline.toISOString() : null,
        idleMinutes:   normalizeIdleMinutes(pending.idleMinutes),
      } : null,
    });
  } catch (err) {
    logDeRuta(err, res);
    res.status(500).json({ error: 'No se pudo consultar quién está trabajando: ' + err.message });
  }
});

// Programa el mantenimiento: si hay gente, queda EN ESPERA y lo activa solo el promotor
// (server.js) cuando la plataforma se vacía.
router.post('/maintenance/schedule', async (req, res) => {
  if (getMaintenanceState()) {
    return res.status(409).json({ error: 'El mantenimiento ya está activo.' });
  }

  const { message, eta, notifyActiveUsers } = req.body;
  const idleMinutes    = normalizeIdleMinutes(req.body.idleMinutes);
  const maxWaitMinutes = normalizeMaxWait(req.body.maxWaitMinutes);

  let count;
  try {
    ({ count } = await countActiveUsers({ idleMinutes }));
  } catch (err) {
    // Sin poder contar no se programa nada: dejaría una espera que el promotor tampoco
    // podría resolver, y el dueño creería que el sistema está esperando por él.
    logDeRuta(err, res);
    return res.status(500).json({ error: 'No se pudo contar quién está trabajando: ' + err.message });
  }

  // Plataforma ya vacía: no tiene sentido esperar 30 s a que el promotor descubra lo que
  // ya sabemos. Se activa en el acto, como si hubiera apretado "Activar mantenimiento".
  if (count === 0) {
    const state = setMaintenanceOn({
      message, eta, activatedBy: res.locals.user.email, reason: 'manual',
    });
    logAudit(req, 'system.maintenance_on', [], {
      ...(message ? { mensaje: message } : {}), ...(eta ? { eta } : {}), sin_espera: true,
    });
    return res.json({ ok: true, activated: true, state });
  }

  // Reprogramar una espera en curso conserva su requestedAt: cambiar el mensaje no puede
  // reiniciar el cronómetro de "hace cuánto estoy esperando" (ni el tope de RN-09).
  const previo  = getPendingState();
  const pending = setMaintenancePending({
    message, eta, idleMinutes, maxWaitMinutes, notifyActiveUsers,
    requestedBy: res.locals.user.email,
    requestedAt: previo ? previo.requestedAt : undefined,
  });

  logAudit(req, 'system.maintenance_scheduled', [], {
    ...(message ? { mensaje: message } : {}), ...(eta ? { eta } : {}),
    idleMinutes, maxWaitMinutes, activosAlProgramar: count,
  });

  res.json({ ok: true, activated: false, pending, activity: { count, ready: false, idleMinutes } });
});

// Cancela SOLO una espera. Si el mantenimiento ya está activo hay que apagarlo con
// /maintenance/off, que es explícito — cancelar no puede desbloquear la app por accidente.
router.post('/maintenance/cancel', (req, res) => {
  if (getMaintenanceState()) {
    return res.status(409).json({
      error: 'El mantenimiento ya está activo. Usá "Desactivar mantenimiento".',
    });
  }

  const pending = getPendingState();
  setMaintenanceOff(); // idempotente: cancelar algo que no existe no es un error
  if (pending) {
    logAudit(req, 'system.maintenance_cancelled', [],
      { esperoMinutos: minutesAgo(pending.requestedAt) });
  }

  res.json({ ok: true });
});

// Activar YA MISMO, sin mirar a nadie. Es la salida de emergencia (algo se está rompiendo
// y hay que cortar ahora) y pisa cualquier espera en curso.
router.post('/maintenance/on', (req, res) => {
  const { message, eta } = req.body;
  const desdeEspera = !!getPendingState();
  setMaintenanceOn({ message, eta, activatedBy: res.locals.user.email, reason: 'manual' });

  logAudit(req, 'system.maintenance_on', [],
    { ...(message ? { mensaje: message } : {}), ...(eta ? { eta } : {}),
      ...(desdeEspera ? { corto_espera: true } : {}) },
  );

  res.json({ ok: true, state: getMaintenanceState() });
});

router.post('/maintenance/off', (req, res) => {
  setMaintenanceOff();

  logAudit(req, 'system.maintenance_off', [], {});

  res.json({ ok: true });
});

module.exports = router;

// Expuestas para tests/unit/backupTarball.test.js. El armado del backup es la pieza más
// difícil de probar por la puerta de entrada normal (la ruta exige sesión de superadmin
// con el email del dueño), y a la vez es la que no se puede permitir romper en silencio:
// un backup mal armado se descubre el día que hace falta restaurarlo.
module.exports.createBackupTarball = createBackupTarball;
module.exports.buildBackupStaging  = buildBackupStaging;
module.exports.COLLECTIONS         = COLLECTIONS;
