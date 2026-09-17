// RN-18 de specs/fusion-de-cuentas.spec.md, fijada sobre el código fuente:
//
//     rehabilitar una cuenta borra su marca de fusión (mergedInto, mergedAt)
//
// Por qué importa. El login de una cuenta deshabilitada que tiene `mergedInto` dice "esta cuenta
// se unificó con otra, entrá con l••••@gmail.com" (RN-17). Si una fusión se deshace volviendo a
// habilitar la cuenta, y meses después alguien la deshabilita por otro motivo —un pase de
// escuela—, sin esta regla el login le diría a esa persona que se unificó con una cuenta que no
// tiene nada que ver con lo que le pasó.
//
// Hoy hay TRES rutas que prenden y apagan cuentas (admin, preceptor y el docente desde el curso),
// y mañana puede haber una cuarta. Mismo remedio que la regla de oro del correo
// (tests/unit/verificacionRegla.test.js): la única forma de pasar no es acordarse, es usar el
// método del modelo, `user.setActive()`.

const { test, describe } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');
const mongoose = require('mongoose');

const User = require('../../models/User');

const RAIZ     = path.join(__dirname, '../..');
const CARPETAS = ['routes', 'services'];

// Asignaciones a `.active` que NO son sobre un documento de usuario: no hay marca que borrar.
const ASIGNACIONES_PERMITIDAS = [
  {
    archivo: 'routes/superadmin.js',
    linea:   "filter.active = true;",
    porque:  'arma el FILTRO de la búsqueda de usuarios (?active=true); no escribe ninguna cuenta',
  },
  {
    archivo: 'routes/superadmin.js',
    linea:   "filter.active = false;",
    porque:  'arma el FILTRO de la búsqueda de usuarios (?active=false); no escribe ninguna cuenta',
  },
];

function sinComentarios(codigo) {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

function archivosJs(carpeta) {
  const out = [];
  (function recorrer(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(completo);
      else if (entrada.name.endsWith('.js')) out.push(completo);
    }
  })(path.join(RAIZ, carpeta));
  return out;
}

const relativo = (abs) => path.relative(RAIZ, abs).replace(/\\/g, '/');

describe('el modelo ofrece la forma correcta de prender y apagar una cuenta', () => {
  const marcada = () => new User({
    name: 'Cuenta unificada', email: 'padron@familia.com', password: 'x', role: 'student',
    active: false, mergedInto: new mongoose.Types.ObjectId(), mergedAt: new Date('2026-09-16'),
  });

  test('User declara mergedInto y mergedAt, opcionales', () => {
    const u = new User({ name: 'x', email: 'x@y.com', password: 'x', role: 'student' });
    assert.strictEqual(u.mergedInto ?? null, null, 'una cuenta nueva no nace marcada');
    assert.strictEqual(u.mergedAt ?? null, null);
    assert.ok(User.schema.path('mergedInto'), 'falta el campo mergedInto en el schema');
    assert.ok(User.schema.path('mergedAt'), 'falta el campo mergedAt en el schema');
    assert.ok(!User.schema.path('mergedInto').isRequired, 'tiene que ser opcional: las cuentas viejas no lo tienen');
  });

  test('setActive(true) habilita y borra la marca de fusión', () => {
    const u = marcada();
    assert.strictEqual(typeof u.setActive, 'function', 'falta user.setActive()');
    u.setActive(true);
    assert.strictEqual(u.active, true);
    assert.strictEqual(u.mergedInto, null);
    assert.strictEqual(u.mergedAt, null);
  });

  test('setActive(false) deshabilita y NO toca la marca', () => {
    // Apagar a mano una cuenta ya unificada no tiene por qué borrar a qué cuenta se unificó.
    const u = marcada();
    const destino = u.mergedInto;
    u.setActive(false);
    assert.strictEqual(u.active, false);
    assert.strictEqual(String(u.mergedInto), String(destino));
  });
});

