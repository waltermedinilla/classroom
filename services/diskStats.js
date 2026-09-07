// Estadísticas de almacenamiento para el monitor del superadmin.
//
// Dos costos MUY distintos, por eso van separados:
//
//   1. Espacio del volumen (fs.statfs) — una syscall, microsegundos. Se calcula siempre.
//   2. Cuánto ocupa la app (recorrer el árbol de archivos) — O(cantidad de archivos), y
//      el monitor refresca CADA 5 SEGUNDOS (ver views/superadmin/monitor.ejs), así que
//      escanear en cada tick sería tirar I/O a la basura. Va cacheado.
//
// ⭐ Y el cache NO alcanza: el escaneo tampoco puede correr DENTRO del request.
//
// Medido en producción el 2026-09-06: 13.784 archivos, 17,5 GB, **4.436 ms** el escaneo
// (11.010 de esos archivos son entregas de alumnos, y crecen toda la clase, todo el año).
// Con el cache venciendo cada 60 s y el panel pidiendo cada 5, una de cada doce respuestas
// pagaba el escaneo entero: `/monitor/stats` promediaba 1.099 ms con picos de 17,5 s, y el
// 15,6% de las llamadas pasaba de 3 segundos. El doble de lo que sugiere la cuenta, porque
// este cache es una variable de módulo y **vive en cada worker**: en cluster son dos caches
// que vencen por su cuenta, así que el escaneo se paga el doble de veces.
//
// Por eso el vencimiento NO bloquea: se sirve el dato viejo al instante y el refresco corre
// por detrás. Ningún request vuelve a esperar los 4 segundos. La única excepción imposible
// de evitar es el primero de todos, cuando no hay absolutamente nada que servir.
//
// El precio es que el desglose puede tener varios minutos de atraso — y por eso `calculadoHace`
// viaja en la respuesta y la vista lo escribe al lado del número. Un dato de almacenamiento
// atrasado unos minutos no le cambia la decisión a nadie; una pantalla que tarda 17 segundos,
// sí.
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
  // Material del gabinete psicopedagógico (services/soeAdjuntos.js). Faltaba: el panel decía
  // "cuánto ocupa la app" y se comía los certificados e informes del SOE, que están fuera de
  // /public. Esta lista es además de dónde sale la lista de carpetas que el backup tiene que
  // respaldar o excluir a propósito (tests/unit/backupCarpetas.test.js).
  { id: 'soe',       label: 'Material del gabinete (SOE)', dir: path.join(__dirname, '../archivos/soe') },
];

// 5 minutos, no 60 segundos: como el refresco ya no se paga dentro del request, el TTL solo
// gobierna cuánto I/O se le tira al disco. Y ese disco es el mismo que está sirviendo las
// entregas de los alumnos, así que 12 escaneos por hora y por worker en vez de 60 es la
// diferencia que importa. El espacio ocupado no cambia de minuto a minuto.
const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, data: null };

// El refresco en curso, para que dos requests simultáneos no disparen dos escaneos. Con el
// panel pidiendo cada 5 s y un escaneo de 4, se solapaban solos.
let refresco = null;

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

// Las carpetas que se escanean. Es RUTAS salvo que un test la reemplace: escanear las de
// verdad hacía que la suite tardara 20 segundos y dependiera de cuántos archivos tenga la
// máquina de quien la corre.
let rutasActivas = RUTAS;

// El escaneo caro, aislado. No toca el cache: de eso se encarga quien lo llama.
async function escanear(mongoose) {
  const medidos = await Promise.all(rutasActivas.map(async r => ({
    id: r.id, label: r.label, ...(await tamanoDirectorio(r.dir)),
  })));
  const db = await tamanoBaseDatos(mongoose);
  return { carpetas: medidos, db };
}

// Dispara el escaneo si no hay otro en curso y devuelve la promesa. Un fallo NO tumba el
// cache viejo: seguir mostrando un desglose de hace un rato es mejor que no mostrar ninguno,
// y el volumen —que es el dato que importa para no quedarse sin disco— se calcula aparte y
// siempre.
function refrescar(mongoose) {
  if (refresco) return refresco;
  refresco = escanear(mongoose)
    .then((data) => { cache = { at: Date.now(), data }; })
    .catch(() => { /* se conserva lo que haya en cache */ })
    .finally(() => { refresco = null; });
  return refresco;
}

// Devuelve el bloque completo para el monitor. `mongoose` se recibe por parámetro para
// no acoplar este servicio a la conexión (y poder testearlo sin base).
async function getDiskStats(mongoose) {
  const volumen = await espacioVolumen();

  const vencido = (Date.now() - cache.at) > TTL_MS;
  if (!cache.data) {
    // El primer request de la vida del worker: no hay nada viejo que servir, hay que esperar.
    await refrescar(mongoose);
  } else if (vencido) {
    // ⭐ Acá está el arreglo: se dispara y NO se espera. Este request contesta con el dato
    // viejo, en microsegundos, y el que venga después ya encuentra el nuevo.
    refrescar(mongoose);
  }

  // El escaneo puede no haber dejado nada (falló el primero de todos). El monitor tiene que
  // seguir mostrando volumen, usuarios, RAM y carga igual.
  const { carpetas, db } = cache.data || {
    carpetas: [],
    db: { disponible: false, datos: 0, storage: 0, indices: 0, documentos: 0 },
  };
  const totalArchivos = carpetas.reduce((a, c) => a + c.bytes, 0);

  return {
    volumen,
    carpetas,
    db,
    // Lo que ocupa la app = archivos subidos + storage real de Mongo
    appTotal: totalArchivos + (db.disponible ? db.storage : 0),
    // Para que la vista pueda avisar que el desglose no es del segundo exacto. Ahora importa
    // más que antes: con el refresco por detrás puede llegar a los minutos. `null` cuando no
    // hay nada calculado todavía — sin esto daría los 56 años que van desde el epoch.
    calculadoHace: cache.data ? Math.round((Date.now() - cache.at) / 1000) : null,
  };
}

// Solo para tests: fuerza el próximo cálculo a ignorar el cache.
function invalidarCache() { cache = { at: 0, data: null }; refresco = null; }

// Solo para tests: la promesa del refresco en curso, o null si no hay ninguno. Es lo que
// permite verificar que el request NO esperó y que el escaneo igual ocurrió.
function refrescoPendiente() { return refresco; }

// Solo para tests: apunta el escaneo a otras carpetas. Sin argumento vuelve a las de verdad.
function rutasDePrueba(rutas) { rutasActivas = rutas || RUTAS; invalidarCache(); }

// RUTAS se exporta para tests/unit/backupCarpetas.test.js: esta lista es el inventario de
// carpetas que la app escribe, y el test la usa para exigir que cada una esté respaldada por
// el backup o excluida a propósito.
module.exports = {
  getDiskStats, invalidarCache, refrescoPendiente, rutasDePrueba, TTL_MS, RUTAS,
};
