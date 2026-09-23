// services/versionesEntrega.js — el tope de 5 versiones por entrega (RN-34), función pura.
// Correr con: npm run test:unit
//
// Ver specs/correccion-de-entregas.spec.md, RN-33/RN-34. El `unlink` de hoy pasa a ser un
// `rename` a `_versiones/`: cada reenvío EMPUJA la versión que quedó afuera. Sin tope, un
// alumno indeciso que reenvía 40 veces hace crecer `archivos/entregas` —el 99,8% del peso del
// backup— sin límite. Con tope, la más vieja se cae y sus archivos se borran de verdad.
//
// ── El contrato que este archivo asume ──────────────────────────────────────────
//
//   recortarVersiones(versionesExistentes, nuevaVersion, tope = 5) -> { versiones, descartada }
//     `nuevaVersion` es la que ACABA de quedar afuera (lo que era "la actual" antes del
//     reenvío) y se antepone al array: versiones = [nuevaVersion, ...versionesExistentes],
//     recortado a `tope` elementos.
//     `descartada`: la versión más vieja que se cae por superar el tope, o `null` si no hizo
//     falta cortar nada. El llamador es quien borra del disco los archivos de `descartada`
//     (esta función no toca el filesystem: es pura).
//     No muta `versionesExistentes`.

const test   = require('node:test');
const assert = require('node:assert');

let VersionesEntrega = null;
try {
  VersionesEntrega = require('../../services/versionesEntrega.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (!VersionesEntrega || typeof VersionesEntrega.recortarVersiones !== 'function') {
  test('falta implementar services/versionesEntrega.js (RN-34)', () => {
    throw new Error(
      'services/versionesEntrega.js tiene que existir y exportar recortarVersiones(' +
      'versionesExistentes, nuevaVersion, tope). Ver specs/correccion-de-entregas.spec.md RN-33/RN-34.',
    );
  });
} else {
  const { recortarVersiones } = VersionesEntrega;

  const version = (at, files = ['a.pdf']) => ({ at, text: '', files: files.map(f => ({ filename: f })) });

  test('con menos versiones que el tope, no se descarta nada', () => {
    const { versiones, descartada } = recortarVersiones([version('2026-09-01')], version('2026-09-05'), 5);
    assert.strictEqual(versiones.length, 2);
    assert.strictEqual(descartada, null);
    assert.strictEqual(versiones[0].at, '2026-09-05', 'la recién movida va primero (la más reciente)');
  });

  test('CA-49 — reenviar una vez: la entrega tiene la nueva, versions[0] tiene la vieja', () => {
    const { versiones } = recortarVersiones([], version('2026-09-01', ['original.pdf']), 5);
    assert.strictEqual(versiones.length, 1);
    assert.strictEqual(versiones[0].files[0].filename, 'original.pdf');
  });

  test('CA-50 — al sexto reenvío hay 5 versiones y la primera ya no está', () => {
    let versiones = [];
    let descartadaFinal = null;
    for (let i = 1; i <= 6; i++) {
      const r = recortarVersiones(versiones, version(`v${i}`, [`archivo${i}.pdf`]), 5);
      versiones = r.versiones;
      if (r.descartada) descartadaFinal = r.descartada;
    }
    assert.strictEqual(versiones.length, 5, 'el tope de 5 se respeta después del sexto reenvío');
    assert.ok(!versiones.some(v => v.at === 'v1'),
      'la primera versión (v1) tiene que haber salido: es la más vieja');
    assert.ok(descartadaFinal, 'tiene que haberse descartado exactamente una versión en algún punto');
    assert.strictEqual(descartadaFinal.at, 'v1', 'la descartada es la más vieja, no cualquiera');
  });

  test('no muta el array de versiones existentes', () => {
    const existentes = [version('2026-09-01')];
    const copia = existentes.map(v => ({ ...v }));
    recortarVersiones(existentes, version('2026-09-05'), 5);
    assert.deepStrictEqual(existentes, copia);
  });

  test('el tope es un parámetro, no una constante escondida: con tope 1 se descarta enseguida', () => {
    const { versiones, descartada } = recortarVersiones([version('vieja')], version('nueva'), 1);
    assert.strictEqual(versiones.length, 1);
    assert.strictEqual(versiones[0].at, 'nueva');
    assert.ok(descartada, 'con tope 1, la que ya estaba tiene que caer');
    assert.strictEqual(descartada.at, 'vieja');
  });

  test('con tope 0 no se guarda ninguna versión (caso límite defensivo)', () => {
    const { versiones } = recortarVersiones([], version('nueva'), 0);
    assert.strictEqual(versiones.length, 0);
  });
}
