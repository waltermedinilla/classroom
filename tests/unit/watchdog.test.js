// Tests del diagnóstico del watchdog (services/watchdogDiagnostico.js).
// Correr con: npm run test:unit
//
// LO QUE PROTEGEN: que el veredicto señale la capa CORRECTA. Una herramienta de diagnóstico
// que se equivoca de capa es peor que no tenerla — manda a revisar Tailscale cuando el
// problema está en el código, o al revés, y hace perder justo el tiempo que vino a ahorrar.
//
// El caso testigo es el del 2026-08-14: la aplicación respondía perfecto, los logs estaban
// limpios, y nadie podía entrar. Cualquier lógica que en ese escenario diga "todo bien"
// es inútil para el problema que motivó esta herramienta.

const test   = require('node:test');
const assert = require('node:assert');

const {
  parsearLinea, parsearCupo, diagnosticar, tramos, resumirIncidentes,
} = require('../../services/watchdogDiagnostico');

// Medición sana. Cada test rompe UNA capa sobre esta base.
const sana = (over = {}) => ({
  fecha: new Date('2026-08-14T07:32:00-0300'),
  app: '200', t: '0.04', db: 'ok', ver: '1.0.42', up: '3600',
  cupo: '11500/12000', workers: '2', conn: '40', load: '0.4',
  mem: '2100/7800', rss: '320', mongo: 'up',
  dns: 'ok', dnsip: '199.38.181.54', ext: '200', tls: '0.3',
  funnel: 'on', tsnet: 'Running', ...over,
});

// ── Parseo ───────────────────────────────────────────────────────────────────

test('parsea una línea real del watchdog', () => {
  const m = parsearLinea('2026-08-14T07:32:01-0300 app=200 t=0.042 db=ok ver=1.0.42 cupo=11500/12000 dns=ok ext=200 funnel=on');
  assert.equal(m.app, '200');
  assert.equal(m.db, 'ok');
  assert.equal(m.cupo, '11500/12000');
  assert.equal(m.fecha.getFullYear(), 2026);
});

test('una línea corrupta devuelve null en vez de romper el informe', () => {
  // Un log truncado a mitad de escritura no puede tumbar el análisis del resto del día
  assert.equal(parsearLinea(''), null);
  assert.equal(parsearLinea('basura sin fecha'), null);
  assert.equal(parsearLinea('2026-08-14T07:32:01-0300'), null, 'sin campos no sirve');
  assert.equal(parsearLinea('2026-08-14T07:32:01-0300 db=ok'), null, 'sin app= falta la medición de control');
  assert.equal(parsearLinea(null), null);
  assert.equal(parsearLinea(undefined), null);
});

test('parsearCupo entiende el formato y rechaza lo que no lo es', () => {
  assert.deepEqual(parsearCupo('3000/12000'), { restante: 3000, limite: 12000, fraccion: 0.25 });
  assert.equal(parsearCupo('?/?'), null);
  assert.equal(parsearCupo('12000'), null);
  assert.equal(parsearCupo(''), null);
  assert.equal(parsearCupo('100/0'), null, 'límite cero divide por cero');
});

// ── ⭐ El caso que motivó la herramienta ─────────────────────────────────────

test('app sana + DNS caído = es el Funnel, NO el código', () => {
  // El escenario del 14/08: logs impecables y nadie puede entrar.
  const d = diagnosticar(sana({ dns: 'nxdomain', ext: 'skip' }));

  assert.equal(d.estado, 'falla');
  assert.equal(d.capa, 'dns-funnel');
  assert.match(d.resumen, /sana|resuelve/i);
  assert.match(d.accion, /funnel reset/, 'tiene que dar el comando exacto del arreglo');
});

test('DNS ok pero el camino público no completa = Funnel (incidente del 22/07)', () => {
  // Aquella vez el DNS resolvía perfecto y el handshake TLS se caía. Mismo arreglo.
  const d = diagnosticar(sana({ ext: '000', tls: '0' }));

  assert.equal(d.estado, 'falla');
  assert.equal(d.capa, 'funnel');
  assert.match(d.accion, /funnel reset/);
});

