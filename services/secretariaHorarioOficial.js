// Comparar con el horario oficial — fase 4 del panel de la Secretaria.
// Ver specs/secretaria-horario-oficial.spec.md.
//
// Funciones PURAS (sin Mongo, sin req). La ruta junta los documentos.
//
// ⭐ Solo COMPARA (decisión de Walter): nada de acá escribe horarios, materias ni docentes.

const grillaSvc = require('./recursos/horario');

const str = (x) => (x == null ? '' : String(x));
const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const min = (h) => grillaSvc.aMinutos(h);

// ── Normalización ────────────────────────────────────────────────────────────────────────────

const sinAcentos = (s) => str(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
const palabras = (s) => sinAcentos(s).toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').split(/\s+/).filter(Boolean);

// ── El documento (HO-01) ─────────────────────────────────────────────────────────────────────

const LIMITE_CURSOS = 200;
const LIMITE_ENTRADAS = 400;

// Devuelve { cursos, errores }. Con errores, `cursos` no se usa: se importa todo o nada.
function validarDocumento(doc) {
  const errores = [];
  if (!doc || typeof doc !== 'object') return { cursos: [], errores: ['El archivo no es un JSON válido.'] };
  if (doc.tipo !== 'horario-oficial') errores.push('El archivo no es un horario oficial (falta "tipo": "horario-oficial").');
  if (!Array.isArray(doc.cursos) || !doc.cursos.length) errores.push('El archivo no tiene cursos.');
  if (errores.length) return { cursos: [], errores };
  if (doc.cursos.length > LIMITE_CURSOS) return { cursos: [], errores: [`Demasiados cursos (más de ${LIMITE_CURSOS}).`] };

  const vistos = new Set();
  const cursos = doc.cursos.map((c, i) => {
    const nombre = `Curso ${c && c.curso}° ${String(c && c.division).padStart(2, '0')}°`;
    const curso = Number(c && c.curso), division = Number(c && c.division);
    if (!Number.isInteger(curso) || curso < 1 || curso > 9) errores.push(`Curso ${i + 1}: el curso tiene que ser un número de 1 a 9.`);
    if (!Number.isInteger(division) || division < 1 || division > 99) errores.push(`Curso ${i + 1}: la división tiene que ser un número de 1 a 99.`);
    const k = `${curso}|${division}`;
    if (vistos.has(k)) errores.push(`${nombre}: está repetido.`);
    vistos.add(k);
    const entradas = Array.isArray(c && c.entradas) ? c.entradas : [];
    if (entradas.length > LIMITE_ENTRADAS) errores.push(`${nombre}: demasiados renglones.`);
    const limpias = entradas.map((e, j) => {
      const donde = `${nombre}, renglón ${j + 1}`;
      const dia = Number(e && e.dia);
      if (!grillaSvc.DIAS_VALIDOS.includes(dia)) errores.push(`${donde}: el día tiene que ser de 1 (lunes) a 6 (sábado).`);
      const desde = str(e && e.desde), hasta = str(e && e.hasta);
      if (!HORA_RE.test(desde) || !HORA_RE.test(hasta)) errores.push(`${donde}: falta el horario o está mal escrito (HH:MM).`);
      else if (min(desde) >= min(hasta)) errores.push(`${donde}: el horario termina antes de empezar.`);
      return {
        hora: Number.isFinite(Number(e && e.hora)) ? Number(e.hora) : null,
        dia, desde, hasta,
        materia: str(e && e.materia).trim().slice(0, 160),
        docente: str(e && e.docente).trim().slice(0, 160),
        nota: str(e && e.nota).trim().slice(0, 40),
      };
    });
    return {
      curso, division,
      turno: str(c.turno).trim().slice(0, 40),
      carrera: str(c.carrera).trim().slice(0, 160),
      notas: Array.isArray(c.notas) ? c.notas.map(n => str(n).slice(0, 300)) : [],
      entradas: limpias,
    };
  });
  return { cursos, errores };
}

// ── Curso y división (D2 / HO-02) ────────────────────────────────────────────────────────────

// "1° 1°", "1°1", "1ro 1ra", "1° 01°" → [1, 1]. Sin dos números, null.
function numerosDeDivision(nombre) {
  const n = str(nombre).match(/\d+/g);
  if (!n || n.length < 2) return null;
  return [Number(n[0]), Number(n[1])];
}

// divisiones: [{ id, name }]. Devuelve el id de la división de la plataforma, o null.
function divisionDe({ curso, division }, divisiones = []) {
  const d = divisiones.find(x => {
    const n = numerosDeDivision(x.name);
    return n && n[0] === curso && n[1] === division;
  });
  return d ? str(d.id) : null;
}

// ── Materia (D5 / HO-04) ─────────────────────────────────────────────────────────────────────

function claveMateria(nombre) {
  let p = palabras(nombre);
  // "Ciencias Sociales: Geografía" → "geografia"; "Lengua Extranjera - Inglés" → "lengua extranjera".
  if (p[0] === 'ciencias' && p[1] === 'sociales' && p.length > 2) p = p.slice(2);
  if (p[0] === 'lengua' && p[1] === 'extranjera') p = p.filter(x => x !== 'ingles');
  return p;
}

const contiene = (a, b) => b.length > 0 && b.every(x => a.includes(x));

function coincideMateria(oficial, plataforma) {
  const a = claveMateria(oficial), b = claveMateria(plataforma);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  // Uno contiene al otro, palabra por palabra. Pero "lengua" no es "lengua extranjera": el más
  // corto tiene que tener al menos dos palabras para valer por contención.
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return corto.length >= 2 && contiene(largo, corto);
}

// ── Docente (D6 / HO-03) ─────────────────────────────────────────────────────────────────────

const palabrasNombre = (s) => sinAcentos(s).toUpperCase().replace(/[^A-Z0-9Ñ' ]+/g, ' ').split(/\s+/).filter(Boolean);

// 'exacto' | 'parecido' | null
function comparaNombres(oficial, plataforma) {
  const a = palabrasNombre(oficial), b = palabrasNombre(plataforma);
  if (!a.length || !b.length) return null;
  const A = new Set(a), B = new Set(b);
  if (A.size === B.size && [...A].every(x => B.has(x))) return 'exacto';
  // El apellido (primera palabra del oficial) TIENE que estar: el nombre de pila solo no alcanza
  // ("NAVARRO MARIA LAURA" no es "VASQUEZ MARIA LAURA").
  if (!B.has(a[0])) return null;
  const compartidas = a.filter(x => B.has(x)).length;
  if (compartidas >= 2) return 'parecido';
  if (b.every(x => A.has(x)) || a.every(x => B.has(x))) return 'parecido';
  return null;
}

// usuarios: [{ id, name }]. Devuelve { estado: 'exacto'|'parecido'|'no', usuario }.
// Si hay un exacto, gana; si hay varios parecidos, el primero (y se avisa igual).
function coincideDocente(nombreOficial, usuarios = []) {
  let parecido = null;
  for (const u of usuarios) {
    const r = comparaNombres(nombreOficial, u.name);
    if (r === 'exacto') return { estado: 'exacto', usuario: u };
    if (r === 'parecido' && !parecido) parecido = u;
  }
  return parecido ? { estado: 'parecido', usuario: parecido } : { estado: 'no', usuario: null };
}

// ── Módulos que cubre un renglón (D3 / HO-05) ────────────────────────────────────────────────

// Devuelve [{ turno, orden, desde, hasta }] de la grilla de la escuela que se superponen con
// [desde, hasta) en al menos la mitad del módulo.
function modulosQueCubre(grilla, desde, hasta) {
  if (!grillaSvc.horarioCargado(grilla)) return [];
  const d = min(desde), h = min(hasta);
  const out = [];
  for (const t of grilla.turnos) {
    for (const f of grillaSvc.modulosDeClase(t)) {
      const fd = min(f.desde), fh = min(f.hasta);
      const solapa = Math.min(h, fh) - Math.max(d, fd);
      if (solapa > 0 && solapa * 2 >= (fh - fd)) out.push({ turno: t.id, orden: f.orden, desde: f.desde, hasta: f.hasta });
    }
  }
  return out;
}

// ── La comparación de un curso (D4 / HO-06) ──────────────────────────────────────────────────

const ORDEN_PEOR = ['falta', 'otraMateria', 'otroDocente', 'docenteParecido', 'coincide'];
const peor = (estados) => ORDEN_PEOR.find(e => estados.includes(e)) || 'coincide';

// oficial: { entradas } (un curso validado).
// grilla: el Horario de la escuela.
// materias: las del curso en la plataforma: [{ id, name, horarioClases, docentes: [{ id, name }] }].
// Devuelve { filas, sobran, resumen }.
function compararCurso({ oficial, grilla, materias = [] }) {
  // Qué hay en cada celda de la plataforma: clave dia|turno|orden → [materia]
  const enCelda = new Map();
  for (const m of materias) {
    for (const e of m.horarioClases || []) {
      const k = `${Number(e.dia)}|${e.turno}|${Number(e.orden)}`;
      if (!enCelda.has(k)) enCelda.set(k, []);
      if (!enCelda.get(k).includes(m)) enCelda.get(k).push(m);
    }
  }
  const usadas = new Set();

  const filas = (oficial.entradas || []).map(e => {
    const base = { ...e, plataforma: [], estado: '', docenteEn: null };
    if (!e.materia) return { ...base, estado: 'sinMateria' };
    const mods = modulosQueCubre(grilla, e.desde, e.hasta);
    if (!mods.length) return { ...base, estado: 'sinModulo' };

    const estados = [];
    const vistas = [];
    let docenteEn = null;
    for (const mod of mods) {
      const k = `${e.dia}|${mod.turno}|${mod.orden}`;
      const lista = enCelda.get(k) || [];
      if (!lista.length) { estados.push('falta'); continue; }
      const misma = lista.find(m => coincideMateria(e.materia, m.name));
      for (const m of lista) if (!vistas.includes(m)) vistas.push(m);
      if (!misma) { estados.push('otraMateria'); continue; }
      usadas.add(`${k}|${misma.id}`);
      if (!e.docente) { estados.push('coincide'); continue; }
      const d = coincideDocente(e.docente, misma.docentes || []);
      if (d.estado === 'exacto') estados.push('coincide');
      else if (d.estado === 'parecido') { estados.push('docenteParecido'); docenteEn = d.usuario.name; }
      else estados.push('otroDocente');
    }
    // Las otras materias de esas celdas también "se usaron": ya se muestran en este renglón.
    for (const mod of mods) {
      for (const m of enCelda.get(`${e.dia}|${mod.turno}|${mod.orden}`) || []) usadas.add(`${e.dia}|${mod.turno}|${mod.orden}|${m.id}`);
    }
    return {
      ...base,
      estado: peor(estados),
      docenteEn,
      plataforma: vistas.map(m => ({ materia: m.name, docentes: (m.docentes || []).map(d => d.name) })),
    };
  });

  // Lo que la plataforma tiene y el oficial no (en celdas que ningún renglón cubrió).
  const sobran = [];
  for (const m of materias) {
    for (const e of m.horarioClases || []) {
      const k = `${Number(e.dia)}|${e.turno}|${Number(e.orden)}`;
      if (usadas.has(`${k}|${m.id}`)) continue;
      const mod = grillaSvc.moduloDe(grilla, e.turno, e.orden);
      if (!mod) continue;
      sobran.push({ dia: Number(e.dia), turno: e.turno, orden: Number(e.orden), desde: mod.desde, hasta: mod.hasta,
        materia: m.name, docentes: (m.docentes || []).map(d => d.name) });
    }
  }
  sobran.sort((a, b) => a.dia - b.dia || a.desde.localeCompare(b.desde));

  const cuenta = (est) => filas.filter(f => f.estado === est).length;
  const resumen = {
    renglones: filas.length,
    coincide: cuenta('coincide'),
    diferencias: cuenta('falta') + cuenta('otraMateria') + cuenta('otroDocente') + sobran.length,
    parecidos: cuenta('docenteParecido'),
    informativos: cuenta('sinModulo') + cuenta('sinMateria'),
    sobran: sobran.length,
  };
  return { filas, sobran, resumen };
}

// ── Docentes del oficial contra los de la escuela (D6, resumen) ──────────────────────────────

// cursos: los oficiales; usuarios: los docentes de la escuela [{ id, name }].
// Devuelve { faltan: [nombre], parecidos: [{ oficial, plataforma }] }, ordenados.
function docentesDelOficial(cursos = [], usuarios = []) {
  const nombres = [...new Set(cursos.flatMap(c => (c.entradas || []).map(e => e.docente).filter(Boolean)))];
  const faltan = [], parecidos = [];
  for (const n of nombres) {
    const r = coincideDocente(n, usuarios);
    if (r.estado === 'no') faltan.push(n);
    else if (r.estado === 'parecido') parecidos.push({ oficial: n, plataforma: r.usuario.name });
  }
  const orden = (a, b) => sinAcentos(a).localeCompare(sinAcentos(b), 'es');
  faltan.sort(orden);
  parecidos.sort((a, b) => orden(a.oficial, b.oficial));
  return { faltan, parecidos };
}

const ETIQUETA_ESTADO = {
  coincide: 'Coincide',
  docenteParecido: '¿Mismo docente?',
  otroDocente: 'Otro docente',
  otraMateria: 'Otra materia',
  falta: 'No está cargado',
  sinModulo: 'Fuera de la grilla',
  sinMateria: 'Sin materia',
};

module.exports = {
  validarDocumento, numerosDeDivision, divisionDe,
  claveMateria, coincideMateria, comparaNombres, coincideDocente,
  modulosQueCubre, compararCurso, docentesDelOficial,
  ETIQUETA_ESTADO, ORDEN_PEOR,
};
