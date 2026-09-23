// Los planos de AutoCAD (.dwg y .dxf) entran por TODOS los caminos de subida del docente y del
// alumno. Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Pedido del 2026-08-29: "quiero que incluyas archivos DWG para la carga de los docentes, y de
// los alumnos, en todas sus acciones", y en seguida "agregá también el .dxf".
//
// Por qué una suite entera para dos extensiones: "qué se puede subir" NO vive en un lugar, vive
// en nueve —tres listas del servidor, dos del navegador y cuatro `accept=`—. La historia del
// proyecto ya mostró cómo se rompe eso. El 2026-08-24 la entrega del alumno tenía su propia
// lista, se quedó sin `.heic`, y el síntoma fue una foto de iPhone rechazada por un cartel que
// nombraba a las imágenes entre lo permitido. Agregar una extensión en ocho de los nueve
// lugares es exactamente el mismo bug con otra fecha, y no se ve mirando un camino solo: se ve
// comparándolos, que es lo que hace esta suite.
//
// El .dxf se agregó UN DÍA después que el .dwg, y esa es la prueba de que la suite sirve para
// lo que se escribió: la segunda extensión entró por los nueve lugares sin tener que salir a
// buscarlos de nuevo.
//
// ⚠️ ACTUALIZADO por specs/correccion-de-entregas.spec.md (2026-09-21), y esto es la mitad
// importante del cambio, no un detalle: hasta acá decía "los planos no tienen visor en el
// navegador... el previsualizador los manda al botón Descargar", y eso DEJÓ DE SER CIERTO para
// los dos formatos (§ I): el `.dxf` se dibuja DIRECTO en el navegador (`dxf-viewer`, RN-42) y
// el `.dwg` se dibuja vía un `.dxf` derivado que convierte el servidor con ODA File Converter
// (RN-42a). Las aserciones de abajo sobre `VER_EN_LINEA`, en cambio, SIGUEN SIENDO CIERTAS Y NO
// SE TOCAN: `VER_EN_LINEA` es la lista de la SALA EN VIVO (qué se sirve `inline` en el chat), y
// esa decisión no cambió — los planos se siguen bajando `attachment` con su mime y `nosniff`
// (RN-39/RN-42g). Lo que cambió es que AHORA HAY UN VISOR APARTE (el del corrector), no que la
// sala empezó a mostrarlos inline. Ver el bloque "§ I — los planos SÍ tienen visor" más abajo.
//
// Esta suite también se generalizó de "los planos" a "los formatos que tienen que estar en
// las siete listas de RN-44" (RN-44d, CA-64): además de .dwg/.dxf ahora exige .ppt/.pptx en
// los mismos lugares (§ J de la spec de corrección de entregas). PowerPoint SÍ tiene visor
// (recorre la cadena de Office, RN-44e) — por eso NO entra en las aserciones de "no se puede
// previsualizar" que siguen valiendo para los planos... que ahora tampoco valen para ellos. La
// única extensión que de verdad sigue sin ningún visor, a los fines de esta suite, es una que
// no está en ninguna de las listas (se usa `.zip` como testigo en el bloque de abajo).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { EXT_ARCHIVOS } = require('../../services/liveRoom');
const Adjuntos = require('../../public/js/adjuntosActividad');

// Los dos formatos de plano, siempre juntos. Sumar un tercero (un .rvt de Revit, un .skp de
// SketchUp) es agregarlo acá y correr la suite: lo que falle es la lista que quedó atrás.
const PLANOS = ['.dwg', '.dxf'];

// § J — PowerPoint (RN-44). Van los dos formatos, igual que los planos: no tiene sentido
// aceptar .pptx y dejar .ppt afuera, ni al revés.
const POWERPOINT = ['.ppt', '.pptx'];

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

const activities = leer('routes/activities.js');
const rooms      = leer('routes/rooms.js');
const courseJs   = leer('public/js/course.js');
const courseEjs  = leer('views/course.ejs');
const nuevaEjs   = leer('views/activities/new.ejs');
const salaEjs    = leer('views/partials/live-room.ejs');

