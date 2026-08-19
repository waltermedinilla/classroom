#!/usr/bin/env node
// Muestra el reporte de una subida que falló, a partir del código que vio el usuario.
//
//   node tools/ver-subida.js SUB-7F3A2C     # una en particular
//   node tools/ver-subida.js                # las últimas 15, para ver si hay un patrón
//   node tools/ver-subida.js --hoy          # solo las de hoy
//
// El código sale del cartel de error que ve el docente o el alumno. Alcanza con una foto de
// la pantalla. Los reportes los manda el navegador a POST /diagnostico/subida y quedan en
// combined.log con `evento: "subida_fallida"` (ver routes/diagnostico.js).
//
// ⚠️ Si el código NO aparece, eso TAMBIÉN es un resultado: significa que el navegador no
// pudo ni siquiera avisar. Ahí el problema está antes de la aplicación (la red del aula, el
// Funnel, el DNS), y hay que mirar del lado del servidor y de la conexión, no del código.
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// En producción los logs viven en /home/walter/classroom/logs. Corriendo desde el árbol del
// proyecto, el default de abajo ya apunta bien; si algún día se mueven, LOGS_DIR lo arregla
// sin tocar este archivo.
const LOGS_DIR = process.env.LOGS_DIR || path.join(__dirname, '../logs');
const LOG      = path.join(LOGS_DIR, 'combined.log');

const args   = process.argv.slice(2);
const codigo = args.find(a => /^SUB-/i.test(a));
const soloHoy = args.includes('--hoy');
const LIMITE  = 15;

const mb = (b) => {
  if (typeof b !== 'number') return '?';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
};

// Lo que el reintento automático le regala al diagnóstico y no se podía saber de ninguna
// otra forma: si falló UN envio pudo ser un pico de un segundo, pero si fallaron los cuatro
// repartidos en ~50 s, el corte DURÓ. Eso separa "se cayó un paquete" de "el Funnel estuvo
// abajo", que son dos investigaciones distintas.
function duracionDelCorte(r) {
  if (!(r.intentos > 1)) return '';
  return `\n  → Falló los ${r.intentos} intentos repartidos en ~50 s: el corte duró, no fue un pico.`;
}

