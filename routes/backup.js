const express     = require('express');
const multer      = require('multer');
const tar         = require('tar');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const crypto      = require('crypto');
const rateLimit   = require('express-rate-limit');
const { requireAuth }       = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/superadmin');
const { invalidateAll }     = require('../middleware/cache');
const {
  getMaintenanceState, setMaintenanceOn, setMaintenanceOff, SYSTEM_OWNER_EMAIL,
} = require('../config/maintenance');

const School       = require('../models/School');
const User         = require('../models/User');
const Course       = require('../models/Course');
const Activity     = require('../models/Activity');
const Submission   = require('../models/Submission');
const Announcement = require('../models/Announcement');
const Suggestion    = require('../models/Suggestion');
const Division      = require('../models/Division');
const Subject       = require('../models/Subject');

const router = express.Router();

// Mismas rutas base que routes/activities.js / routes/admin.js / routes/announcements.js
// (no hay un config compartido para esto en el proyecto; se repite el patrón existente).
const ARCHIVOS_BASE = path.join(__dirname, '../public/archivos');
const ENTREGAS_BASE = path.join(__dirname, '../archivos/entregas');

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

// Todas las colecciones que entran en el backup. Un solo array evita repetir la lista
// en el dump, el restore y el cálculo de "diff" del preview.
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
];

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

// Vuelca todas las colecciones + archivos a un .tar.gz. Devuelve la ruta al archivo
// generado (en os.tmpdir(), el caller decide si lo persiste o lo borra) y el manifest.
async function createBackupTarball(generatedByEmail) {
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

    const filesDir     = path.join(stagingDir, 'files');
    fs.mkdirSync(filesDir);
    const archivosMeta = copyDir(ARCHIVOS_BASE, path.join(filesDir, 'archivos'));
    const entregasMeta = copyDir(ENTREGAS_BASE, path.join(filesDir, 'entregas'));

    const manifest = {
      version:     BACKUP_FORMAT_VERSION,
      createdAt:   createdAt.toISOString(),
      appVersion:  require('../package.json').version,
      generatedBy: generatedByEmail,
      collections: collectionsMeta,
      files: { archivos: archivosMeta, entregas: entregasMeta },
    };
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const stamp   = createdAt.toISOString().replace(/[:.]/g, '-');
    const tarPath = path.join(os.tmpdir(), `classroom-backup-${stamp}.tar.gz`);
    await tar.c({ gzip: true, cwd: stagingDir, file: tarPath }, ['manifest.json', 'db', 'files']);

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
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Descarga de backup
// ─────────────────────────────────────────────────────────────────────────────

router.get('/download', async (req, res) => {
  let tarPath;
  try {
    const result = await createBackupTarball(res.locals.user.email);
    tarPath = result.tarPath;
    const filename = `classroom-backup-${result.stamp}.tar.gz`;
    res.setHeader('X-Backup-Manifest', encodeURIComponent(JSON.stringify(result.manifest)));
    res.download(tarPath, filename, (err) => {
      fs.unlink(tarPath, () => {});
      if (err && !res.headersSent) res.status(500).json({ error: 'Error al generar el backup' });
    });
  } catch (err) {
    if (tarPath) fs.unlink(tarPath, () => {});
    res.status(500).json({ error: err.message || 'Error al generar el backup' });
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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB, margen amplio sobre el volumen actual (~33 MB)
  fileFilter: (req, file, cb) => {
    cb(null, /\.(tar\.gz|tgz)$/i.test(file.originalname));
  },
});

// POST /superadmin/backup/preview — sube el .tar.gz, lee SOLO el manifest (sin
// desempaquetar db/ ni files/, que pueden pesar mucho) y devuelve el diff contra la BD actual.
router.post('/preview', (req, res, next) => {
  uploadTar.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'El archivo supera los 500 MB' });
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
    fs.renameSync(req.file.path, tarPath);

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
    const missingCollections = COLLECTIONS.filter(c => !(c.name in (manifest.collections || {})));
    if (missingCollections.length) {
      fs.unlink(tarPath, () => {});
      return res.status(400).json({ error: `El backup no incluye: ${missingCollections.map(c => c.name).join(', ')}` });
    }

    // Guarda el manifest como sidecar en disco (no en memoria) — el POST /restore
    // posterior puede caer en otro worker de PM2 y necesita poder releerlo.
    fs.writeFileSync(path.join(UPLOADS_DIR, `${token}.manifest.json`), JSON.stringify(manifest));

    // Limpieza de garantía a los 30 min, sin depender de que alguien vuelva a pedir el token.
    setTimeout(() => {
      fs.unlink(tarPath, () => {});
      fs.unlink(path.join(UPLOADS_DIR, `${token}.manifest.json`), () => {});
    }, UPLOAD_TTL_MS);

    const diff = {};
    for (const { name, model } of COLLECTIONS) {
      diff[name] = { current: await model.countDocuments(), backup: manifest.collections[name] };
    }

    res.json({ previewToken: token, manifest, diff });
  } catch (err) {
    cleanupOnError();
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

  // Activa mantenimiento automáticamente durante la restauración, salvo que YA esté
  // activo (ej. lo prendió manualmente el dueño antes) — en ese caso no lo tocamos,
  // ni al empezar ni al terminar, para no apagar algo que no prendimos nosotros.
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
    fs.renameSync(safety.tarPath, safetyDest);
    log.push(`Backup de seguridad generado: ${path.basename(safetyDest)}`);

    // 2. Extrae el backup a restaurar completo (ahora sí, db/ + files/)
    extractDir = path.join(UPLOADS_DIR, `${previewToken}-extract`);
    fs.mkdirSync(extractDir, { recursive: true });
    await tar.x({ file: tarPath, cwd: extractDir });
    log.push('Backup a restaurar descomprimido');

    // 3. Reemplaza cada colección: borra todo lo actual, inserta lo del backup.
    for (const { name, model } of COLLECTIONS) {
      const filePath = path.join(extractDir, 'db', `${name}.json`);
      const docs = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];
      await model.deleteMany({});
      if (docs.length) await model.insertMany(docs, { ordered: false });
      log.push(`Restaurado ${name}: ${docs.length} documento(s)`);
    }

    // 4. Reemplaza los archivos físicos
    replaceDir(path.join(extractDir, 'files', 'archivos'), ARCHIVOS_BASE);
    replaceDir(path.join(extractDir, 'files', 'entregas'), ENTREGAS_BASE);
    log.push('Archivos físicos restaurados (adjuntos, novedades, avatares, entregas)');

    // 5. El cache de usuario/escuela puede tener _id que ya no existen o cambiaron.
    invalidateAll();
    log.push('Cache de usuarios/escuelas invalidado');

    res.json({ ok: true, log, safetyBackup: path.basename(safetyDest) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error durante la restauración', log });
  } finally {
    fs.unlink(tarPath, () => {});
    fs.unlink(manifestPath, () => {});
    if (extractDir) fs.rm(extractDir, { recursive: true, force: true }, () => {});
    if (!alreadyInMaintenance) setMaintenanceOff();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Modo mantenimiento (Caso A: la app sigue viva, la bloqueamos a propósito)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/maintenance-status', (req, res) => {
  res.json({ state: getMaintenanceState() });
});

router.post('/maintenance/on', (req, res) => {
  const { message, eta } = req.body;
  setMaintenanceOn({ message, eta, activatedBy: res.locals.user.email, reason: 'manual' });
  res.json({ ok: true, state: getMaintenanceState() });
});

router.post('/maintenance/off', (req, res) => {
  setMaintenanceOff();
  res.json({ ok: true });
});

module.exports = router;
