// Tests de la zona horaria: una sola fuente de hora para todo el proyecto.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// El bug que fijan: el servidor de producción corre en UTC y la Argentina está en UTC-3, así
// que TODA vista que formateaba una fecha por su cuenta con toLocaleDateString mostraba tres
// horas de más — en vencimientos, entregas y auditoría. La otra mitad del bug es el navegador:
// las máquinas del aula tienen cualquier zona configurada, así que el mismo vencimiento se
// veía distinto en cada pantalla. Una entrega de las 23:30 aparecía al día siguiente.
//
// La regla, y lo único que hay que recordar al escribir una vista nueva:
//   El servidor formatea con `fmt` (res.locals, viene de services/liveRoom.js).
//   El navegador formatea con `Fecha` (public/js/fecha.js, misma API y mismos textos).
//   Nadie más llama a toLocale*String — salvo pasando un `timeZone:` explícito, que es el
//   caso de las fechas 'YYYY-MM-DD' sin instante (ahí la zona correcta ES UTC).

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');

// Los dos dueños de la hora. Son los únicos que construyen Intl.DateTimeFormat.
const DUENIOS = [
  path.join('services', 'liveRoom.js'),
  path.join('public', 'js', 'fecha.js'),
];

const DIRS = ['views', 'routes', 'services', path.join('public', 'js')];

function archivos(dir, ext, acc = []) {
  const full = path.join(RAIZ, dir);
  if (!fs.existsSync(full)) return acc;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) archivos(rel, ext, acc);
    else if (ext.some(x => e.name.endsWith(x))) acc.push(rel);
  }
  return acc;
}

// Una llamada a toLocale*String que NO declara timeZone usa la zona del proceso (UTC en
// producción) o la del equipo. Eso es exactamente el bug.
//
// La trampa: toLocaleString también formatea NÚMEROS — (1234).toLocaleString('es-AR') da
// "1.234". Eso no tiene nada que ver con la zona horaria y no hay que tocarlo. Se distingue
// por el receptor: "total", "pico" y "usado" son contadores; "createdAt" no.
const RECEPTOR_ES_FECHA = /(fecha|date|At$|_at$|ts$|dt$|hora|time|vence|creado|ultimo|seen|expira)/i;

function infracciones(texto) {
  const out = [];
  const re = /([\w.$\])]+|new Date\([^)]*\))\.toLocale(Date|Time)?String\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const todo = m[0], receptor = m[1], tipo = m[2], args = m[3];
    if (/timeZone\s*:/.test(args)) continue;            // deliberado (fechas YYYY-MM-DD)
    const opcionesDeFecha = /(day|month|year|hour|minute|second|weekday)\s*:/.test(args);
    const esFecha = Boolean(tipo) || opcionesDeFecha
                 || receptor.startsWith('new Date') || RECEPTOR_ES_FECHA.test(receptor);
    if (esFecha) out.push(todo.length > 70 ? todo.slice(0, 70) + '...' : todo);
  }
  return out;
}

test('ninguna vista ni ruta formatea fechas por su cuenta', () => {
  const malos = [];
  for (const dir of DIRS) {
    for (const rel of archivos(dir, ['.ejs', '.js'])) {
      if (DUENIOS.includes(rel)) continue;
      const hits = infracciones(fs.readFileSync(path.join(RAIZ, rel), 'utf8'));
      if (hits.length) malos.push(rel + ' (' + hits.length + '): ' + hits[0]);
    }
  }
  assert.deepStrictEqual(malos, [],
    'Estos archivos formatean fechas sin zona horaria fija. ' +
    'Usar fmt.* en el servidor y Fecha.* en el navegador:\n  ' + malos.join('\n  '));
});

test('un instante UTC se imprime en la hora de la escuela, no en UTC', () => {
  const { fmt } = require(path.join(RAIZ, 'services', 'liveRoom.js'));
  // 17:05 UTC son las 14:05 en Buenos Aires. Si esto diera 17:05, volvió el bug.
  const d = new Date('2026-08-06T17:05:09Z');
  assert.strictEqual(fmt.hora(d), '14:05');
  assert.strictEqual(fmt.fechaCorta(d), '06/08/2026');
  // El caso que rompía de verdad: una entrega de las 23:30 hora local es del día 6, pero en
  // UTC ya es el 7. Con la zona del proceso, la entrega cambiaba de día.
  const nocturna = new Date('2026-08-07T02:30:00Z');
  assert.strictEqual(fmt.fechaCorta(nocturna), '06/08/2026');
  assert.strictEqual(fmt.hora(nocturna), '23:30');
});

