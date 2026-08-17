// Tests del envío del backup por FTP (services/backupFtp.js).
// Correr con: npm run test:unit
//
// Corren contra un servidor FTP de verdad —uno mínimo, levantado acá mismo (ver
// ftpServidorDePrueba.js)— y no contra un mock. La razón: lo único que importa de esta
// feature es que el paquete llegue ENTERO del otro lado, y eso solo se verifica hablando
// el protocolo. Lo que fijan estos tests:
//
//   1. lo que sube es byte por byte lo que se mandó;
//   2. se sube como `.part` y se renombra recién al terminar — un envío cortado tiene que
//      VERSE cortado, porque un .tar.gz truncado con nombre bueno se descubre incompleto
//      el día que hace falta restaurarlo, que es el peor día posible;
//   3. "Probar conexión" prueba ESCRITURA, no solo login (IIS crea los sitios FTP en modo
//      lectura por defecto: enterarse a los 800 MB transferidos sería inaceptable);
//   4. los errores llegan traducidos a algo accionable y no como el texto crudo de la
//      librería.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { crearServidorFtp } = require('./ftpServidorDePrueba');
const {
  probarConexion, enviarBackup, limpiarParcial, mensajeDeError, modoSeguro, ARCHIVO_PRUEBA,
} = require('../../services/backupFtp');

const USUARIO  = 'tester';
const PASSWORD = 'secreto';

// Levanta un servidor limpio para cada test: comparten puerto efímero y carpeta propia,
// así ninguno depende de lo que haya dejado el anterior.
async function conServidor(fn) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-prueba-'));
  const srv  = crearServidorFtp({ usuario: USUARIO, password: PASSWORD, raiz });
  const puerto = await srv.escuchar();
  try {
    await fn({ raiz, puerto, destinoBase: {
      host: '127.0.0.1', puerto, usuario: USUARIO, password: PASSWORD, modo: 'plano', directorio: '/',
    } });
  } finally {
    await srv.cerrar();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Probar conexión
// ─────────────────────────────────────────────────────────────────────────────

test('probarConexion entra, escribe y borra el archivo de prueba', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    const r = await probarConexion(destinoBase);

    assert.strictEqual(r.escritura, true);
    assert.strictEqual(r.limpio, true);
    assert.strictEqual(r.carpeta, '/');
    // Lo importante del "limpio": el archivo de prueba no puede quedar tirado en la
    // carpeta de backups del dueño.
    assert.ok(!fs.existsSync(path.join(raiz, ARCHIVO_PRUEBA)), 'quedó el archivo de prueba sin borrar');
  });
});

test('probarConexion crea la carpeta de destino si no existe', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    const r = await probarConexion({ ...destinoBase, directorio: '/backups/classroom' });

    assert.strictEqual(r.carpeta, '/backups/classroom');
    assert.ok(fs.existsSync(path.join(raiz, 'backups', 'classroom')), 'no se creó la carpeta anidada');
  });
});

test('probarConexion falla con credenciales incorrectas y el mensaje explica qué revisar', async () => {
  await conServidor(async ({ destinoBase }) => {
    const err = await probarConexion({ ...destinoBase, password: 'incorrecta' })
      .then(() => null, e => e);

    assert.ok(err, 'debería haber fallado con la contraseña incorrecta');
    const mensaje = mensajeDeError(err, destinoBase);
    assert.match(mensaje, /usuario o la contrase/i);
    // No alcanza con decir "530": el mensaje tiene que orientar sobre el usuario de IIS.
    assert.match(mensaje, /IIS/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Envío
// ─────────────────────────────────────────────────────────────────────────────

test('enviarBackup sube el contenido intacto y lo deja con el nombre final', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    // 3 MB de bytes aleatorios: suficiente para que la transferencia use varios chunks y
    // el pipe no sea un solo write, que es donde aparecerían los errores de corrupción.
    const contenido = crypto.randomBytes(3 * 1024 * 1024);
    const nombre    = 'classroom-backup-2026-08-17.tar.gz';

    const r = await enviarBackup({
      destino: destinoBase, nombre, origen: Readable.from([contenido]),
    });

    const destinoReal = path.join(raiz, nombre);
    assert.ok(fs.existsSync(destinoReal), 'no llegó el archivo');
    assert.deepStrictEqual(fs.readFileSync(destinoReal), contenido, 'el contenido no es idéntico');
    assert.strictEqual(r.remoto, '/' + nombre);

    // El parcial no puede sobrevivir a un envío exitoso.
    assert.ok(!fs.existsSync(destinoReal + '.part'), 'quedó el .part después de terminar bien');
  });
});

test('enviarBackup informa progreso creciente mientras transfiere', async () => {
  await conServidor(async ({ destinoBase }) => {
    const contenido = crypto.randomBytes(4 * 1024 * 1024);
    const avances   = [];

    await enviarBackup({
      destino: destinoBase, nombre: 'con-progreso.tar.gz',
      origen: Readable.from([contenido]),
      onProgress: (bytes) => avances.push(bytes),
    });

    assert.ok(avances.length > 0, 'nunca se reportó progreso');
    // El último reporte tiene que coincidir con lo realmente transferido: es el número que
    // la pantalla muestra como "se enviaron X MB".
    assert.strictEqual(avances[avances.length - 1], contenido.length);
    for (let i = 1; i < avances.length; i++) {
      assert.ok(avances[i] >= avances[i - 1], 'el contador de progreso retrocedió');
    }
  });
});

test('enviarBackup sube a .part primero: un corte deja un parcial, nunca un .tar.gz con nombre bueno', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    const nombre = 'cortado.tar.gz';

    // Un origen que falla a mitad de camino simula el caso real: el empaquetado se cae o
    // el dueño cancela con la transferencia empezada.
    const origen = new Readable({
      read() {
        this.push(crypto.randomBytes(64 * 1024));
        if (!this._veces) this._veces = 0;
        if (++this._veces > 8) this.destroy(new Error('se cortó el origen'));
      },
    });

    const err = await enviarBackup({ destino: destinoBase, nombre, origen })
      .then(() => null, e => e);

    assert.ok(err, 'el envío cortado debería haber fallado');
    // La invariante que sostiene todo el diseño: NUNCA puede aparecer el nombre final.
    assert.ok(!fs.existsSync(path.join(raiz, nombre)),
      'apareció el .tar.gz con nombre final pese a que la transferencia se cortó');
  });
});

