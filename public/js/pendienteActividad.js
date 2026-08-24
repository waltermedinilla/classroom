// Regla ÚNICA de "¿esta actividad todavía le cuenta al alumno como tarea PENDIENTE?"
// Ver specs/pendientes-vencidos.spec.md.
//
// Vive en public/js y no en services/ por el mismo motivo que su hermana
// public/js/visibilidadActividad.js: la misma decisión hace falta en el servidor
// (el contador del inicio y la pantalla "Mis pendientes") y en los tests, y no puede
// divergir entre ellos. Se carga con require() desde los routers.
//
// QUÉ RESUELVE (pedido del usuario, 2026-08-23): al alumno le seguían figurando como
// "tareas para entregar" actividades que ya habían expirado hace semanas. Eran dos
// agujeros distintos, los dos por la misma razón — el filtro anterior solo miraba
// `dueDate >= ahora`, y había dos formas de que eso nunca dejara de dar verdadero:
//
//   1) Actividad SIN fecha de entrega. `if (!a.dueDate) return true` la dejaba pendiente
//      para siempre. En el espejo local del 2026-08-23 eran 68 actividades, de hasta 29
//      días de antigüedad.
//   2) Actividad vencida con "entregas tardías habilitadas". El docente abre las tardías
//      y no las cierra nunca, así que `if (a.allowLateSubmissions) return true` la dejaba
//      pendiente para siempre. Eran 45, de hasta 24 días vencidas.
//
// Ahora cada una tiene su ventana y después caduca sola, sin que nadie toque nada.
//
// OJO CON EL ALCANCE: esto decide qué se CUENTA como pendiente (el cartel "Tenés N tareas
// pendientes" del inicio y la lista de /activities/my-pending). NO decide si el alumno
// puede entregar: eso lo sigue mandando `allowLateSubmissions` en la ruta de entrega, y
// la actividad sigue estando en la solapa Actividades del curso con su chip de siempre.
// Que caduque el pendiente no le cierra la puerta a nadie.
//
// Tampoco es la regla del legajo del SOE (services/soeIndicadores.js): ahí "pendiente"
// significa "esto nunca lo entregó" y las vencidas TIENEN que contar. Son dos preguntas
// distintas y a propósito no comparten esta función.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Pendiente = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  var UN_DIA = 24 * 60 * 60 * 1000;

  // Ventanas elegidas por el usuario el 2026-08-23. Son los dos únicos números de la
  // feature: para cambiar la política se cambian acá y no hay que tocar nada más.
  var DIAS_SIN_FECHA = 15;  // desde que se publica, si el docente no puso fecha de entrega
  var DIAS_TARDIAS   = 14;  // desde el vencimiento, si el docente dejó las tardías abiertas

  // Normaliza a milisegundos. Acepta Date, string ISO (lo que llega por JSON) o número.
  function ms(fecha) {
    return fecha instanceof Date ? fecha.getTime() : new Date(fecha).getTime();
  }

  function ahoraMs(ahora) {
    return ms(ahora || new Date());
  }

  /**
   * Desde cuándo se cuentan los días de una actividad sin fecha de entrega.
   *
   * Es la fecha de PUBLICACIÓN, no la de creación: el docente que carga el domingo una
   * actividad programada para el martes tiene que estrenar sus 15 días el martes, no el
   * domingo. `availableFrom` es exactamente eso (ver visibilidadActividad.js) y solo se
   * cae a `createdAt` para los documentos viejos que no llevan el campo.
   */
  function publicadaEl(act) {
    if (!act) return null;
    var base = act.availableFrom || act.createdAt;
    return base ? ms(base) : null;
  }

  /**
   * Momento exacto en que la actividad deja de contarle al alumno como pendiente.
   *
   * @returns {Date|null} null = no caduca nunca (no debería pasar hoy, pero un documento
   *          sin fecha de entrega NI fecha de publicación no tiene desde dónde contar y
   *          se lo deja pendiente antes que hacerlo desaparecer por una fecha inventada).
   */
  function caducaEl(act) {
    if (!act) return null;
    if (!act.dueDate) {
      var pub = publicadaEl(act);
      return pub == null ? null : new Date(pub + DIAS_SIN_FECHA * UN_DIA);
    }
    // Con fecha de entrega el corte es el vencimiento, más la gracia SOLO si el docente
    // dejó las tardías abiertas. Sin tardías el corte es el vencimiento pelado, que es
    // lo que ya hacía el filtro viejo.
    var vence = ms(act.dueDate);
    return new Date(act.allowLateSubmissions ? vence + DIAS_TARDIAS * UN_DIA : vence);
  }

  /** ¿Le sigue contando al alumno como tarea pendiente? */
  function sigueSiendoPendiente(act, ahora) {
    var corte = caducaEl(act);
    if (corte === null) return true;
    return ahoraMs(ahora) < corte.getTime();
  }

  /**
   * Comparador para ordenar la lista de pendientes: lo que tiene fecha primero, de lo más
   * urgente a lo más lejano, y las SIN fecha al final.
   *
   * Existe porque en Mongo el `null` ordena ANTES que cualquier fecha: `sort({ dueDate: 1 })`
   * arrancaba la lista con las que no tienen plazo y empujaba para abajo lo que vence mañana,
   * que es exactamente al revés de para qué se abre la pantalla. El orden se decide acá, en
   * JS, después de filtrar.
   *
   * Ojo con la tentación de ordenar por caducaEl(): la sin fecha publicada hace 14 días
   * caduca mañana y se treparía al primer puesto, arriba de una tarea que vence mañana. La
   * caducidad es tarea de la lista, no un plazo que el alumno tenga que atender.
   *
   * Entre las sin fecha manda la publicación: la más vieja va primero porque es la que está
   * más cerca de irse de la lista.
   */
  function porUrgencia(a, b) {
    var da = a && a.dueDate, db = b && b.dueDate;
    if (da && db) return ms(da) - ms(db);
    if (da) return -1;
    if (db) return 1;
    return (publicadaEl(a) || 0) - (publicadaEl(b) || 0);
  }

  return {
    DIAS_SIN_FECHA: DIAS_SIN_FECHA,
    DIAS_TARDIAS: DIAS_TARDIAS,
    publicadaEl: publicadaEl,
    caducaEl: caducaEl,
    sigueSiendoPendiente: sigueSiendoPendiente,
    porUrgencia: porUrgencia,
  };
});
