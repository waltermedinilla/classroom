// Tests del destino FTP guardado (config/ftpDestino.js).
// Correr con: npm run test:unit
//
// Dos cosas se cuidan acá y las dos son de las que no avisan cuando se rompen:
//
//   1. Que lo que el dueño tipea llegue normalizado. Pegar "ftp://mi-pc/backups" de la
//      barra del explorador, o "mi-pc:2121", o una carpeta con barras invertidas de
//      Windows, es lo que uno hace sin pensar. Si eso no se limpia acá, el error aparece
//      recién 15 segundos después como un ENOTFOUND que no explica nada.
//   2. Que la contraseña del FTP de casa NO quede en texto plano en el disco del servidor.
//      El repo ya tuvo un leak de credenciales por un archivo copiado sin mirar.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ANTES del require: config/ftpDestino.js resuelve la ruta una sola vez, al cargarse. Sin
// esto los tests escribirían ftp-destino.json en la raíz del repo y le pisarían al dueño
// el destino real que tenga configurado.
const DIR_TMP = fs.mkdtempSync(path.join(os.tmpdir(), `ftp-destino-${process.pid}-`));
process.env.FTP_DESTINO_FILE = path.join(DIR_TMP, 'ftp-destino.json');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-para-los-tests';

const {
  normalizarDestino, normalizarDirectorio, partirHostPuerto,
  leerDestino, leerPassword, tienePasswordGuardada, puedeGuardarPassword,
  guardarDestino, olvidarDestino, DestinoInvalido, DESTINO_FILE,
} = require('../../config/ftpDestino');

const BASE = { host: '100.101.102.103', usuario: 'walter', modo: 'plano', directorio: '/backups' };

test.afterEach(() => olvidarDestino());
test.after(() => fs.rmSync(DIR_TMP, { recursive: true, force: true }));

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de lo que se tipea
// ─────────────────────────────────────────────────────────────────────────────

test('acepta una URL pegada del explorador y se queda solo con el host', () => {
  // "ftp://mi-pc.tailc1c538.ts.net/backups" es exactamente lo que uno copia y pega.
  const d = normalizarDestino({ ...BASE, host: 'ftp://mi-pc.tailc1c538.ts.net/backups' });
  assert.strictEqual(d.host, 'mi-pc.tailc1c538.ts.net');
});

test('separa el puerto pegado al host, pero el campo puerto gana si está lleno', () => {
  assert.strictEqual(normalizarDestino({ ...BASE, host: 'mi-pc:2121' }).puerto, 2121);

  // Si el dueño llenó los dos, mandar el del host sería ignorar lo que tipeó más
  // específicamente en su propio campo.
  assert.strictEqual(normalizarDestino({ ...BASE, host: 'mi-pc:2121', puerto: 21 }).puerto, 21);
});

test('entiende IPv6, que es lo que reparte Tailscale además de la 100.x', () => {
  // Con corchetes se le puede sacar el puerto...
  assert.deepStrictEqual(partirHostPuerto('[fd7a:115c:a1e0::1]:2121'),
    { host: 'fd7a:115c:a1e0::1', puerto: '2121' });

  // ...y pelada no, porque los ':' son ambiguos: se toma entera como host.
  assert.deepStrictEqual(partirHostPuerto('fd7a:115c:a1e0::1'),
    { host: 'fd7a:115c:a1e0::1', puerto: null });
});

test('el puerto por defecto sale del modo elegido', () => {
  assert.strictEqual(normalizarDestino({ ...BASE, modo: 'plano' }).puerto, 21);
  assert.strictEqual(normalizarDestino({ ...BASE, modo: 'ftps' }).puerto, 21);
  // El implícito vive en el 990 por convención; que el formulario no lo sepa no puede
  // terminar en una conexión al 21 que va a fallar con un error de TLS ilegible.
  assert.strictEqual(normalizarDestino({ ...BASE, modo: 'ftps-implicito' }).puerto, 990);
});

test('la carpeta se normaliza al estilo del protocolo aunque del otro lado haya Windows', () => {
  // FTP habla con '/' sin importar el filesystem del servidor: pegar "C:\Backups" tiene
  // que funcionar igual.
  assert.strictEqual(normalizarDirectorio('C:\\Backups\\classroom'), 'C:/Backups/classroom');
  assert.strictEqual(normalizarDirectorio('/backups/'), '/backups');
  assert.strictEqual(normalizarDirectorio('/backups//classroom'), '/backups/classroom');
  assert.strictEqual(normalizarDirectorio(''), '/');
  assert.strictEqual(normalizarDirectorio(undefined), '/');
});

