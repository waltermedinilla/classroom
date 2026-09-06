// Tests de los DOS techos de memoria de ecosystem.config.js y de que estén alineados.
//
// ── Por qué existe este test ──────────────────────────────────────────────────────────
// El 05/09/2026 se midió que los workers de producción se reciclaban cada 4 minutos en
// horario de clase: 272 reinicios en el VPS y 89 en el servidor viejo, todos con
// `[PM2][WORKER] ... exceeds --max-memory-restart`. No era una fuga: era `max_memory_restart`
// en 400 MB peleado con el techo de heap que Node se da solo (4144 MB, medido con
// `v8.getHeapStatistics()` en las dos máquinas). V8 no compacta hasta acercarse a SU límite,
// así que el worker llegaba a los 400 MB lleno de basura y PM2 lo mataba antes de que ningún
// GC tuviera motivo de correr.
//
// El arreglo es un PAR de números, y ahí está el riesgo que este archivo cubre: bajar el techo
// de PM2 sin bajar el del heap, o subir el del heap sin subir el de PM2, reintroduce el bug
// exacto — y no lo notaría nadie, porque la app arranca perfecto y falla recién bajo carga
// real, en horario de clase. No hay pantalla que se rompa ni test funcional que se ponga rojo:
// simplemente vuelven los reinicios.
//
// Por eso las aserciones son sobre la RELACIÓN entre los dos números, no sobre sus valores.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const config = require('../../ecosystem.config.js');

// El margen mínimo entre el heap de V8 y el techo de PM2, en MB.
//
// No es un número de la galera: el RSS que mide PM2 es el heap MÁS todo lo que vive fuera de
// él —libvips/sharp, los hasta 20 MB por request de las imágenes en memoryStorage
// (config/imagePresets.js), los buffers de mongoose— y eso NINGÚN GC lo baja. Con la app
// recién arrancada y sin una sola visita, el RSS medido en producción ya es de 165 MB por
// worker. 256 es ese piso con algo de aire.
const MARGEN_NATIVO_MB = 256;

// El techo que Node se da solo cuando nadie le dice nada, medido en el VPS y en el servidor
// viejo (los dos con >= 16 GB de RAM). Pedir un heap MÁS grande que esto no tendría ningún
// efecto: la bandera no bajaría nada y volveríamos al comportamiento que causó el bug.
const HEAP_POR_DEFECTO_MB = 4144;

// '400M' | '1280M' | '1G' | '1.5G' → MB
function aMB(valor) {
  const m = /^([\d.]+)\s*([KMG])B?$/i.exec(String(valor).trim());
  assert.ok(m, `no sé leer el tamaño "${valor}"`);
  const n = parseFloat(m[1]);
  return { k: n / 1024, m: n, g: n * 1024 }[m[2].toLowerCase()];
}

