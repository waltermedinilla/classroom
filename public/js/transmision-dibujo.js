/* Dibujar sobre la pantalla compartida (specs/sala-dibujo-y-archivos.spec.md, parte DB).
 *
 * Dos mitades en un archivo:
 *   · PURA (arriba): coordenadas, la lista de marcas y cómo se dibujan sobre un contexto 2D.
 *     Se prueba desde node con `require` (tests/unit/salaDibujo.test.js).
 *   · CONTROL (abajo): solo en el navegador. Arma el botón "Dibujar", la capa donde se dibuja
 *     y la barra de herramientas, y compone pantalla + marcas en un lienzo que viaja en lugar
 *     de la pantalla sola (DB3). Necesita window.Transmision (public/js/transmision.js), así
 *     que este <script> va DESPUÉS de aquel.
 *
 * Las marcas se guardan en coordenadas 0..1 sobre la IMAGEN, no sobre el recuadro (DB4.3): así
 * valen igual en la capa del docente, que mide lo que mida su pantalla, y en el lienzo que
 * viaja, que mide lo que mide la captura.
 */
(function (raiz) {
  'use strict';

  // ── PURA ───────────────────────────────────────────────────────────────────

  const COLORES = { rojo: '#e53935', amarillo: '#fdd835', verde: '#43a047', azul: '#1e88e5' };
  const LASER_MS = 1200;   // lo que tarda en desvanecerse el puntero láser

  // Grosor de cada herramienta, como fracción del ALTO de la imagen: un trazo tiene que verse
  // igual de grueso en una captura de 720 que en una de 1080.
  const GROSOR = { lapiz: 0.004, resaltador: 0.022, laser: 0.006 };
  const TEXTO_ALTO = 0.034;

  // Dónde cae la imagen dentro de un recuadro con object-fit: contain.
  function areaDeImagen(ancho, alto, vw, vh) {
    if (!(ancho > 0 && alto > 0 && vw > 0 && vh > 0)) return null;
    const escala = Math.min(ancho / vw, alto / vh);
    const w = vw * escala, h = vh * escala;
    return { x: (ancho - w) / 2, y: (alto - h) / 2, w, h };
  }

  // Un punto del recuadro (px relativos a su esquina) → 0..1 sobre la imagen; null afuera.
  function aNormal(ancho, alto, vw, vh, px, py) {
    const a = areaDeImagen(ancho, alto, vw, vh);
    if (!a) return null;
    const x = (px - a.x) / a.w, y = (py - a.y) / a.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function crearPizarra() {
    let marcas = [];
    let actual = null;
    return {
      marcas: () => marcas,
      dibujando: () => !!actual,
      empezar(herramienta, color, p, ahora) {
        if (!p || !GROSOR[herramienta]) return;
        actual = { tipo: herramienta, color, puntos: [p], fin: 0 };
        marcas.push(actual);
        if (herramienta === 'laser') actual.ultimo = ahora || 0;
      },
      seguir(p, ahora) {
        if (!actual || !p) return;
        const u = actual.puntos[actual.puntos.length - 1];
        // Puntos casi pegados no suman nada y engordan el dibujo de cada cuadro.
        if (Math.abs(u.x - p.x) + Math.abs(u.y - p.y) < 0.0015) return;
        actual.puntos.push(p);
        if (actual.tipo === 'laser') actual.ultimo = ahora || 0;
      },
      terminar(ahora) {
        if (!actual) return;
        if (actual.tipo === 'laser') actual.fin = ahora || 0;
        actual = null;
      },
      texto(p, texto, color) {
        const t = String(texto || '').trim().slice(0, 120);
        if (!p || !t) return;
        marcas.push({ tipo: 'texto', color, puntos: [p], texto: t });
      },
      deshacer() {
        // El láser no se deshace: se va solo. Deshacer saca la última marca que se queda.
        for (let i = marcas.length - 1; i >= 0; i--) {
          if (marcas[i].tipo !== 'laser') { marcas.splice(i, 1); break; }
        }
        actual = null;
      },
      borrar() { marcas = []; actual = null; },
      // Saca los láseres vencidos. Devuelve true si queda algo que pintar en movimiento.
      vencer(ahora) {
        marcas = marcas.filter(m => m.tipo !== 'laser' || m === actual || !m.fin || ahora - m.fin < LASER_MS);
        return marcas.some(m => m.tipo === 'laser');
      },
    };
  }

  // Pinta las marcas sobre un contexto 2D de w × h (el área de la imagen), corrido en (ox, oy).
  function pintar(ctx, marcas, w, h, ahora, ox = 0, oy = 0) {
    for (const m of marcas) {
      const pts = m.puntos;
      if (!pts || !pts.length) continue;
      ctx.save();
      if (m.tipo === 'texto') {
        const tam = Math.max(12, Math.round(h * TEXTO_ALTO));
        ctx.font = '600 ' + tam + 'px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        // Fondo oscuro detrás del texto: tiene que leerse sobre cualquier pantalla.
        const ancho = ctx.measureText ? ctx.measureText(m.texto).width : m.texto.length * tam * 0.6;
        const x = ox + pts[0].x * w, y = oy + pts[0].y * h;
        ctx.fillStyle = 'rgba(0,0,0,.75)';
        ctx.fillRect(x - 4, y - 3, ancho + 8, tam + 6);
        ctx.fillStyle = m.color;
        ctx.fillText(m.texto, x, y);
        ctx.restore();
        continue;
      }
      let alfa = 1;
      if (m.tipo === 'laser' && m.fin) alfa = Math.max(0, 1 - (ahora - m.fin) / LASER_MS);
      if (m.tipo === 'resaltador') alfa = 0.35;
      ctx.globalAlpha = alfa;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = Math.max(1.5, GROSOR[m.tipo] * h);
      ctx.lineCap = m.tipo === 'resaltador' ? 'butt' : 'round';
      ctx.lineJoin = 'round';
      if (m.tipo === 'laser') { ctx.shadowColor = m.color; ctx.shadowBlur = ctx.lineWidth * 2; }
      ctx.beginPath();
      ctx.moveTo(ox + pts[0].x * w, oy + pts[0].y * h);
      if (pts.length === 1) ctx.lineTo(ox + pts[0].x * w + 0.1, oy + pts[0].y * h + 0.1);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(ox + pts[i].x * w, oy + pts[i].y * h);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Tamaño del lienzo que viaja: el de la captura, sin pasar de 1920 de ancho (DB4.6).
  function medidaLienzo(vw, vh, max = 1920) {
    if (!(vw > 0 && vh > 0)) return { w: 1280, h: 720 };
    if (vw <= max) return { w: Math.round(vw), h: Math.round(vh) };
    return { w: max, h: Math.round(vh * max / vw) };
  }

  const api = { COLORES, LASER_MS, GROSOR, areaDeImagen, aNormal, crearPizarra, pintar, medidaLienzo };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  raiz.TransmisionDibujo = api;

  // ── CONTROL (navegador) ────────────────────────────────────────────────────

  const doc = raiz.document;
  const TX = raiz.Transmision;
  if (!doc || !TX) return;
  const $ = (id) => doc.getElementById(id);

  const ESTILO = `
  .tx-cuadro .tx-chico-btn { z-index:4; }
  .txd-capa { position:absolute; left:0; top:0; width:100%; height:100%; z-index:3; cursor:crosshair; touch-action:none; }
  .txd-barra { position:absolute; top:8px; left:50%; transform:translateX(-50%); z-index:4;
    display:flex; align-items:center; gap:2px; padding:4px 6px; border-radius:22px;
    background:rgba(32,33,36,.88); border:1px solid rgba(255,255,255,.25); box-shadow:0 2px 10px rgba(0,0,0,.4);
    max-width:calc(100% - 16px); overflow-x:auto; }
  .txd-barra button { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px;
    border:0; border-radius:50%; background:transparent; color:#e8eaed; cursor:pointer; flex:0 0 auto; }
  .txd-barra button:hover { background:rgba(255,255,255,.12); }
  .txd-barra button.activo { background:#1a73e8; color:#fff; }
  .txd-barra .material-symbols-outlined { font-size:20px; }
  .txd-barra .txd-sep { width:1px; height:22px; background:rgba(255,255,255,.25); margin:0 4px; flex:0 0 auto; }
  .txd-barra .txd-color { width:22px; height:22px; margin:0 3px; border:2px solid rgba(255,255,255,.5); }
  .txd-barra .txd-color.activo { outline:2px solid #fff; outline-offset:2px; background-clip:padding-box; }
  .txd-texto { position:absolute; z-index:5; min-width:120px; font:600 15px system-ui, sans-serif;
    padding:3px 6px; border-radius:4px; border:1px solid #fff; background:rgba(0,0,0,.7); outline:none; }
  `;

  let estilo = null;
  function ponerEstilo() {
    if (estilo) return;
    estilo = doc.createElement('style');
    estilo.textContent = ESTILO;
    doc.head.appendChild(estilo);
  }

  const S = {
    activo: false,
    herramienta: 'lapiz',
    color: COLORES.rojo,
    pizarra: crearPizarra(),
    btn: null, capa: null, ctxCapa: null, barra: null, input: null,
    lienzo: null, ctxLienzo: null, pistaLienzo: null, origen: null, reloj: null,
    mandandoLienzo: false, rafCapa: 0,
  };

  // ── el botón "Dibujar", al lado de "Dejar de compartir" ──
  function asegurarBoton() {
    if (S.btn) return S.btn;
    const cuadro = $('txCuadro'), vecino = $('txPantallaChico');
    if (!cuadro || !vecino) return null;
    ponerEstilo();
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'tx-chico-btn txd-btn';
    b.setAttribute('aria-pressed', 'false');
    b.title = 'Dibujar sobre la pantalla compartida';
    b.innerHTML = '<span class="material-symbols-outlined">draw</span><span class="tx-chico-texto">Dibujar</span>';
    b.style.display = 'none';
    b.addEventListener('click', () => (S.activo ? apagar() : prender()));
    cuadro.appendChild(b);
    S.btn = b;
    return b;
  }

  // Lo pone a la izquierda de "Dejar de compartir", que está anclado a la derecha.
  function ubicarBoton() {
    const vecino = $('txPantallaChico');
    if (!S.btn || !vecino) return;
    S.btn.style.right = (vecino.offsetWidth + 18) + 'px';
  }

  // ── la barra de herramientas ──
  // El nombre termina en _ICONOS a propósito: así lo encuentra el barrido de tools/iconos.js y
  // los iconos entran en la fuente recortada (si no, se vería la palabra en inglés).
  const HERRAMIENTA_ICONOS = {
    lapiz: 'edit',
    resaltador: 'ink_highlighter',
    laser: 'flare',
    texto: 'title',
};  // sin sangría: el barrido busca el cierre de la tabla al principio del renglón
  const HERR_NOMBRE = { lapiz: 'Lápiz', resaltador: 'Resaltador', laser: 'Puntero láser', texto: 'Texto' };

  function armarBarra() {
    const barra = doc.createElement('div');
    barra.className = 'txd-barra';
    barra.setAttribute('role', 'toolbar');
    barra.setAttribute('aria-label', 'Herramientas de dibujo');
    let html = '';
    for (const [id, ico] of Object.entries(HERRAMIENTA_ICONOS)) {
      const nom = HERR_NOMBRE[id];
      html += '<button type="button" data-herr="' + id + '" title="' + nom + '" aria-label="' + nom + '">' +
              '<span class="material-symbols-outlined">' + ico + '</span></button>';
    }
    html += '<span class="txd-sep"></span>';
    for (const [nom, hex] of Object.entries(COLORES)) {
      html += '<button type="button" class="txd-color" data-color="' + hex + '" style="background:' + hex +
              '" title="' + nom + '" aria-label="Color ' + nom + '"></button>';
    }
    html += '<span class="txd-sep"></span>' +
      '<button type="button" data-acc="deshacer" title="Deshacer (Ctrl+Z)" aria-label="Deshacer"><span class="material-symbols-outlined">undo</span></button>' +
      '<button type="button" data-acc="borrar" title="Borrar todo" aria-label="Borrar todo"><span class="material-symbols-outlined">delete_sweep</span></button>' +
      '<button type="button" data-acc="cerrar" title="Dejar de dibujar" aria-label="Dejar de dibujar"><span class="material-symbols-outlined">close</span></button>';
    barra.innerHTML = html;
    barra.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.herr) { cerrarTexto(true); S.herramienta = b.dataset.herr; }
      if (b.dataset.color) S.color = b.dataset.color;
      if (b.dataset.acc === 'deshacer') S.pizarra.deshacer();
      if (b.dataset.acc === 'borrar') S.pizarra.borrar();
      if (b.dataset.acc === 'cerrar') { apagar(); return; }
      pintarBarra();
      pedirCuadro();
    });
    return barra;
  }

  function pintarBarra() {
    if (!S.barra) return;
    S.barra.querySelectorAll('[data-herr]').forEach(b => b.classList.toggle('activo', b.dataset.herr === S.herramienta));
    S.barra.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('activo', b.dataset.color === S.color));
    if (S.capa) S.capa.style.cursor = S.herramienta === 'texto' ? 'text' : 'crosshair';
  }

  // ── la capa del docente: donde se dibuja con el mouse y se ve en el acto (DB4.4) ──
  function medidaVideo() {
    const v = $('txVideo');
    return { vw: v ? v.videoWidth : 0, vh: v ? v.videoHeight : 0 };
  }

  function puntoDe(e) {
    const r = S.capa.getBoundingClientRect();
    const { vw, vh } = medidaVideo();
    return aNormal(r.width, r.height, vw, vh, e.clientX - r.left, e.clientY - r.top);
  }

  function armarCapa() {
    const c = doc.createElement('canvas');
    c.className = 'txd-capa';
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const p = puntoDe(e);
      if (!p) return;
      e.preventDefault();
      if (S.herramienta === 'texto') { abrirTexto(e, p); return; }
      c.setPointerCapture(e.pointerId);
      S.pizarra.empezar(S.herramienta, S.color, p, performance.now());
      pedirCuadro();
    });
    c.addEventListener('pointermove', (e) => {
      if (!S.pizarra.dibujando()) return;
      S.pizarra.seguir(puntoDe(e), performance.now());
      pedirCuadro();
    });
    const fin = () => { if (S.pizarra.dibujando()) { S.pizarra.terminar(performance.now()); pedirCuadro(); } };
    c.addEventListener('pointerup', fin);
    c.addEventListener('pointercancel', fin);
    return c;
  }

  function pintarCapa() {
    S.rafCapa = 0;
    if (!S.capa) return;
    const r = S.capa.getBoundingClientRect();
    const dpr = raiz.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (S.capa.width !== W || S.capa.height !== H) { S.capa.width = W; S.capa.height = H; }
    const ctx = S.ctxCapa;
    ctx.clearRect(0, 0, W, H);
    const { vw, vh } = medidaVideo();
    const a = areaDeImagen(W, H, vw, vh);
    const ahora = performance.now();
    const quedaLaser = S.pizarra.vencer(ahora);
    if (a) pintar(ctx, S.pizarra.marcas(), a.w, a.h, ahora, a.x, a.y);
    if (quedaLaser) pedirCuadro();
  }

  function pedirCuadro() {
    if (!S.rafCapa && S.capa) S.rafCapa = raiz.requestAnimationFrame(pintarCapa);
  }

  // ── texto (DB2) ──
  function abrirTexto(e, p) {
    cerrarTexto(true);
    const cuadro = $('txCuadro');
    const r = cuadro.getBoundingClientRect();
    const i = doc.createElement('input');
    i.type = 'text';
    i.className = 'txd-texto';
    i.maxLength = 120;
    i.placeholder = 'Escribí y Enter';
    i.style.left = (e.clientX - r.left) + 'px';
    i.style.top = (e.clientY - r.top) + 'px';
    i.style.color = S.color;
    i._p = p;
    i.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); cerrarTexto(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); cerrarTexto(false); }
    });
    i.addEventListener('blur', () => cerrarTexto(true));
    cuadro.appendChild(i);
    S.input = i;
    setTimeout(() => i.focus(), 0);
  }

  function cerrarTexto(guardar) {
    const i = S.input;
    if (!i) return;
    S.input = null;
    if (guardar) S.pizarra.texto(i._p, i.value, S.color);
    i.remove();
    pedirCuadro();
  }

  // ── lo que viaja: pantalla + marcas en un lienzo (DB3) ──
  function componer() {
    const o = S.origen;
    if (!o || !S.ctxLienzo) return;
    const vw = o.videoWidth, vh = o.videoHeight;
    if (!vw || !vh) return;
    const m = medidaLienzo(vw, vh);
    if (S.lienzo.width !== m.w || S.lienzo.height !== m.h) { S.lienzo.width = m.w; S.lienzo.height = m.h; }
    const ctx = S.ctxLienzo;
    ctx.drawImage(o, 0, 0, m.w, m.h);
    pintar(ctx, S.pizarra.marcas(), m.w, m.h, performance.now());
  }

  async function mandarLienzo(si) {
    if (si === S.mandandoLienzo) return;
    const cruda = TX.pistaPantalla && TX.pistaPantalla();
    if (!cruda) return;
    try {
      await TX.reemplazarPantalla(si ? S.pistaLienzo : cruda);
      S.mandandoLienzo = si;
    } catch (e) { /* si falla, sigue viajando lo que viajaba */ }
  }

  // DB4.2: con la pestaña oculta los temporizadores casi se frenan; viaja la pantalla sola.
  function alCambiarVisibilidad() {
    if (!S.activo) return;
    mandarLienzo(doc.visibilityState === 'visible');
  }

  function prender() {
    const cruda = TX.pistaPantalla && TX.pistaPantalla();
    if (!cruda || S.activo) return;
    ponerEstilo();
    const cuadro = $('txCuadro');
    S.activo = true;
    S.pizarra.borrar();

    S.capa = armarCapa();
    S.ctxCapa = S.capa.getContext('2d');
    S.barra = armarBarra();
    cuadro.appendChild(S.capa);
    cuadro.appendChild(S.barra);
    pintarBarra();

    S.origen = doc.createElement('video');
    S.origen.muted = true;
    S.origen.playsInline = true;
    S.origen.srcObject = new MediaStream([cruda]);
    S.origen.play().catch(() => {});
    S.lienzo = doc.createElement('canvas');
    const m = medidaLienzo(cruda.getSettings().width, cruda.getSettings().height);
    S.lienzo.width = m.w; S.lienzo.height = m.h;
    S.ctxLienzo = S.lienzo.getContext('2d');
    S.pistaLienzo = S.lienzo.captureStream(15).getVideoTracks()[0];
    try { S.pistaLienzo.contentHint = 'detail'; } catch (e) { /* no todos lo tienen */ }
    S.reloj = setInterval(componer, 1000 / 15);
    componer();

    mandarLienzo(doc.visibilityState === 'visible');
    doc.addEventListener('visibilitychange', alCambiarVisibilidad);
    raiz.addEventListener('resize', pedirCuadro);
    doc.addEventListener('keydown', atajo);
    pintarBoton();
    pedirCuadro();
  }

  async function apagar() {
    if (!S.activo) return;
    S.activo = false;
    cerrarTexto(false);
    doc.removeEventListener('visibilitychange', alCambiarVisibilidad);
    raiz.removeEventListener('resize', pedirCuadro);
    doc.removeEventListener('keydown', atajo);
    // DB4.1: vuelve a viajar la pantalla sola, y recién después se suelta el lienzo.
    await mandarLienzo(false);
    clearInterval(S.reloj); S.reloj = null;
    if (S.pistaLienzo) { try { S.pistaLienzo.stop(); } catch (e) {} }
    if (S.origen) { S.origen.srcObject = null; }
    S.pistaLienzo = S.origen = S.lienzo = S.ctxLienzo = null;
    if (S.capa) S.capa.remove();
    if (S.barra) S.barra.remove();
    S.capa = S.ctxCapa = S.barra = null;
    S.mandandoLienzo = false;
    S.pizarra.borrar();
    pintarBoton();
  }

  function atajo(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !S.input) {
      e.preventDefault();
      S.pizarra.deshacer();
      pedirCuadro();
    }
  }

  function pintarBoton() {
    const b = asegurarBoton();
    if (!b) return;
    const comparte = TX.estoyEmitiendo() && TX.tieneProductor('pantalla');
    b.style.display = comparte ? '' : 'none';
    b.classList.toggle('activo', S.activo);
    b.setAttribute('aria-pressed', S.activo ? 'true' : 'false');
    const t = b.querySelector('.tx-chico-texto');
    if (t) t.textContent = S.activo ? 'Dejar de dibujar' : 'Dibujar';
    if (comparte) ubicarBoton();
  }

  // transmision.js avisa cada vez que se repinta. Si se dejó de compartir (o de emitir), el
  // modo dibujo se apaga solo (DB4.5).
  TX.alPintar = function () {
    if (S.activo && !(TX.estoyEmitiendo() && TX.tieneProductor('pantalla'))) apagar();
    pintarBoton();
  };
  pintarBoton();
})(typeof window !== 'undefined' ? window : this);
