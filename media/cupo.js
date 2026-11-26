// EL CUPO: quién entra a transmitir, quién espera y en qué calidad va cada clase.
// specs/transmision-cupo-automatico.spec.md (D3, D4, D5, D2).
//
// Funciones PURAS, como el gobernador (media/aforo.js): sin mediasoup, sin mongoose, sin reloj
// propio (el "ahora" entra por parámetro). Así se prueban miles de escenarios sin levantar nada,
// y el proceso de medios (media/servidor.js) solo guarda el estado y llama a esto.
//
// Diferencia con el gobernador anterior: aquel elegía UNA capa para toda la escuela y decidía
// con la clase ya al aire. Esto decide ANTES de que la clase salga (admitir) y reparte la
// calidad CLASE POR CLASE, bajando primero a quien menos usa la sala (capasPorClase).

const { CAPAS, CUPO, CAMARA_CHICA_MBPS } = require('../config/transmision');

const ORDEN = CAPAS.map(c => c.id);                       // ['360p', '180p', 'audio']
const MBPS = Object.fromEntries(CAPAS.map(c => [c.id, c.mbps]));
const UMBRAL_AUDIO = CAPAS.find(c => c.id === 'audio').umbral;
const contar = (x) => Math.max(0, Number(x) || 0);

// Lo que consume UNA clase en una capa: sus espectadores por el costo de la capa, más la cámara
// chica (pantalla + cámara) solo en la mejor capa, igual que el gobernador.
function costoDeClase(c, capa) {
  const n = contar(c.espectadores);
  const chica = capa === ORDEN[0] ? contar(c.conPantallaYCamara) * CAMARA_CHICA_MBPS : 0;
  return n * (MBPS[capa] ?? MBPS[ORDEN[0]]) + chica;
}

const total = (clases, capas) => clases.reduce((a, c) => a + costoDeClase(c, capas[c.id]), 0);

// D5: el orden en que se baja la calidad. Primero el docente que MENOS usa la sala (clases en
// vivo de los últimos 30 días); si empatan, la que empezó a transmitir MÁS TARDE.
function ordenDeBaja(clases) {
  return clases.slice().sort((a, b) =>
    contar(a.uso30) - contar(b.uso30) || contar(b.desde) - contar(a.desde) || String(a.id).localeCompare(String(b.id)));
}

// La asignación "limpia" para un límite dado: todas en media; si se pasa, se baja de a una a
// calidad baja en el orden de D5; si ni así, de a una a solo audio.
function asignar(clases, presupuesto, limiteMezcla) {
  const capas = Object.fromEntries(clases.map(c => [c.id, ORDEN[0]]));
  const orden = ordenDeBaja(clases);
  for (const c of orden) {
    if (total(clases, capas) <= presupuesto * limiteMezcla) break;
    capas[c.id] = ORDEN[1];
  }
  for (const c of orden) {
    if (total(clases, capas) <= presupuesto * UMBRAL_AUDIO) break;
    capas[c.id] = ORDEN[2];
  }
  return capas;
}

// ⭐ D5. La capa de cada clase al aire. `clases`: [{ id, espectadores, conPantallaYCamara, uso30,
// desde }]. `previas`: { id → capa } de la vuelta anterior (para la histéresis).
//
// Bajar es inmediato (protege el puerto). SUBIR solo si la clase también subiría con un límite
// 10 puntos más bajo: así una carga estable no hace saltar a nadie entre media y baja.
function capasPorClase(clases, { presupuesto, previas = {} } = {}) {
  const lista = (clases || []).filter(c => c && c.id != null);
  const ahora = asignar(lista, presupuesto, CUPO.LIMITE_MEZCLA);
  const conMargen = asignar(lista, presupuesto, CUPO.LIMITE_MEZCLA - CUPO.HISTERESIS);
  const out = {};
  for (const c of lista) {
    const antes = previas[c.id];
    const nueva = ahora[c.id];
    const mejora = antes && ORDEN.indexOf(nueva) < ORDEN.indexOf(antes);
    if (!mejora) { out[c.id] = nueva; continue; }
    // Quiere subir: sube solo hasta donde lo permite el límite con margen (que nunca es mejor que
    // `ahora`, porque es más estricto). Si con margen no mejora, se queda como estaba.
    const conM = conMargen[c.id];
    out[c.id] = ORDEN.indexOf(conM) < ORDEN.indexOf(antes) ? conM : antes;
  }
  return out;
}

