// Tests del compresor de archivos del backup (services/backupCompressor.js).
//
// Runner: `node --test` — npm run test:unit
//
// Las imágenes de prueba se generan con sharp en cada corrida (mismo criterio que
// tests/images/optimizer.test.js: nada de binarios commiteados) y se escriben a un
// directorio temporal que se borra al terminar.
//
// Lo que estos tests protegen, en orden de importancia:
//   1. Que el nombre y la extensión del archivo NUNCA cambien. De eso depende que un
//      backup comprimido se pueda restaurar sin reescribir las rutas guardadas en Mongo.
//      Si esto se rompe, el restore deja la mitad de las imágenes del sitio en 404.
//   2. Que un archivo dañado no haga fracasar el backup entero.
//   3. Que los archivos que no se pueden mejorar queden intactos, no peor.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const fsp  = require('fs/promises');
const os   = require('os');
const path = require('path');
const sharp = require('sharp');

// `node --test tests/unit/*.test.js` corre cada archivo en su propio proceso, PERO todos a
// la vez. Sin esto, los fixtures de acá agotaban la memoria de libvips y hacían caer también
// a liveRoom.test.js y maintenanceWindow.test.js con "vips_tracked: out of memory" — un
// fallo desconcertante en tests que no tocan imágenes. Los fixtures además se mantienen
// chicos a propósito (ver el mismo problema documentado en tests/images/optimizer.test.js).
sharp.cache(false);
sharp.concurrency(1);

const {
  clasificar, analizarCarpetas, invalidarCache,
  comprimirImagen, comprimirArbol, TIPOS, TIPOS_COMPRIMIBLES,
} = require('../../services/backupCompressor');

