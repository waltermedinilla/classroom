// Reglas compartidas sobre los adjuntos de una actividad — ver specs/actividad-imagenes.spec.md
//
// Mismo patrón que public/js/visibilidadActividad.js: la decisión hace falta en tres lados y
// no puede divergir entre ellos.
//   1) el navegador, para saber a cuál de las dos rutas de subida mandar cada archivo y para
//      dibujar la miniatura en vez del cuadradito con la extensión;
//   2) el servidor, para no aceptar como adjunto cualquier URL que le manden;
//   3) los tests → tests/unit/adjuntosActividad.test.js.
//
// Ojo con EXT_IMAGEN: la lista AUTORIZADA vive en config/imagePresets.js (`EXT_IMAGENES`), que
// es la que usa el fileFilter de multer y por lo tanto la que decide de verdad. Esta copia
// existe solo porque el navegador no puede hacer require() de config/. El test unitario
// compara las dos y falla si alguien toca una sola: sin eso, el síntoma sería que el navegador
// deja elegir un archivo que el servidor rechaza (o al revés) y nadie se entera hasta que una
// docente no puede subir su foto.

(function (raiz, definir) {
  var api = definir();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Adjuntos = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {

  var EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'];

  // Extensión en minúsculas y con el punto, o '' si el nombre no tiene ninguna.
  // Se mira SIEMPRE el último punto: "consigna.pdf.exe" es un .exe, no un .pdf.
  function extensionDe(nombre) {
    var n = String(nombre == null ? '' : nombre);
    var i = n.lastIndexOf('.');
    return i <= 0 ? '' : n.slice(i).toLowerCase();
  }

  // ¿Este adjunto se muestra como imagen? Decide la extensión del nombre y nada más: el
  // servidor ya validó el contenido con sharp al subirlo, y el mime que llega del navegador
  // no es confiable (un .heic de iPhone suele llegar con mime vacío).
  function esImagen(nombre) {
    return EXT_IMAGEN.indexOf(extensionDe(nombre)) !== -1;
  }

  // ¿Esta URL es un adjunto NUESTRO, servido desde public/archivos?
  //
  // Es la guarda de `uploadedFiles` en POST /activities/create: ese campo es un JSON que arma
  // el navegador, así que su contenido es lo que quiera mandar quien llame a la ruta, no lo
  // que subió. Sin esto un docente podía guardar como "archivo" de la actividad cualquier URL
  // —incluida una `javascript:`— y quien la veía era el alumno.
  //
  // Los `..` se rechazan aparte del prefijo, y no es paranoia de más: al borrar la actividad
  // la ruta hace path.join(ARCHIVOS_BASE, url.replace('/archivos/', '')) para limpiar el
  // disco. Un "/archivos/../../algo" pasaría el prefijo y saldría de la carpeta.
  function esUrlDeAdjunto(url) {
    var u = String(url == null ? '' : url);
    if (u.indexOf('/archivos/') !== 0) return false;   // ancla al principio: nada de "//evil/archivos/"
    if (u.indexOf('..') !== -1) return false;
    if (u.indexOf('\\') !== -1) return false;          // separador de Windows: path.join lo respeta
    return u.length > '/archivos/'.length;
  }

  // Escapa un texto para insertarlo con innerHTML. Vive acá —y no suelto en course.js— para
  // poder testearlo: `node --test` no puede cargar course.js, que toca el DOM al importarse.
  //
  // Lo que arregla: el NOMBRE del adjunto se pintaba crudo (`${a.name}`) en la lista que ve el
  // alumno. El nombre lo elige quien sube el archivo, así que un archivo llamado
  // `<img src=x onerror=…>.pdf` era un script guardado en la base que se ejecutaba en la
  // pantalla de cada alumno del curso. Nótese que `escAtt()` de course.js NO alcanza: escapa
  // comillas para atributos, no `<`.
  function escaparTexto(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    EXT_IMAGEN: EXT_IMAGEN,
    extensionDe: extensionDe,
    esImagen: esImagen,
    esUrlDeAdjunto: esUrlDeAdjunto,
    escaparTexto: escaparTexto,
  };
});