// ⭐ D3. ¿Entra una clase más, en calidad MEDIA?
//   clases:   las que están al aire (y las admitidas que todavía no conectaron)
//   nueva:    { espectadores } que se estiman para la clase que pide
//   medidas:  { cpu, perdida, salidaMbps } del proceso de medios, o null si no hay (RN-6)
//   capacidad: la capacidad medida del puerto (Mbit/s) o null
// Devuelve { entra, motivo, proyectado }.
function admitir({ clases = [], nueva = {}, medidas = null, presupuesto, capacidad = null } = {}) {
  const enMedia = Object.fromEntries(clases.map(c => [c.id, ORDEN[0]]));
  const suma = total(clases, enMedia) + costoDeClase({ espectadores: nueva.espectadores }, ORDEN[0]);
  if (suma > presupuesto * CUPO.UMBRAL_ADMISION) return { entra: false, motivo: 'red', proyectado: suma };
  if (medidas) {
    if (Number.isFinite(medidas.cpu) && medidas.cpu >= CUPO.CPU_MAX) return { entra: false, motivo: 'procesador', proyectado: suma };
    if (Number.isFinite(medidas.perdida) && medidas.perdida >= CUPO.PERDIDA_MAX) return { entra: false, motivo: 'perdida', proyectado: suma };
    if (capacidad && Number.isFinite(medidas.salidaMbps)) {
      const extra = costoDeClase({ espectadores: nueva.espectadores }, ORDEN[0]);
      if (medidas.salidaMbps + extra > capacidad * CUPO.PUERTO_MAX) return { entra: false, motivo: 'puerto', proyectado: suma };
    }
  }
  return { entra: true, motivo: medidas ? '' : 'sin-mediciones', proyectado: suma };
}

// ── D4. La lista de espera ──────────────────────────────────────────────────────────────────
//
// Un pedido: { sessionId, docente, materia, tieneClase, pedidoAt, vistoAt, uso30 }.
// Orden: primero los que tienen clase AHORA según el horario; entre ellos, el que tocó primero.

function ordenarCola(cola) {
  return cola.slice().sort((a, b) =>
    (b.tieneClase ? 1 : 0) - (a.tieneClase ? 1 : 0) || contar(a.pedidoAt) - contar(b.pedidoAt));
}

// Saca los pedidos que nadie renovó (pestaña cerrada) y las reservas vencidas. Una reserva
// vencida NO echa al docente: vuelve a la lista en su mismo orden (se le borra la reserva).
function limpiar({ cola = [], reserva = null, ahora }) {
  const viva = cola.filter(p => ahora - contar(p.vistoAt) <= CUPO.ESPERA_TTL_MS);
  let r = reserva;
  if (r && (ahora > r.hasta || !viva.some(p => p.sessionId === r.sessionId))) r = null;
  return { cola: viva, reserva: r };
}

// Pone o actualiza un pedido (lo llama cada vuelta del navegador que espera: así `tieneClase`
// se recalcula cuando empieza el módulo, RN-3, y `vistoAt` lo mantiene vivo).
function anotar(cola, pedido, ahora) {
  const i = cola.findIndex(p => p.sessionId === pedido.sessionId);
  if (i < 0) return [...cola, { ...pedido, pedidoAt: ahora, vistoAt: ahora }];
  const nueva = cola.slice();
  nueva[i] = { ...cola[i], ...pedido, pedidoAt: cola[i].pedidoAt, vistoAt: ahora };
  return nueva;
}

