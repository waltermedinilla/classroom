// Tests del armado del .tar.gz del backup (routes/backup.js).
// Correr con: npm run test:unit
//
// Por qué existe este archivo: la descarga del backup no se puede ejercitar por la puerta
// normal (la ruta exige sesión de superadmin CON el email del dueño), y a la vez es la
// función que no se puede permitir romper en silencio — un backup mal armado no da error,
// se descubre el día que hace falta restaurarlo.
//
// Lo importante que cubre: desde 2026-08-10 el backup NO copia los ~900 MB de archivos al
// staging, los enlaza y deja que tar los siga (follow: true). Eso hace que el árbol real
// del servidor quede colgando adentro de un directorio temporal que después se borra. Los
// tests de acá abajo fijan las dos propiedades de las que depende que eso sea seguro:
//   1. el .tar.gz sale con el MISMO layout que cuando se copiaba (backups intercambiables);
//   2. limpiar el staging NO toca los archivos originales.
//
// Tocan disco y Mongo de verdad, pero contra fixtures temporales: BACKUP_ARCHIVOS_BASE y
// BACKUP_ENTREGAS_BASE se setean ANTES del require para que el módulo no mire nunca
// public/archivos ni archivos/entregas del proyecto.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const tar    = require('tar');

require('dotenv').config();

// ANTES del require: routes/backup.js resuelve estas rutas una sola vez, al cargarse.
const FIXTURES      = fs.mkdtempSync(path.join(os.tmpdir(), `backup-fixtures-${process.pid}-`));
const ARCHIVOS_DIR  = path.join(FIXTURES, 'archivos');
const ENTREGAS_DIR  = path.join(FIXTURES, 'entregas');
process.env.BACKUP_ARCHIVOS_BASE = ARCHIVOS_DIR;
process.env.BACKUP_ENTREGAS_BASE = ENTREGAS_DIR;

const mongoose = require('mongoose');
const { createBackupTarball, COLLECTIONS } = require('../../routes/backup');

// Un árbol chico pero con la misma forma que el real: subcarpetas por escuela/curso.
const ARCHIVOS_FIXTURE = {
  'escuela1/actividades/curso1/apunte.pdf': 'contenido del apunte',
  'escuela1/avatars/alumno.png':            'no es un png de verdad, alcanza',
  'general/avatars/docente.png':            'otro archivo',
};
const ENTREGAS_FIXTURE = {
  'escuela1/act1/alumno1/entrega.pdf': 'la entrega del alumno',
};

function escribirFixture(base, archivos) {
  for (const [rel, contenido] of Object.entries(archivos)) {
    const destino = path.join(base, rel);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
  }
}

async function listarTar(tarPath) {
  const entradas = [];
  await tar.t({ file: tarPath, onReadEntry: e => entradas.push({ path: e.path, type: e.type }) });
  return entradas;
}

function stagingsHuerfanos() {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('classroom-backup-staging-'));
}

test.before(async () => {
  escribirFixture(ARCHIVOS_DIR, ARCHIVOS_FIXTURE);
  escribirFixture(ENTREGAS_DIR, ENTREGAS_FIXTURE);
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/classroom-escuela');
});

