// La REGLA DE ORO de la verificación de contacto, fijada estáticamente sobre el código fuente:
//
//     toda escritura de User.email  borra emailVerifiedAt
//     toda escritura de User.phone  borra phoneVerifiedAt (y recalcula phoneE164)
//
// Es EL bug de esta clase de features: se verifica el correo, después se cambia por otro, y la
// marca verde queda pegada a un dato que nadie confirmó nunca. Un test funcional prueba los
// caminos que se le ocurrieron a quien lo escribió; éste prueba el código entero, que es lo que
// hace falta cuando el riesgo es que MAÑANA alguien agregue un séptimo lugar sin acordarse.
//
// Es el mismo remedio que la lista única CARPETAS del backup y su test: la única forma de pasar
// no es "acordarse", es usar los métodos del modelo (setEmail/setPhone/camposDeContacto).
//
// Ver specs/verificacion-de-contacto.spec.md, D5.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const RAIZ       = path.join(__dirname, '../..');
const CARPETAS   = ['routes', 'services'];
const MODELO     = path.join(RAIZ, 'models/User.js');

// Escrituras directas que NO son sobre un documento de usuario ya guardado, y por lo tanto no
// tienen ninguna verificación que borrar. Existe por el mismo motivo que EXCLUIDAS_DEL_BACKUP:
// para que el test pueda distinguir "se olvidaron" de "se decidió", que es exactamente la
// diferencia que nadie podía ver el día que faltaban 14 colecciones en el backup.
const ASIGNACIONES_PERMITIDAS = [
  {
    archivo: 'routes/superadmin.js',
    linea:   'userData.email = u.email;',
    porque:  'arma el payload de User.create() en la importación; es una cuenta NUEVA, ' +
             'que nace con emailVerifiedAt en null — no hay verificación que borrar',
  },
];

// Saca comentarios de línea y de bloque para no acusar a los comentarios que EXPLICAN la regla
// (hay varios que citan `user.email =` textualmente). Las cadenas quedan, que es aceptable: una
// cadena con `.email =` adentro no existe hoy y si apareciera merece una mirada igual.
function sinComentarios(codigo) {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

function archivosJs(carpeta) {
  const base = path.join(RAIZ, carpeta);
  const out  = [];
  (function recorrer(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(completo);
      else if (entrada.name.endsWith('.js')) out.push(completo);
    }
  })(base);
  return out;
}

const relativo = (abs) => path.relative(RAIZ, abs).replace(/\\/g, '/');

describe('el modelo ofrece la única forma correcta de escribir estos campos', () => {
  const fuente = fs.readFileSync(MODELO, 'utf8');

  test('User tiene setEmail, setPhone y camposDeContacto', () => {
    assert.match(fuente, /userSchema\.methods\.setEmail/, 'falta setEmail()');
    assert.match(fuente, /userSchema\.methods\.setPhone/, 'falta setPhone()');
    assert.match(fuente, /userSchema\.statics\.camposDeContacto/, 'falta camposDeContacto()');
  });

  test('los tres borran la verificación del canal que tocan', () => {
    const setEmail = fuente.slice(fuente.indexOf('methods.setEmail'), fuente.indexOf('methods.setPhone'));
    assert.match(setEmail, /emailVerifiedAt\s*=\s*null/,  'setEmail no borra emailVerifiedAt');
    assert.match(setEmail, /emailVerifiedVia\s*=\s*null/, 'setEmail no borra emailVerifiedVia');

    const setPhone = fuente.slice(fuente.indexOf('methods.setPhone'), fuente.indexOf('statics.camposDeContacto'));
    assert.match(setPhone, /phoneVerifiedAt\s*=\s*null/,  'setPhone no borra phoneVerifiedAt');
    assert.match(setPhone, /phoneE164\s*=/,               'setPhone no recalcula phoneE164');

    const campos = fuente.slice(fuente.indexOf('statics.camposDeContacto'));
    assert.match(campos, /emailVerifiedAt\s*=\s*null/, 'camposDeContacto no borra la del correo');
    assert.match(campos, /phoneVerifiedAt\s*=\s*null/, 'camposDeContacto no borra la del celular');
    assert.match(campos, /phoneE164\s*[:=]/,           'camposDeContacto no recalcula phoneE164');
  });
});

describe('nadie escribe email/phone por afuera de los métodos', () => {
  test('no hay asignaciones directas .email = / .phone = sin justificar', () => {
    const hallazgos = [];

    for (const carpeta of CARPETAS) {
      for (const archivo of archivosJs(carpeta)) {
        const rel    = relativo(archivo);
        const lineas = sinComentarios(fs.readFileSync(archivo, 'utf8')).split('\n');

        lineas.forEach((linea, i) => {
          // `.email =` pero no `==`, `===` ni `=>`
          if (!/\.(email|phone)\s*=[^=>]/.test(linea)) return;
          const texto     = linea.trim();
          const permitida = ASIGNACIONES_PERMITIDAS.some(
            (p) => p.archivo === rel && texto.includes(p.linea),
          );
          if (!permitida) hallazgos.push(`${rel}:${i + 1}  ${texto}`);
        });
      }
    }

    assert.deepStrictEqual(hallazgos, [],
      'Escritura directa de email/phone. Usá user.setEmail()/user.setPhone() — si no, la marca ' +
      'de verificado queda pegada a un dato que nadie confirmó. Si es una cuenta nueva y no ' +
      'aplica, sumala a ASIGNACIONES_PERMITIDAS con el motivo.');
  });

  test('ningún $set escribe email/phone sin pasar por camposDeContacto()', () => {
    // El otro camino de escritura: updateOne/findByIdAndUpdate, donde no hay documento sobre el
    // que llamar un método. Es por donde se coló el intercambio de correos de la fusión de DNI
    // duplicados (services/dbFixes.js), que el barrido inicial de la spec no había visto.
    const hallazgos = [];

    for (const carpeta of CARPETAS) {
      for (const archivo of archivosJs(carpeta)) {
        const rel    = relativo(archivo);
        const lineas = sinComentarios(fs.readFileSync(archivo, 'utf8')).split('\n');

        lineas.forEach((linea, i) => {
          if (!/\$set\s*:/.test(linea)) return;
          if (!/\b(email|phone)\s*:/.test(linea)) return;
          if (linea.includes('camposDeContacto')) return;
          hallazgos.push(`${rel}:${i + 1}  ${linea.trim()}`);
        });
      }
    }

    assert.deepStrictEqual(hallazgos, [],
      'Un $set escribe email/phone directo. Usá { $set: User.camposDeContacto({ email }) }.');
  });

  test('las asignaciones permitidas siguen existiendo (si no, sobra la excepción)', () => {
    // Sin esto, la lista de excepciones se vuelve basura acumulada: quedan renglones
    // protegiendo código que ya no está, y el siguiente que la lea no sabe si son reales.
    for (const permitida of ASIGNACIONES_PERMITIDAS) {
      const fuente = fs.readFileSync(path.join(RAIZ, permitida.archivo), 'utf8');
      assert.ok(fuente.includes(permitida.linea),
        `sobra la excepción de ${permitida.archivo}: ya no existe "${permitida.linea}"`);
      assert.ok(permitida.porque && permitida.porque.length > 20,
        `la excepción de ${permitida.archivo} tiene que decir POR QUÉ`);
    }
  });
});
