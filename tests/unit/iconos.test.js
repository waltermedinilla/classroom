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

test('⭐ ningún icono escrito como texto se pierde por lo que haya arriba en el archivo', () => {
  // Este barrido es A PROPÓSITO distinto al de tools/iconos.js, y por eso vale: el de allá
  // recorre el archivo entero con una sola expresión, y el 2026-08-31 se descubrió que una
  // mención de la clase dentro de JavaScript le hacía saltear el icono siguiente —así se
  // perdió `dynamic_feed`, el de la solapa Novedades de la materia, que docentes y alumnos
  // vieron escrito en inglés—. Un test que usara el MISMO barrido habría dicho que todo
  // estaba bien. Este mira icono por icono, sin arrastrar nada de lo anterior.
  const CLASE = 'material-symbols-outlined';
  const archivos = [];
  (function recorrer(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = require('path').join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') recorrer(p); }
      else if (e.name.endsWith('.ejs') || e.name.endsWith('.js')) archivos.push(p);
    }
  })(require('path').join(__dirname, '..', '..', 'views'));
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = require('path').join(dir, e.name);
      if (e.isDirectory()) recorrer(p); else if (e.name.endsWith('.js')) archivos.push(p);
    }
  })(require('path').join(__dirname, '..', '..', 'public', 'js'));

  const usados = new Map();
  for (const archivo of archivos) {
    const src = fs.readFileSync(archivo, 'utf8');
    let i = -1;
    while ((i = src.indexOf(CLASE, i + 1)) !== -1) {
      const fin = src.indexOf('</span>', i);
      if (fin === -1) continue;
      const bloque = src.slice(i, fin);
      // Un icono son unos pocos caracteres. Un tramo largo es una mención en CSS o en JS que
      // se estiró hasta el `</span>` de otro: ahí no hay nada que leer.
      if (bloque.length > 400) continue;
      const m = bloque.match(/>\s*([a-z][a-z0-9_]{2,})\s*$/);
      if (m) usados.set(m[1], archivo + ':' + src.slice(0, i).split('\n').length);
    }
  }

  assert.ok(usados.size > 150,
    'el barrido de control encontró solo ' + usados.size + ' iconos: se rompió él, no la lista');
  assert.ok(usados.has('dynamic_feed'),
    'la solapa Novedades de la materia dejó de usar dynamic_feed: si el icono cambió, este ' +
    'testigo del bug del 2026-08-31 hay que actualizarlo a mano');

  const enElPartial = new Set(listaDe(urlDelPartial()));
  const faltan = [...usados].filter(([icono]) => !enElPartial.has(icono));

  assert.deepStrictEqual(faltan, [],
    'Estos iconos están escritos en una vista pero NO están en la lista del partial:\n' +
    faltan.map(([icono, donde]) => '  · ' + icono + '  (' + donde + ')').join('\n') +
    '\n\nCada uno se ve como su nombre en inglés al lado del control.\n' +
    'Se arregla con:  npm run iconos:actualizar\n');
});

test('⭐ los iconos que se ELIGEN desde JavaScript entran en la lista', () => {
  // Tercer reporte del mismo síntoma, tercera causa (2026-09-16): al tocar el botón de modo
  // oscuro aparecía la palabra "light_mode". El `<span>` del botón dice `dark_mode`, así que
  // ese entraba; `light_mode` solo existe dentro de un ternario de JavaScript que lo escribe
  // con `textContent`, y el barrido solo miraba lo escrito dentro de un `<span>`. Los otros
  // tres son la misma familia, cada uno por uno de los tres caminos que tiene un nombre elegido
  // en JS para llegar a la pantalla. Si alguno deja de usarse, este testigo se actualiza a mano.
  const enElCodigo = new Set(escanearIconos());
  const testigos = {
    light_mode:  'views/partials/footer.ejs — asignado con textContent (botón de modo oscuro)',
    expand_less: 'public/js/nav-responsive.js — asignado con textContent (menú de solapas en el celular)',
    play_circle: 'public/js/course.js — guardado en la variable linkIcon (adjunto de YouTube)',
    public_off:  'views/superadmin/monitor.ejs — pasado al parámetro `icono` de fnPintarEstado',
  };
  const faltan = Object.entries(testigos).filter(([icono]) => !enElCodigo.has(icono));

  assert.deepStrictEqual(faltan, [],
    'El barrido de tools/iconos.js dejó de ver estos iconos elegidos desde JavaScript:\n' +
    faltan.map(([icono, donde]) => '  · ' + icono + '  (' + donde + ')').join('\n'));
});

