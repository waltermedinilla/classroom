// La matemática y —sobre todo— el DIAGNÓSTICO del panel de la sala en vivo
// (/superadmin/monitor, sección "Sala en vivo"). Ver specs/monitor-sala-escala.spec.md.
//
// Separado de la vista por el mismo motivo que ratelimit-chart.js: sin DOM se puede testear
// con node:test (tests/unit/salaChart.test.js). Se carga como <script> en monitor.ejs y como
// require() en los tests.
//
// ⭐ LO IMPORTANTE DE ESTE ARCHIVO NO SON LOS GRÁFICOS: es `diagnostico()`. Un panel lleno de
// números obliga a que quien lo mira sepa de antemano qué es normal y qué no. Esa traducción
// —de los contadores a "qué está interfiriendo"— es una regla, y las reglas se testean.

/* ─── Gráficos ──────────────────────────────────────────────────────────────── */

/**
 * Convierte una serie en los `points` de un <polyline> de 300×90, con el eje Y arrancando
 * SIEMPRE en cero.
 *
 * ⚠️ El cero no es negociable en este panel. Un eje que arranca en el mínimo hace que una
 * variación de 3,1 a 3,4 ms se vea como un salto vertical enorme, y este gráfico existe
 * justamente para distinguir "subió un poco" de "se disparó".
 */
function puntosDe(serie, campo, ancho, alto) {
  ancho = ancho || 300; alto = alto || 90;
  const lista = serie || [];
  if (!lista.length) return { points: '', tope: 0 };

  const valores = lista.map(p => Number(p[campo]) || 0);
  const tope    = Math.max(1, ...valores);

  const points = lista.map((p, i) => {
    const x = lista.length === 1 ? ancho / 2 : (i * ancho) / (lista.length - 1);
    const y = alto - ((Number(p[campo]) || 0) / tope) * alto;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return { points, tope };
}

/**
 * ⭐ El eje 2: costo por poll contra cantidad de salas abiertas.
 *
 * Devuelve los puntos ya escalados MÁS la pendiente de la recta que mejor los aproxima. La
 * pendiente es el número que contesta la pregunta de la spec: si el costo por poll no depende
 * de cuántas salas hay, la recta es plana y la sala escala. Si sube, hay algo superlineal.
 *
 * Se usa mínimos cuadrados sobre (salas, msPorPoll), que con 10-30 puntos alcanza y sobra.
 */
function curvaPorSalas(porSalas, ancho, alto) {
  ancho = ancho || 300; alto = alto || 90;
  const lista = (porSalas || []).filter(p => p && p.salas != null);
  if (lista.length < 2) return { puntos: [], pendiente: null, veredicto: 'sin-datos' };

  const xs = lista.map(p => p.salas);
  const ys = lista.map(p => p.msPorPoll);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const topeY = Math.max(1, ...ys);

  const n = lista.length;
  const mediaX = xs.reduce((a, b) => a + b, 0) / n;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mediaX) * (ys[i] - mediaY);
    den += (xs[i] - mediaX) ** 2;
  }
  const pendiente = den === 0 ? 0 : num / den;   // ms de poll por cada sala más

  const puntos = lista.map(p => ({
    x: maxX === minX ? ancho / 2 : ((p.salas - minX) * ancho) / (maxX - minX),
    y: alto - (p.msPorPoll / topeY) * alto,
    salas: p.salas, msPorPoll: p.msPorPoll, minutos: p.minutos,
  }));

  // El umbral: que 10 salas más agreguen menos de 1 ms al poll es "plano" para cualquier uso
  // práctico. Por encima de eso conviene mirarlo antes de que el aula lo note.
  const porDiezSalas = pendiente * 10;
  const veredicto = porDiezSalas < 1 ? 'plano' : (porDiezSalas < 3 ? 'sube-poco' : 'sube');

  return { puntos, pendiente, porDiezSalas, veredicto, minX, maxX, topeY };
}

/* ─── ⭐ El diagnóstico ──────────────────────────────────────────────────────── */

// Las palancas, con el umbral por debajo del cual dejan de estar haciendo su trabajo.
//
// Los umbrales son bajos a propósito: no están para pedir perfección sino para detectar que
// algo SE ROMPIÓ. Una palanca sana anda arriba del 85%; una rota cae al piso, no al 60%.
const PALANCAS = [
  { clave: 'cache',      nombre: 'RN-1 · cache del curso',       piso: 60,
    roto: 'El cache del curso no está sirviendo: se está resolviendo la materia entera en cada poll. Mirá si algo invalida de más o si el TTL quedó en cero.' },
  { clave: 'presencia',  nombre: 'RN-2 · huella de presencia',   piso: 50,
    roto: 'La fila de presencia viaja en casi todos los polls: la huella cambia siempre. Suele ser un campo no determinista que entró al bloque de presencia.' },
  { clave: 'escrituras', nombre: 'RN-3 · ventana de escritura',  piso: 40,
    roto: 'La presencia se está escribiendo casi en cada poll: la ventana no está frenando nada.' },
];

/**
 * Traduce el resumen a una lista de hallazgos ordenados por gravedad.
 *
 * Cada hallazgo lleva `nivel` ('ok' | 'aviso' | 'alerta'), un texto corto y qué mirar. Es el
 * reemplazo de "acordate de qué significa cada número".
 */
