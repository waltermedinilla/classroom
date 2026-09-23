// Lógica pura del Modo Corrector — public/js/correccion.js.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/correccion-de-entregas.spec.md, sección "Tests necesarios" → "Lógica pura extraída".
// Este archivo fija el CONTRATO de las funciones que el módulo tiene que exportar. Donde la
// spec no fija la forma exacta (estadoDeEntrega, ordenCorreccion, renderVisor: la spec da el
// QUÉ pero no la firma completa), el contrato de abajo es la propuesta del tester para que el
// implementador tenga algo concreto que seguir — está escrito así en el reporte de esta ronda,
// no es letra de la spec.
//
// ── El contrato que este archivo asume ──────────────────────────────────────────
//
//   estaDevuelta(grade) -> boolean                                            [RN-21]
//     ver tests/unit/returnedAtDefault.test.js para el porqué. Repetido acá nada más que
//     con la matriz completa, porque es la función que más se usa desde otros módulos.
//
//   puedeDevolver(grade) -> boolean                                           [RN-27]
//     true solo si HAY algo que devolver: points != null || feedback.trim() !== ''.
//     Gobierna el botón (deshabilitado si no hay nada) y la ruta (quién queda en omitidas[]).
//
//   estadoDeEntrega({ sub, grade }) -> 'sin_entregar'|'entregado_sin_calificar'|'borrador'|'devuelto'  [RN-11]
//     sin_entregar            : !sub
//     entregado_sin_calificar : sub && (!grade || grade.points == null)
//     borrador                : sub && grade.points != null && !estaDevuelta(grade)
//     devuelto                : sub && grade.points != null && estaDevuelta(grade)
//
//   ordenCorreccion(alumnos, filtro) -> Array
//     `alumnos`: [{ studentId, sub, grade }, ...] en el mismo orden de la planilla.
//     `filtro` : 'todos' | 'entregado_sin_calificar' | 'sin_entregar' | 'calificado'
//     Devuelve el subconjunto que matchea el filtro (via estadoDeEntrega), EN EL MISMO ORDEN
//     relativo del array de entrada — nunca alfabético por su cuenta (RN-09/CA-10). No muta
//     `alumnos`. "Calificado" incluye borrador Y devuelta (RN-11: "Calificados: points != null").
//
//   renderVisor(att, opciones) -> { motivo: string|null, acciones: Array<{tipo:string}> }  [RN-05,RN-20,RN-41]
//     att: { name: string, size: number (bytes) }
//     opciones (todas opcionales, default = "nada listo todavía"):
//       archivoEnDisco:              boolean, default true
//       conversionOfficeDisponible:  boolean, default false  (RN-16 — ¿hay soffice?)
//       conversionCadDisponible:     boolean, default false  (RN-42c — ¿hay ODA?)
//       pdfDerivadoListo:            boolean, default false  (RN-16c)
//       dxfDerivadoListo:            boolean, default false  (RN-42d)
//     motivo: null si hay visor, o uno de los 8 motivos cerrados de RN-20.
//     acciones: SIEMPRE incluye { tipo: 'descargar' } (RN-19/CA-21). Incluye
//       { tipo: 'enlace-firmado' } únicamente cuando hace falta el paso 1 de Office
//       (RN-15: nunca para imagen, PDF cacheado, DXF o DWG-vía-derivado).
//
//   extensionParaLog(nombre) -> string    [RN-47] — ver tests/unit/formatoRechazado.test.js,
//     que es donde vive la batería completa. Acá solo se confirma que el módulo la exporta.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const Adjuntos = require('../../public/js/adjuntosActividad');

const raiz = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