test('TODO ok es un diagnóstico en sí mismo, no un "no sé"', () => {
  // Si el usuario reporta que no anda y el watchdog dice ok en ese minuto, el problema no
  // está ni en el servidor ni en el camino público. Eso también es información.
  const d = diagnosticar(sana());
  assert.equal(d.estado, 'ok');
  assert.equal(d.capa, null);
});

// ── El orden de las capas: de adentro hacia afuera ──────────────────────────

test('con la app caída no culpa al Funnel, aunque el Funnel también esté mal', () => {
  // Una capa rota explica a todas las de afuera. Decir "es el Funnel" acá mandaría a mirar
  // Tailscale cuando lo que hay que abrir es error.log.
  const d = diagnosticar(sana({ app: '000', t: '0', dns: 'nxdomain', ext: '000', funnel: 'off' }));

  assert.equal(d.capa, 'app', 'la capa más interna es la que manda');
  assert.match(d.accion, /error\.log|pm2/i);
});

test('un 500 de la app se trata como app caída', () => {
  assert.equal(diagnosticar(sana({ app: '500' })).capa, 'app');
  assert.equal(diagnosticar(sana({ app: '503' })).capa, 'app');
});

test('app caída Y sin workers apunta a los workers, que es más específico', () => {
  const d = diagnosticar(sana({ app: '000', t: '0', workers: '0' }));
  assert.equal(d.capa, 'workers');
  assert.match(d.accion, /pm2/);
});

test('workers=0 con la app respondiendo NO es una falla: falló la medición', () => {
  // Si /health devolvió 200, hay workers por definición. Un workers=0 ahí significa que
  // pgrep no está o el proceso corre con otra línea de comandos. Detectado al correr el
  // recolector de verdad en un entorno sin pgrep: reportarlo como caída sería una alarma
  // falsa, y las alarmas falsas son lo que hace que se deje de mirar la herramienta.
  const d = diagnosticar(sana({ app: '200', workers: '0' }));
  assert.equal(d.estado, 'ok');
  assert.notEqual(d.capa, 'workers');
});

test('la base caída se distingue de la app caída', () => {
  // La app contesta 200 en /health pero informa db != ok: el arreglo es docker, no el código
  const d = diagnosticar(sana({ db: 'down' }));
  assert.equal(d.capa, 'mongo');
  assert.match(d.accion, /docker/);
});

test('docker "down" con la app diciendo db:ok NO es falla', () => {
  // `db:"ok"` sale de una consulta real a Mongo; `docker ps` puede fallar por permisos, por
  // otro nombre de contenedor, o porque Mongo no corre en Docker. La medición directa gana.
  // Detectado corriendo el recolector en una máquina sin Docker.
  const d = diagnosticar(sana({ db: 'ok', mongo: 'down' }));
  assert.equal(d.estado, 'ok');
});

test('si la app NO confirma la base, el contenedor caído sí es el diagnóstico', () => {
  const d = diagnosticar(sana({ db: '?', mongo: 'down' }));
  assert.equal(d.capa, 'mongo');
});

// ── Cupo ─────────────────────────────────────────────────────────────────────

test('el cupo agotado es falla y aclara que NO deja la pantalla en blanco', () => {
  const d = diagnosticar(sana({ cupo: '0/12000' }));
  assert.equal(d.estado, 'falla');
  assert.equal(d.capa, 'cupo');
  assert.match(d.resumen, /Demasiadas peticiones/i,
    'el síntoma del cupo es un mensaje, no una página que no carga: esa distinción es lo que descartó esta hipótesis el 14/08');
});

test('el cupo bajo avisa pero no declara falla', () => {
  const d = diagnosticar(sana({ cupo: '600/12000' })); // 5%
  assert.equal(d.estado, 'aviso');
  assert.equal(d.capa, 'cupo');
});

test('el cupo se evalúa DESPUÉS del DNS: un sitio inalcanzable no es un problema de cupo', () => {
  const d = diagnosticar(sana({ cupo: '0/12000', dns: 'nxdomain', ext: 'skip' }));
  assert.equal(d.capa, 'dns-funnel', 'si nadie llega, el cupo es una consecuencia');
});

