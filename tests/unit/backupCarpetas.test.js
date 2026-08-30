// Cobertura del backup, segunda mitad: ¿está TODA carpeta de archivos que hay que respaldar?
// Correr con: npm run test:unit
//
// El hermano de tests/unit/backupCobertura.test.js, que hace lo mismo con las colecciones de
// Mongo. Existe porque el 2026-08-30 pasó de nuevo lo que ese test ya había cazado una vez,
// pero del lado de los archivos: la feature de material del gabinete estrenó
// `archivos/soe/` —certificados, informes, recetas de chicos— y el backup siguió copiando
// las dos carpetas de siempre. Nadie se enteró: el paquete se genera igual, pesa lo que
// tiene que pesar y no da ningún error.
//
// El modo de falla es el mismo de siempre y va a volver, porque cada feature que sube
// archivos estrena su carpeta y agregarla acá es un paso que nada obliga a dar. Por eso el
// test no fija una lista de nombres —eso envejece en el próximo commit— sino la REGLA: toda
// carpeta que la app administre tiene que estar respaldada o excluida a propósito.
//
// El inventario sale de services/diskStats.js (RUTAS), que es la lista que ya usa el panel
// de disco del superadmin. Tener una sola fuente para las dos cosas es parte del punto: una
// carpeta nueva que no aparezca en NINGUNA de las dos pantallas ya no existe para nadie.

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('path');

const { CARPETAS, CARPETAS_EXCLUIDAS, planDeCarpetas } = require('../../routes/backup');
const { RUTAS } = require('../../services/diskStats');

// routes/backup.js deja overridear sus rutas por env var (lo usa backupTarball.test.js para
// correr contra fixtures de unos KB). Si alguna está seteada, las rutas de CARPETAS no son
// las del proyecto y compararlas contra las de diskStats no diría nada.
const OVERRIDES = ['BACKUP_ARCHIVOS_BASE', 'BACKUP_ENTREGAS_BASE', 'BACKUP_SOE_BASE']
  .filter(v => process.env[v]);

const norm = (p) => path.resolve(p).toLowerCase();

test('toda carpeta que la app escribe está respaldada o excluida a propósito', {
  skip: OVERRIDES.length ? `hay rutas overrideadas por env (${OVERRIDES.join(', ')})` : false,
}, () => {
  const respaldadas = new Set(CARPETAS.map(c => norm(c.dir)));
  const excluidas   = new Set(Object.keys(CARPETAS_EXCLUIDAS).map(norm));

  const huerfanas = RUTAS.filter(({ dir }) => !respaldadas.has(norm(dir)) && !excluidas.has(norm(dir)));

  assert.deepStrictEqual(
    huerfanas.map(h => h.id), [],
    'Hay carpetas de archivos que el backup no guarda y que tampoco están excluidas a propósito:\n' +
    huerfanas.map(h => `  · ${h.id} — ${h.label} (${h.dir})`).join('\n') +
    '\n\nAgregalas a CARPETAS en routes/backup.js, o a CARPETAS_EXCLUIDAS con el motivo. ' +
    'Si van a CARPETAS, tienen que ir con optional:true — los backups ya generados no las ' +
    'traen, y el restore usa esa marca para dejarlas como están en vez de vaciarlas.',
  );
});

// El espejo del anterior: una carpeta que el backup dice respaldar y que la app no escribe
// por ningún lado es un árbol que ya no existe (una feature que se sacó, un rename a medias).
// Empaquetarla no rompe nada, pero el restore SÍ la reemplaza, así que conviene enterarse.
test('el backup no respalda carpetas que ya no existen en el inventario de la app', {
  skip: OVERRIDES.length ? `hay rutas overrideadas por env (${OVERRIDES.join(', ')})` : false,
}, () => {
  const inventario = new Set(RUTAS.map(r => norm(r.dir)));
  const sobrantes  = CARPETAS.filter(c => !inventario.has(norm(c.dir)));

  assert.deepStrictEqual(
    sobrantes.map(c => c.id), [],
    'El backup respalda carpetas que no están en services/diskStats.js (RUTAS):\n' +
    sobrantes.map(c => `  · ${c.id} (${c.dir})`).join('\n') +
    '\n\nO la carpeta ya no se usa y sale de CARPETAS, o falta declararla en RUTAS para que ' +
    'el panel de disco del superadmin también la cuente.',
  );
});

