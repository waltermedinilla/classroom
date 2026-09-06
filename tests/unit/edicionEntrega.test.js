// El alumno corrige su entrega antes de que la corrijan — la regla de quién puede editar.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/edicion-de-la-entrega.spec.md. Cinco bloques:
//
//   1. EL ORDEN — que es la regla entera: sin entrega > reabierta > vencida > corregida >
//      congelada > editable. El caso que originó todo es el alumno que sube el archivo
//      equivocado y se queda con eso puesto: antes, tener una entrega Y el flag apagado
//      alcanzaba para cerrarle la puerta, aunque nadie hubiera mirado el trabajo todavía.
//   2. QUÉ ES CORREGIR (D2) — la NOTA, y solo la nota. La devolución escrita sin nota es el
//      pedido de rehacer y no cierra nada; la autocalificación (manual: false) tampoco.
//   2.bis LA REAPERTURA — "Permitir que lo rehaga" le gana a la nota, al plazo y al check.
//   3. EL FLAG (D1/D4) — ausente se lee como marcado, `false` congela, y estar marcado
//      NO le gana a corregida ni a vencida.
//   4. EL CABLEADO — que la vista cargue el módulo ANTES de course.js, que las rutas no
//      tengan la condición vieja escrita a mano, que el modelo nazca con el default nuevo,
//      y que el botón del docente se LEA en los dos temas.
//      Sin cualquiera de esas, la regla es correcta y no se aplica.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const { MOTIVOS, puedeEditar, esCorregida } = require('../../public/js/edicionEntrega');

const raiz  = path.join(__dirname, '..', '..');
const leer  = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const rutas = leer('routes/activities.js');
const vista = leer('views/course.ejs');
const curso = leer('public/js/course.js');

// ── Andamios ────────────────────────────────────────────────────────────────

const AHORA   = new Date('2026-09-04T12:00:00Z');
const ANTES   = new Date('2026-08-30T12:00:00Z');  // venció hace 5 días
const DESPUES = new Date('2026-09-10T12:00:00Z');  // vence en 6 días

// Actividad como la ve la regla: los mismos nombres de campo del lado del servidor
// (documento Activity) y del navegador (lo que manda GET /activities/course/:id).
const act = (extra) => Object.assign({
  dueDate: null, allowLateSubmissions: false, allowResubmission: true,
}, extra);

// Atajo: la pregunta completa, con entrega ya hecha, que es el caso de esta feature.
const motivo = (a, grade, reabierta) =>
  puedeEditar({ act: a, grade: grade || null, hayEntrega: true, reabierta, ahora: AHORA }).motivo;

const puede = (a, grade, reabierta) =>
  puedeEditar({ act: a, grade: grade || null, hayEntrega: true, reabierta, ahora: AHORA }).puede;

// ── 1. El orden ─────────────────────────────────────────────────────────────

test('sin entrega previa: no hay nada que editar, manda el plazo y nada más', () => {
  const sinEntrega = (a, grade) =>
    puedeEditar({ act: a, grade: grade || null, hayEntrega: false, ahora: AHORA });

  assert.equal(sinEntrega(act()).motivo, MOTIVOS.sinEntrega,
    'la primera entrega no la cierra ninguna de las reglas nuevas');
  assert.equal(sinEntrega(act()).puede, true);

  // El docente que corrige en papel y carga la nota a mano sigue pudiendo recibir la
  // entrega después. Es el comportamiento de hoy y la spec lo deja explícitamente afuera.
  assert.equal(sinEntrega(act(), { points: 9, manual: true }).puede, true,
    'corregir sin entrega NO le cierra la primera entrega al alumno');

  // El plazo sí la cierra: eso ya era así antes de esta feature.
  assert.equal(sinEntrega(act({ dueDate: ANTES })).motivo, MOTIVOS.vencida);
});

test('ESTE es el caso del pedido: entregó, nadie corrigió, el plazo corre → puede editar', () => {
  assert.equal(motivo(act({ dueDate: DESPUES })), MOTIVOS.editable);
  assert.equal(puede(act({ dueDate: DESPUES })), true);
  assert.equal(motivo(act()), MOTIVOS.editable, 'sin fecha límite también');
});

