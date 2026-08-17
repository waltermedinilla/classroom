const net  = require('net');
const fs   = require('fs');
const path = require('path');

// Servidor FTP mínimo, SOLO para los tests de services/backupFtp.js.
//
// Por qué existe en vez de un mock: lo único que importa de esta feature es que los bytes
// lleguen enteros del otro lado. Un mock de basic-ftp probaría que llamamos a los métodos
// que decidimos llamar —o sea, nada—, mientras que el `.part` que se renombra al final, el
// contador de progreso y el permiso de escritura solo se pueden verificar hablando el
// protocolo de verdad. Es también la razón por la que no se agrega un paquete de servidor
// FTP como devDependency: acá alcanza con los ~10 comandos que basic-ftp usa para subir.
//
// Implementa lo justo: USER/PASS, FEAT, TYPE, PWD, CWD, MKD, EPSV, PASV, STOR, DELE,
// RNFR/RNTO, QUIT. Sin TLS, sin listados, sin descargas. No sirve para nada más que esto.

function crearServidorFtp({ usuario = 'tester', password = 'secreto', raiz } = {}) {
  const conexiones = new Set();

  const servidor = net.createServer((control) => {
    conexiones.add(control);
    control.on('close', () => conexiones.delete(control));
    control.on('error', () => {}); // un cliente que corta de golpe no es un fallo del test

    let autenticado  = false;
    let usuarioDado  = null;
    let cwd          = '/';           // relativo a `raiz`, siempre con '/'
    let renombrarDe  = null;
    let servidorDatos = null;
    let esperaDatos   = null;         // Promise<socket> de la conexión de datos pendiente
    let buffer = '';

    const responder = (linea) => control.write(linea + '\r\n');

    // Traduce una ruta del protocolo (siempre '/') a una del filesystem real, sin dejar
    // que un '..' se escape de la carpeta del test.
    const aReal = (rutaFtp) => {
      const destino = path.resolve(raiz, '.' + path.posix.resolve('/', rutaFtp));
      if (destino !== raiz && !destino.startsWith(raiz + path.sep)) return null;
      return destino;
    };

    const resolverDesdeCwd = (arg) => path.posix.resolve(cwd, arg);

    const abrirModoPasivo = (formato) => {
      if (servidorDatos) servidorDatos.close();
      servidorDatos = net.createServer();
      esperaDatos = new Promise((resolve) => servidorDatos.once('connection', resolve));
      servidorDatos.listen(0, '127.0.0.1', () => {
        const puerto = servidorDatos.address().port;
        if (formato === 'epsv') {
          responder(`229 Entering Extended Passive Mode (|||${puerto}|)`);
        } else {
          responder(`227 Entering Passive Mode (127,0,0,1,${puerto >> 8},${puerto & 255})`);
        }
      });
    };

    const cerrarDatos = () => {
      if (servidorDatos) { servidorDatos.close(); servidorDatos = null; }
      esperaDatos = null;
    };

    const manejar = async (linea) => {
      const corte  = linea.indexOf(' ');
      const cmd    = (corte === -1 ? linea : linea.slice(0, corte)).toUpperCase();
      const arg    = corte === -1 ? '' : linea.slice(corte + 1);

      if (cmd === 'USER') { usuarioDado = arg; return responder('331 Password required'); }
      if (cmd === 'PASS') {
        autenticado = usuarioDado === usuario && arg === password;
        return responder(autenticado ? '230 Login successful' : '530 Login incorrect');
      }
      if (!autenticado) return responder('530 Please login with USER and PASS');

      switch (cmd) {
        case 'FEAT':  return control.write('211-Features:\r\n UTF8\r\n211 End\r\n');
        case 'SYST':  return responder('215 UNIX Type: L8');
        case 'TYPE':  return responder('200 Type set');
        case 'STRU':  return responder('200 Structure set');
        case 'OPTS':  return responder('200 Ok');
        case 'NOOP':  return responder('200 Ok');
        case 'PWD':   return responder(`257 "${cwd}" is the current directory`);

        case 'CWD': {
          const destino = resolverDesdeCwd(arg);
          const real    = aReal(destino);
          if (!real || !fs.existsSync(real) || !fs.statSync(real).isDirectory()) {
            return responder('550 Failed to change directory');
          }
          cwd = destino;
          return responder('250 Directory changed');
        }

        case 'MKD': {
          const destino = resolverDesdeCwd(arg);
          const real    = aReal(destino);
          if (!real) return responder('550 Permission denied');
          fs.mkdirSync(real, { recursive: true });
          return responder(`257 "${destino}" created`);
        }

        case 'EPSV': abrirModoPasivo('epsv'); return;
        case 'PASV': abrirModoPasivo('pasv'); return;

        case 'STOR': {
          if (!esperaDatos) return responder('425 Use PASV or EPSV first');
          const destino = resolverDesdeCwd(arg);
          const real    = aReal(destino);
          if (!real) return responder('550 Permission denied');

          const espera = esperaDatos;
          responder('150 Opening data connection');
          try {
            const datos = await espera;
            await new Promise((resolve, reject) => {
              const salida = fs.createWriteStream(real);
              datos.pipe(salida);
              salida.on('finish', resolve);
              salida.on('error', reject);
              datos.on('error', reject);
            });
            responder('226 Transfer complete');
          } catch (err) {
            responder('426 Transfer aborted: ' + err.message);
          } finally {
            cerrarDatos();
          }
          return;
        }

        case 'DELE': {
          const real = aReal(resolverDesdeCwd(arg));
          if (!real || !fs.existsSync(real)) return responder('550 File not found');
          fs.unlinkSync(real);
          return responder('250 File deleted');
        }

        case 'RNFR': {
          const real = aReal(resolverDesdeCwd(arg));
          if (!real || !fs.existsSync(real)) return responder('550 File not found');
          renombrarDe = real;
          return responder('350 Ready for destination name');
        }

        case 'RNTO': {
          const real = aReal(resolverDesdeCwd(arg));
          if (!renombrarDe || !real) return responder('503 Bad sequence of commands');
          fs.renameSync(renombrarDe, real);
          renombrarDe = null;
          return responder('250 Rename successful');
        }

        case 'QUIT':
          responder('221 Goodbye');
          cerrarDatos();
          return control.end();

        default:
          return responder('502 Command not implemented');
      }
    };

    // Las respuestas tienen que salir en el orden en que llegaron los comandos, y STOR es
    // async (espera la conexión de datos y el archivo entero). Sin esta cola, un comando
    // que llegue pegado en el mismo paquete se respondería antes que el STOR anterior.
    let cola = Promise.resolve();
    control.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let corte;
      while ((corte = buffer.indexOf('\r\n')) !== -1) {
        const linea = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        if (linea) cola = cola.then(() => manejar(linea)).catch(() => {});
      }
    });

    responder('220 Servidor FTP de prueba');
  });

  return {
    escuchar: () => new Promise((resolve) => {
      servidor.listen(0, '127.0.0.1', () => resolve(servidor.address().port));
    }),
    cerrar: () => new Promise((resolve) => {
      for (const c of conexiones) c.destroy();
      servidor.close(resolve);
    }),
  };
}

module.exports = { crearServidorFtp };
