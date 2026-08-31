// Barrido de los iconos de Material que la aplicación usa realmente.
//
// Existe porque la fuente completa pesa 3,8 MB (~3.700 iconos) y la app usa ~270. Pidiéndole
// a Google solo esos, el archivo baja a 233 KB. La diferencia no se nota en una computadora
// sola, pero a las 7 de la mañana con 300 dispositivos entrando juntos son 70 MB por el
// enlace de la escuela en vez de 1,1 GB.
//
// ⚠️ EL PRECIO DE EQUIVOCARSE ES ALTO Y SILENCIOSO. Un icono que no entre en la lista no da
// error en ningún lado: se muestra con su NOMBRE en inglés ("dynamic_feed") al lado del
// control, para siempre. Es exactamente el problema que este recorte vino a resolver.
//
// Por eso este archivo es UNO SOLO y lo usan los dos lados: tools/actualizar-iconos.js lo
// llama para escribir el partial, y tests/unit/iconos.test.js lo llama para verificar que el
// partial siga al día. Si fueran dos implementaciones, tarde o temprano dirían cosas
// distintas y el test dejaría de proteger.

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

// Dónde puede aparecer el nombre de un icono. `services` y `routes` entran porque hay
// catálogos de iconos en código (config/sections.js, los tipos de la auditoría, los estados
// de una actividad) que las vistas después imprimen con <%= algo.icon %>.
const CARPETAS = [
  ['views',      ['.ejs']],
  ['public/js',  ['.js']],
  ['config',     ['.js']],
  ['services',   ['.js']],
  ['routes',     ['.js']],
  ['middleware', ['.js']],
];

// Un nombre de icono de Material: minúsculas, dígitos y guion bajo, al menos 3 caracteres.
const NOMBRE = /^[a-z][a-z0-9_]{2,}$/;

// El contenido de un <span class="material-symbols-outlined">…</span>.
//
// ⚠️ Cierra en `</span>` y NO en el primer `<`. Parece un detalle y no lo es: la mitad de los
// iconos se imprimen con un ternario de EJS (`<%= x ? 'task_alt' : 'front_hand' %>`), y `<%=`
// EMPIEZA con `<`. Con el patrón que cortaba en el primer `<`, todos esos quedaban vacíos y
// el barrido devolvía 217 iconos en vez de 270 — 53 que habrían aparecido en inglés.
const CONTEXTO = /material-symbols-outlined[^>]*>([\s\S]*?)<\/span>/g;

// Cualquier cadena entrecomillada que parezca un nombre de icono, dentro de ese contexto.
const ENTRECOMILLADO = /['"]([a-z][a-z0-9_]{2,})['"]/g;

// Catálogos en código: { icon: 'badge' }, { icono: 'schedule' }, { iconName: 'star' }.
// Se toma de más a propósito: un nombre que no sea un icono real solo agrega unos bytes al
// archivo, mientras que uno que falte se ve roto en pantalla. El error barato es incluir.
const CAMPO_ICONO = /icon(?:o|Name)?\s*:\s*['"]([a-z][a-z0-9_]{2,})['"]/g;

// TABLAS de iconos: `const TIPO_ENTRADA_ICONS = { entrevista: 'record_voice_over', … }`.
//
// ⚠️ ESTE PATRÓN FALTABA Y SE PAGÓ. La clave de estas tablas es el tipo (`entrevista`) y el
// valor es el icono, así que ninguno de los dos patrones de arriba las ve: no hay un campo
// que se llame `icon` y la vista las imprime con `<%= algo[x] %>`, sin comillas. Resultado:
// los iconos de la línea de tiempo del legajo —record_voice_over, family_restroom,
// handshake— se venían mostrando con su nombre en inglés desde que existe el recorte, que es
// exactamente el bug que este barrido vino a evitar.
//
// La convención que lo arregla es el NOMBRE: cualquier constante terminada en _ICONS o
// _ICONOS es una tabla de iconos y todos sus valores entrecomillados entran. Una tabla nueva
// que respete el nombre queda cubierta sola.
const TABLA_ICONOS = /_ICON(?:S|OS)\s*=\s*\{([\s\S]*?)\n\}/g;

function archivosDe(dir, exts) {
  const abs = path.join(RAIZ, dir);
  if (!fs.existsSync(abs)) return [];
  const salida = [];
  (function recorrer(d) {
    for (const entrada of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
        recorrer(p);
      } else if (exts.some(e => entrada.name.endsWith(e))) {
        salida.push(p);
      }
    }
  })(abs);
  return salida;
}

// Devuelve los nombres de icono usados en el proyecto, ordenados y sin repetir.
function escanearIconos() {
  const nombres = new Set();
  const agregar = (x) => { if (x && NOMBRE.test(x)) nombres.add(x); };

  for (const [dir, exts] of CARPETAS) {
    for (const archivo of archivosDe(dir, exts)) {
      const src = fs.readFileSync(archivo, 'utf8');

      for (const m of src.matchAll(CONTEXTO)) {
        const bloque = m[1];
        agregar(bloque.trim());                                  // <span …>badge</span>
        for (const q of bloque.matchAll(ENTRECOMILLADO)) agregar(q[1]); // …? 'a' : 'b'
      }
      for (const m of src.matchAll(CAMPO_ICONO)) agregar(m[1]);
      for (const m of src.matchAll(TABLA_ICONOS)) {
        for (const q of m[1].matchAll(ENTRECOMILLADO)) agregar(q[1]);
      }
    }
  }
  return [...nombres].sort();
}

// La URL exacta que va en el partial. Se arma acá para que el generador y el test comparen
// exactamente lo mismo, incluido el orden de los parámetros.
function urlDeIconos(iconos) {
  return 'https://fonts.googleapis.com/css2'
       + '?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,0..200'
       + '&icon_names=' + iconos.join(',')
       + '&display=block';
}

const PARTIAL = path.join(RAIZ, 'views', 'partials', 'head-iconos.ejs');

module.exports = { escanearIconos, urlDeIconos, PARTIAL };