test('vencida le gana a todo lo demás', () => {
  assert.equal(motivo(act({ dueDate: ANTES })), MOTIVOS.vencida);
  assert.equal(puede(act({ dueDate: ANTES })), false);

  // Con las tardías abiertas el plazo deja de cerrar: misma condición que ya usaban las
  // tres rutas y el isBlocked del modal.
  assert.equal(motivo(act({ dueDate: ANTES, allowLateSubmissions: true })), MOTIVOS.editable);

  // Vencida Y corregida: gana vencida, porque es la que ya existía.
  assert.equal(motivo(act({ dueDate: ANTES }), { points: 8, manual: true }), MOTIVOS.vencida);
});

test('cada motivo trae su texto, y el texto sale del módulo', () => {
  // El cartel de la pantalla y el mensaje del 403 tienen que decir lo mismo porque SON lo
  // mismo. Si el texto se escribiera en el HTML, divergen en la primera edición.
  for (const clave of ['vencida', 'corregida', 'congelada']) {
    const r = puedeEditar({
      act: act(clave === 'vencida'   ? { dueDate: ANTES }
             : clave === 'congelada' ? { allowResubmission: false } : {}),
      grade: clave === 'corregida' ? { points: 7, manual: true } : null,
      hayEntrega: true, ahora: AHORA,
    });
    assert.equal(r.motivo, clave);
    assert.equal(typeof r.texto, 'string');
    assert.ok(r.texto.length > 10, `el motivo ${clave} tiene que traer un texto para mostrar`);
  }
  assert.equal(puedeEditar({ act: act(), grade: null, hayEntrega: true, ahora: AHORA }).texto, '',
    'editable no tiene cartel: no hay nada que explicar');
});

// ── 2. Qué es corregir (D2) ─────────────────────────────────────────────────

test('la nota puesta cierra la edición', () => {
  assert.equal(motivo(act(), { points: 9, feedback: '', manual: true }), MOTIVOS.corregida);
  assert.equal(motivo(act(), { points: 0, feedback: '', manual: true }), MOTIVOS.corregida,
    'un 0 es una nota: cierra igual que un 10');
  assert.equal(motivo(act(), { points: 7, feedback: 'Muy bien', manual: true }), MOTIVOS.corregida,
    'nota + devolución es la corrección completa');
});

test('la devolución escrita SIN nota NO cierra: es el pedido de rehacer', () => {
  // La primera versión de la regla cerraba también acá, y estaba mal: "rehacé el punto 3"
  // ES el caso de uso de la devolución sin nota, y cerrar ahí le traba al alumno
  // exactamente lo que el docente le está pidiendo que haga. Lo reportó el usuario el mismo
  // día que se implementó: "pero ahora cómo tengo que corregir".
  assert.equal(motivo(act(), { points: null, feedback: 'Rehacé el punto 3', manual: true }),
    MOTIVOS.editable);
  assert.equal(puede(act(), { points: null, feedback: 'Rehacé el punto 3', manual: true }), true);
});

test('un grade sin nota y sin devolución tampoco cierra', () => {
  // POST /:id/grade deja el subdocumento puesto aunque el docente vacíe el campo.
  assert.equal(motivo(act(), { points: null, feedback: '', manual: true }), MOTIVOS.editable);
});

test('la AUTOCALIFICACIÓN no es corrección del docente (trampa 2)', () => {
  // Las actividades con templateSnapshot se autocalifican AL ENVIARLAS, con manual:false.
  // Sin este caso, el cuestionario queda cerrado en el mismo instante en que el alumno lo
  // responde y allowResubmission —que ahí significa "puede volver a intentar"— no sirve
  // para nada. Hoy hay 0 actividades con plantilla en producción: el bug aparecería meses
  // después sin que nadie lo relacione.
  assert.equal(motivo(act(), { points: 6, feedback: 'Autocalificado', manual: false }),
    MOTIVOS.editable);

  // Pero si el docente la toca a mano, pasa a ser manual:true y ahí sí cierra.
  assert.equal(motivo(act(), { points: 8, feedback: 'Autocalificado', manual: true }),
    MOTIVOS.corregida);
});

