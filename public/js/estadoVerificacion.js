// Regla ÚNICA de "¿este contacto está verificado?" — ver specs/verificacion-de-contacto.spec.md
//
// Está en public/js y no en services/ por el mismo motivo que visibilidadActividad.js: la misma
// decisión hace falta en tres lados y no puede divergir entre ellos.
//   1) el servidor, para pintar el chip en las vistas EJS y para armar los contadores de
//      cobertura → los routers y el partial hacen require() de este archivo;
//   2) el navegador, para refrescar el chip al terminar de verificar SIN recargar la página
//      → views/profile.ejs lo carga como <script> y queda en window.EstadoVerificacion;
//   3) los tests → tests/unit/estadoVerificacion.test.js.
//
// El proyecto ya aprendió de la peor manera qué pasa cuando una regla se repite por pantalla:
// los formatos de archivo viven en 9 lugares y las subidas de imagen en 6 caminos. Acá el chip
// va en 9 pantallas, así que la regla vive UNA vez.
//
// El estado sale de dos campos de User por canal:
//   <canal>VerifiedAt   → fecha de verificación. null = no verificado. LA FECHA ES EL DATO:
//                         "verificado hace 8 meses" no es lo mismo que "verificado ayer", y un
//                         booleano no se puede mostrar en la auditoría ni en una línea de tiempo.
//   <canal>VerifiedVia  → CÓMO se verificó. Es lo que separa "le llegó un código y lo puso" de
//                         "el preceptor lo confirmó por teléfono", y por eso el chip dice
//                         "Verificado por la escuela" y no "Verificado" a secas. Ver D6.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.EstadoVerificacion = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  var VERIFICADO = 'verificado';  // hay dato y está confirmado
  var PENDIENTE  = 'pendiente';   // hay dato cargado y nadie lo confirmó
  var SIN_DATO   = 'sin-dato';    // no hay ni correo ni celular cargado

  // Los dos canales, y de qué campos de User sale cada uno. Una sola tabla: agregar un canal
  // (si algún día hay uno) es agregar una línea acá, no tocar nueve vistas.
  var CANALES = {
    email: {
      label:      'Correo electrónico',
      corto:      'correo',
      campoDato:  'email',
      campoAt:    'emailVerifiedAt',
      campoVia:   'emailVerifiedVia',
    },
    celular: {
      label:      'Celular',
      corto:      'celular',
      campoDato:  'phone',
      campoAt:    'phoneVerifiedAt',
      campoVia:   'phoneVerifiedVia',
    },
  };

  // Cómo se llama cada vía en pantalla. 'staff' es el único que cambia el TEXTO del chip, y es
  // a propósito: quien lee la pantalla tiene que poder distinguir qué evidencia hay detrás sin
  // abrir la auditoría. Ver D6 de la spec — es lo que hace honesta a la verificación asistida.
  var TEXTO_POR_VIA = {
    enlace:      'Verificado',
    codigo:      'Verificado',
    staff:       'Verificado por la escuela',
    importacion: 'Verificado',
  };

  function esCanalValido(canal) {
    return Object.prototype.hasOwnProperty.call(CANALES, canal);
  }

  // Los campos de User que necesita estadoContacto(), listos para pegar en un .select() de
  // Mongoose.
  //
  // ⚠️ EXISTE PORQUE EL MODO DE FALLA ES SILENCIOSO. Una ruta que arma su .select() a mano y
  // se olvida de estos campos no da ningún error: simplemente le pasa a la vista un usuario
  // sin `emailVerifiedAt`, y el chip —que no puede distinguir "no vino en el select" de "no
  // está verificado"— dice "Sin verificar" para TODO EL MUNDO. Es la misma clase de bug que
  // el backup al que le faltaban 14 colecciones: anda perfecto y miente.
  //
  // Uso:  .select('_id name email ' + CAMPOS_SELECT)
  var CAMPOS_SELECT = 'email emailVerifiedAt emailVerifiedVia phone phoneE164 phoneVerifiedAt phoneVerifiedVia';

  /**
   * El estado de un contacto de una persona.
   *
   * @param {object} persona  un User (documento de Mongoose, .lean() o el JSON de una API)
   * @param {string} canal    'email' | 'celular'
   * @returns {{estado, canal, label, dato, via, desde, texto, icono, tono}}
   *
   * `tono` es 'ok' | 'neutro' — NO un color. El color lo decide la vista con las variables del
   * tema: un hex acá terminaría en un `style=` inline, que le gana a la variante oscura y deja
   * texto invisible. Es exactamente el bug de 1,10:1 que ya pasó en la sala en vivo.
   */
  function estadoContacto(persona, canal) {
    if (!esCanalValido(canal)) throw new Error('estadoContacto: canal desconocido "' + canal + '"');
    var def = CANALES[canal];
    var p   = persona || {};

    var dato = p[def.campoDato] || null;
    if (!dato) {
      return {
        estado: SIN_DATO, canal: canal, label: def.label, dato: null, via: null, desde: null,
        texto: 'Sin ' + def.corto, icono: 'remove', tono: 'neutro',
      };
    }

    var desde = p[def.campoAt] || null;
    if (!desde) {
      return {
        estado: PENDIENTE, canal: canal, label: def.label, dato: dato, via: null, desde: null,
        texto: 'Sin verificar', icono: 'gpp_maybe', tono: 'neutro',
      };
    }

    var via = p[def.campoVia] || null;
    return {
      estado: VERIFICADO, canal: canal, label: def.label, dato: dato, via: via,
      desde: desde instanceof Date ? desde : new Date(desde),
      texto: TEXTO_POR_VIA[via] || 'Verificado',
      icono: 'verified',
      tono:  'ok',
    };
  }

  // Atajo para las plantillas y los filtros: ¿está verificado?
  function estaVerificado(persona, canal) {
    return estadoContacto(persona, canal).estado === VERIFICADO;
  }

  // Filtro de Mongo para "los que NO tienen verificado este canal", que es la lista que le
  // interesa a quien administra: a quiénes hay que ir a buscar. Incluye tanto al que no cargó
  // el dato como al que lo cargó y no lo confirmó — para la escuela son el mismo problema
  // ("no le puedo escribir"), y separarlos en dos filtros no le sirve a nadie.
  function filtroSinVerificar(canal) {
    if (!esCanalValido(canal)) throw new Error('filtroSinVerificar: canal desconocido "' + canal + '"');
    var filtro = {};
    filtro[CANALES[canal].campoAt] = null;
    return filtro;
  }

  // Filtro inverso, para contar la cobertura.
  function filtroVerificado(canal) {
    if (!esCanalValido(canal)) throw new Error('filtroVerificado: canal desconocido "' + canal + '"');
    var filtro = {};
    filtro[CANALES[canal].campoAt] = { $ne: null };
    return filtro;
  }

  return {
    VERIFICADO: VERIFICADO, PENDIENTE: PENDIENTE, SIN_DATO: SIN_DATO,
    CANALES: CANALES,
    CAMPOS_SELECT: CAMPOS_SELECT,
    esCanalValido: esCanalValido,
    estadoContacto: estadoContacto,
    estaVerificado: estaVerificado,
    filtroSinVerificar: filtroSinVerificar,
    filtroVerificado: filtroVerificado,
  };
});
