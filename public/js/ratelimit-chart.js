// Matemática del gráfico de consumo del rate limit (/superadmin/monitor, sección Rate limit).
// Fase 2 de specs/monitor-ratelimit.spec.md.
//
// Está separado de la vista por el mismo motivo que public/js/devoluciones.js: sin DOM se
// puede testear con node:test (tests/unit/ratelimitChart.test.js). Se carga como <script>
// en monitor.ejs y como require() en los tests.
//
// El proyecto no usa librerías de charting: el monitor ya dibuja sus sparklines con
// <polyline> a mano y esto extiende ese vocabulario.

/**
 * Rellena con ceros los buckets que no tienen muestra, entre `desde` y `hasta`.
 *
 * Es lo que hace que el eje X sea TIEMPO y no una secuencia de índices: sin esto, un hueco
 * de tres horas sin tráfico se dibujaría pegado al punto anterior, exactamente igual que un
 * hueco de un minuto, y la curva mentiría sobre cuándo pasó cada cosa.
 *
 * Un bucket sin muestra queda marcado con `vacio: true`: puede ser "no hubo tráfico" o "el
 * servidor estaba apagado", y quien lea el gráfico merece poder distinguirlo del cero real.
 */
function rellenarBuckets(serie, desde, hasta, bucketMin) {
  const bucketMs = bucketMin * 60 * 1000;
  const inicio   = Math.floor(new Date(desde).getTime() / bucketMs) * bucketMs;
  const fin      = Math.floor(new Date(hasta).getTime() / bucketMs) * bucketMs;

  const porClave = new Map();
  (serie || []).forEach(p => {
    const clave = Math.floor(new Date(p.t).getTime() / bucketMs) * bucketMs;
    porClave.set(clave, p);
  });

  const salida = [];
  for (let t = inicio; t <= fin; t += bucketMs) {
    const p = porClave.get(t);
    salida.push(p
      ? { ...p, t: new Date(t), vacio: false }
      : { t: new Date(t), pasadas: 0, bloqueadas: 0, picoUsado: 0, picoIp: '', vacio: true });
  }
  return salida;
}

/**
 * Tope del eje Y para la curva de ocupación del cupo.
 *
 * Normalmente es el límite configurado, para que la altura se lea como "porcentaje del
 * cupo". Pero si alguna vez el pico lo supera —pasa: el cupo es por worker y el `max` puede
 * bajarse en caliente— el eje tiene que crecer o la curva se dibujaría fuera del recuadro.
 * El 10% de aire arriba evita que el pico quede pegado al borde.
 */
function topeEjeY(serie, limite) {
  const pico = Math.max(0, ...(serie || []).map(p => p.picoUsado || 0));
  const base = limite > 0 ? limite : 0;
  if (pico > base) return Math.ceil(pico * 1.1);
  return base || Math.max(1, Math.ceil(pico * 1.1));
}

/** Puntos "x,y x,y ..." para un <polyline>, mapeando el campo pedido contra el tope del eje. */
function puntosSerie(serie, campo, { ancho, alto, tope }) {
  const lista = serie || [];
  if (lista.length === 0) return '';
  const paso = lista.length > 1 ? ancho / (lista.length - 1) : 0;
  const techo = tope > 0 ? tope : 1;
  return lista.map((p, i) => {
    const x = lista.length > 1 ? i * paso : ancho / 2;
    const y = alto - Math.min(1, (p[campo] || 0) / techo) * alto;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Mismo trazo que puntosSerie pero cerrado contra la base, para rellenar el área. */
function pathArea(serie, campo, { ancho, alto, tope }) {
  const puntos = puntosSerie(serie, campo, { ancho, alto, tope });
  if (!puntos) return '';
  const lista = serie || [];
  const xIni  = lista.length > 1 ? 0 : ancho / 2;
  const xFin  = lista.length > 1 ? ancho : ancho / 2;
  return `M${xIni},${alto} L${puntos.split(' ').join(' L')} L${xFin},${alto} Z`;
}

/**
 * Alturas (0..1) de las barras de tráfico. Escala propia —el máximo de la serie— porque
 * `pasadas por bucket` y `cupo consumido` son magnitudes distintas: meterlas en el mismo eje
 * haría que una de las dos quedara siempre aplastada contra el piso.
 */
function alturasTrafico(serie) {
  const lista = serie || [];
  const max   = Math.max(1, ...lista.map(p => p.pasadas || 0));
  return lista.map(p => ({
    alto:     (p.pasadas || 0) / max,
    bloqueado: (p.bloqueadas || 0) > 0,
    vacio:     !!p.vacio,
  }));
}

/**
 * Etiquetas del eje X: 4 marcas repartidas, con el formato que corresponde al rango.
 * En 7d la hora no aporta nada y el día sí; en 1h es exactamente al revés.
 */
function etiquetasEjeX(serie, rango) {
  const lista = serie || [];
  if (lista.length === 0) return [];

  const soloDia  = rango === '7d';
  // hour12:false — es-AR devuelve "12:59 a. m." por defecto, que en un eje de monitoreo se
  // lee peor que "00:59" y encima ocupa el doble.
  const formatea = (fecha) => soloDia
    ? new Date(fecha).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
    : new Date(fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });

  const cuantas = Math.min(4, lista.length);
  const marcas  = [];
  for (let i = 0; i < cuantas; i++) {
    const idx = cuantas === 1 ? 0 : Math.round(i * (lista.length - 1) / (cuantas - 1));
    marcas.push({ pos: lista.length > 1 ? idx / (lista.length - 1) : 0.5, label: formatea(lista[idx].t) });
  }
  return marcas;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    rellenarBuckets, topeEjeY, puntosSerie, pathArea, alturasTrafico, etiquetasEjeX,
  };
}
