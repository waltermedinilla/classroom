// Sala en vivo: imágenes de los alumnos, respuesta citada y contraste del chat.
// Correr con: npm run test:unit    (node --test tests/unit/*.test.js)
//
// Ver specs/sala-imagenes-y-respuestas.spec.md. Tres bloques:
//
//   1. PERMISOS — la matriz de quién puede escribir, compartir una foto y borrar. Son las
//      funciones puras de services/liveRoom.js: reciben un contexto plano, no `req`, así que
//      se prueban sin base ni servidor.
//   2. LA CITA — qué se copia del mensaje al que se le contesta y qué NO se copia nunca.
//   3. CONTRASTE — el bug que originó todo esto: en modo oscuro, los mensajes propios daban
//      1,10:1 (texto casi blanco sobre un celeste claro fijo). Acá el ratio WCAG se CALCULA a
//      partir de los colores declarados en el archivo, no se mira a ojo: mirarlo a ojo una vez
//      es lo que ya se hizo, y la regresión entró igual.

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');

const {
  puedeEscribir, puedeCompartirImagen, puedeBorrarMensaje, citaDeMensaje, EXTRACTO_MAX,
} = require('../../services/liveRoom');

const raiz = path.join(__dirname, '..', '..');
const sala = fs.readFileSync(path.join(raiz, 'views/partials/live-room.ejs'), 'utf8');

// ── Andamios ────────────────────────────────────────────────────────────────

const ALUMNO  = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTRO    = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const DOCENTE = 'cccccccccccccccccccccccc';

const sesion = (settings = {}, mudos = []) => ({
  _id: 'sesion1',
  closedAt: null,
  settings: { studentsCanWrite: true, reactionsOn: true, studentsCanShareImages: true, ...settings },
  mutedStudents: mudos,
});

const cerrada = () => ({ ...sesion(), closedAt: new Date() });

const alumno   = { esGestor: false, esAlumno: true,  modo: 'visible',     userId: ALUMNO };
const docente  = { esGestor: true,  esAlumno: false, modo: 'visible',     userId: DOCENTE };
const preceptor= { esGestor: false, esAlumno: false, modo: 'visible',     userId: OTRO };
const directivo= { esGestor: false, esAlumno: false, modo: 'observacion', userId: OTRO };

// ── 1. Permisos ─────────────────────────────────────────────────────────────

test('escribir: la matriz completa', () => {
  assert.equal(puedeEscribir(sesion(), docente),   true,  'la docente escribe siempre');
  assert.equal(puedeEscribir(sesion(), alumno),    true,  'el alumno escribe con la sala abierta');
  assert.equal(puedeEscribir(sesion(), preceptor), true,  'preceptoría presentada escribe');
  assert.equal(puedeEscribir(sesion(), directivo), false, 'mirar sin aparecer implica no hablar');

  assert.equal(puedeEscribir(null, docente),    false, 'sin sala no se escribe');
  assert.equal(puedeEscribir(cerrada(), alumno), false, 'la sala cerrada no recibe mensajes');

  const soloDocente = sesion({ studentsCanWrite: false });
  assert.equal(puedeEscribir(soloDocente, alumno),  false, '"solo yo escribo" calla al curso');
  assert.equal(puedeEscribir(soloDocente, docente), true,  '…pero no a la docente');

  assert.equal(puedeEscribir(sesion({}, [ALUMNO]), alumno), false, 'el silenciado no escribe');
  assert.equal(puedeEscribir(sesion({}, [OTRO]),   alumno), true,  'silenciar a otro no me calla a mí');
});

