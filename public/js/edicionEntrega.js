// Regla ÚNICA de "¿este alumno puede todavía tocar su entrega?".
// Ver specs/edicion-de-la-entrega.spec.md.
//
// Vive en public/js por el mismo motivo que sus hermanas visibilidadActividad.js,
// estadoActividad.js y pendienteActividad.js: la misma decisión hace falta en más de un
// lugar y no puede divergir entre ellos. Acá los consumidores son CINCO, y antes de este
// módulo la condición estaba escrita a mano en los cinco:
//
//   servidor (routes/activities.js)          navegador (public/js/course.js)
//   1. POST /:id/upload-submission-image     4. renderSubmissionSection() → canEdit
//   2. POST /:id/upload-submission-file      5. renderRunnerSection()     → locked
//   3. POST /:id/submit  (+ DELETE /:id/submission, que nació con el módulo)
//
// QUÉ RESUELVE (pedido del usuario, 2026-09-04): "el alumno cuando quiere entregar un
// trabajo, si por error se equivoca le queda deshabilitado". La condición vieja era
// `existing && !activity.allowResubmission`: alcanzaba con que hubiera una entrega y con
// que el docente no hubiera tildado un checkbox que estaba apagado por defecto y escondido
// abajo de la barra lateral. Medido sobre el espejo local ese día: 1350 de 1852 entregas
// (73%) estaban congeladas sin que ningún docente lo hubiera decidido.
//
// Ahora el flag sigue existiendo —el docente lo destilda para congelar una evaluación— pero
// nace MARCADO, y lo que cierra la puerta es que alguien haya hecho algo: que el docente
// haya corregido, o que se haya acabado el plazo.
//
// OJO CON EL ALCANCE: esto decide si el alumno puede EDITAR una entrega que ya existe. No
// decide si puede entregar por primera vez (eso lo sigue mandando el plazo y nada más), ni
// qué chip se le muestra en la tarjeta (eso es estadoActividad.js, que pregunta otra cosa:
// ver la trampa 3 de la spec).

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.EdicionEntrega = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Los motivos, con el texto que se muestra. El texto sale de acá y no del HTML para que
  // el cartel de la pantalla y el mensaje del 403 digan lo mismo porque SON lo mismo.
  var MOTIVOS = {
    sinEntrega: 'sinEntrega',
    reabierta:  'reabierta',
    vencida:    'vencida',
    corregida:  'corregida',
    congelada:  'congelada',
    editable:   'editable',
  };

  var TEXTOS = {
    vencida:   'El plazo de entrega venció. Solo podés visualizarla.',
    corregida: 'El docente ya te puso nota. Solo podés visualizarla.',
    congelada: 'El docente no permite modificar la entrega una vez enviada. Solo podés visualizarla.',
  };

  // Lo que ve el alumno cuando el docente lo habilitó a rehacerla: no es un motivo de
  // bloqueo, es lo contrario, y por eso vive aparte de TEXTOS.
  var AVISO_REABIERTA = 'El docente te habilitó a rehacer esta entrega.';

  /**
   * ¿El plazo cerró la entrega? Misma condición, carácter por carácter, que la que ya
   * usaban las tres rutas y el `isBlocked` del modal antes de este módulo.
   */
  function estaVencida(act, ahora) {
    if (!act || !act.dueDate) return false;
    if (act.allowLateSubmissions) return false;
    return new Date(act.dueDate) < (ahora || new Date());
  }

  /**
   * ¿El docente ya corrigió ESTA entrega? (decisión D2 de la spec, corregida el 2026-09-04)
   *
   * **La NOTA, y solo la nota.** La primera versión también cerraba con la devolución
   * escrita sin nota, y estaba mal: en la práctica del aula esa devolución es casi siempre
   * el PEDIDO DE REHACER —"rehacé el punto 3"— así que cerrar ahí le traba al alumno
   * exactamente lo que el docente le está pidiendo que haga. Si falta la nota, la corrección
   * todavía no terminó.
   *
   * Lo que NO es una corrección: la AUTOCALIFICACIÓN (`manual: false`). Las actividades con
   * templateSnapshot se autocalifican al enviarlas; sin esta pregunta, el cuestionario
   * quedaría cerrado en el mismo instante en que el alumno lo responde.
   *
   * `manual` es `true` por default en el modelo, así que los grades históricos —que eran
   * todos del docente, no había autocalificador— se leen como manuales, que es lo que eran.
   */
  function esCorregida(grade) {
    if (!grade) return false;
    if (grade.manual === false) return false;
    return grade.points != null;
  }

  /**
   * La pregunta completa. El orden ES la regla:
   *
   *   sin entrega  >  reabierta  >  vencida  >  corregida  >  congelada  >  editable
   *
   * @param {object}  o.act         actividad (documento del servidor u objeto del navegador:
   *                                los dos traen dueDate, allowLateSubmissions, allowResubmission)
   * @param {object}  o.grade       el grade DE ESTE ALUMNO, ya buscado. null = no lo corrigieron
   * @param {boolean} o.hayEntrega  si no hay entrega no hay nada que editar
   * @param {boolean} o.reabierta   el docente lo habilitó a rehacerla (`submission.reopenedAt`)
   * @param {Date}    o.ahora       opcional, para los tests
   * @returns {{puede: boolean, motivo: string, texto: string}}
   */
  function puedeEditar(o) {
    var op  = o || {};
    var act = op.act || {};

    // Sin entrega previa no hay edición que discutir: manda el plazo y nada más, igual que
    // siempre. Que el docente haya cargado una nota a mano (corrigió en papel) no le cierra
    // la primera entrega al alumno — es el comportamiento de hoy y la spec lo deja afuera.
    if (!op.hayEntrega) {
      return estaVencida(act, op.ahora)
        ? { puede: false, motivo: MOTIVOS.vencida,    texto: TEXTOS.vencida }
        : { puede: true,  motivo: MOTIVOS.sinEntrega, texto: '' };
    }

    // La REAPERTURA le gana a todo lo demás, y es a propósito: es una autorización
    // explícita del docente, sobre ESTE alumno, posterior a todo lo otro. Si le apretó
    // "Permitir que lo rehaga", que el plazo o su propia nota se lo impidan sería
    // contestarle que no a algo que acaba de decir que sí. Se apaga sola cuando el docente
    // le vuelve a poner nota.
    if (op.reabierta) {
      return { puede: true, motivo: MOTIVOS.reabierta, texto: AVISO_REABIERTA };
    }

    // Vencida va primero porque es la única de las tres que ya existía: si el plazo cerró,
    // el motivo que el alumno tiene que leer es ese.
    if (estaVencida(act, op.ahora)) {
      return { puede: false, motivo: MOTIVOS.vencida, texto: TEXTOS.vencida };
    }
    if (esCorregida(op.grade)) {
      return { puede: false, motivo: MOTIVOS.corregida, texto: TEXTOS.corregida };
    }
    // === false y no falsy: un documento SIN el campo es de antes de la migración y se lee
    // como marcado, que es todo el punto de la decisión D1.
    if (act.allowResubmission === false) {
      return { puede: false, motivo: MOTIVOS.congelada, texto: TEXTOS.congelada };
    }
    return { puede: true, motivo: MOTIVOS.editable, texto: '' };
  }

  return {
    MOTIVOS: MOTIVOS,
    TEXTOS: TEXTOS,
    AVISO_REABIERTA: AVISO_REABIERTA,
    estaVencida: estaVencida,
    esCorregida: esCorregida,
    puedeEditar: puedeEditar,
  };
});
