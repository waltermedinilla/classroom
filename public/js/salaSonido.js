// El sonido de aviso del chat de la sala en vivo: cuándo suena, qué eligió cada persona en su
// navegador, y el aviso en sí. Ver specs/sonido-chat-sala.spec.md.
//
// QUÉ RESUELVE (pedido del usuario, 2026-09-22): quien tiene la clase abierta pero la mirada en
// otro lado —el cuaderno, la pizarra, otra ventana— no se entera de que alguien escribió. Suena
// SOLO adentro de la página: sin push, sin mail, sin avisos del navegador (la sala sigue sin
// notificar hacia afuera, ver la nota del principio de la spec).
//
// Vive acá y no adentro del <script> de views/partials/live-room.ejs por el mismo motivo que el
// cursor de public/js/salaPoll.js: adentro del .ejs no se puede probar, y una regla de cinco
// condiciones con una marca y un tiempo mínimo es exactamente lo que "a ojo parece correcto".
// Los tests están en tests/unit/salaSonido.test.js.
//
// Lo carga también el SERVIDOR (los dos modelos, services/liveRoom.js y routes/rooms.js) por
// la lista de categorías: así el `enum` de Mongoose, la validación de /config y la lectura del
// navegador no pueden divergir.
//
// OJO CON EL ALCANCE: la parte de decisión no toca el DOM, el reloj ni la red —recibe todo por
// parámetro—. El reproductor, al final, es lo único que solo anda en el navegador.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SalaSonido = api;
})(this, function () {

  // ── La política del docente ────────────────────────────────────────────────

  // Qué mensajes suenan. 'docente' = autor con rol de personal (ROLES_PERSONAL).
  var SONIDO_DE         = ['todos', 'docente'];
  // La categoría que queda elegida la primera vez que alguien prende el sonido (D10): menos
  // ruido para treinta alumnos, y quien gestiona escucha a todos igual (RN-12).
  var SONIDO_DE_DEFAULT = 'docente';

  // ⚠️ COPIA de STAFF_ROLES (services/liveRoom.js), con un test guarda que falla si divergen. No
  // se importa porque este archivo corre en el navegador, que no tiene al servidor a mano. Es el
  // mismo criterio de "personal" que usa la presencia de la sala.
  var ROLES_PERSONAL = ['teacher', 'admin', 'superadmin', 'directivo', 'preceptor', 'jefe', 'soe'];

  // ── La decisión de cada persona, en su navegador ──────────────────────────

  var PREFERENCIAS        = ['siempre', 'si_no_miro', 'silencio'];
  // 'siempre' y no 'silencio': es el valor que deja actuar a la decisión del docente. Con
  // silencio por defecto, prender el sonido no le haría nada a nadie hasta que cada alumno
  // entrara a un menú (D10).
  var PREFERENCIA_DEFAULT = 'siempre';
  // UNA sola clave, sin id de curso: la elección vale para todas las salas de esa persona.
  var CLAVE_LOCAL         = 'salaSonido';

  // ── El tiempo mínimo entre dos avisos (D9) ───────────────────────────────

  // POLL_MS × 3 (services/liveRoom.js). Con la sala activa el poll corre cada 4 s, y sin un
  // mínimo un chat animado sonaría cada 4 s toda la clase — que es lo que lleva a silenciarlo
  // para siempre. Va como número porque el navegador no tiene POLL_MS a mano; el test guarda
  // obliga a mirar esto el día que alguien toque la cadencia del poll.
  var ENFRIAMIENTO_MS = 12000;

  // ── El aviso ──────────────────────────────────────────────────────────────

  // Límites fijos con test (RN-25): corto, y a volumen moderado — el volumen real lo pone el
  // sistema. Son dos tonos que se pisan un poco; el segundo termina justo en DURACION_MS.
  var DURACION_MS  = 260;
  var GANANCIA_MAX = 0.15;
  var ATAQUE_S     = 0.01;

  /**
   * La política de la sesión, leída de `settings`. Es la ÚNICA lectura de `sonido`, en el
   * servidor y en el navegador (RN-03).
   *
   * ⚠️ `=== true`, AL REVÉS que los tres interruptores vecinos, que se leen con `!== false`.
   * Allá la ausencia del campo tiene que querer decir PERMITIDO; acá tiene que querer decir
   * APAGADO: una sesión abierta antes del despliegue no tiene el campo, y leerla como sus
   * vecinos prendería el sonido en todas las salas abiertas el día del deploy.
   */
  function politica(settings) {
    var s = settings || {};
    return {
      activo: s.sonido === true,
      de:     SONIDO_DE.indexOf(s.sonidoDe) >= 0 ? s.sonidoDe : SONIDO_DE_DEFAULT,
    };
  }

  /** La preferencia local ya validada: cualquier cosa rara vale lo mismo que no haber elegido. */
  function preferencia(valorCrudo) {
    return PREFERENCIAS.indexOf(valorCrudo) >= 0 ? valorCrudo : PREFERENCIA_DEFAULT;
  }

  function mayorSeq(mensajes) {
    var max = null;
    for (var i = 0; i < mensajes.length; i++) {
      if (max === null || mensajes[i].seq > max) max = mensajes[i].seq;
    }
    return max;
  }

  /**
   * El estado de sonido de una pantalla recién cargada. La marca arranca en el mayor `seq` de
   * lo que vino pintado del servidor: lo que ya está en pantalla no es novedad (mismo principio
   * que anotarActividades() en el partial). Sin mensajes, `null`: la primera tanda que llegue
   * es historial.
   */
  function crearEstado(sessionId, mensajes) {
    return {
      sessionId:    sessionId == null ? null : sessionId,
      marca:        mayorSeq(mensajes || []),
      ultimoSonido: null,
    };
  }

  /**
   * ¿Esta tanda suena? Devuelve `{ sonar, estado }` con un estado NUEVO: el que recibe no se
   * toca. El orden de los pasos es el del algoritmo de la spec (§ Entidades), y cada uno cita
   * la regla que lo explica.
   *
   * `e` = { origen, sessionId, mensajes, politica, preferencia, mirando, esGestor, ahora }
   */
  function evaluar(estado, e) {
    // 1. El latido nunca decide que la sesión cambió (RN-22): eso es del poll, que es el que
    //    mueve el cursor. Se devuelve el MISMO estado, sin copiar.
    if (e.origen === 'latido' && e.sessionId !== estado.sessionId) {
      return { sonar: false, estado: estado };
    }

    var s = { sessionId: estado.sessionId, marca: estado.marca, ultimoSonido: estado.ultimoSonido };

    // 2. Otra sesión, o la sala cerrada: se olvida la marca (RN-14). `ultimoSonido` NO se toca:
    //    cerrar y reabrir la sala no resetea el tiempo mínimo.
    if (e.sessionId !== s.sessionId) {
      s.sessionId = e.sessionId;
      s.marca     = null;
    }

    var mensajes = e.mensajes || [];
    var maxSeq   = mayorSeq(mensajes);

    // 3. Sin marca, la tanda es historial: la fija y no suena (RN-14).
    if (s.marca === null) {
      s.marca = maxSeq;
      return { sonar: false, estado: s };
    }

    // 4. Candidatos (RN-10, RN-11). Las imágenes y los archivos cuentan como cualquier mensaje;
    //    el aviso de sistema "creó la actividad" no, aunque lleve botón (D10).
    var marca = s.marca;
    var candidatos = mensajes.filter(function (m) {
      return m.seq > marca && m.kind !== 'system' && m.esMio === false && m.borrado === false;
    });

    // 5. La categoría rige para la clase, NO para quien gestiona (RN-12, D8). Si filtrara
    //    también a la docente, con 'docente' no escucharía a nadie: sus mensajes no suenan por
    //    propios y los de los alumnos quedarían afuera.
    var pol = e.politica || {};
    if (pol.de === 'docente' && e.esGestor === false) {
      candidatos = candidatos.filter(function (m) { return ROLES_PERSONAL.indexOf(m.rol) >= 0; });
    }

    // 6. La marca avanza SIEMPRE, suene o no (RN-18): prender el sonido a mitad de clase no
    //    puede hacer sonar lo que ya pasó. Y por esto mismo, lo que cae dentro del tiempo
    //    mínimo no queda guardado para después.
    if (maxSeq !== null) s.marca = Math.max(s.marca, maxSeq);

    // 7. La regla final (RN-23, D6, D9).
    var sonar = candidatos.length > 0
      && pol.activo === true
      && e.preferencia !== 'silencio'
      && (e.preferencia === 'siempre' || e.mirando === false)
      && (s.ultimoSonido === null || e.ahora - s.ultimoSonido >= ENFRIAMIENTO_MS);

    // Desde la DECISIÓN, no desde el parlante: si el audio está bloqueado tampoco suena, y el
    // tiempo mínimo corre igual (RN-23).
    if (sonar) s.ultimoSonido = e.ahora;
    return { sonar: sonar, estado: s };
  }

  // ── La preferencia local (RN-19) ─────────────────────────────────────────
  //
  // Las dos envuelven TODO en try/catch, incluido el acceso a `storage`: Safari en modo privado
  // y algunas netbooks con el almacenamiento bloqueado tiran al escribir, y hay navegadores que
  // tiran ya al tocar `window.localStorage`. Quien llama se queda con el valor en memoria
  // mientras dure la página.

  function leerPreferencia(storage) {
    try { return preferencia(storage.getItem(CLAVE_LOCAL)); }
    catch (e) { return PREFERENCIA_DEFAULT; }
  }

  // Un valor fuera de la lista no se escribe: pisar un 'silencio' guardado con el default le
  // devolvería el sonido a alguien que lo apagó, sin que lo haya pedido.
  function guardarPreferencia(storage, valor) {
    if (PREFERENCIAS.indexOf(valor) < 0) return false;
    try { storage.setItem(CLAVE_LOCAL, valor); return true; }
    catch (e) { return false; }
  }

  // ── El reproductor ───────────────────────────────────────────────────────
  //
  // WebAudio generado y NO un archivo (RN-25): cero bytes de red, cero pedidos (ni el primero),
  // nada que sumar a public/, al backup ni a la lista de estáticos cacheados.

  /** ¿Este navegador tiene WebAudio? `webkitAudioContext` es el de Safari viejo. */
  function soportaAudio(win) {
    return !!(win && (win.AudioContext || win.webkitAudioContext));
  }

  // Uno solo por página. Solo navegador: nada de acá abajo corre con node.
  var contexto = null;
  var alCambiar = null;

  /**
   * Crea el AudioContext si todavía no existe. Se llama recién cuando hace falta sonido
   * (política prendida y preferencia distinta de silencio, RN-26): con el sonido apagado, que
   * es como arrancan todas las salas, la página no crea ninguno.
   *
   * Si la página ya tuvo un gesto (en la materia, el clic en "En vivo"), Chrome y Firefox lo
   * dejan arrancar solo. Si no, nace suspendido y hace falta desbloquear().
   *
   * `cambio` se llama cada vez que el contexto cambia de estado. Hace falta porque el arranque
   * solo es ASÍNCRONO: sin esto, la campana seguiría diciendo "Activar sonido" hasta la próxima
   * vuelta del poll aunque el audio ya ande.
   */
  function prepararAudio(cambio) {
    if (cambio) alCambiar = cambio;
    if (contexto) return contexto;
    var w = typeof window !== 'undefined' ? window : null;
    var Clase = w && (w.AudioContext || w.webkitAudioContext);
    if (!Clase) return null;
    try {
      contexto = new Clase();
      contexto.onstatechange = function () {
        try { if (alCambiar) alCambiar(); } catch (e) { /* pintar la campana no puede romper el audio */ }
      };
    } catch (e) {
      contexto = null;
    }
    return contexto;
  }

  /** ¿Puede sonar ya, sin esperar a nadie? */
  function audioListo() {
    return !!contexto && contexto.state === 'running';
  }

  /**
   * Crea o reanuda el contexto. Tiene que llamarse ADENTRO del manejador de un gesto: Safari
   * no acepta un resume() que llega después. La promesa nunca rechaza y dice si quedó andando.
   * `cambio`, igual que en prepararAudio().
   */
  function desbloquear(cambio) {
    try {
      var c = prepararAudio(cambio);
      if (!c) return Promise.resolve(false);
      if (c.state === 'running') return Promise.resolve(true);
      return Promise.resolve(c.resume()).then(audioListo, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  // Un tono senoidal con ataque corto y caída exponencial. La rampa exponencial no puede
  // arrancar ni terminar en 0, y por eso 0.0001, que ya es silencio.
  function tono(c, frecuencia, desde, dura) {
    var osc = c.createOscillator();
    var vol = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frecuencia, desde);
    vol.gain.setValueAtTime(0.0001, desde);
    vol.gain.exponentialRampToValueAtTime(GANANCIA_MAX, desde + ATAQUE_S);
    vol.gain.exponentialRampToValueAtTime(0.0001, desde + dura);
    osc.connect(vol);
    vol.connect(c.destination);
    osc.start(desde);
    osc.stop(desde + dura);
  }

  /**
   * Toca el aviso UNA vez. Con el contexto sin desbloquear no toca nada y no lo guarda para
   * después (RN-26): un aviso que llega tarde avisa de algo que ya pasó.
   *
   * Nunca tira (RN-28): el que llama es el poll, que es lo que mantiene viva la sala, y un
   * error de audio no puede cortarlo.
   */
  function reproducir() {
    try {
      if (!audioListo()) return false;
      var t = contexto.currentTime;
      tono(contexto, 880,  t,        0.14);
      tono(contexto, 1175, t + 0.09, DURACION_MS / 1000 - 0.09);
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    // constantes
    SONIDO_DE: SONIDO_DE,
    SONIDO_DE_DEFAULT: SONIDO_DE_DEFAULT,
    PREFERENCIAS: PREFERENCIAS,
    PREFERENCIA_DEFAULT: PREFERENCIA_DEFAULT,
    CLAVE_LOCAL: CLAVE_LOCAL,
    ROLES_PERSONAL: ROLES_PERSONAL,
    ENFRIAMIENTO_MS: ENFRIAMIENTO_MS,
    DURACION_MS: DURACION_MS,
    GANANCIA_MAX: GANANCIA_MAX,
    // puras
    politica: politica,
    preferencia: preferencia,
    crearEstado: crearEstado,
    evaluar: evaluar,
    leerPreferencia: leerPreferencia,
    guardarPreferencia: guardarPreferencia,
    soportaAudio: soportaAudio,
    // solo navegador
    prepararAudio: prepararAudio,
    audioListo: audioListo,
    desbloquear: desbloquear,
    reproducir: reproducir,
  };
});
