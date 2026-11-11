// Tests de quién deja rastro de "entró a la plataforma ese día" (S1 del panel de la Secretaria).
// Correr con: npm run test:unit
//
// Ver D3, RN-14 y CA-20 de specs/secretaria-docentes-del-dia.spec.md. La escritura en sí vive en
// el camino caliente de middleware/auth.js; acá se prueba la decisión, que es pura.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { debeRegistrarIngreso } = require('../../services/ingresoDiario');

describe('debeRegistrarIngreso', () => {
  test('el personal deja rastro', () => {
    for (const role of ['teacher', 'jefe', 'directivo', 'preceptor', 'soe', 'secretaria', 'admin', 'superadmin']) {
      assert.strictEqual(debeRegistrarIngreso({ role, active: true, suplantando: false }), true, role);
    }
  });

  test('CA-20 · los alumnos NO: no hacen falta y son menores', () => {
    assert.strictEqual(debeRegistrarIngreso({ role: 'student', active: true, suplantando: false }), false);
  });

  test('una cuenta deshabilitada no', () => {
    assert.strictEqual(debeRegistrarIngreso({ role: 'teacher', active: false, suplantando: false }), false);
  });

  test('⭐ RN-14 · un admin suplantando al docente no le inventa un ingreso', () => {
    assert.strictEqual(debeRegistrarIngreso({ role: 'teacher', active: true, suplantando: true }), false);
  });

  test('sin rol, no', () => {
    assert.strictEqual(debeRegistrarIngreso({}), false);
  });
});
