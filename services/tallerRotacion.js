// Rotación de grupos de taller — F4 de specs/jefe-de-taller.spec.md.
//
// Funciones puras (sin base): los períodos de una rotación, el calendario circular, las
// validaciones de grupos y de calendario, y "qué le toca hoy" a un alumno o a un MEP.
// Las fechas son 'YYYY-MM-DD' de calendario (hora de Argentina) y se operan en UTC a
// mediodía para que la zona de la máquina no corra un día.

const str = (x) => (x == null ? '' : String(x));
const FECHA_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const CAMBIA_CADA = ['semana', 'quincena', 'mes', 'manual'];
const MAX_PERIODOS = 60;
const MAX_DIAS = 400;          // RN-F4-7
const MAX_GRUPOS = 12;         // RN-F4-1
const MAX_NOMBRE_GRUPO = 40;
const MAX_NOMBRE_ROTACION = 80;
const MAX_ESTACIONES = 20;

const aUTC = (f) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const deUTC = (d) => d.toISOString().slice(0, 10);
const sumarDias = (f, n) => { const d = aUTC(f); d.setUTCDate(d.getUTCDate() + n); return deUTC(d); };
const esFecha = (f) => FECHA_RE.test(str(f)) && deUTC(aUTC(f)) === f;
const diasEntre = (a, b) => Math.round((aUTC(b) - aUTC(a)) / 86400000);
const domingoDe = (f) => sumarDias(f, (7 - aUTC(f).getUTCDay()) % 7);
const finDeMes = (f) => { const d = aUTC(f); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return deUTC(d); };

// JT-20. { desde, hasta, cambiaCada, cortes } → { periodos: [{ desde, hasta }] } o { error }.
function armarPeriodos({ desde, hasta, cambiaCada, cortes = [] }) {
  if (!esFecha(desde) || !esFecha(hasta)) return { error: 'Las fechas de inicio y fin no son válidas.' };
  if (hasta < desde) return { error: 'La fecha de fin es anterior a la de inicio.' };
  if (diasEntre(desde, hasta) > MAX_DIAS) return { error: `Una rotación puede durar como mucho ${MAX_DIAS} días.` };
  if (!CAMBIA_CADA.includes(cambiaCada)) return { error: 'Elegí cada cuánto cambian los grupos.' };

  const periodos = [];
  if (cambiaCada === 'manual') {
    const inicios = [desde, ...[...new Set((Array.isArray(cortes) ? cortes : []).map(str).filter(esFecha))]
      .filter(c => c > desde && c <= hasta).sort()];
    inicios.forEach((ini, i) => periodos.push({ desde: ini, hasta: i + 1 < inicios.length ? sumarDias(inicios[i + 1], -1) : hasta }));
  } else {
    let ini = desde;
    while (ini <= hasta) {
      let fin;
      if (cambiaCada === 'semana') fin = domingoDe(ini);
      else if (cambiaCada === 'quincena') fin = periodos.length ? sumarDias(ini, 13) : sumarDias(domingoDe(ini), 7);
      else fin = finDeMes(ini);
      if (fin > hasta) fin = hasta;
      periodos.push({ desde: ini, hasta: fin });
      if (periodos.length > MAX_PERIODOS) break;
      ini = sumarDias(fin, 1);
    }
  }
  if (periodos.length > MAX_PERIODOS) return { error: `Quedan más de ${MAX_PERIODOS} períodos: acortá las fechas o cambiá cada más tiempo.` };
  return { periodos };
}

// Las estaciones repetidas en un período que no admiten más de un grupo (RN-F4-2).
function choques(asignacion, estaciones) {
  const admite = new Map(estaciones.map(e => [str(e._id), !!e.admiteVarios]));
  const cuenta = new Map();
  for (const a of asignacion) {
    if (a.estacion == null) continue;
    const k = str(a.estacion);
    cuenta.set(k, (cuenta.get(k) || 0) + 1);
  }
  return [...cuenta].filter(([k, n]) => n > 1 && !admite.get(k)).map(([k]) => k);
}

const nombreEstacion = (estaciones, id) => (estaciones.find(e => str(e._id) === str(id)) || {}).nombre || 'una estación';

