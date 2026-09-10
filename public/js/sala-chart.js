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
  const ordenada  = mediaY - pendiente * mediaX;

  // ⭐ QUÉ TAN BIEN LA RECTA DESCRIBE LOS PUNTOS (R²). Agregado el 2026-09-10.
  //
  // Sin esto el gráfico daba un veredicto SIEMPRE, aunque los puntos no siguieran ninguna
  // recta. Medido en producción ese día, el rango de 7 días decía "sube" sobre esto:
  //
  //     7 salas → 934 ms      10 salas → 182 ms
  //
  // …que va para abajo. Una pendiente sobre puntos dispersos es un número, no una conclusión.
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (pendiente * xs[i] + ordenada)) ** 2;
    ssTot += (ys[i] - mediaY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  const puntos = lista.map(p => ({
    x: maxX === minX ? ancho / 2 : ((p.salas - minX) * ancho) / (maxX - minX),
    y: alto - (p.msPorPoll / topeY) * alto,
    salas: p.salas, msPorPoll: p.msPorPoll, minutos: p.minutos,
  }));

  const porDiezSalas = pendiente * 10;

  // ⚠️ EL R² SOLO DECIDE CUANDO HAY ALGO QUE EXPLICAR, y esto costó un test.
  //
  // La tentación es "si el ajuste es malo, no opines". Pero **una curva de verdad plana tiene
  // R² casi cero por construcción**: no hay varianza que explicar, así que ninguna recta la
  // "explica". Con el R² como primer filtro, el mejor resultado posible —el costo por poll no
  // se mueve— se reportaba como "los puntos no siguen una recta". Justo al revés.
  //
  // El orden correcto es mirar primero cuánto se MUEVEN los puntos:
  //   · si apenas se mueven, ya está: es plano, y el R² no viene al caso;
  //   · si se mueven mucho, ahí sí importa si una recta lo explica o es una nube.
  const DISPERSION_PLANA = 0.25;   // el rango vale menos de un cuarto del promedio
  const R2_MINIMO        = 0.5;

  const dispersion = mediaY === 0 ? 0 : (Math.max(...ys) - Math.min(...ys)) / mediaY;

  let veredicto;
  if (dispersion < DISPERSION_PLANA) {
    veredicto = 'plano';
  } else if (r2 < R2_MINIMO) {
    veredicto = 'disperso';
  } else {
    // El umbral: que 10 salas más agreguen menos de 1 ms al poll es "plano" para cualquier uso
    // práctico. Por encima de eso conviene mirarlo antes de que el aula lo note.
    veredicto = porDiezSalas < 1 ? 'plano' : (porDiezSalas < 3 ? 'sube-poco' : 'sube');
  }

  return { puntos, pendiente, porDiezSalas, r2, dispersion, veredicto,
           minX, maxX, topeY, R2_MINIMO, DISPERSION_PLANA };
}

/* ─── ⭐ El diagnóstico ──────────────────────────────────────────────────────── */

// Por encima de esto, el proceso tardó en atender un timer que ya debía haber disparado.
const LOOP_P99_ALERTA = 50;

// ⭐ Mínimo de polls para que un PROMEDIO signifique algo (2026-09-11).
//
// Sin esto el panel afirmaba con un puñado de muestras. El caso que lo destapó: un `pm2 reload`
// deja el cache del curso vacío en los dos workers, así que los primeros polls son todos
// fallos; con la escuela vacía esos polls fríos se quedan con el promedio del rango entero, y el
// panel lo leía como el estado normal.
//
// 200 es bajo a propósito: UNA persona en UNA sala aporta ~900 polls por hora, así que esto no
// tapa datos reales — solo el arranque y las visitas de treinta segundos.
const MUESTRA_MINIMA = 200;

const ORDEN = { alerta: 0, aviso: 1, ok: 2 };
const ordenar = (h) => h.slice().sort((a, b) => ORDEN[a.nivel] - ORDEN[b.nivel]);

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
 * El retraso del event loop, que distingue un PICO de un ESTADO.
 *
 * ⚠️ `loopP99Ms` NO es un promedio sobre los polls: es el peor minuto del rango —se agrega con
 * `$max`, y dentro del minuto ya es un p99—. Un solo reinicio o una recolección de basura lo
 * fijan para las 24 h enteras.
 *
 * ⭐ CORREGIDO EL 2026-09-11. Antes esta rama entraba SOLO por `loopP99Ms > 50` y después
 * imprimía `resto` como si fuera su prueba, sin mirarlo nunca. Con 338 ms de pico y 0,02 ms de
 * espera el panel decía *"de los 59,99 ms del poll, 0,02 son esperando turno y no trabajando"* y
 * concluía *"el cuello es CPU, no la base"* — lo contrario de lo que decían sus propios números,
 * porque 59,97 de esos ms eran trabajo, y el trabajo del poll es la base.
 *
 * Saturación es pico alto **y** polls pagando cola. Con una sola de las dos, es un pico.
 *
 * Se devuelve incluso sin polls: un día sin nadie es justo el que dice si el proceso se traba
 * solo, y ahí no hay promedios que mirar.
 */
function hallazgoDelLoop(r, d, mongo, colaDomina) {
  if (r.loopP99Ms == null || r.loopP99Ms <= LOOP_P99_ALERTA) return null;

  if (colaDomina) {
    return {
      nivel: 'alerta',
      titulo: `El proceso está saturado: el event loop se atrasa ${r.loopP99Ms} ms`,
      detalle: `De los ${r.msPorPoll} ms del poll, ${d.resto} son esperando turno y no trabajando, contra ${mongo} ms de trabajo real. El cuello es CPU, no la base: acá no sirve tocar queries ni índices.`,
    };
  }

  const cola = d
    ? `los polls no están pagando cola (${d.resto} ms de espera contra ${mongo} ms de trabajo real)`
    : 'no hubo polls, así que no se puede saber si alguien lo pagó';

  return {
    nivel: 'aviso',
    titulo: `Pico de ${r.loopP99Ms} ms en el event loop, en un solo minuto`,
    detalle: `Es el peor minuto del rango, no su estado: ${cola}. Un reinicio, una recolección de basura o un trabajo pesado de un minuto alcanzan para esto. Si se repite rango tras rango, ahí sí es saturación.`,
  };
}

