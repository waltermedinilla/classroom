// Auditoría de las subidas de imagen — que ningún camino falle en silencio.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/subidas-de-imagen.spec.md. Esta suite existe por lo que se encontró el
// 2026-08-24 barriendo los seis caminos de subida uno al lado del otro: tres contestaban
// un 400 con la lista de formatos, dos DESCARTABAN la imagen y contestaban 201/200 como si
// nada, y el sexto (la entrega del alumno) tenía su propia lista de extensiones, ya
// desactualizada. Ninguno de los tres problemas se veía desde un camino solo: se ven
// comparándolos, y por eso esta suite compara.
//
// Cuatro bloques:
//   1. UNA SOLA LISTA — que las tres copias de "qué es una imagen" digan lo mismo.
//   2. NUNCA EN SILENCIO — que la imagen rechazada deje cartel y línea de log, sin
//      cortar la conexión a mitad de subida.
//   3. LO QUE DECLARA CADA PANTALLA — que el selector de archivos no ofrezca lo que el
//      servidor va a rechazar, ni al revés.
//   4. LA ENTREGA — que las fotos del alumno vayan por la ruta que las recomprime.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { EXT_IMAGENES, EXT_DEPENDEN_DE_CODEC, MAX_INPUT_BYTES } = require('../../config/imagePresets');
const { ExtensionNoPermitidaError } = require('../../middleware/image-upload');
const { heifSoportado, MENSAJE_HEIC_SIN_CODEC } = require('../../services/imageOptimizer');
const Adjuntos = require('../../public/js/adjuntosActividad');

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

const imageUpload = leer('middleware/image-upload.js');
const activities  = leer('routes/activities.js');
const optimizer   = leer('services/imageOptimizer.js');
const courseJs    = leer('public/js/course.js');

// ── 1. Una sola lista ───────────────────────────────────────────────────────

test('el navegador y el servidor aceptan exactamente las mismas imágenes', () => {
  // La copia del navegador (public/js/adjuntosActividad.js) existe porque no puede
  // require() de config/. Si divergen, el síntoma es que se puede elegir un archivo que el
  // servidor rechaza — o al revés, que se rechaza en el navegador algo que el servidor
  // aceptaría, y nadie se entera.
  EXT_IMAGENES.forEach(ext => {
    assert.equal(Adjuntos.esImagen('foto' + ext), true,
      `${ext} está en EXT_IMAGENES pero el navegador no la reconoce como imagen`);
  });
  // Y al revés: nada que el navegador crea imagen puede faltar en la lista del servidor.
  ['.bmp', '.svg', '.pdf', '.zip', ''].forEach(ext => {
    assert.equal(Adjuntos.esImagen('archivo' + ext), false,
      `${ext || '(sin extensión)'} no debería contar como imagen`);
  });
});

test('están los formatos que manda la gente de verdad', () => {
  // Cada uno de estos entró por un caso real, y sacarlos vuelve a romperlo:
  //   .heic/.heif → la cámara del iPhone (2026-08-11)
  //   .jfif       → lo que guarda Chrome en Windows con "Guardar imagen como" (2026-08-24)
  //   .avif       → lo que sirven y guardan hoy muchos sitios (2026-08-24)
  //   .webp       → lo que baja de WhatsApp Web y de medio internet
  ['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.avif', '.heic', '.heif'].forEach(ext => {
    assert.ok(EXT_IMAGENES.includes(ext), `falta ${ext} en EXT_IMAGENES`);
  });
});

test('.bmp queda afuera, y es a propósito', () => {
  // Este libvips no decodifica BMP ("unsupported image format"). Aceptarlo por extensión
  // cambiaría un rechazo honesto por un "El archivo no es una imagen válida" que miente
  // sobre un BMP perfectamente sano.
  assert.ok(!EXT_IMAGENES.includes('.bmp'));
});

