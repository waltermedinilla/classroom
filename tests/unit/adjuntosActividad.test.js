// Tests de las reglas de adjuntos de una actividad (public/js/adjuntosActividad.js).
//
// Pedido que originó la feature (2026-08-19): "en la creación de una actividad, el docente
// debe poder subir y compartir archivos de imágenes". De ahí salen las dos reglas de este
// archivo: cuál adjunto es una imagen (decide por qué ruta se sube y si se dibuja miniatura)
// y qué URL puede guardarse como adjunto de una actividad.
//
// Criterios de aceptación en specs/actividad-imagenes.spec.md.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { EXT_IMAGEN, extensionDe, esImagen, esUrlDeAdjunto, escaparTexto } = require('../../public/js/adjuntosActividad');
const { EXT_IMAGENES } = require('../../config/imagePresets');

describe('esImagen', () => {

  test('reconoce los formatos que sube una docente desde la compu o el celular', () => {
    for (const nombre of ['pizarron.jpg', 'mapa.JPEG', 'consigna.png', 'foto.webp', 'animado.gif']) {
      assert.ok(esImagen(nombre), `${nombre} debería contar como imagen`);
    }
  });

  test('reconoce el .heic del iPhone', () => {
    // Es el formato por defecto de la cámara de iOS desde iOS 11: la docente saca la foto y
    // la sube sin enterarse de que no es un .jpg. Si esto se rompe, el navegador la manda por
    // la ruta de PDF/Word y el rebote no explica nada.
    assert.ok(esImagen('IMG_4021.HEIC'));
    assert.ok(esImagen('foto.heif'));
  });

  test('un PDF, un Word o un Excel NO son imágenes', () => {
    for (const nombre of ['guia.pdf', 'consigna.docx', 'notas.xlsx', 'planilla.xls']) {
      assert.ok(!esImagen(nombre), `${nombre} no debería contar como imagen`);
    }
  });

  test('mira SIEMPRE la última extensión, no la primera', () => {
    // "foto.png.exe" es un .exe. Con un match sobre cualquier punto del nombre se colaba por
    // la ruta de imágenes, y del otro lado hay un archivo que se guarda y se le sirve al alumno.
    assert.ok(!esImagen('foto.png.exe'));
    assert.ok(esImagen('captura.exe.png')); // al revés sí: la extensión real es .png
  });

  test('no se cae con un nombre raro, vacío o ausente', () => {
    for (const nombre of ['', 'sinextension', '.jpg', undefined, null]) {
      assert.strictEqual(typeof esImagen(nombre), 'boolean', `falló con ${JSON.stringify(nombre)}`);
    }
    // ".jpg" es un archivo oculto sin extensión (como .gitignore), no una imagen llamada jpg.
    assert.ok(!esImagen('.jpg'));
  });

  test('extensionDe devuelve la extensión en minúsculas y con el punto', () => {
    assert.strictEqual(extensionDe('Pizarron.JPG'), '.jpg');
    assert.strictEqual(extensionDe('sinextension'), '');
  });

  test('la lista del navegador es EXACTAMENTE la que autoriza el servidor', () => {
    // La lista que decide de verdad es EXT_IMAGENES (config/imagePresets.js), la del fileFilter
    // de multer. La copia de public/js existe solo porque el navegador no puede require() de
    // config/. Si divergen, el síntoma es una docente que elige una foto y el servidor se la
    // rechaza (o al revés), y nadie relaciona una cosa con la otra. Este test es lo que evita
    // que la divergencia llegue a producción.
    assert.deepStrictEqual([...EXT_IMAGEN].sort(), [...EXT_IMAGENES].sort());
  });
});

describe('esUrlDeAdjunto', () => {

  test('acepta la URL que devuelven las rutas de subida', () => {
    assert.ok(esUrlDeAdjunto('/archivos/687f1a2b3c4d5e6f70819293/actividades/6890a1b2c3d4e5f607182930/m8x3k2a1b9.webp'));
    assert.ok(esUrlDeAdjunto('/archivos/general/actividades/general/1755-abc.pdf'));
  });

  test('rechaza cualquier URL que no cuelgue de /archivos/', () => {
    // `uploadedFiles` es un JSON que arma el navegador: lo que llega es lo que quiera mandar
    // quien llame a POST /activities/create, no lo que se subió. Sin esta guarda se podía
    // guardar como "archivo" de la tarea una URL cualquiera, y quien la abría era el alumno.
    for (const url of [
      'https://ejemplo.com/algo.pdf',
      'javascript:alert(document.cookie)',
      '//evil.example/archivos/x.png',       // protocol-relative: el prefijo NO está al principio
      '/entregas/otro-alumno/tarea.pdf',
      'data:text/html,<script>1</script>',
      '/archivos/',                          // el prefijo solo, sin archivo
      '',
      undefined,
      null,
    ]) {
      assert.ok(!esUrlDeAdjunto(url), `debería rechazar ${JSON.stringify(url)}`);
    }
  });

  test('rechaza los ".." aunque el prefijo esté bien', () => {
    // No es paranoia de más: al borrar la actividad, la ruta hace
    // path.join(ARCHIVOS_BASE, url.replace('/archivos/', '')) para limpiar el disco. Un ".."
    // pasa el prefijo y sale de la carpeta — el unlink termina en otro lado.
    assert.ok(!esUrlDeAdjunto('/archivos/../../server.js'));
    assert.ok(!esUrlDeAdjunto('/archivos/escuela/../../../.env'));
  });

  test('el nombre del archivo se pinta escapado, no como HTML', () => {
    // El nombre lo elige quien sube el archivo y se pintaba crudo en la lista de adjuntos que
    // ve el alumno: un archivo llamado "<img src=x onerror=…>.pdf" era un script guardado en
    // la base que corría en la pantalla de cada alumno del curso.
    const nombre = '<img src=x onerror="alert(1)">.pdf';
    const salida = escaparTexto(nombre);
    assert.ok(!salida.includes('<'), `no puede quedar ningún "<" sin escapar: ${salida}`);
    assert.ok(!salida.includes('"'), `no puede quedar ninguna comilla sin escapar: ${salida}`);
    assert.ok(salida.includes('&lt;img'), `debería escapar la etiqueta: ${salida}`);
    // Y el `&` primero, o "&lt;" se convertiría en "&amp;lt;" y el nombre se vería mal.
    assert.strictEqual(escaparTexto('Guía & apunte.pdf'), 'Guía &amp; apunte.pdf');
    // Un nombre normal no cambia: esto no puede ensuciar el 99,9% de los casos.
    assert.strictEqual(escaparTexto('pizarrón clase 1.webp'), 'pizarrón clase 1.webp');
    assert.strictEqual(escaparTexto(null), '');
  });

  test('rechaza la barra invertida de Windows', () => {
    // El servidor de desarrollo corre en Windows y path.join respeta el separador nativo:
    // "/archivos/..\\..\\algo" no lleva ningún ".." literal para un chequeo ingenuo de "/..".
    assert.ok(!esUrlDeAdjunto('/archivos/escuela\\..\\..\\server.js'));
  });
});