test('un grade de OTRO alumno no es asunto de esta regla', () => {
  // La regla recibe el grade YA buscado. Pasarle null es "a este alumno no lo corrigieron".
  assert.equal(motivo(act(), null), MOTIVOS.editable);
  assert.equal(motivo(act(), undefined), MOTIVOS.editable);
});

test('esCorregida() es la mitad reutilizable de la regla: la nota y solo la nota', () => {
  assert.equal(esCorregida({ points: 5, manual: true }), true);
  assert.equal(esCorregida({ points: 0, manual: true }), true, 'un 0 es una nota');
  assert.equal(esCorregida({ points: null, feedback: 'ojo', manual: true }), false,
    'la devolución escrita no es una corrección terminada');
  assert.equal(esCorregida({ points: null, feedback: '', manual: true }), false);
  assert.equal(esCorregida({ points: 5, manual: false }), false);
  assert.equal(esCorregida(null), false);
});

// ── 2.bis  La reapertura del docente ────────────────────────────────────────

test('"Permitir que lo rehaga" le gana a la nota puesta', () => {
  const conNota = { points: 4, feedback: 'Rehacelo', manual: true };
  assert.equal(motivo(act(), conNota), MOTIVOS.corregida, 'sin reabrir, la nota cierra');
  assert.equal(motivo(act(), conNota, true), MOTIVOS.reabierta);
  assert.equal(puede(act(), conNota, true), true);
});

test('la reapertura le gana también al PLAZO VENCIDO y al check destildado', () => {
  // Es una autorización explícita, sobre este alumno, posterior a todo lo demás: si el
  // docente le dijo "rehacelo", que su propio plazo se lo impida sería contestarle que no a
  // algo que acaba de decir que sí.
  assert.equal(motivo(act({ dueDate: ANTES }), null, true), MOTIVOS.reabierta);
  assert.equal(motivo(act({ allowResubmission: false }), null, true), MOTIVOS.reabierta);
  assert.equal(motivo(act({ dueDate: ANTES, allowResubmission: false }),
    { points: 2, manual: true }, true), MOTIVOS.reabierta,
    'los tres motivos de bloqueo juntos, y la reapertura gana igual');
});

test('reabrir a alguien que no entregó no inventa una entrega', () => {
  assert.equal(
    puedeEditar({ act: act(), grade: null, hayEntrega: false, reabierta: true, ahora: AHORA }).motivo,
    MOTIVOS.sinEntrega);
});

test('el aviso de reabierta NO es un cartel de bloqueo', () => {
  const r = puedeEditar({
    act: act(), grade: { points: 5, manual: true }, hayEntrega: true, reabierta: true, ahora: AHORA,
  });
  assert.equal(r.puede, true);
  assert.ok(/habilit/i.test(r.texto), 'el texto tiene que avisarle que puede rehacerla: ' + r.texto);
});

// ── 3. El flag del docente (D1 / D4) ────────────────────────────────────────

test('el flag ausente se lee como MARCADO (los documentos históricos)', () => {
  // Se pregunta por === false, no por falsy: un documento sin el campo es de antes de la
  // migración y tiene que poder editarse, que es todo el punto de D1.
  const sinCampo = { dueDate: null, allowLateSubmissions: false };
  assert.equal(motivo(sinCampo), MOTIVOS.editable);
  assert.equal(motivo(act({ allowResubmission: undefined })), MOTIVOS.editable);
  assert.equal(motivo(act({ allowResubmission: null })), MOTIVOS.editable);
});

test('el docente que destilda el check congela la entrega', () => {
  assert.equal(motivo(act({ allowResubmission: false })), MOTIVOS.congelada);
  assert.equal(puede(act({ allowResubmission: false })), false);
});

