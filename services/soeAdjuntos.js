// El material que acompaña una actuación del gabinete: archivos y enlaces.
//
// Qué problema resuelve. Hasta el 2026-08-30 el legajo era TEXTO y nada más: el certificado
// que trajo la madre, la receta que mandó el neurólogo, el informe del hospital y el estudio
// que hizo el fonoaudiólogo vivían en una carpeta de cartón —o en el celular de alguien—, y
// el legajo decía "trajo un certificado" sin poder mostrarlo. Cuando al año siguiente otra
// persona lee el legajo, ese "trajo un certificado" no vale nada.
//
// TODO acá es PURO: no requiere mongoose, no toca disco, no lee la fecha del sistema y no
// arma HTML. Es la misma regla que services/soeAcceso.js y services/soeLinea.js, y por el
// mismo motivo: lo consumen el modelo (el enum), la ruta (la validación), la vista (las
// etiquetas) y los tests, y los cuatro no se pueden contradecir nunca.
//
// ⚠️ ESTE ARCHIVO NO DECIDE QUIÉN VE NADA. La confidencialidad sigue viviendo entera en
// services/soeAcceso.js: `adjuntos` es un campo de nivel COMPLETO y la ruta que sirve el
// archivo revalida el alcance del alumno igual que cualquier otra. Acá solo está la forma.
//
// Ver specs/soe-adjuntos-y-agenda.spec.md.

// ── A qué se cuelga un adjunto ───────────────────────────────────────────────
//
// Los adjuntos viven en UN SOLO array plano del legajo (`SoeCase.adjuntos`) con un puntero a
// la actuación a la que pertenecen, y no repartidos adentro de entries[], referrals[] y
// compañía. Tres motivos, en orden de importancia:
//
//   1. La regla de confidencialidad queda en UNA sola guarda —el mismo argumento con el que
//      models/SoeCase.js embebe todo en un documento—: un array, un sanitizado, un lugar
//      donde olvidarse de aplicarla.
//   2. La ruta que sirve el archivo hace UNA búsqueda (`legajo.adjuntos.id(x)`). Con los
//      adjuntos repartidos habría que recorrer cuatro arrays anidados para encontrar uno.
//   3. "Todo el material del legajo en una sola pantalla" es una lectura que el gabinete
//      necesita —"¿qué papeles tenemos de este chico?"— y que con el array plano sale sola.
const ANCLAS = ['legajo', 'entrada', 'derivacion', 'devolucion', 'citacion'];

const ANCLA_LABELS = {
  legajo:     'Documentación del legajo',
  entrada:    'Actuación del seguimiento',
  derivacion: 'Derivación',
  devolucion: 'Devolución del servicio',
  citacion:   'Citación',
};

// ── Archivo o enlace ─────────────────────────────────────────────────────────
//
// El enlace existe porque no todo el material se puede —ni conviene— guardar: el aula
// virtual de un taller externo, un formulario de la Dirección General de Escuelas, un
// documento compartido del hospital. Copiarlo al servidor sería una copia que envejece; el
// enlace apunta al original.
const KINDS = ['archivo', 'enlace'];

// ── Qué clase de papel es ────────────────────────────────────────────────────
//
// La categoría no es decorativa: es lo que permite contestar "¿tenemos el certificado?" sin
// abrir los ocho archivos. Los nombres son los que usa la escuela al hablar, no los de un
// sistema de salud.
const CATEGORIAS = [
  'certificado', 'receta', 'informe', 'estudio', 'nota_derivacion',
  'autorizacion', 'acta', 'produccion', 'otro',
];

const CATEGORIA_LABELS = {
  certificado:     'Certificado',
  receta:          'Receta o indicación',
  informe:         'Informe profesional',
  estudio:         'Estudio o evaluación',
  nota_derivacion: 'Nota de derivación',
  autorizacion:    'Autorización o consentimiento',
  acta:            'Acta o citación firmada',
  produccion:      'Producción del alumno',
  otro:            'Otro material',
};

const CATEGORIA_ICONS = {
  certificado:     'verified',
  receta:          'medication',
  informe:         'description',
  estudio:         'biotech',
  nota_derivacion: 'outgoing_mail',
  autorizacion:    'approval',
  acta:            'history_edu',
  produccion:      'draw',
  otro:            'attach_file',
};

