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

// ── Período: día, semana o mes (pedido del 2026-11-22) ──────────────────────────────────────
//
// `fecha` ('YYYY-MM-DD', hora de Argentina) es el ancla: el día, la semana (lunes a domingo)
// o el mes que la contienen. Una fecha futura o mal escrita cae en hoy. Las fechas se manejan
// como texto y en UTC para que el horario de la máquina no corra un día.
const PERIODOS = ['dia', 'semana', 'mes'];
const TZ_AR = '-03:00';   // Argentina no tiene horario de verano
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const aUTC = (f) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const deUTC = (d) => d.toISOString().slice(0, 10);
const sumarDias = (f, n) => { const d = aUTC(f); d.setUTCDate(d.getUTCDate() + n); return deUTC(d); };
const sumarMeses = (f, n) => { const d = aUTC(f); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return deUTC(d); };
const hoyAR = (ahora) => deUTC(new Date(ahora.getTime() - 3 * 3600 * 1000));

function ventanaDelPeriodo(periodo, fecha, ahora = new Date()) {
  const p = PERIODOS.includes(periodo) ? periodo : 'semana';
  const hoy = hoyAR(ahora);
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha || '')) && !Number.isNaN(aUTC(fecha).getTime()) && fecha <= hoy ? fecha : hoy;

  let inicio, fin;
  if (p === 'dia') { inicio = f; fin = sumarDias(f, 1); }
  else if (p === 'semana') {
    const dow = (aUTC(f).getUTCDay() + 6) % 7;   // 0 = lunes
    inicio = sumarDias(f, -dow); fin = sumarDias(inicio, 7);
  } else { inicio = f.slice(0, 8) + '01'; fin = sumarMeses(inicio, 1); }

  const anterior = p === 'dia' ? sumarDias(inicio, -1) : p === 'semana' ? sumarDias(inicio, -7) : sumarMeses(inicio, -1);
  const siguiente = fin <= hoy ? fin : null;

  const [, mi, di] = inicio.split('-').map(Number);
  const ultimo = sumarDias(fin, -1);
  const [yu, mu, du] = ultimo.split('-').map(Number);
  const titulo = p === 'dia' ? null   // el día lo escribe la vista, con la fecha larga de la escuela
    : p === 'semana' ? `Semana del ${di} ${MES_CORTO[mi - 1]} al ${du} ${MES_CORTO[mu - 1]}`
    : `${MESES[mi - 1][0].toUpperCase()}${MESES[mi - 1].slice(1)} de ${yu}`;

  return {
    periodo: p, fecha: f, inicio, fin, anterior, siguiente, titulo, esActual: inicio <= hoy && hoy < fin,
    desde: new Date(`${inicio}T00:00:00${TZ_AR}`),
    hasta: new Date(`${fin}T00:00:00${TZ_AR}`),   // exclusivo
  };
}

// ── Lo que hizo cada Sección (pedido del 2026-11-22) ─────────────────────────────────────────
//
// secciones: [{ _id, name, heads, divisions, courses }]; talleres: materias con esTaller.
// porMateria: Map courseId → { actividades, novedades, clasesEnVivo }
// items: [{ tipo, titulo, course, autor, fecha }] del período (ya con nombres)
// Devuelve una tarjeta por Sección, y "Sin sección" para los talleres que no están en ninguna.
function resumenPorSeccion({ secciones = [], talleres = [], porMateria = new Map(), items = [], nombres = new Map() }) {
  const vacio = { actividades: 0, novedades: 0, clasesEnVivo: 0 };
  const usadas = new Set();
  const tarjeta = (id, name, heads, materias) => {
    const ids = new Set(materias.map(m => str(m._id)));
    const tot = { ...vacio };
    for (const m of materias) {
      const c = porMateria.get(str(m._id)) || vacio;
      tot.actividades += c.actividades; tot.novedades += c.novedades; tot.clasesEnVivo += c.clasesEnVivo;
    }
    const meps = new Set(materias.flatMap(m => [m.owner, ...(m.coTeachers || [])].filter(Boolean).map(str)));
    return {
      id, name,
      jefes: (heads || []).map(h => nombres.get(str(h)) || 'Usuario eliminado'),
      materias: materias.map(m => ({ id: str(m._id), name: m.name, ...(porMateria.get(str(m._id)) || vacio) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
      cantidadMeps: meps.size,
      ...tot,
      ultimos: items.filter(i => ids.has(str(i.course))).sort((a, b) => b.fecha - a.fecha).slice(0, 8),
    };
  };
  const out = secciones.map(s => {
    const divs = new Set((s.divisions || []).map(str));
    const sueltas = new Set((s.courses || []).map(str));
    const materias = talleres.filter(m => sueltas.has(str(m._id)) || divs.has(str(m.division)));
    materias.forEach(m => usadas.add(str(m._id)));
    return tarjeta(str(s._id), s.name, s.heads, materias);
  });
  const sueltas = talleres.filter(m => !usadas.has(str(m._id)));
  if (sueltas.length) out.push(tarjeta('', 'Talleres sin sección', [], sueltas));
  return out;
}

module.exports = { PATRONES_TALLER, PERIODOS, sugerirTaller, jefesYMeps, ventanaDelPeriodo, resumenPorSeccion };
