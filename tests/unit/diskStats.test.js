// Tests del cache de almacenamiento del monitor (services/diskStats.js).
// Correr con: npm run test:unit
//
// Qué se protege acá. El escaneo del árbol de archivos son 4.436 ms medidos en producción el
// 2026-09-06 (13.784 archivos, 17,5 GB, y las entregas crecen toda la clase). El monitor pide
// cada 5 segundos, así que cuando ese escaneo corría DENTRO del request, una de cada doce
// respuestas lo pagaba entera: /monitor/stats promediaba 1.099 ms con picos de 17,5 s.
//
// El arreglo es que el vencimiento no bloquee: se sirve el dato viejo y el escaneo corre por
// detrás. Es un arreglo fácil de deshacer sin querer —basta un `await` de más en el refresco—
// y el síntoma no aparece en desarrollo, donde las carpetas están casi vacías y el escaneo
// tarda milisegundos. De ahí estos tests: miden que el request NO esperó.
//
// La demora del escaneo se controla desde el `mongoose` falso, porque tamanoBaseDatos() es
// parte del escaneo y es lo único inyectable. Nada de esto toca el disco de verdad.

const test = require('node:test');
const assert = require('node:assert');
const { mock } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getDiskStats, invalidarCache, refrescoPendiente, rutasDePrueba, TTL_MS,
} = require('../../services/diskStats');

// Dos archivos en una carpeta temporal, en vez de las carpetas de verdad. Escanear
// archivos/entregas y public/archivos hacía que esta suite tardara 20 segundos y que el
// resultado dependiera de cuántos archivos tenga la máquina de quien la corre.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskstats-test-'));
fs.writeFileSync(path.join(tmp, 'uno.txt'), 'x'.repeat(100));
fs.writeFileSync(path.join(tmp, 'dos.txt'), 'x'.repeat(50));
rutasDePrueba([{ id: 'prueba', label: 'Carpeta de prueba', dir: tmp }]);

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// Un mongoose de mentira cuyo db.stats() tarda lo que se le pida y cuenta sus llamadas.
// Cada llamada = un escaneo completo, que es justo lo que queremos contar.
function mongooseFalso({ demoraMs = 0, storage = 1000 } = {}) {
  const falso = {
    escaneos: 0,
    connection: {
      db: {
        stats: async () => {
          falso.escaneos++;
          if (demoraMs) await new Promise(r => setTimeout(r, demoraMs));
          return { dataSize: 10, storageSize: storage, indexSize: 1, objects: 5 };
        },
      },
    },
  };
  return falso;
}

const ms = (desde) => Number(process.hrtime.bigint() - desde) / 1e6;
const ahora = () => process.hrtime.bigint();

// Deja el cache lleno y devuelve el mongoose usado, para que cada test arranque parejo.
async function conCacheCaliente(opciones) {
  invalidarCache();
  const mg = mongooseFalso(opciones);
  await getDiskStats(mg);
  return mg;
}

