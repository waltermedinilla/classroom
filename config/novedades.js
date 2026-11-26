// Novedades guiadas — specs/recorrido-novedades.spec.md.
//
// La pantalla se oscurece, queda iluminado lo nuevo (un botón, una solapa, una parte de la
// pantalla) y un cartel lo explica. Esta es LA lista: cargar una novedad es agregar una entrada.
// La pieza visual (public/js/novedades.js) no se toca.
//
// Cada entrada:
//   id        único y PARA SIEMPRE (RN-4): con él se recuerda quién la vio. No se cambia ni se
//             reutiliza, o todos la vuelven a ver.
//   desde     'YYYY-MM-DD': antes de esa fecha no se muestra.
//   hasta     'YYYY-MM-DD' o null: después de esa fecha ya no se muestra (RN-5).
//   titulo    cómo se llama en la solapa "Novedades" del superadmin.
//   para      a quién va, en palabras, para esa misma solapa.
//   roles     los roles que la ven (D2-1).
//   modulo    opcional: el módulo que tiene que estar habilitado para la persona. Se pregunta con
//             moduloActivoPara (config/modulos.js), que resuelve también los "por persona" como
//             "¿Quiénes pueden transmitir?" (D2-2).
//   pantalla  RegExp sobre la ruta (sin la query): en qué páginas puede aparecer.
//   pasos     [{ donde, titulo, texto }]. `donde` es el selector de lo que se ilumina; null =
//             cartel en el centro. En `texto`, **así** va en negrita. Son TEXTO, no HTML.
//
// ⭐ D6 (regla de trabajo): cada spec que cambia algo visible para un rol responde "¿Lleva
// novedad guiada?". Si es sí, su entrada se escribe y se aprueba en esa misma spec.

const ROLES = require('../models/User').getRoles();
const { MODULOS_BY_ID, moduloActivoPara } = require('./modulos');

const NOVEDADES = [
  {
    id: 'transmitir',
    desde: '2026-11-26',
    hasta: null,
    titulo: 'Transmití tu clase en vivo',
    para: 'Docentes habilitados para transmitir',
    // Los roles que pueden ser titulares o co-docentes de una materia. Lo fino (que sea docente
    // de ESA materia y esté en la lista de la escuela) lo resuelven `modulo` y que el botón esté
    // a la vista: el botón solo se dibuja para quien puede transmitir en esa sala (puedeEmitir).
    roles: ['teacher', 'jefe', 'jefetaller', 'directivo', 'admin', 'superadmin'],
    modulo: 'transmision',
    pantalla: /^\/courses\/[0-9a-f]{24}\/?$/,
    pasos: [
      {
        donde: '#txAbrir',
        titulo: 'Transmití tu clase en vivo',
        texto: 'Con **Transmitir** tus alumnos te ven y te escuchan desde su casa: podés compartir '
             + 'la cámara, el micrófono o tu pantalla. Para terminar, tocá **Dejar de transmitir** '
             + 'en el mismo lugar.',
      },
    ],
  },
];

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// NV-09: una entrada mal cargada no llega a producción. Se valida al arrancar.
function validarNovedades(lista, { roles = ROLES, modulos = MODULOS_BY_ID } = {}) {
  const ids = new Set();
  for (const n of lista) {
    const quien = `config/novedades.js: la novedad "${n && n.id}"`;
    if (!n || typeof n.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(n.id)) throw new Error(`${quien} necesita un id de 2 a 40 letras minúsculas, números o guiones`);
    if (ids.has(n.id)) throw new Error(`${quien} tiene el id repetido`);
    ids.add(n.id);
    if (!FECHA.test(n.desde || '')) throw new Error(`${quien} necesita "desde" como AAAA-MM-DD`);
    if (n.hasta != null && !FECHA.test(n.hasta)) throw new Error(`${quien} tiene "hasta" mal escrito`);
    if (!Array.isArray(n.roles) || !n.roles.length) throw new Error(`${quien} necesita al menos un rol`);
    for (const r of n.roles) if (!roles.includes(r)) throw new Error(`${quien} tiene un rol que no existe: ${r}`);
    if (n.modulo != null && !modulos[n.modulo]) throw new Error(`${quien} tiene un módulo que no existe: ${n.modulo}`);
    if (!(n.pantalla instanceof RegExp)) throw new Error(`${quien} necesita "pantalla" como expresión regular`);
    if (!Array.isArray(n.pasos) || !n.pasos.length) throw new Error(`${quien} necesita al menos un paso`);
    for (const p of n.pasos) {
      if (!p || !p.titulo || !p.texto) throw new Error(`${quien} tiene un paso sin título o sin texto`);
      if (p.donde != null && typeof p.donde !== 'string') throw new Error(`${quien} tiene un "donde" que no es un selector`);
    }
  }
  return true;
}
validarNovedades(NOVEDADES);

const POR_ID = Object.fromEntries(NOVEDADES.map(n => [n.id, n]));

// D2, pasos 1 y 2: el rol y el módulo, y que esté en fecha. `hoy` es 'YYYY-MM-DD'.
function corresponde(nov, { user, school, hoy }) {
  if (!nov || !user) return false;
  if (!nov.roles.includes(user.role)) return false;
  if (hoy && (hoy < nov.desde || (nov.hasta && hoy > nov.hasta))) return false;
  if (nov.modulo && !moduloActivoPara(school, user, nov.modulo)) return false;
  return true;
}

const entradaDe = (user, id) => ((user && user.novedadesVistas) || []).find(e => e && e.id === id) || null;

// RN-3b: pendiente = nunca la vio, o pidió volver a verla.
function pendiente(nov, user) {
  const e = entradaDe(user, nov.id);
  return !e || !!e.repetidaEn;
}

// Lo que va al navegador para ESTA página: las que corresponden, están pendientes y son de esta
// pantalla, de la más vieja a la más nueva (D3, de a una). Sin RegExp ni roles: solo lo visual.
function novedadesPara({ user, school, ruta, hoy, impersonando = false, lista = NOVEDADES }) {
  if (!user || impersonando) return [];
  return lista
    .filter(n => n.pantalla.test(ruta || '') && corresponde(n, { user, school, hoy }) && pendiente(n, user))
    .sort((a, b) => (a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0))
    .map(n => ({ id: n.id, pasos: n.pasos.map(p => ({ donde: p.donde || null, titulo: p.titulo, texto: p.texto })) }));
}

// Mi perfil (D8): ¿cuántas novedades le corresponden a esta persona, vistas o no?
const queLeCorresponden = ({ user, school, hoy, lista = NOVEDADES }) =>
  lista.filter(n => corresponde(n, { user, school, hoy }));

module.exports = { NOVEDADES, POR_ID, validarNovedades, corresponde, pendiente, entradaDe, novedadesPara, queLeCorresponden };
