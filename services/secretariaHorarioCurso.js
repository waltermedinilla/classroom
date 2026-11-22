// Horario del curso — fase 3 del panel de la Secretaria.
// Ver specs/secretaria-horario-del-curso.spec.md.
//
// Funciones PURAS (sin Mongo, sin req, sin Date.now()). La ruta junta los documentos.
//
// ⭐ No hay datos nuevos (D1): la grilla del curso es otra forma de ver Course.horarioClases,
// el mismo campo que carga la solapa "Horario de materias". Cargar desde la grilla escribe ahí.
//
// ⭐ La forma de `grillaDelCurso` es la que va a usar la comparación con los horarios de la
// otra plataforma (D5): celda por celda, [turno][orden][dia] → materias. No cambiarla a la ligera.
//
// Las horas se comparan en MINUTOS DEL DÍA con live.hora(), igual que la fase 2 (RH-06).

const live = require('./liveRoom');
const grillaSvc = require('./recursos/horario');
const { diaSemana, TOLERANCIA_MIN } = require('./secretariaPuntualidad');

// RH-05: para las clases que no son la primera del día, cuenta la sala de esa materia desde
// 30 minutos antes del inicio del módulo hasta su fin.
const VENTANA_ANTES_MIN = 30;

const str = (x) => (x == null ? '' : String(x));
const minutosDe = (d) => grillaSvc.aMinutos(live.hora(new Date(d)));
const clave = (dia, turno, orden) => `${dia}|${turno}|${orden}`;

// Nombre como en la otra plataforma: mayúsculas sostenidas (pregunta abierta 2, aprobada).
// No es una fecha: toLocaleUpperCase acá está bien.
const enMayusculas = (s) => str(s).toLocaleUpperCase('es-AR');

// ── La grilla ────────────────────────────────────────────────────────────────────────────────

// materias: [{ id, name, horarioClases, docentes: [{ id, name }] }] — las del curso.
// Devuelve { dias, turnos: [{ id, label, modulos: [{ orden, label, desde, hasta,
//   celdas: { [dia]: { materias: [{ materiaId, materia, docentes }], doble } } }] }] }.
// Una entrada que apunta a un módulo que ya no existe no aparece (RP-03 / CH-03).
function grillaDelCurso({ grilla, materias = [] }) {
  if (!grillaSvc.horarioCargado(grilla)) return null;
  const dias = (grilla.dias || []).map(Number).sort((a, b) => a - b);

  const porCelda = new Map();
  for (const m of materias) {
    for (const e of m.horarioClases || []) {
      if (!grillaSvc.moduloDe(grilla, e.turno, e.orden)) continue;
      const k = clave(Number(e.dia), e.turno, Number(e.orden));
      if (!porCelda.has(k)) porCelda.set(k, []);
      const lista = porCelda.get(k);
      if (lista.some(x => x.materiaId === str(m.id))) continue;
      lista.push({
        materiaId: str(m.id),
        materia: m.name || '',
        docentes: (m.docentes || []).map(d => ({ id: str(d.id), name: enMayusculas(d.name) })),
      });
    }
  }

  const turnos = grilla.turnos
    .map(t => ({
      id: t.id, label: t.label,
      modulos: grillaSvc.modulosDeClase(t).map(f => {
        const celdas = {};
        for (const d of dias) {
          const lista = porCelda.get(clave(d, t.id, f.orden)) || [];
          lista.sort((a, b) => a.materia.localeCompare(b.materia, 'es'));
          celdas[d] = { materias: lista, doble: lista.length > 1 };   // CH-02 / D2
        }
        return { orden: f.orden, label: f.label, desde: f.desde, hasta: f.hasta, celdas };
      }),
    }))
    .filter(t => t.modulos.length);

  return { dias, turnos };
}

// ── Choques (D6) ─────────────────────────────────────────────────────────────────────────────

// otras: las clases de los docentes del curso en OTRAS materias de la escuela:
//   [{ docenteId, docente, materiaId, materia, curso, enAlcance, horarioClases }]
// Devuelve un Map clave(dia, turno, orden) → [texto], para las celdas del curso.
// D4: un curso fuera del alcance no se nombra.
function choques({ grillaCurso, otras = [] }) {
  const res = new Map();
  if (!grillaCurso) return res;
  const ocupado = new Map();   // `${docenteId}|${clave}` → [descripciones]
  for (const o of otras) {
    for (const e of o.horarioClases || []) {
      const k = `${str(o.docenteId)}|${clave(Number(e.dia), e.turno, Number(e.orden))}`;
      if (!ocupado.has(k)) ocupado.set(k, []);
      ocupado.get(k).push({
        materiaId: str(o.materiaId),
        texto: o.enAlcance ? `${o.materia} en ${o.curso}` : 'otro curso',
      });
    }
  }
  for (const t of grillaCurso.turnos) {
    for (const m of t.modulos) {
      for (const [dia, celda] of Object.entries(m.celdas)) {
        const k = clave(Number(dia), t.id, m.orden);
        const avisos = [];
        for (const mat of celda.materias) {
          for (const d of mat.docentes) {
            for (const otro of ocupado.get(`${d.id}|${k}`) || []) {
              if (otro.materiaId === mat.materiaId) continue;
              avisos.push(`${d.name} tiene clase en ${otro.texto} a esta hora`);
            }
          }
        }
        if (avisos.length) res.set(k, [...new Set(avisos)]);
      }
    }
  }
  return res;
}

