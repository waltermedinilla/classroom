// Tests de las reglas que hacen usable la plataforma en un teléfono.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Estos no prueban lógica sino el marcado y el CSS, porque los bugs que cubren no eran de
// código: eran de layout. Todos se midieron a 375 px (iPhone X) recorriendo cada rol.
//
// ── Alumno ────────────────────────────────────────────────────────────────────
//   1. El contenido del header sumaba 562 px sobre 375 disponibles. El botón del avatar
//      caía entero fuera de pantalla (x 405→445) y, como `body` tiene `overflow-x:hidden`,
//      no quedaba ni siquiera alcanzable con scroll. Ese botón era el ÚNICO acceso al menú
//      con "Cerrar sesión": desde un teléfono no había forma de salir de la sesión.
//   2. Las 5 solapas de la materia sumaban 642 px sobre 347 de ancho útil, `.tabs` no
//      scrolleaba (overflow visible) y el body recortaba: "Mis notas", "Personas" y
//      "En vivo" eran inalcanzables. Un alumno no podía ver sus notas desde el celular.
//   3. En "Mi perfil", los botones "Cambiar correo" y "Cambiar contraseña" quedaban fuera
//      de pantalla (x 433→639): no se podía cambiar la contraseña desde un teléfono.
//
// ── Docente ───────────────────────────────────────────────────────────────────
//   4. `.grade-table` (calificar entregas) reparte 5 columnas por porcentaje. A 375 px la
//      tabla quedaba en 286 px y el textarea de la devolución en 67 px de ancho. No
//      desbordaba: se comprimía hasta ser inservible, que en la práctica es lo mismo.
//   5. La barra de escribir de la sala en vivo daba 19 px de alto y los botones 24×24.
//
// ── Preceptor ─────────────────────────────────────────────────────────────────
//   6. El calendario de "Actividades del día" usaba `repeat(7, 1fr)`. Un track `1fr` no
//      baja de su contenido, así que los 7 días sumaban 351 px en una tarjeta de 315 y la
//      columna del SÁBADO quedaba cortada (x 335→380).
//
// Son asserts sobre el texto de los archivos, que es tosco, pero alcanza para lo que
// interesa: que nadie borre sin querer la salida de sesión del menú lateral ni las reglas
// que hacen entrar el header, las solapas, el perfil, la grilla de calificar y el
// calendario. La verificación fina (posiciones reales) se hizo en el navegador; acá queda
// la red de seguridad contra la regresión.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const raiz   = path.join(__dirname, '..', '..');
const header = fs.readFileSync(path.join(raiz, 'views/partials/header.ejs'), 'utf8');
const css    = fs.readFileSync(path.join(raiz, 'public/css/style.css'), 'utf8');
const sala   = fs.readFileSync(path.join(raiz, 'views/partials/live-room.ejs'), 'utf8');
const calend = fs.readFileSync(path.join(raiz, 'views/preceptor/actividades.ejs'), 'utf8');
const toma   = fs.readFileSync(path.join(raiz, 'views/preceptor/asistencia-toma.ejs'), 'utf8');

// Devuelve el cuerpo de los @media (max-width: 900px) concatenados, que es el breakpoint
// que el archivo ya venía usando para móvil. Contar llaves en vez de usar un regex vago:
// los bloques tienen reglas anidadas y un `[\s\S]*?}` cortaría en la primera.
function bloquesMovil(fuente) {
  const salida = [];
  const marca = '@media (max-width: 900px)';
  let desde = 0;
  for (;;) {
    const i = fuente.indexOf(marca, desde);
    if (i === -1) break;
    const abre = fuente.indexOf('{', i);
    let nivel = 0, j = abre;
    for (; j < fuente.length; j++) {
      if (fuente[j] === '{') nivel++;
      else if (fuente[j] === '}') { nivel--; if (nivel === 0) break; }
    }
    salida.push(fuente.slice(abre + 1, j));
    desde = j;
  }
  return salida.join('\n');
}

const movil = bloquesMovil(css);

// ── 1. Salida de sesión alcanzable ──────────────────────────────────────────
// El menú del avatar no se toca (en escritorio está bien), pero el drawer tiene que
// ofrecer la salida por su cuenta: es lo único que se abre con el botón de hamburguesa,
// que sí entra en pantalla en cualquier ancho.

