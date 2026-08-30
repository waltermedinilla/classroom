// Tests del recorte de la fuente de iconos.
// Correr con: npm run test:unit
//
// Qué se protege acá. La app pide a Google SOLO los iconos que usa (270 de ~3.700), lo que
// baja el archivo de 3,8 MB a 233 KB. El precio de equivocarse es alto y silencioso: un icono
// que no esté en la lista **no da error en ningún log**, simplemente se muestra con su NOMBRE
// en inglés al lado del control —"dynamic_feed" junto a Novedades— para siempre. Es
// exactamente el problema que los usuarios reportaron el 2026-08-30 y que este recorte vino a
// resolver; sin este test, lo reintroduciríamos de a un icono por vez.
//
// La lista la genera `npm run iconos:actualizar`. Este test vuelve a barrer el código con el
// MISMO módulo y falla si el partial se quedó atrás.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');

const { escanearIconos, urlDeIconos, PARTIAL } = require('../../tools/iconos');

const contenido = () => fs.readFileSync(PARTIAL, 'utf8');
const urlDelPartial = () => {
  const m = contenido().match(/href="([^"]+)"/);
  assert.ok(m, 'views/partials/head-iconos.ejs tiene que tener un <link href="...">');
  return m[1];
};
const listaDe = (url) => {
  const m = url.match(/icon_names=([^&]*)/);
  return m ? m[1].split(',').filter(Boolean) : [];
};

test('⭐ no falta ningún icono en la lista del partial', () => {
  const enElCodigo  = escanearIconos();
  const enElPartial = new Set(listaDe(urlDelPartial()));
  const faltan = enElCodigo.filter(i => !enElPartial.has(i));

  assert.deepStrictEqual(faltan, [],
    'Estos iconos se usan en el código pero NO están en views/partials/head-iconos.ejs:\n' +
    faltan.map(i => '  · ' + i).join('\n') +
    '\n\nCada uno de ellos se va a ver como su nombre en inglés al lado del control.\n' +
    'Se arregla con:  npm run iconos:actualizar\n');
});

test('el partial pide la fuente con display=block, no swap', () => {
  // Con `swap` el navegador dibuja el NOMBRE del icono mientras baja la fuente. Para una
  // fuente de texto es lo correcto; para una de iconos es el bug que originó todo esto.
  const url = urlDelPartial();
  assert.ok(url.includes('display=block'), 'la fuente tiene que pedirse con display=block');
  assert.ok(!url.includes('display=swap'), 'display=swap muestra el nombre del icono como texto');
});

test('el partial pide un recorte y no la familia completa', () => {
  const url = urlDelPartial();
  assert.ok(url.includes('icon_names='),
    'sin icon_names se bajan los ~3.700 iconos (3,8 MB) en vez de los 270 que se usan');
  assert.ok(listaDe(url).length > 100,
    'la lista quedó sospechosamente corta: ¿se corrió el generador con el código a medias?');
});

test('el partial NO se incluye a sí mismo', () => {
  // Paso exactamente esto el 2026-08-30 al migrar las 87 vistas: el script que reemplazaba el
  // <link> por el include recorrió TAMBIÉN el partial y lo dejó incluyéndose a sí mismo. En
  // producción eso es una recursión infinita en el primer render de cualquier pantalla.
  assert.ok(!contenido().includes("include('") || !contenido().includes('head-iconos'),
    'head-iconos.ejs se está incluyendo a sí mismo: eso es una recursión infinita al renderizar');
});

test('todas las vistas con <head> propio incluyen el partial', () => {
  // Si una vista se quedó con el <link> viejo a mano, esa pantalla baja los 3,8 MB completos
  // y además se desincroniza el día que cambie la lista.
  const sueltas = [];
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = require('path').join(dir, e.name);
      if (e.isDirectory()) { recorrer(p); continue; }
      if (!e.name.endsWith('.ejs')) continue;
      if (p.endsWith('head-iconos.ejs')) continue;
      const s = fs.readFileSync(p, 'utf8');
      if (s.includes('fonts.googleapis')) sueltas.push(p);
    }
  })(require('path').join(__dirname, '..', '..', 'views'));

  assert.deepStrictEqual(sueltas, [],
    'Estas vistas todavía piden la fuente por su cuenta en vez de incluir el partial:\n' +
    sueltas.map(p => '  · ' + p).join('\n'));
});
