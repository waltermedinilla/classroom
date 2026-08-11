// Estadísticas de almacenamiento para el monitor del superadmin.
//
// Dos costos MUY distintos, por eso van separados:
//
//   1. Espacio del volumen (fs.statfs) — una syscall, microsegundos. Se calcula siempre.
//   2. Cuánto ocupa la app (recorrer el árbol de archivos) — O(cantidad de archivos), y
//      hoy ya son 144 archivos / ~214 MB, con tendencia a crecer con cada entrega. El
//      monitor refresca CADA 5 SEGUNDOS (ver views/superadmin/monitor.ejs), así que
//      escanear en cada tick sería tirar I/O a la basura. Va cacheado.
//
// Todos los tamaños se devuelven en BYTES; el formateo a MB/GB es cosa de la vista.

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');

// Directorios que administra la app, con la etiqueta que ve el superadmin.
// Las rutas son las mismas que usan routes/activities.js y routes/courses.js.
const RUTAS = [
  { id: 'entregas',  label: 'Entregas de alumnos', dir: path.join(__dirname, '../archivos/entregas') },
  { id: 'materiales', label: 'Adjuntos y avatares', dir: path.join(__dirname, '../public/archivos') },
  // Adjuntos del chat de la sala en vivo (routes/rooms.js). Van aparte de 'materiales' porque
  // son los únicos que se purgan solos —a los 3 meses, con cleanup-rooms.js—, así que verlos
  // crecer y bajar por separado dice si la retención está alcanzando.
  { id: 'salas',     label: 'Archivos de salas en vivo', dir: path.join(__dirname, '../archivos/salas') },
];

const TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

// Suma recursiva del tamaño de un directorio.
//
// - `withFileTypes` evita un stat extra por entrada para saber si es directorio.
// - Los symlinks NO se siguen: un link que apunte hacia arriba haría un loop infinito.
//   `isFile()` es false para symlinks, así que quedan afuera solos.
// - Cualquier error por entrada (permisos, archivo borrado entre el readdir y el stat)
//   se ignora: es un panel informativo, no vale abortar todo el cálculo por un archivo.
async function tamanoDirectorio(dir) {
  let total = 0;
  let archivos = 0;

  let entradas;
  try {
    entradas = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, archivos: 0 }; // el directorio puede no existir todavía
  }

  for (const entrada of entradas) {
    const completa = path.join(dir, entrada.name);
    try {
      if (entrada.isDirectory()) {
        const sub = await tamanoDirectorio(completa);
        total    += sub.bytes;
        archivos += sub.archivos;
      } else if (entrada.isFile()) {
        const st = await fsp.stat(completa);
        total    += st.size;
        archivos += 1;
      }
    } catch {
      // entrada ilegible o borrada mientras recorríamos: se saltea
    }
  }
  return { bytes: total, archivos };
}

// Espacio del volumen donde vive la app. fs.statfs existe en Node 18.15+ y funciona
// tanto en Linux (producción) como en Windows (desarrollo).
async function espacioVolumen() {
  try {
    const st = await fsp.statfs(path.join(__dirname, '..'));
    const total = st.blocks * st.bsize;
    // `bavail` (disponible para usuario sin privilegios) y no `bfree`: en Linux el
    // filesystem reserva un porcentaje para root, y bfree lo incluiría, mostrando más
    // espacio libre del que la app realmente puede usar.
    const libre = st.bavail * st.bsize;
    return {
      disponible: true,
      total,
      libre,
      usado: total - libre,
      porcentaje: total > 0 ? Math.round(((total - libre) / total) * 100) : 0,
    };
  } catch {
    return { disponible: false, total: 0, libre: 0, usado: 0, porcentaje: 0 };
  }
}

// Tamaño de la base de datos. `dataSize` es lo que ocupan los documentos; `storageSize`
// lo que MongoDB reservó en disco (suele ser mayor por fragmentación y compresión).
async function tamanoBaseDatos(mongoose) {
  try {
    const st = await mongoose.connection.db.stats();
    return {
      disponible: true,
      datos:      st.dataSize    || 0,
      storage:    st.storageSize || 0,
      indices:    st.indexSize   || 0,
      documentos: st.objects     || 0,
    };
  } catch {
    return { disponible: false, datos: 0, storage: 0, indices: 0, documentos: 0 };
  }
}

// Devuelve el bloque completo para el monitor. `mongoose` se recibe por parámetro para
// no acoplar este servicio a la conexión (y poder testearlo sin base).
async function getDiskStats(mongoose) {
  const volumen = await espacioVolumen();

  // El escaneo caro sale del cache si sigue fresco
  const ahora = Date.now();
  if (!cache.data || (ahora - cache.at) > TTL_MS) {
    const medidos = await Promise.all(RUTAS.map(async r => ({
      id: r.id, label: r.label, ...(await tamanoDirectorio(r.dir)),
    })));
    const db = await tamanoBaseDatos(mongoose);
    cache = { at: ahora, data: { carpetas: medidos, db } };
  }

  const { carpetas, db } = cache.data;
  const totalArchivos = carpetas.reduce((a, c) => a + c.bytes, 0);

  return {
    volumen,
    carpetas,
    db,
    // Lo que ocupa la app = archivos subidos + storage real de Mongo
    appTotal: totalArchivos + (db.disponible ? db.storage : 0),
    // Para que la vista pueda avisar que el desglose no es del segundo exacto
    calculadoHace: Math.round((Date.now() - cache.at) / 1000),
  };
}

// Solo para tests: fuerza el próximo cálculo a ignorar el cache
function invalidarCache() { cache = { at: 0, data: null }; }

module.exports = { getDiskStats, invalidarCache, TTL_MS };
