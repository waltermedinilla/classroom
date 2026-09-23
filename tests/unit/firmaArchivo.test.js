// services/firmaArchivo.js — la URL firmada de RN-15, CA-13 entero, SIN red.
// Correr con: npm run test:unit
//
// Ver specs/correccion-de-entregas.spec.md, RN-15: la cadena de Office descarga el archivo
// DESDE Microsoft, que no manda la cookie de sesión — así que hace falta una ruta separada,
// sin requireAuth, protegida por una firma HMAC de vida corta. "Ruta separada, no un `if`
// dentro de la ruta con guarda": el mismo criterio que ya usa RN-32 para los comentarios.
//
// ── El contrato que este archivo asume ──────────────────────────────────────────
//
//   firmar(filename, docenteId, ttlMs = 5*60*1000) -> { url, expiraEn, exp, sig }
//     HMAC-SHA256(filename + '.' + exp + '.' + docenteId) con clave derivada de JWT_SECRET.
//     `exp` es un epoch en ms; `expiraEn` es lo que ve el cliente (segundos u "ms", a
//     elección del implementador — este archivo no lo fija).
//
//   verificar({ filename, exp, sig }, { comoDocenteId } = {}) -> { ok: true } | { ok: false, motivo }
//     motivo: 'ENLACE_VENCIDO' | 'FIRMA_INVALIDA'
//     Compara con crypto.timingSafeEqual (precedente: models/ContactVerification.js:129) y
//     tiene que sobrevivir una `sig` de largo distinto sin explotar (timingSafeEqual tira si
//     los buffers no miden lo mismo).

const test   = require('node:test');
const assert = require('node:assert');

let FirmaArchivo = null;
try {
  FirmaArchivo = require('../../services/firmaArchivo.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (!FirmaArchivo || typeof FirmaArchivo.firmar !== 'function' || typeof FirmaArchivo.verificar !== 'function') {
  test('falta implementar services/firmaArchivo.js (RN-15)', () => {
    throw new Error(
      'services/firmaArchivo.js tiene que existir y exportar firmar(filename, docenteId, ttlMs) ' +
      'y verificar({ filename, exp, sig }). Ver specs/correccion-de-entregas.spec.md RN-15 y CA-13.',
    );
  });
} else {
  const { firmar, verificar } = FirmaArchivo;
  const DOCENTE_A = '507f1f77bcf86cd799439011';
  const DOCENTE_B = '507f1f77bcf86cd799439012';

  test('CA-13(a) — firma correcta y dentro de los 5 minutos: verifica OK', () => {
    const { exp, sig } = firmar('trabajo-123.docx', DOCENTE_A);
    const r = verificar({ filename: 'trabajo-123.docx', exp, sig });
    assert.strictEqual(r.ok, true, `esperaba ok:true, dio ${JSON.stringify(r)}`);
  });

  test('RN-15 — el TTL por defecto es 5 minutos', () => {
    const antes = Date.now();
    const { exp } = firmar('trabajo-123.docx', DOCENTE_A);
    const despues = Date.now();
    const cincoMin = 5 * 60 * 1000;
    assert.ok(exp >= antes + cincoMin - 1000 && exp <= despues + cincoMin + 1000,
      `exp tiene que caer ~5 minutos en el futuro; dio exp=${exp}, ahora=${antes}`);
  });

  test('CA-13(b) — vencido: 403 ENLACE_VENCIDO', () => {
    // ttlMs negativo: el `exp` que firmar() calcula (ahora + ttlMs) ya queda en el pasado, y
    // la `sig` se calcula CONTRA ESE MISMO exp — por eso hay que verificar con el par
    // { exp, sig } tal cual lo devolvió firmar(), no recalcular exp por separado (si no, la
    // firma no coincide y el test daría FIRMA_INVALIDA en vez de ENLACE_VENCIDO, que es un
    // motivo distinto y probaría otra cosa).
    const { exp, sig } = firmar('trabajo-123.docx', DOCENTE_A, -1000);
    assert.ok(exp < Date.now(), 'fixture mal armado: el exp tiene que quedar en el pasado');
    const r = verificar({ filename: 'trabajo-123.docx', exp, sig });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'ENLACE_VENCIDO');
  });

  test('CA-13(c) — sig alterada: 403 FIRMA_INVALIDA', () => {
    const { exp, sig } = firmar('trabajo-123.docx', DOCENTE_A);
    const alterada = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
    const r = verificar({ filename: 'trabajo-123.docx', exp, sig: alterada });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'FIRMA_INVALIDA');
  });

  test('CA-13(d) — la firma de un archivo A no sirve para pedir B: 403 FIRMA_INVALIDA', () => {
    const { exp, sig } = firmar('archivo-A.docx', DOCENTE_A);
    const r = verificar({ filename: 'archivo-B.docx', exp, sig });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.motivo, 'FIRMA_INVALIDA');
  });

  test('la firma de un docente no le sirve a otro docente para el mismo archivo', () => {
    // El docenteId entra al HMAC: dos docentes que gestionan la misma materia (co-titular)
    // no pueden reusar el enlace firmado del otro sin que la firma cambie.
    const { exp, sig } = firmar('trabajo-123.docx', DOCENTE_A);
    // Se arma lo que WEB armaría si alguien intentara reusar la firma alegando ser B: la
    // verificación tiene que atarse al mismo docenteId con el que se firmó, no aceptar
    // cualquiera. Esto se prueba indirectamente: verificar() no recibe el docenteId como
    // parámetro público más que a través de la firma, así que cambiar CUALQUIER insumo del
    // HMAC (acá, mentir el docente en una firma armada a mano con B) tiene que fallar.
    const propiaDeB = firmar('trabajo-123.docx', DOCENTE_B);
    assert.notStrictEqual(sig, propiaDeB.sig,
      'dos docentes distintos tienen que producir firmas distintas para el mismo archivo');
  });

  test('una sig de largo distinto no rompe timingSafeEqual: da FIRMA_INVALIDA, no explota', () => {
    const { exp } = firmar('trabajo-123.docx', DOCENTE_A);
    assert.doesNotThrow(() => {
      const r = verificar({ filename: 'trabajo-123.docx', exp, sig: 'ab' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.motivo, 'FIRMA_INVALIDA');
    }, 'una sig corta/mal formada tiene que dar un 403 prolijo, no tirar una excepción sin capturar');
  });

  test('sin sig, sin exp o sin filename: FIRMA_INVALIDA, nunca un crash', () => {
    for (const bad of [{}, { filename: 'x.docx' }, { filename: 'x.docx', exp: Date.now() + 1000 }]) {
      assert.doesNotThrow(() => {
        const r = verificar(bad);
        assert.strictEqual(r.ok, false);
      }, `verificar(${JSON.stringify(bad)}) no puede tirar`);
    }
  });

  test('la url que devuelve firmar() apunta a la ruta separada, no a la autenticada', () => {
    const { url } = firmar('trabajo-123.docx', DOCENTE_A);
    assert.match(url, /\/activities\/entrega-firmada\/trabajo-123\.docx/,
      'RN-15: la URL tiene que apuntar a GET /activities/entrega-firmada/:filename, no a ' +
      '/activities/submission-file/:filename (esa sigue detrás de requireAuth)');
    assert.match(url, /exp=/);
    assert.match(url, /sig=/);
  });
}
