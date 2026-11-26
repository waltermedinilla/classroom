// Novedades guiadas — specs/recorrido-novedades.spec.md (D5).
//
// La pantalla se oscurece, queda iluminado lo nuevo y un cartel lo explica. Las novedades
// llegan del servidor en #novedadesDatos (data-lista, escapado): solo las que le corresponden
// a esta persona en esta página y todavía no vio.
//
// Reglas que este archivo cumple:
//   - De a una (RN-6), de la más vieja a la más nueva.
//   - Un paso se muestra solo si lo que ilumina está A LA VISTA (D2-3). Si ninguno está, se
//     espera (el botón de la sala aparece con el primer poll) y la novedad NO se marca.
//   - Los textos son texto: **así** es negrita y se arma con nodos, nunca como HTML (NV-10).
//   - Si algo falla, se cierra y la página sigue igual (RN-7).
(function () {
  'use strict';
  var datos = document.getElementById('novedadesDatos');
  if (!datos) return;
  var lista;
  try { lista = JSON.parse(datos.getAttribute('data-lista') || '[]'); } catch (e) { return; }
  if (!Array.isArray(lista) || !lista.length) return;

  // En cluster, el usuario cacheado de otro proceso puede tardar unos segundos en enterarse de
  // que ya la vio: se recuerda también en este navegador para no repetirla en ese rato.
  var CLAVE = 'novedadVista:';
  function yaVistaAca(id) {
    try { return sessionStorage.getItem(CLAVE + id) === '1' || localStorage.getItem(CLAVE + id) === '1'; } catch (e) { return false; }
  }
  function recordarAca(id) {
    try { sessionStorage.setItem(CLAVE + id, '1'); localStorage.setItem(CLAVE + id, '1'); } catch (e) { /* sin storage */ }
  }
  lista = lista.filter(function (n) { return n && n.id && Array.isArray(n.pasos) && !yaVistaAca(n.id); });
  if (!lista.length) return;

  function visible(sel) {
    if (!sel) return true;   // paso centrado
    var el;
    try { el = document.querySelector(sel); } catch (e) { return false; }
    if (!el || el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function pasosVisibles(n) {
    return n.pasos.filter(function (p) { return visible(p.donde); });
  }
  // Una novedad con algún paso que ilumina algo espera a que eso esté; una que es solo de
  // cartel centrado sale enseguida.
  function lista_para(n) {
    var conBlanco = n.pasos.some(function (p) { return !!p.donde; });
    var vis = pasosVisibles(n);
    return conBlanco ? vis.some(function (p) { return !!p.donde; }) : vis.length > 0;
  }

  var ESTILO = [
    '.nv-tapa{position:fixed;inset:0;z-index:3000;background:transparent}',
    '.nv-tapa.nv-centro{background:rgba(15,23,42,.72)}',
    '.nv-luz{position:fixed;z-index:3001;border-radius:22px;pointer-events:none;box-shadow:0 0 0 9999px rgba(15,23,42,.72);transition:left .25s,top .25s,width .25s,height .25s}',
    '.nv-luz::after{content:"";position:absolute;inset:-6px;border-radius:28px;border:3px solid #fbbc04;animation:nvLatido 1.6s ease-out infinite}',
    '@keyframes nvLatido{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.18)}}',
    '@media (prefers-reduced-motion: reduce){.nv-luz::after{animation:none}.nv-luz{transition:none}}',
    '.nv-cartel{position:fixed;z-index:3002;background:var(--surface,#fff);color:var(--text,#202124);border-radius:14px;padding:16px 18px 14px;',
    'width:min(340px,calc(100vw - 32px));box-shadow:0 12px 32px rgba(0,0,0,.35);font-family:inherit;box-sizing:border-box}',
    '.nv-cartel:focus{outline:none}',
    '.nv-nuevo{display:inline-block;background:#fef7e0;color:#8a5300;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:8px;padding:2px 8px;margin-bottom:8px}',
    '.nv-cartel h3{margin:0 0 6px;font-size:17px;line-height:1.3}',
    '.nv-cartel p{margin:0 0 14px;font-size:14px;line-height:1.45;color:var(--text-secondary,#3c4043)}',
    '.nv-cartel p b{color:var(--text,#202124)}',
    '.nv-pie{display:flex;align-items:center;gap:8px}',
    '.nv-pasos{font-size:12px;color:var(--text-secondary,#5f6368);margin-right:auto}',
    '.nv-cartel button{border:0;border-radius:18px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:inherit}',
    '.nv-omitir{background:transparent;color:var(--text-secondary,#5f6368)}',
    '.nv-ok{background:#1a73e8;color:#fff;font-weight:500}',
    '.nv-flecha{position:absolute;width:14px;height:14px;background:var(--surface,#fff);transform:rotate(45deg)}',
  ].join('');

  var abierta = false;

  function marcar(id, como) {
    recordarAca(id);
    try {
      fetch('/novedades/' + encodeURIComponent(id) + '/vista', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ como: como }),
      }).catch(function () { /* queda recordada en este navegador; se reintenta otro día */ });
    } catch (e) { /* idem */ }
  }

  // "**x**" → negrita, armada con nodos.
  function textoConNegrita(p, texto) {
    String(texto).split('**').forEach(function (trozo, i) {
      if (!trozo) return;
      if (i % 2) { var b = document.createElement('b'); b.textContent = trozo; p.appendChild(b); }
      else p.appendChild(document.createTextNode(trozo));
    });
  }

  function mostrar(nov) {
    var pasos = pasosVisibles(nov);
    if (!pasos.length) return;
    abierta = true;
    if (!document.getElementById('nvEstilo')) {
      var st = document.createElement('style'); st.id = 'nvEstilo'; st.textContent = ESTILO; document.head.appendChild(st);
    }
    var foco = document.activeElement;
    var tapa = document.createElement('div'); tapa.className = 'nv-tapa';
    var luz = document.createElement('div'); luz.className = 'nv-luz';
    var cartel = document.createElement('div');
    cartel.className = 'nv-cartel';
    cartel.setAttribute('role', 'dialog');
    cartel.setAttribute('aria-modal', 'true');
    cartel.tabIndex = -1;
    document.body.appendChild(tapa); document.body.appendChild(luz); document.body.appendChild(cartel);
    var i = 0, cerrada = false;

    function cerrar(como) {
      if (cerrada) return;
      cerrada = true;
      [tapa, luz, cartel].forEach(function (x) { if (x.parentNode) x.parentNode.removeChild(x); });
      window.removeEventListener('resize', ubicar);
      window.removeEventListener('scroll', ubicar, true);
      document.removeEventListener('keydown', teclas, true);
      marcar(nov.id, como);
      abierta = false;
      try { if (foco && foco.focus) foco.focus(); } catch (e) { /* nada */ }
      setTimeout(siguiente, 600);
    }

    function teclas(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); cerrar('omitir'); }
      else if (ev.key === 'Tab') {   // el foco no se escapa del cartel
        var bs = cartel.querySelectorAll('button');
        if (!bs.length) return;
        var primero = bs[0], ultimo = bs[bs.length - 1];
        if (ev.shiftKey && document.activeElement === primero) { ev.preventDefault(); ultimo.focus(); }
        else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primero.focus(); }
      }
    }

    function ubicar() {
      try {
        var paso = pasos[i];
        var el = paso.donde ? document.querySelector(paso.donde) : null;
        var W = window.innerWidth, H = window.innerHeight;
        var cw = cartel.offsetWidth, ch = cartel.offsetHeight;
        var flecha = cartel.querySelector('.nv-flecha');
        if (!el || el.offsetParent === null) {          // centrado (o lo iluminado se fue)
          luz.style.display = 'none';
          tapa.classList.add('nv-centro');
          cartel.style.left = Math.max(16, (W - cw) / 2) + 'px';
          cartel.style.top = Math.max(16, (H - ch) / 2) + 'px';
          if (flecha) flecha.style.display = 'none';
          return;
        }
        tapa.classList.remove('nv-centro');
        luz.style.display = '';
        var r = el.getBoundingClientRect(), m = 6;
        luz.style.left = (r.left - m) + 'px'; luz.style.top = (r.top - m) + 'px';
        luz.style.width = (r.width + 2 * m) + 'px'; luz.style.height = (r.height + 2 * m) + 'px';
        var abajo = r.bottom + m + 16 + ch <= H || r.top - m - 16 - ch < 0;
        var left = Math.max(16, Math.min(W - cw - 16, r.left + r.width / 2 - cw / 2));
        cartel.style.left = left + 'px';
        cartel.style.top = (abajo ? r.bottom + m + 14 : r.top - m - 14 - ch) + 'px';
        if (flecha) {
          flecha.style.display = '';
          flecha.style.left = Math.max(14, Math.min(cw - 28, r.left + r.width / 2 - left - 7)) + 'px';
          flecha.style.top = abajo ? '-7px' : '';
          flecha.style.bottom = abajo ? '' : '-7px';
        }
      } catch (e) { cerrar('omitir'); }
    }

    function pintar() {
      var paso = pasos[i];
      cartel.textContent = '';
      var nuevo = document.createElement('span'); nuevo.className = 'nv-nuevo'; nuevo.textContent = 'Nuevo';
      var h = document.createElement('h3'); h.id = 'nvTit'; h.textContent = paso.titulo;
      var p = document.createElement('p'); textoConNegrita(p, paso.texto);
      var pie = document.createElement('div'); pie.className = 'nv-pie';
      var n = document.createElement('span'); n.className = 'nv-pasos'; n.textContent = (i + 1) + ' de ' + pasos.length;
      var om = document.createElement('button'); om.type = 'button'; om.className = 'nv-omitir'; om.textContent = 'Omitir';
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'nv-ok';
      ok.textContent = i < pasos.length - 1 ? 'Siguiente' : 'Entendido';
      om.addEventListener('click', function () { cerrar('omitir'); });
      ok.addEventListener('click', function () {
        if (i < pasos.length - 1) { i++; pintar(); }
        else cerrar('entendido');
      });
      pie.appendChild(n); pie.appendChild(om); pie.appendChild(ok);
      var fl = document.createElement('i'); fl.className = 'nv-flecha';
      cartel.appendChild(nuevo); cartel.appendChild(h); cartel.appendChild(p); cartel.appendChild(pie); cartel.appendChild(fl);
      cartel.setAttribute('aria-labelledby', 'nvTit');
      var el = paso.donde ? document.querySelector(paso.donde) : null;
      if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); } }
      ubicar();
      setTimeout(ubicar, 50);
      ok.focus();
    }

    tapa.addEventListener('click', function () { cerrar('omitir'); });
    window.addEventListener('resize', ubicar);
    window.addEventListener('scroll', ubicar, true);
    document.addEventListener('keydown', teclas, true);
    try { pintar(); } catch (e) { cerrar('omitir'); }
  }

  // Espera a que lo nuevo esté a la vista (el botón de la sala aparece con el primer poll).
  // Revisa cada segundo durante 10 minutos; si en ese rato no apareció, no se marca y saldrá
  // otro día.
  var intentos = 0;
  function siguiente() {
    if (abierta || !lista.length) return;
    var idx = -1;
    for (var k = 0; k < lista.length; k++) if (lista_para(lista[k])) { idx = k; break; }
    if (idx < 0) {
      if (++intentos < 600) setTimeout(siguiente, 1000);
      return;
    }
    var nov = lista.splice(idx, 1)[0];
    // Un respiro para que la página termine de acomodarse antes de oscurecerla.
    setTimeout(function () {
      if (lista_para(nov)) { try { mostrar(nov); } catch (e) { abierta = false; } }
      else { lista.unshift(nov); setTimeout(siguiente, 1000); }
    }, 700);
  }

  if (document.readyState === 'complete') siguiente();
  else window.addEventListener('load', siguiente);
})();