/**
 * Traduce el resumen a una lista de hallazgos ordenados por gravedad.
 *
 * Cada hallazgo lleva `nivel` ('ok' | 'aviso' | 'alerta'), un texto corto y qué mirar. Es el
 * reemplazo de "acordate de qué significa cada número".
 */
function diagnostico(resumen) {
  const r = resumen || {};
  const hallazgos = [];

  // El desglose del poll, y la pregunta que decide si su tiempo es cola o es trabajo.
  const d          = r.desglose;
  const mongo      = d ? +(d.sesion + d.presencia + d.estado).toFixed(2) : 0;
  const colaDomina = !!d && d.resto > mongo;

  // Va antes de cualquier corte por tráfico: es lo único que se puede afirmar un día sin nadie.
  const loop = hallazgoDelLoop(r, d, mongo, colaDomina);
  if (loop) hallazgos.push(loop);

  // Sin tráfico no hay nada que diagnosticar, y decirlo es mejor que pintar todo en verde.
  if (!r.polls) {
    hallazgos.push({ nivel: 'ok', titulo: 'No hay nadie en ninguna sala',
                     detalle: 'No es un problema: es que no hubo polls en este rango.' });
    return ordenar(hallazgos);
  }

  // ⭐ Muestra chica: los promedios del rango todavía no significan nada, así que el panel se
  // calla en vez de afirmar. El pico del event loop de arriba sí vale — no es un promedio.
  if (r.polls < MUESTRA_MINIMA) {
    hallazgos.push({
      nivel: 'aviso',
      titulo: `Solo ${r.polls} polls en el rango: muy poco para promediar`,
      detalle: `Debajo de ${MUESTRA_MINIMA} polls, un par de polls lentos —los del arranque, con el cache del curso todavía vacío— se quedan con el promedio del rango entero. Los números están, pero no se puede concluir de ellos: mirá un rango más largo.`,
    });
    return ordenar(hallazgos);
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

  // ── Salas que quedaron colgadas ──
  //
  // La diferencia entre "salas con gente" y "sesiones sin cerrar". El autocierre
  // (`closeStaleSessions`) solo corre cuando alguien abre el panel de dirección o de
  // preceptoría, así que una clase que terminó y a la que nadie volvió queda abierta.
  //
  // No es una falla del servidor: es una sala que dice "en vivo" y no lo está, y eso lo ven
  // dirección y preceptoría en sus tarjetas. Aviso, no alerta.
  if (r.salasColgadas >= 3) {
    hallazgos.push({
      nivel: 'aviso',
      titulo: `${r.salasColgadas} salas quedaron abiertas sin nadie adentro`,
      detalle: `Hay ${r.sesionesSinCerrar} sesiones sin cerrar y solo ${r.salasAbiertas} con gente. El autocierre solo barre cuando alguien abre el panel de dirección o preceptoría: hasta entonces esas clases figuran "en vivo" sin estarlo.`,
    });
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
  // ⭐ Y ACÁ EL PANEL DEJA DE ADIVINAR (2026-09-10). Antes decía "probablemente una query
  // nueva", que era una corazonada. Con el desglose se puede señalar la fase, y con el retraso
  // del event loop se distingue "la base tarda" de "el proceso está saturado" — que llevan a
  // arreglos opuestos: índices contra CPU.
  const cachePct = (palancas.cache || {}).pct;

  if (r.msPorPoll > 20 && d) {
    const fases = [
      { n: 'resolver la sesión de la sala', ms: d.sesion },
      { n: 'la presencia',                  ms: d.presencia },
      { n: 'armar el estado (mensajes y presencia)', ms: d.estado },
      { n: 'serializar la respuesta',       ms: d.cuerpo },
    ].sort((a, b) => b.ms - a.ms);

    if (!colaDomina) {
      // El tiempo es trabajo: se nombra la fase, que es lo accionable.
      hallazgos.push({
        nivel: 'aviso',
        titulo: `El poll tarda ${r.msPorPoll} ms, y ${fases[0].ms} se van en ${fases[0].n}`,
        detalle: cachePct != null && cachePct >= 60
          ? 'Las palancas funcionan, así que el tiempo es trabajo real de la base en esa fase. Ahí es donde conviene mirar índices o sacar una query.'
          : 'Y encima el cache no está ayudando: arreglá eso primero, que puede explicarlo solo.',
      });
    } else if (!loop) {
      // La cola domina pero el event loop todavía no acusa: es la dirección a vigilar.
      hallazgos.push({
        nivel: 'aviso',
        titulo: `El poll pasa más tiempo esperando (${d.resto} ms) que trabajando (${mongo} ms)`,
        detalle: 'El proceso tiene cola. Todavía no llega a saturarse —el event loop está bien— pero es la dirección a vigilar si sube el uso.',
      });
    }
    // Cola dominando Y loop acusando ya lo dijo la alerta de saturación, arriba de todo.
  }

  if (!hallazgos.some(h => h.nivel !== 'ok')) {
    hallazgos.unshift({ nivel: 'ok', titulo: 'La sala se está comportando como dice la spec',
                        detalle: 'Las palancas funcionan, los mensajes llegan y el atraso vuelve a cero.' });
  }

  return ordenar(hallazgos);
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