test('el navegador y el servidor imprimen exactamente lo mismo', () => {
  const { fmt } = require(path.join(RAIZ, 'services', 'liveRoom.js'));
  // public/js/fecha.js es un IIFE que cuelga `Fecha` del global.
  const sandbox = { SCHOOL_TZ: fmt.TZ };
  const codigo = fs.readFileSync(path.join(RAIZ, 'public', 'js', 'fecha.js'), 'utf8');
  new Function('window', codigo)(sandbox);
  const Fecha = sandbox.Fecha;

  assert.ok(Fecha, 'public/js/fecha.js tiene que definir window.Fecha');
  const d = new Date('2026-08-06T17:05:09Z');
  for (const nombre of Object.keys(fmt)) {
    if (nombre === 'TZ') continue;
    assert.strictEqual(typeof Fecha[nombre], 'function', 'falta Fecha.' + nombre);
    assert.strictEqual(Fecha[nombre](d), fmt[nombre](d), 'Fecha.' + nombre + ' difiere del servidor');
  }
});

test('una fecha nula o inválida da texto vacío, no "Invalid Date"', () => {
  const { fmt } = require(path.join(RAIZ, 'services', 'liveRoom.js'));
  for (const f of ['hora', 'fechaCorta', 'diaMesAnioHora']) {
    assert.strictEqual(fmt[f](null), '');
    assert.strictEqual(fmt[f](undefined), '');
    assert.strictEqual(fmt[f]('no es una fecha'), '');
  }
});

test('las vistas reciben fmt en todas las rutas', () => {
  const server = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8');
  assert.match(server, /res\.locals\.fmt\s*=/,
    'server.js tiene que publicar fmt en res.locals para que TODA vista lo tenga');
});

test('el navegador recibe la zona de la escuela antes de usarla', () => {
  const footer = fs.readFileSync(path.join(RAIZ, 'views', 'partials', 'footer.ejs'), 'utf8');
  assert.match(footer, /window\.SCHOOL_TZ/, 'el footer tiene que definir window.SCHOOL_TZ');
  assert.match(footer, /src="\/js\/fecha\.js"/, 'el footer tiene que cargar /js/fecha.js');
  const tz    = footer.indexOf('window.SCHOOL_TZ');
  const carga = footer.indexOf('src="/js/fecha.js"');
  assert.ok(tz < carga, 'SCHOOL_TZ tiene que definirse ANTES de cargar fecha.js');
  // Y el partial usa Fecha.* en su propio JS: la carga va antes que el primer uso, o el menú
  // de usuario revienta con "Fecha is not defined" en TODAS las páginas.
  const primerUso = footer.indexOf('Fecha.');
  if (primerUso !== -1) {
    assert.ok(carga < primerUso, 'footer.ejs usa Fecha.* antes de cargar /js/fecha.js');
  }
});

test('toda vista que use Fecha.* carga fecha.js (vía el footer)', () => {
  const malas = [];
  for (const rel of archivos('views', ['.ejs'])) {
    if (rel === path.join('views', 'partials', 'footer.ejs')) continue;
    const txt = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    const uso = txt.indexOf('Fecha.');
    if (uso === -1) continue;
    const m = txt.match(/include\(['"][^'"]*partials\/footer/);
    const inc = m ? txt.indexOf(m[0]) : -1;
    if (inc === -1) malas.push(rel + ': usa Fecha.* y no incluye partials/footer');
    else if (inc > uso) malas.push(rel + ': usa Fecha.* antes de incluir partials/footer');
  }
  assert.deepStrictEqual(malas, [], malas.join('\n  '));
});

// El error que costó caro al hacer el barrido: `fmt` existe en las VISTAS porque server.js lo
// pone en res.locals, pero dentro de routes/ y services/ es solo un nombre suelto. Un
// `fmt.fechaCorta(...)` ahí arriba se escribe igual y revienta con ReferenceError recién
// cuando alguien pisa esa línea — y pasó en el CSV de notas, que es de las rutas sin test.
test('routes y services no usan fmt sin tenerlo en el alcance', () => {
  const malos = [];
  for (const dir of ['routes', 'services']) {
    for (const rel of archivos(dir, ['.js'])) {
      const txt = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
      if (!/\bfmt\./.test(txt)) continue;
      const declarado = /(const|let|var)\s+(\{[^}]*\bfmt\b[^}]*\}|fmt)\s*=/.test(txt);
      if (!declarado) {
        malos.push(rel + ': usa fmt.* sin declararlo (res.locals solo llega a las vistas)');
      }
    }
  }
  assert.deepStrictEqual(malos, [], malos.join('\n  '));
});

test('el JS del navegador resuelve Fecha en los dos entornos', () => {
  const malos = [];
  for (const rel of archivos(path.join('public', 'js'), ['.js'])) {
    if (DUENIOS.includes(rel)) continue;
    const txt = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
    if (!/\bFecha\./.test(txt)) continue;
    // Si el archivo además se carga con require() desde los tests, tiene que resolver Fecha
    // por su cuenta: bajo Node no hay window y el global no existe.
    const seRequiere = /module\.exports/.test(txt);
    const loResuelve = /(const|let|var)\s+Fecha\s*=/.test(txt);
    if (seRequiere && !loResuelve) {
      malos.push(rel + ': se carga con require() en los tests y usa Fecha sin resolverla');
    }
  }
  assert.deepStrictEqual(malos, [], malos.join('\n  '));
});