// Ruido de baja frecuencia escalado: se comporta como una foto frente al compresor.
// Un color plano se comprimiría a casi nada y el ruido puro es incompresible; ninguno de
// los dos mide la rama que estos tests dicen medir (ver el comentario largo en
// tests/images/optimizer.test.js).
function fotoRealista(width, height) {
  const s = 32;
  const semilla = Buffer.alloc(s * s * 3);
  for (let i = 0; i < semilla.length; i++) semilla[i] = Math.floor(Math.random() * 256);
  return sharp(semilla, { raw: { width: s, height: s, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' });
}

let tmp;

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bkc-test-'));
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function escribir(rutaRelativa, buffer) {
  const completa = path.join(tmp, rutaRelativa);
  await fsp.mkdir(path.dirname(completa), { recursive: true });
  await fsp.writeFile(completa, buffer);
  return completa;
}

describe('clasificar', () => {

  test('mapea cada extensión a su tipo', () => {
    assert.strictEqual(clasificar('foto.jpg'),      'imagenes');
    assert.strictEqual(clasificar('foto.jpeg'),     'imagenes');
    assert.strictEqual(clasificar('captura.png'),   'imagenes');
    assert.strictEqual(clasificar('apunte.pdf'),    'pdf');
    assert.strictEqual(clasificar('avatar.webp'),   'webp');
    assert.strictEqual(clasificar('planilla.xlsx'), 'documentos');
    assert.strictEqual(clasificar('video.mp4'),     'otros');
  });

  test('es indiferente a mayúsculas y a la ruta completa', () => {
    assert.strictEqual(clasificar('FOTO.JPG'), 'imagenes');
    assert.strictEqual(clasificar('Escaneo.PDF'), 'pdf');
    assert.strictEqual(clasificar('/a/b/c/x.Png'), 'imagenes');
  });

  test('sin extensión o con nombre vacío cae en otros, no rompe', () => {
    assert.strictEqual(clasificar('LEEME'), 'otros');
    assert.strictEqual(clasificar(''),      'otros');
    assert.strictEqual(clasificar(null),    'otros');
  });

  test('webp no es comprimible: ya la optimizó imageOptimizer al subirse', () => {
    assert.strictEqual(TIPOS.webp.comprimible, false);
    assert.deepStrictEqual(TIPOS_COMPRIMIBLES, ['imagenes', 'pdf']);
  });
});

describe('comprimirImagen', () => {

  test('achica una foto grande y CONSERVA la extensión .jpg', async () => {
    const original = await fotoRealista(1900, 1400).jpeg({ quality: 95 }).toBuffer();
    const ruta = await escribir('caso-jpg/foto.jpg', original);

    const r = await comprimirImagen(ruta);

    assert.ok(r.ok, `esperaba que comprimiera, motivo: ${r.motivo}`);
    assert.ok(r.despues < r.antes / 3, `esperaba bastante ahorro, pasó de ${r.antes} a ${r.despues}`);
    // La invariante: el archivo sigue existiendo con el MISMO nombre y sigue siendo un JPEG.
    assert.ok(fs.existsSync(ruta), 'el archivo tiene que seguir en la misma ruta');
    const meta = await sharp(ruta).metadata();
    assert.strictEqual(meta.format, 'jpeg', 'un .jpg tiene que seguir siendo JPEG por dentro');
    assert.strictEqual((await fsp.stat(ruta)).size, r.despues);
  });

  test('un .png sigue siendo PNG por dentro', async () => {
    const original = await fotoRealista(1900, 1400).png().toBuffer();
    const ruta = await escribir('caso-png/captura.png', original);

    const r = await comprimirImagen(ruta);

    assert.ok(r.ok, `esperaba que comprimiera, motivo: ${r.motivo}`);
    const meta = await sharp(ruta).metadata();
    assert.strictEqual(meta.format, 'png');
  });

  test('respeta el techo de 1600 px sin agrandar las chicas', async () => {
    const grande = await escribir('caso-techo/grande.jpg',
      await fotoRealista(1900, 1300).jpeg({ quality: 95 }).toBuffer());
    const chica = await escribir('caso-techo/chica.jpg',
      await fotoRealista(400, 300).jpeg({ quality: 95 }).toBuffer());

    await comprimirImagen(grande);
    await comprimirImagen(chica);

    const metaGrande = await sharp(grande).metadata();
    assert.strictEqual(metaGrande.width, 1600);

    const metaChica = await sharp(chica).metadata();
    assert.strictEqual(metaChica.width, 400, 'una imagen chica no se agranda');
  });

  test('si el resultado pesaría más, gana el original y el archivo queda intacto', async () => {
    // Una imagen ya chiquita y comprimida al máximo: reencodearla solo agrega peso.
    const original = await fotoRealista(40, 40).jpeg({ quality: 40 }).toBuffer();
    const ruta = await escribir('caso-gana-original/chica.jpg', original);

    const r = await comprimirImagen(ruta);

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'ya-optimizada');
    assert.strictEqual(r.antes, r.despues, 'no debe reportar ahorro');
    assert.deepStrictEqual(await fsp.readFile(ruta), original, 'el archivo no se tocó');
  });

  test('elige el encoder por el formato REAL, no por la extensión mentirosa', async () => {
    // Caso real de este proyecto: hay avatares que son JPEG con nombre .png. Si el encoder
    // se eligiera por la extensión, el JPEG iría al encoder PNG, saldría más grande y se
    // perdería la compresión entera por la regla de "gana el original".
    const jpegConNombrePng = await fotoRealista(1800, 1200).jpeg({ quality: 95 }).toBuffer();
    const ruta = await escribir('caso-extension-mentirosa/avatar.png', jpegConNombrePng);

    const r = await comprimirImagen(ruta);

    assert.ok(r.ok, `esperaba que comprimiera, motivo: ${r.motivo}`);
    assert.ok(r.despues < r.antes, 'tiene que haber ahorrado');
    const meta = await sharp(ruta).metadata();
    assert.strictEqual(meta.format, 'jpeg', 'se preserva el formato real, no el que dice el nombre');
    assert.ok(fs.existsSync(ruta), 'y el nombre .png no cambia');
  });

  test('un archivo que no es una imagen se reporta ilegible y queda intacto', async () => {
    const basura = Buffer.from('esto no es una imagen, es texto renombrado');
    const ruta = await escribir('caso-roto/falsa.jpg', basura);

    const r = await comprimirImagen(ruta);

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'ilegible');
    assert.deepStrictEqual(await fsp.readFile(ruta), basura, 'el original no se pierde');
  });
});

describe('comprimirArbol', () => {

  test('sin opciones no toca nada', async () => {
    const ruta = await escribir('caso-noop/foto.jpg',
      await fotoRealista(1800, 1200).jpeg({ quality: 95 }).toBuffer());
    const antes = await fsp.readFile(ruta);

    const r = await comprimirArbol(path.join(tmp, 'caso-noop'), {});

    assert.strictEqual(r.imagenes.count, 0);
    assert.deepStrictEqual(await fsp.readFile(ruta), antes);
  });

  test('recorre subdirectorios, saltea lo no comprimible y sigue después de un archivo roto', async () => {
    const dir = path.join(tmp, 'caso-arbol');
    const foto = await fotoRealista(1800, 1200).jpeg({ quality: 95 }).toBuffer();

    await escribir('caso-arbol/escuela/actividades/a.jpg', foto);
    await escribir('caso-arbol/escuela/actividades/sub/b.jpg', foto);
    await escribir('caso-arbol/escuela/rota.jpg', Buffer.from('no soy una imagen'));
    const docx  = await escribir('caso-arbol/escuela/planilla.docx', Buffer.alloc(5000, 7));
    const otros = await escribir('caso-arbol/escuela/notas.txt', Buffer.from('hola'));

    const r = await comprimirArbol(dir, { imagenes: true });

    assert.strictEqual(r.imagenes.count, 2, 'las dos fotos válidas, incluida la del subdirectorio');
    assert.strictEqual(r.imagenes.fallidos, 1, 'la rota se cuenta pero no aborta el recorrido');
    assert.ok(r.imagenes.despues < r.imagenes.antes);

    // Lo que no es imagen no se toca ni se cuenta.
    assert.strictEqual((await fsp.stat(docx)).size, 5000);
    assert.strictEqual(await fsp.readFile(otros, 'utf8'), 'hola');
  });

  test('los nombres de archivo del árbol son exactamente los mismos después de comprimir', async () => {
    const dir = path.join(tmp, 'caso-nombres');
    const foto = await fotoRealista(1800, 1200).jpeg({ quality: 95 }).toBuffer();
    await escribir('caso-nombres/x/1785011940900-1vy1fo44psr.jpg', foto);
    await escribir('caso-nombres/x/otra.jpeg', foto);
    await escribir('caso-nombres/x/captura.png', await fotoRealista(1800, 1200).png().toBuffer());

    const listar = (d) => fs.readdirSync(d).sort();
    const antes = listar(path.join(dir, 'x'));

    await comprimirArbol(dir, { imagenes: true });

    assert.deepStrictEqual(listar(path.join(dir, 'x')), antes,
      'si esto falla, un backup restaurado deja las imágenes del sitio en 404');
  });
});

describe('analizarCarpetas', () => {

  test('agrupa por tipo, totaliza y ordena los más pesados', async () => {
    const dir = path.join(tmp, 'caso-analisis');
    await escribir('caso-analisis/esc/actividades/chica.jpg', Buffer.alloc(1000, 1));
    await escribir('caso-analisis/esc/actividades/grande.jpg', Buffer.alloc(9000, 1));
    await escribir('caso-analisis/esc/avatars/a.webp', Buffer.alloc(500, 1));
    await escribir('caso-analisis/esc/doc.pdf', Buffer.alloc(4000, 1));

    invalidarCache();
    const r = await analizarCarpetas([{ dir, label: 'Prueba' }]);

    assert.strictEqual(r.porTipo.imagenes.count, 2);
    assert.strictEqual(r.porTipo.imagenes.bytes, 10000);
    assert.strictEqual(r.porTipo.pdf.count, 1);
    assert.strictEqual(r.porTipo.webp.count, 1);
    assert.strictEqual(r.total.count, 4);
    assert.strictEqual(r.total.bytes, 14500);

    assert.strictEqual(r.topPesados[0].bytes, 9000, 'el más pesado va primero');
    assert.ok(r.topPesados[0].bytes >= r.topPesados[1].bytes);
  });

  test('solo estima ahorro sobre lo comprimible', async () => {
    const dir = path.join(tmp, 'caso-ahorro');
    await escribir('caso-ahorro/a.jpg',  Buffer.alloc(10000, 1));
    await escribir('caso-ahorro/b.webp', Buffer.alloc(10000, 1));
    await escribir('caso-ahorro/c.docx', Buffer.alloc(10000, 1));

    invalidarCache();
    const r = await analizarCarpetas([{ dir, label: 'Prueba' }]);

    assert.ok(r.porTipo.imagenes.ahorroEstimado > 0);
    assert.strictEqual(r.porTipo.webp.ahorroEstimado, 0);
    assert.strictEqual(r.porTipo.documentos.ahorroEstimado, 0);
    assert.ok(r.porTipo.imagenes.ahorroEstimado < r.porTipo.imagenes.bytes,
      'el ahorro nunca puede ser el 100%');
  });

  test('una carpeta vacía o inexistente devuelve ceros, no explota', async () => {
    invalidarCache();
    const r = await analizarCarpetas([{ dir: path.join(tmp, 'no-existe'), label: 'Nada' }]);

    assert.strictEqual(r.total.count, 0);
    assert.strictEqual(r.total.bytes, 0);
    assert.deepStrictEqual(r.topPesados, []);
    // La vista divide por el mayor para dibujar las barras: un 0 acá sería un NaN en pantalla.
    for (const t of Object.values(r.porTipo)) assert.strictEqual(t.ahorroEstimado, 0);
  });

  test('el cache evita recorrer de nuevo dentro de la ventana', async () => {
    const dir = path.join(tmp, 'caso-cache');
    await escribir('caso-cache/a.jpg', Buffer.alloc(1000, 1));

    invalidarCache();
    const primera = await analizarCarpetas([{ dir, label: 'Prueba' }]);
    assert.strictEqual(primera.total.count, 1);

    // Un archivo nuevo NO se ve hasta que vence el TTL: es el trato del cache y lo que
    // hace que la card del monitor (que refresca cada 5s) no salga a recorrer el disco.
    await escribir('caso-cache/b.jpg', Buffer.alloc(1000, 1));
    const segunda = await analizarCarpetas([{ dir, label: 'Prueba' }]);
    assert.strictEqual(segunda.total.count, 1, 'debería venir del cache');

    invalidarCache();
    const tercera = await analizarCarpetas([{ dir, label: 'Prueba' }]);
    assert.strictEqual(tercera.total.count, 2);
  });
});
