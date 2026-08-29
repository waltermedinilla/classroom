// Tests del cartel de mudanza (config/mudanza.js).
// Correr con: npm run test:unit
//
// Lo que se está protegiendo acá es un servidor que, el día que esto se prenda, va a estar
// contestando "andate a otro lado" a TODA la escuela. Dos propiedades tienen que valer sí o sí:
//
//   1. Apagado por defecto. Sin MUDANZA_URL no cambia nada. Se despliega semanas antes de
//      usarse y no puede alterarle el comportamiento a nadie mientras tanto.
//   2. /deploy nunca se tapa. Es el webhook que aplica los despliegues: si la mudanza lo
//      bloqueara, este mismo servidor quedaría sin forma de recibir el cambio que la APAGUE.
//      Es la escalera que uno deja apoyada antes de subir al techo.

const test   = require('node:test');
const assert = require('node:assert');

const { destinoMudanza, estaExenta, urlDestino, RUTAS_EXENTAS } = require('../../config/mudanza');

test('sin MUDANZA_URL la mudanza está apagada', () => {
  assert.strictEqual(destinoMudanza({}), null);
  assert.strictEqual(destinoMudanza({ MUDANZA_URL: '' }), null);
  assert.strictEqual(destinoMudanza({ MUDANZA_URL: '   ' }), null);
});

test('una URL sin esquema no prende la mudanza', () => {
  // "sanjose.escuela.site" sin https:// no sirve como destino de un redirect: el navegador lo
  // interpretaría como una ruta relativa y dejaría al visitante dando vueltas en este mismo
  // servidor. Preferimos no prender la mudanza a prenderla apuntando a la nada.
  assert.strictEqual(destinoMudanza({ MUDANZA_URL: 'sanjose.escuela.site' }), null);
});

test('la barra final se normaliza para no generar // en el destino', () => {
  assert.strictEqual(destinoMudanza({ MUDANZA_URL: 'https://sanjose.escuela.site/' }),
    'https://sanjose.escuela.site');
  assert.strictEqual(destinoMudanza({ MUDANZA_URL: 'https://sanjose.escuela.site' }),
    'https://sanjose.escuela.site');
});

test('⭐ /deploy y /health quedan SIEMPRE exentos', () => {
  // Si esto se rompe, el servidor viejo queda sin forma de recibir el despliegue que apague
  // la mudanza, y el watchdog pierde la única ruta con la que distingue "vivo" de "caído".
  assert.ok(estaExenta('/deploy'), '/deploy tiene que seguir atendiéndose');
  assert.ok(estaExenta('/health'), '/health tiene que seguir atendiéndose');
  assert.ok(RUTAS_EXENTAS.includes('/deploy'));
  assert.ok(RUTAS_EXENTAS.includes('/health'));
});

test('los estáticos de la propia pantalla quedan exentos', () => {
  // La pantalla de mudanza usa /css/style.css, el favicon y el logo. Sin exentarlos, el
  // cartel se vería roto justo en el momento en que más importa que se lea bien.
  assert.ok(estaExenta('/css/style.css'));
  assert.ok(estaExenta('/js/fecha.js'));
  assert.ok(estaExenta('/favicon.png'));
  assert.ok(estaExenta('/Logo.jpg'));
});

test('el resto de la plataforma NO queda exento', () => {
  ['/', '/login', '/courses', '/admin/users', '/soe/pedidos'].forEach((p) => {
    assert.strictEqual(estaExenta(p), false, `${p} no debería estar exenta`);
  });
});

test('el destino conserva el path del visitante', () => {
  // Quien tenía guardado el enlace a una materia aterriza en esa misma materia del servidor
  // nuevo, no en la portada.
  assert.strictEqual(
    urlDestino('https://sanjose.escuela.site', '/courses/6a28'),
    'https://sanjose.escuela.site/courses/6a28');
});

test('un path raro no rompe el destino', () => {
  // Defensa contra un path vacío o ausente: mejor la portada del servidor nuevo que una URL
  // malformada.
  assert.strictEqual(urlDestino('https://x.site', ''), 'https://x.site/');
  assert.strictEqual(urlDestino('https://x.site', undefined), 'https://x.site/');
  assert.strictEqual(urlDestino('https://x.site', 'courses'), 'https://x.site/');
});