test('ninguna carpeta está respaldada y excluida a la vez', () => {
  const excluidas = new Set(Object.keys(CARPETAS_EXCLUIDAS).map(norm));
  const ambas = CARPETAS.filter(c => excluidas.has(norm(c.dir)));
  assert.deepStrictEqual(ambas.map(c => c.id), [],
    'Una carpeta no puede estar en CARPETAS y en CARPETAS_EXCLUIDAS al mismo tiempo');
});

// ─────────────────────────────────────────────────────────────────────────────
// Qué pasa al restaurar un backup que no trae todas las carpetas
// ─────────────────────────────────────────────────────────────────────────────
//
// Es la parte cara de equivocarse: restaurar un backup de julio no puede llevarse puestos
// los certificados que el gabinete cargó en agosto. Al revés que las colecciones ausentes
// —que se vacían a propósito—, una carpeta opcional que el backup no trae se deja como está.

const trae = (...ids) => (id) => ids.includes(id);
const accionDe = (plan, id) => plan.find(c => c.id === id).accion;

test('un backup viejo, sin files/soe, NO borra el material del gabinete', () => {
  const plan = planDeCarpetas(trae('archivos', 'entregas'));

  assert.equal(accionDe(plan, 'soe'), 'intacta',
    'restaurar un backup anterior a la feature borraría certificados que no están en ninguna otra copia');
  assert.equal(accionDe(plan, 'archivos'), 'reemplazar');
  assert.equal(accionDe(plan, 'entregas'), 'reemplazar');
});

test('un backup que sí trae la carpeta la reemplaza, aunque venga vacía', () => {
  // "Vacía pero presente" es una fecha en la que no había papeles cargados, y a esa fecha
  // hay que poder volver. Lo que no se puede es confundirla con "el backup no la trae".
  const plan = planDeCarpetas(trae('archivos', 'entregas', 'soe'));
  for (const { id, accion } of plan) {
    assert.equal(accion, 'reemplazar', `${id} tendría que reemplazarse`);
  }
});

test('una carpeta NO opcional ausente se reemplaza igual (queda vacía), como antes', () => {
  // Comportamiento viejo, intacto: si a un backup le falta files/entregas, entregas se vacía.
  // Solo las carpetas nacidas después del formato 1.0 se protegen.
  const plan = planDeCarpetas(() => false);
  assert.equal(accionDe(plan, 'archivos'), 'reemplazar');
  assert.equal(accionDe(plan, 'entregas'), 'reemplazar');
  assert.equal(accionDe(plan, 'soe'), 'intacta');
});

test('cada exclusión dice por qué', () => {
  for (const [dir, motivo] of Object.entries(CARPETAS_EXCLUIDAS)) {
    assert.ok(typeof motivo === 'string' && motivo.length > 15,
      `La exclusión de ${dir} no explica el motivo. Sin eso, el próximo que lea la lista no ` +
      'puede saber si fue una decisión o un olvido.');
  }
});

// El id es el nombre de la carpeta DENTRO del .tar.gz (`files/<id>/`), y el restore busca
// por ahí. Cambiarlo convierte todos los backups ya generados en backups que, al restaurar,
// dejan esa carpeta sin reemplazar y en silencio.
test('los ids de las carpetas son estables y únicos', () => {
  const ids = CARPETAS.map(c => c.id);
  assert.deepStrictEqual([...new Set(ids)], ids, 'hay ids repetidos en CARPETAS');

  for (const id of ['archivos', 'entregas']) {
    assert.ok(ids.includes(id),
      `falta la carpeta '${id}': está en el formato 1.0 y todos los backups existentes la traen`);
  }
  for (const { id, optional } of CARPETAS) {
    if (id === 'archivos' || id === 'entregas') {
      assert.ok(!optional, `'${id}' no puede ser optional: todos los backups la traen desde el 1.0`);
    } else {
      assert.ok(optional, `'${id}' nació después del formato 1.0, tiene que ir con optional:true`);
    }
  }
});