// Las listas del servidor viven adentro de un router que arrastra mongoose entero, así que no
// se pueden require() desde un test unitario: se leen del texto. Es el mismo recurso que usa
// tests/unit/subidaImagenes.test.js, y alcanza porque lo que se vigila es el CONTENIDO de la
// lista, no cómo se evalúa.
function listaDeExtensiones(fuente, nombre, dondeDice) {
  const m = fuente.match(new RegExp(`const\\s+${nombre}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `no se encontró la lista ${nombre} en ${dondeDice} — ¿se renombró?`);
  const items = m[1].match(/'([^']*)'/g);
  assert.ok(items && items.length, `la lista ${nombre} de ${dondeDice} quedó vacía`);
  return items.map(s => s.slice(1, -1));
}

// El `accept=` puede estar en el mismo renglón que el id o en el siguiente (las vistas lo
// parten para no pasarse de ancho), por eso el salto de línea entra en el patrón.
function acceptDe(fuente, id, dondeDice) {
  const m = fuente.match(new RegExp(`id="${id}"[\\s\\S]{0,200}?accept="([^"]*)"`));
  assert.ok(m, `no se encontró el accept de #${id} en ${dondeDice} — ¿se renombró el input?`);
  return m[1].split(',').map(s => s.trim());
}

const EXT_ALLOWED     = listaDeExtensiones(activities, 'EXT_ALLOWED',     'routes/activities.js');
const EXT_SUBMISSIONS = listaDeExtensiones(activities, 'EXT_SUBMISSIONS', 'routes/activities.js');
const DOC_EXTS        = listaDeExtensiones(nuevaEjs,   'DOC_EXTS',        'views/activities/new.ejs');
const SUB_ALLOWED     = listaDeExtensiones(courseJs,   'SUB_ALLOWED_EXTS','public/js/course.js');
const VER_EN_LINEA    = listaDeExtensiones(rooms,      'VER_EN_LINEA',    'routes/rooms.js');

// ── 1. El servidor ──────────────────────────────────────────────────────────

test('las tres listas del servidor aceptan los dos planos', () => {
  // Son los tres lugares donde el fileFilter de multer decide de verdad. Que el navegador
  // deje elegir el archivo no sirve de nada si acá rebota.
  for (const plano of PLANOS) {
    assert.ok(EXT_ALLOWED.includes(plano),
      `el adjunto de la actividad (docente) tiene que aceptar ${plano}`);
    assert.ok(EXT_SUBMISSIONS.includes(plano),
      `la entrega del alumno tiene que aceptar ${plano}`);
    assert.ok(EXT_ARCHIVOS.includes(plano),
      `el archivo de la sala en vivo tiene que aceptar ${plano}`);
  }
});

// RN-44 (§ J, specs/correccion-de-entregas.spec.md): PowerPoint YA entra por la sala en vivo
// (EXT_ARCHIVOS) pero no por acá — esa asimetría es justo lo que RN-44 corrige. CA-64 pide
// literalmente que ESTE archivo (el que ata las listas entre sí) sea el que falle si `.pptx`
// se cae de alguna de las siete.
test('RN-44 / CA-64 — las tres listas del servidor aceptan PowerPoint (.ppt y .pptx)', () => {
  for (const ppt of POWERPOINT) {
    assert.ok(EXT_ALLOWED.includes(ppt),
      `el adjunto de la actividad (docente) tiene que aceptar ${ppt} — RN-44, lugar #1`);
    assert.ok(EXT_SUBMISSIONS.includes(ppt),
      `la entrega del alumno tiene que aceptar ${ppt} — RN-44, lugar #2`);
    assert.ok(EXT_ARCHIVOS.includes(ppt),
      `la sala en vivo YA acepta ${ppt} desde antes de esta feature — si esto falla, se rompió algo que ya andaba`);
  }
});

test('las extensiones se comparan siempre en minúscula y con punto', () => {
  // path.extname(...).toLowerCase() es lo que se compara contra estas listas: una entrada
  // como 'DXF' o 'dxf' sin punto no coincidiría nunca y el rechazo no se explicaría solo.
  for (const [nombre, lista] of [['EXT_ALLOWED', EXT_ALLOWED],
                                 ['EXT_SUBMISSIONS', EXT_SUBMISSIONS],
                                 ['EXT_ARCHIVOS', EXT_ARCHIVOS]]) {
    assert.ok(lista.every(e => e.startsWith('.') && e === e.toLowerCase()),
      `${nombre} tiene una entrada sin punto o con mayúsculas`);
    assert.strictEqual(new Set(lista).size, lista.length, `${nombre} tiene entradas repetidas`);
  }
});

// ── 2. El navegador dice lo mismo que el servidor ───────────────────────────

test('la lista del creador de actividades es la del servidor, sin el punto', () => {
  // DOC_EXTS (views/activities/new.ejs) es la copia que valida ANTES de subir. Si se separan,
  // el síntoma es un archivo que se puede elegir y el servidor rechaza —o al revés, uno que el
  // navegador rebota y el servidor habría aceptado, que es peor porque no deja rastro en
  // ningún log.
  assert.deepStrictEqual(
    DOC_EXTS.slice().sort(),
    EXT_ALLOWED.map(e => e.slice(1)).sort(),
    'DOC_EXTS y EXT_ALLOWED se separaron');
});

