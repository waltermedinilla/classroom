// Las operaciones de reserva que TOCAN LA BASE. La lógica pura vive en disponibilidad.js y
// horario.js; acá está lo que no se puede testear sin Mongo: confirmar, liberar y pedir.
//
// Existe como service —y no adentro de un router— porque los dos routers necesitan lo mismo:
// routes/reservas.js confirma cuando el docente ya está autorizado, y routes/recursos.js
// confirma cuando el administrativo aprueba un pendiente. Que las dos puertas pasen por la
// misma función es lo único que garantiza que el cupo se descuente igual por las dos.

const crypto = require('crypto');

const Horario             = require('../../models/Horario');
const Recurso             = require('../../models/Recurso');
const Reserva             = require('../../models/Reserva');
const RecursoAutorizacion = require('../../models/RecursoAutorizacion');
const cupo = require('./cupo');
const { moduloDe }  = require('./horario');
const { expandirSerie, esPasado } = require('./disponibilidad');

const horarioDe = (schoolId) => Horario.findOne({ school: schoolId }).lean();

// ¿Este docente puede reservar este recurso sin pasar por la bandeja?
// Dos caminos, y el primero es tan importante como el segundo: un recurso marcado
// `requiereAutorizacion: false` (el proyector del pasillo) no le hace pedir permiso a nadie.
async function puedeReservarDirecto(recurso, userId) {
  if (!recurso.requiereAutorizacion) return true;
  const auth = await RecursoAutorizacion.findOne({
    recurso: recurso._id, docente: userId, revocadaEl: null,
  }).lean();
  return !!auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmar y liberar — el par que mantiene el cupo cuadrado
// ─────────────────────────────────────────────────────────────────────────────

// Pasa una reserva a 'confirmada', tomando el cupo si el recurso es divisible.
//
// Devuelve { ok: true } o { ok: false, motivo, libres? } con:
//   'tomado'   → recurso exclusivo, otro docente se lo quedó mientras esto estaba pendiente
//   'sincupo'  → recurso divisible, no quedan tantas unidades (`libres` dice cuántas hay)
//
// ⚠️ NINGUNO DE LOS DOS ES UN ERROR DEL PROGRAMA. Son la respuesta normal a una carrera que
// el diseño permite a propósito (los pendientes no bloquean el casillero — ver el comentario
// del índice en models/Reserva.js). Quien llama tiene que traducirlos a un mensaje humano;
// un 500 acá es la peor cara del módulo.
async function confirmar(reserva, recurso, unidades = null) {
  const u = reserva.exclusiva ? 1 : Number(unidades || reserva.unidades || 1);

  // Recurso EXCLUSIVO: la guarda es el índice único parcial de models/Reserva.js. No hay
  // contador que tocar, y no hay carrera que perder — si dos llegan juntos, Mongo elige.
  if (reserva.exclusiva) {
    reserva.status   = 'confirmada';
    reserva.unidades = 1;
    try {
      await reserva.save();
      return { ok: true };
    } catch (err) {
      if (err?.code === 11000) {
        reserva.status = 'pendiente';   // se deja como estaba en memoria para el caller
        return { ok: false, motivo: 'tomado' };
      }
      throw err;
    }
  }

  // Recurso DIVISIBLE: primero se toma el cupo, después se guarda.
  //
  // El orden importa y no es negociable. Al revés —guardar y después descontar— deja una
  // ventana en la que la reserva ya está confirmada pero el contador todavía no la refleja,
  // y otra aprobación simultánea entra por arriba del cupo.
  const tomado = await cupo.tomar({
    recurso: reserva.recurso, date: reserva.date, turno: reserva.turno, modulo: reserva.modulo,
    unidades: u, capacidad: recurso.capacidad,
  });
  if (!tomado.ok) return { ok: false, motivo: 'sincupo', libres: tomado.libres };

  reserva.status   = 'confirmada';
  reserva.unidades = u;
  try {
    await reserva.save();
    return { ok: true };
  } catch (err) {
    // El cupo ya está tomado y la reserva no se guardó: si esto no se devuelve, quedan
    // unidades ocupadas que no son de nadie. Es exactamente la fuga que recalcular() existe
    // para encontrar — mejor no producirla.
    await cupo.devolver({
      recurso: reserva.recurso, date: reserva.date, turno: reserva.turno,
      modulo: reserva.modulo, unidades: u,
    });
    throw err;
  }
}

// Saca una reserva de circulación (cancelada o rechazada) devolviendo el cupo si lo tenía.
//
// Solo devuelve cupo la que estaba CONFIRMADA: una pendiente nunca lo tomó, y devolverlo
// igual regalaría unidades que nadie sacó.
async function liberar(reserva, { status, motivoRechazo = '', porUsuario = null }) {
  const estabaConfirmada = reserva.status === 'confirmada';

  reserva.status = status;
  if (motivoRechazo) reserva.motivoRechazo = motivoRechazo;
  reserva.resueltaPor = porUsuario;
  reserva.resueltaEl  = new Date();
  await reserva.save();

  if (estabaConfirmada && !reserva.exclusiva) {
    await cupo.devolver({
      recurso: reserva.recurso, date: reserva.date, turno: reserva.turno,
      modulo: reserva.modulo, unidades: reserva.unidades || 1,
    });
  }
  return reserva;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedir
// ─────────────────────────────────────────────────────────────────────────────

// Crea la reserva (o la serie). Devuelve { creadas, omitidas, error }.
//
// ⚠️ LA SERIE ES PARCIAL A PROPÓSITO: si el docente pide 30 martes y dos están tomados, se
// crean los otros 28 y se informan los 2. Cancelar el pedido entero por dos choques sería
// castigarlo por algo que no eligió, y obligarlo a volver a cargar 28 fechas a mano.
async function pedir({
  req, school, recurso, docente, horario,
  turno, modulo, desde, repeticion, hasta, unidades, course, division, motivo, hoy,
}) {
  const franja = moduloDe(horario, turno, modulo);
  if (!franja) return { creadas: [], omitidas: [], error: 'Ese módulo no existe en el horario.' };

  const { fechas, error } = expandirSerie({
    desde, repeticion, hasta, dias: horario.dias || [1, 2, 3, 4, 5],
  });
  if (error) return { creadas: [], omitidas: [], error };

  // Reservar ayer no es un problema de permisos, es un problema de sentido. Se filtra en vez
  // de rechazar todo: una serie semanal que arranca la semana pasada sigue teniendo sentido
  // de hoy en adelante.
  const futuras = fechas.filter(f => !esPasado(f, hoy));
  if (!futuras.length) return { creadas: [], omitidas: [], error: 'Esa fecha ya pasó.' };

  const directo = await puedeReservarDirecto(recurso, docente._id);
  const pedidas = recurso.divisible ? Math.max(1, Number(unidades) || 1) : 1;
  const serie   = futuras.length > 1 ? crypto.randomUUID() : null;

  const creadas  = [];
  const omitidas = [];

  for (const date of futuras) {
    // Lo que ya hay en el casillero. Se relee por fecha —y no una vez para toda la serie—
    // porque cada martes tiene su propia ocupación.
    const enElCasillero = await Reserva.find({
      recurso: recurso._id, date, turno, modulo: Number(modulo),
      status: { $in: ['pendiente', 'confirmada'] },
    }).lean();

    // Doble pedido del mismo docente sobre el mismo casillero: no es un choque, es un clic
    // repetido. Se saltea sin ruido.
    if (enElCasillero.some(r => String(r.docente) === String(docente._id))) {
      omitidas.push({ date, motivo: 'Ya tenías un pedido para ese módulo.' });
      continue;
    }

    const confirmadas = enElCasillero.filter(r => r.status === 'confirmada');
    const tomadas = confirmadas.reduce((n, r) => n + (r.unidades || 1), 0);
    const capacidad = recurso.divisible ? (recurso.capacidad || 1) : 1;

    if (tomadas + pedidas > capacidad) {
      omitidas.push({
        date,
        motivo: recurso.divisible
          ? `Solo quedan ${Math.max(0, capacidad - tomadas)} disponibles.`
          : 'Ya está reservado.',
      });
      continue;
    }

    const reserva = new Reserva({
      school: school._id, recurso: recurso._id,
      date, turno, modulo: Number(modulo),
      docente: docente._id, course: course || null, division: division || null,
      motivo: motivo || '',
      status: 'pendiente',
      unidadesPedidas: pedidas,
      unidades: pedidas,
      exclusiva: !recurso.divisible,
      serie,
    });

    if (!directo) { await reserva.save(); creadas.push(reserva); continue; }

    // Docente ya autorizado: entra directo, pero IGUAL pasa por el cupo. Estar autorizado
    // habilita a no esperar una aprobación, no a pasarse de 30 netbooks.
    await reserva.save();
    const r = await confirmar(reserva, recurso, pedidas);
    if (r.ok) { creadas.push(reserva); continue; }

    // Perdió la carrera entre el chequeo de arriba y el $inc. La reserva se borra en vez de
    // dejarla pendiente: el docente pidió entrar directo, no pedir permiso.
    await Reserva.deleteOne({ _id: reserva._id });
    omitidas.push({
      date,
      motivo: r.motivo === 'sincupo' ? `Solo quedan ${r.libres} disponibles.` : 'Ya está reservado.',
    });
  }

  return { creadas, omitidas, error: null };
}

// Los recursos activos de una escuela, en el orden en que se pintan.
const recursosDe = (schoolId) =>
  Recurso.find({ school: schoolId, activo: true }).sort({ tipo: 1, name: 1 }).lean();

module.exports = {
  horarioDe, recursosDe, puedeReservarDirecto,
  confirmar, liberar, pedir,
};
