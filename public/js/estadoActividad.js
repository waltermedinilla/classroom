// Regla ÚNICA de "¿en qué estado está esta actividad PARA ESTE ALUMNO?".
// Ver specs/entrega-sale-de-pendientes.spec.md.
//
// Vive en public/js por el mismo motivo que sus hermanas visibilidadActividad.js y
// pendienteActividad.js: la misma decisión hace falta en más de un lugar y no puede
// divergir entre ellos. Acá los consumidores son dos, los dos en la pantalla de la
// materia (public/js/course.js):
//
//   1. el chip de la tarjeta en la solapa Actividades;
//   2. la lista "Próximas entregas" de la barra lateral de Novedades.
//
// QUÉ RESUELVE (pedido del usuario, 2026-08-24): al alumno que ya había entregado le
// seguía figurando "Pendiente" en la tarjeta y la tarea seguía apareciendo en "Próximas
// entregas" hasta que venciera el plazo. O sea: lo que ya hizo se le mezclaba con lo
// que le falta hacer, que es justo lo que esas dos pantallas tienen que separar.
//
// La causa era que el servidor no le mandaba el dato: GET /activities/course/:id le
// devolvía al alumno su nota (`myGrade`) pero nada sobre su propia entrega, así que el
// navegador no tenía con qué distinguir "todavía la tengo que hacer" de "ya la entregué".
// Ahora llega `mySubmission` y esta función lo usa.
//
// OJO CON EL ALCANCE: esto decide cómo se MUESTRA la actividad, no si el alumno puede
// entregar (eso lo sigue mandando `allowLateSubmissions` en POST /activities/:id/submit)
// ni si le cuenta como pendiente en el cartel del inicio y en "Mis pendientes" — esa es
// pendienteActividad.js, que ya descontaba las entregadas por su lado desde siempre.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.EstadoActividad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // El chip completo, no solo su nombre: la etiqueta, el ícono y la clase CSS viven acá
  // para que el test pueda preguntarle a la regla qué se ve, y no haya que leerlo del HTML
  // que arma course.js.
  var ESTADOS = {
    calificada: { clave: 'calificada', etiqueta: 'Calificada', icono: 'grade',        css: 'status-graded'    },
    entregada:  { clave: 'entregada',  etiqueta: 'Entregada',  icono: 'check_circle', css: 'status-submitted' },
    vencida:    { clave: 'vencida',    etiqueta: 'Vencida',    icono: 'lock',         css: 'status-overdue'   },
    tardia:     { clave: 'tardia',     etiqueta: 'Tardía',     icono: 'lock_open',    css: 'status-late-open' },
    pendiente:  { clave: 'pendiente',  etiqueta: 'Pendiente',  icono: '',             css: 'status-pending'   },
  };

  /** ¿El alumno ya entregó esta actividad? `mySubmission` lo pone el servidor. */
  function yaEntregada(act) {
    return !!(act && act.mySubmission);
  }

  /**
   * Estado del alumno para la tarjeta de la solapa Actividades.
   *
   * El orden de las preguntas ES la regla:
   *
   *   calificada > entregada > vencida > tardía > pendiente
   *
   * "Entregada" va ARRIBA de vencida y de tardía a propósito: si ya entregué, que la
   * fecha haya pasado es un dato del plazo, no de mi estado — el que entregó no tiene
   * nada más que hacer y no le tiene que figurar un candado. "Calificada" le sigue
   * ganando a todo porque es el final del camino, e incluso se puede llegar a ella sin
   * entrega (el docente que corrige en papel y carga la nota a mano).
   *
   * @param {object} act    actividad como la manda GET /activities/course/:id al alumno
   * @param {Date}   ahora  opcional, para los tests
   */
  function estadoParaAlumno(act, ahora) {
    var hoy = ahora || new Date();
    // Con points null hay devolución escrita pero todavía no hay nota: no es "Calificada".
    // Ver public/js/devoluciones.js y la memoria de devoluciones del docente.
    if (act && act.myGrade && act.myGrade.points != null) return ESTADOS.calificada;
    if (yaEntregada(act)) return ESTADOS.entregada;

    var vencida = act && act.dueDate && new Date(act.dueDate) < hoy;
    if (vencida) return act.allowLateSubmissions ? ESTADOS.tardia : ESTADOS.vencida;
    return ESTADOS.pendiente;
  }

  /**
   * ¿Va en "Próximas entregas"? Lo que todavía tengo que hacer y tiene fecha por delante.
   *
   * La visibilidad (actividad programada) NO se pregunta acá: de eso se ocupa
   * visibilidadActividad.js, que course.js aplica antes. Una regla, un archivo.
   */
  function esProximaEntrega(act, ahora) {
    if (!act || !act.dueDate) return false;
    if (yaEntregada(act)) return false;
    return new Date(act.dueDate) > (ahora || new Date());
  }

  return {
    ESTADOS: ESTADOS,
    yaEntregada: yaEntregada,
    estadoParaAlumno: estadoParaAlumno,
    esProximaEntrega: esProximaEntrega,
  };
});