test('la lista de la entrega es la del servidor sin las imágenes', () => {
  // EXT_SUBMISSIONS conserva las de imagen como red para el JS viejo en cache (ver el
  // comentario de routes/activities.js); la del navegador no las tiene porque las fotos las
  // decide Adjuntos.esImagen() y van por la ruta que las recomprime. Sacando esas, tienen que
  // ser la misma lista — y ahí es donde los planos tienen que aparecer en las dos.
  const documentosDelServidor = EXT_SUBMISSIONS.filter(e => !Adjuntos.esImagen('archivo' + e));
  assert.deepStrictEqual(
    SUB_ALLOWED.slice().sort(),
    documentosDelServidor.map(e => e.slice(1)).sort(),
    'SUB_ALLOWED_EXTS y EXT_SUBMISSIONS se separaron');
});

// ── 3. Lo que declara cada pantalla ─────────────────────────────────────────

// Los cuatro selectores por los que puede entrar un documento. Si uno no nombra el plano, el
// explorador de archivos de Windows lo deja en gris y la persona concluye que la plataforma no
// lo acepta — sin cartel, sin error y sin nada que investigar después. Es el modo de falla más
// caro de los nueve, justamente porque no se queja.
const SELECTORES_DE_DOCUMENTO = [
  [nuevaEjs,  'fileInput',         'views/activities/new.ejs',     'adjunto del docente, pantalla completa'],
  [courseEjs, 'activityFileInput', 'views/course.ejs',             'adjunto del docente, modal de la materia'],
  [courseJs,  'subFileInput',      'public/js/course.js',          'entrega del alumno'],
  [salaEjs,   'lrFileArchivo',     'views/partials/live-room.ejs', 'archivo de la sala en vivo'],
];

for (const [fuente, id, archivo, quien] of SELECTORES_DE_DOCUMENTO) {
  test(`el selector #${id} (${quien}) ofrece los dos planos`, () => {
    const accept = acceptDe(fuente, id, archivo);
    for (const plano of PLANOS) {
      assert.ok(accept.includes(plano), `#${id} no ofrece ${plano}; declara: ${accept.join(',')}`);
    }
  });
}

// CA-63(c): "el accept= de los tres inputs lo ofrece — verificado leyendo el atributo, no a
// ojo, porque su olvido no da error: deja el archivo en gris sin cartel ni log" (RN-44b). Son
// los mismos tres selectores de docente/alumno de arriba — el de la sala en vivo (lrFileArchivo)
// queda afuera de este chequeo puntual porque RN-44 dice que YA los ofrece desde antes.
const SELECTORES_DE_ACTIVIDAD = SELECTORES_DE_DOCUMENTO.filter(([, id]) => id !== 'lrFileArchivo');

for (const [fuente, id, archivo, quien] of SELECTORES_DE_ACTIVIDAD) {
  test(`CA-63(c) — el selector #${id} (${quien}) ofrece PowerPoint (.ppt y .pptx)`, () => {
    const accept = acceptDe(fuente, id, archivo);
    for (const ppt of POWERPOINT) {
      assert.ok(accept.includes(ppt),
        `#${id} no ofrece ${ppt}; declara: ${accept.join(',')} — RN-44b: esto no da error, deja ` +
        'el archivo en gris en el explorador y nadie se entera de por qué');
    }
  });
}

// ── 4. El plano se descarga, no se intenta abrir ────────────────────────────

test('un plano no cuenta como imagen en ningún lado', () => {
  // Si contara, la entrega lo mandaría a /upload-submission-image y sharp se lo comería con un
  // "no se puede decodificar": el plano tiene que ir por la ruta de documentos, entero.
  for (const plano of PLANOS) {
    assert.strictEqual(Adjuntos.esImagen('plano' + plano), false);
    assert.strictEqual(Adjuntos.esImagen('PLANO' + plano.toUpperCase()), false);
    assert.ok(!Adjuntos.EXT_IMAGEN.includes(plano));
  }
});

test('los planos no se sirven en línea: se bajan', () => {
  // mime-types los mapea a `image/vnd.dwg` y `image/vnd.dxf`, así que un navegador al que se
  // los mandemos inline se queda con una pestaña en blanco creyendo que le pasamos una imagen
  // rota. La sala decide inline/attachment con VER_EN_LINEA y ahí no están — a propósito.
  for (const plano of PLANOS) {
    assert.ok(!VER_EN_LINEA.includes(plano),
      `ningún navegador sabe dibujar un ${plano}: tiene que bajarse`);
  }
});