// ── Rendimiento ──────────────────────────────────────────────────────────────

test('una app lenta se avisa aunque responda 200', () => {
  const d = diagnosticar(sana({ t: '3.5' }));
  assert.equal(d.estado, 'aviso');
  assert.equal(d.capa, 'rendimiento');
});

test('0.04s no es lento', () => {
  assert.equal(diagnosticar(sana({ t: '0.04' })).estado, 'ok');
});

// ── Mediciones degradadas ────────────────────────────────────────────────────

test('sin dnsutils lo dice, en vez de dar un OK que no verificó nada', () => {
  const d = diagnosticar(sana({ dns: 'n/d', ext: 'skip' }));
  assert.equal(d.estado, 'ok');
  assert.match(d.accion, /dnsutils|dig/i, 'tiene que avisar que esa capa quedó sin medir');
});

test('un DNS que respondió por MagicDNS no cuenta como verificación externa', () => {
  const d = diagnosticar(sana({ dns: 'local', ext: 'skip' }));
  assert.match(d.accion, /MagicDNS|internet/i);
});

test('diagnosticar tolera null', () => {
  const d = diagnosticar(null);
  assert.equal(d.estado, 'falla');
  assert.equal(d.capa, 'medicion');
});

// ── Tramos: un incidente es un rango, no una línea ──────────────────────────

test('las mediciones seguidas del mismo estado se agrupan en un tramo', () => {
  const base = new Date('2026-08-14T07:30:00-0300');
  const min  = (n) => new Date(base.getTime() + n * 60000);
  const t = tramos([
    sana({ fecha: min(0) }),
    sana({ fecha: min(1), dns: 'nxdomain', ext: 'skip' }),
    sana({ fecha: min(2), dns: 'nxdomain', ext: 'skip' }),
    sana({ fecha: min(3), dns: 'nxdomain', ext: 'skip' }),
    sana({ fecha: min(4) }),
  ]);

  assert.equal(t.length, 3, 'ok → falla → ok');
  assert.equal(t[1].capa, 'dns-funnel');
  assert.equal(t[1].muestras, 3, 'tres minutos caído');
  assert.equal(t[1].desde.getMinutes(), 31);
  assert.equal(t[1].hasta.getMinutes(), 33);
});

test('un cambio de capa corta el tramo aunque las dos sean falla', () => {
  const base = new Date('2026-08-14T07:30:00-0300');
  const min  = (n) => new Date(base.getTime() + n * 60000);
  const t = tramos([
    sana({ fecha: min(0), dns: 'nxdomain', ext: 'skip' }),
    sana({ fecha: min(1), app: '000' }),
  ]);

  assert.equal(t.length, 2, 'dns-funnel y app son incidentes distintos');
});

test('tramos tolera lista vacía', () => {
  assert.deepEqual(tramos([]), []);
  assert.deepEqual(tramos(undefined), []);
});

// ── Resumen ──────────────────────────────────────────────────────────────────

test('el resumen calcula disponibilidad y agrupa por capa', () => {
  const r = resumirIncidentes([
    sana(), sana(), sana(),
    sana({ dns: 'nxdomain', ext: 'skip' }),
  ]);

  assert.equal(r.total, 4);
  assert.equal(r.conFalla, 1);
  assert.equal(r.disponibilidad, 75);
  assert.equal(r.porCapa['dns-funnel'], 1);
});

test('los avisos no cuentan como caída', () => {
  // Un cupo al 5% o una respuesta lenta no son "el sitio estuvo caído"
  const r = resumirIncidentes([sana({ cupo: '600/12000' }), sana({ t: '3' })]);
  assert.equal(r.conFalla, 0);
  assert.equal(r.disponibilidad, 100);
});

test('resumirIncidentes tolera lista vacía', () => {
  const r = resumirIncidentes([]);
  assert.equal(r.total, 0);
  assert.equal(r.disponibilidad, null, 'sin datos no se inventa un 100%');
});
