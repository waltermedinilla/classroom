// La tarea entregada sale de lo pendiente — estado de la actividad para el alumno.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/entrega-sale-de-pendientes.spec.md. Cuatro bloques:
//
//   1. EL ORDEN — que es la regla entera: calificada > entregada > vencida > tardía >
//      pendiente. El caso que originó todo es "entregada y además vencida": antes ganaba
//      la fecha y el alumno veía un candado sobre algo que ya había hecho.
//   2. PRÓXIMAS ENTREGAS — qué entra en la tarjeta del sidebar y qué no.
//   3. EL CABLEADO — que el servidor mande `mySubmission` y que la vista cargue el módulo
//      ANTES de course.js. Sin cualquiera de las dos, la regla es correcta y no se aplica.
//   4. CONTRASTE — el chip nuevo tiene fondo fijo; el ratio WCAG se calcula, no se mira.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  ESTADOS, yaEntregada, estadoParaAlumno, esProximaEntrega,
} = require('../../public/js/estadoActividad');

const raiz    = path.join(__dirname, '..', '..');
const leer    = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const rutas   = leer('routes/activities.js');
const vista   = leer('views/course.ejs');
const estilos = leer('public/css/style.css');

// ── Andamios ────────────────────────────────────────────────────────────────

const AHORA   = new Date('2026-08-24T12:00:00Z');
const ANTES   = new Date('2026-08-20T12:00:00Z');  // venció hace 4 días
const DESPUES = new Date('2026-08-30T12:00:00Z');  // vence en 6 días

const entregada = { at: new Date('2026-08-19T10:00:00Z') };

const act = (extra) => Object.assign({
  _id: 'a1', title: 'Trabajo', dueDate: null, allowLateSubmissions: false,
  myGrade: null, mySubmission: null,
}, extra);

const clave = (a) => estadoParaAlumno(a, AHORA).clave;

// ── 1. El orden ─────────────────────────────────────────────────────────────

test('sin entrega y con plazo por delante: pendiente', () => {
  assert.equal(clave(act({ dueDate: DESPUES })), 'pendiente');
  assert.equal(clave(act()), 'pendiente', 'sin fecha de entrega también es pendiente');
});

test('entregada: deja de ser pendiente', () => {
  assert.equal(clave(act({ dueDate: DESPUES, mySubmission: entregada })), 'entregada');
  assert.equal(clave(act({ mySubmission: entregada })), 'entregada',
    'sin fecha de entrega, entregar igual la saca de pendiente');
});

test('ESTE es el caso del pedido: entregada Y vencida no muestra candado', () => {
  // Antes ganaba la fecha: al alumno que había entregado el 19 le figuraba "Vencida" el 24,
  // mezclada con lo que todavía tiene que hacer. La entrega le gana al plazo.
  assert.equal(clave(act({ dueDate: ANTES, mySubmission: entregada })), 'entregada');
  assert.equal(clave(act({ dueDate: ANTES, allowLateSubmissions: true, mySubmission: entregada })),
    'entregada', 'con tardías abiertas, igual: ya entregó');
});

test('sin entregar y vencida: vencida, o tardía si el docente abrió las tardías', () => {
  assert.equal(clave(act({ dueDate: ANTES })), 'vencida');
  assert.equal(clave(act({ dueDate: ANTES, allowLateSubmissions: true })), 'tardia');
});

test('calificada le gana a todo, incluso sin entrega', () => {
  // El docente que corrige en papel y carga la nota a mano: hay nota y no hay Submission.
  assert.equal(clave(act({ dueDate: ANTES, myGrade: { points: 8 } })), 'calificada');
  assert.equal(clave(act({ mySubmission: entregada, myGrade: { points: 8 } })), 'calificada');
});

test('devolución escrita SIN nota no es "calificada"', () => {
  // points null = el docente escribió una devolución y todavía no puso nota. Ver la memoria
  // de devoluciones del docente: los contadores filtran por points != null.
  const a = act({ mySubmission: entregada, myGrade: { points: null, feedback: 'Buen trabajo' } });
  assert.equal(clave(a), 'entregada', 'una devolución sin nota no la da por calificada');
});

