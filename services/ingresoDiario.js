// "Entró a la plataforma ese día" (S1 del panel de la Secretaria).
// Ver D3 de specs/secretaria-docentes-del-dia.spec.md y models/IngresoDiario.js.
//
// Lo llama middleware/auth.js SOLO cuando la escritura throttleada de lastSeen efectivamente
// modificó el documento, o sea como mucho una vez por minuto por persona. Es el camino caliente
// de TODO pedido autenticado, así que esta función:
//   - no se espera (fire-and-forget),
//   - nunca lanza (todo error se traga y se loguea),
//   - es idempotente (upsert sobre el índice único {user, fecha}).

const IngresoDiario = require('../models/IngresoDiario');
const live = require('./liveRoom');

// ¿Este pedido tiene que dejar rastro de ingreso? Pura, para poder probarla sin Mongo.
//   - Los alumnos no: no hacen falta y son menores.
//   - Una cuenta deshabilitada tampoco (el pedido termina en logout).
//   - ⭐ Un admin SUPLANTANDO al docente tampoco: el token es el del docente, pero el que está
//     sentado es el admin. Sin esto, revisar la cuenta de alguien un domingo le dejaría a esa
//     persona un "entró a la plataforma" que nunca hizo (RN-14).
function debeRegistrarIngreso({ role, active, suplantando }) {
  if (!role || role === 'student') return false;
  if (active === false) return false;
  if (suplantando) return false;
  return true;
}

function registrarIngreso(user, ahora = new Date(), logger = null) {
  try {
    const fecha = live.diaEscolar(ahora);
    IngresoDiario.updateOne(
      { user: user._id, fecha },
      {
        $setOnInsert: { primeraVez: ahora, school: user.school || null },
        $set: { ultimaVez: ahora },
      },
      { upsert: true },
    ).catch(err => {
      // E11000: dos workers insertaron a la vez y ganó el otro. Es lo esperado, no un error.
      if (err && err.code === 11000) return;
      try { logger && logger.warn('[ingresoDiario] no se pudo registrar', { error: err.message }); } catch {}
    });
  } catch (err) {
    try { logger && logger.warn('[ingresoDiario] no se pudo registrar', { error: err.message }); } catch {}
  }
}

module.exports = { debeRegistrarIngreso, registrarIngreso };
