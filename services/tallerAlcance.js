// Jefe de Taller — funciones puras (specs/jefe-de-taller.spec.md, F1).
// Sin Mongo, sin req. La ruta junta los documentos.

const str = (x) => (x == null ? '' : String(x));
const sinAcentos = (s) => str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── D2: sugerir si una materia es de taller, por el nombre (JT-02) ──────────────────────────
//
// Solo SUGIERE: /taller/materias muestra la sugerencia y alguien la confirma. Los patrones
// salen de los nombres reales del horario oficial (2026-11-22).
const PATRONES_TALLER = [
  /^taller/,                         // "Taller…", "Talleres pre-profesionaliz."
  /\btalleres?\b/,                   // "Prácticas de Taller de Electricidad II"
  /^practicas?\b/,                   // "Prácticas Mecánicas II", "Prácticas Profesionalizantes"
  /^operaciones (mecanicas|constructivas)/,
];
// Nunca son taller aunque algo coincida (por si una materia se llama "Taller de lectura" en
// Lengua: mejor no sugerir de más).
const NUNCA_TALLER = [/\blengua\b/, /\bmatematica/, /\btecnologica\b/, /\bliteratura\b/];

function sugerirTaller(nombre) {
  const n = sinAcentos(nombre).replace(/\s+/g, ' ').trim();
  if (!n) return false;
  if (NUNCA_TALLER.some(re => re.test(n))) return false;
  return PATRONES_TALLER.some(re => re.test(n));
}

// ── P1: cada Jefe de Sección con sus MEP y lo que subió cada uno (JT-07) ─────────────────────
//
// secciones: [{ _id, name, heads: [id], divisions: [id], courses: [id] }]
// talleres:  [{ _id, name, division, owner, coTeachers }]   (solo las de esTaller)
// nombres:   Map id → nombre de usuario
// subidas:   Map id → { actividades, novedades, ultima: Date|null }   (en el período)
//
// Una materia de taller es de una sección si está en `courses` o su división está en
// `divisions`. Un MEP que da clases en dos secciones aparece en las dos.
function jefesYMeps({ secciones = [], talleres = [], nombres = new Map(), subidas = new Map() }) {
  const vacio = { actividades: 0, novedades: 0, ultima: null };
  const subio = (id) => subidas.get(str(id)) || vacio;
  const porJefe = new Map();

  for (const s of secciones) {
    const divs = new Set((s.divisions || []).map(str));
    const sueltas = new Set((s.courses || []).map(str));
    const materias = talleres.filter(m => sueltas.has(str(m._id)) || divs.has(str(m.division)));

    const meps = new Map();
    for (const m of materias) {
      for (const id of new Set([m.owner, ...(m.coTeachers || [])].filter(Boolean).map(str))) {
        if (!meps.has(id)) meps.set(id, { id, name: nombres.get(id) || 'Usuario eliminado', materias: [], ...subio(id) });
        const lista = meps.get(id).materias;
        if (!lista.includes(m.name)) lista.push(m.name);
      }
    }

    for (const jefeId of (s.heads || []).map(str)) {
      if (!porJefe.has(jefeId)) {
        porJefe.set(jefeId, { id: jefeId, name: nombres.get(jefeId) || 'Usuario eliminado', secciones: [], meps: new Map(), ...subio(jefeId) });
      }
      const j = porJefe.get(jefeId);
      if (!j.secciones.includes(s.name)) j.secciones.push(s.name);
      for (const [id, mep] of meps) {
        if (id === jefeId) continue;   // el jefe que además da un taller no es su propio MEP
        if (!j.meps.has(id)) j.meps.set(id, { ...mep, materias: [...mep.materias] });
        else for (const n of mep.materias) if (!j.meps.get(id).materias.includes(n)) j.meps.get(id).materias.push(n);
      }
    }
  }

  const porNombre = (a, b) => a.name.localeCompare(b.name, 'es');
  return [...porJefe.values()]
    .map(j => ({ ...j, meps: [...j.meps.values()].sort(porNombre) }))
    .sort(porNombre);
}

// ── Período de "Jefes y MEP" ────────────────────────────────────────────────────────────────
// 'semana' (default) | 'mes' → { desde: Date, hasta: Date, periodo }
function ventanaDelPeriodo(periodo, ahora = new Date()) {
  const p = periodo === 'mes' ? 'mes' : 'semana';
  const hasta = new Date(ahora);
  const desde = new Date(ahora);
  desde.setDate(desde.getDate() - (p === 'mes' ? 30 : 7));
  return { desde, hasta, periodo: p };
}

module.exports = { PATRONES_TALLER, sugerirTaller, jefesYMeps, ventanaDelPeriodo };
