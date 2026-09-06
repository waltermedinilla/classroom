/* Cliente de la transmisión en vivo. Ver specs/transmision-en-vivo.spec.md.
 *
 * Convive con el chat de views/partials/live-room.ejs SIN tocarlo: el chat sigue en su poll de
 * 4 segundos y por acá pasa solamente lo que no puede esperar cuatro segundos —SDP, candidatos
 * ICE, "empecé a transmitir"— (D3). Todo lo demás (manos levantadas, quién tiene la palabra, si
 * la transmisión está prendida) viaja por el poll y lo pinta el propio partial.
 *
 * Depende de public/js/mediasoup-client.bundle.js, que expone `window.mediasoupClient`.
 * ⚠️ Ese bundle está COMMITEADO a propósito: el proyecto no tiene paso de build y el deploy
 * solo hace git pull + npm install + pm2 reload. Si algún día se actualiza mediasoup-client,
 * hay que correr `npm run build:mediasoup` y commitear el resultado.
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
    conectando: false,
    reintentos: 0,
    capa: '360p',
    mirando: false,
    emitiendo: false,
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

  async function conectar() {
    if (S.conectando || (S.ws && S.ws.readyState === WebSocket.OPEN)) return true;
    S.conectando = true;

    try {
      // El ticket lo firma Express, no este proceso (D4). Dura 60 segundos: alcanza de sobra
      // para abrir el WebSocket, y es lo que hace que revocar el acceso surta efecto rápido.
      const r = await post(BASE + '/transmision/ticket');
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || 'no se pudo entrar a la transmisión');
      }
      const { ticket } = await r.json();

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      S.ws = new WebSocket(`${proto}//${location.host}/rtc`);

      await new Promise((resolve, reject) => {
        S.ws.onopen = resolve;
        S.ws.onerror = () => reject(new Error('no se pudo abrir la conexión de video'));
      });

      S.ws.onmessage = (ev) => manejar(JSON.parse(ev.data));
      S.ws.onclose = () => alCerrarse();

      const bienvenida = await pedir('hola', { ticket }, 'bienvenido');
      S.capa = bienvenida.capa || '360p';

      S.device = new window.mediasoupClient.Device();
      await S.device.load({ routerRtpCapabilities: bienvenida.rtpCapabilities });

      S.reintentos = 0;
      return bienvenida;
    } finally {
      S.conectando = false;
    }
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

    if (m.t === 'error') {
      // Un ticket vencido no es un error para el usuario: se pide otro y se sigue.
      if (m.recuperable) return reconectar();
      aviso(m.error, 'error');
    }
    return undefined;
  }

  function alCerrarse() {
    S.ws = null;
    if (!S.mirando && !S.emitiendo) return;

    // Reconexión con espera creciente. El tope de 5 intentos no es un capricho: si a los ~30
    // segundos no volvió, lo honesto es decirlo y dejar de consumir batería y datos.
    if (S.reintentos >= 5) {
      aviso('Se cortó la transmisión. Podés seguir la clase por el chat.', 'error');
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
    if (!bienvenida.emitir) throw new Error('Tu escuela todavía no te habilitó para transmitir');

    await transporteDeEnvio();
    S.emitiendo = true;

    if (modo.micro !== false) await publicarMicrofono();
    if (modo.pantalla)        await publicarPantalla();
    if (modo.camara)          await publicarCamara();

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
      codecOptions: { opusDtx: true, opusFec: true },
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
    try { p.close(); } catch (e) { /* ya estaba cerrado */ }
    S.productores.delete(cual);
    post(BASE + '/transmision/modo', { [cual]: false }).catch(() => {});
    pintar();
  }

  // ── Mirar (alumno) ─────────────────────────────────────────────────────────

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
    if (!S.mirando || S.consumidores.has(producerId)) return;
    const t = await transporteDeRecibo();

    const { parametros } = await pedir('consumir', {
      transportId: t.id, producerId, rtpCapabilities: S.device.rtpCapabilities,
    }, 'consumiendo');

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
    const destino = c.kind === 'audio' ? $('txAudio') : $('txVideo');
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

    const pista = S.pistas.get(producerId);
    if (pista) {
      for (const el of [$('txVideo'), $('txAudio')]) {
        if (el?.srcObject instanceof MediaStream) {
          try { el.srcObject.removeTrack(pista); } catch (e) {}
        }
      }
      S.pistas.delete(producerId);
    }
    pintar();
  }

  // ── Cortar ─────────────────────────────────────────────────────────────────

  function limpiar(cerrarWs = true) {
    for (const p of S.productores.values()) { try { p.close(); } catch (e) {} }
    for (const c of S.consumidores.values()) { try { c.close(); } catch (e) {} }
    S.productores.clear(); S.consumidores.clear(); S.pistas.clear();

    for (const el of [$('txVideo'), $('txAudio')]) if (el) el.srcObject = null;

    try { S.txEnvio?.close(); } catch (e) {}
    try { S.txRecibo?.close(); } catch (e) {}
    S.txEnvio = S.txRecibo = null;

    if (cerrarWs && S.ws) { try { S.ws.close(); } catch (e) {} S.ws = null; }
  }

  function dejarDeMirar() { S.mirando = false; limpiar(); pintar(); }
  function dejarDeEmitir() { S.emitiendo = false; limpiar(); pintar(); }

  // ── Pintado ────────────────────────────────────────────────────────────────
  //
  // Solo lo que depende de ESTA pestaña (si estoy mirando, si estoy emitiendo). Todo lo demás
  // —quién tiene la palabra, las manos levantadas, si hay transmisión— lo pinta el partial con
  // los datos del poll, que es la fuente de verdad.

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
  }

  // ── Se expone lo mínimo, para que el partial lo enganche ───────────────────

  window.Transmision = {
    empezarAEmitir, dejarDeEmitir,
    empezarAMirar, dejarDeMirar,
    publicarMicrofono, publicarPantalla, publicarCamara, despublicar,
    pintar,
    estoyMirando:   () => S.mirando,
    estoyEmitiendo: () => S.emitiendo,
    tieneProductor: (c) => S.productores.has(c),
  };

  // La pestaña que se cierra suelta todo en el acto: un alumno que se va no puede seguir
  // consumiendo puerto (RN-9).
  window.addEventListener('pagehide', () => limpiar());
})();