function diagnostico(resumen) {
  const r = resumen || {};
  const hallazgos = [];

  // Sin tráfico no hay nada que diagnosticar, y decirlo es mejor que pintar todo en verde.
  if (!r.polls) {
    return [{ nivel: 'ok', titulo: 'No hay nadie en ninguna sala',
              detalle: 'No es un problema: es que no hubo polls en este rango.' }];
  }

  // ── El síntoma que importa: ¿llegan los mensajes? ──
  //
  // ⭐ LO QUE DECIDE NO ES EL PICO, ES LA REPETICIÓN. Corregido el 2026-09-08 con los primeros
  // datos reales: un pico de 101 mensajes de atraso resultó ser UNA reconexión, y bajó solo a
  // 6, 4 y 1 en los minutos siguientes. Con el máximo suelto se leía como un congelamiento.
  //
  //   · una reconexión aporta UN poll muy atrasado y se acabó;
  //   · un navegador congelado sigue polleando cada 4-8 s con el mismo `since` viejo, así que
  //     aporta decenas por minuto, minuto tras minuto.
  //
  // Por eso se mira el PORCENTAJE de polls muy atrasados, no el peor caso.
  const atraso = r.atraso || {};
  const umbral = atraso.umbral || 10;

  if (atraso.pctMuyAtrasados >= 2) {
    hallazgos.push({
      nivel: 'alerta',
      titulo: `${atraso.pctMuyAtrasados}% de los polls llega más de ${umbral} mensajes atrás`,
      detalle: 'No son reconexiones sueltas: se repite. El cursor no está avanzando — reciben y no pintan, o descartan. Es la firma del congelamiento del 2026-09-08. Revisá que el salaPoll.js que llega al navegador sea el nuevo.',
    });
  } else if (atraso.muyAtrasados > 0) {
    hallazgos.push({
      nivel: 'ok',
      titulo: `${atraso.muyAtrasados} reconexiones (pico de ${atraso.max} mensajes)`,
      detalle: 'Alguien volvió después de estar desconectado y se bajó lo atrasado de una. Es normal: si fuera un cursor trabado, se repetiría poll tras poll.',
    });
  }

  // ── El otro síntoma: ¿tarda? ──
  const entrega = r.entrega || {};
  if (entrega.mensajes) {
    const p95 = entrega.p95 || {};
    if (p95.ms === null) {
      hallazgos.push({
        nivel: 'alerta',
        titulo: 'Los mensajes tardan más de 20 s en llegar',
        detalle: 'Muy por encima de los 8 s que es el techo normal con la cadencia lenta. Mirá el ms por poll y la red del aula.',
      });
    } else if (p95.ms > 8000) {
      hallazgos.push({
        nivel: 'aviso',
        titulo: `El 95% de los mensajes llega en ${p95.etiqueta}`,
        detalle: 'Por encima de los 8 s del ritmo lento. Todavía no es grave, pero conviene mirarlo.',
      });
    }
  }

  // ── Las palancas ──
  const palancas = r.palancas || {};
  PALANCAS.forEach(p => {
    const dato = palancas[p.clave] || {};
    if (dato.pct == null) return;            // no tuvo ocasiones: no es una falla
    if (dato.pct < p.piso) {
      hallazgos.push({ nivel: 'alerta', titulo: `${p.nombre} al ${dato.pct}%`, detalle: p.roto });
    }
  });

  // ── El costo, cruzado con las palancas ──
  //
  // Un ms por poll alto CON el cache sano no se explica por las palancas: significa que
  // apareció trabajo nuevo en el poll. Es la lectura que un número suelto no da.
  const cachePct = (palancas.cache || {}).pct;
  if (r.msPorPoll > 20 && cachePct != null && cachePct >= 60) {
    hallazgos.push({
      nivel: 'aviso',
      titulo: `El poll tarda ${r.msPorPoll} ms con el cache sano`,
      detalle: 'Las palancas están funcionando, así que el tiempo viene de otro lado: probablemente una query nueva en el camino del poll.',
    });
  }

  if (!hallazgos.some(h => h.nivel !== 'ok')) {
    hallazgos.unshift({ nivel: 'ok', titulo: 'La sala se está comportando como dice la spec',
                        detalle: 'Las palancas funcionan, los mensajes llegan y el atraso vuelve a cero.' });
  }

  const orden = { alerta: 0, aviso: 1, ok: 2 };
  return hallazgos.sort((a, b) => orden[a.nivel] - orden[b.nivel]);
}

/* ─── Formato ───────────────────────────────────────────────────────────────── */

// Números grandes, cortos y en español. 41.000 se lee peor que "41 mil" en una tarjeta.
function corto(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace('.', ',') + ' MM';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + ' mil';
  return String(Math.round(v));
}

function bytesCortos(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(1).replace('.', ',') + ' GB';
  if (v >= 1024 * 1024)        return (v / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  if (v >= 1024)               return (v / 1024).toFixed(1).replace('.', ',') + ' KB';
  return v + ' B';
}

// Milisegundos de CPU ahorrados, en la unidad que se entienda: 468.000 ms son 7,8 minutos.
function tiempoCorto(ms) {
  const v = Number(ms) || 0;
  if (v >= 3600000) return (v / 3600000).toFixed(1).replace('.', ',') + ' h';
  if (v >= 60000)   return (v / 60000).toFixed(1).replace('.', ',') + ' min';
  if (v >= 1000)    return (v / 1000).toFixed(1).replace('.', ',') + ' s';
  return Math.round(v) + ' ms';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { puntosDe, curvaPorSalas, diagnostico, corto, bytesCortos, tiempoCorto, PALANCAS };
} else if (typeof window !== 'undefined') {
  window.SalaChart = { puntosDe, curvaPorSalas, diagnostico, corto, bytesCortos, tiempoCorto, PALANCAS };
}
