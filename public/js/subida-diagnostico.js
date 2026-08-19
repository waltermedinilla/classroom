// Diagnóstico de subidas fallidas, del lado del navegador.
//
// Cuando una subida falla, el que la sufre ve un cartel y nosotros no vemos nada: si la
// request murió en camino (red del aula, límite de cuerpo de un intermediario, timeout de
// proxy) el log del servidor está impecable, porque nunca le llegó. Este archivo cierra ese
// hueco: arma un reporte de lo que vio el navegador, se lo manda al servidor
// (POST /diagnostico/subida) y devuelve un CÓDIGO CORTO para mostrar en pantalla.
//
// El código es la llave: con una foto del cartel alcanza para encontrar el reporte entero.
//     node tools/ver-subida.js SUB-7F3A2C
//
// El dato que más pesa es cuántos bytes logró empujar el navegador antes de morir. Por eso
// hay que llamar a `progreso()` en cada `xhr.upload.onprogress` — sin eso el reporte no
// puede distinguir "se cortó a mitad de camino" de "subió entero y el servidor lo rechazó",
// que son problemas de dos personas distintas.
//
// Uso:
//     const seg = SubidaDiag.seguir('/activities/123/upload-submission-file', file);
//     xhr.upload.onprogress = (e) => { SubidaDiag.progreso(seg, e); ... };
//     xhr.onload  = () => { if (falló) { const f = SubidaDiag.fallar(seg, xhr, 'http'); … } };
//     xhr.onerror = () => { const f = SubidaDiag.fallar(seg, null, 'red'); … };
//
// `fallar()` devuelve { codigo, detalle } y NUNCA lanza: si el diagnóstico se rompe, la
// subida ya falló y lo último que hay que hacer es taparle al usuario el error de verdad
// con un error nuestro.
(function () {
  'use strict';

  // Sin I, L ni O: se confunden con 1 y 0 cuando alguien lee el código de una foto de la
  // pantalla, que es exactamente como va a llegar.
  var ALFABETO = '0123456789ABCDEFGHJKMNPQRSTUVWXYZ';

  function nuevoCodigo() {
    var s = '';
    var n = 6;
    if (window.crypto && window.crypto.getRandomValues) {
      var buf = new Uint8Array(n);
      window.crypto.getRandomValues(buf);
      for (var i = 0; i < n; i++) s += ALFABETO[buf[i] % ALFABETO.length];
    } else {
      for (var j = 0; j < n; j++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
    }
    return 'SUB-' + s;
  }

  function mb(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return null;
    // El cero exacto va ANTES del redondeo. El Math.max(1, ...) de abajo está para que un
    // archivo de 300 bytes no diga "0 KB", pero aplastaba también el cero de verdad, y ese
    // cero es el dato más importante que produce esta herramienta: "0 bytes enviados"
    // significa que la conexión nunca se estableció, "1 KB" significa que se estableció y
    // murió transmitiendo. Son dos investigaciones distintas.
    if (bytes === 0) return '0 KB';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  }

  // Empieza a seguir una subida. Barato: es un objeto plano, no engancha nada.
  //
  // `opts.progresoMedible = false` para las subidas hechas con fetch, que NO puede informar
  // el progreso de subida. Sin esa distinción el reporte diría "se envió 0 de 3 MB" —o sea,
  // "se cortó apenas arrancó"— para toda subida por fetch, y mandaría a buscar el problema
  // a la red cuando la red anduvo perfecto. Un diagnóstico que miente con seguridad es peor
  // que uno que dice "esto no lo sé".
  function seguir(ruta, file, opts) {
    var medible = !opts || opts.progresoMedible !== false;
    return {
      ruta:     String(ruta || ''),
      nombre:   (file && file.name) || null,
      bytes:    (file && typeof file.size === 'number') ? file.size : null,
      mime:     (file && file.type) || null,
      t0:       Date.now(),
      enviados: medible ? 0 : null,
      medible:  medible,
      // Cuántos envíos se hicieron de este archivo. Arranca en 0 y lo sube `nuevoIntento`
      // antes de cada uno, así que durante el primer envío ya vale 1.
      intentos: 0,
    };
  }

  // Adaptador para las subidas hechas con fetch: devuelve algo con la forma mínima que
  // `fallar()` sabe leer, para no tener dos caminos distintos según cómo se subió.
  // `cuerpo` se pasa aparte porque el body de una Response solo se puede leer una vez, y
  // quien llama normalmente ya lo consumió para sacar el mensaje de error.
  function desdeRespuesta(res, cuerpo) {
    return {
      status:       res ? res.status : 0,
      statusText:   res ? res.statusText : '',
      responseText: cuerpo || '',
      getResponseHeader: function (h) {
        try { return res && res.headers ? res.headers.get(h) : null; } catch (e) { return null; }
      },
    };
  }

  function progreso(seg, e) {
    if (seg && e && e.lengthComputable) seg.enviados = e.loaded;
  }

  // ── Reintento automático ────────────────────────────────────────────────────
  //
  // Producción sirve la escuela detrás de un Tailscale Funnel con cortes intermitentes de
  // 1-2 minutos, peores a primera hora. Está medido: de 1023 subidas que llegaron al
  // servidor, 1003 salieron bien; las que fallaron murieron con CERO bytes enviados en
  // menos de dos segundos, sin llegar nunca a la aplicación. O sea: la subida se rinde en
  // un segundo y el corte dura minutos, así que el docente ve el error al instante y
  // reintenta a mano — una reintentó el mismo PDF seis veces en once minutos.
  //
  // Esto no arregla el Funnel (eso es sacarlo del camino), tapa el agujero mientras tanto.

  // Envío original + 3 reintentos = 4 envíos repartidos en ~50 segundos, que es del orden
  // de lo que dura un corte. Es una constante y no una opción: el test la fija.
  var ESPERAS_MS = [5000, 15000, 30000];

  // ¿El cuerpo lo escribió NUESTRA aplicación? Es LA pregunta del reintento, y es la misma
  // bifurcación que ya organiza el diagnóstico entero (ver `veredicto` en
  // tools/ver-subida.js): ningún intermediario —Funnel, proxy, balanceador— contesta JSON;
  // contestan HTML o texto plano.
  //
  // Mira si parsea como OBJETO, y no si trae un campo `error` puntual, por un caso concreto
  // que se escapaba: el 503 del modo mantenimiento responde `{ maintenance, message, eta }`
  // SIN `error` (server.js), y los tres caminos de subida mandan `Accept: application/json`,
  // así que caen justo ahí. Buscando `error` se reintentaría, y durante una ventana de
  // mantenimiento cada subida golpearía el servidor cuatro veces en cincuenta segundos —
  // exactamente lo contrario de lo que el mantenimiento pide. Preguntando "¿es un objeto
  // JSON?" quedan cubiertas también las formas de error que se agreguen mañana.
  function contestoLaApp(cuerpo) {
    if (!cuerpo) return false;
    try {
      var j = JSON.parse(cuerpo);
      return !!j && typeof j === 'object';
    } catch (e) { return false; }
  }

  // ¿Vale la pena volver a intentar? El ORDEN de las preguntas es el criterio.
  //   { motivo, status, cuerpo } → boolean
  function reintentable(f) {
    f = f || {};
    // Si habló la aplicación, dijo que no a propósito: un 413 por tamaño, un 403 sin
    // acceso, un 400 de validación, un 429 de rate limit (reintentar un límite es la única
    // forma de empeorarlo) o el 503 de mantenimiento. Insistir no cambia ninguna respuesta.
    if (contestoLaApp(f.cuerpo)) return false;
    // La conexión se cayó o tardó demasiado: es exactamente el caso que motivó todo esto.
    if (f.motivo === 'red' || f.motivo === 'timeout') return true;
    // Status 0 = nunca hubo respuesta. Es red disfrazada de HTTP.
    if (!f.status) return true;
    // 5xx sin cuerpo nuestro: contestó un intermediario (502/504 del proxy, el Funnel a
    // medio caer) y eso puede estar sano en cinco segundos.
    //
    // El corte en 500 deja afuera al 4xx a propósito, INCLUIDO el 413 que no es nuestro: un
    // límite de tamaño —el de la aplicación o el de un proxy— es configuración estática, así
    // que los cuatro intentos darían el mismo 413 y serían cincuenta segundos del docente
    // para llegar al mismo lugar. Solo se reintenta lo que puede cambiar solo.
    return f.status >= 500;
  }

  // Cuánto esperar DESPUÉS del intento número `intento` (el primer envío es el 1).
  // null = se acabó la ventana, hay que rendirse.
  function esperaDe(intento) {
    var espera = ESPERAS_MS[intento - 1];
    return typeof espera === 'number' ? espera : null;
  }

  // Prepara `seg` para un envío más.
  //
  // REINICIA `t0` y `enviados` a propósito: si acumularan los cuatro intentos, `ms` daría
  // ~50.000 y el informe del servidor concluiría "decenas de segundos → el archivo ya
  // estaba arriba, mirá el timeout del proxy" (ver `veredicto` en tools/ver-subida.js), que
  // es falso y manda a la capa equivocada. `ms` y `enviados` siguen describiendo el ÚLTIMO
  // intento —su significado no cambia— y lo nuevo que se reporta es `intentos`.
  function nuevoIntento(seg) {
    if (!seg) return;
    seg.intentos = (seg.intentos || 0) + 1;
    seg.t0       = Date.now();
    if (seg.medible) seg.enviados = 0;
  }

  // Espera `ms` avisando cada segundo cuántos faltan, para que la pantalla no parezca
  // colgada. Devuelve una función para cancelar: sin eso, una espera de 30 segundos sigue
  // viva aunque la tarjeta ya no esté.
  function esperar(ms, alTick, alTerminar) {
    var quedan = Math.ceil(ms / 1000);
    var vivo   = true;
    if (alTick) alTick(quedan);
    var id = setInterval(function () {
      quedan--;
      if (!vivo) return;
      if (quedan > 0) { if (alTick) alTick(quedan); return; }
      clearInterval(id);
      vivo = false;
      if (alTerminar) alTerminar();
    }, 1000);
    return function cancelar() {
      vivo = false;
      clearInterval(id);
    };
  }

  // Arma el texto que ve la persona. Se separa de `fallar` porque es lo único de este
  // archivo que hay que releer pensando en quién lo lee: un docente en el medio de una
  // clase, no alguien que va a abrir DevTools.
  function detalleHumano(seg, xhr, motivo, mensajeDelServidor) {
    var total    = seg && seg.bytes;
    var enviados = seg && seg.enviados;
    // Solo se habla de "cuánto se alcanzó a enviar" si de verdad se midió (ver `seguir`).
    var cortado  = seg && seg.medible && total && typeof enviados === 'number' && enviados < total;

    if (motivo === 'red' || motivo === 'timeout') {
      var base = motivo === 'timeout'
        ? 'La subida tardó demasiado y se cortó.'
        : 'La subida se cortó antes de llegar al servidor.';
      if (cortado && enviados === 0) {
        // Se separa del caso de abajo porque "se alcanzaron a enviar 0 KB" se lee como un
        // error de la herramienta, y es justo el caso más informativo de todos.
        base += ' No se alcanzó a enviar nada del archivo (0 de ' + mb(total) + ').';
      } else if (cortado) {
        base += ' Se alcanzaron a enviar ' + mb(enviados) + ' de ' + mb(total) + '.';
      }
      // El texto tiene que reconocer que YA se reintentó solo: decirle "probá de nuevo" a
      // alguien que estuvo casi un minuto esperando cuatro intentos suena a que la pantalla
      // no se enteró de lo que acaba de pasar.
      var reintentos = (seg && seg.intentos > 1)
        ? ' Se reintentó solo ' + (seg.intentos - 1) + (seg.intentos - 1 === 1 ? ' vez' : ' veces') + ' y no hubo caso.'
        : '';
      return base + reintentos +
        ' Suele ser la conexión: esperá un momento y probá otra vez; si se repite, avisá con el código de abajo.';
    }

    // El servidor (o algo en el medio) contestó.
    if (mensajeDelServidor) return mensajeDelServidor;

    // Sin JSON entendible: casi siempre es un INTERMEDIARIO, no la aplicación — la app
    // contesta JSON en todos sus errores de subida. Vale la pena decirlo, porque cambia por
    // completo dónde hay que buscar.
    var st = xhr && xhr.status;
    if (!st) return 'El servidor no devolvió una respuesta que se pueda interpretar.';
    if (st === 413) return 'El archivo fue rechazado por tamaño antes de llegar a la aplicación (error 413).';
    if (st === 502 || st === 503 || st === 504) {
      return 'El servidor no estuvo disponible para recibir el archivo (error ' + st + ').';
    }
    return 'El servidor respondió con un error ' + st + ' sin explicación.';
  }

  function fallar(seg, xhr, motivo) {
    var codigo = nuevoCodigo();
    var mensajeDelServidor = null;
    var cuerpo = null;
    var requestId = null;

    try {
      if (xhr) {
        cuerpo = (xhr.responseText || '').slice(0, 300);
        try {
          var j = JSON.parse(xhr.responseText);
          if (j && typeof j.error === 'string') mensajeDelServidor = j.error;
        } catch (e) { /* no era JSON: es justamente uno de los casos interesantes */ }
        // Lo pone middleware/request-log.js. Es lo que une este reporte con la línea del
        // access log de la MISMA request, cuando la request existió.
        try { requestId = xhr.getResponseHeader('X-Request-Id'); } catch (e) {}
      }
    } catch (e) { /* nunca romper por el diagnóstico */ }

    var detalle = detalleHumano(seg, xhr, motivo, mensajeDelServidor);

    try {
      var payload = {
        codigo:     codigo,
        ruta:       seg && seg.ruta,
        motivo:     motivo,
        status:     xhr ? xhr.status : undefined,
        statusText: xhr ? xhr.statusText : undefined,
        requestId:  requestId || undefined,
        respuesta:  cuerpo || undefined,
        archivo:    { nombre: seg && seg.nombre, bytes: seg && seg.bytes, mime: seg && seg.mime },
        // Se omite si no se pudo medir: el servidor calcula el porcentaje a partir de esto,
        // y mandar 0 haría que el informe afirme "se cortó apenas arrancó".
        enviados:   (seg && seg.medible) ? seg.enviados : undefined,
        ms:         seg && seg.t0 ? (Date.now() - seg.t0) : undefined,
        // Cuántos envíos se hicieron antes de rendirse. Se reporta UNA sola vez, al agotar
        // la ventana: el endpoint tiene rate limit de 30 por hora por persona, así que
        // avisar en cada intento quemaría cuatro slots y le mostraría al usuario un código
        // que no es el del fallo que reportó. Ojo al leerlo: `ms` es del ÚLTIMO intento.
        intentos:   (seg && seg.intentos > 1) ? seg.intentos : undefined,
        // Qué tipo de conexión declara el equipo ('4g', '3g', 'slow-2g'…). No está en todos
        // los navegadores; cuando está, distingue "el wifi del aula" de "el servidor".
        conexion:   (navigator.connection && navigator.connection.effectiveType) || undefined,
        pantalla:   location.pathname,
      };

      // fetch con keepalive: el reporte tiene que salir aunque la persona cierre la pestaña
      // enseguida (que es lo que hace cualquiera cuando algo falla). No se espera la
      // respuesta ni se hace nada con ella: si el aviso tampoco puede salir, el usuario
      // igual tiene el código en pantalla, y que NO aparezca en el log es en sí mismo un
      // dato — significa que el navegador no pudo ni avisar.
      fetch('/diagnostico/subida', {
        method:      'POST',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify(payload),
        keepalive:   true,
        credentials: 'same-origin',
      }).catch(function () {});
    } catch (e) { /* ídem */ }

    return { codigo: codigo, detalle: detalle };
  }

  // Texto listo para el cartel: el detalle + el código, que es lo que hay que pedirle a
  // quien reporta el problema.
  function mensaje(falla) {
    return falla.detalle + '\n\nCódigo del error: ' + falla.codigo +
           '\nSi vuelve a pasar, pasale este código a quien administra la plataforma.';
  }

  var api = {
    seguir: seguir, progreso: progreso, fallar: fallar, mensaje: mensaje,
    desdeRespuesta: desdeRespuesta,
    reintentable: reintentable, esperaDe: esperaDe, nuevoIntento: nuevoIntento,
    esperar: esperar, ESPERAS_MS: ESPERAS_MS,
  };

  if (typeof window !== 'undefined') window.SubidaDiag = api;

  // Bajo `node --test` se require() este mismo archivo (tests/unit/subidaDiagnostico.test.js),
  // igual que public/js/ratelimit-chart.js. Las internas (`mb`, `detalleHumano`) salen SOLO
  // por acá: en el navegador la superficie pública sigue siendo la de arriba.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({}, api, { mb: mb, detalleHumano: detalleHumano });
  }
})();
