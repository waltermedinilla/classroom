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
  PRESUPUESTO_MBPS, CAPAS, MAX_CLASES, mbpsDeCapa, MAX_VOCES, VOZ_KBPS_TIPICO, CAMARA_CHICA_MBPS,
} = require('../config/transmision');

// Un conteo que llega roto (undefined, negativo, NaN) se lee como cero.
const contar = (x) => Math.max(0, Number(x) || 0);

// Lo que suma la cámara chica (C3 de specs/transmision-camara-primero.spec.md): solo en la
// MEJOR capa. En 180p o en solo audio la esquina no se manda, así que no cuesta nada.
const extraCamaraChica = (capa, conPantallaYCamara) =>
  (capa === CAPAS[0].id ? contar(conPantallaYCamara) * CAMARA_CHICA_MBPS : 0);

// Consumo total, en Mbit/s, de N espectadores recibiendo esta capa. `conPantallaYCamara` es
// cuántos de esos N están en una sala donde el docente comparte pantalla CON la cámara prendida:
// esos reciben además la cámara chica.
function consumoMbps(espectadores, capa, conPantallaYCamara = 0) {
  return contar(espectadores) * mbpsDeCapa(capa) + extraCamaraChica(capa, conPantallaYCamara);
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
//
// La cámara chica entra en la cuenta de la mejor capa y en ninguna otra, así que la función
// sigue siendo monótona: más espectadores (o más con pantalla) nunca dan mejor calidad.
function capaPermitida(espectadores, conPantallaYCamara = 0) {
  const n = contar(espectadores);
  for (const c of CAPAS) {
    const total = n * c.mbps + extraCamaraChica(c.id, conPantallaYCamara);
    if (total <= PRESUPUESTO_MBPS * c.umbral) return c.id;
  }
  return null;
}

// La decisión completa, que es lo que consume el proceso de medios: la capa, el consumo que
// implica, y POR QUÉ se degradó. El motivo no es adorno — es lo que le permite al docente leer
// "estás en calidad baja porque hay 9 clases al aire" en vez de sospechar que su internet anda
// mal. Un sistema que se degrada en silencio produce el mismo reclamo, pero sin el dato.
function decidir(espectadores, { clases = 0, conPantallaYCamara = 0 } = {}) {
  // Red de seguridad, ANTES que el presupuesto: si esto se dispara no es que la escuela creció,
  // es que algo se desbocó, y conviene que el registro los distinga.
  if (clases > MAX_CLASES) {
    return {
      capa: null, mbps: 0, ocupacion: 0,
      motivo: 'red-de-seguridad',
      mensaje: 'Hay demasiadas clases transmitiendo a la vez. Podés seguir con el chat.',
    };
  }

  const capa = capaPermitida(espectadores, conPantallaYCamara);
  if (!capa) {
    return {
      capa: null, mbps: 0, ocupacion: 100,
      motivo: 'aforo',
      mensaje: 'La escuela llegó al tope de clases transmitiendo. Podés seguir con el chat.',
    };
  }

  const mbps = consumoMbps(espectadores, capa, conPantallaYCamara);
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
  // La voz se estima con el consumo TÍPICO y no con el peor caso que cuenta el gobernador: ver
  // VOZ_KBPS_TIPICO en config/transmision.js.
  const mbps  = capa === 'voz' ? VOZ_KBPS_TIPICO / 1000 : mbpsDeCapa(capa);
  const mbits = mbps * 60 * Math.max(0, Number(minutos) || 0);
  return Math.round(mbits / 8);
}

// ¿Puede empezar a sonar una voz más en esta sala? (Hablar, H4 de specs/sala-hablar.spec.md.)
//
// `alumnosHablando` es cuántos alumnos están sonando AHORA. El docente no cuenta y siempre tiene
// lugar: su voz no puede quedar afuera por un tope que existe para los alumnos.
//
// Vive acá y no en services/transmision.js porque la usa el proceso de medios, que no puede
// cargar mongoose (D4). Un conteo que llega roto (undefined, negativo) se lee como "nadie
// hablando"; uno desbocado (Infinity) como lleno — nunca abre 30 micrófonos.
function hayLugar(alumnosHablando, esDocente) {
  if (esDocente) return true;
  const n = Math.max(0, Number(alumnosHablando) || 0);
  return n < MAX_VOCES - 1;
}

// Qué recibe UN consumidor de video según la capa de la sala (C2 y C3 de
// specs/transmision-camara-primero.spec.md). Devuelve { pausar, capa } donde `capa` es el índice
// de simulcast: 0 = baja (180p), 1 = media (360p).
//
//   · solo audio                       → todo el video en pausa
//   · cámara con pantalla al lado      → es la cámara CHICA: capa baja, y solo en la mejor capa
//   · el resto (cámara sola, pantalla) → la capa que diga el gobernador
//
// La pantalla tiene una sola capa: pedirle la 1 o la 0 da lo mismo, mediasoup manda la que hay.
function planDeVideo({ fuente = '', hayPantalla = false, capa = CAPAS[0].id } = {}) {
  if (capa === 'audio' || !capa) return { pausar: true, capa: 0 };
  if (fuente === 'camara' && hayPantalla) {
    return capa === CAPAS[0].id ? { pausar: false, capa: 0 } : { pausar: true, capa: 0 };
  }
  return { pausar: false, capa: capa === '360p' ? 1 : 0 };
}

module.exports = {
  consumoMbps, ocupacion, capaPermitida, decidir, estimarMB, hayLugar, planDeVideo,
  PRESUPUESTO_MBPS, MAX_CLASES,
};
