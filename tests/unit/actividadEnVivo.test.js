// La actividad creada desde la sala en vivo tiene que quedar donde el docente la busca.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Esta suite nace de un reporte del 2026-08-25: "al agregar tareas cuando están en vivo les
// aparece en novedades únicamente, y debe aparecer también en actividades". Medido en el
// navegador con 8 actividades previas, la nueva salía NOVENA de nueve — o sea, sí estaba en la
// solapa, pero al fondo de todo el año, donde nadie la busca.
//
// La causa son dos reglas que se contradecían:
//   · la lista viene del servidor de la más NUEVA a la más vieja (createdAt: -1), y
//   · createActivity() metía la tarjeta con addActivityTabCard(), que hace appendChild.
// En Novedades no pasaba porque ahí se usa prepend, y por eso el síntoma era justamente
// "aparece en novedades y no en actividades".
//
// El arreglo es no armar la tarjeta a mano: se le vuelve a pedir la lista al servidor, que es
// el único que sabe el orden. Estos tests custodian esa decisión desde los dos lados —el
// orden que promete el servidor y lo que hace el navegador con él— porque el bug solo existe
// cuando los dos se miran juntos.
//
// El bloque 4 es la otra mitad del mismo pedido, del mismo día: el ALUMNO que está en clase
// cuando nace la tarea. Veía el aviso en el chat y sus dos solapas quedaban viejas hasta que
// recargara. Ahora el poll de la sala pone la materia al día sola.
//
// Es la misma técnica de tests/unit/movil.test.js y del bloque 3 de salaChat.test.js: se
// afirma sobre el archivo, porque acá no hay función pura que llamar (es DOM del navegador) y
// mirarlo a ojo una vez es lo que ya se hizo.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

const courseJs   = leer('public/js/course.js');
const activities = leer('routes/activities.js');

// Recorta el cuerpo de una función de nivel superior de course.js: desde `function nombre(`
// hasta la llave que cierra en la columna 0. Sirve para afirmar sobre UNA función y no sobre
// el archivo entero, que tiene 2.000 líneas y muchas menciones de lo mismo.
function cuerpoDe(fuente, nombre) {
  const arranque = fuente.indexOf(`function ${nombre}(`);
  assert.notEqual(arranque, -1, `no existe la función ${nombre}() en public/js/course.js`);
  const cierre = fuente.indexOf('\n}', arranque);
  assert.notEqual(cierre, -1, `no se encontró el final de ${nombre}()`);
  return fuente.slice(arranque, cierre + 2);
}