test('compartir una imagen: el alumno necesita las TRES condiciones a la vez (RN-A3)', () => {
  assert.equal(puedeCompartirImagen(sesion(), alumno), true,
    'sala abierta + interruptor prendido + puede escribir');

  assert.equal(puedeCompartirImagen(cerrada(), alumno), false,
    'la sala cerrada no recibe fotos');
  assert.equal(puedeCompartirImagen(sesion({ studentsCanShareImages: false }), alumno), false,
    'el interruptor de la docente corta las fotos del curso');
  assert.equal(puedeCompartirImagen(sesion({ studentsCanWrite: false }), alumno), false,
    'apagar la palabra apaga también las fotos: no se puede seguir hablando por imagen');
  assert.equal(puedeCompartirImagen(sesion({}, [ALUMNO]), alumno), false,
    'silenciar a alguien lo silencia entero — el pedido explícito del usuario');
});

test('compartir una imagen: la docente no depende de su propio interruptor', () => {
  // El interruptor es "fotos DE LOS ALUMNOS". Si se apagara a sí misma, apagar las fotos del
  // curso le sacaría a la docente la forma de compartir el pizarrón, que es el uso original.
  assert.equal(puedeCompartirImagen(sesion({ studentsCanShareImages: false }), docente), true);
  assert.equal(puedeCompartirImagen(sesion({ studentsCanWrite: false }),       docente), true);
  assert.equal(puedeCompartirImagen(cerrada(), docente), false, 'salvo con la sala cerrada');
});

test('compartir una imagen: preceptoría y dirección miran, no dejan material (RN-A2)', () => {
  // Entran a supervisar la clase. Que puedan ESCRIBIR (preceptoría avisa cosas) no los
  // convierte en parte de la clase a los efectos del material.
  assert.equal(puedeEscribir(sesion(), preceptor),        true);
  assert.equal(puedeCompartirImagen(sesion(), preceptor), false);
  assert.equal(puedeCompartirImagen(sesion(), directivo), false);
});

test('compartir una imagen: una sesión vieja sin el campo se comporta como permitida', () => {
  // Las clases que ya estaban abiertas cuando esto se desplegó no tienen el interruptor. Si el
  // chequeo fuera `=== true`, a esas salas se les caerían las fotos sin que nadie las apagara.
  const vieja = { _id: 'x', closedAt: null, settings: { studentsCanWrite: true }, mutedStudents: [] };
  assert.equal(puedeCompartirImagen(vieja, alumno), true);
});

test('borrar: el autor borra lo suyo solo con la sala abierta (RN-B1)', () => {
  const mio    = { _id: 'm1', author: ALUMNO, kind: 'text', deletedAt: null };
  const ajeno  = { _id: 'm2', author: OTRO,   kind: 'text', deletedAt: null };
  const sistema= { _id: 'm3', author: DOCENTE, kind: 'system', deletedAt: null };

  assert.equal(puedeBorrarMensaje(mio, alumno, { salaAbierta: true }),  true);
  assert.equal(puedeBorrarMensaje(mio, alumno, { salaAbierta: false }), false,
    'la clase terminó: borrar deja de ser "me equivoqué" y pasa a ser limpiar el rastro');
  assert.equal(puedeBorrarMensaje(ajeno, alumno, { salaAbierta: true }), false,
    'nadie borra lo que escribió otro');
  assert.equal(puedeBorrarMensaje(sistema, alumno, { salaAbierta: true }), false,
    'un aviso de la sala no es de nadie');
});

test('borrar: la docente borra cualquier cosa, también con la clase cerrada', () => {
  const ajeno = { _id: 'm2', author: OTRO, kind: 'image', deletedAt: null };
  assert.equal(puedeBorrarMensaje(ajeno, docente, { salaAbierta: true }),  true);
  assert.equal(puedeBorrarMensaje(ajeno, docente, { salaAbierta: false }), true,
    'es moderación: el problema de convivencia aparece justo después de la clase');
});