describe('nadie prende o apaga una cuenta por afuera de setActive()', () => {
  test('no hay asignaciones directas .active = sin justificar', () => {
    const hallazgos = [];
    for (const carpeta of CARPETAS) {
      for (const archivo of archivosJs(carpeta)) {
        const rel = relativo(archivo);
        sinComentarios(fs.readFileSync(archivo, 'utf8')).split('\n').forEach((linea, i) => {
          if (!/\.active\s*=[^=>]/.test(linea)) return;
          const texto = linea.trim();
          if (ASIGNACIONES_PERMITIDAS.some(p => p.archivo === rel && texto.includes(p.linea))) return;
          hallazgos.push(`${rel}:${i + 1}  ${texto}`);
        });
      }
    }
    assert.deepStrictEqual(hallazgos, [],
      'Asignación directa a .active. Usá user.setActive(valor): si no, rehabilitar una cuenta ' +
      'unificada deja pegada la marca y el login mentiría el día que se la vuelva a apagar. Si no ' +
      'es un documento de usuario, sumala a ASIGNACIONES_PERMITIDAS con el motivo.');
  });

  // Un `$set` que escribe `active` con cualquier valor que no sea el literal `false` —true, una
  // variable, una expresión— puede estar habilitando una cuenta. Se busca sobre el archivo ENTERO
  // y no renglón por renglón: la revisión del 2026-09-17 mostró que la versión por renglón no veía
  // un `$set: {` con los campos abajo, que es como está escrita la mitad del proyecto.
  // ⚠️ El espacio va ADENTRO de la condición negativa: con `:\s*(?!false)` el `\s*` retrocede un
  // espacio, la condición mira " false" en vez de "false", y `active: false` contaba como que
  // habilita (el control de abajo lo cazó).
  const HABILITA = /\$set\s*:\s*\{[^{}]*?\bactive\s*:(?!\s*false\b)[^{}]*\}/g;
  const setsQueHabilitan = (codigo) => [...codigo.matchAll(HABILITA)]
    .filter(m => !/mergedInto/.test(m[0]))
    .map(m => ({ texto: m[0], linea: codigo.slice(0, m.index).split('\n').length }));

  test('el detector ve un $set que habilita, esté en un renglón o en varios', () => {
    // Control del propio barrido: si deja de ver estos casos, el test de abajo pasa sin mirar nada.
    assert.strictEqual(setsQueHabilitan("User.updateOne({ _id }, { $set: { active: true } })").length, 1);
    assert.strictEqual(setsQueHabilitan('User.updateOne({ _id }, {\n  $set: {\n    nombre: x,\n    active: true,\n  },\n})').length, 1);
    assert.strictEqual(setsQueHabilitan('User.updateMany(f, { $set: { active: req.body.activa } })').length, 1);
    assert.strictEqual(setsQueHabilitan('User.updateOne(f, { $set: { active: true, mergedInto: null, mergedAt: null } })').length, 0);
    assert.strictEqual(setsQueHabilitan('User.updateOne(f, { $set: { active: false } })').length, 0, 'apagar no borra la marca');
    assert.strictEqual(setsQueHabilitan('User.find({ active: true })').length, 0, 'un filtro no escribe');
  });

  test('ningún $set habilita una cuenta sin borrar la marca', () => {
    // El otro camino de escritura: updateOne/updateMany, donde no hay documento sobre el que
    // llamar el método.
    const hallazgos = [];
    for (const carpeta of CARPETAS) {
      for (const archivo of archivosJs(carpeta)) {
        const rel = relativo(archivo);
        for (const h of setsQueHabilitan(sinComentarios(fs.readFileSync(archivo, 'utf8')))) {
          hallazgos.push(`${rel}:~${h.linea}  ${h.texto.replace(/\s+/g, ' ')}`);
        }
      }
    }
    assert.deepStrictEqual(hallazgos, [],
      'Un $set escribe active sin borrar mergedInto. Si habilita, agregá mergedInto: null y mergedAt: null.');
  });

  test('las asignaciones permitidas siguen existiendo (si no, sobra la excepción)', () => {
    const sobran = ASIGNACIONES_PERMITIDAS.filter(p => {
      const fuente = fs.readFileSync(path.join(RAIZ, p.archivo), 'utf8');
      return !fuente.includes(p.linea);
    });
    assert.deepStrictEqual(sobran.map(p => `${p.archivo}: ${p.linea}`), []);
  });
});