test('el DXF es texto plano y aun así no se sirve como texto', () => {
  // La diferencia entre los dos planos que no es evidente: el DWG es binario, el DXF es ASCII.
  // Un archivo de texto que la escuela guarda y sirve de vuelta es la familia de la que hay que
  // desconfiar —es lo que hace peligroso a un .html o a un .svg—. Acá no llega a serlo porque
  // el tipo declarado es `image/vnd.dxf` y helmet manda `nosniff`, pero eso vale la pena
  // dejarlo escrito: si algún día alguien sirviera estos archivos como `text/*`, el .dxf es el
  // que hay que volver a mirar.
  assert.ok(/nosniff/.test(rooms), 'la ruta que sirve los adjuntos de la sala tiene que mandar nosniff');
  assert.ok(!VER_EN_LINEA.includes('.dxf'), 'el .dxf nunca se abre en el navegador');
  assert.ok(!VER_EN_LINEA.includes('.txt') && !VER_EN_LINEA.includes('.csv'),
    'ningún formato de texto se abre en línea, por la misma razón');
});

// ⚠️ REESCRITO por specs/correccion-de-entregas.spec.md (§ I, 2026-09-21) — no borrado, porque
// lo que hay que dejar es POR QUÉ cambió (mismo criterio que pide la spec para
// backupCarpetas.test.js): hasta acá este test se llamaba "el previsualizador manda el plano al
// botón Descargar" y afirmaba que un plano NUNCA tiene visor. Eso dejó de ser cierto para los
// dos formatos: el `.dxf` se dibuja DIRECTO en el navegador (RN-42) y el `.dwg` se dibuja vía un
// `.dxf` derivado que convierte el servidor con ODA (RN-42a). Las aserciones sobre `_isPdf` y
// `_isOffice` de la versión vieja SIGUEN SIENDO CIERTAS y no se tocan: el plano nunca pasó ni va
// a pasar por esas dos ramas, tenga o no visor propio. Lo que cambia es que ahora existe una
// TERCERA rama (el visor CAD) que sí lo reconoce, y la rama de "no se puede previsualizar"
// sigue en pie para todo lo que de verdad no tiene visor (acá, un testigo: `.zip`).
test('un plano NO pasa por las ramas de PDF ni de Office (siguen siendo ciertas, sin tocar)', () => {
  const pdf    = courseJs.match(/function _isPdf\(name\)[^\n]*/)[0];
  const office = courseJs.match(/function _isOffice\(name\)[^\n]*/)[0];
  assert.ok(!/dwg|dxf/i.test(pdf),    '_isPdf no puede reconocer un plano');
  assert.ok(!/dwg|dxf/i.test(office), '_isOffice no puede reconocer un plano');
});

test('CA-55/CA-56 — el .dxf y el .dwg SÍ tienen visor: pasan por la rama CAD, no por Descargar', () => {
  // Nombre de función propuesto por el tester (no fijado por la spec): _isCad(name). Si el
  // implementador elige otro nombre, este test es el que hay que actualizar — a propósito,
  // para que quede un solo lugar marcando el contrato.
  const m = courseJs.match(/function _isCad\(name\)[^\n]*/);
  assert.ok(m,
    'falta _isCad(name) en public/js/course.js (o el nombre que el implementador elija — este ' +
    'test documenta el contrato propuesto): la rama que reconoce .dwg/.dxf para el visor CAD (§ I)');
  if (m) {
    assert.ok(/dxf/i.test(m[0]), '_isCad tiene que reconocer .dxf (visor directo, RN-42)');
    assert.ok(/dwg/i.test(m[0]), '_isCad tiene que reconocer .dwg (visor vía derivado, RN-42a)');
  }
});

test('la rama de "no se puede previsualizar" sigue existiendo para lo que de verdad no tiene visor', () => {
  assert.ok(/no se puede previsualizar/.test(courseJs),
    'tiene que seguir existiendo la rama que ofrece descargar lo que no se puede mostrar (p.ej. un .zip)');
});

// ── 5. Los carteles ─────────────────────────────────────────────────────────