test('borrar: lo ya borrado no se vuelve a borrar', () => {
  const borrado = { _id: 'm1', author: ALUMNO, kind: 'text', deletedAt: new Date() };
  assert.equal(puedeBorrarMensaje(borrado, docente, { salaAbierta: true }), false);
  assert.equal(puedeBorrarMensaje(borrado, alumno,  { salaAbierta: true }), false);
  assert.equal(puedeBorrarMensaje(null,    docente, { salaAbierta: true }), false);
});

// ── 2. La cita ──────────────────────────────────────────────────────────────

test('cita: copia autor, seq y un extracto recortado', () => {
  const larga = 'a'.repeat(200);
  const c = citaDeMensaje({
    _id: 'm1', seq: 7, authorName: 'PEREZ, Juan', kind: 'text', text: larga,
  });
  assert.equal(c.autor, 'PEREZ, Juan');
  assert.equal(c.seq, 7);
  assert.equal(c.borrado, false);
  assert.equal(c.extracto.length, EXTRACTO_MAX, 'se recorta al máximo, con puntos suspensivos');
  assert.ok(c.extracto.endsWith('…'));
});

test('cita: un texto corto entra entero y sin puntos suspensivos', () => {
  const c = citaDeMensaje({ _id: 'm1', seq: 1, authorName: 'A', kind: 'text', text: '  hola   mundo ' });
  assert.equal(c.extracto, 'hola mundo', 'se normalizan los espacios: la cita es de un renglón');
});

test('cita: un adjunto se nombra por lo que es, no por un texto vacío', () => {
  const img = citaDeMensaje({ _id: 'm1', seq: 2, authorName: 'A', kind: 'image', text: '' });
  assert.match(img.extracto, /Imagen/);
  const arch = citaDeMensaje({
    _id: 'm2', seq: 3, authorName: 'A', kind: 'file', text: '', attachment: { name: 'tp3.pdf' },
  });
  assert.match(arch.extracto, /tp3\.pdf/);
});

test('cita: no se cita el sistema ni lo ya borrado (RN-C2, RN-C7)', () => {
  assert.equal(citaDeMensaje({ _id: 'm', seq: 1, kind: 'system', text: 'abrió la sala' }), null,
    'un aviso automático no tiene autor a quien contestarle');
  assert.equal(citaDeMensaje({ _id: 'm', seq: 1, kind: 'text', text: 'x', deletedAt: new Date() }), null,
    'citar un mensaje borrado sería devolverle el texto que la moderación acaba de sacar');
  assert.equal(citaDeMensaje(null), null, 'y un replyTo que no existe se ignora, no explota');
});

// ── 3. Contraste ────────────────────────────────────────────────────────────
//
// Ratio WCAG 2.1 a partir de los colores declarados en el archivo. Todo lo de acá abajo
// existe porque el bug NO era de lógica: era una regla CSS con un fondo fijo y el color de
// texto heredado de la variable del tema.

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

// Parsea el <style> del partial a una lista de { selector, decls }. Tosco a propósito: no es
// un motor de CSS, es lo justo para poder preguntarle al archivo qué colores declara.
function reglas(fuente) {
  const estilo = fuente.slice(fuente.indexOf('<style>') + '<style>'.length, fuente.indexOf('</style>'));
  const sinComentarios = estilo
    .replace(/<%#[\s\S]*?%>/g, '')   // comentarios EJS
    .replace(/\/\*[\s\S]*?\*\//g, ''); // comentarios CSS
  const salida = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(sinComentarios)) !== null) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    if (selector.startsWith('@')) continue;   // el bloque móvil se recorre por sus reglas hijas
    const decls = {};
    for (const par of m[2].split(';')) {
      const i = par.indexOf(':');
      if (i === -1) continue;
      decls[par.slice(0, i).trim()] = par.slice(i + 1).trim();
    }
    salida.push({ selector, decls });
  }
  return salida;
}

const REGLAS = reglas(sala);
const regla = (sel) => REGLAS.find(r => r.selector === sel);
const esHex = (v) => /^#[0-9a-f]{3,8}$/i.test(String(v || '').trim());

