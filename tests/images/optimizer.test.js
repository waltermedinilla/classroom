// Tests del optimizador de imágenes (services/imageOptimizer.js).
//
// Runner: `node --test` (nativo desde Node 18, acá corre Node 24) — sin dependencias nuevas.
//   npm run test:images
//
// A diferencia del smoke test, esto NO necesita servidor ni base de datos: son funciones
// puras sobre buffers. Corre en menos de un segundo.
//
// Las imágenes de prueba se GENERAN con sharp en cada corrida en vez de commitear binarios:
// el repo no engorda, y los casos quedan explícitos y leíbles acá mismo.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const sharp  = require('sharp');

const { optimizar, ImagenInvalidaError } = require('../../services/imageOptimizer');
const { PRESETS, EXT_IMAGENES, MAX_INPUT_BYTES } = require('../../config/imagePresets');

// Genera algo que se comporte como una FOTO real frente al compresor.
//
// Ojo con el atajo obvio: ni un color plano ni ruido puro sirven. El color plano se
// comprime a casi nada (los tests de ahorro pasarían por accidente) y el ruido puro es
// incompresible, así que el WebP sale MÁS grande que el JPEG de entrada y el optimizador
// devuelve el original — varios tests fallaban por eso, midiendo una rama que no era la
// que decían medir. Ruido de baja frecuencia (chico, escalado con interpolación) da
// gradientes suaves con detalle: se comporta como una foto.
function fotoRealista(width, height) {
  const s = 32;
  const semilla = Buffer.alloc(s * s * 3);
  for (let i = 0; i < semilla.length; i++) semilla[i] = Math.floor(Math.random() * 256);
  return sharp(semilla, { raw: { width: s, height: s, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' });
}

// GIF89a de 1×1 con 2 frames, armado a mano. sharp no sabe ESCRIBIR GIFs animados desde
// una imagen creada al vuelo (necesita que la entrada ya traiga page-height), así que la
// única forma de tener un animado determinístico es escribir los bytes. Verificado: sharp
// lo lee con metadata().pages === 2, que es exactamente el flag que mira el optimizador.
const GIF_ANIMADO = Buffer.from(
  'R0lGODlhAQABAJAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQCACH5' +
  'BAAKAAAALAAAAAABAAEAAAICRAIAOw==',
  'base64',
);

describe('imageOptimizer', () => {

  test('reduce una foto grande al techo del preset y baja drásticamente el peso', async () => {
    // 2400×1800 y no 4000×3000: los tests corren en paralelo y libvips se quedaba sin
    // memoria armando el fixture. Alcanza de sobra — sigue siendo ~20× el preset.
    const original = await fotoRealista(2400, 1800).jpeg({ quality: 95 }).toBuffer();
    const r = await optimizar(original, 'avatar', 'foto.jpg');

    assert.ok(r.optimizada, 'debería marcarse como optimizada');
    assert.strictEqual(r.ext, '.webp');
    assert.strictEqual(r.width,  PRESETS.avatar.width);
    assert.strictEqual(r.height, PRESETS.avatar.height);
    assert.ok(r.bytes < original.length / 5,
      `esperaba al menos 80% de ahorro, pasó de ${original.length} a ${r.bytes}`);
  });

  test('el preset avatar recorta cuadrado (fit cover) aunque la entrada sea apaisada', async () => {
    const original = await fotoRealista(2000, 1200).jpeg().toBuffer();
    const r = await optimizar(original, 'avatar', 'panoramica.jpg');

    assert.strictEqual(r.width, r.height, 'el avatar debe salir cuadrado');
    assert.strictEqual(r.width, 512);
  });

  test('el avatar sale cuadrado incluso si el lado corto no llega al tamaño del preset', async () => {
    // Regresión: `fit:'cover'` + `withoutEnlargement:true` daba 512×400 con esta entrada.
    // El avatar salía RECTANGULAR y el CSS circular lo deformaba. Ahora el lado se calcula
    // como min(preset, ancho, alto): cuadrado siempre, sin estirar nunca.
    const original = await fotoRealista(1600, 400).jpeg().toBuffer();
    const r = await optimizar(original, 'avatar', 'muy-apaisada.jpg');

    assert.strictEqual(r.width, r.height, 'el avatar debe salir cuadrado');
    assert.strictEqual(r.width, 400, 'el lado debe ser el del lado corto de la entrada, sin agrandar');
  });

  test('el preset novedad respeta el aspect ratio (fit inside, sin recorte)', async () => {
    const original = await fotoRealista(3200, 800).jpeg().toBuffer();
    const r = await optimizar(original, 'novedad', 'pizarron.jpg');

    assert.strictEqual(r.width, 1600, 'debe entrar justo en el ancho máximo');
    assert.strictEqual(r.height, 400, 'el alto debe escalar proporcional (3200x800 → 1600x400)');
  });

  test('no agranda una imagen más chica que el preset', async () => {
    const original = await fotoRealista(100, 100).png().toBuffer();
    const r = await optimizar(original, 'avatar', 'chiquita.png');

    assert.strictEqual(r.width, 100, 'no debe estirar a 512');
    assert.strictEqual(r.height, 100);
  });

  test('aplica la orientación del EXIF antes de redimensionar', async () => {
    // Orientation 6 = "rotar 90° a la derecha al mostrar". Es lo que manda un celular
    // sacando una foto vertical: los píxeles vienen apaisados y el visor la endereza.
    // Al reencodear se pierde el EXIF, así que la rotación tiene que quedar aplicada
    // en los píxeles — si no, todas las fotos verticales quedarían acostadas.
    const original = await fotoRealista(1200, 600)
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const r = await optimizar(original, 'novedad', 'vertical.jpg');
    assert.ok(r.height > r.width,
      `la foto debía quedar vertical tras aplicar el EXIF, salió ${r.width}x${r.height}`);
  });

  test('elimina la metadata (incluido el GPS de las fotos de celular)', async () => {
    const original = await fotoRealista(800, 600)
      .withMetadata({ exif: { IFD0: { Copyright: 'Escuela 4118', Software: 'Camara' } } })
      .jpeg()
      .toBuffer();

    const r    = await optimizar(original, 'novedad', 'con-exif.jpg');
    const meta = await sharp(r.buffer).metadata();

    assert.ok(!meta.exif, 'el resultado no debería conservar el bloque EXIF');
  });

  test('conserva la transparencia de un PNG al pasarlo a WebP', async () => {
    const original = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 120, b: 255, alpha: 0.4 } },
    }).png().toBuffer();

    const r    = await optimizar(original, 'header', 'logo.png');
    const meta = await sharp(r.buffer).metadata();

    assert.strictEqual(meta.format, 'webp');
    assert.ok(meta.hasAlpha, 'el canal alpha debería sobrevivir a la conversión');
  });

  test('deja intacto un GIF animado', async () => {
    // Guarda del fixture: si una versión futura de sharp dejara de ver los 2 frames, el
    // test pasaría por el motivo equivocado. Mejor que reviente acá con un mensaje claro.
    const meta = await sharp(GIF_ANIMADO).metadata();
    assert.strictEqual(meta.pages, 2, 'el fixture debe ser un GIF de 2 frames');

    const r = await optimizar(GIF_ANIMADO, 'novedad', 'animado.gif');

    assert.strictEqual(r.optimizada, false);
    assert.strictEqual(r.motivo, 'gif-animado');
    assert.strictEqual(r.ext, '.gif', 'debe conservar la extensión original');
    assert.ok(GIF_ANIMADO.equals(r.buffer), 'el buffer debe ser byte-idéntico al original');
  });

  test('conserva el original si el resultado pesaría más', async () => {
    // Caso real: alguien sube una imagen que YA venía optimizada (un WebP de calidad baja).
    // Reencodearla a q78 la engordaría — el optimizador tiene que darse cuenta y no tocarla.
    const original = await fotoRealista(400, 400).webp({ quality: 20 }).toBuffer();

    const r = await optimizar(original, 'avatar', 'ya-comprimida.webp');

    assert.strictEqual(r.optimizada, false);
    assert.strictEqual(r.motivo, 'ya-optimizada');
    assert.strictEqual(r.bytes, original.length);
    assert.strictEqual(r.ext, '.webp', 'debe conservar la extensión original');
  });

  test('rechaza un archivo que no es una imagen aunque diga .jpg', async () => {
    // El caso real: el fileFilter de multer mira solo la extensión y el Content-Type que
    // declara el navegador, ambos falsificables. Decodificar es la validación de verdad.
    const basura = Buffer.from('#!/bin/sh\nrm -rf /\n');

    await assert.rejects(
      () => optimizar(basura, 'avatar', 'payload.jpg'),
      (err) => {
        assert.ok(err instanceof ImagenInvalidaError, 'debe ser ImagenInvalidaError');
        assert.strictEqual(err.status, 400, 'debe mapear a 400, no a 500');
        return true;
      },
    );
  });

  test('rechaza una imagen truncada', async () => {
    const completa = await fotoRealista(1000, 1000).jpeg().toBuffer();
    // Cabecera JPEG válida, cuerpo cortado: pasa el metadata() y revienta al decodificar.
    const truncada = completa.subarray(0, 500);

    await assert.rejects(() => optimizar(truncada, 'avatar', 'cortada.jpg'),
      (err) => err instanceof ImagenInvalidaError);
  });

  test('en modo tolerante recupera una imagen truncada en vez de rechazarla', async () => {
    // Lo usa SOLO el backfill (optimize-existing-images.js): esos archivos ya están
    // publicados y el navegador los muestra parciales, así que convertir lo decodificable
    // conserva lo que el usuario ya ve y libera el espacio. Caso real en el mirror local:
    // un avatar de 1,62 MB sin marcador de fin JPEG → 0,03 MB.
    const completa = await fotoRealista(1000, 1000).jpeg().toBuffer();
    const truncada = completa.subarray(0, Math.floor(completa.length * 0.6));

    await assert.rejects(() => optimizar(truncada, 'avatar', 'cortada.jpg'),
      (err) => err instanceof ImagenInvalidaError,
      'el modo estricto (subidas) debe seguir rechazándola');

    const r = await optimizar(truncada, 'avatar', 'cortada.jpg', { tolerante: true });
    assert.ok(r.optimizada, 'el modo tolerante debe poder convertirla');
    assert.strictEqual(r.ext, '.webp');
  });

  test('el modo tolerante NO convierte en imagen a un archivo que no lo es', async () => {
    // La tolerancia afloja la decodificación, no la validación de formato: un archivo
    // arbitrario tiene que seguir siendo rechazado por las dos vías.
    const basura = Buffer.from('esto no es una imagen, por más .png que le pongas');

    await assert.rejects(() => optimizar(basura, 'avatar', 'falso.png', { tolerante: true }),
      (err) => err instanceof ImagenInvalidaError);
  });

  test('acepta las fotos de iPhone (.heic/.heif) y da 20 MB de margen de entrada', () => {
    // Caso real del 2026-08-11: una docente subió a la sala una foto sacada con el iPhone
    // y la rebotamos por extensión. El iPhone graba .heic por defecto desde iOS 11, así
    // que "sacar la foto y subirla" era un camino roto para media escuela.
    for (const ext of ['.heic', '.heif']) {
      assert.ok(EXT_IMAGENES.includes(ext), `${ext} tiene que estar aceptada`);
    }
    // El límite viejo (8 MB) rebotaba fotos de celulares actuales, y era MENOR que el de
    // los .zip de la sala (20 MB) — siendo que la foto se recomprime a ~100 KB.
    assert.strictEqual(MAX_INPUT_BYTES, 20 * 1024 * 1024);
  });

  test('un .heic ilegible explica qué hacer, en vez del genérico "no es una imagen válida"', async () => {
    // El riesgo que cubre: si el libvips del servidor viniera sin el códec HEVC, la foto
    // sería válida y aun así fallaría. El mensaje tiene que dar la salida (reenviar como
    // JPG) en lugar de acusar al archivo, que es lo que haría el camino genérico.
    const noEsHeic = Buffer.from('esto no es un HEIC, por más .heic que le pongas');

    await assert.rejects(
      () => optimizar(noEsHeic, 'sala', 'IMG_4821.heic'),
      (err) => {
        assert.ok(err instanceof ImagenInvalidaError, 'debe ser ImagenInvalidaError');
        assert.strictEqual(err.status, 400, 'es culpa del archivo, no del servidor: 400');
        assert.match(err.message, /JPG/, 'debe decirle al usuario cómo salir del paso');
        assert.doesNotMatch(err.message, /no es una imagen válida/,
          'el mensaje genérico no sirve acá: la foto SÍ es una imagen');
        return true;
      },
    );
  });

  test('falla ruidosamente ante un preset inexistente (error de programación, no del usuario)', async () => {
    const original = await fotoRealista(100, 100).png().toBuffer();
    await assert.rejects(() => optimizar(original, 'preset-que-no-existe', 'x.png'),
      /Preset de imagen desconocido/);
  });
});