test('⭐ control por diccionario: ningún nombre de icono real del código falta en la lista', () => {
  // Este control NO mira el contexto —ni el `<span>`, ni el `textContent`, ni el nombre de la
  // variable—, que es justamente lo que le falló tres veces al barrido. Mira el NOMBRE: toda
  // cadena entrecomillada que sea un icono real de Material Symbols tiene que estar en la
  // lista. Así pesca un icono que llegue a la pantalla por un camino que todavía no conocemos.
  //
  // El diccionario es tests/fixtures/material-symbols-nombres.txt, bajado el 2026-09-16 de
  // github.com/google/material-design-icons (variablefont/MaterialSymbolsOutlined…codepoints,
  // primera columna). Si Google agrega iconos nuevos y se usan, conviene refrescarlo.
  //
  // Se limita a nombres CON guion bajo. Las palabras sueltas que también son iconos (`list`,
  // `label`, `style`, `select`, `tab`…) aparecen en el código por mil motivos y darían cuarenta
  // falsas alarmas; con guion bajo, el 2026-09-16 hubo cero: las cuatro que saltaron eran
  // iconos de verdad que se veían en inglés.
  const path = require('path');
  const RAIZ = path.join(__dirname, '..', '..');
  const diccionario = new Set(
    fs.readFileSync(path.join(RAIZ, 'tests', 'fixtures', 'material-symbols-nombres.txt'), 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  assert.ok(diccionario.size > 3000 && diccionario.has('dynamic_feed'),
    'el diccionario de iconos no cargó bien (' + diccionario.size + ' nombres): se rompió él, no la lista');

  // Nombres con forma de icono real que en el código NO se usan como icono. Si este control
  // salta por uno así, se agrega acá con el motivo: no se lo mete a la fuerza en la lista.
  const NO_SON_ICONOS = new Set([]);

  const CARPETAS = [['views', '.ejs'], ['public/js', '.js'], ['config', '.js'],
                    ['services', '.js'], ['routes', '.js'], ['middleware', '.js']];
  const enElPartial = new Set(listaDe(urlDelPartial()));
  const faltan = new Map();
  for (const [carpeta, ext] of CARPETAS) {
    (function recorrer(dir) {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') recorrer(p); continue; }
        if (!e.name.endsWith(ext)) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/['"`]([a-z][a-z0-9]*_[a-z0-9_]+)['"`]/g)) {
          const nombre = m[1];
          if (!diccionario.has(nombre) || enElPartial.has(nombre) || NO_SON_ICONOS.has(nombre)) continue;
          if (!faltan.has(nombre)) {
            faltan.set(nombre, path.relative(RAIZ, p) + ':' + src.slice(0, m.index).split('\n').length);
          }
        }
      }
    })(path.join(RAIZ, carpeta));
  }

  assert.deepStrictEqual([...faltan], [],
    'Estos nombres son iconos de Material y están en el código, pero NO en la lista del partial:\n' +
    [...faltan].map(([icono, donde]) => '  · ' + icono + '  (' + donde + ')').join('\n') +
    '\n\nSi se usan como icono, se ven con su nombre en inglés. Hay que enseñarle a ' +
    'tools/iconos.js a verlos y correr  npm run iconos:actualizar.\n' +
    'Si NO son iconos, van a NO_SON_ICONOS en este test, con el motivo.\n');
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
