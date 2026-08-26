// El horario escolar: generarlo, validarlo y consultarlo. TODO PURO — no toca la base, no
// recibe `req`, no sabe qué es Express. Por eso se puede testear entero con node --test.
//
// El modelo está en models/Horario.js, con el porqué de que las horas sean strings 'HH:MM'.
// Acá alcanza con la consecuencia práctica: 'HH:MM' compara y ordena como string sin ninguna
// conversión, y de ahí sale la mitad de las validaciones de este archivo.

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const horaValida = (h) => typeof h === 'string' && HORA_RE.test(h);

// '08:40' → 520. Solo para hacer aritmética; lo que se guarda siempre es el string.
function aMinutos(h) {
  const [hh, mm] = String(h).split(':').map(Number);
  return hh * 60 + mm;
}

// 520 → '08:40'. Con el cero adelante, que es lo que hace que la comparación de strings
// coincida con la comparación de tiempos ('9:30' > '10:10' sería falso y verdadero al mismo
// tiempo según cómo se compare).
function aHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Los días de la semana, en el orden en que se pintan. 1 = lunes.
const NOMBRE_DIA = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado' };
const DIAS_VALIDOS = [1, 2, 3, 4, 5, 6];

// ─────────────────────────────────────────────────────────────────────────────
// Generar la grilla
// ─────────────────────────────────────────────────────────────────────────────

// Arma las franjas de un turno a partir del rango y el patrón, para que el administrativo no
// tenga que tipear nueve filas a mano. Lo que se GUARDA es el resultado, no la fórmula: una
// escuela con un recreo largo a mitad de mañana rompe cualquier regla, y tiene que poder
// editar la grilla generada fila por fila.
//
// `recreosDespuesDe` son los `orden` de clase después de los cuales va un recreo: [2, 4]
// produce el patrón de la Escuela 4118 (2 módulos · recreo · 2 módulos · recreo · el resto).
//
// El último recreo NO se agrega si no entra completo antes del fin del turno: un recreo
// colgando fuera de horario sería una franja que no existe en la realidad.
function generarFranjas({ desde, hasta, duracionModulo = 40, duracionRecreo = 10, recreosDespuesDe = [] }) {
  if (!horaValida(desde) || !horaValida(hasta)) return [];
  if (!(duracionModulo > 0)) return [];

  const fin     = aMinutos(hasta);
  const recreos = new Set(recreosDespuesDe.map(Number));
  const franjas = [];
  let t = aMinutos(desde);
  let orden = 1;

  // Tope de seguridad: un rango dado vuelta o una duración absurda no puede colgar el server.
  while (t + duracionModulo <= fin && orden <= 24) {
    franjas.push({
      tipo: 'clase', orden, label: `${orden}ª hora`,
      desde: aHHMM(t), hasta: aHHMM(t + duracionModulo),
    });
    t += duracionModulo;

    if (recreos.has(orden) && duracionRecreo > 0 && t + duracionRecreo <= fin) {
      franjas.push({
        tipo: 'recreo', orden: null, label: 'Recreo',
        desde: aHHMM(t), hasta: aHHMM(t + duracionRecreo),
      });
      t += duracionRecreo;
    }
    orden++;
  }
  return franjas;
}

// Copia un turno corriéndolo N minutos. Es el botón "copiar del Turno Mañana": los dos turnos
// de la escuela tienen forma idéntica y solo cambia a qué hora arrancan, así que cargar el
// segundo a mano sería tipear lo mismo dos veces y equivocarse una.
function correrTurno(turno, minutos, { id, label } = {}) {
  const correr = (h) => aHHMM(aMinutos(h) + minutos);
  return {
    id:    id    || turno.id,
    label: label || turno.label,
    desde: correr(turno.desde),
    hasta: correr(turno.hasta),
    franjas: (turno.franjas || []).map(f => ({
      ...f, desde: correr(f.desde), hasta: correr(f.hasta),
    })),
  };
}