test('D4: estar marcado NO le gana a corregida ni a vencida', () => {
  // Palabras del usuario: "ten en cuenta que el docente no haya corregido antes o no hayan
  // vencido". El flag habilita, la regla nueva cierra igual.
  assert.equal(motivo(act({ allowResubmission: true }), { points: 9, manual: true }),
    MOTIVOS.corregida);
  assert.equal(motivo(act({ allowResubmission: true, dueDate: ANTES })), MOTIVOS.vencida);
});

test('corregida le gana a congelada: el motivo que se muestra es el que pasó primero', () => {
  assert.equal(motivo(act({ allowResubmission: false }), { points: 9, manual: true }),
    MOTIVOS.corregida);
});

// ── 4. El cableado ──────────────────────────────────────────────────────────

test('course.ejs carga edicionEntrega.js ANTES de course.js', () => {
  // Si va después, EdicionEntrega es undefined y la sección "Mi entrega" no dibuja nada.
  const posModulo = vista.indexOf('/js/edicionEntrega.js');
  const posCourse = vista.indexOf('/js/course.js');
  assert.ok(posModulo !== -1, 'course.ejs tiene que cargar el módulo');
  assert.ok(posCourse !== -1);
  assert.ok(posModulo < posCourse,
    'edicionEntrega.js va ANTES de course.js o la regla no existe cuando course.js la usa');
});

test('no queda ninguna condición vieja escrita a mano en las rutas', () => {
  // La misma pregunta estaba copiada en tres lugares de routes/activities.js. El barrido
  // busca la FORMA vieja de preguntarla, no el nombre del módulo: un archivo que importe
  // EdicionEntrega y además conserve la condición vieja pasaría cualquier chequeo hecho
  // sobre el import.
  const viejas = rutas.match(/!\s*activity\.allowResubmission/g) || [];
  assert.deepEqual(viejas, [],
    'la condición `!activity.allowResubmission` tiene que salir de las rutas: la regla vive en el módulo');

  const viejasCliente = curso.match(/!\s*act\.allowResubmission/g) || [];
  assert.deepEqual(viejasCliente, [],
    'y tampoco puede quedar escrita a mano en course.js');
});

test('las tres rutas de entrega pasan por la misma guarda', () => {
  // Las dos de subida y el submit. La de archivos, además, la corría DESPUÉS de multer:
  // quien no podía entregar igual alcanzaba a empujar 20 MB al disco antes del 403.
  for (const ruta of ['upload-submission-image', 'upload-submission-file', 'submit']) {
    const i = rutas.indexOf(`'/:id/${ruta}'`);
    assert.ok(i !== -1, `falta la ruta ${ruta}`);
    // La guarda tiene que estar nombrada en la definición del router, antes del handler.
    const declaracion = rutas.slice(i, i + 700);
    assert.ok(declaracion.includes('exigirAlumnoQuePuedeEntregar'),
      `${ruta} tiene que pasar por exigirAlumnoQuePuedeEntregar`);
  }
});

test('reabrir la entrega tiene su ruta, y es del DOCENTE', () => {
  const i = rutas.indexOf("'/:id/reopen-submission'");
  assert.ok(i !== -1, 'falta POST /activities/:id/reopen-submission');
  const decl = rutas.slice(i, i + 900);
  assert.ok(!decl.includes('exigirAlumnoQuePuedeEntregar'),
    'la reapertura NO puede pasar por la guarda del alumno: justamente sirve para cuando el alumno no puede');
  assert.ok(/canManage/.test(decl),
    'solo quien gestiona el curso puede reabrirle la entrega a un alumno');
});

test('poner nota vuelve a cerrar una entrega reabierta', () => {
  // Si no se apagara, el alumno quedaría con la puerta abierta para siempre después de la
  // primera reapertura, y el docente no tendría cómo volver a cerrarla salvo a mano.
  const i = rutas.indexOf("router.post('/:id/grade'");
  assert.ok(i !== -1);
  const cuerpo = rutas.slice(i, rutas.indexOf('// DELETE /activities/:id', i));
  assert.ok(/reopenedAt/.test(cuerpo),
    'POST /:id/grade tiene que apagar la reapertura al guardar una nota');
});