test('cada estado trae su etiqueta y su clase CSS', () => {
  assert.equal(ESTADOS.entregada.etiqueta, 'Entregada');
  assert.equal(ESTADOS.entregada.css, 'status-submitted');
  const declaradas = Object.values(ESTADOS).map(e => e.css);
  assert.equal(new Set(declaradas).size, declaradas.length, 'dos estados no pueden compartir el chip');
});

test('yaEntregada() no se cree un mySubmission vacío', () => {
  assert.equal(yaEntregada(act({ mySubmission: entregada })), true);
  assert.equal(yaEntregada(act()), false);
  assert.equal(yaEntregada(null), false);
});

// ── 2. Próximas entregas ────────────────────────────────────────────────────

test('a "Próximas entregas" va lo que falta hacer y tiene fecha por delante', () => {
  assert.equal(esProximaEntrega(act({ dueDate: DESPUES }), AHORA), true);
  assert.equal(esProximaEntrega(act({ dueDate: DESPUES, mySubmission: entregada }), AHORA), false,
    'lo ya entregado no es una entrega próxima: es el pedido del usuario');
  assert.equal(esProximaEntrega(act({ dueDate: ANTES }), AHORA), false, 'lo vencido no es próximo');
  assert.equal(esProximaEntrega(act(), AHORA), false, 'sin fecha no hay nada próximo que mostrar');
});

// ── 3. El cableado ──────────────────────────────────────────────────────────

test('el servidor le manda al alumno su propia entrega', () => {
  // Sin este campo la regla de arriba es correcta y no sirve para nada: el navegador no
  // tiene con qué contestar. Es lo que faltaba.
  assert.ok(/obj\.mySubmission\s*=/.test(rutas),
    'GET /activities/course/:id tiene que devolverle al alumno su mySubmission');
  assert.ok(/Submission\.find\([\s\S]{0,200}student:\s*userId/.test(rutas),
    'y sacarlo de una sola consulta de Submission por las actividades del curso');
});

test('la vista carga el módulo ANTES de course.js', () => {
  const iEstado = vista.indexOf('/js/estadoActividad.js');
  const iCourse = vista.indexOf('/js/course.js');
  assert.ok(iEstado !== -1, 'course.ejs tiene que cargar /js/estadoActividad.js');
  assert.ok(iEstado < iCourse, 'si carga después, course.js se cae con EstadoActividad undefined');
});

// ── 4. Contraste ────────────────────────────────────────────────────────────

function luminancia(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const canal = (i) => {
    const c = parseInt(n.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

function contraste(a, b) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Lee la regla del chip en style.css y le saca fondo y color.
function reglaDelChip(selector) {
  const re = new RegExp(selector.replace(/[.[\]"=]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = estilos.match(re);
  assert.ok(m, `no existe la regla ${selector} — ¿se renombró el chip?`);
  const decls = {};
  for (const par of m[1].split(';')) {
    const i = par.indexOf(':');
    if (i === -1) continue;
    decls[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return decls;
}

for (const [tema, selector] of [
  ['claro',  '.act-status-chip.status-submitted'],
  ['oscuro', '[data-theme="dark"] .act-status-chip.status-submitted'],
]) {
  test(`contraste ${tema}: el chip "Entregada" llega a 4,5:1`, () => {
    const d = reglaDelChip(selector);
    const fondo = (d.background || d['background-color'] || '').trim();
    const texto = (d.color || '').trim();
    // Un fondo fijo obliga a un color fijo: si el texto se hereda del tema, en oscuro queda
    // el texto claro sobre el fondo claro del chip. Ese fue el bug de 1,10:1 de la sala.
    assert.ok(/^#[0-9a-f]{3,8}$/i.test(fondo) && /^#[0-9a-f]{3,8}$/i.test(texto),
      `${selector} tiene que declarar fondo Y color en hex para poder medirse`);
    const ratio = contraste(fondo, texto);
    assert.ok(ratio >= 4.5,
      `${selector} da ${ratio.toFixed(2)}:1 (${texto} sobre ${fondo}); WCAG AA pide 4,5:1`);
  });
}
