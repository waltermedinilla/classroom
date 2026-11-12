// Puntualidad del docente — fase 2 del panel de la Secretaria.
// Ver specs/secretaria-puntualidad.spec.md.
//
// Funciones PURAS, igual que services/secretariaDia.js: sin Mongo, sin req, sin Date.now().
//
// ⭐ La comparación se hace en MINUTOS DEL DÍA, en la zona de la escuela, y no armando un Date
// con "la fecha + 07:30": construir ese instante obliga a decidir el desfasaje a mano, que es
// exactamente cómo vuelve el bug de las tres horas. La hora de llegada se pasa a 'HH:MM' con
// live.hora() (la misma que usa toda la plataforma, la sala y el chat) y la del módulo ya es
// 'HH:MM' en la grilla (models/Horario.js).
//
// ⭐ Se mide la llegada del día contra la PRIMERA clase del día (D2): el ingreso a la plataforma
// se registra una vez por día, así que no sirve para saber si llegó a la clase de la tarde.

const live = require('./liveRoom');
const grillaSvc = require('./recursos/horario');

const TOLERANCIA_MIN = 10;   // RP-06

const ESTADOS = {
  sinClase:    null,                       // sin color, sin texto
  sinRegistro: 'Sin registro en su horario', // sin color (decisión de Walter)
  aTiempo:     'a tiempo',
  tarde:       'tarde',
};

// 'YYYY-MM-DD' → 1 (lunes) … 7 (domingo). Es un día de calendario, no un instante: se calcula
// con UTC a mediodía para que ninguna zona lo corra de día.
function diaSemana(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return w === 0 ? 7 : w;
}

// Normaliza y valida lo que llega del formulario contra la grilla de la escuela (RP-01, RP-02).
// Devuelve { ok, entradas } o { ok: false, error }.
function validarHorarioClases(entradas, grilla) {
  if (!grillaSvc.horarioCargado(grilla)) {
    return { ok: false, error: 'La escuela todavía no tiene cargada la grilla de módulos.' };
  }
  if (!Array.isArray(entradas)) return { ok: false, error: 'Horario inválido.' };
  if (entradas.length > 60) return { ok: false, error: 'Demasiados módulos para una materia.' };
  const dias = new Set((grilla.dias || []).map(Number));
  const vistos = new Set();
  const limpias = [];
  for (const e of entradas) {
    const dia = Number(e && e.dia);
    const turno = String(e && e.turno || '');
    const orden = Number(e && e.orden);
    if (!Number.isInteger(dia) || !dias.has(dia)) {
      return { ok: false, error: 'Ese día no está en el horario de la escuela.' };
    }
    if (!grillaSvc.moduloDe(grilla, turno, orden)) {
      return { ok: false, error: 'Ese módulo no existe en el horario de la escuela.' };
    }
    const clave = `${dia}|${turno}|${orden}`;
    if (vistos.has(clave)) continue;   // RP-02: el duplicado se descarta, no es un error
    vistos.add(clave);
    limpias.push({ dia, turno, orden });
  }
  limpias.sort((a, b) => a.dia - b.dia || a.turno.localeCompare(b.turno) || a.orden - b.orden);
  return { ok: true, entradas: limpias };
}

// Las clases de un día, con la franja resuelta contra la grilla. Una entrada que apunta a una
// franja que ya no existe se IGNORA (RP-03): la materia no se rompe por un cambio de grilla.
function clasesDelDia({ fecha, materias = [], grilla }) {
  if (!grillaSvc.horarioCargado(grilla)) return [];
  const dia = diaSemana(fecha);
  const clases = [];
  for (const m of materias) {
    for (const e of m.horarioClases || []) {
      if (Number(e.dia) !== dia) continue;
      const f = grillaSvc.moduloDe(grilla, e.turno, e.orden);
      if (!f) continue;
      const turno = grillaSvc.turnoDe(grilla, e.turno);
      clases.push({
        materia: m.name || '', materiaId: String(m.id || m._id || ''),
        turno: e.turno, turnoLabel: turno ? turno.label : '',
        orden: f.orden, label: f.label, desde: f.desde, hasta: f.hasta,
        inicio: grillaSvc.aMinutos(f.desde),
      });
    }
  }
  clases.sort((a, b) => a.inicio - b.inicio);
  return clases;
}

// RP-04. `senales` es lo que ya calculó services/secretariaDia.senalesDelDocente para ese
// docente y ese día (ingreso y salas recortados al día y al alcance).
function puntualidad({ fecha, materias = [], grilla, senales, hayDatoIngreso = true, tolerancia = TOLERANCIA_MIN }) {
  const clases = clasesDelDia({ fecha, materias, grilla });
  if (!clases.length) return { estado: 'sinClase', clases: [] };

  const primera = clases[0];

  // La llegada: lo primero que pasó entre el ingreso a la plataforma y la sala (decisión de
  // Walter: "cualquiera de las dos"). El ingreso solo cuenta si ese día ya se registraba (RP-07).
  const candidatos = [];
  if (hayDatoIngreso && senales && senales.ingreso && senales.ingreso.primeraVez) {
    candidatos.push(new Date(senales.ingreso.primeraVez));
  }
  for (const s of (senales && senales.sala && senales.sala.items) || []) {
    if (s.desde) candidatos.push(new Date(s.desde));
  }
  // Por las dudas: algo de otro día no puede ser la llegada de este (CP-09).
  const delDia = candidatos.filter(d => live.diaEscolar(d) === fecha);
  if (!delDia.length) return { estado: 'sinRegistro', clases, primera };

  const llego = new Date(Math.min(...delDia.map(d => d.getTime())));
  const llegoHHMM = live.hora(llego);
  const minutos = grillaSvc.aMinutos(llegoHHMM) - primera.inicio;   // RP-05

  return {
    estado: minutos <= tolerancia ? 'aTiempo' : 'tarde',
    clases, primera, llego, llegoHHMM, minutos,
  };
}

// El texto chico debajo del nombre (D3). El color nunca va solo.
function textoPuntualidad(p) {
  if (!p || p.estado === 'sinClase') return '';
  const clase = p.primera ? `Le tocaba ${p.primera.label}, ${p.primera.desde}` : '';
  if (p.estado === 'sinRegistro') return `${ESTADOS.sinRegistro} · ${clase}`;
  const llegada = p.estado === 'tarde'
    ? `Llegó ${p.llegoHHMM} · ${p.minutos} min tarde`
    : `Llegó ${p.llegoHHMM} · a tiempo`;
  return `${llegada} · ${clase}`;
}

module.exports = {
  TOLERANCIA_MIN, ESTADOS,
  diaSemana, validarHorarioClases, clasesDelDia, puntualidad, textoPuntualidad,
};