test.after(async () => {
  await mongoose.disconnect();
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

test('el backup trae el manifest y un .json por cada colección declarada', async () => {
  const { tarPath, manifest } = await createBackupTarball('test@example.com');
  try {
    const rutas = (await listarTar(tarPath)).map(e => e.path);

    assert.ok(rutas.includes('manifest.json'), 'falta manifest.json en la raíz del backup');
    for (const { name } of COLLECTIONS) {
      assert.ok(rutas.includes(`db/${name}.json`), `falta db/${name}.json`);
      assert.equal(typeof manifest.collections[name], 'number',
        `el manifest no declara cuántos documentos trae ${name}`);
    }
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
});

// Este es EL test que protege el cambio a enlaces: si algún día tar deja de seguirlos, o
// alguien saca follow:true, las rutas dejan de aparecer y el backup sale sin archivos.
test('los archivos entran con las rutas files/archivos y files/entregas, ya resueltas', async () => {
  const { tarPath, manifest } = await createBackupTarball('test@example.com');
  try {
    const entradas = await listarTar(tarPath);
    const rutas    = entradas.map(e => e.path);

    for (const rel of Object.keys(ARCHIVOS_FIXTURE)) {
      assert.ok(rutas.includes(`files/archivos/${rel}`), `falta files/archivos/${rel}`);
    }
    for (const rel of Object.keys(ENTREGAS_FIXTURE)) {
      assert.ok(rutas.includes(`files/entregas/${rel}`), `falta files/entregas/${rel}`);
    }

    // Un enlace empaquetado SIN resolver produce un backup que parece sano y pesa nada:
    // al restaurarlo en otra máquina, apunta a un destino que no existe.
    const enlaces = entradas.filter(e => e.type === 'SymbolicLink' || e.type === 'Link');
    assert.deepEqual(enlaces, [], 'el backup empaquetó enlaces en vez del contenido real');

    assert.equal(manifest.files.archivos.count, Object.keys(ARCHIVOS_FIXTURE).length);
    assert.equal(manifest.files.entregas.count, Object.keys(ENTREGAS_FIXTURE).length);
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
});

// La consecuencia más cara de equivocarse acá: borrar el staging siguiendo el enlace
// vaciaría public/archivos y archivos/entregas del servidor de producción.
test('limpiar el staging no toca los archivos originales', async () => {
  const antes = fs.readFileSync(path.join(ARCHIVOS_DIR, 'escuela1/actividades/curso1/apunte.pdf'), 'utf8');

  const { tarPath } = await createBackupTarball('test@example.com');
  fs.rmSync(tarPath, { force: true });

  for (const rel of Object.keys(ARCHIVOS_FIXTURE)) {
    assert.ok(fs.existsSync(path.join(ARCHIVOS_DIR, rel)), `el backup se llevó puesto ${rel}`);
  }
  for (const rel of Object.keys(ENTREGAS_FIXTURE)) {
    assert.ok(fs.existsSync(path.join(ENTREGAS_DIR, rel)), `el backup se llevó puesto ${rel}`);
  }
  assert.equal(
    fs.readFileSync(path.join(ARCHIVOS_DIR, 'escuela1/actividades/curso1/apunte.pdf'), 'utf8'),
    antes,
    'el contenido del original cambió después de generar el backup',
  );
});

test('no deja directorios de staging dando vueltas en el temporal', async () => {
  const antes = stagingsHuerfanos();
  const { tarPath } = await createBackupTarball('test@example.com');
  fs.rmSync(tarPath, { force: true });
  assert.deepEqual(stagingsHuerfanos(), antes, 'quedó un staging sin borrar en os.tmpdir()');
});

// Escuela recién creada: todavía no entregó nadie, así que archivos/entregas ni siquiera
// existe en disco. El backup tiene que traer la carpeta igual — vacía, pero presente — para
// que el restore no encuentre un hueco donde espera reemplazar un árbol. Va último porque
// borra el fixture de entregas para reproducirlo.
test('una carpeta de origen inexistente entra igual, vacía, y no rompe el backup', async () => {
  fs.rmSync(ENTREGAS_DIR, { recursive: true, force: true });
  assert.equal(fs.existsSync(ENTREGAS_DIR), false, 'el fixture tenía que quedar borrado');

  try {
    const { tarPath, manifest } = await createBackupTarball('test@example.com');
    try {
      const rutas = (await listarTar(tarPath)).map(e => e.path);
      assert.ok(rutas.some(r => r === 'files/entregas/' || r.startsWith('files/entregas/')),
        'el backup no incluye la carpeta files/entregas');
      assert.equal(manifest.files.entregas.count, 0);
    } finally {
      fs.rmSync(tarPath, { force: true });
    }
  } finally {
    escribirFixture(ENTREGAS_DIR, ENTREGAS_FIXTURE);
  }
});
