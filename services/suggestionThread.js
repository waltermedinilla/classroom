// El hilo de una sugerencia: la conversación completa entre quien la envió y el equipo.
//
// Una sugerencia arrancó siendo un ida y vuelta (`text` + `response`) y ahora puede seguir:
// el usuario contesta la respuesta, el superadmin vuelve a contestar, y así. Los dos primeros
// mensajes siguen viviendo en sus campos originales para no migrar las sugerencias que ya
// están en producción, y el resto en `messages[]` — ver el comentario del modelo.
//
// Este módulo es el ÚNICO lugar que sabe eso. Las rutas y las vistas piden el hilo armado y
// no vuelven a mirar `text`/`response` por su cuenta: si algún día se migra todo a
// `messages[]`, se cambia acá y nada más.

// Tope de mensajes de un hilo. No es una restricción técnica: es la regla que pidió el
// usuario — el hilo sirve para seguir UNA conversación, y cuando se estira tanto casi
// siempre ya es otro tema, que corresponde a una sugerencia nueva.
const MAX_MENSAJES = 20;

// Devuelve la conversación en orden cronológico:
//   [{ from: 'user'|'staff', text, at, editedAt, autor, indice }]
// `indice` es -1 para el mensaje inicial, -2 para la primera respuesta y el índice dentro de
// `messages[]` para el resto: es lo que necesita el editor para saber qué está tocando.
function hilo(s) {
  if (!s) return [];
  const items = [{
    from: 'user',
    text: s.text,
    at: s.createdAt,
    editedAt: null,
    autor: s.user,
    indice: -1,
  }];

  if (s.response) {
    items.push({
      from: 'staff',
      text: s.response,
      at: s.respondedAt,
      editedAt: null,
      autor: s.respondedBy,
      indice: -2,
    });
  }

  (s.messages || []).forEach((m, i) => {
    items.push({
      from: m.from,
      text: m.text,
      at: m.at,
      editedAt: m.editedAt || null,
      autor: m.author,
      indice: i,
    });
  });

  return items;
}

// Quién habló último. Es lo que decide si la pelota está del lado del equipo (hay que
// contestar) o del usuario (ya se le contestó y todavía no dijo nada).
function ultimoMensaje(s) {
  const items = hilo(s);
  return items[items.length - 1] || null;
}

// ¿La sugerencia está esperando respuesta del equipo? Vale tanto para la que nadie contestó
// nunca como para el hilo donde el usuario volvió a escribir. Se calcula del hilo y no de un
// campo nuevo, así las sugerencias históricas dan el resultado correcto sin backfill.
function esperaAlEquipo(s) {
  const ultimo = ultimoMensaje(s);
  return !ultimo || ultimo.from === 'user';
}

// ¿El usuario puede seguir el hilo? Solo si el equipo ya le contestó algo: mientras su
// sugerencia está sin responder no hay conversación que continuar, y dejarlo escribir ahí
// convertiría la bandeja en un chat de mensajes sueltos. Si no hay respuesta todavía —o el
// hilo llegó al tope— lo que corresponde es abrir una sugerencia nueva.
function puedeResponderElUsuario(s) {
  if (!s) return false;
  if (!s.response && !(s.messages || []).some(m => m.from === 'staff')) return false;
  return cuantosMensajes(s) < MAX_MENSAJES;
}

function cuantosMensajes(s) {
  return hilo(s).length;
}

// Índice del último mensaje del equipo dentro de `messages[]`, o null si la última respuesta
// del equipo sigue siendo la primera (la que vive en `response`). Lo usa el editor del panel:
// "editar respuesta" siempre toca lo último que escribió el equipo, no lo primero.
function ultimoDelEquipo(s) {
  const msgs = (s?.messages || []);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].from === 'staff') return i;
  }
  return (s?.response) ? null : undefined; // null = está en `response`; undefined = no hay
}

module.exports = { MAX_MENSAJES, hilo, ultimoMensaje, esperaAlEquipo, puedeResponderElUsuario, cuantosMensajes, ultimoDelEquipo };
