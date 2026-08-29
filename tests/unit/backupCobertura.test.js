// Cobertura del backup: ¿está TODO lo que hay que respaldar?
// Correr con: npm run test:unit
//
// Por qué existe este archivo. La lista de colecciones del backup
// (COLLECTIONS en routes/backup.js) está escrita a mano, y el backup NO es un mongodump:
// lo que no está en esa lista no se guarda. El 2026-08-29 se comparó la lista contra los
// modelos de models/ y el resultado fue 14 de 29 — entre las 15 ausentes estaban los
// LEGAJOS DEL SOE, las reservas de recursos, las secciones y la mensajería.
//
// Lo peor del modo de falla es que es SILENCIOSO en las dos puntas: el backup se genera sin
// error, pesa lo que tiene que pesar y se descarga bien; y el restore tampoco se queja,
// porque su bucle recorre solo esta misma lista, así que una colección ausente ni se toca.
// La ausencia se descubre el día que se perdió el servidor y hay que reconstruir — que es
// exactamente el día en que no se puede hacer nada al respecto.
//
// La causa de fondo es estructural y va a volver: cada feature nueva trae su modelo, y
// agregarlo a esta lista es un paso que nada obliga a dar. Por eso el test no verifica una
// lista fija de nombres —eso envejece en el próximo commit— sino la REGLA: todo modelo que
// exista en models/ tiene que estar respaldado o excluido a propósito. Un modelo nuevo
// rompe este test hasta que alguien decida cuál de las dos cosas es.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');

const { COLLECTIONS, EXCLUIDAS_DEL_BACKUP } = require('../../routes/backup');

const MODELS_DIR = path.join(__dirname, '..', '..', 'models');

// El nombre real de la colección lo decide Mongoose (pluraliza distinto a como uno espera:
// Activity → activities, RecursoAutorizacion → recursoautorizacions). Preguntárselo al
// modelo en vez de adivinarlo evita falsos positivos: pluralizando a mano, `activities`
// aparecía como faltante estando presente.
function coleccionesDeLosModelos() {
  return fs.readdirSync(MODELS_DIR)
    .filter(f => f.endsWith('.js'))
    .map((f) => {
      const M = require(path.join(MODELS_DIR, f));
      return M && M.collection ? { archivo: f, coleccion: M.collection.name } : null;
    })
    .filter(Boolean);
}

test('todo modelo está respaldado o excluido a propósito', () => {
  const enBackup = new Set(COLLECTIONS.map(c => c.name));
  const excluidas = new Set(Object.keys(EXCLUIDAS_DEL_BACKUP));

  const huerfanas = coleccionesDeLosModelos()
    .filter(({ coleccion }) => !enBackup.has(coleccion) && !excluidas.has(coleccion));

  assert.deepStrictEqual(
    huerfanas, [],
    'Hay modelos que el backup no guarda y que tampoco están excluidos a propósito:\n' +
    huerfanas.map(h => `  · ${h.coleccion} (models/${h.archivo})`).join('\n') +
    '\n\nAgregalos a COLLECTIONS en routes/backup.js, o a EXCLUIDAS_DEL_BACKUP con el motivo. ' +
    'Si van a COLLECTIONS, tienen que ir con optional:true — los backups ya generados no las ' +
    'traen y sin ese flag el preview de un backup viejo se niega a restaurar.',
  );
});

test('los legajos del SOE están en el backup', () => {
  // Caso puntual del bug que originó este archivo. Redundante con el test de arriba a
  // propósito: si alguien alguna vez mueve `soecases` a las excluidas, el test general
  // seguiría pasando y este no. Los legajos son lo más irreemplazable del sistema —
  // ver specs/soe-orientacion.spec.md.
  const nombres = COLLECTIONS.map(c => c.name);
  assert.ok(nombres.includes('soecases'),    'soecases (legajos del SOE) no está en el backup');
  assert.ok(nombres.includes('soerequests'), 'soerequests (derivaciones al SOE) no está en el backup');
});

test('las reservas viajan con su contador atómico', () => {
  // slotocupacions es el contador que evita la doble reserva de un mismo turno. Restaurar
  // `reservas` sin él deja el módulo creyendo que hay lugar donde no lo hay, o netbooks
  // ocupadas que nadie tiene. Ver specs/recursos-reservas.spec.md.
  const nombres = COLLECTIONS.map(c => c.name);
  if (nombres.includes('reservas')) {
    assert.ok(nombres.includes('slotocupacions'),
      'reservas está en el backup pero slotocupacions no: los contadores quedarían desfasados');
  }
});

test('ninguna colección está listada dos veces ni excluida y respaldada a la vez', () => {
  const nombres = COLLECTIONS.map(c => c.name);
  const repetidas = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  assert.deepStrictEqual(repetidas, [], `Colecciones duplicadas en COLLECTIONS: ${repetidas}`);

  const contradictorias = nombres.filter(n => n in EXCLUIDAS_DEL_BACKUP);
  assert.deepStrictEqual(contradictorias, [],
    `Están en COLLECTIONS y en EXCLUIDAS_DEL_BACKUP a la vez: ${contradictorias}`);
});

test('cada exclusión dice por qué', () => {
  // Una exclusión sin motivo es indistinguible de un olvido prolijo.
  for (const [nombre, motivo] of Object.entries(EXCLUIDAS_DEL_BACKUP)) {
    assert.ok(typeof motivo === 'string' && motivo.length > 15,
      `La exclusión de ${nombre} no explica el motivo`);
  }
});
