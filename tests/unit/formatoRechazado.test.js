// § K de specs/correccion-de-entregas.spec.md — el log de formatos rechazados.
// Correr con: npm run test:unit
//
// "El objetivo no es auditar: es poder contestar dentro de dos semanas qué formato le está
// faltando a la escuela, que hoy es imposible." Esta pieza es chica y separable — se puede
// revisar, aprobar e implementar sola, sin tocar el resto del corrector.
//
// Este archivo cubre RN-46/RN-47 (extensionParaLog, en public/js/correccion.js) y hace un
// barrido estructural de los CINCO filtros de RN-45 (CA-67).

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

let Correccion = null;
try {
  Correccion = require('../../public/js/correccion.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (!Correccion || typeof Correccion.extensionParaLog !== 'function') {
  test('falta implementar extensionParaLog() en public/js/correccion.js (RN-47)', () => {
    throw new Error(
      'public/js/correccion.js tiene que exportar extensionParaLog(nombre). Ver ' +
      'specs/correccion-de-entregas.spec.md RN-47 (el recorte exacto está escrito ahí, como ' +
      'pseudocódigo) y RN-46 (nunca el nombre completo del archivo).',
    );
  });
} else {
  const { extensionParaLog } = Correccion;

  // ── RN-47 — el recorte, con los tres resultados posibles ───────────────────

  test('CA-69 — una extensión sana se guarda en minúsculas, con el punto', () => {
    assert.strictEqual(extensionParaLog('ARCHIVO.PPTX'), '.pptx');
    assert.strictEqual(extensionParaLog('trabajo.DoCx'), '.docx');
    assert.strictEqual(extensionParaLog('plano.dwg'), '.dwg');
  });

  test('CA-69 — sin ningún punto en el nombre: (sin_ext)', () => {
    assert.strictEqual(extensionParaLog('sinextension'), '(sin_ext)');
    assert.strictEqual(extensionParaLog(''), '(sin_ext)');
    assert.strictEqual(extensionParaLog(null), '(sin_ext)');
    assert.strictEqual(extensionParaLog(undefined), '(sin_ext)');
  });

  test('una "extensión" con caracteres raros pero de largo válido: (invalida)', () => {
    // Corta (≤10 chars tras el punto) pero con algo que no es [a-z0-9] — un espacio, un
    // acento, un símbolo. Esta es la rama real de "(invalida)" del pseudocódigo de RN-47.
    assert.strictEqual(extensionParaLog('archivo.p ptx'), '(invalida)');
    assert.strictEqual(extensionParaLog('archivo.dwg™'), '(invalida)');
  });

  // ⚠️ DEFECTO DE LA SPEC, dejado documentado a propósito (ver el reporte del tester):
  //
  // CA-69 dice literalmente: "Un nombre con una 'extensión' de 2.000 caracteres se guarda como
  // (invalida)". Pero el pseudocódigo de RN-47 es:
  //
  //   const m = String(nombre||'').toLowerCase().match(/\.([^.\\/]{1,10})$/);
  //   const ext = m && /^[a-z0-9]{1,10}$/.test(m[1]) ? '.'+m[1] : (m ? '(invalida)' : '(sin_ext)');
  //
  // El PRIMER regex ya exige que, después del último punto, haya ENTRE 1 Y 10 caracteres hasta
  // el final del string. Con 2.000 caracteres después del punto, ese regex no matchea EN
  // NINGÚN LADO (no hay otro punto de donde colgarse) → `m` da `null` → por el propio
  // pseudocódigo, el resultado es `(sin_ext)`, NO `(invalida)`. La rama `(invalida)` solo es
  // alcanzable cuando SÍ hay un punto con 1 a 10 caracteres después (o sea, cuando `m` no es
  // null) pero esos caracteres no son `[a-z0-9]` — por ejemplo un espacio o una letra acentuada,
  // como en el test de arriba.
  //
  // Se escribe el test siguiendo el pseudocódigo de RN-47 (que es el que trae la implementación
  // exacta) y se dejan los DOS resultados documentados, para que quien implemente no "corrija"
  // uno de los dos documentos sin que el Arquitecto decida cuál era la intención real.
  test('DEFECTO DE SPEC — 2.000 caracteres tras el punto: el pseudocódigo de RN-47 da (sin_ext), no (invalida) como dice CA-69', () => {
    const nombreLargo = 'trabajo.' + 'x'.repeat(2000);
    assert.strictEqual(extensionParaLog(nombreLargo), '(sin_ext)',
      'esto es lo que produce EL REGEX TAL CUAL ESTÁ ESCRITO en RN-47. Si este test falla ' +
      'porque el implementador siguió la letra de CA-69 en vez de RN-47, hay que volver al ' +
      'Arquitecto: los dos documentos de la misma spec se contradicen entre sí.');
  });

  test('el largo límite: exactamente 10 caracteres después del punto sigue siendo válido', () => {
    const diez = 'a'.repeat(10);
    assert.strictEqual(extensionParaLog(`archivo.${diez}`), `.${diez}`);
  });

  test('once caracteres después del punto ya no matchea: (sin_ext), no (invalida)', () => {
    const once = 'a'.repeat(11);
    assert.strictEqual(extensionParaLog(`archivo.${once}`), '(sin_ext)');
  });

  // ── CA-68 — nunca el nombre del archivo ─────────────────────────────────────

  test('CA-68 — extensionParaLog nunca devuelve el nombre original, solo la extensión', () => {
    const r = extensionParaLog('TP3-Juan-Perez.docx');
    assert.strictEqual(r, '.docx');
    assert.ok(!r.includes('Juan'), 'el apellido del alumno no puede aparecer en lo que se loguea');
    assert.ok(!r.includes('TP3'));
  });
}

// ── CA-67 — barrido de los CINCO filtros de RN-45 ─────────────────────────────
//
// Estructural, a propósito: lee el código fuente y busca evidencia de que CADA UNO de los
// cinco puntos de rechazo llama a la utilidad de log (RN-49 dice que del lado del servidor se
// reusa `logRechazo`, middleware/route-log.js, con el evento 'formato_rechazado'). No ejecuta
// las rutas (necesitaría server + DB): lo que se prueba es que el código no puede rechazar en
// silencio, que es exactamente el bug que esta pieza corrige (ver el comentario de
// middleware/route-log.js sobre los .heic mudos).

const activitiesSrc = leer('routes/activities.js');
const roomsSrc       = leer('routes/rooms.js');
const imageUploadSrc = leer('middleware/image-upload.js');

// Ventanas de código alrededor de cada uno de los 5 puntos de RN-45. Los primeros tres viven
// en el mismo archivo, así que se acota por el nombre de la lista que cada fileFilter usa.
function ventanasDe(fuente, lista, cuantas) {
  const ventanas = [];
  const re = new RegExp(`${lista}\\.includes`, 'g');
  let m;
  while ((m = re.exec(fuente)) && ventanas.length < cuantas) {
    ventanas.push(fuente.slice(m.index, m.index + 600));
  }
  return ventanas;
}

test('CA-67 — RN-45 #1/#3: los dos fileFilter de EXT_ALLOWED (docente) loguean el rechazo', () => {
  const ventanas = ventanasDe(activitiesSrc, 'EXT_ALLOWED', 2);
  assert.ok(ventanas.length >= 1,
    'no se encontró ningún fileFilter que use EXT_ALLOWED.includes en routes/activities.js — ¿se renombró?');
  for (const v of ventanas) {
    assert.match(v, /logRechazo|formato_rechazado/,
      'un rechazo de EXT_ALLOWED tiene que loguearse (RN-45/RN-49): hoy el fileFilter hace ' +
      'cb(null, false) sin loguear la extensión, y el sistema no puede contestar qué formato le falta a la escuela');
  }
});

test('CA-67 — RN-45 #2: la entrega del alumno (EXT_SUBMISSIONS) loguea el rechazo — "el que más importa"', () => {
  const ventanas = ventanasDe(activitiesSrc, 'EXT_SUBMISSIONS', 1);
  assert.ok(ventanas.length >= 1, 'no se encontró el fileFilter de EXT_SUBMISSIONS');
  assert.match(ventanas[0], /logRechazo|formato_rechazado/,
    'RN-45 marca este como "el que más importa": es la entrega del alumno, el caso dominante');
});

test('CA-67 — RN-45 #4: el adjunto de la sala en vivo (live.EXT_ARCHIVOS) loguea el rechazo', () => {
  const ventanas = ventanasDe(roomsSrc, 'EXT_ARCHIVOS', 1);
  assert.ok(ventanas.length >= 1, 'no se encontró el fileFilter de EXT_ARCHIVOS en routes/rooms.js');
  assert.match(ventanas[0], /logRechazo|formato_rechazado/);
});

test('CA-67 — RN-45 #5: el camino de imagen (EXT_IMAGENES) loguea el rechazo con el evento nuevo', () => {
  // RN-45: "el 5 ya tiene medio camino hecho — importa logRechazo y su ExtensionNoPermitidaError
  // ya guarda this.ext; solo hay que sumarle el evento." O sea: logRechazo YA se llama acá; lo
  // que falta es que el evento sea 'formato_rechazado' (hoy no lo es).
  assert.match(imageUploadSrc, /logRechazo/, 'esto ya debería estar (era el "medio camino hecho")');
  assert.match(imageUploadSrc, /formato_rechazado/,
    'falta sumar evento: "formato_rechazado" a la llamada de logRechazo en middleware/image-upload.js (RN-45/RN-49)');
});

// Nota: esta prueba es un chequeo NEGATIVO acotado a las apariciones de 'formato_rechazado'
// que ya existan. Que el evento exista en absoluto ya lo exige la tanda CA-67 de arriba —
// acá el objetivo es más angosto: si aparece, que no venga acompañado del nombre del archivo.
test('RN-46 — el evento no puede llevar el nombre completo del archivo, en ningún lugar de los 5', () => {
  for (const [archivo, fuente] of [
    ['routes/activities.js', activitiesSrc],
    ['routes/rooms.js', roomsSrc],
    ['middleware/image-upload.js', imageUploadSrc],
  ]) {
    // No es un chequeo perfecto (no hay forma de probar "ausencia de un campo" leyendo texto
    // con certeza), pero cubre el error más común: pasar `file.originalname` o `req.file.name`
    // directo al log en la MISMA línea donde se menciona el evento nuevo.
    const cerca = fuente.split('formato_rechazado').slice(1);
    for (const trozo of cerca) {
      const ventana = trozo.slice(0, 300);
      assert.ok(!/originalname/.test(ventana),
        `${archivo}: cerca de 'formato_rechazado' aparece 'originalname' — RN-46 prohíbe loguear ` +
        'el nombre completo del archivo, solo la extensión');
    }
  }
});
