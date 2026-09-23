// Cómo se muestra la presencia de la sala en vivo, y cuándo late el alumno que salió de ella.
// Ver specs/sala-presencia-en-actividad.spec.md.
//
// QUÉ RESUELVE (reclamo del usuario, 2026-09-23): el alumno que se va de la sala a hacer la
// actividad que planteó la docente figuraba "sin conectarse", con el mismo gris que el que
// nunca entró. Estuvo; se fue a trabajar. Son cuatro estados, no dos:
//
//   en la sala · en la actividad · estuvo · no entró
//
// Vive acá y no adentro del <script> de views/partials/live-room.ejs por lo mismo que
// salaSonido.js y salaPoll.js: adentro del .ejs no se puede probar. Y los TEXTOS viven acá por
// la lección del 11/09 (asistencia_preceptoria): un literal escrito a mano en el partial vuelve
// vacuo al test que afirma lo contrario.
//
// Lo carga también el servidor (services/liveRoom.js) por LATIDO_ALUMNO_MS: la ventana de
// escritura del servidor se mide contra este número, y dos copias divergen.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SalaPresencia = api;
})(this, function () {

  // Cada cuánto late el alumno que tiene la materia abierta FUERA de la sala (RN-4).
  //
  // Un minuto, no los 4 s del poll: el dato que sostiene es "está trabajando en la materia",
  // que se mira con una ventana de 3 minutos, y no el "N de M presentes" que se mira segundo a
  // segundo. Cuesta un pedido por minuto por alumno, contra 7,5–15 que hace cada uno adentro.
  var LATIDO_ALUMNO_MS = 60 * 1000;

  var ETIQUETAS = {
    enActividad: 'trabajando en la materia',
    estuvo:      'estuvo',
    seRetiro:    'se retiró a las ',
    noEntro:     'no entró a la clase',
  };

  // El cartel de arriba de la sala.
  //
  // `presentes` sigue siendo "en la sala ahora" (D3): es el número que se mira segundo a
  // segundo, y no se infla con los que se fueron. El segundo número aparece SOLO cuando alguien
  // se fue: con la clase entera adentro son la misma cifra y decirla dos veces es ruido.
  function cartel(p) {
    var presentes  = (p && p.presentes) || 0;
    var total      = (p && p.total) || 0;
    var asistieron = p && typeof p.asistieron === 'number' ? p.asistieron : presentes;
    if (asistieron <= presentes) {
      return 'Sala abierta · ' + presentes + ' de ' + total + ' presentes';
    }
    return 'Sala abierta · ' + presentes + ' en la sala · ' + asistieron + ' de ' + total + ' asistieron';
  }

  // Título (tooltip) del círculo de alguien que NO está en la sala ahora.
  //   titulo(estuvo)             → "Ana · trabajando en la materia" | "Ana · estuvo · se retiró a las 11:29"
  //   titulo(ausente, 'ausente') → "Ana · no entró a la clase"
  function titulo(persona, tipo) {
    var nombre = (persona && persona.nombre) || '—';
    if (tipo === 'ausente') return nombre + ' · ' + ETIQUETAS.noEntro;
    if (persona.enActividad) return nombre + ' · ' + ETIQUETAS.enActividad;
    return nombre + ' · ' + ETIQUETAS.estuvo +
      (persona.seRetiro ? ' · ' + ETIQUETAS.seRetiro + persona.seRetiro : '');
  }

  // ¿Late ahora el navegador de este alumno? (RN-4)
  //
  //   · solo el ALUMNO: el personal ya tiene su latido de 20 s, y el suyo sí lo deja en la sala.
  //   · solo con la sala ABIERTA.
  //   · solo con la sala FUERA DE VISTA: a la vista ya pollea, y ese poll es el que cuenta.
  //   · solo con la pestaña del navegador AL FRENTE (P2): "tiene la materia en una pestaña de
  //     fondo" no es "está trabajando". Ese alumno figura "estuvo", que tampoco es ausente.
  function debeLatir(e) {
    return !!(e && e.alumno && e.abierta && !e.salaALaVista && !e.pestanaOculta);
  }

  return {
    LATIDO_ALUMNO_MS: LATIDO_ALUMNO_MS,
    ETIQUETAS: ETIQUETAS,
    cartel: cartel,
    titulo: titulo,
    debeLatir: debeLatir,
  };
});