// Reglas con fondo fijo que NO llevan texto adentro. Cada una tiene que poder justificarse:
// si mañana alguna empieza a mostrar texto, sale de acá y pasa a necesitar su color.
const SIN_TEXTO = new Set([
  '.lr-punto',      // el puntito verde/gris de "sala abierta"
  '.lr-punto.off',
]);

test('RN-D2: ninguna pastilla de color fija hereda su color de texto', () => {
  // ESTE es el test del bug. `.lr-msg.mio .lr-burbuja` tenía background:#e8f0fe y ningún
  // `color`, así que en tema claro heredaba el texto oscuro (bien) y en oscuro heredaba
  // var(--text) = #e3e5e8 sobre ese mismo celeste: 1,10:1. Un fondo fijo obliga a un color
  // fijo; si el fondo sigue al tema por variable, el texto también puede.
  const culpables = REGLAS.filter(r =>
    esHex(r.decls.background || r.decls['background-color']) &&
    !SIN_TEXTO.has(r.selector.replace(/^\[data-theme="dark"\]\s*/, '')) &&
    !esHex(r.decls.color));

  assert.deepEqual(culpables.map(r => r.selector), [],
    'estas reglas fijan el fondo y dejan el texto a merced del tema: es el bug de 1,10:1');
});

// Los pares que de verdad se leen en el chat, con el tema que le toca a cada uno. El ratio se
// calcula, no se declara: un cambio de color que baje del piso rompe el test solo.
const PARES = [
  ['.lr-msg.mio .lr-burbuja',                       'claro',  '#e8f0fe', '#202124'],
  ['[data-theme="dark"] .lr-msg.mio .lr-burbuja',   'oscuro', null,      null],
  ['.lr-react button.mia',                          'claro',  null,      null],
  ['[data-theme="dark"] .lr-react button.mia',      'oscuro', null,      null],
  ['.lr-aviso',                                     'claro',  null,      null],
  ['[data-theme="dark"] .lr-aviso',                 'oscuro', null,      null],
  ['.lr-obs',                                       'claro',  null,      null],
  ['[data-theme="dark"] .lr-obs',                   'oscuro', null,      null],
  ['.lr-btn-act',                                   'claro',  null,      null],
  ['.lr-ext',                                       'claro',  null,      null],
];

for (const [selector, tema] of PARES) {
  test(`contraste ${tema}: ${selector} llega a 4,5:1`, () => {
    const r = regla(selector);
    assert.ok(r, `no existe la regla ${selector} — ¿se renombró?`);
    const fondo = (r.decls.background || r.decls['background-color'] || '').trim();
    const texto = (r.decls.color || '').trim();
    assert.ok(esHex(fondo) && esHex(texto),
      `${selector} tiene que declarar fondo Y color en hex para poder medirse`);
    const ratio = contraste(fondo, texto);
    assert.ok(ratio >= 4.5,
      `${selector} da ${ratio.toFixed(2)}:1 (${texto} sobre ${fondo}); WCAG AA pide 4,5:1`);
  });
}