// Saca los comentarios. Hace falta para las afirmaciones del tipo "esta función ya NO llama a
// tal otra": el comentario que explica POR QUÉ no la llama la nombra, y sin esto el test se
// afirmaría sobre su propia explicación. El `[^:]` protege los `https://` dentro de strings.
function sinComentarios(codigo) {
  return codigo.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const createActivity    = cuerpoDe(courseJs, 'createActivity');
const loadActivitiesTab = cuerpoDe(courseJs, 'loadActivitiesTab');
const addActivityTabCard = cuerpoDe(courseJs, 'addActivityTabCard');

// ── 1. La premisa: el servidor manda la lista de la más nueva a la más vieja ─────────────

test('GET /activities/course/:id ordena de la más nueva a la más vieja', () => {
  // Es la premisa de todo lo demás. Si algún día esto pasa a createdAt: 1, la solapa se lee
  // al revés y "agregar al final" pasaría a ser lo correcto: que el test caiga acá y se
  // revise el resto, en vez de descubrirlo por un reporte de un docente.
  assert.match(activities, /\.sort\(\{ createdAt: -1 \}\)/,
    'la solapa Actividades depende de este orden');
});

test('el navegador no reordena: pinta la lista tal como viene', () => {
  // loadActivitiesTab() recorre data.activities y va agregando. No hay sort() del lado del
  // cliente y no tiene que haberlo: el orden lo decide un solo lado.
  assert.match(loadActivitiesTab, /data\.activities\.forEach/);
  assert.ok(!/\.sort\(/.test(sinComentarios(loadActivitiesTab)),
    'si el cliente ordena por su cuenta, hay dos reglas de orden que pueden divergir');
  assert.match(addActivityTabCard, /container\.appendChild\(div\)/,
    'agregar al final es correcto MIENTRAS se pinte la lista entera en orden');
});

// ── 2. El arreglo: la solapa se rearma desde el servidor ─────────────────────────────────

test('createActivity no le arma la tarjeta a mano a la solapa Actividades', () => {
  // Este es el test que falla sin el arreglo. addActivityTabCard() hace appendChild, así que
  // llamarla desde acá deja la recién creada última, debajo de todas las viejas.
  assert.ok(!/addActivityTabCard\(/.test(sinComentarios(createActivity)),
    'insertar la tarjeta a mano la manda al fondo de la lista (el bug del 2026-08-25)');
});

test('createActivity le vuelve a pedir la lista al servidor si la solapa ya estaba cargada', () => {
  assert.match(createActivity, /window\._activitiesTabLoaded/);
  assert.match(createActivity, /await loadActivitiesTab\(\)/);
});

test('si la solapa todavía no se cargó, no se toca', () => {
  // La carga lazy del click la va a traer del servidor, ya ordenada. Refrescar acá sería una
  // consulta al pedo y dejaría la solapa marcada como cargada sin que nadie la haya abierto.
  const guarda = createActivity.match(/if \(window\._activitiesTabLoaded\)/);
  assert.ok(guarda, 'el refresco tiene que estar detrás del flag, no incondicional');
});

test('un fallo del refresco no puede dejar la solapa clavada en "Cargando…"', () => {
  // Mismo criterio que el aviso en el chat del lado del servidor (routes/activities.js): la
  // actividad YA está creada, nada de lo que venga después puede hacerla parecer perdida.
  // Sin esto, un refresco fallido deja _activitiesTabLoaded en true y el próximo click ni
  // siquiera reintenta: la solapa queda en "Cargando actividades…" hasta un F5.
  const codigo = sinComentarios(createActivity);
  const bloque = codigo.slice(codigo.indexOf('_activitiesTabLoaded'));
  assert.match(bloque, /catch/,
    'el refresco va con try/catch propio');
  assert.match(bloque, /catch[\s\S]{0,400}window\._activitiesTabLoaded = false/,
    'al fallar hay que desmarcar la solapa para que el próximo click la reintente');
});

// ── 3. Lo que ya andaba y no se puede romper ─────────────────────────────────────────────

test('en Novedades la nueva sigue yendo arriba de todo', () => {
  // El muro también va de lo más nuevo a lo más viejo, y ahí sí es prepend. Es la mitad que
  // funcionaba y la que hacía que el docente dijera "solo me aparece en novedades".
  assert.match(createActivity, /container\.prepend\(streamEl\)/);
});

test('la programada no cae al muro, pero sí va a la solapa', () => {
  // Una actividad con "disponible desde" a futuro no se publica: figura en Actividades con su
  // chip y recién aparece en Novedades cuando llega la fecha. El refresco de la solapa NO
  // puede quedar adentro de ese if, o la programada dejaría de refrescarla.
  //
  // Se mide por la sangría: dos espacios es el nivel de la función; cuatro sería estar adentro
  // del if de visibilidad.
  assert.match(createActivity, /\n  if \(window\._activitiesTabLoaded\) \{/,
    'el refresco va al nivel de la función, no anidado en el filtro del muro');
});

test('el refresco de la solapa va DESPUÉS de agregar al muro', () => {
  // buildActivityStreamEl() también escribe en window._activities, y lo hace con el objeto
  // pelado que devuelve POST /create (sin submittedCount/viewedCount/totalStudents). Si el
  // refresco fuera primero, esa escritura pisaría el objeto bueno del servidor y la primera
  // vez que el docente tocara el ojo, reemplazarTarjetaActividad() redibujaría la tarjeta sin
  // los chips.
  const iMuro     = createActivity.indexOf('container.prepend(streamEl)');
  const iRefresco = createActivity.indexOf('await loadActivitiesTab()');
  assert.ok(iMuro !== -1 && iRefresco !== -1 && iMuro < iRefresco,
    'el que tiene que quedar último en el cache es el objeto del servidor');
});

test('el aviso en el chat de la sala se sigue adelantando', () => {
  // El mensaje de sistema lo escribe el servidor; lrRefrescar() solo adelanta el poll para
  // que la clase lo vea en el momento y no dentro de cuatro segundos.
  assert.match(createActivity, /desdeSala && typeof window\.lrRefrescar === 'function'/);
});

// ── 4. El alumno que está en clase: la materia se pone al día sola ───────────────────────
//
// Segunda mitad del mismo pedido. El alumno estaba en la sala cuando la docente creó la tarea:
// veía el aviso en el chat y sus dos solapas seguían mostrando la lista de antes hasta que
// recargara la página. Lo único que la traía era el botón "Ver actividad".
//
// Ahora el poll de la sala, al ver un aviso NUEVO con id de actividad, refresca el muro y la
// solapa. Verificado el 2026-08-25 con dos sesiones de verdad (el alumno en el navegador, la
// docente creando por HTTP): las dos pantallas se pusieron al día solas, sin recargar.

const sala = leer('views/partials/live-room.ejs');

// Las funciones del partial viven dentro de un IIFE, así que cierran con dos espacios.
function cuerpoDeSala(nombre) {
  const arranque = sala.indexOf(`function ${nombre}(`);
  assert.notEqual(arranque, -1, `no existe ${nombre}() en views/partials/live-room.ejs`);
  const cierre = sala.indexOf('\n  }', arranque);
  assert.notEqual(cierre, -1, `no se encontró el final de ${nombre}()`);
  return sala.slice(arranque, cierre + 4);
}

const ponerAlDia = cuerpoDeSala('ponerLaMateriaAlDia');

test('el poll pone la materia al día en cada vuelta', () => {
  // Va afuera del if de mensajes: si el poll trae una tanda vacía tiene que seguir siendo un
  // no-op, no quedar salteado.
  assert.match(sala, /\n      ponerLaMateriaAlDia\(s\.mensajes \|\| \[\]\);/,
    'la llamada va al nivel del try del poll, no anidada en el if de mensajes');
});

test('se refrescan las DOS pantallas, no solo la solapa', () => {
  // Refrescar Actividades y no Novedades sería el mismo bug al revés: la tarea aparecería en
  // un lado y "no" en el otro, que es exactamente lo que reportó el usuario.
  assert.match(ponerAlDia, /loadStream\(\)/,
    'el muro también tiene que ponerse al día (y de paso recalcula "Próximas entregas")');
  assert.match(ponerAlDia, /loadActivitiesTab\(\)/);
});

test('la solapa se refresca solo si ya estaba cargada', () => {
  assert.match(ponerAlDia, /if \(window\._activitiesTabLoaded\) \{/,
    'sin abrir, su carga lazy ya la va a traer del servidor: refrescar sería al pedo');
});

test('cada actividad se atiende UNA sola vez', () => {
  // La trampa que obliga al Set: una actividad PROGRAMADA le manda el aviso al alumno pero el
  // servidor se la filtra de la lista, así que nunca va a entrar en window._activities.
  // Preguntando solo por el cache, cada poll dispararía un refresco nuevo, para siempre.
  // Medido: 10 polls con una programada anunciada → 1 solo refresco.
  assert.match(sala, /const actividadesAvisadas = new Set\(\);/);
  assert.match(ponerAlDia, /!actividadesAvisadas\.has\(id\)/);
  assert.match(ponerAlDia, /anotarActividades\(msgs\);/,
    'hay que anotarlas SIEMPRE, incluso cuando no se refresca');
});

test('lo que ya vino pintado del servidor no cuenta como novedad', () => {
  // Sin esto, un repintado completo —sala reabierta, o `forzarRepintado`— trae el chat entero
  // otra vez y lo tomaría todo por nuevo.
  assert.match(sala, /anotarActividades\(SALA\.mensajes \|\| \[\]\);/,
    'el arranque tiene que anotar los avisos ya pintados');
});

test('en la sala suelta no se toca nada', () => {
  // views/rooms/standalone.ejs (dirección y preceptoría) es la única página que usa este
  // partial sin public/js/course.js: llamar a loadStream() ahí sería un ReferenceError en cada
  // poll. Es el mismo criterio del botón "Ver actividad".
  assert.match(ponerAlDia, /if \(!EN_MATERIA\) return;/);
});

test('quien la creó no pide la lista dos veces', () => {
  // createActivity() ya refrescó y la dejó en el cache; el aviso le llega igual por el poll.
  // Medido: 6 polls tras crear desde la sala → 1 sola consulta, la de createActivity.
  assert.match(ponerAlDia, /window\._activities \|\| \{\}/);
  assert.match(ponerAlDia, /nuevas\.every\(id => cache\[id\]\) return|if \(nuevas\.every\(id => cache\[id\]\)\) return/);
});

test('un refresco que falla no puede cortar el poll de la sala', () => {
  // Van sin await y con catch: el poll de la sala es lo que mantiene viva la presencia de la
  // clase, y no puede quedar colgado de que ande el refresco de otra solapa.
  assert.match(ponerAlDia, /loadStream\(\)\.catch\(/);
  assert.match(ponerAlDia, /loadActivitiesTab\(\)\.catch\(\(\) => \{ window\._activitiesTabLoaded = false; \}\)/,
    'si falla el de la solapa, se la desmarca para que el próximo click la reintente');
});