// ── Quién lo produjo ─────────────────────────────────────────────────────────
//
// ⚠️ ES QUIÉN LO PRODUJO, NO QUIÉN LO SUBIÓ. Los dos datos se guardan y son distintos: el
// certificado lo firma el neurólogo (`origen: 'profesional'`) y lo carga el gabinete
// (`subidoPor`), porque la familia lo trajo en papel al colegio. Confundirlos haría que
// dentro de un año el legajo dijera que el certificado lo escribió la psicopedagoga de la
// escuela, que es exactamente lo contrario de lo que pasó.
//
// El alumno y la familia figuran acá aunque hoy no tengan pantalla propia para subir nada:
// es el dato honesto sobre de dónde salió el papel. Ver la decisión D5 de la spec.
const ORIGENES = ['gabinete', 'profesional', 'familia', 'alumno', 'escuela'];

const ORIGEN_LABELS = {
  gabinete:    'Lo produjo el gabinete',
  profesional: 'Lo firmó el profesional externo',
  familia:     'Lo trajo la familia',
  alumno:      'Lo trajo el alumno',
  escuela:     'Lo produjo la escuela',
};

const ORIGEN_ICONS = {
  gabinete:    'psychology',
  profesional: 'stethoscope',
  familia:     'family_restroom',
  alumno:      'school',
  escuela:     'apartment',
};

// ── Qué archivos entran ──────────────────────────────────────────────────────
//
// ⚠️ ESTA ES UNA DÉCIMA LISTA DE EXTENSIONES, y es deliberadamente distinta de las nueve que
// compara tests/unit/subidaPlanos.test.js (las de la actividad, la entrega y la sala). No se
// unifican porque el material que se sube acá es de otra naturaleza —un certificado médico,
// una receta, el informe de un hospital—, y cada diferencia tiene su motivo:
//
//   · SÍ entran las imágenes, y son el caso más frecuente: la foto del certificado sacada
//     con el celular en la puerta del consultorio.
//   · NO entra el `.zip`. En las otras listas está para que el docente suba un trabajo
//     práctico entero; acá un contenedor opaco es material que nadie va a poder leer dentro
//     de un año sin bajarlo y descomprimirlo, que es lo contrario de para qué existe el
//     legajo.
//   · NO entran los planos (`.dwg`, `.dxf`), por lo mismo al revés: son de las materias
//     técnicas y no tienen nada que hacer en un legajo psicopedagógico.
//   · NUNCA nada ejecutable ni interpretable como HTML (`.html`, `.svg`, `.js`, `.exe`…).
//     Es la tercera de las tres preguntas obligatorias por formato nuevo del proyecto.
const EXT_DOCUMENTOS = ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.txt', '.xls', '.xlsx'];

// Las imágenes se guardan TAL CUAL, sin pasar por sharp. El motivo está en la ruta
// (routes/soe.js): un certificado es un documento, no una ilustración, y recomprimirlo
// cambia el papel que la familia entregó.
const EXT_IMAGENES = ['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.avif', '.tif', '.tiff', '.heic', '.heif'];

const EXT_ADJUNTOS = [...EXT_DOCUMENTOS, ...EXT_IMAGENES];

// Lo que va en el `accept=` del formulario. NO es EXT_ADJUNTOS: `.heic` y `.heif` quedan
// afuera a propósito, y el motivo está documentado en config/imagePresets.js — Safari en iOS
// mira el `accept` para decidir qué mandar, y con la lista sin HEIC convierte la foto a JPG
// en el camino. Nombrarlas ahí sería pedirle al teléfono el único formato que después nadie
// puede abrir desde la computadora del gabinete.
//
// Siguen aceptadas del lado del servidor: un HEIC que llegue igual se guarda y se descarga,
// en vez de rebotar con un cartel que no explica nada.
const ACCEPT_ADJUNTOS = EXT_ADJUNTOS.filter(e => e !== '.heic' && e !== '.heif').join(',');

// Se muestran DENTRO del navegador; el resto se descarga. Mismo criterio que
// routes/rooms.js:809 — un .docx no se abre en el navegador, y forzar la descarga evita
// cualquier discusión sobre qué hace el visor con él.
//
// El `.txt` NO está, aunque el navegador lo mostraría perfecto: es texto plano subido por un
// usuario y servido de vuelta, que es justo la familia de la que hay que desconfiar (la misma
// nota que dejó el `.dxf` en el proyecto). Servido como adjunto no puede ser otra cosa que un
// archivo que se baja.
const VER_EN_LINEA = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

// 20 MB, el mismo techo que el resto del proyecto (config/imagePresets.js y la sala en vivo).
// Un PDF escaneado de un hospital ronda los 2-5 MB; una foto de celular sin recomprimir, 4.
const MAX_ADJUNTO_BYTES = 20 * 1024 * 1024;