// La lectura del veredicto. Es lo único de este archivo que hay que leer con atención: dice
// DÓNDE seguir buscando, que es para lo que existe la herramienta.
function veredicto(r) {
  const total = r.archivo && r.archivo.bytes;
  const pct   = r.porcentaje;

  if (r.motivo === 'red' || r.motivo === 'timeout') {
    if (typeof pct === 'number' && pct < 100) {
      return [
        `SE CORTÓ EN CAMINO: el navegador solo pudo enviar el ${pct}% del archivo.`,
        'La request nunca llegó entera a la aplicación, así que NO va a haber línea en el',
        'access log. Mirá del lado de la red y de lo que hay delante del server:',
        '  · Tailscale Funnel / proxy: ¿hay límite de tamaño de cuerpo o de tiempo?',
        '  · la conexión del aula (mirá el campo "conexion" de abajo)',
        duracionDelCorte(r),
      ].filter(Boolean).join('\n');
    }
    // Sin `porcentaje` no se midió NADA: la subida salió por fetch, que no informa
    // progreso (ver `progresoMedible` en public/js/subida-diagnostico.js). Afirmar acá
    // que subió entera es inventarlo, y manda a buscar un timeout del servidor que
    // nadie observó.
    if (typeof pct !== 'number') {
      return [
        'LA CONEXIÓN SE CORTÓ, Y CUÁNTO SE ALCANZÓ A ENVIAR no se midió.',
        'Esta subida sale por fetch, que no puede informar progreso, así que NO se puede',
        'distinguir "se cortó apenas arrancó" de "subió entera y murió esperando respuesta".',
        'Lo que SÍ acota el caso es el campo `tardó` de arriba:',
        '  · décimas de segundo  → se cortó al arrancar; mirá la red y el Funnel.',
        '  · decenas de segundos → el archivo ya estaba arriba; mirá el timeout del proxy.',
      ].join('\n');
    }

    return [
      'El navegador dice que la conexión se cortó, pero alcanzó a enviar el archivo entero.',
      'Sospechá de un timeout de un intermediario mientras el servidor procesaba.',
    ].join('\n');
  }

  // ¿Contestó la aplicación o algo que está delante? La app devuelve JSON con `error` en
  // TODOS sus errores de subida, así que el cuerpo lo decide sin ambigüedad. Se resuelve acá
  // y no en la cabeza del que lee: es la bifurcación más importante del informe y mandarse a
  // uno u otro lado por error cuesta horas.
  const nuestro = (() => {
    if (!r.respuesta) return false;
    try { return typeof JSON.parse(r.respuesta).error === 'string'; } catch { return false; }
  })();

  if (r.status === 413) {
    if (nuestro) {
      return [
        'RECHAZADO POR TAMAÑO POR LA APLICACIÓN (413).',
        'El cuerpo es JSON nuestro, así que el archivo llegó y lo frenó nuestro propio límite.',
        'No es la red ni el proxy: si el tope está corto, se sube en el código.',
        `Lo que dijo: ${JSON.parse(r.respuesta).error}`,
      ].join('\n');
    }
    return [
      'RECHAZADO POR TAMAÑO POR UN INTERMEDIARIO (413).',
      'El cuerpo NO es JSON nuestro: quien cortó está DELANTE de la aplicación (proxy,',
      'Funnel, balanceador). Ningún log de la app va a explicarlo.',
      total ? `El archivo pesaba ${mb(total)}: comparalo con el límite de cuerpo de ese intermediario.` : '',
    ].filter(Boolean).join('\n');
  }

  if (!nuestro && r.status >= 400) {
    return [
      `RESPUESTA QUE NO ES DE LA APLICACIÓN (${r.status}).`,
      'La app contesta JSON en todos sus errores de subida y esto no lo es: contestó algo',
      'delante del server. Mirá el proxy / Funnel, no el código.',
    ].join('\n');
  }

  if (r.status >= 500) {
    return r.requestId
      ? `ERROR DEL SERVIDOR (${r.status}). El stack está en error.log:\n  grep ${r.requestId} ${path.join(LOGS_DIR, 'combined.log')}`
      : `ERROR DEL SERVIDOR (${r.status}), pero sin requestId. Buscá por hora en error.log.`;
  }

  if (r.status >= 400) {
    return `RECHAZO ESPERABLE (${r.status}): el servidor dijo que no y explicó por qué. Mirá "respuesta".`;
  }

  return 'Sin status: revisá los campos crudos de abajo.';
}

function mostrar(r) {
  const f = r.archivo || {};
  console.log('\n' + '─'.repeat(74));
  console.log(`${r.codigo}   ${r.timestamp || ''}`);
  console.log('─'.repeat(74));
  console.log(`  quién      ${r.usuario || '?'}${r.rol ? ' (' + r.rol + ')' : ''}`);
  console.log(`  archivo    ${f.nombre || '?'}  ·  ${mb(f.bytes)}  ·  ${f.mime || 'sin tipo'}`);
  console.log(`  se envió   ${mb(r.enviados)}${typeof r.porcentaje === 'number' ? `  (${r.porcentaje}% del archivo)` : ''}`);
  console.log(`  ruta       ${r.ruta || '?'}`);
  console.log(`  resultado  motivo=${r.motivo}  status=${r.status !== undefined ? r.status : '—'} ${r.statusText || ''}`);
  // El detalle de los intentos solo aparece si hubo reintento, para que los reportes de un
  // solo envío —y los viejos, anteriores al reintento automático— se lean igual que siempre.
  if (r.intentos > 1) {
    console.log(`  intentos   ${r.intentos} (el envío original y ${r.intentos - 1} reintento${r.intentos - 1 === 1 ? '' : 's'} automático${r.intentos - 1 === 1 ? '' : 's'})`);
  }
  // La aclaración "(ese intento)" NO es adorno: sin ella se lee que la subida entera tardó
  // 1,2 s, cuando en realidad estuvo casi un minuto peleando. `ms` es del último intento.
  const tardo = r.ms !== undefined ? (r.ms / 1000).toFixed(1).replace('.', ',') + ' s' : '?';
  console.log(`  tardó      ${tardo}${r.intentos > 1 ? ' (ese intento)' : ''}   conexión declarada: ${r.conexion || 'no informada'}`);
  if (r.requestId) console.log(`  requestId  ${r.requestId}`);
  if (r.respuesta) console.log(`  respondió  ${JSON.stringify(r.respuesta).slice(0, 240)}`);
  if (r.userAgent) console.log(`  navegador  ${r.userAgent.slice(0, 100)}`);
  console.log('\n  ' + veredicto(r).split('\n').join('\n  '));
  console.log('');
}

