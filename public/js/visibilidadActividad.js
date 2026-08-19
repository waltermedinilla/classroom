// Regla ÚNICA de "¿el alumno ve esta actividad?" — ver specs/visibilidad-actividades.spec.md
//
// Está en public/js y no en services/ a propósito: la misma decisión hace falta en tres lados
// y no puede divergir entre ellos.
//   1) el servidor, para filtrar lo que devuelve GET /activities/course/:id (y my-pending, y el
//      resumen de pendientes del dashboard) → los routers hacen require() de este archivo;
//   2) el navegador, para dibujar el chip "Programada"/"Oculta" y el ícono del ojo en la tarjeta
//      del docente → course.ejs lo carga como <script> antes de course.js, y queda en
//      window.Visibilidad;
//   3) los tests → tests/unit/visibilidadActividad.test.js.
// Es el patrón de public/js/devoluciones.js (lógica pura, sin DOM) con el envoltorio de
// public/js/fecha.js (un solo nombre colgado del global, en vez de sueltos).
//
// El estado sale de dos campos de Activity:
//   availableFrom   → fecha desde la que se publica sola (la que carga el docente)
//   visibleOverride → override manual del botón de ojo: null = automático, true = mostrar ya,
//                     false = ocultar. Los documentos viejos no tienen el campo y se leen
//                     como automático, así que nada de lo ya cargado cambia de comportamiento.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Visibilidad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  var VISIBLE    = 'visible';     // la ve el alumno
  var PROGRAMADA = 'programada';  // todavía no: availableFrom es futura, se abre sola
  var OCULTA     = 'oculta';      // el docente la bajó a mano con el ojo

  var ETIQUETAS = {
    visible:    'Visible',
    programada: 'Programada',
    oculta:     'Oculta',
  };

  // Normaliza a milisegundos. Acepta Date, string ISO (lo que llega por JSON) o número.
  function ms(fecha) {
    return fecha instanceof Date ? fecha.getTime() : new Date(fecha).getTime();
  }

  /**
   * ¿La fecha de publicación ya llegó? Es el estado "automático", ignorando el ojo.
   * Sin availableFrom se considera publicada (el schema le pone Date.now por default, pero
   * un documento sin el campo no tiene por qué quedar invisible para siempre).
   */
  function disponiblePorFecha(act, ahora) {
    if (!act || !act.availableFrom) return true;
    return ms(act.availableFrom) <= ms(ahora || new Date());
  }

  /**
   * Estado de la actividad de cara al alumno: 'visible' | 'programada' | 'oculta'.
   * El override manual del docente le gana siempre a la fecha, en los dos sentidos.
   */
  function estadoVisibilidad(act, ahora) {
    if (!act) return OCULTA;
    if (act.visibleOverride === true)  return VISIBLE;
    if (act.visibleOverride === false) return OCULTA;
    return disponiblePorFecha(act, ahora) ? VISIBLE : PROGRAMADA;
  }

  /** Atajo booleano de estadoVisibilidad(). */
  function esVisibleParaAlumno(act, ahora) {
    return estadoVisibilidad(act, ahora) === VISIBLE;
  }

  /** Texto corto del chip. */
  function etiquetaVisibilidad(estado) {
    return ETIQUETAS[estado] || ETIQUETAS.oculta;
  }

  /**
   * Valor que hay que guardar en visibleOverride cuando el docente toca el ojo.
   *
   * El ojo es un interruptor de DOS posiciones (visible / no visible), no un ciclo de tres:
   * invierte el estado efectivo. La gracia está en que si para lograr ese estado alcanza con
   * volver al automático, devuelve null en vez de fijar el override — así una actividad
   * programada que el docente adelantó y volvió a bajar queda otra vez esperando su fecha,
   * con la fecha intacta, en lugar de quedar oculta para siempre.
   *
   * @returns {boolean|null} lo que va en activity.visibleOverride
   */
  function proximoOverride(act, ahora) {
    var queremosVisible = !esVisibleParaAlumno(act, ahora);
    var automatico      = disponiblePorFecha(act, ahora);
    return automatico === queremosVisible ? null : queremosVisible;
  }

  /**
   * Fragmento de query de Mongo equivalente a esVisibleParaAlumno(). Tiene que aceptar
   * exactamente los mismos documentos que la función pura (lo verifica el test cruzado).
   *
   * `$ne: false` incluye a los documentos donde el campo falta o es null — o sea, a todo lo
   * cargado antes de esta feature.
   *
   * OJO al combinarlo: devuelve un `$or` de primer nivel. En GET /course/:id hay otro `$or`
   * (el de enrollmentDates) y si los dos se asignan a la misma clave el segundo pisa al
   * primero en silencio. Por eso los dos se meten dentro de un `$and`.
   */
  function filtroVisibleParaAlumno(ahora) {
    var corte = ahora instanceof Date ? ahora : new Date(ahora || Date.now());
    return {
      $or: [
        { visibleOverride: true },
        { visibleOverride: { $ne: false }, availableFrom: { $lte: corte } },
      ],
    };
  }

  return {
    VISIBLE: VISIBLE, PROGRAMADA: PROGRAMADA, OCULTA: OCULTA,
    disponiblePorFecha: disponiblePorFecha,
    estadoVisibilidad: estadoVisibilidad,
    esVisibleParaAlumno: esVisibleParaAlumno,
    etiquetaVisibilidad: etiquetaVisibilidad,
    proximoOverride: proximoOverride,
    filtroVisibleParaAlumno: filtroVisibleParaAlumno,
  };
});