test('rechaza lo que no se puede usar, con un mensaje entendible', () => {
  const mensajeDe = (crudo) => {
    try { normalizarDestino(crudo); return null; } catch (e) {
      assert.ok(e instanceof DestinoInvalido, 'tiene que ser DestinoInvalido para salir como 400');
      return e.message;
    }
  };

  assert.match(mensajeDe({ ...BASE, host: '' }),            /IP o el nombre/i);
  assert.match(mensajeDe({ ...BASE, host: 'mi pc casa' }),  /no parece una IP/i);
  assert.match(mensajeDe({ ...BASE, usuario: '' }),         /usuario/i);
  assert.match(mensajeDe({ ...BASE, puerto: '99999' }),     /Puerto inválido/i);
  assert.match(mensajeDe({ ...BASE, puerto: 'veintiuno' }), /Puerto inválido/i);
  assert.match(mensajeDe({ ...BASE, modo: 'sftp' }),        /Modo de conexión/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia
// ─────────────────────────────────────────────────────────────────────────────

test('guardar y releer devuelve el mismo destino', () => {
  guardarDestino({ ...BASE, puerto: 2121 });
  const leido = leerDestino();

  assert.strictEqual(leido.host, '100.101.102.103');
  assert.strictEqual(leido.puerto, 2121);
  assert.strictEqual(leido.usuario, 'walter');
  assert.strictEqual(leido.directorio, '/backups');
  assert.ok(leido.guardadoEn, 'falta la marca de cuándo se guardó');
});

test('leerDestino devuelve null si nunca se guardó nada', () => {
  assert.strictEqual(leerDestino(), null);
  assert.strictEqual(tienePasswordGuardada(), false);
});

test('un archivo corrupto se trata como "no hay destino" y no rompe la pantalla', () => {
  fs.writeFileSync(DESTINO_FILE, '{ esto no es json');
  assert.strictEqual(leerDestino(), null);
  assert.deepStrictEqual(leerPassword(), { hay: false, password: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// La contraseña
// ─────────────────────────────────────────────────────────────────────────────

test('la contraseña no queda en texto plano en el disco', () => {
  guardarDestino(BASE, { password: 'MiContraseñaSuperSecreta123' });

  const crudo = fs.readFileSync(DESTINO_FILE, 'utf8');
  assert.ok(!crudo.includes('MiContraseñaSuperSecreta123'),
    'la contraseña aparece legible en ftp-destino.json');
  assert.ok(!crudo.includes('"password"'), 'quedó un campo password sin cifrar');

  // Y sin embargo se puede recuperar para usarla.
  assert.deepStrictEqual(leerPassword(), { hay: true, password: 'MiContraseñaSuperSecreta123' });
  assert.strictEqual(tienePasswordGuardada(), true);
});

test('leerDestino nunca devuelve la contraseña: es lo que viaja al navegador', () => {
  guardarDestino(BASE, { password: 'no-debe-salir' });
  const leido = leerDestino();

  assert.ok(!('password' in leido), 'leerDestino filtró la contraseña');
  assert.ok(!('passwordCifrada' in leido), 'leerDestino filtró la contraseña cifrada');
});

test('guardar sin tocar la contraseña conserva la que ya estaba', () => {
  guardarDestino(BASE, { password: 'la-original' });

  // Es el caso del formulario: el navegador no rellena los campos password, así que
  // cambiar solo la carpeta llega con el campo vacío. Borrarla ahí sería el accidente.
  guardarDestino({ ...BASE, directorio: '/otra-carpeta' });

  assert.strictEqual(leerDestino().directorio, '/otra-carpeta');
  assert.strictEqual(leerPassword().password, 'la-original');
});

test('pasar password null la borra', () => {
  guardarDestino(BASE, { password: 'la-original' });
  guardarDestino(BASE, { password: null });

  assert.strictEqual(tienePasswordGuardada(), false);
  assert.deepStrictEqual(leerPassword(), { hay: false, password: null });
});

test('si cambió JWT_SECRET la contraseña queda ilegible, y eso se distingue de "no hay"', () => {
  guardarDestino(BASE, { password: 'atada-al-secreto-viejo' });

  const secretoOriginal = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'otro-secreto-completamente-distinto';
  try {
    const r = leerPassword();
    // La diferencia importa: "hay: true, password: null" es lo que deja a la ruta decir
    // "volvé a escribirla" en vez del genérico "falta la contraseña".
    assert.deepStrictEqual(r, { hay: true, password: null });
  } finally {
    process.env.JWT_SECRET = secretoOriginal;
  }
});

test('sin JWT_SECRET no se guarda ninguna contraseña: preferimos tipearla cada vez', () => {
  const secretoOriginal = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.strictEqual(puedeGuardarPassword(), false);
    assert.throws(() => guardarDestino(BASE, { password: 'algo' }), DestinoInvalido);

    // El destino sin contraseña sí se puede guardar: perder el host tipeado además de la
    // contraseña sería castigar dos veces por lo mismo.
    assert.doesNotThrow(() => guardarDestino(BASE));
    assert.strictEqual(leerDestino().host, BASE.host);
  } finally {
    process.env.JWT_SECRET = secretoOriginal;
  }
});

test('olvidarDestino borra todo, incluida la contraseña', () => {
  guardarDestino(BASE, { password: 'chau' });
  olvidarDestino();

  assert.strictEqual(leerDestino(), null);
  assert.strictEqual(tienePasswordGuardada(), false);
  assert.ok(!fs.existsSync(DESTINO_FILE));
});
