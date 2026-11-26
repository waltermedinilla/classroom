// Lo que la plataforma le manda al proceso de medios cuando un docente toca Transmitir —
// specs/transmision-cupo-automatico.spec.md (D3, D4, RN-3, RN-4).
//
// El proceso de medios no tiene Mongo (D4 de transmision-en-vivo): no sabe si el docente tiene
// clase ahora, cuánto usa la sala ni cuántos alumnos suele tener. Eso se calcula acá y viaja
// en el pedido. La decisión (entra / espera / en qué lugar) la toma allá.

const Horario      = require('../models/Horario');
const Course       = require('../models/Course');
const RoomSession  = require('../models/RoomSession');
const RoomPresence = require('../models/RoomPresence');
const { clasesDelDia } = require('./secretariaPuntualidad');
const { fechaDe } = require('./secretariaDia');
const { CUPO } = require('../config/transmision');

const DIA_MS = 24 * 60 * 60 * 1000;
// Un docente "tiene clase ahora" desde 10 minutos antes de su módulo hasta que termina.
const ANTES_MIN = 10;
const VENTANA_CONECTADO_MS = 45 * 1000;

// Minutos del día en Argentina (UTC-3, sin horario de verano).
const minutosAR = (d) => { const x = new Date(d.getTime() - 3 * 60 * 60 * 1000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

// D4. ¿La materia tiene un módulo ahora según su horario (Course.horarioClases + la grilla)?
// Pura: recibe la grilla ya leída.
function tieneClaseAhora({ course, grilla, ahora = new Date() }) {
  const clases = clasesDelDia({ fecha: fechaDe(ahora), materias: [course], grilla });
  const m = minutosAR(ahora);
  return clases.some(c => {
    const [hh, mm] = String(c.hasta).split(':').map(Number);
    return m >= c.inicio - ANTES_MIN && m < hh * 60 + mm;
  });
}

async function datosDelPedido({ course, session, docente, ahora = new Date() }) {
  const school = course.school;
  const [grilla, susMaterias, conectados, anteriores] = await Promise.all([
    Horario.findOne({ school }).lean(),
    Course.find({ school, $or: [{ owner: docente._id }, { coTeachers: docente._id }] }).select('_id').lean(),
    RoomPresence.countDocuments({ session: session._id, userRole: 'student', lastPingAt: { $gte: new Date(ahora - VENTANA_CONECTADO_MS) } }),
    RoomSession.find({ course: course._id, closedAt: { $ne: null } }).sort({ openedAt: -1 }).limit(5).select('_id').lean(),
  ]);
  // RN-4: clases en vivo de los últimos 30 días en cualquiera de sus materias.
  const uso30 = susMaterias.length
    ? await RoomSession.countDocuments({ course: { $in: susMaterias.map(m => m._id) }, openedAt: { $gte: new Date(ahora - CUPO.USO_DIAS * DIA_MS) } })
    : 0;
  // D3: los alumnos que se estiman para esta clase: los conectados ahora o, si todavía no
  // entraron, el promedio de presentes de sus últimas 5 clases.
  let promedio = 0;
  if (anteriores.length) {
    const presentes = await RoomPresence.countDocuments({ session: { $in: anteriores.map(s => s._id) }, userRole: 'student' });
    promedio = Math.round(presentes / anteriores.length);
  }
  return {
    sessionId: String(session._id),
    docente: docente.name || '',
    materia: [course.name, course.division && course.division.name].filter(Boolean).join(' · '),
    tieneClase: tieneClaseAhora({ course, grilla, ahora }),
    uso30,
    estimados: Math.max(conectados, promedio),
  };
}

// El texto que ve el docente que queda esperando.
function mensajeDeEspera(r) {
  if (r.reservaHasta) {
    const min = Math.max(1, Math.ceil((r.reservaHasta - Date.now()) / 60000));
    return `¡Ya hay lugar! Tenés ${min} ${min === 1 ? 'minuto' : 'minutos'} reservados: tocá Transmitir.`;
  }
  const lugar = r.posicion > 0 ? ` Estás ${r.posicion}.º en la lista:` : '';
  return 'En este momento la escuela no tiene lugar para otra transmisión.'
    + `${lugar} te avisamos acá apenas se libere un lugar. Mientras tanto podés seguir la clase con el chat.`;
}

module.exports = { tieneClaseAhora, datosDelPedido, mensajeDeEspera, minutosAR };
