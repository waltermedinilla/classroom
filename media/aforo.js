// EL GOBERNADOR: cuánta calidad se puede dar sin tumbar el puerto de salida.
//
// Es el único componente de esta feature que puede tirar abajo la plataforma ENTERA si se
// equivoca hacia arriba —y no solo el video: las páginas, las entregas, todo—, así que vive
// solo, sin mediasoup y sin mongoose adentro, y se testea con miles de escenarios sin levantar
// nada. Ver D5 de specs/transmision-en-vivo.spec.md.
//
// LA IDEA, en una línea: se elige la capa MÁS ALTA cuyo consumo total quede por debajo de su
// umbral. No se cuenta aulas — se cuenta ancho de banda. Un tope de aulas contadas a mano
// habría rechazado la clase 13 mientras sobraba el 65 % del puerto.

const {
  PRESUPUESTO_MBPS, CAPAS, MAX_CLASES, mbpsDeCapa,
} = require('../config/transmision');

// Consumo total, en Mbit/s, de N espectadores recibiendo esta capa.
function consumoMbps(espectadores, capa) {
  const n = Math.max(0, Number(espectadores) || 0);
  return n * mbpsDeCapa(capa);
}

// Qué porcentaje del presupuesto ocupa ese consumo (0..∞, no se recorta a 100 a propósito:
// el panel del monitor tiene que poder mostrar que se pasó).
function ocupacion(espectadores, capa) {
  return consumoMbps(espectadores, capa) / PRESUPUESTO_MBPS * 100;
}

// ⭐ LA FUNCIÓN. Con N espectadores en toda la escuela, ¿qué capa se puede dar?
//
// Devuelve el id de la capa, o null para "no entra nadie más".
//
// Es MONÓTONA por construcción —más espectadores nunca devuelve mejor calidad— porque recorre
// CAPAS de mejor a peor y devuelve la primera que entra. Escribirla como una escalera de `if`
// sobre la ocupación ACTUAL sería el bug clásico: bajar la calidad baja la ocupación, que
// volvería a habilitar la calidad alta, que vuelve a subir la ocupación… y la escuela entera
// parpadeando entre 360p y 180p cada cuatro segundos.
function capaPermitida(espectadores) {
  const n = Math.max(0, Number(espectadores) || 0);
  for (const c of CAPAS) {
    if (n * c.mbps <= PRESUPUESTO_MBPS * c.umbral) return c.id;
  }
  return null;
}

// La decisión completa, que es lo que consume el proceso de medios: la capa, el consumo que
// implica, y POR QUÉ se degradó. El motivo no es adorno — es lo que le permite al docente leer
// "estás en calidad baja porque hay 9 clases al aire" en vez de sospechar que su internet anda
// mal. Un sistema que se degrada en silencio produce el mismo reclamo, pero sin el dato.
function decidir(espectadores, { clases = 0 } = {}) {
  // Red de seguridad, ANTES que el presupuesto: si esto se dispara no es que la escuela creció,
  // es que algo se desbocó, y conviene que el registro los distinga.
  if (clases > MAX_CLASES) {
    return {
      capa: null, mbps: 0, ocupacion: 0,
      motivo: 'red-de-seguridad',
      mensaje: 'Hay demasiadas clases transmitiendo a la vez. Podés seguir con el chat.',
    };
  }

  const capa = capaPermitida(espectadores);
  if (!capa) {
    return {
      capa: null, mbps: 0, ocupacion: 100,
      motivo: 'aforo',
      mensaje: 'La escuela llegó al tope de clases transmitiendo. Podés seguir con el chat.',
    };
  }

  const mbps = consumoMbps(espectadores, capa);
  return {
    capa,
    mbps,
    ocupacion: mbps / PRESUPUESTO_MBPS * 100,
    // Solo se marca como degradada si NO es la mejor capa disponible.
    motivo:  capa === CAPAS[0].id ? '' : 'aforo',
    mensaje: capa === CAPAS[0].id ? '' : mensajeDeCapa(capa, espectadores),
  };
}

function mensajeDeCapa(capa, espectadores) {
  if (capa === 'audio') {
    return `Se cortaron las cámaras: hay ${espectadores} personas mirando clases en la escuela. `
         + 'La voz y tu pantalla siguen llegando.';
  }
  return `Estás transmitiendo en calidad baja: hay ${espectadores} personas mirando clases `
       + 'en la escuela al mismo tiempo.';
}

// Cuántos MB consume un espectador en `minutos` con esta capa. Es lo que se le muestra al
// alumno ANTES de que toque "Ver la clase" (D12): un chico con datos del celular tiene derecho
// a saber si va a gastar 70 MB o 700.
function estimarMB(capa, minutos) {
  const mbits = mbpsDeCapa(capa) * 60 * Math.max(0, Number(minutos) || 0);
  return Math.round(mbits / 8);
}

module.exports = {
  consumoMbps, ocupacion, capaPermitida, decidir, estimarMB,
  PRESUPUESTO_MBPS, MAX_CLASES,
};
