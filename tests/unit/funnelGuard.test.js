// Tests del criterio del guardián del Funnel (services/funnelGuard.js).
// Correr con: npm run test:unit
//
// LO QUE PROTEGEN: que el guardián NO resetee el Funnel cuando no corresponde. Este es el
// único componente del proyecto que ejecuta un comando destructivo solo, cada minuto, sin
// que nadie mire. Los dos modos de falla graves son opuestos y los dos están cubiertos acá:
//
//   1. Resetear de más → cada reset corta las conexiones TLS en curso y reinicia la
//      propagación del registro DNS. Encadenados, dejarían el sitio caído PARA SIEMPRE.
//   2. Resetear de menos → vuelve el ritual manual de entrar por SSH a las 7 de la mañana,
//      que es justamente lo que esta herramienta viene a eliminar.

const test   = require('node:test');
const assert = require('node:assert');

const {
  parsearLinea, evaluar, decidirAccion, resumir, agregarSerie, CONFIG_DEFAULT,
} = require('../../services/funnelGuard');

// Medición sana. Cada test rompe UNA capa sobre esta base.
const sana = (over = {}) => ({
  app: '200', dns: 'ok', dnsip: '199.38.181.54', ext: '200', tls: '0.21', funnel: 'on', ...over,
});

// Registro ya escrito en el log (lo que devuelve parsearLinea).
const reg = (over = {}) => ({
  fecha: new Date('2026-08-23T07:00:00-0300'),
  ...sana(), estado: 'ok', capa: '-', accion: 'ninguna', resultado: '-', fallas: 0, ...over,
});

// ── Parseo ───────────────────────────────────────────────────────────────────

test('parsea una línea real del guardián', () => {
  const r = parsearLinea('2026-08-23T07:03:01-0300 app=200 dns=ok dnsip=199.38.181.54 ext=200 tls=0.21 funnel=on estado=ok capa=- accion=ninguna resultado=- fallas=0');
  assert.equal(r.app, '200');
  assert.equal(r.dns, 'ok');
  assert.equal(r.estado, 'ok');
  assert.equal(r.fallas, 0);
  assert.equal(r.fecha.getFullYear(), 2026);
});

test('una línea corrupta devuelve null en vez de romper el panel', () => {
  assert.equal(parsearLinea(''), null);
  assert.equal(parsearLinea('basura sin fecha'), null);
  assert.equal(parsearLinea('2026-08-23T07:03:01-0300'), null, 'sin campos no sirve');
  assert.equal(parsearLinea('2026-08-23T07:03:01-0300 app=200'), null, 'sin estado= no hay veredicto');
  assert.equal(parsearLinea(null), null);
  assert.equal(parsearLinea(undefined), null);
});

// ── El veredicto de una medición ─────────────────────────────────────────────

test('todo sano = ok', () => {
  const v = evaluar(sana());
  assert.equal(v.estado, 'ok');
  assert.equal(v.capa, '-');
});

test('⭐ app sana + DNS caído = el Funnel, que es lo que este guardián repara', () => {
  // El escenario de los incidentes del 20/07, 22/07 y 10/08: el servidor perfecto y el
  // nombre público sin resolver desde internet.
  const v = evaluar(sana({ dns: 'nxdomain', dnsip: 'none', ext: 'skip' }));
  assert.equal(v.estado, 'falla');
  assert.equal(v.capa, 'dns-funnel');
});

test('DNS ok pero la conexión pública no completa = también es el Funnel', () => {
  // El incidente 2 (22/07): resolvía bien y el handshake TLS se caía.
  const v = evaluar(sana({ ext: '000' }));
  assert.equal(v.estado, 'falla');
  assert.equal(v.capa, 'funnel');
});

test('⭐ si la app está caída la capa es "app", NO el Funnel', () => {
  // De adentro hacia afuera: con la app caída, que el camino público falle es consecuencia.
  // Si esto dijera "funnel", el guardián resetearía Tailscale cada minuto mientras el
  // problema real está en PM2 o en el código.
  const v = evaluar(sana({ app: '000', ext: '502' }));
  assert.equal(v.capa, 'app');

  assert.equal(evaluar(sana({ app: '500' })).capa, 'app', 'un 500 también es la app caída');
  assert.equal(evaluar(sana({ app: '503' })).capa, 'app');
});

