/* Colapsa las solapas de sección (.admin-nav) detrás de un botón en pantallas chicas.
 *
 * Por qué existe: los paneles tienen entre 1 y 11 solapas. En un viewport de 375 px el nav
 * del superadmin medía 1356 px y, al ser un flex sin wrap, ESTIRABA EL BODY ENTERO a 1372 px
 * — de ahí el desfasaje de ancho y el scroll horizontal en todas las páginas del panel.
 *
 * La solución es genérica a propósito: opera sobre `.admin-nav`, que es la clase que usan
 * los cuatro partials de navegación (admin, superadmin, directivo, preceptor). Así no hay
 * que tocar cada vista ni mantener cuatro variantes del mismo menú.
 *
 * En escritorio no hace nada: el nav se muestra tal cual siempre estuvo.
 */
(function () {
  var BREAKPOINT = 900; // por encima de esto, solapas normales

  function init() {
    var nav = document.querySelector('.admin-nav');
    if (!nav || nav.dataset.responsiveListo) return;
    nav.dataset.responsiveListo = '1';

    // El rótulo del botón es la solapa activa: en móvil, saber DÓNDE estás importa más
    // que ver todas las opciones a la vez.
    //
    // Ojo con leer textContent directo: los ítems llevan el ícono como
    // <span class="material-symbols-outlined">dashboard</span>, y el nombre del ícono es
    // texto real dentro del nodo. Sin filtrarlo, el botón decía "dashboard Resumen".
    var activo = nav.querySelector('.admin-nav-item.active');
    var etiqueta = 'Secciones';
    if (activo) {
      var copia = activo.cloneNode(true);
      copia.querySelectorAll('.material-symbols-outlined').forEach(function (i) { i.remove(); });
      etiqueta = copia.textContent.replace(/\s+/g, ' ').trim() || 'Secciones';
    }

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Abrir menú de secciones');
    toggle.innerHTML =
      '<span class="material-symbols-outlined">menu</span>' +
      '<span class="nav-toggle-label"></span>' +
      '<span class="material-symbols-outlined nav-toggle-chevron">expand_more</span>';
    // textContent y no innerHTML: el nombre de la solapa sale del DOM y no hace falta
    // volver a interpretarlo como markup.
    toggle.querySelector('.nav-toggle-label').textContent = etiqueta;

    nav.parentNode.insertBefore(toggle, nav);

    function cerrar() {
      nav.classList.remove('nav-abierto');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.querySelector('.nav-toggle-chevron').textContent = 'expand_more';
    }

    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var abierto = nav.classList.toggle('nav-abierto');
      toggle.setAttribute('aria-expanded', abierto ? 'true' : 'false');
      toggle.querySelector('.nav-toggle-chevron').textContent = abierto ? 'expand_less' : 'expand_more';
    });

    // Tocar fuera o Escape cierra el panel. Sin esto queda abierto tapando la página,
    // que es justamente el problema que vinimos a resolver.
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target) && e.target !== toggle) cerrar();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') cerrar();
    });

    // Al pasar a escritorio el panel se cierra: si quedara la clase puesta, el nav se
    // seguiría viendo en columna con las solapas apiladas.
    window.addEventListener('resize', function () {
      if (window.innerWidth > BREAKPOINT) cerrar();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
