// services/conversionCad.js — DWG → DXF vía ODA File Converter (§ I de la spec).
// Correr con: npm run test:unit
//
// "Corre sin depender de que el binario esté instalado: lo que se testea es la elección de
// ruta, los argumentos y la limpieza, no la conversión" (spec, Tests necesarios). Ni siquiera
// se intenta ejecutar ODA de verdad: todo entra por dependencias inyectadas.
//
// ── El contrato que este archivo asume ──────────────────────────────────────────
//
//   RUTA_LINUX = '/usr/bin/ODAFileConverter'          [RN-42c]
//
//   buscarEnWindows({ localAppData, listarCarpetas, existeArchivo }) -> string|null   [RN-42c]
//     Busca bajo `${localAppData}/Programs/ODA/`, primer subdirectorio cuyo NOMBRE matchee
//     /^ODAFileConverter /  (con espacio, para no confundir con otra cosa), y devuelve
//     `${esa carpeta}/ODAFileConverter.exe` si existeArchivo() lo confirma. Nunca compara
//     contra la ruta CON la versión adentro escrita a mano. `listarCarpetas` y `existeArchivo`
//     son inyectables para no tocar el filesystem real en el test (CA-54b).
//
//   detectarOda({ env, platform, localAppData, listarCarpetas, existeArchivo } = {})
//       -> Promise<string|null>                        [RN-42c]
//     `env.ODA_FILE_CONVERTER_BIN` le gana a todo. Si no está: RUTA_LINUX en 'linux', o
//     buscarEnWindows(...) en 'win32'.
//
//   armarComandoOda({ platform, binario, argumentos }) -> { cmd, args }   [RN-42e]
//     En 'linux': { cmd: 'xvfb-run', args: ['-a', binario, ...argumentos] } — SIEMPRE, nunca
//     el binario directo, porque sin la pantalla virtual tira `libGL.so.1` (RN-42e).
//     En cualquier otra plataforma: { cmd: binario, args: argumentos }.
//
//   nuevaCarpetaDeTrabajo() -> { dir, dirIn, dirOut }     [RN-42b]
//     Una carpeta nueva por trabajo, bajo os.tmpdir(), nunca dentro de archivos/entregas.
//
//   convertirDwgADxf(rutaDwgOriginal, opts) -> Promise<{ dxfPath }>       [RN-42a/RN-42b]
//     opts.ejecutar(cmd, args, cb)   inyectable, default = child_process.execFile
//     opts.nuevaCarpetaDeTrabajo()   inyectable, default = la real de arriba
//     Copia el .dwg a `${dir}/in/`, crea `${dir}/out/`, arma el comando con recursivo=0 y
//     filtro '*.DWG', y borra TODA la carpeta de trabajo en un `finally` — también si
//     `ejecutar` falla o tira timeout.

const test   = require('node:test');
const assert = require('node:assert');
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');