test('el menú lateral ofrece cerrar sesión', () => {
  const cuerpo = header.slice(header.indexOf('<div class="drawer-body">'));
  assert.match(cuerpo, /Cerrar sesión/,
    'sin esto, en un teléfono no hay ninguna forma de salir de la sesión');
  assert.match(cuerpo, /onclick="logout\(\)"/,
    'tiene que llamar a la misma función que el menú del avatar');
});

test('la salida de sesión del menú lateral no depende del rol ni de la suplantación', () => {
  const cuerpo = header.slice(header.indexOf('<div class="drawer-body">'));
  // Anclar al onclick y no al rótulo: el comentario que explica el ítem también dice
  // "Cerrar sesión" y aparece antes, así que buscar el texto medía el lugar equivocado.
  const desde  = cuerpo.indexOf('onclick="logout()"');
  // El ítem va después del bloque de `impersonating`, pero fuera de él: si quedara adentro,
  // solo lo vería un admin suplantando, que es justo quien no lo necesita.
  const previo = cuerpo.slice(0, desde);
  const abiertos = (previo.match(/<% if \(/g) || []).length;
  const cerrados = (previo.match(/<% } %>/g) || []).length;
  assert.equal(abiertos - cerrados, 1,
    'debe colgar de un solo `if` (que haya usuario), no anidado en el de impersonating');
});

test('el botón de cerrar sesión no hereda el aspecto de botón del navegador', () => {
  // Es un <button> entre <a>: sin la clase queda con fondo gris y otra tipografía.
  assert.match(header, /class="drawer-item drawer-item-btn"/);
  assert.match(css, /\.drawer-item-btn\s*{[^}]*background:\s*none/);
  assert.match(css, /\.drawer-item-btn\s*{[^}]*font-family:\s*inherit/);
});

// ── 2. El header entra en el ancho ──────────────────────────────────────────

test('en móvil el header suelta el ancho que no le hace falta', () => {
  assert.match(movil, /\.header-title\s*{\s*display:\s*none/,
    'el texto "Materias" al lado del logo se come ~90 px');
  assert.match(movil, /\.user-role\s*{\s*display:\s*none/,
    'el badge de rol se come ~75 px y ya está dentro del menú de usuario');
});

test('el rol sigue estando en el menú de usuario', () => {
  // Ocultar el badge del header solo es aceptable porque el dato no se pierde.
  const menu = header.slice(header.indexOf('<div class="user-menu"'));
  assert.match(menu, /role-badge role-<%= user\.role %>/,
    'si se saca de acá, ocultar el del header deja al usuario sin ver su rol en móvil');
});

// ── 3. Las cinco solapas de la materia se ven ───────────────────────────────

test('en móvil las solapas envuelven en vez de cortarse', () => {
  const tabs = movil.match(/\.tabs\s*{[^}]*}/g) || [];
  assert.ok(tabs.some(r => /flex-wrap:\s*wrap/.test(r)),
    'sin wrap, las que no entran quedan fuera de pantalla y sin forma de llegar');
});

test('la solapa activa se marca con relleno, no con subrayado', () => {
  // Con dos filas, el borde inferior del contenedor deja de señalar cuál está activa.
  const activa = movil.match(/\.tab\.active\s*{[^}]*}/g) || [];
  assert.ok(activa.some(r => /background:\s*var\(--primary\)/.test(r)),
    'la solapa activa necesita otra señal cuando las solapas envuelven');
});

// ── 4. Mi perfil se apila ───────────────────────────────────────────────────

test('en móvil el perfil se apila y los botones llegan a pantalla', () => {
  assert.match(movil, /\.profile-header\s*{[^}]*flex-direction:\s*column/,
    'en fila, los datos y las acciones se van fuera del ancho');
  const acciones = movil.match(/\.profile-actions\s*{[^}]*}/g) || [];
  assert.ok(acciones.some(r => /width:\s*100%/.test(r)),
    'los botones de cambiar correo/contraseña tienen que ocupar el ancho');
});

test('los nombres largos cortan en vez de desbordar', () => {
  // Vienen en formato "APELLIDO APELLIDO, NOMBRE NOMBRE" y son largos de verdad.
  assert.match(movil, /\.profile-info h2\s*{[^}]*overflow-wrap:\s*anywhere/);
});