// ── Carga (RH-02) ────────────────────────────────────────────────────────────────────────────

// Pone `courseId` en la celda y la saca de las demás materias del curso (D2). Con null, la
// vacía. Devuelve SOLO las materias que cambiaron: [{ id, horarioClases }].
function aplicarCelda(materias = [], { dia, turno, orden }, courseId) {
  const k = clave(Number(dia), turno, Number(orden));
  const cambios = [];
  for (const m of materias) {
    const actual = (m.horarioClases || []).map(e => ({ dia: Number(e.dia), turno: e.turno, orden: Number(e.orden) }));
    const tiene = actual.some(e => clave(e.dia, e.turno, e.orden) === k);
    const debe = courseId != null && str(m.id) === str(courseId);
    if (tiene === debe) continue;
    const nuevo = debe
      ? [...actual, { dia: Number(dia), turno, orden: Number(orden) }]
      : actual.filter(e => clave(e.dia, e.turno, e.orden) !== k);
    nuevo.sort((a, b) => a.dia - b.dia || a.turno.localeCompare(b.turno) || a.orden - b.orden);
    cambios.push({ id: str(m.id), horarioClases: nuevo });
  }
  return cambios;
}

// ── Control por clase (D3) ───────────────────────────────────────────────────────────────────

// La primera clase del día de un docente, entre TODAS sus materias de la escuela.
// materiasDelDocente: [{ horarioClases }]. Devuelve el inicio en minutos, o null.
function primerInicioDelDia({ fecha, grilla, materiasDelDocente = [] }) {
  const dia = diaSemana(fecha);
  let min = null;
  for (const m of materiasDelDocente) {
    for (const e of m.horarioClases || []) {
      if (Number(e.dia) !== dia) continue;
      const f = grillaSvc.moduloDe(grilla, e.turno, e.orden);
      if (!f) continue;
      const ini = grillaSvc.aMinutos(f.desde);
      if (min == null || ini < min) min = ini;
    }
  }
  return min;
}

// La llegada del día de un docente: lo primero entre su ingreso a la plataforma (si ese día
// ya se registraba) y su primera entrada a cualquier sala. En minutos, o null.
function llegadaDelDia({ fecha, ingreso, presencias = [], hayDatoIngreso = true }) {
  const ts = [];
  if (hayDatoIngreso && ingreso && ingreso.primeraVez) ts.push(new Date(ingreso.primeraVez));
  for (const p of presencias) if (p.firstSeenAt) ts.push(new Date(p.firstSeenAt));
  const delDia = ts.filter(d => live.diaEscolar(d) === fecha);
  if (!delDia.length) return null;
  return minutosDe(Math.min(...delDia.map(d => d.getTime())));
}

const hhmm = (min) => grillaSvc.aHHMM(min);

// RH-05. Estado de UNA clase de UN docente.
//   clase:   { materiaId, desde, hasta } (HH:MM de la grilla)
//   esPrimera: es su primera clase del día
//   llegada: minutos de su llegada del día (llegadaDelDia), o null
//   presencias: sus RoomPresence del día ({ course, firstSeenAt })
//   esHoy / ahoraMin: para marcar las clases que todavía no empezaron
function puntualidadDeClase({ clase, fecha, esPrimera, llegada, presencias = [], esHoy = false, ahoraMin = 0, tolerancia = TOLERANCIA_MIN }) {
  const inicio = grillaSvc.aMinutos(clase.desde);
  const fin = grillaSvc.aMinutos(clase.hasta);
  if (esHoy && ahoraMin < inicio) return { estado: 'futura', texto: 'Todavía no empezó' };

  let llego = null;
  let origen = '';
  if (esPrimera && llegada != null) {
    llego = llegada; origen = 'Llegó';
  } else {
    // Solo la sala de ESTA materia, dentro de la ventana (CH-08 a CH-10).
    const enVentana = presencias
      .filter(p => str(p.course && (p.course._id || p.course)) === str(clase.materiaId))
      .filter(p => p.firstSeenAt && live.diaEscolar(new Date(p.firstSeenAt)) === fecha)
      .map(p => minutosDe(p.firstSeenAt))
      .filter(m => m >= inicio - VENTANA_ANTES_MIN && m <= fin);
    if (enVentana.length) { llego = Math.min(...enVentana); origen = 'Sala'; }
  }
  if (llego == null) return { estado: 'sinDato', texto: 'Sin dato de esta clase' };

  const minutos = llego - inicio;
  return minutos <= tolerancia
    ? { estado: 'aTiempo', minutos, texto: `${origen} ${hhmm(llego)}` }
    : { estado: 'tarde', minutos, texto: `${origen} ${hhmm(llego)} · ${minutos} min tarde` };
}

// El color de la celda cuando hay más de un docente: el mejor estado gana.
const ORDEN_ESTADO = { aTiempo: 0, tarde: 1, sinDato: 2, futura: 3 };
function mejorEstado(estados = []) {
  return estados.reduce((a, b) => (ORDEN_ESTADO[b] < ORDEN_ESTADO[a] ? b : a), 'futura');
}

module.exports = {
  VENTANA_ANTES_MIN,
  enMayusculas, grillaDelCurso, choques, aplicarCelda,
  primerInicioDelDia, llegadaDelDia, puntualidadDeClase, mejorEstado,
};
