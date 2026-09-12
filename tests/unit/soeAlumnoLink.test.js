// El alumno de un legajo puede no existir, y ninguna pantalla del SOE puede caerse por eso.
// Correr con: npm run test:unit
//
// EL BUG QUE FIJA (2026-09-12): `views/soe/index.ejs` pintaba `l.student._id` a pelo. Cuando
// la cuenta del alumno se elimina, `populate('student')` devuelve null, eso tira
// "Cannot read properties of null" y la ruta lo convierte en un 500 — o sea que se caía
// **el panel entero del gabinete**, no la fila del legajo huérfano. Había cuatro pantallas
// con el mismo patrón y dos que sí lo guardaban, lo que muestra que la regla existía y se
// perdía al copiar y pegar.
//
// El legajo sobrevive al alumno A PROPÓSITO (ver models/SoeCase.js: ni un adjunto dado de
// baja pierde su registro), así que "no puede pasar" no es una respuesta: pasa, y la vista
// tiene que saber pintar el hueco.
//
// Por qué acá y no solo en el smoke: el smoke necesita Mongo, credenciales y un legajo de
// prueba con su alumno borrado a mano. Esto es una plantilla y dos objetos.
//
// ⭐ El segundo describe es la mitad importante: no prueba el arreglo, prueba **la regla**.
// Un test que solo verificara las 6 líneas de hoy no dice nada de la pantalla que alguien
// agregue mañana; este recorre las vistas del SOE y falla si aparece un `student._id` sin
// guarda, sea en un archivo que hoy existe o en uno que todavía no.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const path = require('path');
const ejs  = require('ejs');

const RAIZ     = path.join(__dirname, '..', '..');
const VISTAS   = path.join(RAIZ, 'views');
const PARTIAL  = 'partials/soe-alumno-link';

// Renderiza el partial como lo hace una vista real: con include, para que un error en la
// ruta relativa o en el nombre del archivo también rompa el test.
function pintar(datos) {
  return ejs.render(
    `<%- include('${PARTIAL}', ${JSON.stringify(datos)}) %>`,
    {},
    { filename: path.join(VISTAS, 'x.ejs'), views: [VISTAS] },
  ).trim();
}

describe('partials/soe-alumno-link — el alumno de un legajo', () => {
  test('con el alumno presente, enlaza a su legajo', () => {
    const html = pintar({ student: { _id: 'a1', name: 'PEREZ, Juan' } });
    assert.match(html, /href="\/soe\/legajo\/a1"/, 'debería enlazar a la ficha del legajo');
    assert.match(html, /PEREZ, Juan/, 'debería mostrar el nombre');
  });

  test('el hash es opcional y apunta a la pestaña pedida', () => {
    // Tres de los cuatro llamadores mandan hash ('citaciones', 'derivaciones', 'linea') y uno
    // no manda ninguno: si `locals.hash` se leyera mal, el que no lo manda tiraría
    // ReferenceError y volveríamos al 500 por otra puerta.
    assert.match(pintar({ student: { _id: 'a1', name: 'X' }, hash: 'citaciones' }),
      /href="\/soe\/legajo\/a1#citaciones"/);
    assert.match(pintar({ student: { _id: 'a1', name: 'X' } }),
      /href="\/soe\/legajo\/a1"(?!#)/, 'sin hash no debería quedar un # colgado');
  });

  test('con el alumno eliminado NO se cae, y lo dice', () => {
    // Es el caso exacto del bug: esto tiraba TypeError y se llevaba la pantalla entera.
    const html = pintar({ student: null });
    assert.match(html, /Alumno dado de baja/i,
      'tiene que mostrar el hueco: el gabinete necesita ver que ese legajo quedó sin dueño');
  });

  test('con el alumno eliminado no deja un enlace roto', () => {
    // Un href a /soe/legajo/null o /soe/legajo/false sería peor que no tener enlace: invita a
    // hacer clic para llegar a un error.
    const html = pintar({ student: null });
    assert.doesNotMatch(html, /<a\b/, 'sin alumno no hay ficha a la que ir: no va enlace');
  });
});

describe('ninguna vista del SOE desreferencia student sin guarda', () => {
  // El partial es la ÚNICA excepción, y con motivo escrito: ahí la guarda es estructural
  // (`<% if (student) { %>`) en vez de inline, y es justamente el archivo que este test
  // protege. Cualquier otra excepción futura tiene que justificarse acá, igual que en
  // tests/unit/backupCarpetas.test.js.
  const EXCEPCIONES = {
    'partials/soe-alumno-link.ejs': 'la guarda es el `if (student)` que envuelve todo el archivo',
  };

  // Un tag EJS está guardado si en la MISMA expresión pregunta por el alumno antes de usarlo:
  // `student && student._id` o `student ? student.name : ...`.
  const GUARDADO = /student\s*(?:&&|\?)/;
  const RIESGOSO = /student\.(?:_id|name)\b/;

  const vistas = [
    ...fs.readdirSync(path.join(VISTAS, 'soe')).map(f => 'soe/' + f),
    ...fs.readdirSync(path.join(VISTAS, 'partials'))
      .filter(f => f.startsWith('soe-')).map(f => 'partials/' + f),
  ].filter(f => f.endsWith('.ejs'));

  test('hay vistas del SOE para revisar', () => {
    // Si un rename dejara la lista vacía, los tests de abajo pasarían sin mirar nada.
    assert.ok(vistas.length >= 6, `esperaba al menos 6 vistas, encontré ${vistas.length}`);
  });

  for (const vista of vistas) {
    test(vista, () => {
      const src = fs.readFileSync(path.join(VISTAS, vista), 'utf8');
      const tags = src.match(/<%[^]*?%>/g) || [];
      const malos = tags
        .filter(t => RIESGOSO.test(t) && !GUARDADO.test(t))
        .map(t => t.replace(/\s+/g, ' ').trim());

      if (EXCEPCIONES[vista]) {
        assert.ok(malos.length > 0,
          `${vista} está en EXCEPCIONES pero ya no lo necesita — sacala de la lista`);
        return;
      }

      assert.deepStrictEqual(malos, [],
        `${vista} lee student._id o student.name sin preguntar si existe. `
        + `El alumno de un legajo puede haber sido eliminado y eso tira un 500 en toda la `
        + `pantalla: usá <%- include('../partials/soe-alumno-link', { student: ... }) %>.`);
    });
  }
});
