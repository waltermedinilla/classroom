#!/usr/bin/env node
// Qué formato le está faltando a la escuela — § K de specs/correccion-de-entregas.spec.md.
//
//   node tools/ver-formatos.js            # últimos 30 días, agrupado
//   node tools/ver-formatos.js --mes      # el mes calendario en curso
//   node tools/ver-formatos.js --dias 7   # otra ventana
//
// Hermano de tools/ver-subida.js, y con el mismo insumo: las líneas de combined.log, acá las
// que llevan `evento: "formato_rechazado"` (routes/activities.js, routes/rooms.js,
// middleware/image-upload.js y POST /diagnostico/formato).
//
// ⭐ Por qué una TABLA y no una línea por evento: la pregunta no es "¿quién rebotó?", es "¿qué
// formato hay que empezar a aceptar?". Esa la contesta el agregado —cuántas veces, cuánta
// gente distinta, por qué pantalla— y no la contesta un listado cronológico.
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../logs');
const LOG      = path.join(LOGS_DIR, 'combined.log');

const args = process.argv.slice(2);
const porMes = args.includes('--mes');
const dias = (() => {
  const i = args.indexOf('--dias');
  const n = i !== -1 ? Number(args[i + 1]) : 30;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
})();

// Desde cuándo se cuenta. Con --mes, el 1 del mes en curso.
function desde() {
  const ahora = new Date();
  if (porMes) return new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  return new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);
}

const fecha = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

async function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`\nNo encuentro ${LOG}.`);
    console.error('Si estás en otra máquina, apuntá LOGS_DIR al directorio de logs:\n');
    console.error('  LOGS_DIR=/home/walter/classroom/logs node tools/ver-formatos.js\n');
    process.exit(1);
  }

  const corte = desde();
  const porExt = new Map();
  let total = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(LOG), crlfDelay: Infinity });
  for await (const linea of rl) {
    // Filtro barato antes de parsear, igual que ver-subida.js: combined.log no rota.
    if (linea.indexOf('formato_rechazado') === -1) continue;
    let r;
    try { r = JSON.parse(linea); } catch { continue; }
    if (r.evento !== 'formato_rechazado') continue;
    if (r.timestamp && new Date(r.timestamp) < corte) continue;

    total++;
    const ext = r.ext || '(sin_ext)';
    if (!porExt.has(ext)) {
      porExt.set(ext, { ext, veces: 0, personas: new Set(), rutas: new Set(), origenes: new Set(), primera: null, ultima: null });
    }
    const fila = porExt.get(ext);
    fila.veces++;
    if (r.usuario) fila.personas.add(String(r.usuario));
    if (r.ruta)    fila.rutas.add(r.ruta);
    if (r.origen)  fila.origenes.add(r.origen);
    if (r.timestamp) {
      if (!fila.primera || r.timestamp < fila.primera) fila.primera = r.timestamp;
      if (!fila.ultima  || r.timestamp > fila.ultima)  fila.ultima  = r.timestamp;
    }
  }

  const ventana = porMes
    ? `el mes en curso (desde el ${corte.toISOString().slice(0, 10)})`
    : `los últimos ${dias} días`;

  if (!total) {
    console.log(`\nNo hay ningún formato rechazado en ${ventana}.\n`);
    console.log('Ojo con leerlo como "no falta ningún formato": ver la advertencia de abajo.');
  } else {
    const filas = [...porExt.values()].sort((a, b) => b.veces - a.veces);
    console.log(`\nFormatos rechazados en ${ventana} — ${total} rechazo(s), ${filas.length} extensión(es)\n`);
    console.log('  extensión    veces  personas  por dónde                     primera           última');
    console.log('  ' + '─'.repeat(96));
    for (const f of filas) {
      console.log(
        '  ' + f.ext.padEnd(12) +
        String(f.veces).padStart(5) +
        String(f.personas.size).padStart(10) + '  ' +
        [...f.rutas].join(', ').padEnd(28).slice(0, 28) + '  ' +
        fecha(f.primera).padEnd(17) + ' ' + fecha(f.ultima),
      );
    }
    console.log('');
  }

  // ⚠️ La advertencia va IMPRESA y no en un comentario del código, a propósito: quien lee
  // esta tabla está por tomar una decisión con ella, y el número de arriba es un PISO.
  console.log('  ⚠️  Esto mide lo que alguien INTENTÓ subir, no lo que quiso subir.');
  console.log('      Si el `accept=` de los selectores sigue estricto, el explorador de');
  console.log('      archivos deja el formato EN GRIS y la persona ni lo selecciona: ese');
  console.log('      intento no existe para nadie. La tabla mide, entonces, solo a quien');
  console.log('      encontró la forma de intentarlo igual — es un piso, no un total.');
  console.log('      Ver RN-48 de specs/correccion-de-entregas.spec.md.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
