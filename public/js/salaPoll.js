// El cursor del poll de la sala en vivo: qué se le pide al servidor y qué se hace con lo
// que contesta. Ver specs/sala-poll-carrera.spec.md.
//
// QUÉ RESUELVE (reclamo del usuario, 2026-09-07): "escriben, lo que escriben les figura y
// luego se borra". No se borraba nada de la base: se vaciaba la PANTALLA.
//
// La sala pregunta "¿qué hay después del mensaje N?" cada 4 segundos, y había tres lugares
// que disparaban un pedido extra sin cancelar el que ya estaba viajando (al enviar, al
// volver a la pestaña, al borrar o reaccionar). Nada garantizaba que las respuestas se
// procesaran en el orden en que salieron los pedidos: la que llegaba última pisaba a la que
// había llegado primera, aunque fuera más vieja. Con el cursor en 11 y una respuesta
// atrasada que decía "el último es el 10", el navegador leía eso como "la sala se reinició"
// y limpiaba el chat entero.
//
// Vive acá y no adentro del <script> de views/partials/live-room.ejs por el mismo motivo que
// estadoActividad.js y visibilidadActividad.js: adentro del .ejs no se puede probar, y esta
// es justamente una regla que a ojo pareció correcta durante meses. Los tests están en
// tests/unit/salaPoll.test.js y corren la carrera paso a paso, que es lo único que la
// distingue de "andá a saber, será la conexión".
//
// OJO CON EL ALCANCE: acá no se pinta nada ni se sabe qué es un mensaje. Esto decide tres
// cosas —si la respuesta sirve, si hay que repintar todo, y hasta dónde avanza el cursor— y
// se las devuelve al partial, que es el que toca el DOM.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SalaPoll = api;
})(this, function () {

  // Cuánto se espera a que aparezca un mensaje cuyo número ya está reservado (ver hueco()).
  //
  // El servidor numera con un $inc atómico y guarda el documento DESPUÉS: entre las dos
  // operaciones hay un await, y un poll que caiga justo ahí ve el número sin el mensaje.
  // Ese hueco dura milisegundos; 10 segundos son dos pollradas y media de margen.
  //
  // El límite no es una precaución de más: si un `create` llegara a fallar, ese número no va
  // a existir NUNCA, y sin plazo el cursor se quedaría esperándolo para siempre — la sala
  // muda hasta recargar. Un arreglo que puede colgar el chat es peor que el bug que arregla.
  var HUECO_MS = 10000;

  /**
   * Crea el cursor de una sala. `seq` y `sessionId` son los del render inicial.
   *
   * El estado vive acá adentro y no en el partial a propósito: `seq` suelto en el <script>
   * era modificado desde cuatro lugares distintos (el poll, el reinicio, el repintado y el
   * envío), y esa dispersión es la que dejó pasar la carrera.
   */
  function crearCursor(inicial) {
    inicial = inicial || {};

    var seq       = inicial.seq || 0;
    var sessionId = inicial.sessionId || null;

    // Número del último pedido emitido, y el del último que se dio por bueno.
    //
    // ⭐ SON DOS NÚMEROS, Y ESA ES LA CORRECCIÓN DEL 2026-09-08. Con uno solo, "llegó tarde"
    // se medía contra el último pedido EMITIDO, y el poll salía cada 4 segundos pasara lo que
    // pasara: bastaba que el viaje del aula tardara más que el intervalo para que TODA
    // respuesta volviera con `gen` ya cambiado y se tirara. La sala no se degradaba —se
    // CONGELABA—, y el síntoma tenía las dos mitades del mismo reclamo: "entra pero la sala no
    // carga" y "escribe pero no le llega al alumno".
    //
    // Lo que hay que descartar es lo que llega tarde respecto de lo que YA SE PINTÓ, no
    // respecto de lo que ya se PIDIÓ. Una respuesta lenta que todavía no pisó nadie es la
    // mejor información que hay: es la única que llegó.
    var gen         = 0;
    var genAceptado = 0;

    // Desde cuándo estamos esperando un mensaje que falta en el medio de la tanda. `null`
    // cuando no hay ninguno pendiente.
    var huecoDesde = null;

    /**
     * Arma el próximo pedido. `desdeCero` lo usan borrar y reaccionar, que cambian algo que
     * YA está pintado y necesitan la conversación entera de nuevo.
     *
     * El pedido devuelto se le pasa tal cual a recibir(): lleva el `since` con el que salió
     * (que es lo que permite detectar un hueco) y su número de orden.
     *
     * OJO: `desdeCero` NO toca el cursor acá. Se aplica recién al recibir la respuesta. Si se
     * bajara el cursor a 0 al pedir y esa respuesta se perdiera —un 500, la red del aula—, la
     * pantalla quedaría con el cursor en 0 y el chat pintado: el poll siguiente traería los
     * últimos 100 mensajes ya pintados, y el único motivo por el que no se ven duplicados es
     * el Set `vistos` del partial. Depender de eso es dejar armada la próxima trampa.
     */
    function pedir(opciones) {
      opciones = opciones || {};
      gen += 1;
      return {
        gen:       gen,
        since:     opciones.desdeCero ? 0 : seq,
        desdeCero: !!opciones.desdeCero,
        // Marca el pedido que nace de un `repedir`. Ver la salvaguarda en recibir().
        repedido:  !!opciones.repedido,
      };
    }

    /**
     * Decide qué hacer con lo que contestó el servidor.
     *
     * Devuelve { descartar, reinicio, mensajes, repedir }:
     *   descartar → la respuesta llegó tarde: no se toca NADA de la pantalla.
     *   reinicio  → hay que vaciar el chat antes de pintar (otra sesión, o repintado pedido).
     *   mensajes  → los que se pintan ahora. Puede ser menos de lo que vino (ver hueco()).
     *   repedir   → conviene volver a preguntar ya, sin esperar los 4 segundos.
     */
    function recibir(resp, pedido, ahora) {
      resp   = resp   || {};
      pedido = pedido || {};
      ahora  = ahora  || Date.now();

      // ── RN-1. ¿Llegó tarde respecto de algo que YA se pintó? ───────────────
      //
      // Si sí, se tira ENTERA: la respuesta que la pasó salió con el mismo `since` o con uno
      // mayor, así que ya trajo todo lo que traía esta. Se descarta también el estado
      // (presencia, transmisión, puedoEscribir) y no solo los mensajes: son igual de viejos, y
      // pintarlos hacía parpadear la fila de conectados.
      //
      // ⚠️ Acá decía `pedido.gen !== gen`, comparando contra el último pedido EMITIDO. El
      // razonamiento era "el que la dejó atrás trae lo mismo", y es cierto — pero solo si ese
      // llega. Con el viaje más lento que el intervalo no llegaba NINGUNO: cada respuesta
      // encontraba un pedido más nuevo ya emitido y se tiraba, para siempre. Ver el bloque 5
      // de tests/unit/salaPoll.test.js, que lo corre con el reloj.
      if (pedido.gen <= genAceptado) {
        return { descartar: true, reinicio: false, mensajes: [], repedir: false };
      }
      genAceptado = pedido.gen;

      var respSession = resp.sessionId || null;
      var mensajes    = resp.mensajes || [];

      // ── RN-2. ¿Es otra sesión? ─────────────────────────────────────────────
      //
      // El `sessionId` es el ÚNICO indicador de que la sala es otra. Antes también se
      // reiniciaba cuando el `lastSeq` del servidor venía por debajo del cursor, y eso no era
      // una sala nueva: era la respuesta atrasada de la sala de siempre. Ese renglón es el
      // que vaciaba el chat.
      //
      // La tanda que vino con una sesión distinta no sirve —se pidió con el cursor de la
      // sesión anterior, así que es un recorte arbitrario de la nueva—, así que no se pinta
      // ninguno y se vuelve a preguntar en el acto desde 0. Antes se pintaba igual y la
      // conversación quedaba truncada hasta el poll siguiente.
      if (respSession !== sessionId) {
        sessionId  = respSession;
        seq        = 0;
        huecoDesde = null;
        return {
          descartar: false,
          reinicio:  true,
          mensajes:  [],
          // Con la sala cerrada no hay nada que volver a pedir: quedarse en la pantalla
          // vacía es exactamente lo que corresponde mostrar.
          //
          // Y NUNCA se encadena un repedido con otro. Un repedir que puede volver a pedir es
          // un bucle esperando su condición: alcanza con que el servidor conteste sesiones
          // distintas en dos respuestas seguidas para que cada una dispare la siguiente sin
          // pausa. Se vio de verdad al verificar en el navegador el 2026-09-07 —una decena de
          // pedidos en el mismo milisegundo, con la app entrando y saliendo de la ventana de
          // mantenimiento—, y en producción son dos workers atendiendo a treinta personas.
          // Cortado acá, el peor caso vuelve a ser esperar los 4 segundos del intervalo.
          repedir:   respSession !== null && !pedido.repedido,
        };
      }

      // ── RN-3. Hasta dónde avanza el cursor ─────────────────────────────────
      var corte = hastaDonde(mensajes, pedido, ahora);

      if (corte.seq > seq) seq = corte.seq;
      huecoDesde = corte.huecoDesde;

      return {
        descartar: false,
        reinicio:  !!pedido.desdeCero,
        mensajes:  corte.mensajes,
        repedir:   false,
      };
    }

    /**
     * El cursor avanza con los mensajes RECIBIDOS y nunca por encima de un hueco.
     *
     * Lo que se sacó de acá vale tanto como lo que se agregó: el cursor NO se mueve más con
     * el `seq` que anuncia el servidor (`if (s.seq > seq) seq = s.seq`). Ese número es el
     * `lastSeq` de la sesión, que ya está incrementado mientras el mensaje se está guardando:
     * adoptarlo dejaba el cursor del otro lado de un mensaje que todavía no existía, y esa
     * pantalla no lo recibía nunca más.
     *
     * El hueco es la otra mitad del mismo problema. Con `since = 10` y una tanda que arranca
     * en 12, el 11 existe y está por aparecer. Se pinta hasta el 11... es decir, hasta el
     * último consecutivo —acá, nada—, y el 12 se deja para el poll siguiente, que lo va a
     * traer junto al 11 y en orden. Pintarlo ya significaría leer la conversación al revés.
     *
     * Con `since = 0` no se evalúa nada de esto: el servidor manda los últimos 100 mensajes,
     * que no tienen por qué empezar en 1.
     */
    function hastaDonde(mensajes, pedido, ahora) {
      var ordenados = mensajes.slice().sort(function (a, b) { return a.seq - b.seq; });
      var maximo    = ordenados.length ? ordenados[ordenados.length - 1].seq : seq;

      if (!pedido.since) {
        return { seq: maximo, mensajes: ordenados, huecoDesde: null };
      }

      // Hasta dónde llega la corrida consecutiva que arranca en `since + 1`.
      var consecutivo = pedido.since;
      for (var i = 0; i < ordenados.length; i++) {
        if (ordenados[i].seq !== consecutivo + 1) break;
        consecutivo = ordenados[i].seq;
      }

      if (consecutivo >= maximo) {
        return { seq: maximo, mensajes: ordenados, huecoDesde: null };
      }

      // Hay un hueco. Se espera —pero con plazo: pasado HUECO_MS el número que falta se da
      // por perdido y la conversación sigue. Ver el comentario de la constante.
      var desde = huecoDesde || ahora;
      if (ahora - desde >= HUECO_MS) {
        return { seq: maximo, mensajes: ordenados, huecoDesde: null };
      }

      return {
        seq: consecutivo,
        mensajes: ordenados.filter(function (m) { return m.seq <= consecutivo; }),
        huecoDesde: desde,
      };
    }

    return {
      pedir:   pedir,
      recibir: recibir,
      // Solo de lectura, para el latido de quien gestiona la sala: manda el mismo GET y tira
      // la respuesta, así que NO puede pasar por pedir(). Si numerara un pedido, invalidaría
      // el poll de verdad que estuviera en vuelo y la sala se congelaría cada 20 segundos.
      get seq()       { return seq; },
      get sessionId() { return sessionId; },
    };
  }


  /**
   * El ritmo del ciclo: cada cuánto conviene volver a preguntar. RN-4 de
   * specs/sala-en-vivo-escala.spec.md.
   *
   * QUÉ RESUELVE: una clase de 40 minutos tiene mensajes en ráfagas y silencio en el medio, y
   * hasta acá se preguntaba cada 4 segundos igual, pasara algo o no. Durante el silencio eso es
   * la mitad de los requests tirada — con sus 4 queries y su escritura de presencia cada uno.
   *
   * Vive acá y no adentro del <script> del partial por el mismo motivo que el cursor: una regla
   * de dos estados con un contador es exactamente lo que "a ojo parece obvio" y después resulta
   * que se queda pegada en lento, o que nunca afloja. Los tests están en
   * tests/unit/salaPoll.test.js.
   *
   * @param rapido   ms entre vueltas mientras pasa algo
   * @param lento    ms entre vueltas con la sala en silencio
   * @param vueltas  cuántas vueltas seguidas sin novedades hacen falta para aflojar
   */
  function crearRitmo(opciones) {
    opciones = opciones || {};
    var rapido  = opciones.rapido;
    var lento   = opciones.lento;
    var vueltas = opciones.vueltas;

    var sinNovedad = 0;

    return {
      /**
       * Se llama con el resultado de cada vuelta. `hubo` es true si la pantalla cambió.
       * Devuelve los ms que hay que esperar hasta la próxima.
       *
       * El reseteo es a CERO y de golpe, no un decremento: cuando la conversación arranca, la
       * sala tiene que estar rápida en la vuelta siguiente y no ir bajando de a poco.
       */
      registrar: function (hubo) {
        sinNovedad = hubo ? 0 : sinNovedad + 1;
        return this.ms();
      },

      /** Los ms que corresponden al estado actual, sin registrar nada. */
      ms: function () {
        return sinNovedad >= vueltas ? lento : rapido;
      },

      /**
       * Vuelve al ritmo rápido sin esperar una vuelta. Lo usa el regreso a la pestaña: alguien
       * que vuelve a mirar la sala quiere verla al día ya, no dentro de dos vueltas lentas.
       */
      despertar: function () { sinNovedad = 0; },

      get vueltasSinNovedad() { return sinNovedad; },
    };
  }

  return {
    crearCursor: crearCursor,
    crearRitmo: crearRitmo,
    HUECO_MS: HUECO_MS,
  };
});