// ── 5. Docente: calificar entregas ──────────────────────────────────────────

test('en móvil la grilla de calificar se apila en una tarjeta por alumno', () => {
  assert.match(movil, /\.grade-table td\s*{\s*display:\s*block/,
    'en tabla, la devolución queda en 67 px de ancho');
  assert.match(movil, /\.grade-table thead\s*{\s*display:\s*none/);
});

test('al ocultar la cabecera, cada campo conserva su rótulo', () => {
  // Sin thead, "Nota" y "Devolución" se quedarían sin nombre.
  assert.match(movil, /\.gt-col-grade::before\s*{\s*content:\s*'Nota'/);
  assert.match(movil, /\.gt-col-feedback::before\s*{\s*content:\s*'Devolución al alumno'/);
});

test('"Visto" y "Entrega" le ganan en especificidad al display:block de la celda', () => {
  // `.gt-col-view` sola (0,1,0) pierde contra `.grade-table td` (0,1,1) y quedarían
  // apilados ocupando media tarjeta. Por eso van prefijados.
  assert.match(movil, /\.grade-table \.gt-col-view[\s\S]{0,60}display:\s*inline-block/);
});

test('en móvil el libro de calificaciones achica la columna de nombres', () => {
  // 200 px sobre 347 dejaban menos de una columna de actividad (150 px) a la vista.
  const cols = movil.match(/\.gb-student-col\s*{[^}]*}/g) || [];
  assert.ok(cols.some(r => /width:\s*132px/.test(r)),
    'con 200 px no entraba ninguna columna de notas entera');
});

// ── 6. Docente: la barra de escribir de la sala en vivo ─────────────────────

test('la barra de escribir de la sala es tocable con el pulgar', () => {
  const bloque = sala.slice(sala.indexOf('@media (max-width: 600px)'));
  assert.match(bloque, /\.lr-adj-btn\s*{[^}]*width:40px[^}]*height:40px/);
  assert.match(bloque, /#lrEnviar\s*{[^}]*width:44px[^}]*height:44px/);
});

test('el campo de mensaje usa 16px para que iPhone no haga zoom al enfocar', () => {
  // Por debajo de 16px Safari en iOS agranda la página al enfocar un input y la deja
  // corrida de costado. No es preferencia de tamaño: es evitar ese salto.
  const bloque = sala.slice(sala.indexOf('@media (max-width: 600px)'));
  assert.match(bloque, /\.lr-composer input\s*{[^}]*font-size:16px/);
});

// ── 7. Preceptor ────────────────────────────────────────────────────────────

test('el calendario de actividades deja achicar sus 7 columnas', () => {
  // `1fr` a secas no baja del contenido (min-width:auto) y cortaba el sábado.
  assert.match(calend, /\.ad-grid\s*{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/,
    'con repeat(7, 1fr) la columna del sábado queda fuera de pantalla');
});

test('el enlace de volver del pase de lista tiene área tocable', () => {
  // Es el único camino de vuelta desde el pase de lista y medía 17 px de alto.
  const enlace = toma.match(/<a href="\/preceptor\/asistencia"[^>]*>/)[0];
  assert.match(enlace, /display:inline-block/);
  assert.match(enlace, /padding:\s*8px/);
});

// ── 8. Nada de esto toca el escritorio ──────────────────────────────────────

test('las reglas de móvil viven solo dentro del breakpoint', () => {
  // Si alguna se escapa del @media, rompe el header y las solapas en escritorio.
  const fuera = css.replace(/@media[^{]*{(?:[^{}]|{[^{}]*})*}/g, '');
  assert.doesNotMatch(fuera, /\.header-title\s*{\s*display:\s*none/);
  assert.doesNotMatch(fuera, /\.user-role\s*{\s*display:\s*none/);
  assert.doesNotMatch(fuera, /\.tabs\s*{[^}]*flex-wrap:\s*wrap/);
  assert.doesNotMatch(fuera, /\.profile-header\s*{[^}]*flex-direction:\s*column/);
  assert.doesNotMatch(fuera, /\.grade-table thead\s*{\s*display:\s*none/,
    'ocultar la cabecera en escritorio dejaría la tabla sin encabezados');
});
