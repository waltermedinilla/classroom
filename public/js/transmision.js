/* Cliente de la transmisión en vivo y de "Hablar". Ver specs/transmision-en-vivo.spec.md y
 * specs/sala-hablar.spec.md.
 *
 * Convive con el chat de views/partials/live-room.ejs SIN tocarlo: el chat sigue en su poll de
 * 4 segundos y por acá pasa solamente lo que no puede esperar cuatro segundos —SDP, candidatos
 * ICE, "empecé a transmitir", quién está hablando— (D3). Todo lo demás (manos levantadas, quién
 * tiene la palabra, si la voz está abierta a los alumnos) viaja por el poll y lo pinta el partial.
 *
 * Depende de public/js/mediasoup-client.bundle.js, que expone `window.mediasoupClient`.
 * ⚠️ Ese bundle está COMMITEADO a propósito: el proyecto no tiene paso de build y el deploy
 * solo hace git pull + npm install + pm2 reload. Si algún día se actualiza mediasoup-client,
 * hay que correr `npm run build:mediasoup` y commitear el resultado.
 *
 * ⭐ El bundle NO se carga con la página (H6 de sala-hablar): son 231 KB que bajaría cada alumno
 * al abrir la sala aunque nunca toque nada. Se inyecta recién al tocar "Escuchar", "Ver la
 * clase", "Hablar" o "Transmitir".
 */