let ConversionCad = null;
try {
  ConversionCad = require('../../services/conversionCad.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const FUNCIONES = ['buscarEnWindows', 'detectarOda', 'armarComandoOda', 'convertirDwgADxf'];
const faltan = !ConversionCad ? FUNCIONES : FUNCIONES.filter(f => typeof ConversionCad[f] !== 'function');

if (faltan.length) {
  test(`falta implementar services/conversionCad.js (${!ConversionCad ? 'el archivo no existe' : 'faltan: ' + faltan.join(', ')})`, () => {
    throw new Error(
      'services/conversionCad.js tiene que existir y exportar buscarEnWindows, detectarOda, ' +
      'armarComandoOda y convertirDwgADxf. Ver specs/correccion-de-entregas.spec.md § I ' +
      '(RN-42b, RN-42c, RN-42e) y el contrato escrito arriba de este archivo.',
    );
  });
} else {
  const { buscarEnWindows, detectarOda, armarComandoOda, convertirDwgADxf } = ConversionCad;

  // ── CA-54b — detección por PATRÓN, nunca por la ruta con la versión adentro ─

  test('CA-54b — Windows: encuentra ODAFileConverter 27.1.0 por patrón, no por nombre exacto', () => {
    const arbol = { 'ODAFileConverter 27.1.0': true, 'OtraCosa': true };
    const encontrada = buscarEnWindows({
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      listarCarpetas: () => Object.keys(arbol),
      existeArchivo: () => true,
    });
    assert.ok(encontrada, 'tiene que encontrar algo');
    assert.match(encontrada, /ODAFileConverter 27\.1\.0/);
    assert.match(encontrada, /ODAFileConverter\.exe$/i);
  });

  test('CA-54b — Windows: una versión FUTURA (99.0.0) se encuentra igual, sin tocar el código', () => {
    const encontrada = buscarEnWindows({
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      listarCarpetas: () => ['ODAFileConverter 99.0.0'],
      existeArchivo: () => true,
    });
    assert.ok(encontrada, 'renombrar la carpeta de 27.1.0 a 99.0.0 tiene que seguir encontrándose');
    assert.match(encontrada, /99\.0\.0/);
  });

  test('CA-54b — Windows: sin ninguna carpeta que matchee, no encuentra nada (no explota)', () => {
    const encontrada = buscarEnWindows({
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      listarCarpetas: () => ['OtraCosaCualquiera'],
      existeArchivo: () => true,
    });
    assert.strictEqual(encontrada, null);
  });

  test('CA-54b — Linux: la ruta estable, nunca el directorio versionado que convive al lado', async () => {
    const bin = await detectarOda({
      env: {}, platform: 'linux',
      existeArchivo: (ruta) => ruta === '/usr/bin/ODAFileConverter', // el versionado NO existe acá
    });
    assert.strictEqual(bin, '/usr/bin/ODAFileConverter');
  });

  test('CA-54b — Linux: si solo existe el directorio CON la versión adentro, no lo usa (da null)', async () => {
    const bin = await detectarOda({
      env: {}, platform: 'linux',
      existeArchivo: (ruta) => ruta === '/usr/bin/ODAFileConverter_27.1.0.0/ODAFileConverter',
    });
    assert.strictEqual(bin, null,
      'hardcodear /usr/bin/ODAFileConverter_27.1.0.0/ es justo lo que RN-42c prohíbe: se rompe ' +
      'en silencio con la próxima versión');
  });

  test('CA-54b — ODA_FILE_CONVERTER_BIN le gana a todo, en las dos plataformas', async () => {
    for (const platform of ['linux', 'win32']) {
      const bin = await detectarOda({
        env: { ODA_FILE_CONVERTER_BIN: '/ruta/custom/oda' },
        platform,
        existeArchivo: () => false, // ninguna de las rutas "normales" existe
        listarCarpetas: () => [],
      });
      assert.strictEqual(bin, '/ruta/custom/oda', `en ${platform} la env var tiene que ganar`);
    }
  });

  // ── CA-54c — xvfb-run SIEMPRE en Linux, nunca directo ───────────────────────

  test('CA-54c — en Linux, el comando SIEMPRE va envuelto en xvfb-run -a', () => {
    const { cmd, args } = armarComandoOda({
      platform: 'linux', binario: '/usr/bin/ODAFileConverter',
      argumentos: ['/tmp/in', '/tmp/out', 'ACAD2018', 'DXF', '0', '1', '*.DWG'],
    });
    assert.strictEqual(cmd, 'xvfb-run', 'sin xvfb-run, el error es libGL.so.1 y no se parece en nada al problema real');
    assert.strictEqual(args[0], '-a');
    assert.strictEqual(args[1], '/usr/bin/ODAFileConverter');
    assert.deepStrictEqual(args.slice(2), ['/tmp/in', '/tmp/out', 'ACAD2018', 'DXF', '0', '1', '*.DWG']);
  });

  test('CA-54c — en Windows, el binario se invoca directo (no existe xvfb-run ahí)', () => {
    const { cmd, args } = armarComandoOda({
      platform: 'win32', binario: 'C:\\ODA\\ODAFileConverter.exe',
      argumentos: ['C:\\in', 'C:\\out', 'ACAD2018', 'DXF', '0', '1', '*.DWG'],
    });
    assert.strictEqual(cmd, 'C:\\ODA\\ODAFileConverter.exe');
    assert.deepStrictEqual(args, ['C:\\in', 'C:\\out', 'ACAD2018', 'DXF', '0', '1', '*.DWG']);
  });

  test('RN-42b — el flag recursivo va SIEMPRE en 0', () => {
    const { args } = armarComandoOda({
      platform: 'linux', binario: '/usr/bin/ODAFileConverter',
      argumentos: ['/tmp/in', '/tmp/out', 'ACAD2018', 'DXF', '0', '1', '*.DWG'],
    });
    // posición: carpeta origen, destino, versión, formato, recursivo, auditar, filtro
    assert.strictEqual(args[6], '0', 'el flag recursivo (5to argumento real de ODA) tiene que ser 0');
  });

  // ── CA-57 / CA-58 — la carpeta de trabajo ───────────────────────────────────

  function dwgFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversionCad-fixture-'));
    const dwg = path.join(dir, 'plano.dwg');
    fs.writeFileSync(dwg, 'DWG falso, no hace falta que sea válido para este test');
    return { dir, dwg };
  }

  test('CA-57 — la entrada NUNCA es un directorio de archivos/entregas: siempre bajo os.tmpdir()', async () => {
    const { dwg } = dwgFixture();
    const carpetasUsadas = [];
    const ejecutarFalso = (cmd, args, cb) => { carpetasUsadas.push(args); cb(null, '', ''); };

    // No importa si termina en éxito o en error por no haber depositado un .dxf de verdad en
    // out/: lo único que este test necesita es CON QUÉ CARPETA se invocó el conversor.
    await convertirDwgADxf(dwg, { ejecutar: ejecutarFalso }).catch(() => {});

    assert.ok(carpetasUsadas.length >= 1, 'tiene que haber invocado el conversor al menos una vez');
    const [dirIn] = carpetasUsadas[0];
    assert.ok(dirIn.startsWith(os.tmpdir()) || dirIn.toLowerCase().includes('classroom-cad'),
      `la carpeta de entrada tiene que vivir bajo os.tmpdir(), dio: ${dirIn}`);
    assert.ok(!/archivos[\\/]entregas/i.test(dirIn),
      'RN-42b: nunca se apunta el CLI de ODA a un directorio de archivos/entregas');
  });

  test('CA-57 — la carpeta de trabajo se borra en el finally, incluso si la conversión falla', async () => {
    const { dwg } = dwgFixture();
    let carpetaCreada = null;
    const ejecutarQueFalla = (cmd, args, cb) => {
      carpetaCreada = args[0]; // primer argumento: carpeta de entrada
      cb(new Error('ODA murió (simulado)'));
    };

    await assert.rejects(() => convertirDwgADxf(dwg, { ejecutar: ejecutarQueFalla }));

    assert.ok(carpetaCreada, 'el fixture no capturó ninguna carpeta: revisar el mock');
    const raizTrabajo = path.dirname(carpetaCreada); // .../classroom-cad-<uuid>/in -> .../classroom-cad-<uuid>
    assert.strictEqual(fs.existsSync(raizTrabajo), false,
      'la carpeta de trabajo tiene que desaparecer del disco aunque ODA haya fallado (finally)');
  });

  test('CA-58 — dos conversiones simultáneas usan carpetas DISTINTAS', async () => {
    const { dwg: dwgA } = dwgFixture();
    const { dwg: dwgB } = dwgFixture();
    const carpetas = [];
    const ejecutar = (cmd, args, cb) => {
      carpetas.push(args[0]);
      fs.writeFileSync(path.join(args[1], path.basename(args[0].replace(/[\\/]in$/, '')) + '.dxf'), 'dxf');
      cb(null, '', '');
    };

    await Promise.allSettled([
      convertirDwgADxf(dwgA, { ejecutar }),
      convertirDwgADxf(dwgB, { ejecutar }),
    ]);

    assert.strictEqual(carpetas.length, 2, 'las dos conversiones tienen que haber llamado al conversor');
    assert.notStrictEqual(carpetas[0], carpetas[1],
      'RN-42b: con PM2 en 2 workers, dos conversiones a la vez son el caso normal — una carpeta ' +
      'compartida haría que la segunda le pise el `out/` a la primera');
  });
}