// JT-21. El calendario circular: en el período p, el grupo i va a la estación (i + p) mod m.
// grupos: [id] en orden; estaciones: [{ _id, nombre, admiteVarios }] en orden.
function generarCalendario({ periodos = [], grupos = [], estaciones = [] }) {
  if (!estaciones.length) return { error: 'Elegí al menos una estación.' };
  if (!grupos.length) return { error: 'Este curso todavía no tiene grupos: armalos primero.' };
  const m = estaciones.length;
  const out = periodos.map((p, pi) => ({
    desde: p.desde, hasta: p.hasta,
    asignacion: grupos.map((g, gi) => ({ grupo: g, estacion: estaciones[(gi + pi) % m]._id })),
  }));
  const primero = out[0] ? choques(out[0].asignacion, estaciones) : [];
  if (primero.length) {
    return { error: `Hay más grupos (${grupos.length}) que estaciones (${m}): dos grupos caerían juntos en ${nombreEstacion(estaciones, primero[0])}. Sumá estaciones o marcá alguna que admita más de un grupo.` };
  }
  for (const p of out) {
    const c = choques(p.asignacion, estaciones);
    if (c.length) return { error: `Dos grupos caerían juntos en ${nombreEstacion(estaciones, c[0])} (del ${p.desde} al ${p.hasta}).` };
  }
  return { periodos: out };
}

// JT-22. Las correcciones a mano. entrada: [{ asignacion: [{ grupo, estacion | null }] }], una por
// período guardado. Devuelve { periodos } (con las fechas guardadas) o { error }.
function validarCalendario({ entrada, periodosGuardados = [], grupos = [], estaciones = [] }) {
  if (!Array.isArray(entrada) || entrada.length !== periodosGuardados.length) {
    return { error: 'El calendario no coincide con los períodos de la rotación. Recargá la página.' };
  }
  const gruposOk = new Set(grupos.map(str));
  const estOk = new Set(estaciones.map(e => str(e._id)));
  const periodos = [];
  for (let i = 0; i < entrada.length; i++) {
    const p = periodosGuardados[i];
    const lista = Array.isArray(entrada[i] && entrada[i].asignacion) ? entrada[i].asignacion : [];
    const vistos = new Set();
    const asignacion = [];
    for (const a of lista) {
      const g = str(a && a.grupo);
      const e = a && a.estacion != null && a.estacion !== '' ? str(a.estacion) : null;
      if (!gruposOk.has(g)) return { error: 'Hay un grupo que ya no existe. Recargá la página.' };
      if (vistos.has(g)) return { error: 'Un grupo aparece dos veces en el mismo período.' };
      if (e !== null && !estOk.has(e)) return { error: 'Hay una estación que no es de esta rotación.' };
      vistos.add(g);
      asignacion.push({ grupo: g, estacion: e });
    }
    const c = choques(asignacion, estaciones);
    if (c.length) return { error: `Del ${p.desde} al ${p.hasta} hay dos grupos en ${nombreEstacion(estaciones, c[0])}, que admite uno solo.` };
    periodos.push({ desde: p.desde, hasta: p.hasta, asignacion });
  }
  return { periodos };
}

// JT-23. entrada: [{ id?, nombre, alumnos: [id] }]; alumnosDivision: ids válidos.
// Devuelve { grupos: [{ id | null, nombre, alumnos }] } o { error }.
function validarGrupos(entrada, alumnosDivision = []) {
  if (!Array.isArray(entrada) || !entrada.length) return { error: 'Tiene que haber al menos un grupo.' };
  if (entrada.length > MAX_GRUPOS) return { error: `Como mucho ${MAX_GRUPOS} grupos.` };
  const validos = new Set(alumnosDivision.map(str));
  const usados = new Set();
  const nombres = new Set();
  const grupos = [];
  for (const g of entrada) {
    const nombre = str(g && g.nombre).trim();
    if (!nombre || nombre.length > MAX_NOMBRE_GRUPO) return { error: `Cada grupo necesita un nombre de 1 a ${MAX_NOMBRE_GRUPO} letras.` };
    const clave = nombre.toLowerCase();
    if (nombres.has(clave)) return { error: `Hay dos grupos llamados "${nombre}".` };
    nombres.add(clave);
    const alumnos = [];
    for (const a of Array.isArray(g.alumnos) ? g.alumnos : []) {
      const id = str(a);
      if (!validos.has(id)) return { error: 'Hay un alumno que no es de este curso. Recargá la página.' };
      if (usados.has(id)) return { error: 'Un alumno está en dos grupos: cada alumno va en uno solo.' };
      usados.add(id);
      alumnos.push(id);
    }
    grupos.push({ id: g.id ? str(g.id) : null, nombre, alumnos });
  }
  return { grupos };
}

