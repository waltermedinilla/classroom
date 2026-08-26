// El cupo de los recursos DIVISIBLES (las netbooks). Único archivo que escribe
// models/SlotOcupacion.js.
//
// ── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────────────────────
// "No pasarse de 30" es una SUMA, y una suma no cabe en un índice único. La versión
// intuitiva es una carrera abierta:
//
//     const usadas = await sumar(...);           // los dos workers leen 20
//     if (usadas + pedidas <= 30) await crear(); // los dos confirman 15 → 35 netbooks
//
// Con dos workers de PM2 eso pasa de verdad, no en teoría. La guarda tiene que ser UNA
// operación sobre UN documento, que es lo único que Mongo garantiza atómico sin
// transacciones.
//
// ── ⚠️ TODA SALIDA TIENE QUE DEVOLVER EL CUPO ──────────────────────────────────────────
// `ocupadas` es estado derivado. Si un camino (cancelar, rechazar, editar la cantidad, borrar
// el recurso) se olvida de llamar a devolver(), el cupo se filtra para siempre: las netbooks
// figuran ocupadas y no las tiene nadie. Por eso existe recalcular(), y por eso el
// diagnóstico de /superadmin/otros lo expone.
//
// LA VERDAD VIVE EN LAS RESERVAS. Esto es solo la forma de decidir rápido y sin carreras.

const SlotOcupacion = require('../../models/SlotOcupacion');
const Reserva       = require('../../models/Reserva');

const llave = ({ recurso, date, turno, modulo }) => ({
  recurso, date, turno, modulo: Number(modulo),
});

// Cuántas unidades hay tomadas ahora en este casillero (0 si nunca se usó).
async function ocupadasEn(slot) {
  const doc = await SlotOcupacion.findOne(llave(slot)).lean();
  return doc?.ocupadas || 0;
}

// Toma `unidades` del casillero si entran. Devuelve:
//   { ok: true,  ocupadas }            → tomadas, y cuántas quedan ocupadas en total
//   { ok: false, ocupadas, libres }    → no entraban; `libres` es lo que sí se podría pedir
//
// Nunca lanza por falta de cupo: eso no es un error del programa, es una respuesta.
async function tomar({ recurso, date, turno, modulo, unidades, capacidad }) {
  const u = Number(unidades);
  const cap = Number(capacidad);

  // Sin esta guarda, `capacidad - unidades` queda negativo, el filtro del $inc no matchea
  // nunca y el código caería al camino de "crear el casillero" — que insertaría 40 unidades
  // en un recurso de 30 sin que nada lo detenga.
  if (!Number.isInteger(u) || u < 1)  return { ok: false, ocupadas: 0, libres: 0 };
  if (!Number.isInteger(cap) || cap < 1) return { ok: false, ocupadas: 0, libres: 0 };
  if (u > cap) return { ok: false, ocupadas: await ocupadasEn({ recurso, date, turno, modulo }), libres: cap };

  const filtro = { ...llave({ recurso, date, turno, modulo }), ocupadas: { $lte: cap - u } };
  const inc    = { $inc: { ocupadas: u } };

  // Camino normal: el casillero ya existe y hay lugar.
  const doc = await SlotOcupacion.findOneAndUpdate(filtro, inc, { new: true });
  if (doc) return { ok: true, ocupadas: doc.ocupadas };

  // No matcheó por una de dos razones: el casillero no existe todavía, o está lleno. Se
  // intenta crearlo; si existe, el índice único de SlotOcupacion contesta E11000 y se
  // reintenta UNA vez contra el camino del $inc, que para entonces ya lo encuentra.
  try {
    const creado = await SlotOcupacion.create({ ...llave({ recurso, date, turno, modulo }), ocupadas: u });
    return { ok: true, ocupadas: creado.ocupadas };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const reintento = await SlotOcupacion.findOneAndUpdate(filtro, inc, { new: true });
    if (reintento) return { ok: true, ocupadas: reintento.ocupadas };
  }

  // Acá sí: no hay lugar. Se lee el estado real para poder decir cuánto queda, que es lo que
  // le permite al administrativo confirmar por menos en vez de rechazar.
  const ocupadas = await ocupadasEn({ recurso, date, turno, modulo });
  return { ok: false, ocupadas, libres: Math.max(0, cap - ocupadas) };
}

