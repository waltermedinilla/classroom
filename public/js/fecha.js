/**
 * Fechas del lado del navegador, en la zona horaria de la ESCUELA.
 *
 * El gemelo de `fmt` en services/liveRoom.js, con la misma API y los mismos textos.
 * Existe por la otra mitad del bug de las tres horas: lo que renderiza el servidor salía
 * en UTC, y lo que arma el navegador salía en la zona del equipo — y las máquinas del aula
 * tienen cualquier zona configurada, así que el mismo vencimiento se veía distinto en cada
 * pantalla. Con esto, servidor y navegador imprimen exactamente lo mismo.
 *
 * La zona NO se decide acá: llega en `window.SCHOOL_TZ` desde partials/footer.ejs, que la
 * toma de `fmt.TZ`. Un solo dueño, services/liveRoom.js.
 */
(function (global) {
  'use strict';

  var TZ = global.SCHOOL_TZ || 'America/Argentina/Buenos_Aires';

  // Se construyen una sola vez: Intl.DateTimeFormat es caro y esto corre por cada tarjeta
  // de actividad de cada repintado.
  function opts(o) {
    var base = { timeZone: TZ };
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) base[k] = o[k];
    return new Intl.DateTimeFormat('es-AR', base);
  }

  var F_HORA   = opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var F_HORA_S = opts({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var F_DIA    = opts({ weekday: 'long', day: 'numeric', month: 'long' });
  var F_LARGA  = opts({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  var F_CORTA  = opts({ day: '2-digit', month: '2-digit', year: 'numeric' });
  var F_FECHAH = opts({ day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var F_DM     = opts({ day: 'numeric', month: 'short' });
  var F_DMA    = opts({ day: 'numeric', month: 'short', year: 'numeric' });
  var F_DMH    = opts({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var F_DMAH   = opts({ day: 'numeric', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var F_DML    = opts({ day: 'numeric', month: 'long', year: 'numeric' });
  var F_DMLH   = opts({ day: 'numeric', month: 'long', year: 'numeric',
                        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  // Una fecha nula o basura devuelve '' y no "Invalid Date": estos textos van directo a la
  // pantalla. Mismo criterio que el `formatear` del servidor.
  function fmtear(f, d) {
    if (!d) return '';
    var t = new Date(d);
    return isNaN(t.getTime()) ? '' : f.format(t);
  }

  global.Fecha = {
    TZ:              TZ,
    hora:            function (d) { return fmtear(F_HORA, d); },    // 14:05
    horaSegundos:    function (d) { return fmtear(F_HORA_S, d); },  // 14:05:09
    fechaDia:        function (d) { return fmtear(F_DIA, d); },     // jueves, 6 de agosto
    fechaLarga:      function (d) { return fmtear(F_LARGA, d); },   // jueves, 6 de agosto de 2026
    fechaCorta:      function (d) { return fmtear(F_CORTA, d); },   // 06/08/2026
    fechaHora:       function (d) { return fmtear(F_FECHAH, d); },  // 06/08/2026, 14:05:09
    diaMes:          function (d) { return fmtear(F_DM, d); },      // 6 ago
    diaMesAnio:      function (d) { return fmtear(F_DMA, d); },     // 6 de ago de 2026
    diaMesHora:      function (d) { return fmtear(F_DMH, d); },     // 6 ago, 14:05
    diaMesAnioHora:  function (d) { return fmtear(F_DMAH, d); },    // 6 de ago de 2026, 14:05
    diaMesLargo:     function (d) { return fmtear(F_DML, d); },     // 6 de agosto de 2026
    diaMesLargoHora: function (d) { return fmtear(F_DMLH, d); },    // 6 de agosto de 2026 a las 14:05
  };
})(typeof window !== 'undefined' ? window : globalThis);

// Igual que public/js/ratelimit-chart.js: en el navegador se carga como <script> y cuelga de
// window; bajo node --test se carga con require(). Una sola implementacion para los dos, que
// es justamente lo que evita que el navegador y el servidor impriman horas distintas.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Fecha;
}
