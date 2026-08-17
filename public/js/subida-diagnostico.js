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
      if (cortado) {
        base += ' Se alcanzaron a enviar ' + mb(enviados) + ' de ' + mb(total) + '.';
      }
      return base + ' Suele ser la conexión: probá de nuevo, y si se repite avisá con el código de abajo.';
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

  window.SubidaDiag = {
    seguir: seguir, progreso: progreso, fallar: fallar, mensaje: mensaje,
    desdeRespuesta: desdeRespuesta,
  };
})();