// Devuelve `unidades` al casillero. Se llama al cancelar, al rechazar y al bajar la cantidad
// otorgada.
//
// El filtro `ocupadas: { $gte: u }` es una red de contención, no la operación: impide que un
// doble-cancelado deje el contador en negativo. Si no matchea, algo ya estaba descuadrado —
// se lleva a 0 y el recalculador lo va a encontrar.
async function devolver({ recurso, date, turno, modulo, unidades }) {
  const u = Number(unidades);
  if (!Number.isInteger(u) || u < 1) return { ok: false, ocupadas: 0 };

  const doc = await SlotOcupacion.findOneAndUpdate(
    { ...llave({ recurso, date, turno, modulo }), ocupadas: { $gte: u } },
    { $inc: { ocupadas: -u } },
    { new: true },
  );
  if (doc) return { ok: true, ocupadas: doc.ocupadas };

  const clamp = await SlotOcupacion.findOneAndUpdate(
    llave({ recurso, date, turno, modulo }),
    { $set: { ocupadas: 0 } },
    { new: true },
  );
  return { ok: true, ocupadas: clamp?.ocupadas || 0, descuadrado: true };
}

// Cambia lo otorgado de `antes` a `ahora` en el mismo casillero. Es lo que hace el botón del
// administrativo cuando edita la cantidad de una reserva YA confirmada.
//
// Bajar siempre entra. Subir puede no entrar, y en ese caso NO se toca nada: se informa
// cuánto hay libre y la reserva queda como estaba. Una edición a medias sería peor que una
// edición rechazada.
async function ajustar({ recurso, date, turno, modulo, antes, ahora, capacidad }) {
  const delta = Number(ahora) - Number(antes);
  if (delta === 0) return { ok: true, ocupadas: await ocupadasEn({ recurso, date, turno, modulo }) };
  if (delta < 0)  return devolver({ recurso, date, turno, modulo, unidades: -delta });
  return tomar({ recurso, date, turno, modulo, unidades: delta, capacidad });
}

// ── El antídoto ────────────────────────────────────────────────────────────────────────
// Recalcula los contadores desde las reservas confirmadas, que son la verdad. Con
// `aplicar: false` solo informa — es como lo usa el diagnóstico de /superadmin/otros, que
// muestra las diferencias ANTES de tocar nada.
//
// Solo mira recursos divisibles: los exclusivos no tienen contador (los guarda el índice
// único de models/Reserva.js) y sus casilleros no existen.
async function recalcular({ recursoIds = null, aplicar = false } = {}) {
  const matchReservas = { status: 'confirmada', exclusiva: false };
  if (recursoIds) matchReservas.recurso = { $in: recursoIds };

  const reales = await Reserva.aggregate([
    { $match: matchReservas },
    { $group: {
      _id: { recurso: '$recurso', date: '$date', turno: '$turno', modulo: '$modulo' },
      unidades: { $sum: '$unidades' },
    } },
  ]);

  const filtroSlots = recursoIds ? { recurso: { $in: recursoIds } } : {};
  const guardados = await SlotOcupacion.find(filtroSlots).lean();

  const clave = (o) => `${o.recurso}|${o.date}|${o.turno}|${o.modulo}`;
  const mapaReal = new Map(reales.map(r => [clave(r._id), r.unidades]));
  const mapaSlot = new Map(guardados.map(s => [clave(s), s.ocupadas]));

  const diferencias = [];
  for (const k of new Set([...mapaReal.keys(), ...mapaSlot.keys()])) {
    const real = mapaReal.get(k) || 0;
    const slot = mapaSlot.get(k) || 0;
    if (real !== slot) {
      const [recurso, date, turno, modulo] = k.split('|');
      diferencias.push({ recurso, date, turno, modulo: Number(modulo), guardado: slot, real });
    }
  }

  if (aplicar) {
    for (const d of diferencias) {
      await SlotOcupacion.updateOne(
        llave(d),
        { $set: { ocupadas: d.real } },
        { upsert: true },
      );
    }
  }

  return { diferencias, revisados: mapaReal.size + mapaSlot.size, aplicado: !!aplicar };
}

module.exports = { ocupadasEn, tomar, devolver, ajustar, recalcular };
