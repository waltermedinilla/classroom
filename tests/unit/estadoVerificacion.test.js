// Tests de la regla de estado de verificación de contacto (public/js/estadoVerificacion.js).
//
// El chip que sale de acá se dibuja en 9 pantallas (perfil, admin, superadmin, directivo,
// preceptor). El valor de tener la regla en un solo archivo es justamente que estos tests la
// fijan una vez para las nueve.
//
// Criterios de aceptación en specs/verificacion-de-contacto.spec.md (sección "Estado").

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const {
  VERIFICADO, PENDIENTE, SIN_DATO,
  estadoContacto, estaVerificado, filtroSinVerificar, filtroVerificado,
} = require('../../public/js/estadoVerificacion');

const AYER = new Date('2026-08-30T10:00:00Z');

describe('estadoContacto — correo', () => {
  test('sin correo cargado → sin-dato', () => {
    const r = estadoContacto({ email: null }, 'email');
    assert.strictEqual(r.estado, SIN_DATO);
    assert.strictEqual(r.tono, 'neutro');
  });

  test('con correo y sin fecha → pendiente', () => {
    const r = estadoContacto({ email: 'a@b.com', emailVerifiedAt: null }, 'email');
    assert.strictEqual(r.estado, PENDIENTE);
    assert.strictEqual(r.texto, 'Sin verificar');
    assert.strictEqual(r.tono, 'neutro');
  });

  test('con fecha → verificado', () => {
    const r = estadoContacto({ email: 'a@b.com', emailVerifiedAt: AYER, emailVerifiedVia: 'enlace' }, 'email');
    assert.strictEqual(r.estado, VERIFICADO);
    assert.strictEqual(r.texto, 'Verificado');
    assert.strictEqual(r.tono, 'ok');
    assert.deepStrictEqual(r.desde, AYER);
  });

  test('un documento HISTÓRICO (sin ninguno de los campos nuevos) se lee como pendiente', () => {
    // Lo que hay hoy en producción: 600 usuarios sin emailVerifiedAt ni emailVerifiedVia.
    // Ninguno tiene que romper la vista ni aparecer como verificado.
    const r = estadoContacto({ email: 'vieja@escuela.edu.ar' }, 'email');
    assert.strictEqual(r.estado, PENDIENTE);
  });

  test('la fecha puede venir como string (JSON de una API) y se normaliza a Date', () => {
    const r = estadoContacto({ email: 'a@b.com', emailVerifiedAt: '2026-08-30T10:00:00.000Z' }, 'email');
    assert.ok(r.desde instanceof Date);
    assert.strictEqual(r.desde.toISOString(), AYER.toISOString());
  });
});

describe('estadoContacto — celular', () => {
  test('lee phone / phoneVerifiedAt, no los del correo', () => {
    const persona = { email: 'a@b.com', emailVerifiedAt: AYER, phone: '261 555 1234' };
    assert.strictEqual(estadoContacto(persona, 'email').estado,   VERIFICADO);
    assert.strictEqual(estadoContacto(persona, 'celular').estado, PENDIENTE);
  });

  test('sin celular cargado → sin-dato, y el texto lo dice en castellano', () => {
    const r = estadoContacto({ phone: null }, 'celular');
    assert.strictEqual(r.estado, SIN_DATO);
    assert.strictEqual(r.texto, 'Sin celular');
  });
});

describe('la vía cambia el TEXTO, que es lo que hace honesta a la verificación asistida', () => {
  test('staff → "Verificado por la escuela", no "Verificado" a secas', () => {
    const r = estadoContacto({ phone: '2615551234', phoneVerifiedAt: AYER, phoneVerifiedVia: 'staff' }, 'celular');
    assert.strictEqual(r.estado, VERIFICADO);
    assert.strictEqual(r.texto, 'Verificado por la escuela');
  });

  test('codigo y enlace → "Verificado"', () => {
    const porCodigo = estadoContacto({ phone: '2615551234', phoneVerifiedAt: AYER, phoneVerifiedVia: 'codigo' }, 'celular');
    const porEnlace = estadoContacto({ email: 'a@b.com',    emailVerifiedAt: AYER, emailVerifiedVia: 'enlace' }, 'email');
    assert.strictEqual(porCodigo.texto, 'Verificado');
    assert.strictEqual(porEnlace.texto, 'Verificado');
  });

  test('una vía desconocida no rompe la pantalla', () => {
    const r = estadoContacto({ email: 'a@b.com', emailVerifiedAt: AYER, emailVerifiedVia: 'inventada' }, 'email');
    assert.strictEqual(r.texto, 'Verificado');
  });
});

describe('el chip NO decide colores', () => {
  test('nunca devuelve un hex: el color lo pone la vista con variables del tema', () => {
    const casos = [
      estadoContacto({ email: 'a@b.com', emailVerifiedAt: AYER }, 'email'),
      estadoContacto({ email: 'a@b.com' }, 'email'),
      estadoContacto({ email: null }, 'email'),
    ];
    for (const r of casos) {
      assert.ok(['ok', 'neutro'].includes(r.tono), 'tono tiene que ser semántico');
      const serializado = JSON.stringify(r);
      assert.ok(!/#[0-9a-fA-F]{3,6}/.test(serializado),
        'un hex acá termina en un style= inline, que le gana a la variante oscura');
    }
  });
});

describe('filtros de Mongo', () => {
  test('filtroSinVerificar junta al que no cargó el dato y al que no lo confirmó', () => {
    assert.deepStrictEqual(filtroSinVerificar('email'),   { emailVerifiedAt: null });
    assert.deepStrictEqual(filtroSinVerificar('celular'), { phoneVerifiedAt: null });
  });

  test('filtroVerificado es el inverso', () => {
    assert.deepStrictEqual(filtroVerificado('email'), { emailVerifiedAt: { $ne: null } });
  });
});

describe('canal desconocido', () => {
  test('revienta en vez de contestar cualquier cosa', () => {
    assert.throws(() => estadoContacto({}, 'telegram'), /canal desconocido/);
    assert.throws(() => filtroSinVerificar('fax'),      /canal desconocido/);
  });
});

describe('es el MISMO archivo en el servidor y en el navegador', () => {
  test('cargado como <script> deja window.EstadoVerificacion con la misma respuesta', () => {
    // Sin este test, el archivo podría funcionar con require() y romperse en el navegador
    // (o al revés) sin que nadie se entere hasta ver el chip mal en una pantalla.
    const ruta   = path.join(__dirname, '../../public/js/estadoVerificacion.js');
    const codigo = fs.readFileSync(ruta, 'utf8');
    const window = {};
    vm.createContext(window);
    vm.runInContext(codigo, window);

    assert.ok(window.EstadoVerificacion, 'tiene que colgarse de window cuando no hay module');
    const persona = { email: 'a@b.com', emailVerifiedAt: AYER, emailVerifiedVia: 'staff' };
    assert.deepStrictEqual(
      JSON.stringify(window.EstadoVerificacion.estadoContacto(persona, 'email')),
      JSON.stringify(estadoContacto(persona, 'email')),
    );
  });
});