test('limpiarParcial borra el .part que quedó de un envío fallido', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    const nombre = 'quedo-a-medias.tar.gz';
    fs.writeFileSync(path.join(raiz, nombre + '.part'), 'medio archivo');

    assert.strictEqual(await limpiarParcial(destinoBase, nombre), true);
    assert.ok(!fs.existsSync(path.join(raiz, nombre + '.part')), 'no se borró el parcial');
  });
});

test('limpiarParcial devuelve false sin explotar si no puede conectarse', async () => {
  // Es limpieza best-effort disparada desde el catch de la ruta: si tira, se comería el
  // error real del envío que el dueño necesita ver.
  const resultado = await limpiarParcial(
    { host: '127.0.0.1', puerto: 1, usuario: 'x', password: 'y', modo: 'plano', directorio: '/' },
    'lo-que-sea.tar.gz',
  );
  assert.strictEqual(resultado, false);
});

test('un envío cancelado por la señal corta la transferencia', async () => {
  await conServidor(async ({ raiz, destinoBase }) => {
    const ac     = new AbortController();
    const nombre = 'cancelado.tar.gz';

    // Origen infinito y lento: sin la cancelación este test no terminaría nunca, que es
    // justamente lo que pasaría en producción si cerrar la pestaña no cortara nada.
    const origen = new Readable({
      read() { setTimeout(() => this.push(crypto.randomBytes(64 * 1024)), 5); },
    });

    const promesa = enviarBackup({
      destino: destinoBase, nombre, origen,
      onProgress: (bytes) => { if (bytes > 128 * 1024) ac.abort(); },
      senal: ac.signal,
    });

    const err = await promesa.then(() => null, e => e);
    origen.destroy();

    assert.ok(err, 'cancelar tiene que hacer que el envío rechace');
    assert.ok(!fs.existsSync(path.join(raiz, nombre)), 'un envío cancelado no puede dejar el nombre final');
  });
});

test('una señal ya abortada ni siquiera abre la conexión', async () => {
  const ac = new AbortController();
  ac.abort();

  // Puerto cerrado a propósito: si intentara conectar, el error sería ECONNREFUSED. Que
  // diga "cancelado" prueba que ni lo intentó.
  const err = await enviarBackup({
    destino: { host: '127.0.0.1', puerto: 1, usuario: 'x', password: 'y', modo: 'plano', directorio: '/' },
    nombre: 'nada.tar.gz', origen: Readable.from(['x']), senal: ac.signal,
  }).then(() => null, e => e);

  assert.match(err.message, /cancelado/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Traducción de errores
// ─────────────────────────────────────────────────────────────────────────────

test('un puerto sin nadie escuchando explica que falta prender el servidor FTP', async () => {
  const destino = { host: '127.0.0.1', puerto: 1, usuario: 'x', password: 'y', modo: 'plano', directorio: '/' };
  const err = await probarConexion(destino).then(() => null, e => e);

  assert.ok(err);
  const mensaje = mensajeDeError(err, destino);
  // El error crudo ("connect ECONNREFUSED 127.0.0.1:1") no le dice a nadie qué hacer.
  assert.match(mensaje, /servidor FTP/i);
  assert.ok(!/ECONNREFUSED/.test(mensaje), 'se filtró el error crudo de Node al mensaje del usuario');
});

test('mensajeDeError traduce los fallos típicos de un FTP casero', () => {
  const destino = { host: 'mi-pc.ts.net', puerto: 21, directorio: '/backups' };

  // DNS: el caso concreto de esta feature es MagicDNS apagado.
  assert.match(mensajeDeError({ code: 'ENOTFOUND' }, destino), /Tailscale/);

  // Modo pasivo: el error más frecuente y el menos evidente. Conecta y autentica bien, y
  // recién falla al abrir el canal de datos. Sin nombrar el rango de puertos no se resuelve.
  assert.match(mensajeDeError({ code: 425 }, destino), /pasiv/i);
  assert.match(mensajeDeError({ code: 425 }, destino), /firewall/i);

  // Permisos: tiene que mencionar la ESCRITURA, que es lo que falta el 90% de las veces.
  assert.match(mensajeDeError({ code: 550 }, destino), /ESCRITURA/);
  assert.match(mensajeDeError({ code: 550 }, destino), /backups/); // nombra la carpeta que falló

  // Elegir mal explícito/implícito da un error de TLS ilegible; hay que decir cuál probar.
  assert.match(mensajeDeError({ message: 'wrong version number' }, destino), /implícito|explícito/);

  // Nunca puede quedar vacío: un mensaje en blanco en la pantalla es peor que uno crudo.
  assert.ok(mensajeDeError(new Error('algo raro'), destino).length > 0);
});

test('modoSeguro traduce los modos de la pantalla al vocabulario de basic-ftp', () => {
  assert.strictEqual(modoSeguro('plano'), false);
  assert.strictEqual(modoSeguro('ftps'), true);
  assert.strictEqual(modoSeguro('ftps-implicito'), 'implicit');
  assert.strictEqual(modoSeguro(undefined), false); // default seguro: no romper la conexión
});