// Lo que llega del formulario de "Nueva rotación". talleresDivision: [{ _id, name }].
function validarRotacion(body = {}, talleresDivision = []) {
  const nombre = str(body.nombre).trim();
  if (!nombre || nombre.length > MAX_NOMBRE_ROTACION) return { error: `Poné un nombre de 1 a ${MAX_NOMBRE_ROTACION} letras.` };
  const r = armarPeriodos({ desde: body.desde, hasta: body.hasta, cambiaCada: body.cambiaCada, cortes: body.cortes });
  if (r.error) return r;
  const talleres = new Map(talleresDivision.map(t => [str(t._id), t]));
  const lista = Array.isArray(body.estaciones) ? body.estaciones : [];
  if (!lista.length) return { error: 'Elegí al menos una estación.' };
  if (lista.length > MAX_ESTACIONES) return { error: `Como mucho ${MAX_ESTACIONES} estaciones.` };
  const estaciones = [];
  for (const e of lista) {
    const t = talleres.get(str(e && e.course));
    if (!t) return { error: 'Cada estación tiene que ser un taller de este curso.' };
    const n = str(e.nombre).trim() || t.name;
    estaciones.push({ nombre: n.slice(0, 80), course: str(t._id), admiteVarios: !!e.admiteVarios });
  }
  return { nombre, desde: body.desde, hasta: body.hasta, cambiaCada: body.cambiaCada, periodos: r.periodos, estaciones };
}

const periodoDeHoy = (rotacion, hoy) => (rotacion.periodos || []).findIndex(p => p.desde <= hoy && hoy <= p.hasta);

// JT-24. Lo que se muestra en la materia (RN-F4-4).
//   rotaciones: las de la división que tienen a courseId como estación.
//   grupos: el doc GruposTaller de la división ({ grupos: [{ _id, nombre, alumnos }] }) o null.
// Alumno → { rotacion, desde, hasta, grupo, estacion: { nombre, course } | null } o null.
// MEP    → { rotacion, desde, hasta, grupos: [{ nombre, alumnos }] } o null.
function queLeToca({ rotaciones = [], grupos = null, courseId, userId, esAlumno, hoy }) {
  const lista = (grupos && grupos.grupos) || [];
  const nombreGrupo = new Map(lista.map(g => [str(g._id), g]));
  for (const rot of rotaciones) {
    const suyas = (rot.estaciones || []).filter(e => str(e.course) === str(courseId));
    if (!suyas.length) continue;
    const i = periodoDeHoy(rot, hoy);
    if (i < 0) continue;
    const p = rot.periodos[i];
    const base = { rotacion: rot.nombre, desde: p.desde, hasta: p.hasta };
    if (esAlumno) {
      const g = lista.find(x => (x.alumnos || []).some(a => str(a) === str(userId)));
      if (!g) return null;
      const a = (p.asignacion || []).find(x => str(x.grupo) === str(g._id));
      const e = a && a.estacion != null ? (rot.estaciones || []).find(x => str(x._id) === str(a.estacion)) : null;
      return { ...base, grupo: g.nombre, estacion: e ? { nombre: e.nombre, course: str(e.course) } : null };
    }
    const ids = new Set(suyas.map(e => str(e._id)));
    const gs = (p.asignacion || []).filter(a => a.estacion != null && ids.has(str(a.estacion)))
      .map(a => nombreGrupo.get(str(a.grupo))).filter(Boolean)
      .map(g => ({ nombre: g.nombre, alumnos: (g.alumnos || []).length }));
    return { ...base, grupos: gs };
  }
  return null;
}

module.exports = {
  CAMBIA_CADA, MAX_PERIODOS, MAX_GRUPOS, MAX_DIAS,
  esFecha, armarPeriodos, generarCalendario, validarCalendario, validarGrupos, validarRotacion,
  periodoDeHoy, queLeToca, choques,
};
