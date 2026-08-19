// Tests del diagnóstico de subidas fallidas — el cartel que ve el docente
// (public/js/subida-diagnostico.js) y el veredicto del informe (tools/ver-subida.js).
// Correr con: npm run test:unit
//
// Lo que protegen estos tests es UNA sola propiedad, la que hace útil a la herramienta:
// **que no mienta**. Un diagnóstico equivocado no es neutro — manda a investigar la capa
// que no es y cuesta horas. Los dos casos de abajo salieron de la investigación del
// 2026-08-18 (subidas fallidas de 4 docentes y alumnos), donde el instrumento se equivocó
// en las dos direcciones a la vez.

const test   = require('node:test');
const assert = require('node:assert');

const {
  mb, detalleHumano, seguir, reintentable, esperaDe, nuevoIntento, ESPERAS_MS,
} = require('../../public/js/subida-diagnostico.js');
const { veredicto } = require('../../tools/ver-subida.js');

// ── Cero bytes enviados no es lo mismo que un kilobyte ───────────────────────
//
// Es LA distinción del diagnóstico de red: 0 bytes significa que la conexión nunca se
// estableció (mirá el Funnel / el proxy), 1 KB significa que se estableció y murió
// transmitiendo (mirá el ancho de banda / la estabilidad del enlace). Son dos
// investigaciones distintas y el cartel las confundía, porque `mb()` redondeaba hacia
// arriba con Math.max(1, …) para que 300 bytes no dijeran "0 KB".

test('mb(0) dice 0 KB y no 1 KB', () => {
  // El caso real: el cartel de SUB-9JDGX2 decía "se alcanzaron a enviar 1 KB de 739 KB"
  // cuando el navegador no había enviado NADA. El informe del servidor decía 0 KB — los
  // dos números salían del mismo dato y no coincidían.
  assert.equal(mb(0), '0 KB');
});

test('mb() sigue redondeando hacia arriba los archivos diminutos', () => {
  // El Math.max(1, …) existía por un motivo válido y no hay que perderlo: un archivo de
  // 300 bytes es un archivo real, y "0 KB" ahí sí sería la mentira.
  assert.equal(mb(300), '1 KB');
  assert.equal(mb(1), '1 KB');
});

test('mb() no toca el resto de la escala', () => {
  assert.equal(mb(739 * 1024), '739 KB');
  assert.equal(mb(2.1 * 1024 * 1024), '2,1 MB');
  assert.equal(mb(null), null);
});

test('el cartel no le dice al docente que envió 1 KB cuando envió 0', () => {
  const seg = seguir('/activities/upload-attachment', { name: 'clase.pdf', size: 739 * 1024, type: 'application/pdf' });
  // xhr.upload.onprogress nunca disparó: la conexión murió antes del primer byte.
  const texto = detalleHumano(seg, null, 'red', null);

  assert.ok(!/enviar 1 KB/.test(texto), `el cartel afirma 1 KB enviado:\n${texto}`);
  assert.ok(/739 KB/.test(texto), 'el tamaño del archivo se sigue informando');
});

// ── "No lo medí" no es lo mismo que "se envió entero" ────────────────────────
//
// Las subidas hechas con fetch no pueden informar progreso, así que van con
// `progresoMedible: false` y el reporte llega SIN el campo `enviados`. El veredicto caía
// al else y afirmaba que el archivo había subido entero, mandando a buscar un timeout del
// servidor que nadie observó. Es justo lo que el propio subida-diagnostico.js declara que
// no hay que hacer: "un diagnóstico que miente con seguridad es peor que uno que dice
// 'esto no lo sé'".

const reporte = (over = {}) => ({
  codigo: 'SUB-TEST01', motivo: 'red', archivo: { bytes: 519 * 1024 }, ms: 1500, ...over,
});