const quitar = (cola, sessionId) => cola.filter(p => p.sessionId !== sessionId);

// El lugar de un pedido en la lista (1, 2, …) o 0 si no está.
function posicion(cola, sessionId) {
  return ordenarCola(cola).findIndex(p => p.sessionId === sessionId) + 1;
}

// ⭐ Lo que se contesta a quien toca Transmitir (o renueva su espera). Junta todo lo anterior:
//   - con alguien adelante (o una reserva de otro), espera aunque hubiera lugar: es justo;
//   - si es el primero y entra, entra (y se le borra la reserva si la tenía);
//   - si no entra, queda anotado y se le dice su lugar.
// Devuelve { entra, posicion, reservaHasta, motivo, estado } con el estado nuevo de la lista.
function pedirLugar({ estado, pedido, ahora, admision }) {
  let { cola, reserva } = limpiar({ cola: estado.cola || [], reserva: estado.reserva || null, ahora });
  cola = anotar(cola, pedido, ahora);
  const primero = ordenarCola(cola)[0];
  const esSuReserva = reserva && reserva.sessionId === pedido.sessionId;
  const reservaDeOtro = reserva && !esSuReserva;
  const leToca = esSuReserva || (!reservaDeOtro && primero && primero.sessionId === pedido.sessionId);

  if (leToca && admision.entra) {
    cola = quitar(cola, pedido.sessionId);
    return { entra: true, posicion: 0, reservaHasta: null, motivo: admision.motivo,
      estado: { cola, reserva: esSuReserva ? null : reserva } };
  }
  return {
    entra: false, posicion: posicion(cola, pedido.sessionId),
    reservaHasta: esSuReserva ? reserva.hasta : null,
    motivo: leToca ? admision.motivo : 'espera',
    estado: { cola, reserva },
  };
}

// D4. Cuando se libera lugar (y hay lista), el primero recibe una reserva de 3 minutos.
// `hayLugar` es la admisión calculada para él. No pisa una reserva vigente.
function reservarSiHayLugar({ estado, ahora, hayLugar }) {
  const { cola, reserva } = limpiar({ cola: estado.cola || [], reserva: estado.reserva || null, ahora });
  if (reserva || !hayLugar || !cola.length) return { cola, reserva, nueva: null };
  const primero = ordenarCola(cola)[0];
  const r = { sessionId: primero.sessionId, hasta: ahora + CUPO.RESERVA_MS };
  return { cola, reserva: r, nueva: r };
}

// ── D2. El presupuesto se achica solo si el puerto no da lo esperado (nunca se agranda) ─────
//
// `historial`: las últimas mediciones [{ t, perdida, salidaMbps }]. Si la pérdida estuvo por
// encima del 5 % durante 30 s seguidos con la salida por debajo del presupuesto, el nuevo
// presupuesto es lo que realmente se sostuvo (el máximo de salida en ese rato). Si no, null.
function achique({ historial = [], presupuesto, ahora }) {
  const ventana = historial.filter(m => ahora - m.t <= CUPO.ACHIQUE_SOSTENIDO_MS);
  if (!ventana.length) return null;
  const cubre = ahora - Math.min(...ventana.map(m => m.t)) >= CUPO.ACHIQUE_SOSTENIDO_MS - CUPO.MEDICION_MS;
  if (!cubre) return null;
  if (!ventana.every(m => Number(m.perdida) > CUPO.PERDIDA_ACHIQUE)) return null;
  const sostenido = Math.max(...ventana.map(m => contar(m.salidaMbps)));
  if (!(sostenido > 0) || sostenido >= presupuesto) return null;
  return Math.max(10, Math.floor(sostenido));
}

module.exports = {
  costoDeClase, ordenDeBaja, capasPorClase, admitir,
  ordenarCola, limpiar, anotar, quitar, posicion, pedirLugar, reservarSiHayLugar, achique,
};