const extensionDe = (nombre) => {
  const m = /\.[a-z0-9]+$/i.exec(String(nombre || '').trim());
  return m ? m[0].toLowerCase() : '';
};

const extensionPermitida = (nombre) => EXT_ADJUNTOS.includes(extensionDe(nombre));
const esImagen    = (ext) => EXT_IMAGENES.includes(String(ext || '').toLowerCase());
const seVeEnLinea = (ext) => VER_EN_LINEA.includes(String(ext || '').toLowerCase());

// ── Enlaces ──────────────────────────────────────────────────────────────────
//
// Solo http y https. `javascript:` y `data:` son las dos formas de convertir un enlace
// guardado en la base en código que corre en la sesión de quien lo toca: el gabinete abre el
// legajo, hace clic en "Informe del hospital" y ejecuta lo que escribió quien cargó el
// enlace. Acá no hay atacante externo (lo carga el propio SOE), pero un legajo dura años y
// esta lista blanca cuesta cuatro líneas.
//
// Devuelve '' —y no null ni el original— cuando no sirve: el llamador lo trata como "no vino
// ningún enlace", que es el mismo camino que un campo vacío.
function normalizarEnlace(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 2000) return '';
  // Sin esquema se asume https: la gente pega "hospital.gob.ar/turnos", y esperar que
  // escriba el https:// es pedirle que sepa algo que no tiene por qué saber.
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(conEsquema);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

// El dominio, para mostrarlo debajo del título del enlace. Es lo que deja ver a dónde lleva
// sin tener que pasar el mouse por encima.
function dominioDe(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── Agrupar por actuación ────────────────────────────────────────────────────
//
// La clave incluye el tipo Y el id porque los ids de subdocumento son únicos por array y no
// por documento: nada impide que una entrada y una citación compartan el mismo _id.
const claveAncla = (tipo, id) => `${tipo || 'legajo'}:${id ? String(id) : ''}`;

// Los adjuntos ELIMINADOS no se filtran acá. El registro queda —quién lo subió, cuándo, y que
// alguien lo dio de baja—: lo que desaparece es el archivo del disco. Un legajo del que se
// puede borrar material sin dejar rastro no es un registro completo. La vista los dibuja
// apagados; quien necesite solo los vigentes usa `vigentes()`.
const vigentes = (adjuntos) => (adjuntos || []).filter(a => a && !a.eliminadoEl);

// Los más nuevos primero: el certificado que trajeron hoy es el que se está buscando.
// La fecha que ordena es la DEL DOCUMENTO (la que dice el certificado), no la de carga —
// mismo criterio que la línea de tiempo.
function ordenarAdjuntos(adjuntos) {
  return (adjuntos || []).slice().sort((a, b) => {
    const fa = a && a.fecha ? new Date(a.fecha).getTime() : 0;
    const fb = b && b.fecha ? new Date(b.fecha).getTime() : 0;
    return fb - fa;
  });
}

// Devuelve un Map clave → adjuntos, para que la línea de tiempo cuelgue cada papel de su
// hito sin recorrer el array entero una vez por hito.
function agruparPorAncla(adjuntos) {
  const mapa = new Map();
  for (const a of ordenarAdjuntos(adjuntos)) {
    if (!a) continue;
    const clave = claveAncla(a.ancla && a.ancla.tipo, a.ancla && a.ancla.id);
    if (!mapa.has(clave)) mapa.set(clave, []);
    mapa.get(clave).push(a);
  }
  return mapa;
}

// "2,4 MB". Propio y no el `pesoLegible` de services/liveRoom.js a propósito: aquel archivo
// arrastra mongoose y los modelos de la sala, y este servicio es puro justamente para poder
// testearse sin base.
function pesoLegible(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

// ¿Este legajo tiene algún papel colgado? Lo usa la ficha para no dibujar un panel vacío.
const tieneMaterial = (adjuntos) => vigentes(adjuntos).length > 0;

module.exports = {
  ANCLAS, ANCLA_LABELS,
  KINDS,
  CATEGORIAS, CATEGORIA_LABELS, CATEGORIA_ICONS,
  ORIGENES, ORIGEN_LABELS, ORIGEN_ICONS,
  EXT_DOCUMENTOS, EXT_IMAGENES, EXT_ADJUNTOS, ACCEPT_ADJUNTOS, VER_EN_LINEA,
  MAX_ADJUNTO_BYTES,
  extensionDe, extensionPermitida, esImagen, seVeEnLinea,
  normalizarEnlace, dominioDe,
  claveAncla, agruparPorAncla, ordenarAdjuntos, vigentes, pesoLegible, tieneMaterial,
};
