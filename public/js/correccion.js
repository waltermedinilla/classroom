// Lógica pura del Modo Corrector — ver specs/correccion-de-entregas.spec.md.
//
// Quinto hermano de devoluciones.js, edicionEntrega.js, estadoActividad.js y
// visibilidadActividad.js, y por el mismo motivo que todos ellos: la misma decisión hace
// falta en el navegador Y en el servidor, y no puede divergir entre los dos. Acá los
// consumidores son cuatro:
//
//   1. views/course.ejs lo carga como <script>, ANTES que edicionEntrega.js — que desde
//      RN-26 le pregunta si la nota está devuelta— y antes que course.js;
//   2. routes/activities.js lo hace require() para decidir qué ve el alumno (RN-24) y qué
//      escribe POST /:id/grade (RN-22);
//   3. los tests (tests/unit/correccion.test.js, returnedAtDefault.test.js,
//      formatoRechazado.test.js);
//   4. routes/diagnostico.js, para el recorte de la extensión que se loguea (RN-47).
//
// ⭐ Lo más caro de todo el archivo es `estaDevuelta`, y conviene leerlo antes de tocar
// cualquier otra cosa: `returnedAt` tiene TRES valores y AUSENTE ≠ NULL. Es la misma red de
// seguridad que `keepFiles` en specs/edicion-de-la-entrega.spec.md.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Correccion = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // Adjuntos.esImagen() es la regla compartida de "esto es una imagen" y NO se reimplementa
  // acá (RN-05c). Se resuelve en el momento de usarla y no al cargar el archivo: en
  // course.ejs este módulo va ANTES que adjuntosActividad.js —el orden lo manda RN-26, que
  // necesita correccion.js antes que edicionEntrega.js— así que al evaluarse esta línea
  // window.Adjuntos todavía no existe.
  var AdjuntosNode = (typeof window !== 'undefined') ? null : require('./adjuntosActividad.js');
  function adjuntos() {
    return AdjuntosNode || (typeof window !== 'undefined' ? window.Adjuntos : null);
  }

  // ── Los topes del visor (RN-41) ──────────────────────────────────────────────
  //
  // Los tres salen de lo MEDIDO sobre los 14 planos reales de producción, y el segundo se
  // DERIVA del primero: un DXF pesa del orden de 5 veces su DWG (2,5× a 5,8× medido), así
  // que 1,5 MB de entrada × 5,8 = 8,7 MB < 10 MB de dibujo. Si se mueve el tope de dibujo
  // hay que recalcular el de entrada con la misma división: si no, aparece el caso "pasó el
  // filtro de entrada y el resultado no se puede dibujar".
  var MB = 1024 * 1024;
  var TOPES = {
    dibujarDxf:    10 * MB,    // ~18× el mayor derivado real (568 KB)
    entradaDwg:    1.5 * MB,   // ~12× el mayor .dwg real (120 KB), y 1,5 × 5,8 < 10
    convertirOffice: 15 * MB,  // RN-16
  };

  // Los OCHO motivos de RN-20, con su texto. El texto sale de acá y no del HTML para que el
  // cartel de la pantalla y el mensaje de la API digan lo mismo porque SON lo mismo — igual
  // que TEXTOS en edicionEntrega.js.
  var MOTIVOS = {
    formato_sin_visor:  'Este tipo de archivo no se puede ver acá. Descargalo para abrirlo con la app correspondiente.',
    office_no_cargo:    'El visor de Microsoft no respondió. Probamos convertirlo…',
    sin_conversor:      'El servidor no tiene instalado el conversor de documentos, así que este archivo solo se puede descargar.',
    sin_conversor_cad:  'El servidor no tiene instalado el conversor de planos, así que este .dwg solo se puede descargar.',
    archivo_muy_grande: 'El archivo pesa N MB y el visor admite hasta M. Descargalo para abrirlo.',
    conversion_fallida: 'No se pudo convertir el archivo para verlo acá (puede estar dañado o protegido con contraseña).',
    plano_muy_grande:   'El plano pesa N MB y el visor admite hasta M. Descargalo y abrilo con AutoCAD.',
    archivo_no_esta:    'El archivo no está en el servidor. Avisale al alumno que lo vuelva a subir.',
    // ⚠️ Noveno motivo, y NO sale de renderVisor: los ocho de arriba se deciden mirando el
    // archivo, y este se descubre recién al intentar dibujar, porque depende de la MÁQUINA
    // del docente y no de la entrega. Por eso no entra en la lista cerrada de RN-20 ni en
    // MOTIVOS_VALIDOS del test.
    //
    // Existe porque sin él este caso caía en `conversion_fallida`, que dice "puede estar
    // dañado o protegido con contraseña": le echaba la culpa al archivo del alumno cuando el
    // problema es que la computadora no tiene aceleración gráfica. En una netbook vieja de la
    // escuela eso manda al docente a pedirle al alumno que suba de nuevo un archivo que está
    // perfecto. El texto nombra la causa real y la salida, como el de la nota mínima.
    sin_webgl:          'Esta computadora no puede dibujar planos en el navegador (le falta aceleración gráfica). El archivo está bien: descargalo y abrilo con AutoCAD.',
  };

  var EXT_OFFICE = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

  function extensionDe(nombre) {
    var m = String(nombre || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function mb(bytes) {
    return Math.round((bytes / MB) * 10) / 10;
  }

  /**
   * Texto de un motivo, con los tamaños puestos cuando el motivo los nombra.
   * @param {string} motivo   uno de los ocho de RN-20
   * @param {object} datos    { bytes, tope } en bytes, opcionales
   */
  function textoDeMotivo(motivo, datos) {
    var base = MOTIVOS[motivo] || '';
    var d = datos || {};
    if (d.bytes != null) base = base.replace('N MB', mb(d.bytes) + ' MB');
    if (d.tope  != null) base = base.replace('hasta M', 'hasta ' + mb(d.tope) + ' MB');
    return base;
  }

  // ── RN-21 — los tres valores de returnedAt ──────────────────────────────────

  /**
   * ¿El alumno puede ver esta corrección?
   *
   *   ausente (undefined) → la nota es ANTERIOR a esta feature: está DEVUELTA. El alumno la
   *                         viene viendo desde el día que se la pusieron y no puede dejar de
   *                         verla porque nosotros estrenemos un campo.
   *   null                → BORRADOR. El docente la guardó y todavía no la devolvió.
   *   Date                → devuelta, y cuándo.
   *
   * ⚠️ Por eso `returnedAt` NO lleva `default` en models/Activity.js (RN-22): con
   * `default: null`, el próximo findById() materializa null en las miles de notas ya
   * cargadas y TODAS las notas de la escuela desaparecen de la vista del alumno — el día del
   * deploy y otra vez el día que alguien restaure un backup anterior a la feature.
   */
  function estaDevuelta(grade) {
    if (!grade) return false;
    if (grade.returnedAt === undefined) return true;
    return grade.returnedAt !== null;
  }

  /**
   * ¿Hay algo para devolver? (RN-27) Gobierna el botón y la ruta: el alumno sin nada no es un
   * error, queda en `omitidas[]`.
   *
   * Una devolución escrita SIN nota sí se puede devolver, y es a propósito: en el aula esa
   * devolución es casi siempre el pedido de rehacer ("rehacé el punto 3"), que es justo lo
   * que el alumno tiene que poder leer.
   */
  function puedeDevolver(grade) {
    if (!grade) return false;
    if (grade.points != null) return true;
    return String(grade.feedback || '').trim() !== '';
  }

  // ── RN-11 — el estado de una entrega ────────────────────────────────────────

  /**
   * El único origen de los chips, del filtro y del color del ítem en la lista de alumnos.
   * @param {object} o  { sub, grade }  la entrega y el grade DE ESE alumno (null si no hay)
   * @returns {'sin_entregar'|'entregado_sin_calificar'|'borrador'|'devuelto'}
   */
  function estadoDeEntrega(o) {
    var op = o || {};
    if (!op.sub) return 'sin_entregar';
    if (!op.grade || op.grade.points == null) return 'entregado_sin_calificar';
    return estaDevuelta(op.grade) ? 'devuelto' : 'borrador';
  }

  // El filtro de la planilla habla de "calificado" (borrador Y devuelta, RN-11); los otros
  // tres chips se llaman igual que el estado.
  function cumpleFiltro(estado, filtro) {
    if (!filtro || filtro === 'todos') return true;
    if (filtro === 'calificado') return estado === 'borrador' || estado === 'devuelto';
    return estado === filtro;
  }

  /**
   * El array que recorren las flechas ‹ › (RN-09). Es PURA y se llama UNA vez, al entrar al
   * Modo Corrector: el llamador se queda con lo que devuelve.
   *
   * Congelar el orden es lo que impide que calificar al alumno #7 lo expulse de la lista
   * —porque dejó de cumplir el filtro— y la flecha › salte a cualquier lado. Por eso acá no
   * se guarda ninguna referencia que se re-evalúe sola: lo devuelto es un array nuevo, en el
   * orden de la planilla filtrada, nunca alfabético por su cuenta.
   */
  function ordenCorreccion(alumnos, filtro) {
    var lista = Array.isArray(alumnos) ? alumnos : [];
    return lista.filter(function (a) {
      return cumpleFiltro(estadoDeEntrega(a), filtro);
    });
  }

  // ── RN-05 / RN-20 / RN-41 — qué visor, y si no hay, por qué ─────────────────

  /**
   * Decide QUÉ se muestra de un archivo. Pura, sin DOM: la comparten las dos monturas —el
   * overlay a pantalla completa de siempre y el panel del corrector—, porque un archivo no
   * puede previsualizarse de una manera en una y de otra en la otra (RN-05).
   *
   * @param {object} att        { name, size } — size en bytes
   * @param {object} opciones   todas opcionales, y el default es "todavía no hay nada listo":
   *   archivoEnDisco              (true)  el documento lo nombra y el disco lo tiene
   *   conversionOfficeDisponible  (false) hay soffice en el servidor (RN-16)
   *   conversionCadDisponible     (false) hay ODA File Converter (RN-42c)
   *   pdfDerivadoListo            (false) el PDF ya está cacheado (RN-16c)
   *   dxfDerivadoListo            (false) el DXF derivado ya está cacheado (RN-42d)
   *   fallo                       motivo ya conocido por el llamador (el iframe de Microsoft
   *                               que no cargó, la conversión que falló)
   * @returns {{tipo: string, motivo: string|null, texto: string, acciones: Array}}
   *
   * `acciones` SIEMPRE trae { tipo: 'descargar' } (RN-19: falle lo que falle, el archivo del
   * alumno se puede bajar). Trae { tipo: 'enlace-firmado' } solo cuando hace falta el paso 1
   * de Office: una imagen, un PDF, un DXF o un derivado ya cacheado NUNCA lo necesitan,
   * porque los dibuja el navegador del docente, que ya tiene la cookie (RN-15).
   */
  function renderVisor(att, opciones) {
    var a   = att || {};
    var op  = opciones || {};
    var ext = extensionDe(a.name);
    var size = Number(a.size) || 0;
    var acciones = [{ tipo: 'descargar' }];

    function resultado(tipo, motivo, datos) {
      return {
        tipo:     tipo,
        motivo:   motivo || null,
        texto:    motivo ? textoDeMotivo(motivo, datos) : '',
        acciones: acciones,
      };
    }

    // El archivo que el documento nombra y el disco no tiene: se contesta con su motivo y no
    // con un spinner girando para siempre (CA-24).
    if (op.archivoEnDisco === false) return resultado('ninguno', 'archivo_no_esta');
    // Un fallo que el llamador ya conoce (el iframe que no cargó, la conversión que murió)
    // entra por la misma puerta, para que el texto salga del mismo lugar.
    if (op.fallo) return resultado('ninguno', op.fallo);

    var Adj = adjuntos();
    if (Adj && Adj.esImagen(a.name)) return resultado('imagen', null);
    if (ext === '.pdf') return resultado('pdf', null);

    // CAD — el dibujo pasa entero en el navegador (RN-39). El .dxf va directo; el .dwg
    // necesita que el servidor produzca su derivado antes (RN-42a).
    if (ext === '.dxf') {
      if (size > TOPES.dibujarDxf) {
        return resultado('ninguno', 'plano_muy_grande', { bytes: size, tope: TOPES.dibujarDxf });
      }
      return resultado('cad', null);
    }
    if (ext === '.dwg') {
      if (op.dxfDerivadoListo) return resultado('cad', null);
      // El tope de ENTRADA rebota ANTES de mandar nada a convertir (CA-61).
      if (size > TOPES.entradaDwg) {
        return resultado('ninguno', 'archivo_muy_grande', { bytes: size, tope: TOPES.entradaDwg });
      }
      if (!op.conversionCadDisponible) return resultado('ninguno', 'sin_conversor_cad');
      return resultado('cad-convertir', null);
    }

    // Office — la cadena de RN-13, en orden.
    if (EXT_OFFICE.indexOf(ext) !== -1) {
      // Paso 0.5: si el PDF derivado ya está, se usa DIRECTO. Más rápido que el viaje a
      // Microsoft y sin emitir ningún enlace firmado (RN-16c).
      if (op.pdfDerivadoListo) return resultado('pdf-derivado', null);
      if (size > TOPES.convertirOffice) {
        return resultado('ninguno', 'archivo_muy_grande', { bytes: size, tope: TOPES.convertirOffice });
      }
      if (!op.conversionOfficeDisponible) return resultado('ninguno', 'sin_conversor');
      // Paso 1: Microsoft descarga el archivo desde SUS servidores, sin nuestra cookie — de
      // ahí el enlace firmado (RN-12/RN-15).
      acciones.push({ tipo: 'enlace-firmado' });
      return resultado('office', null);
    }

    return resultado('ninguno', 'formato_sin_visor');
  }

  // ── RN-47 — la extensión que se loguea, recortada ───────────────────────────

  /**
   * La extensión SOLA, nunca el nombre del archivo (RN-46: los alumnos nombran la entrega con
   * su propio nombre, y eso es un dato personal que no aporta nada a la pregunta "qué formato
   * le falta a la escuela").
   *
   * El recorte no es prolijidad: la extensión la escribe el cliente, así que un nombre con
   * una "extensión" de 2.000 caracteres inundaría logs/combined.log, que NO rota. Tres
   * resultados posibles y ninguno más: una extensión sana, '(invalida)' o '(sin_ext)'.
   */
  function extensionParaLog(nombre) {
    var m = String(nombre == null ? '' : nombre).toLowerCase().match(/\.([^.\\/]{1,10})$/);
    if (!m) return '(sin_ext)';
    return /^[a-z0-9]{1,10}$/.test(m[1]) ? '.' + m[1] : '(invalida)';
  }

  return {
    MOTIVOS: MOTIVOS,
    TOPES: TOPES,
    EXT_OFFICE: EXT_OFFICE,
    extensionDe: extensionDe,
    textoDeMotivo: textoDeMotivo,
    estaDevuelta: estaDevuelta,
    puedeDevolver: puedeDevolver,
    estadoDeEntrega: estadoDeEntrega,
    ordenCorreccion: ordenCorreccion,
    renderVisor: renderVisor,
    extensionParaLog: extensionParaLog,
  };
});