// Lee --max-old-space-size=N de node_args. null si la app no lo declara.
function heapDeclaradoMB(app) {
  const args = app.node_args || [];
  for (const a of args) {
    const m = /^--max-old-space-size=(\d+)$/.exec(String(a).trim());
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

const classroom = config.apps.find(a => a.name === 'classroom');
const media     = config.apps.find(a => a.name === 'classroom-media');

describe('aMB — el lector de tamaños del propio test', () => {
  test('entiende los formatos que acepta PM2', () => {
    assert.strictEqual(aMB('400M'),  400);
    assert.strictEqual(aMB('1280M'), 1280);
    assert.strictEqual(aMB('1G'),    1024);
    assert.strictEqual(aMB('1.5G'),  1536);
  });
});

describe('classroom — los dos techos alineados', () => {
  test('la app existe y sigue en modo cluster', () => {
    assert.ok(classroom, 'no está la app "classroom" en ecosystem.config.js');
    assert.strictEqual(classroom.exec_mode, 'cluster');
    assert.ok(classroom.instances >= 2,
      'con un solo worker, cada reciclado por memoria es un corte de servicio');
  });

  test('declara un techo de heap para V8 (sin esto, V8 se cree dueño de 4 GB)', () => {
    const heap = heapDeclaradoMB(classroom);
    assert.ok(heap !== null,
      'falta --max-old-space-size en node_args: es la mitad del arreglo, no un extra');
  });

  test('el heap de V8 queda POR DEBAJO del techo de PM2, con margen para lo nativo', () => {
    const heap = heapDeclaradoMB(classroom);
    // Sin este guard, un node_args ausente daría heap = null, `techo - null` = techo, y la
    // aserción de abajo pasaría SOLA justo en el caso que este archivo existe para atrapar.
    assert.ok(heap !== null, 'sin --max-old-space-size no hay nada que alinear');

    const techo  = aMB(classroom.max_memory_restart);
    const margen = techo - heap;

    assert.ok(margen >= MARGEN_NATIVO_MB,
      `el margen entre el heap (${heap} MB) y el techo de PM2 (${techo} MB) es de ${margen} MB, ` +
      `y hacen falta al menos ${MARGEN_NATIVO_MB} MB para lo que vive fuera del heap. ` +
      'Con menos, PM2 vuelve a matar workers sanos antes de que V8 tenga motivo de compactar.');
  });

  test('el heap pedido es menor que el que Node daría solo (si no, la bandera no hace nada)', () => {
    const heap = heapDeclaradoMB(classroom);
    assert.ok(heap !== null, 'sin --max-old-space-size, Node usa el techo por defecto');
    assert.ok(heap < HEAP_POR_DEFECTO_MB,
      `pedir ${heap} MB de heap no baja nada: Node ya da ${HEAP_POR_DEFECTO_MB} MB por defecto ` +
      'en estas máquinas, así que V8 seguiría sin compactar antes del techo de PM2');
  });
});

// ⚠️ La app `classroom-media` PUEDE NO EXISTIR todavía: la transmisión en vivo está a medias
// y su bloque vive en la copia de trabajo, no en el repo. El test no la exige —exigir una app
// cuyo `script:` no está versionado es justamente el error que se cometió al commitear esto la
// primera vez: PM2 habría intentado arrancar `media/servidor.js`, que no existe en el árbol—
// pero en cuanto aparezca, estas reglas empiezan a correr solas.
describe('classroom-media — mediasoup juega con otras reglas', () => {
  test('si ya está declarada, sigue en fork y con una sola instancia', () => {
    if (!media) return;   // todavía sin commitear: nada que revisar

    // No es una preferencia: un router de mediasoup vive en la memoria de UN proceso.
    // En cluster, la señalización de un alumno caería en el worker equivocado la mitad de
    // las veces. Ver D2 de specs/transmision-en-vivo.spec.md.
    assert.strictEqual(media.exec_mode, 'fork');
    assert.strictEqual(media.instances, 1);
  });

  test('lo COMMITEADO es coherente: toda app versionada tiene su script versionado', () => {
    // ⭐ El error que este caso existe para que no se repita, cometido el 2026-09-06 al preparar
    // este mismo cambio: `ecosystem.config.js` se commiteó entero, y se llevó el bloque de
    // `classroom-media` que estaba a medias en la copia de trabajo, mientras `media/servidor.js`
    // seguía SIN versionar. Nada se rompe al hacer `require()` del config —`script` es apenas un
    // string— y el sitio sigue en pie; lo que pasa es que `pm2 restart ecosystem.config.js` deja
    // esa app en `errored`. Y ese comando es justamente el único que aplica un cambio de techo
    // de memoria, así que el error se destapa en el peor momento: durante el despliegue.
    //
    // La comparación es commiteado-contra-commiteado A PROPÓSITO. Mirar el disco no serviría de
    // nada (`media/servidor.js` SÍ está en la carpeta, sin versionar) y además pondría en rojo
    // la copia de trabajo de cualquiera que tenga una app a medio hacer, que es un estado
    // legítimo. Lo que no es legítimo es publicar la config de un proceso sin publicar el
    // proceso.
    const { execFileSync } = require('node:child_process');
    const git = (...args) => execFileSync('git', args, {
      cwd: require('node:path').join(__dirname, '..', '..'), encoding: 'utf8',
    });

    let versionado;
    try {
      versionado = git('show', 'HEAD:ecosystem.config.js');
    } catch {
      return;   // sin git o sin HEAD (árbol recién inicializado): nada que comparar
    }

    // Los `script:` del archivo TAL COMO ESTÁ COMMITEADO, sin evaluar el código.
    const scripts = [...versionado.matchAll(/^\s*script:\s*'([^']+)'/gm)].map(m => m[1]);
    assert.ok(scripts.length > 0, 'no encontré ningún script: en el ecosystem commiteado');

    for (const script of scripts) {
      const seguido = git('ls-files', '--', script).trim();
      assert.ok(seguido !== '',
        `el ecosystem commiteado invoca "${script}", que NO está commiteado. ` +
        'Publicar la config de un proceso sin publicar el proceso deja esa app en errored ' +
        'apenas alguien corra `pm2 restart ecosystem.config.js`.');
    }
  });

  test('si algún día declara un techo de heap, vale la misma regla del margen', () => {
    if (!media) return;

    // Hoy NO lo declara a propósito: lo que ocupa un SFU son buffers de RTP en C++, memoria
    // nativa que el heap de V8 ni ve. Subirle el heap no arreglaría nada. Pero si alguien se
    // lo agrega, el margen tiene que estar igual.
    const heap = heapDeclaradoMB(media);
    if (heap === null) return;

    const techo  = aMB(media.max_memory_restart);
    const margen = techo - heap;
    assert.ok(margen >= MARGEN_NATIVO_MB,
      `classroom-media: margen de ${margen} MB entre el heap y el techo de PM2, ` +
      `hacen falta ${MARGEN_NATIVO_MB}`);
  });
});