test('un 3xx de la app cuenta como sana (redirección al login)', () => {
  assert.equal(evaluar(sana({ app: '302' })).estado, 'ok');
});

test('el DNS que responde con IP interna de Tailscale es indeterminado, no falla', () => {
  // MagicDNS contestó: la consulta no salió a internet, así que no probó nada. Marcarlo
  // como falla haría resetear el Funnel por una medición que no vio internet.
  const v = evaluar(sana({ dns: 'local', dnsip: '100.114.77.83' }));
  assert.equal(v.estado, 'indeterminado');
});

test('sin poder consultar el DNS, la medición es indeterminada', () => {
  assert.equal(evaluar(sana({ dns: 'error' })).estado, 'indeterminado');
  assert.equal(evaluar(null).estado, 'indeterminado');
});

// ── La decisión: cuándo se toca el Funnel ────────────────────────────────────

const ctx = (over = {}) => ({
  fallasConsecutivas: 0, minutosDesdeReparacion: null, config: CONFIG_DEFAULT, ...over,
});

test('todo sano = no se toca nada', () => {
  assert.equal(decidirAccion(evaluar(sana()), ctx()).accion, 'ninguna');
});

test('⭐ falla del Funnel confirmada = se repara', () => {
  const v = evaluar(sana({ dns: 'nxdomain', ext: 'skip' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 2 }));
  assert.equal(d.accion, 'reparar');
});

test('una sola medición fallada todavía no dispara el reset', () => {
  // Con un chequeo por minuto, la primera falla puede ser un paquete UDP perdido. Un reset
  // por un falso positivo cuesta un corte real.
  const v = evaluar(sana({ dns: 'nxdomain', ext: 'skip' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 1 }));
  assert.equal(d.accion, 'esperar');
});

test('con FUNNEL_FALLAS=1 sí repara a la primera', () => {
  const v = evaluar(sana({ dns: 'nxdomain', ext: 'skip' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 1, config: { ...CONFIG_DEFAULT, fallasParaReparar: 1 } }));
  assert.equal(d.accion, 'reparar');
});

test('⭐ no se resetea dos veces seguidas: hay que dejar propagar', () => {
  // El reset republica el registro DNS y esa propagación tardó 10-15 min el 20/07.
  // Resetear encima la reinicia desde cero: el nombre no se publicaría nunca.
  const v = evaluar(sana({ dns: 'nxdomain', ext: 'skip' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 5, minutosDesdeReparacion: 3 }));
  assert.equal(d.accion, 'esperar');
  assert.match(d.motivo, /propagaci/i);
});

test('pasado el enfriamiento, si sigue roto se vuelve a reparar', () => {
  const v = evaluar(sana({ dns: 'nxdomain', ext: 'skip' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 12, minutosDesdeReparacion: 11 }));
  assert.equal(d.accion, 'reparar');
});

test('⭐ con la app caída NO se toca el Funnel', () => {
  // Resetear acá agregaría un corte encima de un sitio que ya está mal, y mandaría a
  // investigar Tailscale cuando el problema está en la aplicación.
  const v = evaluar(sana({ app: '000', ext: '000' }));
  const d = decidirAccion(v, ctx({ fallasConsecutivas: 10 }));
  assert.equal(d.accion, 'omitida');
});

test('una medición indeterminada nunca dispara el reset', () => {
  const v = evaluar(sana({ dns: 'error' }));
  assert.equal(decidirAccion(v, ctx({ fallasConsecutivas: 10 })).accion, 'omitida');
});

test('modo=siempre resetea aunque esté todo sano (el pedido literal, con su advertencia)', () => {
  const d = decidirAccion(evaluar(sana()), ctx({ config: { ...CONFIG_DEFAULT, modo: 'siempre' } }));
  assert.equal(d.accion, 'reparar');
});

// ── Resumen para el monitor ──────────────────────────────────────────────────