// El horario de la Escuela 4118, tal como lo dictó el usuario. Es lo que la pantalla ofrece
// precargado en una escuela que todavía no cargó el suyo — un punto de partida editable, no
// una constante del sistema: cualquier otra escuela lo pisa entero desde /admin/recursos.
const PRESET_4118 = () => ({
  dias: [1, 2, 3, 4, 5],
  turnos: [
    {
      id: 'manana', label: 'Turno Mañana', desde: '08:00', hasta: '13:00',
      franjas: generarFranjas({ desde: '08:00', hasta: '13:00', recreosDespuesDe: [2, 4] }),
    },
    {
      id: 'tarde', label: 'Turno Tarde', desde: '14:00', hasta: '19:00',
      franjas: generarFranjas({ desde: '14:00', hasta: '19:00', recreosDespuesDe: [2, 4] }),
    },
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Validar
// ─────────────────────────────────────────────────────────────────────────────

// Devuelve { ok, errores: [String] }. Los mensajes van tal cual a la pantalla, así que están
// en castellano y dicen QUÉ fila está mal, no solo que algo falló.
//
// La validación fuerte se puede permitir porque los dos turnos de la escuela cierran clavados
// contra su rango (7 × 40' + 2 × 10' = 5 h exactas): no hay holgura que perdonar un error de
// carga, y una grilla con un hueco de 5 minutos es siempre un error de tipeo.
function validarHorario(horario = {}) {
  const errores = [];
  const turnos = Array.isArray(horario.turnos) ? horario.turnos : [];

  const dias = Array.isArray(horario.dias) ? horario.dias : [];
  if (!dias.length) errores.push('Elegí al menos un día de la semana.');
  if (dias.some(d => !DIAS_VALIDOS.includes(Number(d)))) {
    errores.push('Hay un día fuera de rango (tiene que ser de lunes a sábado).');
  }

  if (!turnos.length) errores.push('El horario tiene que tener al menos un turno.');

  const idsVistos = new Set();
  for (const t of turnos) {
    const nombre = t.label || t.id || 'un turno';

    if (!t.id) { errores.push(`Falta el identificador de ${nombre}.`); continue; }
    if (idsVistos.has(t.id)) errores.push(`Hay dos turnos con el identificador "${t.id}".`);
    idsVistos.add(t.id);

    if (!horaValida(t.desde) || !horaValida(t.hasta)) {
      errores.push(`${nombre}: el horario del turno tiene que ser HH:MM.`);
      continue;
    }
    if (aMinutos(t.desde) >= aMinutos(t.hasta)) {
      errores.push(`${nombre}: empieza a las ${t.desde} y termina a las ${t.hasta}.`);
      continue;
    }

    const franjas = Array.isArray(t.franjas) ? t.franjas : [];
    if (!franjas.length) { errores.push(`${nombre}: no tiene ninguna franja cargada.`); continue; }

    // Se valida sobre una copia ORDENADA por hora: el administrativo puede haber insertado
    // una fila en el medio, y el orden del array no es la verdad — la hora sí.
    const enOrden = franjas.slice().sort((a, b) => String(a.desde).localeCompare(String(b.desde)));

    let cursor = t.desde;
    let franjaMala = false;
    for (const f of enOrden) {
      if (!horaValida(f.desde) || !horaValida(f.hasta)) {
        errores.push(`${nombre}: la franja "${f.label || '(sin nombre)'}" no tiene horas válidas.`);
        franjaMala = true; break;
      }
      if (aMinutos(f.desde) >= aMinutos(f.hasta)) {
        errores.push(`${nombre}: "${f.label}" va de ${f.desde} a ${f.hasta}.`);
        franjaMala = true; break;
      }
      if (f.desde < cursor) {
        errores.push(`${nombre}: "${f.label}" se superpone con la franja anterior (empieza ${f.desde} y la otra termina ${cursor}).`);
        franjaMala = true; break;
      }
      if (f.desde > cursor) {
        errores.push(`${nombre}: queda un hueco sin cubrir entre ${cursor} y ${f.desde}. Si es un recreo, cargalo como franja.`);
        franjaMala = true; break;
      }
      cursor = f.hasta;
    }
    if (franjaMala) continue;

    if (cursor !== t.hasta) {
      errores.push(`${nombre}: las franjas terminan ${cursor} y el turno termina ${t.hasta}.`);
    }

    // El `orden` de las clases: correlativo desde 1 y sin repetir. Es lo que guarda cada
    // reserva, así que un salto o un repetido convierte a "3ª hora" en algo ambiguo.
    const ordenes = enOrden.filter(f => f.tipo !== 'recreo').map(f => Number(f.orden));
    if (ordenes.some(o => !Number.isInteger(o) || o < 1)) {
      errores.push(`${nombre}: hay un módulo sin número de orden.`);
    } else if (new Set(ordenes).size !== ordenes.length) {
      errores.push(`${nombre}: hay dos módulos con el mismo número.`);
    } else if (ordenes.some((o, i) => o !== i + 1)) {
      errores.push(`${nombre}: los módulos tienen que numerarse 1, 2, 3… sin saltos.`);
    }
  }

  // Dos turnos de la misma escuela no se pueden pisar: 8-13 y 14-19 está bien, 8-13 y 12-17
  // no. Si se pisaran, un mismo instante caería en dos casilleros distintos y "la sala está
  // ocupada" dejaría de tener una sola respuesta.
  const rangos = turnos
    .filter(t => horaValida(t.desde) && horaValida(t.hasta))
    .slice().sort((a, b) => a.desde.localeCompare(b.desde));
  for (let i = 1; i < rangos.length; i++) {
    if (rangos[i].desde < rangos[i - 1].hasta) {
      errores.push(`"${rangos[i - 1].label}" y "${rangos[i].label}" se superponen.`);
    }
  }

  return { ok: errores.length === 0, errores };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consultar
// ─────────────────────────────────────────────────────────────────────────────

const turnoDe = (horario, turnoId) =>
  (horario?.turnos || []).find(t => t.id === turnoId) || null;

// Solo las franjas reservables. Los recreos están en la grilla para que el calendario se
// entienda (ver models/Horario.js), pero no se reservan nunca.
const modulosDeClase = (turno) =>
  (turno?.franjas || []).filter(f => f.tipo !== 'recreo').sort((a, b) => a.orden - b.orden);

// La franja concreta de un módulo, o null. Es la validación que convierte un {turno, modulo}
// que llegó del navegador en algo que existe: sin esto, un POST armado a mano podría reservar
// la "9ª hora" de un turno que tiene siete.
function moduloDe(horario, turnoId, orden) {
  const turno = turnoDe(horario, turnoId);
  if (!turno) return null;
  const n = Number(orden);
  return modulosDeClase(turno).find(f => f.orden === n) || null;
}

// ¿El horario está cargado y es usable? Una escuela con el módulo prendido pero sin horario no
// puede reservar nada, y la pantalla tiene que decirlo en vez de mostrar una grilla vacía.
const horarioCargado = (horario) =>
  !!horario && Array.isArray(horario.turnos) && horario.turnos.some(t => modulosDeClase(t).length > 0);

module.exports = {
  HORA_RE, horaValida, aMinutos, aHHMM,
  NOMBRE_DIA, DIAS_VALIDOS,
  generarFranjas, correrTurno, PRESET_4118,
  validarHorario,
  turnoDe, modulosDeClase, moduloDe, horarioCargado,
};