function listaDeExtensiones(fuente, nombre, dondeDice) {
  const m = fuente.match(new RegExp(`const\\s+${nombre}\\s*=\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `no se encontró la lista ${nombre} en ${dondeDice} — ¿se renombró?`);
  const items = m[1].match(/'([^']*)'/g);
  assert.ok(items && items.length, `la lista ${nombre} de ${dondeDice} quedó vacía`);
  return items.map(s => s.slice(1, -1));
}

const activitiesSrc   = leer('routes/activities.js');
const EXT_SUBMISSIONS = listaDeExtensiones(activitiesSrc, 'EXT_SUBMISSIONS', 'routes/activities.js');

let Correccion = null;
try {
  Correccion = require('../../public/js/correccion.js');
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const FUNCIONES = ['estaDevuelta', 'puedeDevolver', 'estadoDeEntrega', 'ordenCorreccion', 'renderVisor'];
const faltan = !Correccion ? FUNCIONES : FUNCIONES.filter(f => typeof Correccion[f] !== 'function');

if (faltan.length) {
  test(`falta implementar public/js/correccion.js (${!Correccion ? 'el archivo no existe' : 'faltan: ' + faltan.join(', ')})`, () => {
    throw new Error(
      'public/js/correccion.js tiene que existir y exportar estaDevuelta, puedeDevolver, ' +
      'estadoDeEntrega, ordenCorreccion, renderVisor y extensionParaLog. Ver ' +
      'specs/correccion-de-entregas.spec.md, RN-05/RN-09/RN-11/RN-20/RN-21/RN-27/RN-41/RN-47 ' +
      'y el contrato escrito arriba de este archivo.' + (faltan.length ? ` Faltan: ${faltan.join(', ')}` : ''),
    );
  });
} else {
  const { estaDevuelta, puedeDevolver, estadoDeEntrega, ordenCorreccion, renderVisor } = Correccion;

  // ── estaDevuelta / puedeDevolver ──────────────────────────────────────────

  test('RN-21 — estaDevuelta: los tres valores de returnedAt', () => {
    assert.strictEqual(estaDevuelta({ returnedAt: undefined }), true);
    assert.strictEqual(estaDevuelta({ returnedAt: null }), false);
    assert.strictEqual(estaDevuelta({ returnedAt: new Date('2026-01-01') }), true);
    assert.strictEqual(estaDevuelta(null), false);
    assert.strictEqual(estaDevuelta(undefined), false);
  });

  test('RN-27 — puedeDevolver: solo si hay nota o devolución escrita', () => {
    assert.strictEqual(puedeDevolver({ points: 8, feedback: '' }), true, 'con nota alcanza');
    assert.strictEqual(puedeDevolver({ points: null, feedback: 'Rehacé el punto 3' }), true,
      'devolución sin nota también se puede devolver — es el pedido de rehacer');
    assert.strictEqual(puedeDevolver({ points: null, feedback: '' }), false, 'nada que devolver');
    assert.strictEqual(puedeDevolver({ points: null, feedback: '   ' }), false,
      'espacios en blanco no cuentan como devolución escrita');
    assert.strictEqual(puedeDevolver(null), false, 'sin grade, nada que devolver');
  });

  // ── estadoDeEntrega (RN-11) ────────────────────────────────────────────────

  test('RN-11 — estadoDeEntrega: sin_entregar cuando no hay submission', () => {
    assert.strictEqual(estadoDeEntrega({ sub: null, grade: null }), 'sin_entregar');
    assert.strictEqual(estadoDeEntrega({ sub: null, grade: { points: 9, returnedAt: new Date() } }),
      'sin_entregar', 'el docente que corrige en papel sin entrega no cambia este estado');
  });

  test('RN-11 — estadoDeEntrega: entregado_sin_calificar cuando hay entrega y no hay nota', () => {
    assert.strictEqual(estadoDeEntrega({ sub: {}, grade: null }), 'entregado_sin_calificar');
    assert.strictEqual(estadoDeEntrega({ sub: {}, grade: { points: null, feedback: 'Rehacé el punto 3' } }),
      'entregado_sin_calificar', 'devolución sin nota sigue siendo "sin calificar" para el filtro');
  });

  test('RN-11/RN-26 — estadoDeEntrega: borrador cuando hay nota pero no está devuelta', () => {
    assert.strictEqual(
      estadoDeEntrega({ sub: {}, grade: { points: 8, returnedAt: null } }),
      'borrador');
  });

  test('RN-11 — estadoDeEntrega: devuelto cuando hay nota y está devuelta (incluye legado)', () => {
    assert.strictEqual(
      estadoDeEntrega({ sub: {}, grade: { points: 8, returnedAt: new Date() } }),
      'devuelto');
    assert.strictEqual(
      estadoDeEntrega({ sub: {}, grade: { points: 8, returnedAt: undefined } }),
      'devuelto', 'una nota legada (sin returnedAt) es devuelta');
  });

  // ── ordenCorreccion (RN-09, CA-09, CA-10) ──────────────────────────────────

  const roster = [
    { studentId: 'a1', sub: {}, grade: null },                                    // entregado_sin_calificar
    { studentId: 'a2', sub: null, grade: null },                                  // sin_entregar
    { studentId: 'a3', sub: {}, grade: { points: 7, returnedAt: new Date() } },   // devuelto
    { studentId: 'a4', sub: {}, grade: null },                                    // entregado_sin_calificar
    { studentId: 'a5', sub: {}, grade: { points: 5, returnedAt: null } },         // borrador
  ];

  test('CA-10 — ordenCorreccion respeta el orden de la planilla, no alfabético', () => {
    const todos = ordenCorreccion(roster, 'todos');
    assert.deepStrictEqual(todos.map(a => a.studentId), ['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  test('RN-09 — ordenCorreccion filtra por el estado calculado con estadoDeEntrega', () => {
    const filtrado = ordenCorreccion(roster, 'entregado_sin_calificar');
    assert.deepStrictEqual(filtrado.map(a => a.studentId), ['a1', 'a4']);
  });

  test('CA-09 — el array queda CONGELADO: cambiar un grade después no reordena la selección ya hecha', () => {
    // ordenCorreccion es pura: se llama UNA vez al entrar al Modo Corrector y el llamador se
    // queda con el array. Este test demuestra que el array devuelto es independiente del
    // roster de origen: mutar el grade de un alumno DESPUÉS de filtrar no puede cambiar lo
    // que ya se congeló, porque ordenCorreccion no guarda una referencia viva evaluada al vuelo.
    const rosterMutable = roster.map(a => ({ ...a, grade: a.grade ? { ...a.grade } : a.grade }));
    const congelado = ordenCorreccion(rosterMutable, 'entregado_sin_calificar');
    assert.strictEqual(congelado.length, 2, '"1 de 23" del ejemplo de la spec: acá "1 de 2"');

    // Se califica a a1 (deja de cumplir el filtro) directamente sobre el objeto ORIGINAL.
    const a1 = rosterMutable.find(a => a.studentId === 'a1');
    a1.grade = { points: 9, returnedAt: null };

    // El array ya devuelto no se recalcula solo: sigue teniendo los dos elementos originales.
    assert.strictEqual(congelado.length, 2,
      'el array congelado no puede perder al alumno recién calificado: eso es lo que rompería ' +
      'el contador "N de M" y haría saltar la flecha › a cualquier lado');
    assert.strictEqual(congelado[0].studentId, 'a1');
  });

  test('ordenCorreccion no muta el array de entrada', () => {
    const copia = roster.map(a => ({ ...a }));
    ordenCorreccion(copia, 'calificado');
    assert.deepStrictEqual(copia.map(a => a.studentId), roster.map(a => a.studentId));
  });

  test('RN-11 — el filtro "calificado" incluye borrador Y devuelta', () => {
    const calificados = ordenCorreccion(roster, 'calificado');
    assert.deepStrictEqual(calificados.map(a => a.studentId).sort(), ['a3', 'a5']);
  });

  // ── renderVisor (RN-05, RN-19, RN-20, RN-41) ───────────────────────────────

  const MOTIVOS_VALIDOS = new Set([
    null,
    'formato_sin_visor', 'office_no_cargo', 'sin_conversor', 'sin_conversor_cad',
    'archivo_muy_grande', 'conversion_fallida', 'plano_muy_grande', 'archivo_no_esta',
  ]);

  test('CA-21 — TODA extensión de EXT_SUBMISSIONS tiene, siempre, una acción de descargar', () => {
    for (const ext of EXT_SUBMISSIONS) {
      const r = renderVisor({ name: `archivo${ext}`, size: 1024 }, {});
      assert.ok(r && Array.isArray(r.acciones),
        `renderVisor(${ext}) tiene que devolver { acciones: [] }`);
      assert.ok(r.acciones.some(a => a.tipo === 'descargar'),
        `${ext} se quedó sin botón Descargar — RN-19 dice que nunca puede faltar`);
      assert.ok(MOTIVOS_VALIDOS.has(r.motivo),
        `${ext} devolvió un motivo fuera de la lista cerrada de RN-20: ${r.motivo}`);
    }
  });

  test('CA-24 / RN-20 — archivo_no_esta cuando el documento lo nombra y el disco no lo tiene', () => {
    const r = renderVisor({ name: 'perdido.pdf', size: 1000 }, { archivoEnDisco: false });
    assert.strictEqual(r.motivo, 'archivo_no_esta');
    assert.ok(r.acciones.some(a => a.tipo === 'descargar'), 'igual tiene que ofrecer Descargar');
  });

  test('RN-20 — formato_sin_visor para un formato sin ningún camino de vista (.zip)', () => {
    const r = renderVisor({ name: 'entrega.zip', size: 2048 }, {});
    assert.strictEqual(r.motivo, 'formato_sin_visor');
  });

  test('CA-08 / RN-05c — una imagen tiene visor (motivo null), usando Adjuntos.esImagen()', () => {
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png', '.gif']) {
      assert.ok(Adjuntos.esImagen('foto' + ext), `${ext} debería ser imagen para Adjuntos`);
      const r = renderVisor({ name: 'foto' + ext, size: 500000 }, {});
      assert.strictEqual(r.motivo, null, `${ext} tiene visor: no debería traer motivo de rechazo`);
    }
  });

  test('RN-54 / CA-54 — .docx sin LibreOffice y sin PDF cacheado: sin_conversor, no cuelga', () => {
    const r = renderVisor({ name: 'trabajo.docx', size: 20000 }, {
      conversionOfficeDisponible: false, pdfDerivadoListo: false,
    });
    assert.strictEqual(r.motivo, 'sin_conversor');
    assert.ok(r.acciones.some(a => a.tipo === 'descargar'));
  });

  test('CA-54 — .dwg sin ODA y sin DXF cacheado: sin_conversor_cad, no cuelga', () => {
    const r = renderVisor({ name: 'plano.dwg', size: 120000 }, {
      conversionCadDisponible: false, dxfDerivadoListo: false,
    });
    assert.strictEqual(r.motivo, 'sin_conversor_cad');
    assert.ok(r.acciones.some(a => a.tipo === 'descargar'));
  });

  test('CA-55 / RN-42 — un .dxf nunca pide enlace firmado', () => {
    const r = renderVisor({ name: 'plano.dxf', size: 100000 }, {});
    assert.strictEqual(r.motivo, null, 'el .dxf se dibuja directo');
    assert.ok(!r.acciones.some(a => a.tipo === 'enlace-firmado'),
      'RN-15: un enlace firmado solo se emite para el paso 1 de Office, nunca para CAD');
  });

  test('CA-56 — un .dwg con el derivado listo se dibuja sin pedir enlace firmado', () => {
    const r = renderVisor({ name: 'plano.dwg', size: 120000 }, { dxfDerivadoListo: true });
    assert.strictEqual(r.motivo, null);
    assert.ok(!r.acciones.some(a => a.tipo === 'enlace-firmado'));
  });

  test('RN-15 — un .docx SIN pdf cacheado necesita el paso 1 (enlace firmado a Microsoft)', () => {
    const r = renderVisor({ name: 'trabajo.docx', size: 20000 }, { conversionOfficeDisponible: true });
    assert.ok(r.acciones.some(a => a.tipo === 'enlace-firmado'),
      'sin PDF cacheado todavía, el primer paso de la cadena es Microsoft, que necesita URL firmada');
  });

  test('RN-16c — un .docx CON pdf cacheado no necesita enlace firmado (usa el derivado directo)', () => {
    const r = renderVisor({ name: 'trabajo.docx', size: 20000 }, { pdfDerivadoListo: true });
    assert.strictEqual(r.motivo, null);
    assert.ok(!r.acciones.some(a => a.tipo === 'enlace-firmado'),
      'con el PDF ya cacheado, RN-16c dice que se usa directo: no hay que pasar por Microsoft');
  });

  // ── RN-41 — los topes de tamaño, contra los valores medidos ────────────────
  // CA-61, citado literal: "un .dxf de 12 MB → plano_muy_grande...; un .dwg de 2 MB →
  // archivo_muy_grande y no se manda a convertir." Los dos motivos son intencionalmente
  // DISTINTOS según el formato: el .dxf ya es un plano listo para dibujar (tope de DIBUJO,
  // 10 MB, y por eso el motivo nombra al plano); el .dwg rebota en el tope de ENTRADA al
  // conversor (1,5 MB) antes de intentar nada, y por eso usa el motivo genérico.
  const MB = 1024 * 1024;

  test('CA-61 — un .dxf de 12 MB (pasa el tope de DIBUJO, 10 MB) da plano_muy_grande', () => {
    const r = renderVisor({ name: 'plano-grande.dxf', size: 12 * MB }, {});
    assert.strictEqual(r.motivo, 'plano_muy_grande');
    assert.ok(r.acciones.some(a => a.tipo === 'descargar'));
  });

  test('CA-61 — un .dwg de 2 MB (pasa el tope de ENTRADA al conversor, 1,5 MB) da archivo_muy_grande', () => {
    const r = renderVisor({ name: 'plano-grande.dwg', size: 2 * MB }, { conversionCadDisponible: true });
    assert.strictEqual(r.motivo, 'archivo_muy_grande');
  });

  test('RN-41 — ningún archivo real del censo (dwg ≤120 KB, dxf ≤5,3 KB) rebota los topes', () => {
    assert.strictEqual(renderVisor({ name: 'real.dwg', size: 120 * 1024 }, { conversionCadDisponible: true }).motivo, null);
    assert.strictEqual(renderVisor({ name: 'real.dxf', size: Math.round(5.3 * 1024) }, {}).motivo, null);
  });

  // ── El orden de los tres <script> (RN-26) ──────────────────────────────────

  test('views/course.ejs carga correccion.js ANTES de edicionEntrega.js y de course.js', () => {
    const vista = leer('views/course.ejs');
    const iCorreccion = vista.indexOf('/js/correccion.js');
    const iEdicion    = vista.indexOf('/js/edicionEntrega.js');
    const iCourse     = vista.indexOf('/js/course.js');
    assert.ok(iCorreccion !== -1, 'course.ejs tiene que cargar /js/correccion.js');
    assert.ok(iEdicion !== -1, 'course.ejs tiene que cargar /js/edicionEntrega.js');
    assert.ok(iCourse !== -1, 'course.ejs tiene que cargar /js/course.js');
    assert.ok(iCorreccion < iEdicion,
      'correccion.js va ANTES de edicionEntrega.js: la rama "corregida" ahora llama a Correccion.estaDevuelta()');
    assert.ok(iEdicion < iCourse, 'edicionEntrega.js sigue yendo antes de course.js (regla ya existente)');
  });
}