test('el cartel del adjunto del docente sale de la lista, no de un texto a mano', () => {
  // Escrito a mano decía "(PDF, Word, Excel)" y se quedaba viejo apenas la lista cambiaba: es
  // la misma forma de mentir que tenía el cartel de la entrega antes del 2026-08-24.
  assert.ok(/Aceptamos \$\{EXT_ALLOWED\.join/.test(activities),
    'el 400 de /upload-attachment tiene que enumerar EXT_ALLOWED');
  assert.ok(/Aceptamos \$\{EXT_SUBMISSIONS\.join/.test(activities),
    'el 400 de /upload-submission-file tiene que enumerar EXT_SUBMISSIONS');
});

test('los carteles del navegador nombran los dos planos', () => {
  // El que ve la persona ANTES de subir. Que nombre lo que sí se puede es la mitad útil del
  // mensaje: sin eso, "no es un formato aceptado" no dice qué hacer.
  const cartelDocente = nuevaEjs.match(/no es un formato aceptado[^`]*/)[0];
  const cartelAlumno  = courseJs.match(/no es un formato aceptado[^`]*/)[0];
  for (const [quien, cartel] of [['docente', cartelDocente], ['alumno', cartelAlumno]]) {
    assert.ok(/dwg/i.test(cartel), `el cartel del ${quien} no nombra el .dwg`);
    assert.ok(/dxf/i.test(cartel), `el cartel del ${quien} no nombra el .dxf`);
  }
});

// RN-44c / CA-65: "El olvido de un accept= no da error: da un archivo en gris" — pero ACÁ el
// error de origen sería el opuesto (un cartel que no lo menciona no es un bug técnico, pero
// deja a la persona sin saber qué hacer). Extiende el mismo criterio que ya regía para los
// planos: el test se extiende, no se duplica (RN-44d).
test('RN-44c/CA-65 — los carteles escritos a mano nombran PowerPoint', () => {
  const cartelDocente = nuevaEjs.match(/no es un formato aceptado[^`]*/)[0];
  const cartelAlumno  = courseJs.match(/no es un formato aceptado[^`]*/)[0];
  for (const [quien, cartel] of [['docente', cartelDocente], ['alumno', cartelAlumno]]) {
    assert.ok(/powerpoint|pptx?/i.test(cartel),
      `el cartel del ${quien} tiene que nombrar PowerPoint (.ppt/.pptx), como ya nombra el .dwg y el .dxf`);
  }
});

// ── 6. Lo que sigue sin poder entrar ────────────────────────────────────────

test('abrir la puerta a los planos no abrió ninguna otra', () => {
  // La regla de la casa (services/liveRoom.js): nada ejecutable y nada que el navegador pueda
  // interpretar como HTML con scripts adentro. Los planos son datos de dibujo y no se ejecutan
  // en ningún lado, por eso entran; este test es el que impide que la próxima incorporación de
  // buena fe sea un .svg o un .html. Se revisa en las TRES listas y no solo en la de la sala,
  // que era la única que lo tenía cubierto.
  //
  // El `.lsp` está en la lista negra a propósito y no por completismo: AutoLISP es el lenguaje
  // de macros de AutoCAD y es por donde se movieron los gusanos que usaron esta familia de
  // archivos. El plano se acepta; el script que lo acompaña, no.
  const prohibidas = ['.exe', '.bat', '.cmd', '.com', '.msi', '.sh', '.ps1',
                      '.js', '.mjs', '.vbs', '.jar', '.html', '.htm', '.svg', '.php',
                      '.lsp', '.fas', '.vlx', '.dvb', '.scr'];
  for (const [nombre, lista] of [['EXT_ALLOWED', EXT_ALLOWED],
                                 ['EXT_SUBMISSIONS', EXT_SUBMISSIONS],
                                 ['EXT_ARCHIVOS', EXT_ARCHIVOS]]) {
    for (const mala of prohibidas) {
      assert.ok(!lista.includes(mala), `${mala} no puede estar en ${nombre}`);
    }
  }
});

// ── 7. El recuadro de la tarjeta ────────────────────────────────────────────

test('los planos tienen su color y las dos copias del mapa dicen lo mismo', () => {
  // EXT_COLOR está duplicado (public/js/course.js y views/activities/new.ejs) porque la vista
  // no puede importar del bundle. Sin el color, el recuadro sale del gris de "no conozco esta
  // extensión", que es lo mismo que muestra un archivo roto.
  const mapaDe = (fuente, donde) => {
    const m = fuente.match(/const EXT_COLOR = \{([^}]*)\}/);
    assert.ok(m, `no se encontró EXT_COLOR en ${donde}`);
    return m[1].trim();
  };
  const enCourse = mapaDe(courseJs, 'public/js/course.js');
  const enNueva  = mapaDe(nuevaEjs, 'views/activities/new.ejs');
  assert.ok(/DWG:/.test(enCourse), 'falta el color del DWG en public/js/course.js');
  assert.ok(/DXF:/.test(enCourse), 'falta el color del DXF en public/js/course.js');
  assert.strictEqual(enNueva, enCourse, 'las dos copias de EXT_COLOR se separaron');
});