test('sin medición de progreso, el veredicto NO afirma que se envió entero', () => {
  // El caso real: SUB-5DDKY2 y SUB-1XKR4F, adjuntos de la sala en vivo (suben por fetch).
  const v = veredicto(reporte({ porcentaje: undefined, enviados: undefined }));

  assert.ok(!/alcanzó a enviar el archivo entero/.test(v), `el veredicto lo inventa:\n${v}`);
  assert.ok(!/timeout de un intermediario/.test(v), `manda a investigar un timeout no observado:\n${v}`);
  assert.ok(/no se midió|NO SE MIDIÓ/.test(v), `el veredicto tiene que admitir que no sabe:\n${v}`);
});

test('con 0% sigue diciendo que se cortó en camino', () => {
  const v = veredicto(reporte({ porcentaje: 0, enviados: 0 }));
  assert.ok(/SE CORTÓ EN CAMINO/.test(v), v);
});

test('con 100% sí afirma que subió entero y sospecha del timeout', () => {
  // La rama que existía: acá la afirmación está respaldada por una medición real.
  const v = veredicto(reporte({ porcentaje: 100, enviados: 519 * 1024 }));
  assert.ok(/alcanzó a enviar el archivo entero/.test(v), v);
});

// ── Reintento automático ─────────────────────────────────────────────────────
//
// Producción está detrás de un Tailscale Funnel con cortes intermitentes de 1-2 minutos.
// La subida se rinde en ~1 segundo, así que reintentar sola tapa el agujero. Lo que estos
// tests protegen es A QUÉ se le insiste: insistirle a algo que la aplicación rechazó a
// propósito no lo arregla, y en dos casos lo empeora.

const falla = (over = {}) => ({ motivo: 'red', status: 0, cuerpo: '', ...over });

test('la conexión cortada se reintenta', () => {
  // El caso que motivó todo: onerror, 0 bytes, sin respuesta de nadie.
  assert.equal(reintentable(falla({ motivo: 'red', status: 0, cuerpo: '' })), true);
  assert.equal(reintentable(falla({ motivo: 'timeout' })), true);
});

test('el 503 de mantenimiento NO se reintenta', () => {
  // El caso que definió el criterio. El cuerpo del mantenimiento es
  // { maintenance, message, eta } y NO trae `error`, así que buscar el campo `error` lo
  // daría por reintentable: cuatro golpes en cincuenta segundos contra un servidor que
  // está apagado a propósito, y por cada archivo que alguien intente subir.
  const cuerpo = JSON.stringify({ maintenance: true, message: 'Volvemos en un rato', eta: null });
  assert.equal(reintentable(falla({ motivo: 'http', status: 503, cuerpo })), false);
});

test('ningún rechazo por tamaño se reintenta, venga de quien venga', () => {
  // Un 413 es DETERMINISTA: el límite de cuerpo —el nuestro o el de un proxy— es
  // configuración estática, así que los cuatro intentos darían exactamente el mismo 413.
  // Serían cincuenta segundos del docente para llegar al mismo lugar. El reintento existe
  // para fallas transitorias; un archivo demasiado grande no se achica esperando.
  const nuestro = JSON.stringify({ error: 'El archivo supera el máximo de 50 MB' });
  assert.equal(reintentable(falla({ motivo: 'http', status: 413, cuerpo: nuestro })), false);
  assert.equal(reintentable(falla({ motivo: 'http', status: 413, cuerpo: '<html>413 Too Large</html>' })), false);
});

test('un rechazo nuestro no se reintenta, un 5xx de un intermediario sí', () => {
  // Acá está el eje del criterio: mismo tipo de situación, decisión opuesta según QUIÉN
  // contestó. La app dice que no a propósito; un 502 es un intermediario que puede estar
  // sano en cinco segundos.
  assert.equal(reintentable(falla({ motivo: 'http', status: 503, cuerpo: JSON.stringify({ error: 'No disponible' }) })), false);
  assert.equal(reintentable(falla({ motivo: 'http', status: 503, cuerpo: '<html>Service Unavailable</html>' })), true);
});

test('un 429 de rate limit no se reintenta', () => {
  // Reintentar un límite de tasa es la única forma de empeorarlo.
  const cuerpo = JSON.stringify({ error: 'Demasiadas subidas, esperá un momento' });
  assert.equal(reintentable(falla({ motivo: 'http', status: 429, cuerpo })), false);
});