test('resumir cuenta fallas, reparaciones y disponibilidad', () => {
  const r = resumir([
    reg({ fecha: new Date('2026-08-23T07:00:00-0300') }),
    reg({ fecha: new Date('2026-08-23T07:01:00-0300'), estado: 'falla', capa: 'dns-funnel', accion: 'esperar', fallas: 1 }),
    reg({ fecha: new Date('2026-08-23T07:02:00-0300'), estado: 'falla', capa: 'dns-funnel', accion: 'reparar', resultado: 'ok', fallas: 2 }),
    reg({ fecha: new Date('2026-08-23T07:03:00-0300') }),
  ]);
  assert.equal(r.total, 4);
  assert.equal(r.conFalla, 2);
  assert.equal(r.disponibilidad, 50);
  assert.equal(r.reparaciones, 1);
  assert.equal(r.ultimaReparacion.getMinutes(), 2);
  assert.equal(r.fallasSeguidas, 0, 'el último chequeo está sano');
  assert.equal(r.ultimo.estado, 'ok');
});

test('la racha de fallas se cuenta desde el final', () => {
  const r = resumir([
    reg(),
    reg({ estado: 'falla', capa: 'funnel' }),
    reg({ estado: 'falla', capa: 'funnel' }),
  ]);
  assert.equal(r.fallasSeguidas, 2);
});

test('una reparación que falló al ejecutarse se cuenta aparte', () => {
  // Es el caso "el cron no tiene permisos de sudo": el guardián detecta bien y no puede
  // arreglar. Si se contara como reparación exitosa, el panel diría que está todo cubierto.
  const r = resumir([reg({ estado: 'falla', capa: 'funnel', accion: 'reparar', resultado: 'error' })]);
  assert.equal(r.errores, 1);
  assert.match(r.ultimo.texto, /falló|permisos/i);
});

test('sin registros el resumen no rompe', () => {
  const r = resumir([]);
  assert.equal(r.total, 0);
  assert.equal(r.disponibilidad, null);
  assert.equal(r.ultimo, null);
  assert.equal(resumir(null).total, 0);
});

// ── Serie temporal ───────────────────────────────────────────────────────────

test('⭐ los minutos sin chequeo quedan como hueco, no pegados al dato anterior', () => {
  // La trampa que ya mordió en el gráfico del rate limit: sin rellenar, un cron caído tres
  // horas se ve igual que un hueco de un minuto.
  const desde = new Date('2026-08-23T07:00:00-0300');
  const hasta = new Date('2026-08-23T07:50:00-0300');
  const serie = agregarSerie([reg({ fecha: new Date('2026-08-23T07:05:00-0300') })], desde, hasta, 10);

  assert.equal(serie.length, 6, 'seis buckets de 10 minutos');
  assert.equal(serie[0].estado, 'ok', 'el bucket con el chequeo');
  assert.equal(serie[1].estado, 'vacio');
  assert.equal(serie[5].estado, 'vacio');
});

test('un bucket con fallas y chequeos sanos mezclados es "parcial"', () => {
  const desde = new Date('2026-08-23T07:00:00-0300');
  const hasta = new Date('2026-08-23T07:09:00-0300');
  const serie = agregarSerie([
    reg({ fecha: new Date('2026-08-23T07:01:00-0300') }),
    reg({ fecha: new Date('2026-08-23T07:02:00-0300'), estado: 'falla', accion: 'reparar' }),
  ], desde, hasta, 10);

  assert.equal(serie[0].estado, 'parcial');
  assert.equal(serie[0].total, 2);
  assert.equal(serie[0].fallas, 1);
  assert.equal(serie[0].reparaciones, 1, 'la reparación se marca en la franja');
});

test('un bucket con todos los chequeos fallados es "falla"', () => {
  const desde = new Date('2026-08-23T07:00:00-0300');
  const serie = agregarSerie([
    reg({ fecha: new Date('2026-08-23T07:01:00-0300'), estado: 'falla' }),
    reg({ fecha: new Date('2026-08-23T07:02:00-0300'), estado: 'falla' }),
  ], desde, new Date('2026-08-23T07:09:00-0300'), 10);
  assert.equal(serie[0].estado, 'falla');
});