test('diskStats: el refresco no bloquea', async (t) => {
  t.afterEach(() => { mock.timers.reset(); invalidarCache(); });

  await t.test('el PRIMER request sí espera: no hay nada viejo que servir', async () => {
    invalidarCache();
    const mg = mongooseFalso({ demoraMs: 300 });

    const t0 = ahora();
    const r = await getDiskStats(mg);
    const tardo = ms(t0);

    assert.ok(tardo >= 250, `el primero tiene que esperar el escaneo, tardó ${Math.round(tardo)}ms`);
    assert.strictEqual(mg.escaneos, 1);
    assert.ok(Array.isArray(r.carpetas), 'devuelve el desglose');
    assert.strictEqual(typeof r.calculadoHace, 'number');
  });

  await t.test('⭐ con el cache vencido NO espera: contesta al instante y refresca por detrás', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(1_000_000);

    invalidarCache();
    const mg = mongooseFalso({ demoraMs: 300 });
    await getDiskStats(mg);              // llena el cache (este sí espera)
    assert.strictEqual(mg.escaneos, 1);

    mock.timers.setTime(1_000_000 + TTL_MS + 1);   // se vence

    const t0 = ahora();
    const r = await getDiskStats(mg);
    const tardo = ms(t0);

    assert.ok(tardo < 100,
      `el request NO tiene que esperar los 300ms del escaneo, tardó ${Math.round(tardo)}ms.\n` +
      'Si esto falla, alguien puso un await en el refresco de services/diskStats.js.');
    assert.ok(refrescoPendiente(), 'y sin embargo el escaneo tiene que estar corriendo');
    assert.ok(r.carpetas, 'contestó con el desglose viejo, no con nada');

    await refrescoPendiente();
    assert.strictEqual(mg.escaneos, 2, 'el refresco de atrás sí completó');
  });

  await t.test('lo que se sirve mientras refresca es el dato VIEJO, y después el nuevo', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(2_000_000);

    invalidarCache();
    const mg = mongooseFalso({ demoraMs: 50, storage: 111 });
    const primero = await getDiskStats(mg);
    assert.strictEqual(primero.db.storage, 111);

    // El escaneo siguiente va a traer otro número
    mg.connection.db.stats = async () => {
      mg.escaneos++;
      await new Promise(r => setTimeout(r, 50));
      return { dataSize: 10, storageSize: 999, indexSize: 1, objects: 5 };
    };
    mock.timers.setTime(2_000_000 + TTL_MS + 1);

    const durante = await getDiskStats(mg);
    assert.strictEqual(durante.db.storage, 111, 'mientras refresca sigue mostrando lo viejo');

    await refrescoPendiente();
    const despues = await getDiskStats(mg);
    assert.strictEqual(despues.db.storage, 999, 'y una vez listo, lo nuevo');
  });

  await t.test('⭐ dos requests a la vez disparan UN solo escaneo', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(3_000_000);

    invalidarCache();
    const mg = mongooseFalso({ demoraMs: 200 });
    await getDiskStats(mg);
    mock.timers.setTime(3_000_000 + TTL_MS + 1);

    // El panel pide cada 5 s y el escaneo tarda 4: sin la guarda, se solapan solos.
    await Promise.all([getDiskStats(mg), getDiskStats(mg), getDiskStats(mg)]);
    await refrescoPendiente();

    assert.strictEqual(mg.escaneos, 2, 'uno el del cache inicial, UNO solo el del refresco');
  });

  await t.test('con el cache fresco no se escanea nada', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(4_000_000);

    const mg = await conCacheCaliente({ demoraMs: 0 });
    assert.strictEqual(mg.escaneos, 1);

    mock.timers.setTime(4_000_000 + TTL_MS - 1000);   // todavía no vence
    await getDiskStats(mg);
    await getDiskStats(mg);

    assert.strictEqual(mg.escaneos, 1, 'ni uno más');
    assert.strictEqual(refrescoPendiente(), null, 'y no quedó ningún refresco colgado');
  });

  await t.test('calculadoHace dice la antigüedad de verdad, en segundos', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(5_000_000);

    const mg = await conCacheCaliente({ demoraMs: 0 });
    mock.timers.setTime(5_000_000 + 90_000);          // pasaron 90 s

    const r = await getDiskStats(mg);
    assert.strictEqual(r.calculadoHace, 90,
      'la vista lo muestra al lado del número: si miente, el dato viejo pasa por nuevo');
  });
});

test('el desglose sigue midiendo bien: bytes, archivos y el total con la base', async () => {
  // Que el refresco pase a segundo plano no puede cambiar lo que el monitor muestra.
  invalidarCache();
  const mg = mongooseFalso({ storage: 4_000 });
  const r = await getDiskStats(mg);

  assert.strictEqual(r.carpetas.length, 1);
  assert.strictEqual(r.carpetas[0].bytes, 150, 'los dos archivos del fixture: 100 + 50');
  assert.strictEqual(r.carpetas[0].archivos, 2);
  assert.strictEqual(r.appTotal, 150 + 4_000, 'archivos + storage de Mongo');
  assert.ok(r.volumen, 'el espacio del volumen se calcula siempre, fuera del cache');
});

test('⭐ el TTL se mide en minutos, no en segundos', () => {
  // No es un número mágico: con el escaneo fuera del request, el TTL ya no gobierna la latencia
  // sino cuánto I/O se le tira al MISMO disco que sirve las entregas de los alumnos. 60 s eran
  // 60 escaneos por hora y por worker; 5 min son 12. Si alguien lo vuelve a bajar al minuto,
  // que sea a propósito.
  assert.ok(TTL_MS >= 5 * 60 * 1000,
    `el TTL bajó a ${TTL_MS}ms y eso multiplica el I/O sobre archivos/entregas`);
});
