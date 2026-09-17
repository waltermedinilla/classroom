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
//
// ⚠️ ARRANCA EN `<span` Y NO EN EL NOMBRE DE LA CLASE. Es la otra mitad del mismo cuidado, y
// también se pagó. La clase se nombra en el código en TRES lugares distintos: en el HTML de un
// icono, en una regla de CSS (`.tarjeta .material-symbols-outlined { … }`) y en JavaScript
// (`btn.querySelector('.material-symbols-outlined')`). Empezando en el nombre de la clase, los
// tres arrancaban un tramo.
//
// En los dos últimos no hay etiqueta que cerrar, así que `[^>]*>` seguía de largo por varios
// renglones hasta el primer `>` suelto —el de una función flecha `() =>` alcanza— y desde ahí
// se tragaba TODO hasta el próximo `</span>`, que era el de un icono de verdad. Ese icono
// quedaba fuera de la lista y salía en pantalla con su nombre en inglés. Es lo que pasó con
// `dynamic_feed`, el icono de la solapa **Novedades** de la materia (`views/course.ejs`):
// veintipico de renglones más arriba hay un `querySelector` con la clase y el barrido se lo
// comió. Lo reportaron docentes y alumnos el 2026-08-31.
//
// Pidiendo la etiqueta de apertura `<span`, una mención dentro de JS o de CSS ya no puede
// empezar un tramo: para llegar hasta ella desde un `<span` anterior habría que cruzar el `>`
// de ese span. Y no se pierde ninguno de los buenos: el código tiene 1.142 spans con la clase
// y el patrón devuelve 1.142 tramos.
//
// El `(?:<%[^<>]*%>[^<>]*)*` del medio está porque siete iconos llevan EJS DENTRO de la
// etiqueta (`title="<%= motivoCandado(sec) %>"`, `style="color:<%= r.color %>"`). Sin eso, el
// candado de /superadmin/roles y otros seis quedaban afuera.
//
// ⚠️ Y NO se escribe como `(?:[^<>]|<%[\s\S]*?%>)*`, que parece lo mismo y es más corto: esas
// dos alternativas se pisan entre sí y el retroceso se vuelve exponencial. Medido el
// 2026-08-31, el barrido no terminó en 2 minutos. Con este patrón tarda 22 milisegundos.
const CONTEXTO = /<span[^<>]*(?:<%[^<>]*%>[^<>]*)*material-symbols-outlined[^<>]*(?:<%[^<>]*%>[^<>]*)*>([\s\S]*?)<\/span>/g;

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

// Iconos que se ELIGEN en JavaScript: el `<span>` nace con un icono y el código lo cambia.
//
// ⚠️ ESTE PATRÓN FALTABA Y SE PAGÓ (2026-09-16). Al tocar el botón de modo oscuro aparecía la
// palabra "light_mode". El `<span>` del botón dice `dark_mode`, así que ese entraba; pero
// `light_mode` solo existe en `icon.textContent = theme === 'dark' ? 'light_mode' : 'dark_mode'`,
// y ninguno de los patrones de arriba mira JavaScript fuera de un `<span>`. No era el único:
// `expand_less` (el menú de solapas en el celular, al abrirlo), `play_circle` (un adjunto de
// YouTube) y `public_off` (el monitor, con el Funnel caído) llevaban el mismo camino.
//
// Un nombre elegido en JS llega a la pantalla por uno de TRES caminos, y los tres se
// reconocen por un nombre, igual que las tablas `_ICONS`:
//
//   1. Asignado a `textContent` o `innerText`:  icon.textContent = x ? 'light_mode' : 'dark_mode'
//   2. Guardado en algo que se llama icon/icono: const linkIcon = isYt ? 'play_circle' : …
//   3. Pasado a una función con un parámetro icon/icono:
//        function fnPintarEstado(texto, detalle, color, icono) { … }
//        fnPintarEstado('Caído', r.ultimo.texto, '#ea4335', 'public_off');
//
// De cada uno se toman TODAS las cadenas entrecomilladas del renglón. Eso trae algún nombre de
// más (`'dark'` del ternario del botón), que Google ignora: el error barato es incluir.
//
// El `(?![=>])` deja afuera las comparaciones (`icon === 'x'`) y las funciones flecha
// (`(icon) => …`), que no asignan nada.
const ASIGNACION_ICONO = /(?:\.textContent|\.innerText|\b[\w$]*[Ii]con[\w$]*)\s*=(?![=>])([^;\n]*)/g;
const FUNCION_CON_ICONO = /(?:function\s+([\w$]+)\s*|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:function\s*)?)\(([^()]*)\)/g;
const PARAMETRO_ICONO = /(?:^|[\s,(])icon(?:o|Name)?\s*(?:[,=)]|$)/;

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
  const fuentes = CARPETAS.flatMap(([dir, exts]) =>
    archivosDe(dir, exts).map(archivo => fs.readFileSync(archivo, 'utf8')));

  // Camino 3, primera pasada: qué funciones reciben un icono. Se juntan de TODOS los archivos
  // antes de buscar las llamadas, porque la función puede estar en public/js y la llamada en
  // una vista.
  const funcionesConIcono = new Set();
  for (const src of fuentes) {
    for (const m of src.matchAll(FUNCION_CON_ICONO)) {
      if (PARAMETRO_ICONO.test(m[3])) funcionesConIcono.add(m[1] || m[2]);
    }
  }
  const LLAMADA_CON_ICONO = funcionesConIcono.size
    ? new RegExp('\\b(?:' + [...funcionesConIcono].map(f => f.replace(/\$/g, '\\$')).join('|') + ')\\s*\\(([^;\\n]*)', 'g')
    : null;

  for (const src of fuentes) {
    for (const m of src.matchAll(CONTEXTO)) {
      const bloque = m[1];
      agregar(bloque.trim());                                  // <span …>badge</span>
      for (const q of bloque.matchAll(ENTRECOMILLADO)) agregar(q[1]); // …? 'a' : 'b'
    }
    for (const m of src.matchAll(CAMPO_ICONO)) agregar(m[1]);
    for (const m of src.matchAll(TABLA_ICONOS)) {
      for (const q of m[1].matchAll(ENTRECOMILLADO)) agregar(q[1]);
    }
    for (const m of src.matchAll(ASIGNACION_ICONO)) {                 // caminos 1 y 2
      for (const q of m[1].matchAll(ENTRECOMILLADO)) agregar(q[1]);
    }
    if (LLAMADA_CON_ICONO) {                                           // camino 3
      for (const m of src.matchAll(LLAMADA_CON_ICONO)) {
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