async function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`\nNo encuentro ${LOG}.`);
    console.error('Si estás en otra máquina, apuntá LOGS_DIR al directorio de logs:\n');
    console.error('  LOGS_DIR=/home/walter/classroom/logs node tools/ver-subida.js SUB-XXXXXX\n');
    process.exit(1);
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const encontrados = [];

  const rl = readline.createInterface({ input: fs.createReadStream(LOG), crlfDelay: Infinity });
  for await (const linea of rl) {
    // Filtro barato antes de parsear: combined.log tiene una línea por request y parsear
    // todo como JSON en un archivo que no rota todavía es caro al pedo.
    if (linea.indexOf('subida_fallida') === -1) continue;
    let r;
    try { r = JSON.parse(linea); } catch { continue; }
    if (r.evento !== 'subida_fallida') continue;
    if (codigo && String(r.codigo).toUpperCase() !== codigo.toUpperCase()) continue;
    if (soloHoy && !String(r.timestamp || '').startsWith(hoy)) continue;
    encontrados.push(r);
  }

  if (!encontrados.length) {
    if (codigo) {
      console.log(`\nNo hay ningún reporte con el código ${codigo.toUpperCase()}.\n`);
      console.log('Eso ES un dato, no un callejón sin salida: el navegador no llegó ni a avisar.');
      console.log('Quiere decir que el problema está ANTES de la aplicación — la red del aula,');
      console.log('el Funnel o el DNS. Revisá que el código esté bien copiado (no hay letras');
      console.log('I, L ni O en los códigos, justamente para no confundirlas con 1 y 0), y si');
      console.log('está bien, seguí por ahí.\n');
    } else {
      console.log('\nNo hay ninguna subida fallida registrada. \n');
    }
    return;
  }

  const aMostrar = codigo ? encontrados : encontrados.slice(-LIMITE);
  aMostrar.forEach(mostrar);

  if (!codigo && encontrados.length > 1) {
    // El resumen es lo que contesta "¿es de uno solo o le pasa a todos?", que cambia por
    // completo dónde buscar.
    const porMotivo = {};
    const cortadas  = encontrados.filter(r => typeof r.porcentaje === 'number' && r.porcentaje < 100).length;
    encontrados.forEach(r => { porMotivo[r.motivo] = (porMotivo[r.motivo] || 0) + 1; });
    console.log('─'.repeat(74));
    console.log(`RESUMEN: ${encontrados.length} subidas fallidas registradas`);
    console.log(`  por motivo: ${Object.entries(porMotivo).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`  cortadas antes de llegar entera: ${cortadas} de ${encontrados.length}`);
    console.log(`  personas distintas: ${new Set(encontrados.map(r => r.usuario)).size}`);
    console.log('');
  }
}

// Como CLI corre solo; como require() expone el veredicto, que es la parte con criterio y
// la única que vale la pena testear (tests/unit/subidaDiagnostico.test.js).
if (require.main === module) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
} else {
  module.exports = { veredicto, mb };
}