test('RN-D3: el gris tenue del chat llega a 4,5:1 en los DOS temas', () => {
  // var(--text-hint) daba 3,52:1 en oscuro (#72777e sobre la tarjeta) y 2,64:1 en claro
  // (#9aa0a6 sobre blanco). El segundo es peor que el primero y venía así desde siempre:
  // apareció midiendo el arreglo del oscuro. Alcanza para un ícono, no para los avisos del
  // sistema ni para "responder" y "borrar", que son controles.
  //
  // Los dos fondos son los que la sala usa de verdad: la tarjeta (--surface) y el fondo de las
  // burbujas (--bg), que en claro es un gris muy claro y es el caso más exigente.
  const fondos = { claro: ['#ffffff', '#f0f4f8'], oscuro: ['#1e2124', '#111418'] };

  const claro  = sala.match(/(?<!\])\.lr-wrap\s*\{[^}]*--lr-tenue:\s*(#[0-9a-f]{3,6})/i);
  const oscuro = sala.match(/\[data-theme="dark"\]\s*\.lr-wrap\s*\{[^}]*--lr-tenue:\s*(#[0-9a-f]{3,6})/i);
  assert.ok(claro,  'falta el valor claro de --lr-tenue (o dejó de ser un hex medible)');
  assert.ok(oscuro, 'falta la variante oscura de --lr-tenue');

  for (const [tema, valor] of [['claro', claro[1]], ['oscuro', oscuro[1]]]) {
    for (const fondo of fondos[tema]) {
      const ratio = contraste(valor, fondo);
      assert.ok(ratio >= 4.5,
        `--lr-tenue en ${tema} (${valor}) da ${ratio.toFixed(2)}:1 sobre ${fondo}; WCAG AA pide 4,5:1`);
    }
  }

  // Y que se use: si quedara declarada pero sin usar, el test de arriba pasaría igual. Se mide
  // sobre las DECLARACIONES parseadas y no sobre el texto crudo del archivo, que menciona
  // --text-hint en los comentarios que explican justamente por qué dejó de usarse.
  const conHint = REGLAS.filter(r =>
    r.selector !== '.lr-wrap' &&
    Object.values(r.decls).some(v => /var\(--text-hint\)/.test(v)));
  assert.deepEqual(conHint.map(r => r.selector), [],
    'dentro de la sala los grises tenues van por --lr-tenue, no por --text-hint directo');
});

// ── 4. Marcado ──────────────────────────────────────────────────────────────

test('el botón de imagen es del docente Y del alumno; el de archivo, solo del docente', () => {
  // RN-A1: el alumno comparte fotos, no documentos. Son dos `if` distintos en el EJS.
  const imagen = sala.match(/<%\s*if\s*\(esGestor\s*\|\|\s*esAlumno\)\s*\{\s*%>([\s\S]*?)<%\s*\}\s*%>/);
  assert.ok(imagen, 'el botón de imagen tiene que colgar de (esGestor || esAlumno)');
  assert.match(imagen[1], /id="lrBtnImagen"/);
  assert.ok(!/id="lrBtnArchivo"/.test(imagen[1]),
    'el botón de archivo NO puede estar en la misma rama: el alumno no sube documentos');
});

test('el cableado de los dos botones de adjuntar va por separado', () => {
  // Con los cuatro listeners adentro de un solo `if ($("lrBtnImagen"))`, el alumno —que tiene
  // el botón de imagen y no el de archivo— reventaba en la segunda línea con un TypeError, y
  // eso dejaba sin cablear los `change`: el botón de la cámara quedaba muerto para todo el curso.
  const trozo = sala.slice(sala.indexOf("if ($('lrBtnImagen'))"));
  const bloqueImagen = trozo.slice(0, trozo.indexOf("if ($('lrBtnArchivo'))"));
  assert.ok(bloqueImagen.length > 0, 'los dos `if` tienen que existir por separado');
  assert.ok(!/lrBtnArchivo|lrFileArchivo/.test(bloqueImagen),
    'el bloque de la imagen no puede tocar los elementos del archivo');
});

test('el permiso de borrar y el de la cámara los manda el servidor, no la vista', () => {
  // La regla ya no es "soy la docente": con la copia repetida en el navegador, alcanzaba con
  // que una de las dos quedara vieja para mostrar un botón que responde 403.
  assert.match(sala, /m\.puedoBorrar/, 'el botón "borrar" sale de lo que dice el mensaje');
  assert.ok(!/GESTOR && !m\.borrado/.test(sala), 'no puede quedar la regla vieja cableada en la vista');
  assert.match(sala, /s\.puedoCompartirImagen/, 'el botón de la cámara sale del estado de la sala');
});