test('los rechazos de permiso y validación no se reintentan', () => {
  assert.equal(reintentable(falla({ motivo: 'http', status: 403, cuerpo: JSON.stringify({ error: 'Sin acceso' }) })), false);
  assert.equal(reintentable(falla({ motivo: 'http', status: 400, cuerpo: JSON.stringify({ error: 'Falta courseId' }) })), false);
});

test('un 502 del proxy se reintenta', () => {
  assert.equal(reintentable(falla({ motivo: 'http', status: 502, cuerpo: '<html>Bad Gateway</html>' })), true);
});

test('un 200 con HTML (la sesión venció y redirigió al login) no se reintenta', () => {
  // Insistir devolvería el mismo HTML cuatro veces: lo que hay que hacer es volver a entrar.
  assert.equal(reintentable(falla({ motivo: 'http', status: 200, cuerpo: '<!doctype html><html>' })), false);
});

test('la ventana de reintentos son 3 esperas que suman ~50 s', () => {
  // La ventana vive acá y no en un comentario: si alguien cambia las esperas, este test lo
  // dice. Tiene que ser del orden de lo que dura un corte del Funnel (1-2 minutos).
  assert.equal(esperaDe(1), 5000);
  assert.equal(esperaDe(2), 15000);
  assert.equal(esperaDe(3), 30000);
  assert.equal(esperaDe(4), null, 'al cuarto intento ya no se espera más: se muestra el error');

  const total = ESPERAS_MS.reduce((a, b) => a + b, 0);
  assert.equal(total, 50000);
});

test('nuevoIntento acumula intentos pero reinicia el reloj y los bytes', () => {
  // Si `ms` acumulara los cuatro intentos daría ~50.000, y el informe del servidor
  // concluiría "decenas de segundos → el archivo ya estaba arriba, mirá el timeout del
  // proxy". Sería falso y mandaría a la capa equivocada — la misma clase de mentira que
  // los tests de más arriba existen para impedir.
  const seg = seguir('/activities/upload-attachment', { name: 'x.pdf', size: 700 * 1024 });

  nuevoIntento(seg);
  assert.equal(seg.intentos, 1);
  seg.enviados = 12345;
  const t0Primero = seg.t0;

  nuevoIntento(seg);
  assert.equal(seg.intentos, 2, 'el contador de intentos SÍ acumula');
  assert.equal(seg.enviados, 0, 'los bytes son del intento en curso, no del anterior');
  assert.ok(seg.t0 >= t0Primero, 'el reloj arranca de nuevo en cada intento');
});

test('una subida sin progreso medible no gana un contador de bytes al reintentar', () => {
  // Las subidas por fetch van con progresoMedible:false y `enviados` en null. Ponerlo en 0
  // acá haría que el informe afirme "se cortó apenas arrancó" para toda subida de la sala.
  const seg = seguir('/courses/x/sala/adjuntos/archivo', { name: 'x.pdf', size: 500 * 1024 },
    { progresoMedible: false });
  nuevoIntento(seg);
  assert.equal(seg.enviados, null);
});

test('el cartel dice que ya se reintentó solo', () => {
  // Decirle "probá de nuevo" a alguien que estuvo casi un minuto esperando cuatro intentos
  // suena a que la pantalla no se enteró de lo que acaba de pasar.
  const seg = seguir('/activities/upload-attachment', { name: 'x.pdf', size: 700 * 1024 });
  seg.intentos = 4;
  const texto = detalleHumano(seg, null, 'red', null);

  assert.ok(/reintentó solo 3 veces/.test(texto), texto);
  assert.ok(!/^.*probá de nuevo, y si se repite/.test(texto), 'el cierre viejo ignoraba el reintento');
});

test('sin reintentos el cartel no habla de reintentos', () => {
  // Un rechazo de la aplicación sale al primer intento: mencionar reintentos ahí sería
  // inventar algo que no pasó.
  const seg = seguir('/activities/upload-attachment', { name: 'x.pdf', size: 700 * 1024 });
  seg.intentos = 1;
  assert.ok(!/reintentó/.test(detalleHumano(seg, null, 'red', null)));
});
