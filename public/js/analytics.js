// Analítica de producto (PostHog) — pageview con nombre de pantalla, tiempo activo real,
// profundidad de scroll y clicks en CTAs instrumentados a mano.
//
// No-op completo si PostHog no se cargó (POSTHOG_KEY sin configurar — ver server.js y
// views/partials/analytics-init.ejs): este archivo se incluye siempre, en todas las
// páginas, así que tiene que poder correr sin romper nada cuando la analítica está
// apagada, que es el estado por default en dev y en cualquier despliegue sin la env var.
(function () {
  'use strict';
  if (typeof posthog === 'undefined' || !window.__ANALYTICS__) return;

  var ctx = window.__ANALYTICS__;

  // ── Identificación ───────────────────────────────────────────────────────────
  // distinct_id = el _id de Mongo (ya opaco), nunca nombre/email/DNI. rol y escuela van
  // como propiedades para poder filtrar/segmentar sin poder reidentificar a una persona
  // a partir del dato que sale de este navegador.
  if (ctx.user) {
    posthog.identify(ctx.user.id, {
      role: ctx.user.role,
      school_id: ctx.user.school,
    });
  } else if (location.pathname === '/login') {
    // Red de seguridad para computadoras compartidas de la escuela: si el alumno
    // anterior cerró la pestaña sin tocar "Cerrar sesión" (ver logout() en footer.ejs,
    // que también llama a reset()), esto corta la identidad vieja antes de que el
    // siguiente alumno empiece a interactuar. Sin costo si ya estaba anónimo.
    posthog.reset();
  }

  // ── Pageview ──────────────────────────────────────────────────────────────────
  // Manual y no el capture_pageview automático de PostHog: así el evento lleva
  // screen_key (la misma clave que usan el nav y /superadmin/roles) en vez de solo la
  // URL cruda, y los reportes de Trends/Retention agrupan por pantalla, no por URL.
  posthog.capture('$pageview', {
    screen_key: ctx.screenKey,
    impersonating: ctx.impersonating,
  });

  // ── Tiempo activo real (objetivo 2) ─────────────────────────────────────────
  // "Activo" = la pestaña está visible Y hubo una interacción del usuario en los
  // últimos IDLE_TIMEOUT_MS. Una pestaña visible pero abandonada (el usuario se fue a
  // almorzar) deja de sumar segundos después de ese umbral — es la diferencia entre
  // "tiempo de carga de página" (lo que mediría un simple onload) y tiempo real.
  var IDLE_TIMEOUT_MS  = 30000; // 30s sin interactuar = inactivo
  var FLUSH_INTERVAL_MS = 30000; // manda el acumulado cada 30s, no todo junto al final
  var activeSeconds = 0;
  var lastActivityAt = Date.now();

  var ACTIVITY_EVENTS = ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
  ACTIVITY_EVENTS.forEach(function (evt) {
    document.addEventListener(evt, function () { lastActivityAt = Date.now(); }, { passive: true });
  });

  function flushActiveTime() {
    if (activeSeconds <= 0) return;
    posthog.capture('screen_time', { screen_key: ctx.screenKey, seconds: activeSeconds });
    activeSeconds = 0;
  }

  var tickId = setInterval(function () {
    var visible = document.visibilityState === 'visible';
    var recentlyActive = (Date.now() - lastActivityAt) < IDLE_TIMEOUT_MS;
    if (visible && recentlyActive) activeSeconds += 1;
  }, 1000);

  var flushId = setInterval(flushActiveTime, FLUSH_INTERVAL_MS);

  // visibilitychange→hidden es más confiable que unload/pagehide en mobile (Safari en
  // particular no siempre dispara pagehide al cambiar de app) — es el punto de flush
  // principal. pagehide queda como red de seguridad para el cierre de pestaña/navegador.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushActiveTime();
  });
  window.addEventListener('pagehide', function () {
    clearInterval(tickId);
    clearInterval(flushId);
    flushActiveTime();
  });

  // ── Profundidad de scroll (objetivo 4) ──────────────────────────────────────
  var SCROLL_THRESHOLDS = [25, 50, 75, 100];
  var scrollFired = {};
  var scrollTicking = false;

  function checkScrollDepth() {
    scrollTicking = false;
    var doc = document.documentElement;
    var scrollableHeight = doc.scrollHeight - doc.clientHeight;
    // Página sin scroll (todo entra en pantalla): no hay profundidad que medir.
    if (scrollableHeight <= 0) return;
    var percent = Math.min(100, Math.round(((window.scrollY || doc.scrollTop) + doc.clientHeight) / doc.scrollHeight * 100));
    SCROLL_THRESHOLDS.forEach(function (threshold) {
      if (percent >= threshold && !scrollFired[threshold]) {
        scrollFired[threshold] = true;
        posthog.capture('scroll_depth', { screen_key: ctx.screenKey, depth: threshold });
      }
    });
  }
  window.addEventListener('scroll', function () {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(checkScrollDepth);
  }, { passive: true });

  // ── Clicks en CTAs instrumentados (objetivo 3) ──────────────────────────────
  // Convención: agregar data-analytics="nombre_del_evento" a cualquier botón/link que se
  // quiera medir. Un solo listener delegado en document — no hace falta tocar este
  // archivo para instrumentar un botón nuevo, ver agente.md para el patrón y ejemplos
  // ya instrumentados (dashboard, login, registro).
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-analytics]');
    if (!el) return;
    posthog.capture('cta_click', { id: el.getAttribute('data-analytics'), screen_key: ctx.screenKey });
  });

  // API pública mínima para capturar eventos puntuales desde otros scripts de página
  // (dashboard.js, course.js, etc.) sin que cada uno tenga que repetir el guard de
  // "¿está PostHog cargado?" de arriba.
  window.Analytics = {
    track: function (name, props) {
      posthog.capture(name, Object.assign({ screen_key: ctx.screenKey }, props || {}));
    },
  };
})();