test('el códec HEIC se declara aparte del resto', () => {
  // HEIC/HEIF dependen de que libvips traiga el loader; el resto no depende de nada.
  // Ver imageOptimizer.js: la severidad del log cambia según esto.
  assert.deepEqual(EXT_DEPENDEN_DE_CODEC, ['.heic', '.heif']);
  EXT_DEPENDEN_DE_CODEC.forEach(ext => assert.ok(EXT_IMAGENES.includes(ext)));
});

// ── 2. Nunca en silencio ────────────────────────────────────────────────────

test('ESTE es el bug de la auditoría: la imagen rechazada deja marca', () => {
  // `cb(null, false)` a secas le dice a multer "descartá y seguí", y el handler recibe
  // req.file undefined — indistinguible de "no adjuntó nada". Las rutas donde la imagen es
  // OPCIONAL (la novedad, la portada) hacían `if (req.file)` y publicaban SIN la foto, con
  // 201. Sin cartel, sin log y sin código SUB: un fallo imposible de encontrar.
  assert.ok(/req\.imagenRechazada = new ExtensionNoPermitidaError/.test(imageUpload),
    'el fileFilter tiene que dejar anotado el rechazo');
  assert.ok(!/cb\(null,\s*EXT_IMAGENES\.includes/.test(imageUpload),
    'volvió el `cb(null, <booleano>)` pelado: eso descarta la imagen en silencio');
});

test('el rechazo lo contesta subirImagen(), no cada ruta', () => {
  // Si hubiera que sumar un middleware a mano en cada ruta, la próxima que alguien escriba
  // se lo va a olvidar — y ese olvido ES el bug. Por pasar por subirImagen() ya está cubierta.
  const cuerpo = imageUpload.slice(imageUpload.indexOf('function subirImagen'));
  assert.ok(/if \(!err && req\.imagenRechazada\)/.test(cuerpo),
    'subirImagen() tiene que cortar con 400 cuando el filtro marcó la extensión');
});

test('el rechazo NO aborta el parseo (la conexión queda sana)', () => {
  // `cb(err)` corta el cuerpo a mitad de subida: el servidor contesta mientras el navegador
  // todavía manda, y el pedido SIGUIENTE de ese socket muere con "fetch failed". Pasó en el
  // smoke del 2026-08-24 y se arregló anotando el rechazo en vez de lanzarlo.
  assert.ok(!/cb\(new ExtensionNoPermitidaError/.test(imageUpload),
    'volvió el `cb(err)` en el fileFilter: eso deja la conexión a medio camino');
});

test('el error nombra la extensión y la lista completa', () => {
  const err = new ExtensionNoPermitidaError('.bmp');
  assert.ok(err.message.includes('.bmp'), 'tiene que decir QUÉ rechazó');
  EXT_IMAGENES.forEach(ext => {
    assert.ok(err.message.includes(ext), `el cartel no nombra ${ext}`);
  });
});

test('todo rechazo de imagen queda en el log', () => {
  // Sin esto, del lado del servidor no hay una sola línea que diga que a alguien le rebotó
  // una foto. Es la misma lección que ya había dejado escrita `fallar()` en routes/rooms.js.
  assert.ok(/logRechazo\(res, 413/.test(imageUpload), 'el 413 por tamaño tiene que loguearse');
  assert.ok(/logRechazo\(res, 400/.test(imageUpload), 'el 400 por formato tiene que loguearse');
});

test('el tope de entrada sigue siendo el mismo para foto y para archivo', () => {
  // 20 MB en los dos lados. La asimetría (un .zip de 20 MB entra y una foto de 9 MB no) fue
  // un bug real, arreglado el 2026-08-11.
  assert.equal(MAX_INPUT_BYTES, 20 * 1024 * 1024);
  assert.ok(/SUBMISSION_MAX_SIZE = 20 \* 1024 \* 1024/.test(activities));
});

// ── 2 bis. El códec HEIC, y el instrumento que mentía ───────────────────────

test('heifSoportado() mira los sufijos, no si existe el loader', () => {
  // ⭐ La confusión que costó una investigación entera: `sharp.format.heif.input.buffer` da
  // `true` en los binarios precompilados, y no porque sepan leer HEIC — el loader heif está
  // compilado para AVIF (libheif con AV1). El HEIC del iPhone es HEVC, que tiene patentes y
  // no viene en el prebuilt. Lo que sí lo dice es la lista de sufijos que libvips anuncia.
  assert.ok(/fileSuffix/.test(optimizer),
    'la detección tiene que leer fileSuffix');
  assert.ok(!/input\.buffer \|\| sharp\.format\.heif\.input\.file/.test(optimizer),
    'volvió la detección vieja: contesta que sí en un servidor que no lee un solo HEIC');
});

test('heifSoportado() coincide con lo que este binario declara', () => {
  const sufijos = require('sharp').format?.heif?.input?.fileSuffix || [];
  const esperado = sufijos.includes('.heic') || sufijos.includes('.heif');
  assert.equal(heifSoportado(), esperado,
    `sufijos declarados: ${JSON.stringify(sufijos)}`);
});

test('sin códec, el HEIC se rechaza RÁPIDO y con el mismo cartel', () => {
  // Sin esto la foto de 5 MB viaja entera por la red del aula para morir recién al
  // decodificar. El cartel es idéntico en los dos momentos porque es el mismo problema: por
  // eso el mensaje es una constante compartida y no dos textos parecidos.
  assert.ok(/EXT_DEPENDEN_DE_CODEC\.includes\(ext\) && !heifSoportado\(\)/.test(imageUpload),
    'el fileFilter tiene que cortar el HEIC cuando falta el códec');
  assert.ok(/MENSAJE_HEIC_SIN_CODEC/.test(imageUpload) && /MENSAJE_HEIC_SIN_CODEC/.test(optimizer),
    'el cartel del rechazo rápido y el del fallo al decodificar tienen que ser el mismo');
  assert.ok(/iPhone/.test(MENSAJE_HEIC_SIN_CODEC) && /compatible/i.test(MENSAJE_HEIC_SIN_CODEC),
    'el cartel tiene que decir qué pasó y qué hacer');
});

test('la falta de códec se avisa UNA vez al arrancar, no en cada foto', () => {
  // Un log que grita en cada intento por algo que no cambia hasta que alguien toque el
  // servidor deja de leerse. Ver la nota de logging en agente.md.
  assert.ok(/if \(sharpDisponible\(\) && !heifSoportado\(\)\)/.test(optimizer),
    'el aviso de "falta el códec" va al cargar el módulo');
});

// ── 3. Lo que declara cada pantalla ─────────────────────────────────────────

// Todo `accept=` que sirva para elegir una IMAGEN tiene que ofrecer lo que el servidor
// acepta. El caso que esto caza: el input de la entrega declaraba
// `.jpg,.jpeg,.png,.gif,.zip` mientras el resto de la aplicación ya tomaba HEIC.
const PANTALLAS_CON_FOTO = [
  ['views/course.ejs',              'imageInput'],           // imagen de una novedad
  ['views/course.ejs',              'activityImageInput'],   // imagen adjunta a la actividad
  ['views/course.ejs',              'hImageInput'],          // portada de la materia
  ['views/activities/new.ejs',      'imageInput'],           // idem, pantalla completa
  ['views/profile.ejs',             'avatarFileInput'],      // avatar
  ['views/partials/live-room.ejs',  'lrFileImagen'],         // foto en la sala en vivo
];

for (const [archivo, id] of PANTALLAS_CON_FOTO) {
  test(`el selector #${id} de ${path.basename(archivo)} ofrece lo que el servidor acepta`, () => {
    const fuente = leer(archivo);
    const m = fuente.match(new RegExp(`id="${id}"[^>]*`));
    assert.ok(m, `no existe el input #${id} en ${archivo} — ¿se renombró?`);
    const accept = (m[0].match(/accept="([^"]*)"/) || [])[1];
    assert.ok(accept, `#${id} no declara accept`);

    // `image/*` es lo que hace aparecer la cámara en el celular, y además es lo que hace que
    // iOS CONVIERTA el HEIC a JPG en el camino. Las extensiones sueltas cubren los formatos
    // cuyo MIME el sistema no siempre mapea, sobre todo en escritorio.
    assert.ok(accept.includes('image/*'), `#${id} tendría que aceptar image/* (la cámara del celular)`);
    ['.jfif', '.avif'].forEach(ext => {
      assert.ok(accept.includes(ext), `#${id} no ofrece ${ext}`);
    });

    // Y NO tiene que nombrar .heic: Safari manda el original cuando el formulario dice que lo
    // acepta, y este servidor no lo puede leer. Ver la nota larga en config/imagePresets.js.
    // Esto se revisa el día que el servidor tenga el códec HEVC, no antes.
    ['.heic', '.heif'].forEach(ext => {
      assert.ok(!accept.includes(ext),
        `#${id} nombra ${ext}: eso le pide al iPhone justo lo único que no sabemos leer`);
    });
  });
}

// ── 4. La entrega del alumno ────────────────────────────────────────────────

test('el selector de la entrega sigue el mismo criterio que las vistas', () => {
  const m = courseJs.match(/id="subFileInput"[\s\S]{0,200}?accept="([^"]*)"/);
  assert.ok(m, 'no se encontró el accept del input de la entrega');
  assert.ok(m[1].includes('image/*'), 'la entrega tiene que dejar sacar la foto con la cámara');
  assert.ok(!m[1].includes('.heic'),
    'nombrar .heic hace que el iPhone mande el original, que es lo que no podemos leer');
  assert.ok(m[1].includes('.pdf') && m[1].includes('.zip'),
    'y sin perder los documentos, que es lo que más se entrega');
});

test('la foto de la entrega va por la ruta que la recomprime', () => {
  assert.ok(/upload-submission-image/.test(activities),
    'falta la ruta POST /:id/upload-submission-image');
  assert.ok(/esFoto \? '\/upload-submission-image' : '\/upload-submission-file'/.test(courseJs),
    'el navegador tiene que elegir la ruta según si el archivo es una foto');
  assert.ok(/preset: 'adjunto'[\s\S]{0,120}ENTREGAS_BASE/.test(activities),
    'la foto de la entrega usa el preset `adjunto` (2000px): el docente la LEE, no la mira');
});

test('la entrega ya no tiene su propia lista de imágenes', () => {
  // El bug: `SUB_ALLOWED_EXTS` repetía jpg/png/gif a mano y se quedó sin .heic ni .webp
  // cuando el resto de la aplicación ya los aceptaba.
  const m = courseJs.match(/const SUB_ALLOWED_EXTS = \[([^\]]*)\]/);
  assert.ok(m, 'no existe SUB_ALLOWED_EXTS');
  ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].forEach(ext => {
    assert.ok(!m[1].includes(`'${ext}'`),
      `SUB_ALLOWED_EXTS volvió a listar '${ext}' a mano en vez de preguntarle a Adjuntos.esImagen()`);
  });
  assert.ok(/const esFoto = Adjuntos\.esImagen\(file\.name\)/.test(courseJs),
    'la validación de la entrega tiene que usar la regla compartida');
});

test('el permiso se chequea ANTES de recibir los 20 MB', () => {
  // Misma regla que `exigirGestorDelCurso` para el docente: multer recibe el cuerpo entero
  // antes de que corra el handler, así que un chequeo tardío deja que alguien que no puede
  // entregar igual empuje el archivo.
  const i = activities.indexOf('exigirAlumnoQuePuedeEntregar, subirImagen');
  assert.ok(i !== -1, 'el guard tiene que ir ANTES de subirImagen en la cadena de la ruta');
});