test('retirar la entrega tiene su ruta y su guarda', () => {
  const i = rutas.indexOf("router.delete('/:id/submission'");
  assert.ok(i !== -1, 'falta DELETE /activities/:id/submission');
  assert.ok(rutas.slice(i, i + 700).includes('exigirAlumnoQuePuedeEntregar'),
    'no se puede retirar una entrega corregida ni vencida: misma guarda que editar');
});

test('el modelo nace con el default nuevo (D1)', () => {
  const modelo = leer('models/Activity.js');
  const linea = modelo.split('\n').find(l => l.includes('allowResubmission:'));
  assert.ok(linea, 'el campo tiene que seguir existiendo: el docente conserva el control');
  assert.ok(/default:\s*true/.test(linea),
    'allowResubmission pasa a default true; el docente lo destilda para congelar una evaluación');
});

test('la migración existe y no toca las vencidas', () => {
  const mig = leer('migrate-permitir-edicion.js');
  assert.ok(mig.includes('--dry-run'), 'la migración tiene que poder correrse en seco primero');
  assert.ok(mig.includes('allowLateSubmissions'),
    'el filtro tiene que mirar las tardías: una vencida con tardías abiertas SÍ entra');
  assert.ok(/timestamps:\s*false/.test(mig),
    'la updateMany va con timestamps:false para no mover el updatedAt de actividades que no cambió el docente');
});

test('el botón "Permitir que lo rehaga" se lee en los dos temas', () => {
  // Se CALCULA, no se mira a ojo: es la lección del chip de 1,10:1 del chat de la sala y la
  // de los grises que no llegaban a AA en ningún tema. --secondary (#34a853) da 3,06:1 sobre
  // la tarjeta clara, así que el botón usa --verde-texto, que va en par claro/oscuro.
  const estilos = leer('public/css/style.css');

  const variable = (bloque, nombre) => {
    const m = estilos.match(new RegExp(bloque.replace(/[.[\]"=]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\}'));
    assert.ok(m, `no existe el bloque ${bloque}`);
    const v = m[1].match(new RegExp('--' + nombre + '\\s*:\\s*(#[0-9a-fA-F]{3,8})'));
    assert.ok(v, `${bloque} no declara --${nombre}`);
    return v[1];
  };

  const luminancia = (hex) => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const canal = (i) => {
      const c = parseInt(n.slice(i * 2, i * 2 + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
  };
  const contraste = (a, b) => {
    const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  // El botón vive en la celda de la tabla, sobre --surface.
  for (const [tema, bloque] of [['claro', ':root'], ['oscuro', '[data-theme="dark"]']]) {
    const verde   = variable(bloque, 'verde-texto');
    const fondo   = variable(bloque, 'surface');
    const ratio   = contraste(verde, fondo);
    assert.ok(ratio >= 4.5,
      `en tema ${tema} el botón abierto da ${ratio.toFixed(2)}:1 sobre la tarjeta (hace falta 4,5)`);
  }

  assert.ok(/\.gt-rehacer\.is-open\s*\{[^}]*var\(--verde-texto\)/.test(estilos),
    'el botón abierto tiene que usar --verde-texto, no --secondary');
});

test('el aviso de reapertura llega al alumno por las dos pantallas', () => {
  // Si el servidor lo marca y la pantalla no lo dice, el alumno no tiene forma de enterarse
  // de que la puerta que estaba cerrada se volvió a abrir.
  assert.ok(/reabierta:\s*!!submission\?\.reopenedAt/.test(curso),
    'renderSubmissionSection y renderRunnerSection tienen que pasarle la reapertura a la regla');
  const veces = (curso.match(/reabierta:\s*!!submission\?\.reopenedAt/g) || []).length;
  assert.equal(veces, 2, `las DOS pantallas del alumno (archivos y runner), encontré ${veces}`);
  assert.ok(/veredicto\.motivo === 'reabierta'/.test(curso),
    'la pantalla tiene que mostrar el aviso cuando el motivo es reabierta');
});