(function () {
  'use strict';

  // Estado de ESTA pestaña. Nada de esto es la verdad —la verdad está en el servidor y llega
  // por el poll—, es solo lo necesario para sostener las conexiones.
  const S = {
    ws: null, device: null,
    txEnvio: null, txRecibo: null,
    productores: new Map(),   // 'micro'|'pantalla'|'camara' → producer
    consumidores: new Map(),  // producerId → consumer
    pistas: new Map(),        // producerId → MediaStreamTrack
    audios: new Map(),        // producerId → <audio> (uno por voz, ver montarPista)
    conectando: null,        // la promesa de la conexión en curso
    bienvenida: null,
    reintentos: 0,
    capa: '360p',
    mirando: false,
    emitiendo: false,

    // Hablar: la voz del alumno (pulsar para hablar).
    permiso: false,           // lo que dice el último ticket: true | 'audio' | false
    voz: null,                // el productor de la voz del alumno (nace pausado)
    vozPista: null,           // su MediaStreamTrack, para apagar la lucecita del micrófono
    preparando: null,         // la promesa de prepararVoz() en curso
    dedoAbajo: false,         // el botón está apretado AHORA
    hablando: false,          // el servidor dijo hablarOk y todavía no soltó
    relojVoz: null,
    voces: new Map(),         // uid → nombre, de quienes están hablando (evento 'hablando')
  };

  // Ninguna pulsación dura más que esto. Es el MISMO número que MAX_PULSACION_MS de
  // config/transmision.js, y el proceso de medios lo impone igual: esto es para que el botón se
  // suelte solo en la pantalla del chico en vez de quedar diciendo "hablando" (H3).
  const MAX_PULSACION_MS = 60 * 1000;

  // Opus afinado para VOZ (H5 de sala-hablar). Vale para el micrófono del docente y para la voz
  // del alumno: mono, 24 kbps, con DTX (el silencio casi no cuesta) y FEC (tolera pérdidas del
  // celular sin reenviar).
  //
  // ⭐ `opusPtime: 60` es el ajuste que más ahorra y no se ve: con paquetes de 20 ms las
  // cabeceras pesaban MÁS que la voz. Medido con getStats(): de ~51 a ~33 kbps por voz. Mismos
  // números que VOZ_PTIME en config/transmision.js.
  const OPUS_VOZ = {
    opusStereo: false,
    opusDtx: true,
    opusFec: true,
    opusMaxAverageBitrate: 24000,
    opusPtime: 60,
  };

  const BASE = window.LR_BASE || '';
  const $ = (id) => document.getElementById(id);

  // ── Utilidades ─────────────────────────────────────────────────────────────

  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });

  function aviso(texto, tipo) {
    const el = $('txAviso');
    if (!el) return;
    el.textContent = texto || '';
    el.style.display = texto ? '' : 'none';
    el.className = 'tx-aviso' + (tipo ? ' tx-' + tipo : '');
  }

  // El bundle de mediasoup-client, bajo demanda y una sola vez.
  let cargandoBundle = null;
  function cargarMediasoup() {
    if (window.mediasoupClient) return Promise.resolve();
    if (cargandoBundle) return cargandoBundle;
    cargandoBundle = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/mediasoup-client.bundle.js';
      s.onload = () => resolve();
      s.onerror = () => { cargandoBundle = null; reject(new Error('no se pudo cargar el audio')); };
      document.head.appendChild(s);
    });
    return cargandoBundle;
  }

  async function pedirTicket() {
    // El ticket lo firma Express, no el proceso de medios (D4). Dura 60 segundos: alcanza de
    // sobra para abrir el WebSocket, y es lo que hace que revocar el acceso surta efecto rápido.
    const r = await post(BASE + '/transmision/ticket');
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || 'no se pudo entrar a la transmisión');
    }
    return r.json();
  }

  // ── Señalización ───────────────────────────────────────────────────────────

  // Cada mensaje que espera respuesta se resuelve por TIPO. El protocolo es chico y cada
  // pedido tiene una respuesta distinta, así que no hace falta un id de correlación.
  const enEspera = new Map();

  function pedir(tipo, datos, respuesta) {
    return new Promise((resolve, reject) => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return reject(new Error('sin conexión'));
      const reloj = setTimeout(() => { enEspera.delete(respuesta); reject(new Error('timeout')); }, 15000);
      enEspera.set(respuesta, (m) => { clearTimeout(reloj); resolve(m); });
      S.ws.send(JSON.stringify({ t: tipo, ...datos }));
    });
  }

  const mandar = (m) => { if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(m)); };

  // Una sola conexión por pestaña. Dos llamados casi juntos (tocar "Escuchar" y apretar para
  // hablar enseguida) comparten la MISMA conexión en curso en vez de abrir dos WebSockets.
  function conectar() {
    if (S.ws && S.ws.readyState === WebSocket.OPEN && S.bienvenida) return Promise.resolve(S.bienvenida);
    if (S.conectando) return S.conectando;
    S.conectando = abrirConexion().finally(() => { S.conectando = null; });
    return S.conectando;
  }

  async function abrirConexion() {
    await cargarMediasoup();
    const { ticket } = await pedirTicket();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    S.ws = new WebSocket(`${proto}//${location.host}/rtc`);

    await new Promise((resolve, reject) => {
      S.ws.onopen = resolve;
      S.ws.onerror = () => reject(new Error('no se pudo abrir la conexión de audio'));
    });

    S.ws.onmessage = (ev) => manejar(JSON.parse(ev.data));
    S.ws.onclose = () => alCerrarse();

    const bienvenida = await pedir('hola', { ticket }, 'bienvenido');
    S.capa = bienvenida.capa || '360p';
    S.permiso = bienvenida.emitir;

    S.device = new window.mediasoupClient.Device();
    await S.device.load({ routerRtpCapabilities: bienvenida.rtpCapabilities });

    S.reintentos = 0;
    S.bienvenida = bienvenida;
    return bienvenida;
  }

  function manejar(m) {
    // Primero, quien esté esperando esta respuesta.
    const esperando = enEspera.get(m.t);
    if (esperando) { enEspera.delete(m.t); return esperando(m); }

    if (m.t === 'productorNuevo') return consumir(m.id).catch(() => {});
    if (m.t === 'productorSeFue') return sacarPista(m.id);

    if (m.t === 'capaCambiada') {
      S.capa = m.capa;
      // El mensaje viene armado del servidor: es el único que sabe cuánta gente hay mirando en
      // TODA la escuela, que es el dato que explica la degradación.
      if (m.mensaje) aviso(m.mensaje, 'atencion');
      return undefined;
    }

    // ── Hablar ──
    if (m.t === 'hablando') {
      if (m.on) S.voces.set(String(m.uid), m.nom || '—');
      else S.voces.delete(String(m.uid));
      return avisarVoces();
    }
    if (m.t === 'hablarOk') return alPoderHablar();
    if (m.t === 'lleno') {
      S.dedoAbajo = false;
      aviso(m.mensaje || 'Esperá un momento: ya están hablando dos compañeros.', 'atencion');
      return pintar();
    }
    if (m.t === 'callado') return undefined;
    if (m.t === 'teCallaron') {
      cortarLocal();
      if (m.motivo === 'tiempo') aviso('Se cortó tu micrófono: se puede hablar hasta un minuto seguido.', 'atencion');
      if (m.motivo === 'silenciado') aviso('Tu profe te silenció en esta clase.', 'atencion');
      return pintar();
    }
    if (m.t === 'modoVoz' && m.abierta === false) {
      soltarMicrofono();
      S.permiso = false;
      return pintar();
    }

    if (m.t === 'error') {
      // Un ticket vencido no es un error para el usuario: se pide otro y se sigue.
      if (m.recuperable) return reconectar();
      aviso(m.error, 'error');
    }
    return undefined;
  }

  function alCerrarse() {
    S.ws = null;
    S.bienvenida = null;
    // Quien habla deja de hablar: el servidor ya se enteró al caerse la conexión.
    cortarLocal();
    soltarMicrofono();
    S.voces.clear(); avisarVoces();
    if (!S.mirando && !S.emitiendo) return;

    // Reconexión con espera creciente. El tope de 5 intentos no es un capricho: si a los ~30
    // segundos no volvió, lo honesto es decirlo y dejar de consumir batería y datos.
    if (S.reintentos >= 5) {
      aviso('Se cortó el audio. Podés seguir la clase por el chat.', 'error');
      S.mirando = S.emitiendo = false;
      return pintar();
    }
    S.reintentos++;
    setTimeout(() => reconectar(), Math.min(1000 * 2 ** S.reintentos, 10000));
    return undefined;
  }

  async function reconectar() {
    try {
      limpiar(false);
      if (S.emitiendo) await empezarAEmitir(S.modoPedido || {});
      else if (S.mirando) await empezarAMirar();
    } catch (e) { /* alCerrarse ya programa el próximo intento */ }
  }

  // ── Transportes ────────────────────────────────────────────────────────────

  async function transporteDeEnvio() {
    if (S.txEnvio) return S.txEnvio;
    const { parametros } = await pedir('crearTransporte', { proposito: 'enviar' }, 'transporte');
    const t = S.device.createSendTransport(parametros);

    t.on('connect', ({ dtlsParameters }, ok, mal) => {
      pedir('conectarTransporte', { transportId: t.id, dtlsParameters }, 'transporteListo')
        .then(ok).catch(mal);
    });
    t.on('produce', ({ kind, rtpParameters, appData }, ok, mal) => {
      pedir('producir', { transportId: t.id, kind, rtpParameters, fuente: appData.fuente }, 'produciendo')
        .then((m) => ok({ id: m.id })).catch(mal);
    });

    S.txEnvio = t;
    return t;
  }

  async function transporteDeRecibo() {
    if (S.txRecibo) return S.txRecibo;
    const { parametros } = await pedir('crearTransporte', { proposito: 'recibir' }, 'transporte');
    const t = S.device.createRecvTransport(parametros);
    t.on('connect', ({ dtlsParameters }, ok, mal) => {
      pedir('conectarTransporte', { transportId: t.id, dtlsParameters }, 'transporteListo')
        .then(ok).catch(mal);
    });
    S.txRecibo = t;
    return t;
  }

  // ── Emitir (docente) ───────────────────────────────────────────────────────

  async function empezarAEmitir(modo) {
    S.modoPedido = modo;
    const bienvenida = await conectar();
    if (bienvenida.emitir !== true) throw new Error('Tu escuela todavía no te habilitó para transmitir');

    await transporteDeEnvio();
    S.emitiendo = true;

    if (modo.micro !== false) await publicarMicrofono();
    if (modo.pantalla)        await publicarPantalla();
    if (modo.camara)          await publicarCamara();

    // Con "Todos pueden hablar" el docente tiene que ESCUCHAR a los alumnos: se consumen las
    // voces que ya estén en la sala; las que lleguen después vienen por 'productorNuevo'.
    for (const p of bienvenida.productores || []) {
      if (p.kind === 'audio') await consumir(p.id).catch(() => {});
    }

    pintar();
  }

  async function publicarMicrofono() {
    if (S.productores.has('micro')) return;
    // La cancelación de eco y de ruido las hace el navegador y son gratis: en un aula con el
    // parlante abierto, sin `echoCancellation` la clase se llena de acople.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const t = await S.txEnvio.produce({
      track: stream.getAudioTracks()[0],
      codecOptions: OPUS_VOZ,
      appData: { fuente: 'micro' },
    });
    S.productores.set('micro', t);
  }

  async function publicarPantalla() {
    if (S.productores.has('pantalla')) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 15 } },
      audio: true,   // el audio de la pestaña, para mostrar un video (solo Chrome y Edge)
    });
    const video = stream.getVideoTracks()[0];

    // Si el docente corta desde el botón del navegador ("Dejar de compartir"), hay que
    // enterarse: si no, la app sigue diciendo que comparte pantalla y muestra un cuadro negro.
    video.addEventListener('ended', () => despublicar('pantalla'));

    const t = await S.txEnvio.produce({
      track: video,
      // Una pantalla con texto quieto no necesita tres capas: no hay movimiento que degradar.
      // Una sola capa a 400 kbps es mejor imagen que tres mal repartidas.
      encodings: [{ maxBitrate: 400000 }],
      codecOptions: { videoGoogleStartBitrate: 300 },
      appData: { fuente: 'pantalla' },
    });
    S.productores.set('pantalla', t);

    const audio = stream.getAudioTracks()[0];
    if (audio) {
      const a = await S.txEnvio.produce({ track: audio, appData: { fuente: 'pantalla-audio' } });
      S.productores.set('pantalla-audio', a);
    }
  }

  async function publicarCamara() {
    if (S.productores.has('camara')) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
    });
    const t = await S.txEnvio.produce({
      track: stream.getVideoTracks()[0],
      // Simulcast de DOS capas y no de tres: 720p está prohibido (config/transmision.js), así
      // que la tercera no tendría a quién servirle. Publicar una capa que nadie consume es
      // subida del docente tirada a la basura, y la subida es el recurso escaso en Argentina.
      encodings: [
        { rid: 'baja',  maxBitrate: 125000, scaleResolutionDownBy: 2 },
        { rid: 'media', maxBitrate: 400000, scaleResolutionDownBy: 1 },
      ],
      codecOptions: { videoGoogleStartBitrate: 300 },
      appData: { fuente: 'camara' },
    });
    S.productores.set('camara', t);
  }

  function despublicar(cual) {
    const p = S.productores.get(cual);
    if (!p) return;
    try { p.track?.stop(); } catch (e) { /* ya estaba parado */ }
    try { p.close(); } catch (e) { /* ya estaba cerrado */ }
    S.productores.delete(cual);
    post(BASE + '/transmision/modo', { [cual]: false }).catch(() => {});
    pintar();
  }

  // ── Mirar / escuchar (alumno) ──────────────────────────────────────────────

  async function empezarAMirar() {
    const bienvenida = await conectar();
    await transporteDeRecibo();
    S.mirando = true;

    // Los que YA están al aire: es lo que permite que alguien que entra a los veinte minutos
    // vea la clase sin esperar a que el docente vuelva a publicar nada.
    for (const p of bienvenida.productores || []) await consumir(p.id).catch(() => {});
    pintar();
  }

  async function consumir(producerId) {
    // El docente también consume (las voces de los alumnos con "Todos pueden hablar").
    if ((!S.mirando && !S.emitiendo) || S.consumidores.has(producerId)) return;
    if (S.voz && S.voz.id === producerId) return;   // la voz propia no se escucha de vuelta
    const t = await transporteDeRecibo();

    const { parametros } = await pedir('consumir', {
      transportId: t.id, producerId, rtpCapabilities: S.device.rtpCapabilities,
    }, 'consumiendo');

    // Quien emite solo escucha VOCES: no tiene dónde ni para qué pintar un video.
    if (!S.mirando && parametros.kind !== 'audio') return;

    const c = await t.consume(parametros);
    S.consumidores.set(producerId, c);
    S.pistas.set(producerId, c.track);

    // El consumidor nace pausado del lado del servidor y se reanuda recién ahora, con el
    // <video> ya preparado. Al revés, los primeros paquetes llegan antes de que haya dónde
    // pintarlos y el video tarda segundos en aparecer, o aparece negro.
    await pedir('reanudar', { consumerId: c.id }, 'reanudado');
    montarPista(producerId, c);
  }

  function montarPista(producerId, c) {
    // ⭐ Cada voz en su PROPIO <audio>. Un solo <audio> con varias pistas en su MediaStream no
    // las mezcla en todos los navegadores: con el docente y dos alumnos hablando, se escucharía
    // uno solo. Separado, además, la voz sigue aunque el docente apague la cámara.
    if (c.kind === 'audio') {
      const caja = $('txAudios');
      if (!caja) return;
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = new MediaStream([c.track]);
      caja.appendChild(el);
      S.audios.set(producerId, el);
      el.play().catch(() => aviso('Tocá la pantalla para que empiece a sonar.', 'atencion'));
      return;
    }

    const destino = $('txVideo');
    if (!destino) return;
    const stream = destino.srcObject instanceof MediaStream ? destino.srcObject : new MediaStream();
    stream.addTrack(c.track);
    destino.srcObject = stream;
    destino.play().catch(() => {
      // Los navegadores no dejan reproducir sin un gesto del usuario. Como todo esto arranca
      // desde el botón "Ver la clase" (D12) esto casi nunca pasa, pero si pasa hay que decirlo
      // en vez de dejar un cuadro mudo.
      aviso('Tocá el video para que empiece a sonar.', 'atencion');
    });
  }

  function sacarPista(producerId) {
    const c = S.consumidores.get(producerId);
    if (c) { try { c.close(); } catch (e) {} S.consumidores.delete(producerId); }

    const el = S.audios.get(producerId);
    if (el) { el.srcObject = null; el.remove(); S.audios.delete(producerId); }

    const pista = S.pistas.get(producerId);
    if (pista) {
      const v = $('txVideo');
      if (v?.srcObject instanceof MediaStream) { try { v.srcObject.removeTrack(pista); } catch (e) {} }
      S.pistas.delete(producerId);
    }
    pintar();
  }

  // ── Hablar: pulsar para hablar (alumno) ────────────────────────────────────
  //
  // Ver H3 de specs/sala-hablar.spec.md. El micrófono del alumno SOLO manda mientras el dedo
  // está apoyado: la voz nace pausada y con `zeroRtpOnPause`, así que soltado no viaja ni un
  // paquete. Nunca un micrófono abierto en la casa de un chico.

  // Deja lista la voz: permiso de audio en el ticket, micrófono y productor PAUSADO. La primera
  // vez dispara el permiso del navegador, que el chico tiene que aceptar.
  function prepararVoz() {
    if (S.voz) return Promise.resolve();
    if (S.preparando) return S.preparando;

    S.preparando = (async () => {
      // Para hablar hay que estar escuchando: sin eso no oiría a quién le contesta.
      if (!S.mirando) await empezarAMirar();

      // Si el ticket con el que entró era de escucha, se pide otro. Un segundo 'hola' en la
      // misma conexión renueva los permisos sin cortar lo que se está escuchando.
      if (S.permiso !== 'audio') {
        const { ticket } = await pedirTicket();
        const r = await pedir('hola', { ticket }, 'permisos');
        S.permiso = r.emitir;
        if (r.emitir !== 'audio') throw new Error('Tu profe no habilitó a los alumnos a hablar');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      S.vozPista = stream.getAudioTracks()[0];

      const t = await transporteDeEnvio();
      S.voz = await t.produce({
        track: S.vozPista,
        codecOptions: OPUS_VOZ,
        // Soltado = 0 paquetes. Sin esto, un alumno con el botón suelto sigue mandando.
        zeroRtpOnPause: true,
        disableTrackOnPause: true,
        stopTracks: false,
        appData: { fuente: 'voz' },
      });
      // El servidor ya la creó pausada; esto frena también el envío del lado del navegador.
      S.voz.pause();
    })();

    return S.preparando.finally(() => { S.preparando = null; });
  }

  async function apretar() {
    if (S.dedoAbajo) return;
    S.dedoAbajo = true;
    pintar();
    try {
      if (!S.voz) {
        aviso('Preparando el micrófono…', 'atencion');
        await prepararVoz();
        aviso('');
        // Si ya soltó mientras se preparaba (o el navegador preguntó el permiso), NO habla: la
        // primera vez solo deja el micrófono listo.
        if (!S.dedoAbajo) return pintar();
      }
      mandar({ t: 'hablar' });
    } catch (e) {
      S.dedoAbajo = false;
      if (e.name === 'NotAllowedError') aviso('No diste permiso para usar el micrófono.', 'error');
      else aviso(e.message || 'No se pudo abrir el micrófono.', 'error');
      pintar();
    }
  }

  // El servidor dijo que hay lugar: recién ahora sale la voz.
  function alPoderHablar() {
    if (!S.dedoAbajo || !S.voz) { mandar({ t: 'callar' }); return; }
    try { S.voz.resume(); } catch (e) { /* se cerró en el medio */ }
    S.hablando = true;
    clearTimeout(S.relojVoz);
    S.relojVoz = setTimeout(() => soltar(), MAX_PULSACION_MS);
    pintar();
  }

  function soltar() {
    if (!S.dedoAbajo && !S.hablando) return;
    S.dedoAbajo = false;
    const estaba = S.hablando;
    cortarLocal();
    if (estaba) mandar({ t: 'callar' });
    pintar();
  }

  // Frena la voz de este lado, sin preguntarle nada al servidor.
  function cortarLocal() {
    clearTimeout(S.relojVoz);
    S.relojVoz = null;
    S.hablando = false;
    S.dedoAbajo = false;
    try { if (S.voz && !S.voz.paused) S.voz.pause(); } catch (e) { /* ya estaba cerrada */ }
  }

  // Suelta el micrófono del todo: "Solo yo hablo", silenciado, o se fue. El `stop()` es lo que
  // apaga la lucecita del micrófono en el navegador, que es la señal que entiende la familia.
  function soltarMicrofono() {
    cortarLocal();
    if (S.voz) { try { S.voz.close(); } catch (e) {} S.voz = null; }
    if (S.vozPista) { try { S.vozPista.stop(); } catch (e) {} S.vozPista = null; }
    if (S.txEnvio && !S.emitiendo) { try { S.txEnvio.close(); } catch (e) {} S.txEnvio = null; }
  }

  // Quién está hablando, para el indicador del partial. Nadie habla de forma anónima.
  function avisarVoces() {
    if (typeof window.Transmision?.alCambiarVoces === 'function') {
      window.Transmision.alCambiarVoces([...S.voces.values()]);
    }
  }

  // ── Cortar ─────────────────────────────────────────────────────────────────

  function limpiar(cerrarWs = true) {
    soltarMicrofono();
    for (const p of S.productores.values()) {
      try { p.track?.stop(); } catch (e) {}
      try { p.close(); } catch (e) {}
    }
    for (const c of S.consumidores.values()) { try { c.close(); } catch (e) {} }
    for (const el of S.audios.values()) { el.srcObject = null; el.remove(); }
    S.productores.clear(); S.consumidores.clear(); S.pistas.clear(); S.audios.clear();

    const v = $('txVideo');
    if (v) v.srcObject = null;

    try { S.txEnvio?.close(); } catch (e) {}
    try { S.txRecibo?.close(); } catch (e) {}
    S.txEnvio = S.txRecibo = null;
    S.voces.clear(); avisarVoces();

    if (cerrarWs && S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  }

  function dejarDeMirar() { S.mirando = false; limpiar(); pintar(); }
  function dejarDeEmitir() { S.emitiendo = false; limpiar(); pintar(); }

  // ── Pintado ────────────────────────────────────────────────────────────────
  //
  // Solo lo que depende de ESTA pestaña (si estoy mirando, si estoy emitiendo, si estoy
  // hablando). Todo lo demás —si hay transmisión, si la voz está abierta a los alumnos— lo pinta
  // el partial con los datos del poll, que es la fuente de verdad.

  function pintar() {
    const hayVideo = [...S.pistas.values()].some(t => t.kind === 'video');
    const cuadro = $('txCuadro');
    if (cuadro) cuadro.style.display = (S.mirando || S.emitiendo) ? '' : 'none';

    const sinVideo = $('txSinVideo');
    if (sinVideo) sinVideo.style.display = (S.mirando && !hayVideo) ? '' : 'none';

    document.querySelectorAll('[data-tx-cuando]').forEach((el) => {
      const cuando = el.dataset.txCuando;
      const visible = (cuando === 'mirando'   && S.mirando)
                   || (cuando === 'emitiendo' && S.emitiendo)
                   || (cuando === 'quieto'    && !S.mirando && !S.emitiendo);
      el.style.display = visible ? '' : 'none';
    });

    for (const [cual, id] of [['micro', 'txBtnMicro'], ['pantalla', 'txBtnPantalla'], ['camara', 'txBtnCamara']]) {
      const b = $(id);
      if (b) b.classList.toggle('activo', S.productores.has(cual));
    }

    // El botón de pulsar para hablar.
    const ptt = $('txPtt');
    if (ptt) {
      ptt.classList.toggle('hablando', S.hablando);
      ptt.classList.toggle('esperando', S.dedoAbajo && !S.hablando);
      const txt = $('txPttTexto');
      if (txt) {
        txt.textContent = S.hablando ? 'Hablando… soltá para terminar'
          : S.dedoAbajo ? 'Esperá…'
          : 'Mantené apretado para hablar';
      }
    }
  }

  // ── Se expone lo mínimo, para que el partial lo enganche ───────────────────

  window.Transmision = {
    empezarAEmitir, dejarDeEmitir,
    empezarAMirar, dejarDeMirar,
    publicarMicrofono, publicarPantalla, publicarCamara, despublicar,
    apretar, soltar, soltarMicrofono,
    pintar,
    estoyMirando:   () => S.mirando,
    estoyEmitiendo: () => S.emitiendo,
    estoyHablando:  () => S.hablando,
    tengoMicrofono: () => !!S.voz,
    tieneProductor: (c) => S.productores.has(c),
    // El partial lo reemplaza para pintar "Hablando: …".
    alCambiarVoces: null,
  };

  // La pestaña que se cierra suelta todo en el acto: un alumno que se va no puede seguir
  // consumiendo puerto (RN-9), ni dejar un micrófono abierto.
  window.addEventListener('pagehide', () => limpiar());
})();
