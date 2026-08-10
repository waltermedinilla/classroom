// El hilo de un mensaje: la conversación entre el superadministrador y UN destinatario.
//
// El mensaje original vive en Message.body (uno solo, compartido por todos los destinatarios)
// y la conversación posterior en MessageRecipient.thread[], que es privada de esa persona.
// Este módulo es el único lugar que arma las dos cosas juntas: las rutas y las vistas piden
// el hilo ya armado y no vuelven a mirar `body` por su cuenta.
//
// La API es deliberadamente la misma forma que services/suggestionThread.js para que las
// vistas y los tests de las dos features se lean igual. Lo que NO se copia es su caso
// especial (los dos primeros mensajes en campos aparte): esa es deuda heredada de no poder
// migrar producción, y un modelo nuevo no tiene por qué arrastrarla.

// Tope de mensajes de un hilo. Mismo criterio ya tomado para las sugerencias: el hilo sirve
// para seguir UNA conversación, y cuando se estira tanto casi siempre ya es otro tema.
const MAX_MENSAJES = 20;

// La conversación en orden cronológico:
//   [{ from: 'staff'|'user', text, at, editedAt, autor, indice }]
// `indice` es -1 para el mensaje original (vive en Message.body, no en el array) y el índice
// dentro de thread[] para el resto: es lo que necesita el editor para saber qué está tocando.
function hilo(message, recipient) {
  if (!message) return [];

  const items = [{
    from: 'staff',
    text: message.body,
    at: message.createdAt,
    editedAt: null,
    autor: message.sender,
    indice: -1,
  }];

  (recipient?.thread || []).forEach((m, i) => {
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

function cuantosMensajes(message, recipient) {
  return hilo(message, recipient).length;
}

function ultimoMensaje(message, recipient) {
  const items = hilo(message, recipient);
  return items[items.length - 1] || null;
}

// ¿La pelota está del lado del destinatario? Es true apenas se envía el mensaje (nadie
// contestó todavía) y vuelve a serlo cada vez que el superadmin responde.
function esperaAlDestinatario(message, recipient) {
  const ultimo = ultimoMensaje(message, recipient);
  return !!ultimo && ultimo.from === 'staff';
}

// ¿El destinatario puede escribir?
//
// A diferencia de las sugerencias —donde el usuario solo puede seguir un hilo que el equipo
// ya contestó— acá puede responder de entrada: el mensaje inicial YA es del staff, así que
// siempre hay algo a lo que contestar. La única puerta es el toggle del remitente.
function puedeResponderElUsuario(message, recipient) {
  if (!message) return false;
  if (!message.allowReplies) return false;
  return cuantosMensajes(message, recipient) < MAX_MENSAJES;
}

// Índice del último mensaje del staff dentro de thread[], o null si el último que escribió el
// staff sigue siendo el mensaje original. Lo usa el editor del panel: "editar" toca siempre lo
// último que escribió el equipo.
function ultimoDelStaff(recipient) {
  const msgs = recipient?.thread || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].from === 'staff') return i;
  }
  return null; // null = el último del staff es Message.body
}

module.exports = {
  MAX_MENSAJES,
  hilo,
  cuantosMensajes,
  ultimoMensaje,
  esperaAlDestinatario,
  puedeResponderElUsuario,
  ultimoDelStaff,
};
