// Cache en memoria de actividades: activityId → objeto actividad completo
// Se llena al cargar el tab y al crear una actividad; permite acceso O(1) sin re-fetch
let selectedImage = null;
window._activities = {};

// Mapa de colores por extensión de archivo para los iconos de adjuntos.
// El recuadro lleva el texto en BLANCO, así que un color nuevo tiene que contrastar contra
// blanco: el violeta de los planos da 6,4:1. El gris de fallback es para lo que no está acá.
// DWG y DXF comparten color a propósito: son el mismo plano guardado de dos maneras, y darles
// colores distintos sugeriría una diferencia que a quien mira la tarjeta no le importa.
const EXT_COLOR = { PDF: '#ea4335', DOC: '#1a73e8', DOCX: '#1a73e8', XLS: '#34a853', XLSX: '#34a853', PPT: '#c43e1c', PPTX: '#c43e1c', DWG: '#8430ce', DXF: '#8430ce' };

// Configuración visual por tipo de actividad: etiqueta, ícono Material Symbols, color del thumb
// color=null → usa el color del curso (window.COURSE_COLOR)
const TYPE_CONFIG = {
  tarea:      { label: 'Tarea',            icon: 'assignment', color: null },
  evaluacion: { label: 'Evaluación',       icon: 'quiz',       color: '#f9ab00' },
  tp:         { label: 'Trabajo Práctico', icon: 'science',    color: '#0f9d58' },
};

// Devuelve la config del tipo de actividad (fallback a 'tarea' si el valor es desconocido)
function typeConfig(type) { return TYPE_CONFIG[type] || TYPE_CONFIG.tarea; }

// Devuelve { ext, color } para mostrar el icono del archivo con el color correcto
function extColor(filename) {
  const ext = filename.split('.').pop().toUpperCase();
  return { ext, color: EXT_COLOR[ext] || '#5f6368' }; // Gris por defecto si la ext no está en el mapa
}

// Extrae el dominio de una URL para mostrar como label de un link adjunto
function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

/* ─── Helpers de adjuntos para mostrar ─── */

// Escapa comillas dobles para uso en atributos HTML
function escAtt(s) { return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

function _isPdf(name)    { return /\.pdf$/i.test(name || ''); }
function _isOffice(name) { return /\.(doc|docx|xls|xlsx|ppt|pptx)$/i.test(name || ''); }
// Los planos SÍ tienen visor desde el 2026-09-21 (§ I de specs/correccion-de-entregas.spec.md):
// el .dxf se dibuja directo en el navegador y el .dwg se dibuja vía un .dxf derivado que
// convierte el servidor con ODA. Antes de eso los dos caían al botón Descargar, y el
// comentario de routes/activities.js todavía lo contaba así.
function _isCad(name)    { return /\.(dwg|dxf)$/i.test(name || ''); }
// Delega en la regla compartida (public/js/adjuntosActividad.js) para que el visor a pantalla
// completa y la miniatura de la lista no puedan opinar distinto sobre el mismo archivo.
function _isImage(name)  { return Adjuntos.esImagen(name); }
function _isYoutube(url) { return /youtu\.?be/.test(url || ''); }
function _ytId(url) {
  const m = (url || '').match(/(?:v=|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

// ─── Google Drive / Docs / Sheets / Slides ───
// Devuelve la URL de embed (`/preview`) si el link es de un archivo de Google que se puede
// previsualizar embebido, o '' si no lo es. Al devolver '' el flujo cae en el comportamiento
// de siempre (abrir en pestaña nueva), así que cualquier formato de URL que no reconozcamos
// sigue funcionando exactamente como antes.
//
// Formatos soportados:
//   drive.google.com/file/d/ID/view          → drive.google.com/file/d/ID/preview
//   drive.google.com/open?id=ID              → drive.google.com/file/d/ID/preview
//   docs.google.com/document/d/ID/edit       → docs.google.com/document/d/ID/preview
//   docs.google.com/spreadsheets/d/ID/edit   → .../preview   (idem presentation)
//
// Google Forms queda deliberadamente afuera: el alumno necesita interactuar y completar,
// y embeberlo en un modal es peor experiencia que abrirlo en su propia pestaña.
function _gDriveEmbedUrl(url) {
  const u = url || '';
  if (!/^https?:\/\/(drive|docs)\.google\.com\//i.test(u)) return '';
  if (/\/forms\//i.test(u)) return '';

  // Archivo suelto en Drive (PDF, imagen, video, lo que sea)
  const file = u.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/i);
  if (file) return `https://drive.google.com/file/d/${file[1]}/preview`;

  // Link de compartir viejo: /open?id=...
  const open = u.match(/drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/i);
  if (open) return `https://drive.google.com/file/d/${open[1]}/preview`;

  // Documento nativo de Google (Docs / Sheets / Slides)
  const doc = u.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/i);
  if (doc) return `https://docs.google.com/${doc[1]}/d/${doc[2]}/preview`;

  return '';
}

// Construye el HTML de la lista de adjuntos (archivos y links) de una actividad
// Cada ítem usa data-atributos para pasar los datos al previsualizador al hacer click
function buildAttachmentListHTML(attachments) {
  if (!attachments || attachments.length === 0) return '';
  return attachments.map(a => {
    if (a.type === 'file') {
      const { ext, color } = extColor(a.name);
      // PDF y Office → ícono de vista previa
      const actionIcon = 'visibility';
      // La imagen muestra la imagen: un cuadradito gris que dice "WEBP" no le dice nada a
      // nadie, y la miniatura es lo que permite reconocer de un vistazo cuál de las tres
      // fotos del pizarrón es la que hace falta. `loading="lazy"` porque una actividad puede
      // traer varias y no todas se ven al abrir.
      const icono = Adjuntos.esImagen(a.name)
        ? `<div class="att-item-icon att-item-thumb"><img src="${escAtt(a.url)}" alt="" loading="lazy"></div>`
        : `<div class="att-item-icon" style="background:${color}">${ext}</div>`;
      return `<div class="att-item" style="cursor:pointer"
        data-att-type="file" data-att-name="${escAtt(a.name)}"
        data-att-url="${escAtt(a.url)}" data-att-mime="${a.mime||''}"
        onclick="handleAttachmentClick(this)" role="button" tabindex="0">
        ${icono}
        <span class="att-item-name">${Adjuntos.escaparTexto(a.name)}</span>
        <span class="material-symbols-outlined att-item-open">${actionIcon}</span>
      </div>`;
    }
    // Link
    const domain  = getDomain(a.url);
    const isYt    = _isYoutube(a.url);
    // El ícono anticipa lo que va a pasar al hacer click: reproducir (YouTube), previsualizar
    // dentro del modal (Drive), o abrir en otra pestaña (el resto).
    const linkIcon = isYt ? 'play_circle' : _gDriveEmbedUrl(a.url) ? 'visibility' : 'open_in_new';
    return `<div class="att-item" style="cursor:pointer"
      data-att-type="link" data-att-name="${escAtt(a.name || domain)}"
      data-att-url="${escAtt(a.url)}" data-att-mime=""
      onclick="handleAttachmentClick(this)" role="button" tabindex="0">
      <div class="att-item-icon link-icon">
        <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="20" height="20"
          style="border-radius:3px" onerror="this.outerHTML='<span class=\\'material-symbols-outlined\\' style=\\'font-size:20px;color:var(--primary)\\'>language</span>'">
      </div>
      <span class="att-item-name">${Adjuntos.escaparTexto(a.name || domain)}</span>
      <span class="material-symbols-outlined att-item-open">${linkIcon}</span>
    </div>`;
  }).join('');
}

/* ─── Previsualizador de adjuntos (modal pantalla completa) ─── */

// Recibe el <div class="att-item"> y abre la vista previa según el tipo de archivo
function handleAttachmentClick(el) {
  openAttachmentPreview({
    type: el.dataset.attType,
    name: el.dataset.attName,
    url:  el.dataset.attUrl,
    mime: el.dataset.attMime,
  });
}

/**
 * La cadena de previsualización de documentos de Office (RN-13), montada en `contenedor`:
 *
 *   paso 1 → URL FIRMADA → view.officeapps.live.com
 *        ↓ si tarda más de 8 s, o el iframe no carga
 *   paso 2 → PDF convertido con LibreOffice en el servidor
 *        ↓ si no hay LibreOffice, el archivo es muy grande, o la conversión falla
 *   paso 3 → botón Descargar, con el motivo en pantalla
 *
 * ⭐ EL BUG QUE ESTO ARREGLA, escrito para que no se vuelva a diagnosticar mal: hasta el
 * 2026-09-21 acá se le pasaba a Microsoft la URL pública del archivo, y Microsoft lo DESCARGA
 * desde sus propios servidores, sin nuestra cookie. Como /activities/submission-file/ está
 * detrás de requireAuth —que REDIRIGE a /login—, Microsoft recibía un 302 a una página HTML y
 * mostraba su error genérico: ninguno de los 296 .docx entregados se previsualizaba. Lo que
 * lo mantuvo invisible es que el Office del DOCENTE sí funciona (sus adjuntos viven en
 * /public, que se sirve sin guarda), o sea que funciona justo en el caso que uno prueba
 * primero.
 *
 * Los 8 segundos son un setTimeout y no una lectura del iframe: view.officeapps.live.com es
 * cross-origin, así que NO se puede saber si cargó bien o cargó un error. El disparador es
 * el tiempo, no el contenido.
 */
async function montarVisorOffice(contenedor, att) {
  const url    = att.url  || '';
  const nombre = att.name || '';
  const esEntrega = /^\/activities\/submission-file\//.test(url);
  // Microsoft tiene que poder LLEGAR al archivo. Desde localhost no puede, y ahí el paso 1
  // no es que "falla": no existe. Se va derecho al paso 2, que corre en esta misma máquina.
  const microsoftLlega = !/localhost|127\.0\.0\.1/.test(window.location.hostname);

  const cartel = (texto) => {
    contenedor.innerHTML = `
      <div class="att-preview-no-support">
        <span class="material-symbols-outlined">description</span>
        <p>No se puede mostrar el documento acá</p>
        <p class="att-preview-no-support-sub"></p>
      </div>`;
    contenedor.querySelector('.att-preview-no-support-sub').textContent = texto;
  };
  const esperando = (texto) => {
    contenedor.innerHTML = `
      <div class="att-preview-loading">
        <div class="att-preview-spinner"></div>
        <p></p>
      </div>`;
    contenedor.querySelector('.att-preview-loading p').textContent = texto;
  };

  // ── Paso 2: el PDF que convierte LibreOffice ──────────────────────────────
  // Cada motivo de fallo tiene su texto, y el texto sale del módulo compartido: el cartel de
  // la pantalla y el mensaje de la API dicen lo mismo porque SON lo mismo (RN-20).
  const MOTIVO_POR_STATUS_OFFICE = { 404: 'archivo_no_esta', 413: 'archivo_muy_grande', 422: 'conversion_fallida', 501: 'sin_conversor' };
  async function pasoDos() {
    if (!esEntrega) return cartel(Correccion.MOTIVOS.formato_sin_visor);
    esperando('Convirtiendo el documento…');
    // HEAD: dispara la conversión (o la encuentra cacheada) sin bajar el PDF dos veces.
    const sonda = await fetch(url + '/pdf', { method: 'HEAD' }).catch(() => null);
    if (!sonda || !sonda.ok) {
      if (sonda && sonda.status === 409) return cartel('Estamos preparando la vista previa… Probá de nuevo en unos segundos.');
      const motivo = MOTIVO_POR_STATUS_OFFICE[sonda && sonda.status] || 'conversion_fallida';
      return cartel(Correccion.textoDeMotivo(motivo, { bytes: att.size, tope: 15 * 1024 * 1024 }));
    }
    contenedor.innerHTML = '<iframe class="att-preview-frame"></iframe>';
    contenedor.querySelector('iframe').src = url + '/pdf#toolbar=1';
  }

  // ── Paso 1: Microsoft, con la URL firmada ─────────────────────────────────
  if (!microsoftLlega) return pasoDos();

  let publico = window.location.origin + url;
  if (esEntrega) {
    esperando('Preparando la vista previa…');
    const r = await fetch(url + '/enlace', { method: 'POST' }).catch(() => null);
    // El alumno NO puede emitir enlaces firmados, ni de lo suyo (RN-15): para él la cadena
    // arranca en el paso 2, sin un cartel de error que no tendría nada que explicarle.
    if (!r || !r.ok) return pasoDos();
    const datos = await r.json().catch(() => null);
    if (!datos || !datos.url) return pasoDos();
    publico = window.location.origin + datos.url;
  }

  esperando('Cargando previsualización…');
  const marco = document.createElement('iframe');
  marco.className = 'att-preview-frame';
  marco.style.opacity = '0';
  marco.src = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(publico);

  const reloj = setTimeout(() => { if (contenedor.isConnected) pasoDos(); }, 8000);
  marco.onload = () => {
    clearTimeout(reloj);
    const cargando = contenedor.querySelector('.att-preview-loading');
    if (cargando) cargando.remove();
    marco.style.opacity = '1';
  };
  contenedor.appendChild(marco);
}

// El bundle del visor de planos (dxf-viewer + three.js, npm run build:dxf) pesa 1,2 MB, así
// que NO va en el <script> de course.ejs: se inyecta la PRIMERA vez que alguien abre un
// plano, y una sola vez por pestaña. La promesa cacheada evita que dos clics seguidos
// inyecten dos <script>.
let _bundleDxf = null;
function cargarVisorDxf() {
  if (window.DxfViewer) return Promise.resolve(window.DxfViewer);
  if (!_bundleDxf) {
    _bundleDxf = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = '/js/dxf-viewer.bundle.js';
      tag.onload  = () => resolve(window.DxfViewer);
      // Si el bundle no está (un despliegue que se lo olvidó), se reintenta en el próximo
      // clic en vez de dejar la promesa rechazada para siempre.
      tag.onerror = () => { _bundleDxf = null; reject(new Error('no se pudo cargar el visor de planos')); };
      document.head.appendChild(tag);
    });
  }
  return _bundleDxf;
}

// Qué motivo de RN-20 le corresponde a cada respuesta del derivado. El texto NO se escribe
// acá: sale de public/js/correccion.js, para que el cartel de la pantalla y el mensaje de la
// API digan lo mismo porque SON lo mismo.
const MOTIVO_POR_STATUS = { 404: 'archivo_no_esta', 413: 'archivo_muy_grande', 422: 'conversion_fallida', 501: 'sin_conversor_cad' };

/**
 * Visor de planos: dibuja un .dxf (directo) o un .dwg (vía el .dxf derivado del servidor).
 *
 * ⚠️ TODO lo que se escriba en pantalla desde acá va por textContent, NUNCA por innerHTML
 * (RN-40). Un .dxf es TEXTO PLANO del alumno —nombres de capa, cotas, entidades TEXT— y el
 * derivado es igual de suyo: lo produjo ODA a partir de su archivo, no lo escribió el
 * servidor. Pasar por un conversor no sanitiza nada.
 */
async function montarVisorCad(contenedor, att) {
  const nombre = att.name || '';
  const url    = att.url  || '';
  const esDwg  = /\.dwg$/i.test(nombre);

  // El molde es markup NUESTRO y constante; lo que viene de afuera (el motivo del error, que
  // puede nombrar el archivo del alumno) entra después por textContent y nunca por innerHTML.
  const cartel = (texto) => {
    contenedor.innerHTML = `
      <div class="att-preview-no-support">
        <span class="material-symbols-outlined">architecture</span>
        <p>No se puede mostrar el plano acá</p>
        <p class="att-preview-no-support-sub"></p>
      </div>`;
    contenedor.querySelector('.att-preview-no-support-sub').textContent = texto;
  };

  const esperando = (texto) => {
    contenedor.innerHTML = `
      <div class="att-preview-loading">
        <div class="att-preview-spinner"></div>
        <p></p>
      </div>`;
    contenedor.querySelector('.att-preview-loading p').textContent = texto;
  };

  // Los topes los decide la función pura, no esta pantalla: son los mismos que aplica el
  // servidor y salen de lo medido sobre los planos reales (RN-41).
  const decision = Correccion.renderVisor({ name: nombre, size: att.size || 0 },
    { conversionCadDisponible: true, dxfDerivadoListo: !esDwg });
  if (decision.motivo) return cartel(decision.texto);

  esperando('Preparando el plano…');

  let urlDxf = url;
  if (esDwg) {
    // El derivado solo existe para las ENTREGAS: es la única ruta que sabe convertirlo.
    if (!/^\/activities\/submission-file\//.test(url)) {
      return cartel(Correccion.MOTIVOS.formato_sin_visor);
    }
    urlDxf = url + '/dxf';
    // HEAD y no GET: alcanza para saber si la conversión salió bien y no baja el archivo dos
    // veces. El status dice POR QUÉ falló, y cada motivo tiene su texto.
    const sonda = await fetch(urlDxf, { method: 'HEAD' }).catch(() => null);
    if (!sonda || !sonda.ok) {
      const motivo = MOTIVO_POR_STATUS[sonda && sonda.status] || 'conversion_fallida';
      return cartel(Correccion.textoDeMotivo(motivo,
        { bytes: att.size, tope: Correccion.TOPES.entradaDwg }));
    }
  }

  let modulo;
  try {
    modulo = await cargarVisorDxf();
  } catch {
    return cartel('El visor de planos no está disponible. Descargalo para abrirlo con AutoCAD.');
  }

  // El visor de planos dibuja con WebGL, que NO está en todas las máquinas: falta en equipos
  // viejos, con los drivers desactualizados, o con la aceleración por hardware apagada. Se
  // pregunta ANTES de instanciar el visor porque el error que tira three.js al no poder crear
  // el contexto es indistinguible de un DXF roto, y confundirlos manda al docente a pedirle
  // al alumno que vuelva a subir un archivo que está perfecto.
  if (!hayWebgl()) return cartel(Correccion.MOTIVOS.sin_webgl);

  contenedor.textContent = '';
  const lienzo = document.createElement('div');
  lienzo.className = 'visor-cad-lienzo';
  contenedor.appendChild(lienzo);

  try {
    const visor = new modulo.DxfViewer(lienzo, { autoResize: true });
    contenedor._visorCad = visor;   // para poder destruirlo al cerrar
    await visor.Load({ url: urlDxf });
  } catch {
    // Descartado WebGL más arriba, acá queda el archivo: un DXF roto o algo que no es un plano.
    cartel(Correccion.MOTIVOS.conversion_fallida);
  }
}

// ¿Esta máquina puede dibujar con WebGL? Se consulta una sola vez y se cachea: crear un
// contexto es caro y el resultado no cambia mientras la pestaña viva.
let _webglOk = null;
function hayWebgl() {
  if (_webglOk !== null) return _webglOk;
  try {
    const c = document.createElement('canvas');
    _webglOk = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    _webglOk = false;
  }
  return _webglOk;
}

/**
 * Visor de imagen con zoom, arrastre y rotación, montado dentro de `contenedor`.
 *
 * Es CSS `transform` sobre un <img> y nada más: ni librerías, ni canvas, ni servidor. Y
 * soporta los cinco formatos de imagen que decide Adjuntos.esImagen(), que es la regla
 * compartida y no se duplica acá.
 *
 * ⚠️ La ROTACIÓN ES SOLO DE LA VISTA: no reescribe el archivo del alumno ni guarda nada.
 * Enderezar la foto para leerla es del que corrige; tocar la entrega es otra cosa y necesita
 * su propia decisión (specs/correccion-de-entregas.spec.md, "Lo que queda afuera").
 */
function montarVisorDeImagen(contenedor, url, nombre) {
  let escala = 1, giro = 0, x = 0, y = 0, ajustada = true;

  contenedor.innerHTML = `
    <div class="visor-img-lienzo">
      <img class="visor-img-foto" src="${escAtt(url)}" alt="${escAtt(nombre || '')}" draggable="false">
    </div>
    <div class="visor-img-barra">
      <button type="button" data-accion="menos" title="Alejar (rueda del mouse)"><span class="material-symbols-outlined">zoom_out</span></button>
      <span class="visor-img-nivel">100%</span>
      <button type="button" data-accion="mas" title="Acercar (rueda del mouse)"><span class="material-symbols-outlined">zoom_in</span></button>
      <button type="button" data-accion="izq" title="Rotar a la izquierda"><span class="material-symbols-outlined">rotate_left</span></button>
      <button type="button" data-accion="der" title="Rotar a la derecha"><span class="material-symbols-outlined">rotate_right</span></button>
      <button type="button" data-accion="ajustar" title="Ajustar a la pantalla / tamaño real (doble clic en la foto)"><span class="material-symbols-outlined">fit_screen</span></button>
    </div>`;

  const lienzo = contenedor.querySelector('.visor-img-lienzo');
  const foto   = contenedor.querySelector('.visor-img-foto');
  const nivel  = contenedor.querySelector('.visor-img-nivel');

  function pintar() {
    foto.style.transform = `translate(${x}px, ${y}px) scale(${escala}) rotate(${giro}deg)`;
    nivel.textContent = Math.round(escala * 100) + '%';
    lienzo.classList.toggle('esta-ajustada', ajustada);
  }
  function zoom(factor, centro) {
    const previa = escala;
    escala = Math.min(8, Math.max(0.1, escala * factor));
    ajustada = false;
    // Si el zoom viene de la rueda, se acerca HACIA EL PUNTERO: en una foto ampliada 4 veces,
    // acercar siempre al centro obliga a arrastrar después de cada rueda.
    if (centro) {
      const caja = lienzo.getBoundingClientRect();
      const dx = centro.clientX - (caja.left + caja.width / 2) - x;
      const dy = centro.clientY - (caja.top + caja.height / 2) - y;
      x -= dx * (escala / previa - 1);
      y -= dy * (escala / previa - 1);
    }
    pintar();
  }
  function ajustar() {
    escala = 1; x = 0; y = 0; ajustada = !ajustada;
    pintar();
  }

  contenedor.querySelectorAll('[data-accion]').forEach(b => {
    b.addEventListener('click', () => {
      const a = b.dataset.accion;
      if (a === 'mas')     zoom(1.25);
      if (a === 'menos')   zoom(1 / 1.25);
      if (a === 'izq')     { giro -= 90; pintar(); }
      if (a === 'der')     { giro += 90; pintar(); }
      if (a === 'ajustar') ajustar();
    });
  });

  lienzo.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e);
  }, { passive: false });

  lienzo.addEventListener('dblclick', ajustar);

  // Arrastrar para moverse adentro de la foto. Con pointer events anda igual con mouse y con
  // dedo, y setPointerCapture evita que soltar afuera del visor deje el arrastre pegado.
  let arrastrando = null;
  lienzo.addEventListener('pointerdown', (e) => {
    arrastrando = { px: e.clientX, py: e.clientY };
    lienzo.setPointerCapture(e.pointerId);
    lienzo.classList.add('arrastrando');
  });
  lienzo.addEventListener('pointermove', (e) => {
    if (!arrastrando) return;
    x += e.clientX - arrastrando.px;
    y += e.clientY - arrastrando.py;
    arrastrando = { px: e.clientX, py: e.clientY };
    ajustada = false;
    pintar();
  });
  const soltar = () => { arrastrando = null; lienzo.classList.remove('arrastrando'); };
  lienzo.addEventListener('pointerup', soltar);
  lienzo.addEventListener('pointercancel', soltar);

  pintar();
}

// Abre el previsualizador:
//  - PDF        → iframe inline en modal pantalla completa + botón Descargar
//  - YouTube    → iframe embed en modal pantalla completa + botón Abrir en YouTube
//  - Google Drive/Docs/Sheets/Slides → iframe /preview + botón Abrir en Google Drive
//  - Word/Excel → visor de Office Online (o descarga si estamos en local)
//  - Otro link  → abre en nueva pestaña (la mayoría bloquea embedding)
function openAttachmentPreview(att) {
  const name     = att.name || '';
  const url      = att.url  || '';
  const isPdf    = att.type === 'file' && _isPdf(name);
  const isOffice = att.type === 'file' && _isOffice(name);
  const isImage  = att.type === 'file' && _isImage(name);
  const isCad    = att.type === 'file' && _isCad(name);
  const isYt     = _isYoutube(url);
  // '' si no es un link de Google embebible → cae en el window.open de siempre
  const gDriveUrl = att.type === 'link' ? _gDriveEmbedUrl(url) : '';

  // Links que no son YouTube ni Google Drive → abrir en nueva pestaña
  if (att.type === 'link' && !isYt && !gDriveUrl) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  let bodyContent = '';

  if (isPdf) {
    bodyContent = `<iframe src="${url}#toolbar=1" class="att-preview-frame"></iframe>`;

  } else if (isOffice) {
    // La cadena de Office se monta después (montarVisorOffice): el paso 1 necesita pedirle
    // un enlace firmado al servidor, y eso es una request, no HTML.
    bodyContent = '<div class="visor-office"></div>';

  } else if (isImage) {
    // El visor de imagen se MONTA después (montarVisorDeImagen), no se arma acá: necesita
    // listeners, no sólo HTML. Acá queda el contenedor vacío.
    //
    // ⭐ Por qué la foto tiene visor propio y no un <img> pelado: el 88% de lo que se
    // entrega en esta escuela son fotos del trabajo hecho a mano (13.337 de 15.136 archivos,
    // censo del 2026-09-21). Un <img> con max-width alcanza para MIRAR un adjunto y no
    // alcanza para CORREGIR un ejercicio manuscrito fotografiado de lejos y torcido.
    bodyContent = '<div class="visor-img" data-src="' + escAtt(url) + '"></div>';

  } else if (isYt) {
    const vid = _ytId(url);
    if (!vid) { window.open(url, '_blank', 'noopener'); return; }
    bodyContent = `<iframe src="https://www.youtube.com/embed/${vid}?autoplay=1&rel=0"
      class="att-preview-frame" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;

  } else if (gDriveUrl) {
    // Google sirve /preview con X-Frame-Options que permite el embed. Si el archivo NO está
    // compartido como "cualquiera con el enlace", Google muestra su propia pantalla de
    // "solicitar acceso" DENTRO del iframe — no podemos detectarlo desde acá (es cross-origin),
    // por eso el botón "Abrir en Google Drive" de la barra superior es la salida para el alumno.
    bodyContent = `<iframe src="${gDriveUrl}" class="att-preview-frame"
      allow="autoplay" allowfullscreen></iframe>`;

  } else if (isCad) {
    // El plano se dibuja en el NAVEGADOR, que ya tiene la cookie de sesión: el servidor solo
    // produce el .dxf derivado cuando el original es un .dwg. Se monta después, como la
    // imagen, porque necesita fetch y un bundle que se carga la primera vez (RN-43).
    bodyContent = '<div class="visor-cad"></div>';

  } else if (att.type === 'file') {
    // Formato sin previewer (ej: ZIP). Muestra aviso + botón para descargar.
    bodyContent = `<div class="att-preview-no-support">
      <span class="material-symbols-outlined">description</span>
      <p>Este tipo de archivo no se puede previsualizar</p>
      <p class="att-preview-no-support-sub">Descargalo para abrirlo con la app correspondiente.</p>
    </div>`;
  }

  // Botón de acción en la barra superior. Para submission-file agregamos ?dl=1 porque el
  // endpoint sirve inline por defecto (para permitir la preview inline en iframe); sin ese
  // parámetro el navegador podría abrir el archivo en vez de descargarlo.
  const servesInline = url.startsWith('/activities/submission-file/') || /\/activities\/[^/]+\/staged-file\//.test(url);
  const downloadUrl = servesInline
    ? url + (url.includes('?') ? '&' : '?') + 'dl=1'
    : url;
  // Para links externos (YouTube, Drive) el botón abre el original en una pestaña nueva:
  // el atributo `download` de <a> es ignorado en cross-origin, así que ofrecer "Descargar"
  // ahí no haría nada. Además es la salida del alumno si el archivo de Drive no está
  // compartido y el iframe le muestra "solicitar acceso".
  const externalLabel = isYt ? 'Abrir en YouTube' : gDriveUrl ? 'Abrir en Google Drive' : '';
  const actionBtn = externalLabel
    ? `<a href="${url}" target="_blank" rel="noopener" class="att-preview-btn">
        <span class="material-symbols-outlined">open_in_new</span> ${externalLabel}
       </a>`
    : `<a href="${downloadUrl}" download="${escAtt(name)}" class="att-preview-btn">
        <span class="material-symbols-outlined">download</span> Descargar
       </a>`;

  const overlay = document.createElement('div');
  overlay.className = 'att-preview-overlay';
  overlay.innerHTML = `
    <div class="att-preview-topbar">
      <span class="att-preview-fname">${name}</span>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        ${actionBtn}
        <button class="att-preview-close" onclick="closeAttPreview()" title="Cerrar (Esc)">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
    <div class="att-preview-body">${bodyContent}</div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  // Las dos monturas del visor de imagen (esta y la del panel del corrector) comparten la
  // misma función: un archivo no puede verse de una manera en el overlay y de otra en el
  // panel. Por eso el docente que nunca cambia de modo TAMBIÉN gana el zoom y la rotación.
  const cajaImagen = overlay.querySelector('.visor-img');
  if (cajaImagen) montarVisorDeImagen(cajaImagen, cajaImagen.dataset.src, name);

  const cajaCad = overlay.querySelector('.visor-cad');
  if (cajaCad) montarVisorCad(cajaCad, att);

  const cajaOffice = overlay.querySelector('.visor-office');
  if (cajaOffice) montarVisorOffice(cajaOffice, att);

  const onEsc = e => { if (e.key === 'Escape') { closeAttPreview(); document.removeEventListener('keydown', onEsc); } };
  overlay._onEsc = onEsc;
  document.addEventListener('keydown', onEsc);
}

function closeAttPreview() {
  const overlay = document.querySelector('.att-preview-overlay');
  if (!overlay) return;
  if (overlay._onEsc) document.removeEventListener('keydown', overlay._onEsc);
  // El visor de planos se apaga a mano: adentro tiene un contexto WebGL, y el navegador
  // permite unos pocos por pestaña. Sin esto, abrir y cerrar planos termina dejando la
  // pestaña sin poder dibujar ninguno más.
  const cajaCad = overlay.querySelector('.visor-cad');
  if (cajaCad && cajaCad._visorCad) { try { cajaCad._visorCad.Destroy(); } catch {} }
  overlay.remove();
  document.body.style.overflow = '';
}

// Chip de resumen de adjuntos ("2 archivos · 1 imagen · 1 vínculo") para las tarjetas del stream
function attachmentCountChip(attachments) {
  if (!attachments || attachments.length === 0) return '';
  // La imagen se cuenta aparte: "1 archivo" no le anticipa al alumno que lo que hay adentro
  // es la foto de la consigna, que es justo el dato que hace que la abra.
  const archivos = attachments.filter(a => a.type === 'file');
  const imgs  = archivos.filter(a => Adjuntos.esImagen(a.name)).length;
  const files = archivos.length - imgs;
  const links = attachments.filter(a => a.type === 'link').length;
  const parts = [];
  if (files) parts.push(`${files} archivo${files > 1 ? 's' : ''}`);
  if (imgs)  parts.push(`${imgs} ${imgs > 1 ? 'imágenes' : 'imagen'}`);
  if (links) parts.push(`${links} vínculo${links > 1 ? 's' : ''}`);
  return `<span class="att-count-chip"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px">attach_file</span> ${parts.join(' · ')}</span>`;
}

/* ─── Tabs ─── */
// Maneja el cambio de pestaña (Novedades / Actividades / Personas / Calificaciones / Mis notas)
// La carga de datos es lazy: solo se ejecuta la primera vez que se visita el tab
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hidden'));
    document.getElementById(this.dataset.tab + 'Tab').classList.remove('hidden');

    // El FAB (botón "+" flotante) solo se muestra en el tab de actividades (para el docente)
    const fab = document.getElementById('fabBtn');
    if (fab) fab.style.display = this.dataset.tab === 'activities' ? 'flex' : 'none';

    // Carga lazy del tab de actividades (flag evita recargar si ya se cargó)
    if (this.dataset.tab === 'activities' && !window._activitiesTabLoaded) {
      loadActivitiesTab();
    }
    // Carga lazy del gradebook del docente
    if (this.dataset.tab === 'calificaciones' && !window._calificacionesTabLoaded) {
      loadCalificacionesTab();
    }
    // "Mis notas" del alumno se recarga siempre (puede haber sido calificado en otro tab)
    if (this.dataset.tab === 'misnotas') {
      loadMisNotasTab();
    }
  });
});

/* ─── Stream: Novedades ─── */
// Formatea fecha de forma corta: "15 may 2025, 10:30"
function fmtShort(d) {
  return Fecha.diaMesAnioHora(d);
}
// Formatea fecha de forma larga: "15 de mayo de 2025, 10:30"
function fmtLong(d) {
  return Fecha.diaMesLargoHora(d);
}

// Construye el HTML de un comentario en una novedad
// c.author viene populado con name desde la API
function buildCommentHtml(c) {
  const initial = c.author?.name?.charAt(0).toUpperCase() || '?';
  return `<div class="ann-comment">
    <div class="avatar" style="width:28px;height:28px;font-size:13px;flex-shrink:0">${initial}</div>
    <div class="ann-comment-body">
      <div class="ann-comment-author">${c.author?.name || 'Usuario'}</div>
      <div class="ann-comment-text">${c.text}</div>
      <div class="ann-comment-date">${fmtShort(c.createdAt)}</div>
    </div>
  </div>`;
}

// Construye el elemento DOM de una novedad completa (expandible)
// ann viene del array announcements de GET /announcements/course/:courseId
function buildAnnouncementEl(ann) {
  // Preview truncado a 100 caracteres para el estado colapsado
  const preview      = ann.text.length > 100 ? ann.text.slice(0, 100) + '…' : ann.text;
  const commentsHtml = (ann.comments || []).map(buildCommentHtml).join('');

  // Editar: solo el autor. Eliminar: el autor o quien gestiona la materia (moderación de
  // novedades ajenas, típicamente las de un alumno). El backend revalida las dos cosas.
  const esAutor    = !!window.USER_ID && String(ann.author?._id) === String(window.USER_ID);
  const puedeBorrar = esAutor || window.IS_OWNER === true;
  const editadaMsg = ann.editedAt
    ? `<span class="ann-edited-tag" title="Editada el ${fmtShort(ann.editedAt)}">(editada)</span>` : '';

  const wrapper = document.createElement('div');
  wrapper.className  = 'ann-card';
  wrapper.dataset.id = ann._id;
  wrapper.innerHTML = `
    <div class="stream-item ann-stream-item" onclick="toggleAnnExpand('${ann._id}')">
      <div class="stream-item-icon ann-icon">
        <span class="material-symbols-outlined">campaign</span>
      </div>
      <div class="stream-item-body">
        <div class="stream-item-text"><strong>${ann.author.name}</strong> publicó: ${preview}</div>
        <div class="stream-item-date">${fmtShort(ann.createdAt)} ${editadaMsg}</div>
      </div>
      <span class="material-symbols-outlined ann-expand-arrow">expand_more</span>
    </div>
    <div class="ann-expanded" id="ann-exp-${ann._id}" style="display:none">
      ${(esAutor || puedeBorrar) ? `
      <div class="ann-actions">
        ${esAutor ? `<button class="ann-action-btn" onclick="startEditAnnouncement('${ann._id}')" title="Editar novedad">
          <span class="material-symbols-outlined">edit</span> Editar
        </button>` : ''}
        ${puedeBorrar ? `<button class="ann-action-btn ann-action-danger" onclick="deleteAnnouncement('${ann._id}')" title="Eliminar novedad">
          <span class="material-symbols-outlined">delete</span> Eliminar
        </button>` : ''}
      </div>` : ''}
      <div class="ann-full-text" id="ann-text-${ann._id}">${ann.text}</div>
      ${ann.image ? `<img src="${ann.image}" class="ann-full-img" alt="">` : ''}
      <div class="ann-comments" id="ann-comments-${ann._id}">${commentsHtml}</div>
      <div class="ann-comment-form">
        <div class="avatar" style="width:28px;height:28px;font-size:13px;flex-shrink:0">${window.USER_INITIAL || '?'}</div>
        <input type="text" class="ann-comment-input" id="ann-ci-${ann._id}"
          placeholder="Agregar comentario de clase..."
          onkeydown="if(event.key==='Enter'){event.preventDefault();postComment('${ann._id}')}">
        <button class="icon-btn" id="ann-cb-${ann._id}" onclick="postComment('${ann._id}')" title="Enviar">
          <span class="material-symbols-outlined" style="color:var(--primary)">send</span>
        </button>
      </div>
    </div>
  `;
  return wrapper;
}

// Expande o colapsa el panel de detalle de una novedad
function toggleAnnExpand(annId) {
  const card = document.querySelector(`.ann-card[data-id="${annId}"]`);
  const exp  = document.getElementById('ann-exp-' + annId);
  if (!card || !exp) return;
  const open = exp.style.display !== 'none';
  exp.style.display = open ? 'none' : 'block';
  card.classList.toggle('expanded', !open); // Clase CSS que rota la flecha de expand
}

// Edición inline de una novedad: reemplaza el texto por un textarea con Guardar/Cancelar.
// No toca la imagen — para cambiarla hay que borrar la novedad y publicarla de nuevo.
function startEditAnnouncement(annId) {
  const cont = document.getElementById('ann-text-' + annId);
  if (!cont || cont.dataset.editing === '1') return;

  const original = cont.textContent;
  cont.dataset.editing = '1';
  cont.dataset.original = original;
  cont.innerHTML = `
    <textarea class="ann-edit-input" id="ann-edit-${annId}" rows="4">${original.replace(/</g, '&lt;')}</textarea>
    <div class="ann-edit-error form-error" id="ann-edit-err-${annId}"></div>
    <div class="ann-edit-btns">
      <button class="btn btn-outline" onclick="cancelEditAnnouncement('${annId}')">Cancelar</button>
      <button class="btn btn-primary" id="ann-edit-save-${annId}" onclick="saveEditAnnouncement('${annId}')">
        <span class="material-symbols-outlined">check</span> Guardar
      </button>
    </div>`;
  const ta = document.getElementById('ann-edit-' + annId);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function cancelEditAnnouncement(annId) {
  const cont = document.getElementById('ann-text-' + annId);
  if (!cont) return;
  cont.textContent = cont.dataset.original || '';
  cont.dataset.editing = '0';
}

async function saveEditAnnouncement(annId) {
  const cont  = document.getElementById('ann-text-' + annId);
  const ta    = document.getElementById('ann-edit-' + annId);
  const errEl = document.getElementById('ann-edit-err-' + annId);
  const btn   = document.getElementById('ann-edit-save-' + annId);
  const text  = ta.value.trim();

  errEl.classList.remove('show');
  if (!text) {
    errEl.textContent = 'La novedad no puede quedar vacía.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled = true;
  try {
    const res  = await fetch('/announcements/' + annId, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'No se pudo guardar';
      errEl.classList.add('show');
      btn.disabled = false;
      return;
    }
    // Se recarga el stream para que el preview colapsado y el "(editada)" queden al día.
    loadStream();
  } catch {
    errEl.textContent = 'Error de conexión';
    errEl.classList.add('show');
    btn.disabled = false;
  }
}

// Elimina una novedad (POST /announcements/:id/delete). Se lleva sus comentarios y su imagen.
async function deleteAnnouncement(annId) {
  if (!confirm('¿Eliminar esta novedad? Se borran también sus comentarios y la imagen adjunta. No se puede deshacer.')) return;
  try {
    const res  = await fetch('/announcements/' + annId + '/delete', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'No se pudo eliminar la novedad');
      return;
    }
    document.querySelector(`.ann-card[data-id="${annId}"]`)?.remove();
  } catch {
    alert('Error de conexión');
  }
}

// Envía un comentario a una novedad (POST /announcements/:id/comment)
// Inserta el comentario nuevo en el DOM sin recargar la página
async function postComment(annId) {
  const input = document.getElementById('ann-ci-' + annId);
  const btn   = document.getElementById('ann-cb-' + annId);
  const text  = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  const res  = await fetch('/announcements/' + annId + '/comment', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });
  const data = await res.json();
  btn.disabled = false;

  if (!res.ok) { alert(data.error); return; }

  input.value = '';
  const container = document.getElementById('ann-comments-' + annId);
  container.insertAdjacentHTML('beforeend', buildCommentHtml(data.comment));
  // Scroll suave hasta el nuevo comentario para que quede visible
  container.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Construye el elemento del stream para una actividad reciente
// Se muestra en el tab Novedades junto a las novedades del curso
function buildActivityStreamEl(act) {
  window._activities[act._id] = act; // Cachea la actividad para uso futuro
  const div = document.createElement('div');
  div.className     = 'stream-item';
  div.style.cursor  = 'pointer';
  div.onclick       = () => openActivityDetail(act._id); // Click abre el modal de detalle
  div.innerHTML = `
    <div class="stream-item-icon act-icon">
      <span class="material-symbols-outlined">assignment</span>
    </div>
    <div class="stream-item-body">
      <div class="stream-item-text"><strong>${act.author.name}</strong> publicó una nueva tarea: ${act.title}</div>
      <div class="stream-item-date">${Fecha.diaMes(act.createdAt)}</div>
    </div>
    <button class="icon-btn" title="Más opciones" onclick="event.stopPropagation()">
      <span class="material-symbols-outlined">more_vert</span>
    </button>
  `;
  return div;
}

// Pinta la tarjeta "Próximas entregas" del sidebar a partir de la lista ya filtrada.
// Está separada de loadStream() porque hay dos momentos en que hay que redibujarla: al
// cargar la solapa Novedades y cuando el alumno entrega desde el modal (ahí la tarea deja
// de ser una entrega próxima y tiene que irse de la lista sin recargar la página).
function renderUpcoming(upcoming) {
  const upcomingList = document.getElementById('upcomingList');
  if (!upcomingList) return;
  if (upcoming.length === 0) {
    upcomingList.innerHTML = '<p class="stream-no-upcoming">No tenés tareas pendientes</p>';
    return;
  }
  upcomingList.innerHTML = upcoming.slice(0, 3).map(a => `
    <div class="upcoming-item" data-id="${a._id}" onclick="openActivityDetail('${a._id}')">
      <div class="upcoming-item-title">${a.title}</div>
      <div class="upcoming-item-due">${fmtShort(a.dueDate)}</div>
    </div>
  `).join('');
}

// Redibuja "Próximas entregas" con el cache de actividades, sin volver a pedir el stream.
// Se llama cuando el alumno entrega: la tarea sale de la lista en el acto y, si había una
// cuarta esperando afuera del tope de 3, entra sola.
//
// El cache alcanza porque al alumno el servidor le manda exactamente lo mismo que este
// filtro necesita: window._activities lo llenan loadStream() y loadActivitiesTab(), y para
// un alumno las dos traen el mismo conjunto (las que ya están publicadas).
function refrescarProximasEntregas() {
  const now = new Date();
  const upcoming = Object.values(window._activities || {})
    .filter(a => Visibilidad.esVisibleParaAlumno(a, now))
    .filter(a => EstadoActividad.esProximaEntrega(a, now))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  renderUpcoming(upcoming);
}

// Carga el stream (novedades + actividades) mezclados y ordenados cronológicamente
// También llena el sidebar de "Próximas entregas" con las actividades con dueDate futuro
async function loadStream() {
  const container = document.getElementById('streamList');
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando...</p></div>';

  // Fetch en paralelo de novedades y actividades del curso
  // window.COURSE_ID viene expuesto por course.ejs en el bloque <script>
  const [annRes, actRes] = await Promise.all([
    fetch('/announcements/course/' + window.COURSE_ID),
    fetch('/activities/course/'    + window.COURSE_ID),
  ]);
  const annData = await annRes.json();
  const actData = await actRes.json();

  // Próximas entregas en el sidebar: lo que TODAVÍA hay que hacer y tiene fecha por
  // delante, máx 3. Lo ya entregado sale de acá (EstadoActividad.esProximaEntrega): esta
  // tarjeta es la lista de lo que falta, no el índice de la materia.
  const now = new Date();
  const upcoming = (actData.activities || [])
    .filter(a => Visibilidad.esVisibleParaAlumno(a, now))
    .filter(a => EstadoActividad.esProximaEntrega(a, now))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  renderUpcoming(upcoming);

  // Mezcla y ordena novedades + actividades por fecha (más recientes primero).
  //
  // Al docente el servidor le manda TODAS sus actividades, programadas incluidas; al muro
  // solo van las publicadas. Es lo mismo que hace createActivity() al crear una programada
  // (no la prepende), y sin este filtro al recargar la página aparecía igual. Al docente la
  // programada le sigue figurando en la solapa Actividades, con su chip y su botón de ojo.
  const delMuro = (actData.activities || []).filter(a => Visibilidad.esVisibleParaAlumno(a, now));
  const items = [
    ...annData.announcements.map(a => ({ type: 'announcement', date: new Date(a.createdAt), data: a })),
    ...delMuro.map(a               => ({ type: 'activity',     date: new Date(a.createdAt), data: a })),
  ].sort((a, b) => b.date - a.date);

  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">campaign</span></div><p>Aún no hay publicaciones</p></div>';
    return;
  }

  items.forEach(item => {
    container.appendChild(item.type === 'announcement' ? buildAnnouncementEl(item.data) : buildActivityStreamEl(item.data));
  });
}

// Carga el stream al inicializar la página (tab Novedades está activo por defecto)
loadStream();

/* ─── Post Announcement ─── */
// Muestra el formulario inline de nueva novedad y oculta el botón de acción
function openAnnouncementForm() {
  document.getElementById('streamActionRow').style.display    = 'none';
  document.getElementById('announcementFormCard').style.display = 'block';
  document.getElementById('announcementText').focus();
}

// Cierra el formulario de novedad y restaura el estado inicial (limpia imagen seleccionada)
function closeAnnouncementForm() {
  document.getElementById('announcementFormCard').style.display = 'none';
  document.getElementById('streamActionRow').style.display      = 'flex';
  document.getElementById('announcementText').value = '';
  selectedImage = null;
  document.getElementById('imageInput').value = '';
  document.getElementById('imageName').textContent = '';
  document.getElementById('imagePreviewContainer').innerHTML = '';
}

// Activa el tab de actividades programáticamente (usado desde botones de acción rápida)
function switchToActivities() {
  const tab = document.querySelector('.tab[data-tab="activities"]');
  if (tab) tab.click();
}

// Muestra preview de la imagen seleccionada para una novedad (FileReader → base64)
// OJO: `?.` es obligatorio. #imageInput vive dentro de `<% if (course.isTeacher(...)) %>`
// en views/course.ejs, así que NO existe para el alumno. Sin el optional chaining esto
// tiraba TypeError en el nivel superior del script y abortaba la carga de course.js
// entero: todo lo declarado más abajo con const/let (SUB_ALLOWED_EXTS, SUB_MAX_SIZE…)
// quedaba sin inicializar y la entrega del alumno se rompía por TDZ. Mismo motivo en
// el resto de los addEventListener de nivel superior de este archivo.
document.getElementById('imageInput')?.addEventListener('change', function () {
  if (this.files && this.files[0]) {
    selectedImage = this.files[0];
    document.getElementById('imageName').textContent = '';
    const reader = new FileReader();
    reader.onload = function (e) {
      document.getElementById('imagePreviewContainer').innerHTML = `
        <div class="image-preview-wrap">
          <img src="${e.target.result}" class="image-preview-thumb" alt="Vista previa">
          <button class="image-preview-remove" onclick="removeImagePreview()" title="Quitar imagen">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>`;
    };
    reader.readAsDataURL(selectedImage); // Lee como URL base64 para previsualizar sin subir
  }
});

// Quita la imagen seleccionada del estado local y limpia el preview
function removeImagePreview() {
  selectedImage = null;
  document.getElementById('imageInput').value = '';
  document.getElementById('imagePreviewContainer').innerHTML = '';
}

// Publica una novedad (POST /announcements/create como multipart/form-data)
// Inserta el elemento al inicio del stream sin recargar la página
async function postAnnouncement() {
  const text = document.getElementById('announcementText').value.trim();
  if (!text) return;

  const btn = document.querySelector('.announcement-form-btns .btn-primary');
  btn.disabled    = true;
  btn.textContent = 'Publicando...';

  // Usa FormData porque puede incluir imagen (multipart)
  const formData = new FormData();
  formData.append('courseId', window.COURSE_ID);
  formData.append('text', text);
  if (selectedImage) formData.append('image', selectedImage);

  const res  = await fetch('/announcements/create', { method: 'POST', body: formData });
  const data = await res.json();

  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">send</span> Publicar';

  if (!res.ok) { alert(data.error); return; }

  // Inserta la novedad nueva al principio del stream (más reciente primero)
  const el        = buildAnnouncementEl(data.announcement);
  const container = document.getElementById('streamList');
  const empty     = container.querySelector('.empty-state');
  if (empty) empty.remove();
  container.prepend(el);
  closeAnnouncementForm();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ─── Adjuntos en el modal de creación de actividad ─── */
let activityFiles = []; // Archivos locales seleccionados (File objects, aún no subidos)
let activityLinks = []; // Links agregados manualmente [{ name, url }]

// Imágenes: NO viajan con el create como los demás archivos, se pre-suben apenas se eligen.
//
// El motivo es que la imagen no se guarda como llega: el servidor la recomprime a WebP
// (POST /activities/upload-image), y eso necesita su propia ruta. La contrapartida es que
// acá hay que llevar el estado de una subida en curso, que para PDF/Word/Excel no existía.
//
// Forma de cada entrada: { uid, estado: 'subiendo' | 'listo', nombre, pct, url, mime }.
// Las 'listo' son exactamente lo que espera `uploadedFiles` en POST /activities/create.
let activityImages = [];
// Tope de entrada de la imagen: el servidor la recibe en memoria para recomprimirla
// (MAX_INPUT_BYTES en config/imagePresets.js). Entra cualquier foto de celular.
const ACT_IMG_MAX_SIZE = 20 * 1024 * 1024;

// Agrega archivos al array local cuando el usuario los selecciona.
// Los dos inputs —"Subir archivo" y "Subir imagen"— caen acá: lo que decide por dónde va
// cada uno es la extensión, no el botón que se apretó.
['activityFileInput', 'activityImageInput'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', function () {
    Array.from(this.files).forEach(f => {
      if (Adjuntos.esImagen(f.name)) subirImagenAdjunta(f);
      else activityFiles.push(f);
    });
    this.value = ''; // Resetea el input para permitir seleccionar el mismo archivo de nuevo
    renderAttachmentPreviews();
  });
});

// Deshabilita "Crear actividad" mientras haya una imagen subiendo. Sin esto se puede crear
// la actividad sin la foto que se está subiendo, y el docente no se entera: la imagen queda
// huérfana en el disco y la tarea sale sin adjunto.
function syncActivitySubmitBtn() {
  const btn = document.getElementById('activitySubmitBtn');
  if (!btn) return;
  const subiendo = activityImages.filter(i => i.estado === 'subiendo').length;
  btn.disabled = subiendo > 0;
  btn.innerHTML = subiendo > 0
    ? `<span class="material-symbols-outlined">hourglass_top</span> Subiendo ${subiendo === 1 ? 'imagen' : subiendo + ' imágenes'}...`
    : '<span class="material-symbols-outlined">check</span> Crear actividad';
}

// Sube una imagen a /activities/upload-image y la deja lista para el create.
//
// Es la misma coreografía que uploadSubFile() (barra de progreso, código de diagnóstico,
// reintentos con espera): la red del aula es la misma para la docente que para el alumno.
function subirImagenAdjunta(file) {
  if (file.size > ACT_IMG_MAX_SIZE) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    showUploadErrModal('Imagen demasiado grande',
      `"${file.name}" pesa ${mb} MB. El máximo permitido es ${ACT_IMG_MAX_SIZE / 1024 / 1024} MB.`);
    return;
  }

  const uid     = Date.now() + '-' + Math.random().toString(36).slice(2);
  const entrada = { uid, estado: 'subiendo', nombre: file.name, pct: 0, url: '', mime: '' };
  activityImages.push(entrada);
  renderAttachmentPreviews();

  const ruta = '/activities/upload-image?courseId=' + encodeURIComponent(window.COURSE_ID);
  // Lo que aporta el seguimiento es cuántos bytes llegó a empujar el navegador: es lo que
  // distingue "se cortó en camino" (nada de eso deja rastro en el log del servidor) de
  // "subió entera y el servidor la rechazó". Ver public/js/subida-diagnostico.js.
  const seg  = SubidaDiag.seguir(ruta, file);

  // La tarjeta se vuelve a dibujar entera cada vez que cambia algo del grid (se agrega un
  // link, se quita un archivo), así que el progreso se guarda en la entrada y además se
  // pinta directo sobre el nodo: si el repintado pasa en el medio, la barra no vuelve a cero.
  const enPantalla = () => document.getElementById('aimg-' + uid);
  const estado     = (t) => {
    const c = enPantalla();
    if (c) c.querySelector('.att-upload-status').textContent = t;
  };
  const sigueViva  = () => activityImages.includes(entrada);
  const quitar     = () => {
    const i = activityImages.indexOf(entrada);
    if (i !== -1) activityImages.splice(i, 1);
    renderAttachmentPreviews();
  };

  function enviarIntento() {
    // Si la quitaron (o se cerró el modal) se abandona sin tocar nada más.
    if (!sigueViva()) return;

    SubidaDiag.nuevoIntento(seg);

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      SubidaDiag.progreso(seg, e);
      if (!e.lengthComputable || !sigueViva()) return;
      entrada.pct = Math.round((e.loaded / e.total) * 100);
      const c = enPantalla();
      if (!c) return;
      c.querySelector('.att-upload-bar').style.width = entrada.pct + '%';
      c.querySelector('.att-upload-status').textContent = entrada.pct < 100 ? entrada.pct + '%' : 'Procesando...';
    };

    xhr.onload = () => {
      if (!sigueViva()) return;

      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}

      if ((xhr.status === 200 || xhr.status === 201) && data?.url) {
        entrada.estado = 'listo';
        entrada.url    = data.url;
        // El nombre que devuelve el servidor ya no es "pizarron.jpg" sino "pizarron.webp":
        // es el archivo que existe de verdad, y es el que va a descargar el alumno.
        entrada.nombre = data.name || file.name;
        entrada.mime   = data.mime || '';
        renderAttachmentPreviews();
        return;
      }
      fracaso(xhr, 'http');
    };

    xhr.onerror   = () => fracaso(null, 'red');
    xhr.ontimeout = () => fracaso(null, 'timeout');

    xhr.open('POST', ruta);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(fd);
  }

  // Los tres modos de falla convergen acá: un solo código SUB-XXXXXX, un solo cartel.
  function fracaso(xhr, motivo) {
    const cuerpo = xhr ? (xhr.responseText || '') : '';
    const espera = (sigueViva() && SubidaDiag.reintentable({
      motivo, status: xhr ? xhr.status : 0, cuerpo,
    })) ? SubidaDiag.esperaDe(seg.intentos) : null;

    if (espera !== null) {
      // La barra vuelve a cero: dejarla donde murió el intento sería hacerla mentir.
      entrada.pct = 0;
      const c = enPantalla();
      if (c) c.querySelector('.att-upload-bar').style.width = '0%';
      SubidaDiag.esperar(espera,
        (s) => estado('Reintento en ' + s + ' s'),
        () => { estado('Reintentando ' + (seg.intentos + 1) + ' de 4'); enviarIntento(); });
      return;
    }

    quitar();
    showUploadErrModal('No se pudo subir la imagen',
      SubidaDiag.mensaje(SubidaDiag.fallar(seg, xhr, motivo)));
  }

  enviarIntento();
}

// Quita una imagen ya subida (o en curso) del modal. El archivo ya subido queda en el disco
// hasta que pase cleanup-files.js, igual que en el creador de pantalla completa.
function removeActivityImage(uid) {
  const i = activityImages.findIndex(x => x.uid === uid);
  if (i !== -1) activityImages.splice(i, 1);
  renderAttachmentPreviews();
}

// Muestra u oculta el campo para agregar un link manualmente
function toggleLinkInput() {
  const area     = document.getElementById('linkInputArea');
  const isHidden = area.style.display === 'none';
  area.style.display = isHidden ? 'block' : 'none';
  if (isHidden) document.getElementById('linkUrlInput').focus();
  else document.getElementById('linkUrlInput').value = '';
}

// Enter en el campo de link lo agrega directamente
document.getElementById('linkUrlInput')?.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); addLinkFromInput(); }
});

// Agrega el link del input al array local; normaliza URLs sin protocolo
function addLinkFromInput() {
  const input = document.getElementById('linkUrlInput');
  const url   = input.value.trim();
  if (!url) return;
  let normalized = url;
  if (!/^https?:\/\//i.test(url)) normalized = 'https://' + url; // Añade https:// si falta
  activityLinks.push({ name: getDomain(normalized), url: normalized });
  input.value = '';
  toggleLinkInput();
  renderAttachmentPreviews();
}

// Elimina un archivo por índice del array local
function removeFile(i)  { activityFiles.splice(i, 1); renderAttachmentPreviews(); }
// Elimina un link por índice del array local
function removeLink(i)  { activityLinks.splice(i, 1); renderAttachmentPreviews(); }

// Renderiza el grid de previews de adjuntos pendientes en el modal de creación
function renderAttachmentPreviews() {
  const grid = document.getElementById('attachmentPreviews');
  grid.innerHTML = '';

  // Las imágenes van primero: son las únicas que ya están subidas de verdad, y la miniatura
  // es lo que le confirma al docente que la foto salió bien antes de crear la actividad.
  activityImages.forEach(img => {
    const card = document.createElement('div');
    card.className = 'att-preview-card';
    card.id = 'aimg-' + img.uid;
    // Mientras sube no hay miniatura: la que se muestra es la que devolvió el servidor, ya
    // recomprimida, que es exactamente la que va a ver el alumno.
    card.innerHTML = img.estado === 'listo'
      ? `<div class="att-preview-thumb att-thumb-img"><img src="${escAtt(img.url)}" alt=""></div>
         <div class="att-preview-name" title="${escAtt(img.nombre)}">${Adjuntos.escaparTexto(img.nombre)}</div>
         <button class="att-preview-remove" onclick="removeActivityImage('${img.uid}')" title="Quitar">
           <span class="material-symbols-outlined">close</span>
         </button>`
      : `<div class="att-preview-thumb att-thumb-img">
           <span class="material-symbols-outlined" style="font-size:34px;color:var(--text-hint)">image</span>
         </div>
         <div class="att-upload-progress-wrap">
           <div class="att-upload-bar" style="width:${img.pct}%"></div>
         </div>
         <div class="att-upload-status">${img.pct}%</div>
         <button class="att-preview-remove" onclick="removeActivityImage('${img.uid}')" title="Cancelar">
           <span class="material-symbols-outlined">close</span>
         </button>`;
    grid.appendChild(card);
  });

  activityFiles.forEach((f, i) => {
    const { ext, color } = extColor(f.name);
    const card = document.createElement('div');
    card.className = 'att-preview-card';
    card.innerHTML = `
      <div class="att-preview-thumb" style="background:${color}">
        <span class="att-preview-ext">${ext}</span>
      </div>
      <div class="att-preview-name" title="${escAtt(f.name)}">${Adjuntos.escaparTexto(f.name)}</div>
      <button class="att-preview-remove" onclick="removeFile(${i})" title="Quitar">
        <span class="material-symbols-outlined">close</span>
      </button>
    `;
    grid.appendChild(card);
  });

  activityLinks.forEach((l, i) => {
    const domain = getDomain(l.url);
    const card   = document.createElement('div');
    card.className = 'att-preview-card';
    card.innerHTML = `
      <div class="att-preview-thumb link-thumb">
        <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=64" width="36" height="36"
          style="border-radius:6px"
          onerror="this.outerHTML='<span class=\\'material-symbols-outlined\\' style=\\'font-size:36px;color:var(--primary)\\'>language</span>'">
      </div>
      <div class="att-preview-name" title="${l.url}">${domain}</div>
      <button class="att-preview-remove" onclick="removeLink(${i})" title="Quitar">
        <span class="material-symbols-outlined">close</span>
      </button>
    `;
    grid.appendChild(card);
  });

  // El botón de crear depende de si queda alguna imagen subiendo, y el grid es justamente
  // lo que se repinta cada vez que eso cambia.
  syncActivitySubmitBtn();
}

/* ─── Crear Actividad ─── */
// `desdeSala` lo manda el botón "Crear actividad" de la sala en vivo (views/partials/live-room.ejs).
// Es el MISMO modal: lo único que cambia es que el servidor, al crearla, avisa en el chat de la
// clase. Se guarda en una variable en vez de en un campo del form porque el modal se reutiliza y
// un input oculto quedaría marcado para la creación siguiente.
let activityFromRoom = false;
function openActivityModal(desdeSala) {
  activityFromRoom = !!desdeSala;
  document.getElementById('activityModal').classList.add('show');
  document.getElementById('activityTitle').focus();
}

// Cierra y resetea completamente el modal de creación (limpia arrays de adjuntos locales)
function closeActivityModal() {
  activityFromRoom = false;
  document.getElementById('activityModal').classList.remove('show');
  ['activityTitle', 'activityDesc', 'activityDueDate', 'activityPoints', 'activityAvailableFrom']
    .forEach(id => { document.getElementById(id).value = ''; });
  activityFiles = [];
  activityLinks = [];
  // Las imágenes que estaban subiendo se sueltan acá: el XHR sigue su curso, pero al no
  // encontrar su entrada en el array se abandona solo (ver sigueViva() en subirImagenAdjunta).
  activityImages = [];
  renderAttachmentPreviews();
  document.getElementById('linkInputArea').style.display = 'none';
  document.getElementById('linkUrlInput').value = '';
  const err = document.getElementById('activityError');
  err.classList.remove('show');
  err.textContent = '';
}

// Cierra el modal si el usuario hace clic en el overlay
document.getElementById('activityModal')?.addEventListener('click', function (e) {
  if (e.target === this) closeActivityModal();
});

// Crea una actividad (POST /activities/create como multipart/form-data)
// Links se serializa como JSON string porque FormData no soporta objetos anidados
// Después de crear: refresca la solapa Actividades desde el servidor Y agrega el elemento al
// stream si ya está disponible
async function createActivity() {
  const title   = document.getElementById('activityTitle').value.trim();
  const errorEl = document.getElementById('activityError');
  errorEl.classList.remove('show');

  if (!title) {
    errorEl.textContent = 'El título es requerido';
    errorEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('activitySubmitBtn');
  btn.disabled    = true;
  btn.textContent = 'Creando...';

  // Se copia ANTES del fetch: closeActivityModal() resetea la bandera, y para cuando hay que
  // refrescar la sala el modal ya se cerró.
  const desdeSala = activityFromRoom;

  const fd = new FormData();
  fd.append('courseId',       window.COURSE_ID);
  fd.append('title',          title);
  if (desdeSala) fd.append('fromRoom', '1');
  fd.append('type',           document.getElementById('activityType').value || 'tarea');
  fd.append('description',    document.getElementById('activityDesc').value.trim());
  fd.append('dueDate',        document.getElementById('activityDueDate').value || '');
  fd.append('availableFrom',  document.getElementById('activityAvailableFrom').value || '');
  fd.append('points',         document.getElementById('activityPoints').value || '');
  activityFiles.forEach(f => fd.append('files', f)); // Cada archivo como campo "files"
  fd.append('links', JSON.stringify(activityLinks));  // Links como JSON string
  // Las imágenes ya están en el disco del servidor: viajan como referencia, no como archivo.
  // Solo las terminadas — el botón está deshabilitado mientras quede alguna subiendo, así que
  // acá no debería haber ninguna a medias, pero filtrar es más barato que confiar.
  fd.append('uploadedFiles', JSON.stringify(activityImages
    .filter(i => i.estado === 'listo')
    .map(i => ({ url: i.url, name: i.nombre, mime: i.mime }))));

  const res  = await fetch('/activities/create', { method: 'POST', body: fd });
  const data = await res.json();

  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span> Crear actividad';

  if (!res.ok) {
    errorEl.textContent = data.error;
    errorEl.classList.add('show');
    return;
  }

  closeActivityModal();
  // Limpia el buscador para que la nueva actividad sea visible
  const searchInput = document.getElementById('activitySearch');
  if (searchInput && searchInput.value) { searchInput.value = ''; filterActivities(''); }

  // En el stream (el muro de la materia) va solo si ya está publicada: la programada aparece
  // en la solapa Actividades con su chip, y recién cae al muro cuando llega su fecha.
  if (Visibilidad.esVisibleParaAlumno(data.activity, new Date())) {
    const streamEl = buildActivityStreamEl(data.activity);
    const container = document.getElementById('streamList');
    const empty     = container.querySelector('.empty-state');
    if (empty) empty.remove();
    container.prepend(streamEl);
  }

  // La solapa Actividades se rearma desde el servidor en vez de insertarle la tarjeta a mano.
  //
  // Antes acá iba addActivityTabCard(), que hace appendChild: la tarjeta quedaba ÚLTIMA. Pero la
  // lista va de la más NUEVA a la más vieja (GET /activities/course/:id ordena createdAt:-1), así
  // que la recién creada aterrizaba al fondo, debajo de todo lo del año. El docente la creaba
  // desde la sala en vivo, la veía aparecer arriba de todo en Novedades —ahí sí va prepend— y al
  // entrar a Actividades no la encontraba: "me aparece solo en novedades". Medido el 2026-08-25
  // con 8 actividades previas: la nueva salía novena de nueve.
  //
  // Pedirle la lista al servidor y no ordenar acá es a propósito: el orden lo decide un solo lado.
  // De paso la tarjeta sale con los chips de entregas y vistas, que la respuesta de POST /create
  // no trae (no tiene submittedCount/viewedCount/totalStudents) y quedaban en blanco.
  //
  // Va DESPUÉS del muro y no antes: buildActivityStreamEl() también cachea en
  // window._activities, y con el objeto pelado de la respuesta. Yendo último, el que queda en
  // el cache es el del servidor, con los contadores — si no, tocar el ojo redibuja la tarjeta
  // recién creada y le borra los chips.
  //
  // Si la solapa todavía no se cargó no hay nada que hacer: su carga lazy la va a traer del
  // servidor, ya en su lugar.
  if (window._activitiesTabLoaded) {
    try {
      await loadActivitiesTab();
    } catch {
      // La actividad YA está creada; que falle este refresco no puede dejar la solapa clavada en
      // "Cargando actividades…". Marcarla como no cargada hace que el próximo click la reintente.
      window._activitiesTabLoaded = false;
    }
  }

  // El aviso en el chat lo escribe el servidor al crear la actividad; esto solo adelanta el poll
  // de la sala para que se vea ya, y no dentro de cuatro segundos.
  if (desdeSala && typeof window.lrRefrescar === 'function') window.lrRefrescar();
}

/* ─── Pestaña Actividades ─── */
// Flag para evitar recargar el tab si ya fue cargado (lazy loading)
window._activitiesTabLoaded = false;

// Construye y agrega la tarjeta de actividad en la vista del DOCENTE
// Incluye: thumbnail con colores del curso, tipo+puntos, título, fecha/chip de vencimiento, menú ⋮
// act viene del cache window._activities o de la respuesta de createActivity
function addActivityTabCard(act) {
  window._activities[act._id] = act; // Asegura que esté en el cache

  const container = document.getElementById('activitiesList');
  const empty     = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const now       = new Date();
  const isOverdue = act.dueDate && new Date(act.dueDate) < now;

  const dateText = act.dueDate
    ? 'Entrega: ' + Fecha.diaMesHora(act.dueDate)
    : 'Publicado: ' + Fecha.diaMes(act.createdAt);

  // Chip de estado del plazo: muestra si vencida y si las tardías están abilitadas
  const overdueChip = isOverdue
    ? `<span class="overdue-chip ${act.allowLateSubmissions ? 'overdue-open' : 'overdue-closed'}" data-actid="${act._id}">
        <span class="material-symbols-outlined" style="font-size:12px">${act.allowLateSubmissions ? 'lock_open' : 'lock'}</span>
        ${act.allowLateSubmissions ? 'Tardías habilitadas' : 'Plazo vencido'}
      </span>`
    : '';

  // Estado de cara al alumno: 'visible' | 'programada' | 'oculta' (Visibilidad viene de
  // /js/visibilidadActividad.js, la misma regla que aplica el servidor).
  const estado    = Visibilidad.estadoVisibilidad(act, now);
  const seVe      = estado === Visibilidad.VISIBLE;
  // Chip de visibilidad: solo cuando la actividad NO se ve. La programada dice desde cuándo,
  // porque es el dato que el docente necesita para saber si la cargó bien.
  const visChip   = seVe ? '' : `<span class="vis-chip vis-${estado}" data-actid="${act._id}">
        <span class="material-symbols-outlined" style="font-size:12px">${estado === Visibilidad.PROGRAMADA ? 'schedule' : 'visibility_off'}</span>
        ${Visibilidad.etiquetaVisibilidad(estado)}${estado === Visibilidad.PROGRAMADA ? ' · ' + Fecha.diaMesHora(act.availableFrom) : ''}
      </span>`;

  const tc        = typeConfig(act.type);
  const typeLabel = tc.label + (act.points != null ? ' · ' + act.points + ' pts' : '');

  // Color del thumbnail: usa el color del tipo si existe, si no el color del curso
  const c1      = tc.color || window.COURSE_COLOR  || '#1a73e8';
  const c2      = tc.color ? '' : (window.COURSE_COLOR2 || '');
  const thumbBg = c2 ? `background:linear-gradient(135deg,${c1},${c2})` : `background:${c1}`;

  // Chip de entregas recibidas: solo se muestra si hay alumnos en el curso
  const submittedChip = (act.totalStudents > 0)
    ? `<span class="submitted-chip" data-actid="${act._id}" title="Entregas recibidas">
        <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-3px">upload_file</span>
        ${act.submittedCount ?? 0}/${act.totalStudents}
      </span>`
    : '';

  // Chip de aperturas: cuántos alumnos abrieron el detalle. Permite detectar de un vistazo
  // la actividad que nadie vio (distinto de la que vieron y no hicieron).
  const viewedChip = (act.totalStudents > 0)
    ? `<span class="viewed-chip" data-actid="${act._id}" title="Alumnos que abrieron la actividad">
        <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-3px">visibility</span>
        ${act.viewedCount ?? 0}/${act.totalStudents}
      </span>`
    : '';

  // Tercer chip, al lado de los otros dos y con el mismo formato: cuántas ENTREGAS tienen
  // algo sin leer en el hilo privado (RN-31c). Solo aparece si hay algo — un chip en 0 sería
  // ruido en las 30 tarjetas que no tienen nada. En ámbar, que es el color de "te toca a vos".
  const sinLeerChip = (act.comentariosSinLeer > 0)
    ? `<span class="unread-chip" data-actid="${act._id}" title="Entregas con comentarios sin leer">
        <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-3px">forum</span>
        ${act.comentariosSinLeer} sin leer
      </span>`
    : '';

  const div = document.createElement('div');
  // act-no-visible atenúa la tarjeta: de un vistazo se distingue lo que el alumno ya tiene
  // de lo que todavía no. Sigue siendo clickeable y editable como cualquier otra.
  div.className  = 'act-student-item' + (seVe ? '' : ' act-no-visible');
  div.dataset.id = act._id;
  // Click en la tarjeta abre el detalle; los clicks en el ⋮ y en el ojo son suyos
  div.onclick = (e) => { if (!e.target.closest('.activity-row-menu, .act-eye-btn')) openActivityDetail(act._id); };
  div.innerHTML = `
    <div class="act-thumb" style="${thumbBg}">
      <span class="material-symbols-outlined">${tc.icon}</span>
    </div>
    <div class="act-content">
      <div class="act-type-label">${typeLabel}</div>
      <div class="act-item-title">${act.title} ${overdueChip}${visChip}</div>
      <div class="act-item-date${isOverdue ? ' date-overdue' : ''}">${dateText}</div>
    </div>
    <div class="act-status-col">
      ${viewedChip}
      ${submittedChip}
      ${sinLeerChip}
    </div>
    <div class="act-actions-col">
      <button class="icon-btn act-eye-btn${seVe ? '' : ' is-off'}" onclick="toggleActivityVisibility('${act._id}')"
              title="${seVe ? 'Ocultar a los alumnos' : 'Mostrar a los alumnos ahora'}"
              aria-label="${seVe ? 'Ocultar a los alumnos' : 'Mostrar a los alumnos ahora'}">
        <span class="material-symbols-outlined">${seVe ? 'visibility' : 'visibility_off'}</span>
      </button>
      <button class="icon-btn activity-row-menu" onclick="toggleActivityMenu(event,'${act._id}')" title="Más opciones">
        <span class="material-symbols-outlined">more_vert</span>
      </button>
    </div>
  `;

  container.appendChild(div);
}

// Avisa en el propio formulario que con una "Disponible desde" futura la actividad NO se
// publica al guardar. Sin esto el docente la crea, no la ve el alumno y parece que se perdió.
// Lo usan el modal de crear y el de editar (views/course.ejs).
function avisoProgramada(inputId, hintId) {
  const input = document.getElementById(inputId);
  const hint  = document.getElementById(hintId);
  if (!input || !hint) return;
  const futura = input.value && new Date(input.value) > new Date();
  hint.textContent = futura
    ? 'Queda deshabilitada y se publica sola en esa fecha. Podés adelantarla con el botón de ojo.'
    : '"Disponible desde" controla cuándo los alumnos pueden ver la actividad. Si se deja vacío, se publica inmediatamente.';
  hint.style.color = futura ? '#b45309' : '';
}

// Barra de visibilidad del modal de detalle del docente. Misma forma que la de entregas
// tardías (.overdue-control-bar) para que las dos se lean igual.
function barraVisibilidad(act) {
  const estado = Visibilidad.estadoVisibilidad(act, new Date());
  const seVe   = estado === Visibilidad.VISIBLE;

  let texto;
  if (seVe)                                    texto = 'Visible para los alumnos';
  else if (estado === Visibilidad.PROGRAMADA)  texto = 'Programada — se publica el ' + Fecha.diaMesHora(act.availableFrom);
  else                                         texto = 'Oculta — los alumnos no la ven';

  return `<div class="vis-control-bar ${seVe ? 'is-on' : 'is-off'}" id="visControlBar">
    <div class="vis-control-left">
      <span class="material-symbols-outlined" style="font-size:17px">${seVe ? 'visibility' : (estado === Visibilidad.PROGRAMADA ? 'schedule' : 'visibility_off')}</span>
      <span class="vis-label">${texto}</span>
    </div>
    <button class="btn ${seVe ? 'btn-outline' : 'btn-primary'}" onclick="toggleVisibilityFromDetail('${act._id}')">
      <span class="material-symbols-outlined">${seVe ? 'visibility_off' : 'visibility'}</span>
      ${seVe ? 'Ocultar' : 'Mostrar ahora'}
    </button>
  </div>`;
}

// Mismo toggle, disparado desde el modal de detalle: además de la barra hay que refrescar la
// tarjeta que quedó atrás en la lista, o al cerrar el modal muestra el estado anterior.
async function toggleVisibilityFromDetail(actId) {
  const bar = document.getElementById('visControlBar');
  const btn = bar?.querySelector('button');
  if (btn) btn.disabled = true;

  try {
    const res  = await fetch('/activities/' + actId + '/toggle-visibility', { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'No se pudo cambiar la visibilidad'); return; }

    const act = window._activities[actId];
    if (act) {
      act.visibleOverride = data.visibleOverride;
      act.availableFrom   = data.availableFrom;
      if (bar) bar.outerHTML = barraVisibilidad(act);
      reemplazarTarjetaActividad(actId);
    }
  } catch (e) {
    alert('Error de conexión al cambiar la visibilidad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Redibuja de cero la tarjeta del docente a partir del cache window._activities, sin recargar
// la solapa entera (el docente que está ordenando varias seguidas no pierde el scroll).
// addActivityTabCard hace appendChild, así que se construye al final y se la mueve al lugar
// de la vieja. Se usa al tocar el ojo y al guardar una edición: los dos pueden cambiar el
// estado de visibilidad, y armarla de nuevo evita tener que parchear campo por campo.
function reemplazarTarjetaActividad(actId) {
  const vieja = document.querySelector(`.act-student-item[data-id="${actId}"]`);
  const act   = window._activities[actId];
  if (!vieja || !act) return;
  // Cada rol tiene su constructora, igual que en loadActivitiesTab(). Antes esto llamaba
  // siempre a la del docente: no se notaba porque solo lo usaban flujos de docente, pero
  // desde que el alumno redibuja su tarjeta al entregar hay que respetar el rol.
  window.IS_OWNER ? addActivityTabCard(act) : addStudentActivityCard(act);
  const nueva = document.getElementById('activitiesList').lastElementChild;
  vieja.replaceWith(nueva);
}

/* ─── Botón de ojo: mostrar / ocultar la actividad a los alumnos ─── */
// PATCH /activities/:id/toggle-visibility — el servidor decide el valor del override con la
// misma regla que el cliente (public/js/visibilidadActividad.js) y devuelve el estado nuevo.
async function toggleActivityVisibility(actId) {
  closeActMenu();
  const act = window._activities[actId];
  if (!act) return;

  const btn = document.querySelector(`.act-student-item[data-id="${actId}"] .act-eye-btn`);
  if (btn) btn.disabled = true;

  try {
    const res  = await fetch('/activities/' + actId + '/toggle-visibility', { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'No se pudo cambiar la visibilidad'); return; }

    act.visibleOverride = data.visibleOverride;
    act.availableFrom   = data.availableFrom;
    reemplazarTarjetaActividad(actId);
  } catch (e) {
    alert('Error de conexión al cambiar la visibilidad');
    if (btn) btn.disabled = false;
  }
}

/* ─── Vista alumno: tarjeta de actividad ─── */
// Construye la tarjeta para el alumno con su estado personal
// (Calificada / Entregada / Vencida / Tardía / Pendiente — el orden es la regla, ver
// public/js/estadoActividad.js).
// act.myGrade y act.mySubmission vienen del servidor y son solo suyos: su nota, sin las del
// resto de la clase, y la fecha de su propia entrega.
function addStudentActivityCard(act) {
  window._activities[act._id] = act;
  const container = document.getElementById('activitiesList');
  const empty     = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const now       = new Date();
  const isOverdue = act.dueDate && new Date(act.dueDate) < now;

  // Estado del alumno: calificada > entregada > vencida > tardía > pendiente.
  // La regla no está acá: vive en public/js/estadoActividad.js, porque "Próximas entregas"
  // tiene que contestar lo mismo. Lo que sí se decide acá es cómo se dibuja.
  const estado = EstadoActividad.estadoParaAlumno(act, now);

  const icono = estado.icono
    ? `<span class="material-symbols-outlined" style="font-size:12px">${estado.icono}</span>`
    : '';
  const statusChip = `<span class="act-status-chip ${estado.css}">${icono}${estado.etiqueta}</span>`;

  // La nota, solo cuando la hay. Muestra el máximo si está definido.
  const gradeText = estado.clave === 'calificada'
    ? `<span class="act-grade-text">${act.myGrade.points}${act.points != null ? ' / ' + act.points + ' pts' : ' pts'}</span>`
    : '';

  let dateText = '', dateClass = '';
  if (EstadoActividad.yaEntregada(act)) {
    // Al que ya entregó no se le pone en rojo "Venció el 12/8": el plazo dejó de ser su
    // problema. La fecha que le sirve es la de su entrega.
    dateText = 'Entregado: ' + Fecha.diaMes(act.mySubmission.at);
  } else if (act.dueDate) {
    const dueFmt = Fecha.diaMesHora(act.dueDate);
    dateText  = (isOverdue ? 'Venció: ' : 'Entrega: ') + dueFmt;
    dateClass = isOverdue ? ' date-overdue' : ''; // Clase CSS que pone el texto en rojo
  } else {
    dateText = 'Publicado: ' + Fecha.diaMes(act.createdAt);
  }

  const tc        = typeConfig(act.type);
  const typeLabel = tc.label + (act.points != null ? ' · ' + act.points + ' pts' : '');

  const c1      = tc.color || window.COURSE_COLOR  || '#1a73e8';
  const c2      = tc.color ? '' : (window.COURSE_COLOR2 || '');
  const thumbBg = c2
    ? `background: linear-gradient(135deg, ${c1}, ${c2})`
    : `background: ${c1}`;

  const div = document.createElement('div');
  div.className  = 'act-student-item';
  div.dataset.id = act._id;
  div.onclick    = () => openActivityDetail(act._id);
  div.innerHTML = `
    <div class="act-thumb" style="${thumbBg}">
      <span class="material-symbols-outlined">${tc.icon}</span>
    </div>
    <div class="act-content">
      <div class="act-type-label">${typeLabel}</div>
      <div class="act-item-title">${act.title}</div>
      <div class="act-item-date${dateClass}">${dateText}</div>
    </div>
    <div class="act-status-col">
      ${statusChip}
      ${gradeText}
    </div>
  `;
  container.appendChild(div);
}

/* ─── Menú contextual de actividad (solo docente) ──�� */
let _actMenuEl = null; // Referencia al menú abierto; permite cerrarlo si se abre otro

// Abre o cierra el menú contextual de una actividad
// Posiciona el dropdown debajo del botón ⋮ usando getBoundingClientRect
function toggleActivityMenu(e, actId) {
  e.stopPropagation(); // Evita que el click del botón dispare el onclick de la tarjeta
  if (_actMenuEl && _actMenuEl.dataset.id === actId) { closeActMenu(); return; }
  closeActMenu(); // Cierra el menú anterior si había uno abierto

  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();

  const act         = window._activities[actId];
  const actIsOverdue = act && act.dueDate && new Date(act.dueDate) < new Date();

  _actMenuEl             = document.createElement('div');
  _actMenuEl.className   = 'act-dropdown';
  _actMenuEl.dataset.id  = actId;
  _actMenuEl.innerHTML = `
    <button onclick="openEditModal('${actId}')">
      <span class="material-symbols-outlined">edit</span> Editar
    </button>
    <button onclick="copyActivityLink('${actId}')">
      <span class="material-symbols-outlined">link</span> Copiar enlace
    </button>
    ${actIsOverdue ? `<button onclick="toggleLateSubmissions('${actId}')">
      <span class="material-symbols-outlined">${act.allowLateSubmissions ? 'lock' : 'lock_open'}</span>
      ${act.allowLateSubmissions ? 'Cerrar entregas tardías' : 'Habilitar entregas tardías'}
    </button>` : ''}
    <button onclick="deleteActivity('${actId}')">
      <span class="material-symbols-outlined">delete</span> Eliminar
    </button>
  `;
  // Posiciona el dropdown justo debajo y alineado a la derecha del botón ⋮
  _actMenuEl.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  _actMenuEl.style.left = Math.max(8, rect.right + window.scrollX - 168) + 'px';
  document.body.appendChild(_actMenuEl);
}

// Elimina el menú contextual del DOM
function closeActMenu() {
  if (_actMenuEl) { _actMenuEl.remove(); _actMenuEl = null; }
}
// Click en cualquier parte de la página cierra el menú abierto
document.addEventListener('click', closeActMenu);

// Elimina una actividad con confirmación
// DELETE /activities/:id — cascada completa en el servidor (entregas + archivos + doc)
async function deleteActivity(actId) {
  closeActMenu();
  if (!confirm('¿Eliminar esta actividad? No se puede deshacer.')) return;

  const res = await fetch('/activities/' + actId, { method: 'DELETE' });
  if (!res.ok) { alert('Error al eliminar la actividad.'); return; }

  delete window._activities[actId]; // Limpia del cache local
  const row = document.querySelector(`.act-student-item[data-id="${actId}"]`);
  if (row) row.remove();

  // Si no quedan actividades, muestra el estado vacío
  const container = document.getElementById('activitiesList');
  if (!container.querySelector('.act-student-item')) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">assignment</span></div><p>Aún no hay actividades</p></div>';
  }
}

// Habilita o deshabilita entregas tardías desde el menú ⋮ de la tarjeta
// PATCH /activities/:id/toggle-late → invierte allowLateSubmissions en el servidor
// Actualiza el cache local y el chip visual en la tarjeta sin recargar
async function toggleLateSubmissions(actId) {
  closeActMenu();
  const res = await fetch('/activities/' + actId + '/toggle-late', { method: 'PATCH' });
  if (!res.ok) { alert('Error al actualizar'); return; }
  const data = await res.json();

  // Sincroniza el cache local con el nuevo estado
  if (window._activities[actId]) window._activities[actId].allowLateSubmissions = data.allowLateSubmissions;

  // Actualiza el chip en la tarjeta sin reconstruirla completa
  const chip = document.querySelector(`.overdue-chip[data-actid="${actId}"]`);
  if (chip) {
    chip.className = 'overdue-chip ' + (data.allowLateSubmissions ? 'overdue-open' : 'overdue-closed');
    chip.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px">${data.allowLateSubmissions ? 'lock_open' : 'lock'}</span> ${data.allowLateSubmissions ? 'Tardías habilitadas' : 'Plazo vencido'}`;
  }
}

// Habilita o deshabilita entregas tardías desde el modal de detalle de actividad
// Actualiza tanto el chip en la lista como la barra de control en el modal
async function toggleLateFromDetail(actId) {
  const res = await fetch('/activities/' + actId + '/toggle-late', { method: 'PATCH' });
  if (!res.ok) { alert('Error al actualizar'); return; }
  const data = await res.json();

  if (window._activities[actId]) window._activities[actId].allowLateSubmissions = data.allowLateSubmissions;

  // Actualiza chip en la lista (si el tab de actividades está cargado)
  const chip = document.querySelector(`.overdue-chip[data-actid="${actId}"]`);
  if (chip) {
    chip.className = 'overdue-chip ' + (data.allowLateSubmissions ? 'overdue-open' : 'overdue-closed');
    chip.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px">${data.allowLateSubmissions ? 'lock_open' : 'lock'}</span> ${data.allowLateSubmissions ? 'Tardías habilitadas' : 'Plazo vencido'}`;
  }

  // Actualiza la barra de control visible dentro del modal de detalle
  const bar = document.getElementById('overdueControlBar');
  if (bar) {
    const allowed = data.allowLateSubmissions;
    bar.className = 'overdue-control-bar ' + (allowed ? 'is-open' : 'is-closed');
    bar.querySelector('.overdue-control-left').className = 'overdue-control-left ' + (allowed ? 'open' : 'closed');
    bar.querySelector('.overdue-label').textContent      = allowed ? 'Entregas tardías activas' : 'Plazo vencido — entregas cerradas';
    const btn = bar.querySelector('button');
    btn.className = 'btn ' + (allowed ? 'btn-outline' : 'btn-primary');
    btn.innerHTML = `<span class="material-symbols-outlined">${allowed ? 'lock' : 'lock_open'}</span> ${allowed ? 'Cerrar' : 'Habilitar'}`;
  }
}

// Copia la URL del curso al portapapeles (no la de la actividad individual, que no tiene URL propia)
function copyActivityLink(actId) {
  closeActMenu();
  const url = window.location.origin + '/courses/' + window.COURSE_ID;
  navigator.clipboard.writeText(url).then(() => {
    const toast = document.createElement('div');
    toast.className = 'card-copied-toast';
    toast.textContent = 'Enlace copiado';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  });
}

/* ─── Modal Editar Actividad ─── */
// Abre el modal de edición pre-llenado con los datos actuales de la actividad
// Los campos datetime-local requieren conversión de UTC a hora local para que el input muestre la hora correcta
function openEditModal(actId) {
  closeActMenu();
  const act = window._activities[actId];
  if (!act) return;

  document.getElementById('editActivityId').value  = actId;
  document.getElementById('editTitle').value       = act.title || '';
  document.getElementById('editType').value        = act.type || 'tarea';
  document.getElementById('editDesc').value        = act.description || '';
  document.getElementById('editPoints').value      = act.points ?? '';

  // Convierte fecha UTC a cadena local "YYYY-MM-DDTHH:MM" que espera el input datetime-local
  function toLocal(d) {
    if (!d) return '';
    const dt = new Date(d);
    dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset()); // Ajusta a timezone local
    return dt.toISOString().slice(0, 16);
  }
  document.getElementById('editDueDate').value       = toLocal(act.dueDate);
  document.getElementById('editAvailableFrom').value = toLocal(act.availableFrom);
  // Al abrir ya tiene que decir si esta actividad está programada, no solo al tocar la fecha
  avisoProgramada('editAvailableFrom', 'editAvailableHint');
  // `!== false` y no `!!`: un documento sin el campo se lee como marcado. Con `!!`, abrir
  // y guardar el modal de una actividad vieja le congelaba la entrega al alumno sin que el
  // docente hubiera tocado el check.
  document.getElementById('editAllowResubmission').checked = act.allowResubmission !== false;

  document.getElementById('editError').textContent = '';
  document.getElementById('editActivityModal').classList.add('show');
  document.getElementById('editTitle').focus();
}

function closeEditModal() {
  document.getElementById('editActivityModal').classList.remove('show');
}

document.getElementById('editActivityModal')?.addEventListener('click', function (e) {
  if (e.target === this) closeEditModal();
});

// Guarda los cambios de la actividad (PUT /activities/:id)
// Actualiza el cache local y los elementos del DOM sin recargar la página
async function saveEditActivity() {
  const id    = document.getElementById('editActivityId').value;
  const title = document.getElementById('editTitle').value.trim();
  const errEl = document.getElementById('editError');
  errEl.textContent = '';

  if (!title) { errEl.textContent = 'El título es requerido'; return; }

  const btn = document.getElementById('editSubmitBtn');
  btn.disabled    = true;
  btn.textContent = 'Guardando...';

  const res = await fetch('/activities/' + id, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      type:          document.getElementById('editType').value || 'tarea',
      description:   document.getElementById('editDesc').value.trim(),
      dueDate:       document.getElementById('editDueDate').value || '',
      availableFrom: document.getElementById('editAvailableFrom').value || '',
      points:        document.getElementById('editPoints').value || '',
      allowResubmission: document.getElementById('editAllowResubmission').checked,
    }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span> Guardar';

  if (!res.ok) { errEl.textContent = data.error; return; }

  // Fusiona la actividad actualizada con el cache local (preserva campos no editables como grades)
  window._activities[id] = { ...window._activities[id], ...data.activity };

  // Redibuja la tarjeta entera desde el cache ya fusionado, en vez de parchearla campo por
  // campo: la edición puede cambiar "Disponible desde" y con eso el chip Programada/Oculta,
  // el atenuado y el ícono del ojo, además del título, la fecha y el tipo.
  reemplazarTarjetaActividad(id);

  closeEditModal();
}

// Carga el tab de actividades (GET /activities/course/:courseId)
// Según window.IS_OWNER, renderiza con addActivityTabCard (docente) o addStudentActivityCard (alumno)
async function loadActivitiesTab() {
  window._activitiesTabLoaded = true;
  const container = document.getElementById('activitiesList');
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando actividades...</p></div>';

  const res  = await fetch('/activities/course/' + window.COURSE_ID);
  const data = await res.json();

  container.innerHTML = '';
  if (data.activities.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">assignment</span></div><p>Aún no hay actividades</p></div>';
    return;
  }

  // Muestra el buscador solo cuando hay actividades
  const searchWrap = document.getElementById('actSearchWrap');
  if (searchWrap) searchWrap.style.display = '';

  // window.IS_OWNER viene de course.ejs: true si el usuario autenticado es el owner del curso
  data.activities.forEach(act => window.IS_OWNER ? addActivityTabCard(act) : addStudentActivityCard(act));
}

// Filtra las tarjetas de actividades en tiempo real según el texto ingresado
// Busca en título y en el label de tipo (ej: "Evaluación", "Trabajo Práctico")
// Muestra un mensaje si ninguna tarjeta coincide con la búsqueda
function filterActivities(query) {
  const q      = query.trim().toLowerCase();
  const items  = document.querySelectorAll('#activitiesList .act-student-item');
  let   visible = 0;

  items.forEach(item => {
    const title = item.querySelector('.act-item-title')?.textContent?.toLowerCase() || '';
    const type  = item.querySelector('.act-type-label')?.textContent?.toLowerCase() || '';
    const match = !q || title.includes(q) || type.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  // Muestra o quita el mensaje "sin resultados"
  const container = document.getElementById('activitiesList');
  let   noResults = container.querySelector('.act-no-results');
  if (visible === 0 && items.length > 0) {
    if (!noResults) {
      noResults = document.createElement('div');
      noResults.className = 'act-no-results empty-state small';
      noResults.innerHTML = '<p>No hay actividades que coincidan con "<strong></strong>"</p>';
      container.appendChild(noResults);
    }
    noResults.querySelector('strong').textContent = query.trim();
  } else if (noResults) {
    noResults.remove();
  }
}

/* ─── Gradebook del docente ─── */
// Flag para evitar recargar el gradebook si ya fue cargado
window._calificacionesTabLoaded = false;

// Carga y renderiza la tabla de calificaciones (GET /courses/:id/gradebook)
// La tabla muestra alumnos × actividades con las notas y la media de cada actividad
async function loadCalificacionesTab() {
  window._calificacionesTabLoaded = true;
  const container = document.getElementById('calificacionesList');
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando calificaciones...</p></div>';

  const res = await fetch('/courses/' + window.COURSE_ID + '/gradebook');
  if (!res.ok) {
    container.innerHTML = '<p style="color:var(--danger);padding:20px">Error al cargar calificaciones.</p>';
    return;
  }
  renderGradebook(await res.json(), container);
}

// Construye la tabla HTML del gradebook a partir de { activities, students, gradeMap }
// gradeMap[actId][studentId] = points (puede ser undefined si no fue calificado)
function renderGradebook({ activities, students, gradeMap }, container) {
  if (activities.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">assignment</span></div><p>Aún no hay actividades</p></div>';
    return;
  }

  // Calcula el promedio de notas de una actividad (solo calificaciones existentes)
  function calcAvg(actId) {
    const vals = students.map(s => gradeMap[actId]?.[s._id]).filter(v => v != null);
    if (!vals.length) return null;
    return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  }

  function fmtDue(d) {
    if (!d) return 'Sin fecha';
    return Fecha.diaMes(d);
  }

  // Encabezados de columnas: una por actividad
  const actCols = activities.map(act => `
    <th class="gb-act-col">
      <div class="gb-act-date">${fmtDue(act.dueDate)}</div>
      <div class="gb-act-title" onclick="openActivityDetail('${act._id}')" title="${act.title}">${act.title}</div>
      <div class="gb-act-pts">${act.points != null ? 'de ' + act.points : 'sin puntos'}</div>
    </th>`).join('');

  // Fila de promedios de la clase (media por actividad)
  const avgCols = activities.map(act => {
    const avg = calcAvg(act._id.toString());
    return `<td class="gb-avg-cell">${avg != null ? avg : '—'}</td>`;
  }).join('');

  // Filas de alumnos con sus notas
  const studentRows = students.length === 0
    ? `<tr><td colspan="${activities.length + 1}" class="gb-empty-row">No hay alumnos inscriptos</td></tr>`
    : students.map(s => {
        const cells = activities.map(act => {
          const actId = act._id.toString();
          const pts   = gradeMap[actId]?.[s._id] ?? '';
          const max   = act.points != null ? act.points : '';
          return `<td class="gb-cell">
            <div class="gb-grade-wrap">
              <span class="gb-grade-display">${pts !== '' ? pts : '—'}</span>
              ${max !== '' && pts !== '' ? `<span class="gb-grade-max">/${max}</span>` : ''}
            </div>
          </td>`;
        }).join('');
        return `<tr class="gb-student-row">
          <td class="gb-student-col gb-student-name">
            <div class="avatar" style="width:28px;height:28px;font-size:13px">${s.name.charAt(0).toUpperCase()}</div>
            <span>${s.name}</span>
          </td>
          ${cells}
        </tr>`;
      }).join('');

  container.innerHTML = `
    <div class="gradebook-wrap">
      <table class="gradebook">
        <thead>
          <tr class="gb-header-row">
            <th class="gb-student-col"></th>
            ${actCols}
          </tr>
          <tr class="gb-avg-row">
            <td class="gb-student-col gb-avg-label">
              <span class="material-symbols-outlined" style="font-size:18px">group</span>
              Media de la clase
            </td>
            ${avgCols}
          </tr>
        </thead>
        <tbody>${studentRows}</tbody>
      </table>
    </div>`;
}

// Guarda una nota individual desde el gradebook inline (POST /activities/:id/grade)
// Se llama desde el evento blur/change del input de nota en la tabla
async function saveGradeFromGradebook(activityId, studentId, input) {
  const val = input.value.trim();
  if (val === '') return;

  // Misma regla que el servidor (public/js/devoluciones.js): la nota mínima es 1. Se valida
  // acá además de allá para poder DECIR por qué, que en esta tabla es lo único que hay: el
  // guardado es inline, sin botón ni cartel, así que un rechazo silencioso se lee como
  // "escribí un 0 y no pasó nada".
  const veredicto = notaValidaManual(val, input.max ? Number(input.max) : null);
  if (!veredicto.ok) {
    alert(veredicto.error);
    input.focus();
    return;
  }

  input.style.opacity = '0.5'; // Feedback visual de guardado en progreso
  const res = await fetch('/activities/' + activityId + '/grade', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ studentId, points: veredicto.points }),
  });
  input.style.opacity = '1';
  if (res.ok) {
    input.classList.add('gb-saved');
    setTimeout(() => input.classList.remove('gb-saved'), 1800); // Animación de "guardado"
  } else {
    // Antes un rechazo del servidor no se veía en ningún lado y la nota quedaba en pantalla
    // como si se hubiera guardado.
    const d = await res.json().catch(() => ({}));
    alert(d.error || 'No se pudo guardar la nota.');
  }
}

/* ─── Modal Detalle de Actividad ─── */
// Abre el modal y carga los detalles según el rol del usuario
function openActivityDetail(activityId) {
  document.getElementById('activityDetailModal').classList.add('show');
  document.getElementById('detailBody').innerHTML = '<div class="empty-state" style="padding:40px 0"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando...</p></div>';
  // Carga diferente según si es el docente o un alumno
  if (window.IS_OWNER) loadTeacherDetail(activityId);
  else                 loadStudentDetail(activityId);
}

function closeActivityDetail() {
  document.getElementById('activityDetailModal').classList.remove('show');
}

// Abre una actividad desde afuera de la solapa: la usan el botón "Ver actividad" del chat de
// la sala en vivo y el link directo ?actividad=<id>.
//
// No alcanza con openActivityDetail(): el detalle se arma sobre window._activities, que se
// llena recién cuando la solapa Actividades se carga. Un alumno que toca el botón estando en
// "En vivo" nunca la abrió, así que primero hay que traer la lista.
//
// Se carga ANTES de cambiar de solapa a propósito: loadActivitiesTab() deja
// _activitiesTabLoaded en true, y así el click de la solapa no dispara una segunda carga
// contra el mismo contenedor.
async function abrirActividad(activityId) {
  if (!activityId) return;
  if (!window._activities[activityId]) await loadActivitiesTab();

  const tab = document.querySelector('.tab[data-tab="activities"]');
  if (tab && !tab.classList.contains('active')) tab.click();

  // Puede no estar: el docente la borró, o la programó con "disponible desde" a futuro y el
  // alumno todavía no la ve (GET /activities/course/:id se las filtra). Decirlo es mejor que
  // abrir un modal vacío.
  if (!window._activities[activityId]) {
    alert('Esa actividad ya no está disponible.');
    return;
  }
  openActivityDetail(activityId);
}

document.getElementById('activityDetailModal')?.addEventListener('click', function (e) {
  if (e.target === this) closeActivityDetail();
});

// Escape cierra el modal de adjunto primero; si no hay, cierra el modal de actividad
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.att-preview-overlay')) { closeAttPreview(); return; }
  closeActivityModal(); closeActivityDetail();
});

// Construye la sección de adjuntos del docente para el modal de detalle
function attachmentSection(attachments) {
  if (!attachments || attachments.length === 0) return '';
  return `<div style="margin-top:16px">
    <p style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--text-hint);margin-bottom:8px">Adjuntos</p>
    <div class="att-list">${buildAttachmentListHTML(attachments)}</div>
  </div>`;
}

// Carga el detalle de actividad para el DOCENTE
// "Permitir que lo rehaga": la salida del docente para los dos casos que la regla sola no
// cubre — ya le puso nota pero quiere que el trabajo se rehaga igual, o corrigió por error.
// La reapertura le gana a la nota, al plazo vencido y al check destildado, y se apaga sola
// cuando vuelve a poner nota. Ver specs/edicion-de-la-entrega.spec.md.
function botonRehacer(actId, studentId, sub) {
  if (!sub) return '';
  return sub.reopenedAt
    ? `<button class="gt-rehacer is-open" onclick="permitirRehacer('${actId}','${studentId}',false)"
        title="Volver a cerrarle la entrega">
        <span class="material-symbols-outlined">lock_open_right</span>Puede rehacerla · cerrar
      </button>`
    : `<button class="gt-rehacer" onclick="permitirRehacer('${actId}','${studentId}',true)"
        title="Habilitar a este alumno a rehacer su entrega, aunque ya tenga nota o haya vencido el plazo">
        <span class="material-symbols-outlined">lock_open_right</span>Permitir que lo rehaga
      </button>`;
}

// Llama a POST /activities/:id/reopen-submission y redibuja la tabla. Se recarga entera y no
// solo el botón porque la celda muestra también la fecha de actualización de la entrega, que
// cambia en cuanto el alumno rehace.
async function permitirRehacer(actId, studentId, reabrir) {
  try {
    const res = await fetch('/activities/' + actId + '/reopen-submission', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ studentId, reabrir }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showUploadErrModal('No se pudo cambiar la entrega', data.error || 'Error'); return; }
    await loadTeacherDetail(actId);
  } catch {
    showUploadErrModal('Error de conexión', 'No se pudo cambiar la entrega. Verificá tu conexión.');
  }
}

// Hace dos fetches en paralelo: grades (notas por alumno) y submissions (entregas)
// Construye subMap (studentId → submission) para mostrar estado de entrega por alumno
async function loadTeacherDetail(activityId) {
  const body = document.getElementById('detailBody');
  const [gradesRes, subsRes, viewsRes] = await Promise.all([
    fetch('/activities/' + activityId + '/grades'),
    fetch('/activities/' + activityId + '/submissions'),
    fetch('/activities/' + activityId + '/views'),
  ]);
  if (!gradesRes.ok) { body.innerHTML = '<p style="color:var(--danger)">Error al cargar la actividad.</p>'; return; }

  const { activity, studentGrades } = await gradesRes.json();

  // Construye mapa rápido de entregas: studentId → submission (para cruzar en la tabla)
  const subMap = {};
  if (subsRes.ok) {
    const { submissions } = await subsRes.json();
    submissions.forEach(s => { subMap[s.student._id] = s; });
  }

  // Ídem para el acuse de lectura: studentId → view. Si el fetch falla, el mapa queda
  // vacío y la columna muestra "Sin abrir" en todos — degradación silenciosa, igual que
  // hace subMap: no vale la pena romper toda la tabla de notas por esto.
  const viewMap = {};
  if (viewsRes.ok) {
    const { views } = await viewsRes.json();
    views.forEach(v => { if (v.student) viewMap[v.student._id] = v; });
  }
  document.getElementById('detailTitle').textContent = activity.title;

  let html = '';
  if (activity.description) {
    html += `<p style="font-size:14px;color:var(--text-secondary);margin-bottom:16px;white-space:pre-line">${activity.description}</p>`;
  }

  // Metadatos: fecha de entrega, puntos máximos, fecha de disponibilidad
  html += '<div class="detail-meta">';
  if (activity.dueDate)       html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtLong(activity.dueDate)}</span>`;
  if (activity.points != null) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${activity.points} pts máx.</span>`;
  if (activity.availableFrom)  html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">event_available</span> Disponible: ${fmtLong(activity.availableFrom)}</span>`;
  html += '</div>';

  html += attachmentSection(activity.attachments);

  // Barra de visibilidad: siempre presente, porque el docente que abre el detalle de una
  // actividad que preparó para más adelante tiene que ver desde acá que todavía no se publicó.
  html += barraVisibilidad(activity);

  // Barra de control de entregas tardías (solo visible si el plazo venció)
  if (activity.dueDate && new Date(activity.dueDate) < new Date()) {
    const allowed = activity.allowLateSubmissions;
    html += `<div class="overdue-control-bar ${allowed ? 'is-open' : 'is-closed'}" id="overdueControlBar">
      <div class="overdue-control-left ${allowed ? 'open' : 'closed'}">
        <span class="material-symbols-outlined" style="font-size:17px">${allowed ? 'lock_open' : 'lock'}</span>
        <span class="overdue-label">${allowed ? 'Entregas tardías activas' : 'Plazo vencido — entregas cerradas'}</span>
      </div>
      <div class="overdue-control-right">
        <button class="btn ${allowed ? 'btn-outline' : 'btn-primary'}" onclick="toggleLateFromDetail('${activity._id}')">
          <span class="material-symbols-outlined">${allowed ? 'lock' : 'lock_open'}</span>
          ${allowed ? 'Cerrar' : 'Habilitar'}
        </button>
      </div>
    </div>`;
  }

  const graded    = studentGrades.filter(s => s.points != null).length;
  const submitted = Object.keys(subMap).length;
  // Solo cuenta a los alumnos que siguen inscriptos: si uno se dio de baja, su registro de
  // vista sigue en la base pero no aparece en la tabla, y el resumen tiene que coincidir.
  const viewed    = studentGrades.filter(s => viewMap[s._id]).length;
  // Lo guardado que el alumno TODAVÍA NO VE. Va en ámbar y solo si hay: es el número que le
  // falta al docente que corrigió en borrador y se olvidó de devolver (RN-27b).
  const borradores = studentGrades.filter(s => s.points != null && !Correccion.estaDevuelta(s)).length;
  const sinLeer    = Object.values(subMap).filter(sub => sub.unreadForTeacher).length;

  if (studentGrades.length === 0) {
    html += '<div class="empty-state small" style="margin-top:24px"><p>No hay alumnos inscriptos</p></div>';
  } else {
    html += `<div class="gt-summary">
      <span><span class="gt-summary-val" style="color:var(--secondary)">${graded}</span>/<span>${studentGrades.length}</span> calificados</span>
      <span class="gt-summary-sep">·</span>
      <span><span class="gt-summary-val" style="color:var(--primary)">${submitted}</span>/<span>${studentGrades.length}</span> entregaron</span>
      <span class="gt-summary-sep">·</span>
      <span><span class="gt-summary-val" style="color:var(--text-secondary)">${viewed}</span>/<span>${studentGrades.length}</span> vieron</span>
      ${borradores ? `<span class="gt-summary-sep">·</span>
      <span class="gt-summary-borradores" title="Notas guardadas que el alumno todavía no ve">
        <span class="gt-summary-val">${borradores}</span> sin devolver</span>` : ''}
      ${sinLeer ? `<span class="gt-summary-sep">·</span>
      <span class="gt-summary-sinleer" title="Entregas con comentarios sin leer">
        <span class="gt-summary-val">${sinLeer}</span> con comentarios sin leer</span>` : ''}
    </div>
    <div class="grade-table-wrap"><table class="grade-table">
      <thead><tr>
        <th class="gt-col-student">Alumno</th>
        <th class="gt-col-grade">Nota${activity.points != null ? `<span class="gt-pts-max"> / ${activity.points}</span>` : ''}</th>
        <th class="gt-col-feedback">Devolución al alumno</th>
        <th class="gt-col-view">Visto</th>
        <th class="gt-col-sub">Entrega</th>
      </tr></thead>
      <tbody>`;

    // Snapshot de lo que había al abrir el modal: saveAllGrades manda solo las filas tocadas.
    // Se guarda acá (y no en data-attributes) porque el feedback puede traer comillas y saltos
    // de línea que en un atributo HTML habría que escapar a mano.
    window._devolucionesOriginales = {};
    studentGrades.forEach(sg => {
      window._devolucionesOriginales[sg._id] = {
        nota:     sg.points ?? '',
        feedback: sg.feedback || '',
      };
    });

    studentGrades.forEach(sg => {
      const sub          = subMap[sg._id];
      const subFirstDate = sub?.firstSubmittedAt || sub?.createdAt;
      const subIsUpdated = sub && subFirstDate && Math.abs(new Date(subFirstDate) - new Date(sub.updatedAt)) > 2000;

      const subCell = sub
        ? `<div class="gt-sub-delivered">
            <span class="gt-sub-badge gt-sub-ok">
              <span class="material-symbols-outlined">check_circle</span>Entregado
            </span>
            <span class="gt-sub-date">${fmtShort(subFirstDate)}</span>
            ${subIsUpdated ? `<span class="gt-sub-date" style="color:var(--text-hint)">
              <span class="material-symbols-outlined" style="font-size:11px;vertical-align:-1px">update</span>
              Act: ${fmtShort(sub.updatedAt)}</span>` : ''}
            ${sub.text ? `<p class="gt-sub-text" title="${sub.text}">${sub.text}</p>` : ''}
            ${sub.files.map(f => `<span class="gt-sub-file" style="cursor:pointer"
              data-att-type="file" data-att-name="${escAtt(f.name)}"
              data-att-url="${escAtt('/activities/submission-file/' + f.filename)}" data-att-mime="${f.mime||''}"
              onclick="handleAttachmentClick(this)" role="button" tabindex="0">
              <span class="material-symbols-outlined">attach_file</span>${f.name}</span>`).join('')}
            ${botonRehacer(activity._id, sg._id, sub)}
          </div>`
        : `<span class="gt-sub-badge gt-sub-pending">
            <span class="material-symbols-outlined">schedule</span>Pendiente
           </span>`;

      // Acuse de lectura. "Sin abrir" va en gris y no en rojo a propósito: no haber abierto
      // todavía no es una falta, es información para que el docente sepa a quién avisarle.
      const view = viewMap[sg._id];
      const viewCell = view
        ? `<div class="gt-sub-delivered">
            <span class="gt-sub-badge gt-view-ok">
              <span class="material-symbols-outlined">visibility</span>Visto
            </span>
            <span class="gt-sub-date">${fmtShort(view.firstViewedAt)}</span>
            ${view.viewCount > 1 ? `<span class="gt-sub-date" style="color:var(--text-hint)">
              <span class="material-symbols-outlined" style="font-size:11px;vertical-align:-1px">update</span>
              Últ: ${fmtShort(view.lastViewedAt)}</span>` : ''}
          </div>`
        : `<span class="gt-sub-badge gt-view-none">
            <span class="material-symbols-outlined">visibility_off</span>Sin abrir
           </span>`;

      html += `<tr>
        <td>
          <div class="gt-student-cell">
            <div class="avatar" style="width:34px;height:34px;font-size:15px;flex-shrink:0">${sg.name.charAt(0).toUpperCase()}</div>
            <div style="min-width:0">
              <div class="gt-student-name">${subMap[sg._id]?.unreadForTeacher
                ? '<span class="corrector-punto" title="Tiene comentarios sin leer"></span>' : ''}${sg.name}</div>
              <div class="gt-student-email">${sg.email}</div>
            </div>
          </div>
        </td>
        <td class="gt-col-grade">
          <div class="gt-grade-wrap">
            <input class="grade-input" type="number" min="${NOTA_MINIMA}" max="${activity.points || 9999}"
              value="${sg.points ?? ''}" placeholder="—" data-student="${sg._id}">
          </div>
        </td>
        <td class="gt-col-feedback">
          <textarea class="feedback-input" data-student="${sg._id}" rows="2"
            placeholder="Comentario al alumno...">${sg.feedback || ''}</textarea>
        </td>
        <td class="gt-col-view">${viewCell}</td>
        <td class="gt-col-sub">${subCell}</td>
      </tr>`;
    });

    // Estadísticas de la actividad (solo si hay calificaciones y hay puntos máximos definidos)
    const gradedEntries = studentGrades.filter(s => s.points != null);
    let statsHtml = '';
    if (gradedEntries.length > 0) {
      const pts = gradedEntries.map(s => s.points);
      const avg = (pts.reduce((a, b) => a + b, 0) / pts.length).toFixed(1);
      const minPts = Math.min(...pts);
      const maxPts2 = Math.max(...pts);
      statsHtml = `<div class="act-stats">
        <h4 style="margin:24px 0 10px;font-size:14px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">Estadísticas</h4>
        <div class="act-stats-summary">
          <div class="stat-pill"><span class="stat-pill-val">${avg}</span><span class="stat-pill-lbl">Promedio</span></div>
          <div class="stat-pill"><span class="stat-pill-val">${minPts}</span><span class="stat-pill-lbl">Mínimo</span></div>
          <div class="stat-pill"><span class="stat-pill-val">${maxPts2}</span><span class="stat-pill-lbl">Máximo</span></div>
          <div class="stat-pill"><span class="stat-pill-val">${gradedEntries.length}</span><span class="stat-pill-lbl">Calificados</span></div>
        </div>`;
      if (activity.points != null) {
        const maxPts = activity.points;
        const buckets = [
          { label: '0–50%', from: 0, to: 0.5 },
          { label: '50–70%', from: 0.5, to: 0.7 },
          { label: '70–85%', from: 0.7, to: 0.85 },
          { label: '85–100%', from: 0.85, to: 1.01 },
        ];
        const counts = buckets.map(b => pts.filter(p => { const pct = p / maxPts; return pct >= b.from && pct < b.to; }).length);
        const maxCount = Math.max(...counts, 1);
        statsHtml += `<div class="act-histogram">
          ${buckets.map((b, i) => `<div class="hist-bar-wrap">
            <div class="hist-bar-container"><div class="hist-bar" style="height:${Math.round((counts[i]/maxCount)*100)}%"></div></div>
            <div class="hist-bar-count">${counts[i]}</div>
            <div class="hist-bar-label">${b.label}</div>
          </div>`).join('')}
        </div>`;
      }
      statsHtml += `</div>`;
    }

    html += `</tbody></table></div>
      ${statsHtml}
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:20px">
        <span class="grade-saved" id="gs-all" style="font-size:13px">✓ Guardado</span>
        <button class="btn btn-outline" onclick="exportGrades('${activity._id}')">
          <span class="material-symbols-outlined">download</span> Exportar Excel
        </button>
        <button class="btn btn-outline" onclick="saveAllGrades('${activity._id}',${activity.points || 9999},{devolver:false})"
          title="Guarda las notas como borrador: el alumno todavía no las ve">
          <span class="material-symbols-outlined">save</span> Guardar sin devolver
        </button>
        <button class="btn btn-primary" onclick="saveAllGrades('${activity._id}',${activity.points || 9999})">
          <span class="material-symbols-outlined">save</span> Guardar y devolver
        </button>
      </div>`;
  }

  // Los dos modos leen del MISMO objeto en memoria: cambiar de vista no recarga nada (RN-04),
  // porque los tres fetch de arriba ya corrieron. La planilla queda envuelta pero intacta
  // (RN-01: no se saca nada), y al lado nace el contenedor vacío del corrector.
  window._detalleActual = { activity, studentGrades, subMap, viewMap };
  body.innerHTML = `<div id="modoPlanilla">${html}</div><div id="modoCorrector" hidden></div>`;

  // El toggle solo existe para quien gestiona la materia: este mismo modal lo abre el alumno.
  const toggle = document.getElementById('modoToggle');
  if (toggle) toggle.hidden = studentGrades.length === 0;
  aplicarModoCorreccion(modoCorreccionGuardado(), { guardar: false });
}

/* ─── Modo Corrector ─────────────────────────────────────────────────────────
   specs/correccion-de-entregas.spec.md. Corregir un alumno a la vez, con la entrega abierta
   a la izquierda y la nota, la devolución y los comentarios a la derecha.

   ⚠️ RN-01 es la regla que gobierna todo este bloque: NO SE SACA NADA. La planilla queda
   entera y es el modo por defecto; el corrector es otra vista de LOS MISMOS datos, que ya
   están en memoria (window._detalleActual) y no se vuelven a pedir al cambiar de modo. */

// Lo que el corrector tiene abierto. `orden` se CONGELA al entrar (RN-09): guardar una nota
// no reordena ni saca al alumno de la lista aunque deje de cumplir el filtro, porque si no,
// calificar al #7 con el filtro "Entregados sin calificar" lo expulsa en ese mismo momento y
// la flecha › salta a cualquier lado.
window._corrector = { orden: [], indice: 0, filtro: 'todos', archivos: [], archivoIdx: 0, studentId: null };

const FILTROS_CORRECTOR = [
  { id: 'todos',                   label: 'Todos' },
  { id: 'entregado_sin_calificar', label: 'Entregados sin calificar' },
  { id: 'sin_entregar',            label: 'Sin entregar' },
  { id: 'calificado',              label: 'Calificados' },
];

// El modo con el que hay que pintar AHORA MISMO, sin esperar ningún fetch. localStorage es
// cache y NUNCA la fuente de verdad: la de verdad es User.modoCorreccion, que ya vino
// renderizada en la página (RN-02).
function modoCorreccionGuardado() {
  try {
    const local = localStorage.getItem('modoCorreccion');
    if (local === 'planilla' || local === 'corrector') return local;
  } catch {}
  return window.USER_MODO_CORRECCION === 'corrector' ? 'corrector' : 'planilla';
}

/**
 * Cambia de vista. NO recarga datos (RN-04) y NO puede fallar delante de nadie (RN-03): si el
 * PATCH se cae, el modo igual cambia en pantalla y en localStorage, y no se muestra ningún
 * error. Cambiar de vista no es una operación que pueda fallar mientras alguien corrige.
 */
function aplicarModoCorreccion(modo, opciones) {
  const guardar = !(opciones && opciones.guardar === false);
  const esCorrector = modo === 'corrector' && !!window._detalleActual;

  const planilla  = document.getElementById('modoPlanilla');
  const corrector = document.getElementById('modoCorrector');
  if (!planilla || !corrector) return;

  planilla.hidden  = esCorrector;
  corrector.hidden = !esCorrector;
  const modal = document.querySelector('.modal-detail');
  if (modal) modal.classList.toggle('is-corrector', esCorrector);
  document.querySelectorAll('#modoToggle button').forEach(b => {
    b.classList.toggle('activo', b.dataset.modo === (esCorrector ? 'corrector' : 'planilla'));
  });

  if (esCorrector) entrarAlCorrector();

  try { localStorage.setItem('modoCorreccion', esCorrector ? 'corrector' : 'planilla'); } catch {}
  if (guardar) {
    fetch('/courses/profile/preferencias', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ modoCorreccion: esCorrector ? 'corrector' : 'planilla' }),
    }).catch(() => {});   // falla ABIERTO, a propósito: ver RN-03
  }
}

// La nota tal como está EN PANTALLA: lo guardado más lo que el docente escribió y todavía no
// guardó. Los dos modos escriben en el mismo lugar (RN-07), así que pasar de uno a otro con
// la nota a medio escribir no la pierde.
function notaEnPantalla(sg) {
  const nota = document.querySelector('#modoPlanilla .grade-input[data-student="' + sg._id + '"]');
  const dev  = document.querySelector('#modoPlanilla .feedback-input[data-student="' + sg._id + '"]');
  const puntos = nota
    ? (nota.value === '' ? null : Number(nota.value))
    : (sg.points ?? null);
  const grade = { points: puntos, feedback: dev ? dev.value : (sg.feedback || '') };
  // AUSENTE ≠ NULL: si el servidor no mandó `returnedAt` es una nota anterior a la feature y
  // se lee como DEVUELTA. Copiar el campo solo cuando existe es lo que conserva esa diferencia.
  if (sg.returnedAt !== undefined) grade.returnedAt = sg.returnedAt;
  return grade;
}

// Arma el armazón del corrector y congela el orden. Se llama cada vez que se entra al modo:
// el filtro elegido se conserva, pero el array se vuelve a congelar con el estado de ahora.
function entrarAlCorrector() {
  const { studentGrades, subMap } = window._detalleActual;
  const c = window._corrector;

  const alumnos = studentGrades.map(sg => ({
    studentId: sg._id,
    nombre:    sg.name,
    email:     sg.email,
    sub:       subMap[sg._id] || null,
    grade:     notaEnPantalla(sg),
  }));
  c.orden = Correccion.ordenCorreccion(alumnos, c.filtro);
  if (c.indice >= c.orden.length) c.indice = 0;

  const cont = document.getElementById('modoCorrector');
  cont.innerHTML =
    '<div class="corrector-filtros">' +
      FILTROS_CORRECTOR.map(f => '<button type="button" class="corrector-chip' + (f.id === c.filtro ? ' activo' : '') + '"' +
        ' onclick="correctorFiltrar(\'' + f.id + '\')">' + f.label + '</button>').join('') +
      '<span class="corrector-contador" id="correctorContador"></span>' +
      '<span style="flex:1"></span>' +
      '<button type="button" class="corrector-flecha" id="correctorAnterior" onclick="correctorMover(-1)" title="Alumno anterior">' +
        '<span class="material-symbols-outlined">chevron_left</span></button>' +
      '<button type="button" class="corrector-flecha" id="correctorSiguiente" onclick="correctorMover(1)" title="Alumno siguiente">' +
        '<span class="material-symbols-outlined">chevron_right</span></button>' +
    '</div>' +
    '<div class="corrector-layout">' +
      '<div class="corrector-visor" id="correctorVisor"></div>' +
      '<div class="corrector-panel" id="correctorPanel"></div>' +
    '</div>' +
    '<div class="corrector-lista" id="correctorLista"></div>';

  pintarListaCorrector();
  correctorSeleccionar(c.indice);
}

function correctorFiltrar(filtro) {
  window._corrector.filtro = filtro;
  window._corrector.indice = 0;
  entrarAlCorrector();
}

// Pasar de alumno NO guarda nada y NO dispara ningún guardado (RN-10): lo escrito queda en
// el buffer, que es el mismo de la planilla.
function correctorMover(paso) {
  const c = window._corrector;
  const nuevo = c.indice + paso;
  if (nuevo < 0 || nuevo >= c.orden.length) return;
  correctorSeleccionar(nuevo);
}

function pintarListaCorrector() {
  const c = window._corrector;
  const lista = document.getElementById('correctorLista');
  if (!lista) return;
  lista.innerHTML = c.orden.map((a, i) => {
    const estado = Correccion.estadoDeEntrega(a);
    const sinLeer = a.sub && a.sub.unreadForTeacher;
    return '<button type="button" class="corrector-item' + (i === c.indice ? ' activo' : '') + ' estado-' + estado + '"' +
      ' onclick="correctorSeleccionar(' + i + ')">' +
      (sinLeer ? '<span class="corrector-punto" title="Tiene comentarios sin leer"></span>' : '') +
      '<span class="corrector-item-nombre">' + Adjuntos.escaparTexto(a.nombre) + '</span>' +
      '</button>';
  }).join('');

  const contador = document.getElementById('correctorContador');
  if (contador) contador.textContent = c.orden.length ? (c.indice + 1) + ' de ' + c.orden.length : 'Nadie en este filtro';
  const anterior  = document.getElementById('correctorAnterior');
  const siguiente = document.getElementById('correctorSiguiente');
  if (anterior)  anterior.disabled  = c.indice <= 0;
  if (siguiente) siguiente.disabled = c.indice >= c.orden.length - 1;
}

// Abre a UN alumno: trae su detalle pesado, que además APAGA su "sin leer" y dispara el
// prefetch de las conversiones de Office (RN-16b) mientras el docente lee el panel.
async function correctorSeleccionar(indice) {
  const c = window._corrector;
  const { activity } = window._detalleActual;
  c.indice = indice;
  pintarListaCorrector();

  const alumno = c.orden[indice];
  const panel  = document.getElementById('correctorPanel');
  const visor  = document.getElementById('correctorVisor');
  if (!alumno || !panel) {
    if (panel) panel.innerHTML = '<p class="corrector-vacio">No hay ningún alumno con este filtro.</p>';
    // El visor NO se vacía: dejarlo en blanco muestra el #1f1f1f del contenedor como un
    // rectángulo negro sin explicación, que parece algo roto y no un filtro sin resultados.
    if (visor) visor.innerHTML = '<div class="corrector-visor-vacio">'
      + '<span class="material-symbols-outlined">filter_alt_off</span>'
      + '<p>Ningún alumno entra en este filtro</p>'
      + '<p class="corrector-visor-vacio-sub">Probá con otro, o volvé a «Todos».</p>'
      + '</div>';
    return;
  }
  c.studentId = alumno.studentId;
  panel.innerHTML = '<p class="corrector-vacio">Cargando…</p>';

  let detalle = { submission: alumno.sub, grade: null, view: null };
  try {
    const r = await fetch('/activities/' + activity._id + '/entrega/' + alumno.studentId);
    if (r.ok) detalle = await r.json();
  } catch {}
  // Si el docente ya pasó a otro alumno mientras viajaba la respuesta, esta no sirve más.
  if (c.studentId !== alumno.studentId) return;

  // El detalle viene con el hilo ya marcado como leído: el punto ámbar se apaga acá.
  if (alumno.sub) alumno.sub.unreadForTeacher = false;
  if (detalle.submission) alumno.sub = Object.assign({}, alumno.sub, detalle.submission);
  pintarListaCorrector();

  pintarPanelCorrector(alumno, detalle);
  c.archivos   = (detalle.submission && detalle.submission.files) || [];
  c.archivoIdx = 0;
  pintarVisorCorrector();
}

// El visor de la columna izquierda: los archivos de la entrega del alumno abierto, con una
// tira para pasar de uno a otro SIN salir del panel. Una entrega manuscrita suelen ser varias
// hojas: 751 entregas tienen 2 o más archivos, y el máximo observado es 19 (RN-05b).
function pintarVisorCorrector() {
  const c = window._corrector;
  const visor = document.getElementById('correctorVisor');
  if (!visor) return;

  if (!c.archivos.length) {
    // Misma clase que el filtro vacío, y por el mismo motivo: `.corrector-vacio` es del panel
    // claro y acá el fondo es #1f1f1f. Con la clase de antes el texto se leía apenas.
    visor.innerHTML = '<div class="corrector-visor-vacio">'
      + '<span class="material-symbols-outlined">folder_off</span>'
      + '<p>Este alumno no adjuntó ningún archivo</p>'
      + '<p class="corrector-visor-vacio-sub">Si escribió algo, lo vas a ver en el panel de la derecha.</p>'
      + '</div>';
    return;
  }

  const tira = c.archivos.map((f, i) =>
    '<button type="button" class="corrector-archivo' + (i === c.archivoIdx ? ' activo' : '') + '"' +
    ' onclick="correctorVerArchivo(' + i + ')" title="' + escAtt(f.name) + '">' +
    '<span class="material-symbols-outlined">' + (Adjuntos.esImagen(f.name) ? 'image' : 'description') + '</span>' +
    '<span class="corrector-archivo-nombre">' + Adjuntos.escaparTexto(f.name) + '</span>' +
    '</button>').join('');

  const f = c.archivos[c.archivoIdx];
  const url = '/activities/submission-file/' + f.filename;
  visor.innerHTML =
    '<div class="corrector-tira">' + tira + '</div>' +
    '<div class="corrector-lienzo" id="correctorLienzo"></div>' +
    '<div class="corrector-visor-barra">' +
      '<a class="btn btn-outline" href="' + escAtt(url + '?dl=1') + '" download="' + escAtt(f.name) + '">' +
        '<span class="material-symbols-outlined">download</span> Descargar</a>' +
    '</div>';

  // El botón Descargar de arriba NO depende de que el visor pueda mostrar algo, y es a
  // propósito: falle lo que falle —formato sin visor, conversor ausente, archivo borrado del
  // disco— el archivo que entregó el alumno se puede bajar siempre (RN-19).
  montarVisorEnPanel(document.getElementById('correctorLienzo'), {
    type: 'file', name: f.name, url, mime: f.mime, size: f.size,
  });
}

function correctorVerArchivo(i) {
  window._corrector.archivoIdx = i;
  pintarVisorCorrector();
}

/**
 * La segunda montura de RN-05: lo mismo que el overlay a pantalla completa, adentro de la
 * columna izquierda. Las dos comparten la DECISIÓN (Correccion.renderVisor y las funciones de
 * montaje): un archivo no puede previsualizarse de una manera acá y de otra allá.
 */
function montarVisorEnPanel(contenedor, att) {
  if (!contenedor) return;
  const nombre = att.name || '';
  contenedor.innerHTML = '';

  if (_isImage(nombre)) {
    const caja = document.createElement('div');
    caja.className = 'visor-img';
    contenedor.appendChild(caja);
    montarVisorDeImagen(caja, att.url, nombre);
    return;
  }
  if (_isPdf(nombre)) {
    contenedor.innerHTML = '<iframe class="att-preview-frame"></iframe>';
    contenedor.querySelector('iframe').src = att.url + '#toolbar=1';
    return;
  }
  if (_isCad(nombre)) {
    const caja = document.createElement('div');
    caja.className = 'visor-cad';
    contenedor.appendChild(caja);
    montarVisorCad(caja, att);
    return;
  }
  if (_isOffice(nombre)) {
    const caja = document.createElement('div');
    caja.className = 'visor-office';
    contenedor.appendChild(caja);
    montarVisorOffice(caja, att);
    return;
  }
  // Lo que de verdad no tiene visor (un .zip). El motivo sale del módulo compartido, así que
  // el cartel dice lo mismo acá que en el overlay y que en la API.
  const decision = Correccion.renderVisor({ name: nombre, size: att.size || 0 }, {});
  contenedor.innerHTML =
    '<div class="att-preview-no-support">' +
      '<span class="material-symbols-outlined">description</span>' +
      '<p>No se puede ver este archivo acá</p>' +
      '<p class="att-preview-no-support-sub"></p>' +
    '</div>';
  contenedor.querySelector('.att-preview-no-support-sub').textContent = decision.texto;
}

// El panel derecho: TODO lo que tiene la fila de la planilla, más el hilo y el historial. Si
// algo de la fila no estuviera acá, el Modo Corrector sería un modo con MENOS información y
// RN-01 estaría escrita para nada (RN-08).
function pintarPanelCorrector(alumno, detalle) {
  const { activity } = window._detalleActual;
  const panel = document.getElementById('correctorPanel');
  const sub   = detalle.submission;
  const view  = detalle.view;
  const grade = detalle.grade;
  const esc   = Adjuntos.escaparTexto;

  const estado = Correccion.estadoDeEntrega({ sub, grade: notaEnPantalla(
    window._detalleActual.studentGrades.find(sg => sg._id === alumno.studentId) || {}) });
  const ETIQUETA = {
    sin_entregar:            'Sin entregar',
    entregado_sin_calificar: 'Entregado, sin calificar',
    borrador:                'Calificado — sin devolver',
    devuelto:                'Devuelto',
  };

  const subFirstDate = sub && (sub.firstSubmittedAt || sub.createdAt);
  const subIsUpdated = sub && subFirstDate && Math.abs(new Date(subFirstDate) - new Date(sub.updatedAt)) > 2000;

  // El aviso de RN-26: entre el borrador y la devolución el alumno puede cambiar el archivo
  // que el docente acaba de corregir, y sin este cartel eso pasaría en silencio.
  const cambioDespues = sub && grade && grade.gradedAt && new Date(sub.updatedAt) > new Date(grade.gradedAt);

  const notaActual = document.querySelector('#modoPlanilla .grade-input[data-student="' + alumno.studentId + '"]');
  const devActual  = document.querySelector('#modoPlanilla .feedback-input[data-student="' + alumno.studentId + '"]');

  let html =
    '<div class="corrector-alumno">' +
      '<div class="avatar" style="width:38px;height:38px;font-size:16px;flex-shrink:0">' + esc(alumno.nombre.charAt(0).toUpperCase()) + '</div>' +
      '<div style="min-width:0">' +
        '<div class="gt-student-name">' + esc(alumno.nombre) + '</div>' +
        '<div class="gt-student-email">' + esc(alumno.email || '') + '</div>' +
      '</div>' +
      '<span class="corrector-estado estado-' + estado + '">' + ETIQUETA[estado] + '</span>' +
    '</div>' +
    '<div class="corrector-datos">' +
      (sub
        ? '<span><span class="material-symbols-outlined">assignment_turned_in</span> Entregó ' + fmtShort(subFirstDate) +
          (subIsUpdated ? ' · Act: ' + fmtShort(sub.updatedAt) : '') + '</span>'
        : '<span><span class="material-symbols-outlined">schedule</span> Todavía no entregó</span>') +
      (view
        ? '<span><span class="material-symbols-outlined">visibility</span> Vista ' + fmtShort(view.firstViewedAt) +
          (view.viewCount > 1 ? ' · Últ: ' + fmtShort(view.lastViewedAt) : '') + '</span>'
        : '<span><span class="material-symbols-outlined">visibility_off</span> Sin abrir</span>') +
    '</div>' +
    (cambioDespues ? '<p class="corrector-aviso"><span class="material-symbols-outlined">update</span> ' +
      'La entrega cambió después de que la corregiste.</p>' : '') +
    '<div class="corrector-campo">' +
      '<label>Nota' + (activity.points != null ? ' <span class="gt-pts-max">/ ' + activity.points + '</span>' : '') + '</label>' +
      '<input type="number" class="corrector-nota" min="' + NOTA_MINIMA + '" max="' + (activity.points || 9999) + '"' +
        ' value="' + (notaActual ? escAtt(notaActual.value) : '') + '" placeholder="—"' +
        ' oninput="correctorSincronizarNota(this)">' +
    '</div>' +
    '<div class="corrector-campo">' +
      '<label>Devolución al alumno</label>' +
      '<textarea class="corrector-feedback" rows="4" placeholder="Comentario al alumno..."' +
        ' oninput="correctorSincronizarFeedback(this)"></textarea>' +
    '</div>' +
    '<div class="corrector-acciones">' +
      '<button type="button" class="btn btn-outline" onclick="correctorGuardar(false)">' +
        '<span class="material-symbols-outlined">save</span> Guardar</button>' +
      '<button type="button" class="btn btn-devolver" onclick="correctorDevolver()">' +
        '<span class="material-symbols-outlined">assignment_return</span> Devolver</button>' +
      '<span class="grade-saved" id="gs-corrector" style="font-size:13px"></span>' +
    '</div>';

  // Archivos + Rehacer: lo mismo que ofrece la celda "Entrega" de la planilla.
  if (sub) {
    html += '<div class="corrector-bloque"><h5>Archivos</h5>' +
      ((sub.files || []).map((f, i) =>
        '<div class="corrector-archivo-fila">' +
          '<button type="button" class="corrector-archivo-link" onclick="correctorVerArchivo(' + i + ')">' +
            '<span class="material-symbols-outlined">attach_file</span>' + esc(f.name) + '</button>' +
          '<a class="corrector-bajar" href="' + escAtt('/activities/submission-file/' + f.filename + '?dl=1') + '"' +
            ' download="' + escAtt(f.name) + '" title="Descargar"><span class="material-symbols-outlined">download</span></a>' +
        '</div>').join('') || '<p class="corrector-vacio">Sin archivos adjuntos.</p>') +
      (sub.text ? '<p class="gt-sub-text">' + esc(sub.text) + '</p>' : '') +
      botonRehacer(activity._id, alumno.studentId, sub) +
      '</div>';
  }

  // El hilo privado, en los dos sentidos (RN-31). Existe cuando existe la entrega: al que no
  // entregó se le muestra la caja deshabilitada con el motivo, en vez de dejarlo adivinando.
  html += '<div class="corrector-bloque"><h5>Comentarios privados</h5><div class="corrector-hilo" id="correctorHilo"></div>';
  if (sub) {
    html += '<div class="corrector-comentar">' +
      '<textarea id="correctorComentario" rows="2" maxlength="2000" placeholder="Escribile al alumno..."></textarea>' +
      '<button type="button" class="btn btn-outline" onclick="correctorComentar()">' +
        '<span class="material-symbols-outlined">send</span></button></div>';
  } else {
    html += '<p class="corrector-vacio">El hilo se abre con la entrega.</p>';
  }
  html += '</div>';

  // El historial, como línea de tiempo: la actual arriba, marcada, y cada versión con sus
  // archivos (que se abren y se bajan igual que los de ahora, RN-37).
  const versiones = (sub && sub.versions) || [];
  if (versiones.length) {
    html += '<div class="corrector-bloque"><h5>Historial de la entrega</h5>' +
      '<div class="corrector-version actual"><b>Actual</b> · ' + fmtShort(sub.updatedAt) + ' · ' +
        (sub.files || []).length + ' archivo(s)</div>' +
      versiones.map((v, i) =>
        '<div class="corrector-version"><b>Versión ' + (versiones.length - i) + '</b> · ' + fmtShort(v.at) + ' · ' +
          (v.files || []).length + ' archivo(s)' +
          (v.files || []).map(f =>
            '<a class="corrector-version-archivo" href="' + escAtt('/activities/submission-file/' + f.filename) + '"' +
            ' target="_blank" rel="noopener">' + esc(f.name) + '</a>').join('') +
        '</div>').join('') +
      '</div>';
  }

  panel.innerHTML = html;

  // El textarea se llena por textContent y no por interpolación: lo escribió el docente, pero
  // pasa por el mismo camino que el resto y así no hay una excepción que recordar.
  const dev = panel.querySelector('.corrector-feedback');
  if (dev) dev.value = devActual ? devActual.value : '';

  pintarHiloCorrector((sub && sub.privateComments) || []);
}

// El texto de cada comentario va por textContent, NUNCA por innerHTML: lo escribió un alumno.
function pintarHiloCorrector(comentarios) {
  const hilo = document.getElementById('correctorHilo');
  if (!hilo) return;
  hilo.innerHTML = '';
  if (!comentarios.length) {
    const vacio = document.createElement('p');
    vacio.className = 'corrector-vacio';
    vacio.textContent = 'Todavía no hay comentarios.';
    hilo.appendChild(vacio);
    return;
  }
  for (const c of comentarios) {
    const caja = document.createElement('div');
    caja.className = 'corrector-mensaje ' + (c.from === 'teacher' ? 'mio' : 'suyo');
    const quien = document.createElement('span');
    quien.className = 'corrector-mensaje-quien';
    quien.textContent = (c.from === 'teacher' ? 'Vos' : 'El alumno') + ' · ' + fmtShort(c.at);
    const texto = document.createElement('p');
    texto.textContent = c.text;
    caja.append(quien, texto);
    hilo.appendChild(caja);
  }
  hilo.scrollTop = hilo.scrollHeight;
}

// ── El buffer compartido con la planilla (RN-07) ───────────────────────────
//
// El panel NO tiene un buffer propio: escribe en los MISMOS inputs de la planilla, que siguen
// en el DOM aunque estén ocultos. Por eso cambiar de modo con la nota escrita y sin guardar no
// la pierde, y por eso `saveAllGrades` y `recolectarDevoluciones` no se tocaron: lo que se
// manda al servidor lo sigue decidiendo la planilla.
function correctorSincronizarNota(input) {
  const destino = document.querySelector('#modoPlanilla .grade-input[data-student="' + window._corrector.studentId + '"]');
  if (destino) destino.value = input.value;
}

function correctorSincronizarFeedback(textarea) {
  const destino = document.querySelector('#modoPlanilla .feedback-input[data-student="' + window._corrector.studentId + '"]');
  if (destino) destino.value = textarea.value;
}

function avisoCorrector(texto) {
  const el = document.getElementById('gs-corrector');
  if (!el) return;
  el.textContent = texto;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// "Guardar" del Modo Corrector = guardar SIN devolver (RN-27b). Reusa saveAllGrades entero:
// manda todas las filas tocadas, no solo la del alumno abierto, que es justamente el flujo
// "corrijo los 30 y los devuelvo juntos".
async function correctorGuardar(devolver) {
  const { activity } = window._detalleActual;
  const guardadas = await saveAllGrades(activity._id, activity.points || 9999, { devolver: !!devolver });
  // El cartel de saveAllGrades vive adentro de la planilla, que en este modo está oculta: el
  // corrector muestra el suyo, y dice lo mismo.
  avisoCorrector(guardadas
    ? '✓ ' + guardadas + ' guardada(s)' + (devolver ? '' : ' — sin devolver todavía')
    : 'No había cambios para guardar');
  return guardadas;
}

// "Devolver": primero guarda lo que haya escrito (como borrador, para no publicar nada dos
// veces) y después publica al alumno abierto con POST /:id/devolver, que es la ruta que
// escribe `returnedAt` sin tocar ni la nota ni la devolución.
async function correctorDevolver() {
  const { activity } = window._detalleActual;
  const c = window._corrector;
  if (!c.studentId) return;

  await saveAllGrades(activity._id, activity.points || 9999, { devolver: false });

  let res;
  try {
    res = await fetch('/activities/' + activity._id + '/devolver', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ studentIds: [c.studentId] }),
    });
  } catch {
    alert('No se pudo devolver: se cortó la conexión con el servidor.');
    return;
  }
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(datos.error || 'No se pudo devolver la corrección.');
    return;
  }
  avisoCorrector('✓ Devuelta');

  // El alumno ya la ve: el estado del ítem de la lista y el del panel tienen que reflejarlo
  // sin recargar el modal entero.
  const sg = window._detalleActual.studentGrades.find(s => s._id === c.studentId);
  if (sg) sg.returnedAt = new Date().toISOString();
  const alumno = c.orden[c.indice];
  if (alumno) alumno.grade = notaEnPantalla(sg || {});
  pintarListaCorrector();
  correctorSeleccionar(c.indice);
}

// El comentario del docente. Llega SIEMPRE, esté la nota devuelta o en borrador: durante el
// borrador la entrega sigue abierta, así que el alumno puede hacer lo que se le pide (RN-31).
async function correctorComentar() {
  const { activity } = window._detalleActual;
  const c = window._corrector;
  const caja = document.getElementById('correctorComentario');
  if (!caja || !caja.value.trim()) return;

  const texto = caja.value.trim();
  caja.disabled = true;
  let res;
  try {
    res = await fetch('/activities/' + activity._id + '/entrega/' + c.studentId + '/comentario', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ texto }),
    });
  } catch {
    caja.disabled = false;
    alert('No se pudo enviar el comentario: se cortó la conexión.');
    return;
  }
  caja.disabled = false;
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(datos.error || 'No se pudo enviar el comentario.');
    return;
  }
  caja.value = '';
  const alumno = c.orden[c.indice];
  if (alumno && alumno.sub) {
    alumno.sub.privateComments = (alumno.sub.privateComments || []).concat(datos.comentario);
    pintarHiloCorrector(alumno.sub.privateComments);
  }
}

// Guarda de una sola vez las notas Y las devoluciones escritas del modal de detalle.
// Manda una request por fila tocada; la devolución se guarda aunque la nota esté vacía
// (ver public/js/devoluciones.js para la lógica de qué se manda y qué no).
// `opciones.devolver === false` guarda SIN devolver (el botón "Guardar" del Modo Corrector y
// el "Guardar sin devolver" de la planilla, RN-27b). El default es devolver, y eso es lo que
// mantiene intacto al botón principal de siempre: si "Guardar" dejara borradores, la docente
// que nunca cambia de modo dejaría de publicar notas sin enterarse.
async function saveAllGrades(activityId, max, opciones) {
  const devolver = !(opciones && opciones.devolver === false);
  const inputs  = document.querySelectorAll('#modoPlanilla .grade-input[data-student]');
  const btn     = document.querySelector('#modoPlanilla .btn-primary');
  const savedEl = document.getElementById('gs-all');
  const previos = window._devolucionesOriginales || {};

  // Arma una fila por alumno con lo que hay ahora y lo que había al abrir el modal
  const filas = [];
  inputs.forEach(input => {
    const studentId  = input.dataset.student;
    const feedbackEl = document.querySelector(`#modoPlanilla .feedback-input[data-student="${studentId}"]`);
    filas.push({
      studentId,
      nombre:         input.closest('tr')?.querySelector('.gt-student-name')?.textContent || '',
      nota:           input.value,
      feedback:       feedbackEl?.value || '',
      notaPrevia:     previos[studentId]?.nota ?? '',
      feedbackPrevia: previos[studentId]?.feedback ?? '',
    });
  });

  const { guardar, invalidas } = recolectarDevoluciones(filas, max);

  // Antes las notas mal cargadas se descartaban sin decir nada. Y desde el 2026-09-06 el motivo
  // viaja POR FILA: el rango dejó de ser lo único que puede fallar (la nota mínima es 1), y con
  // treinta alumnos en pantalla "quedaron fuera de rango" no dice cuál es el problema de cuál.
  if (invalidas.length) {
    alert('Estas notas no se guardaron:\n' +
      invalidas.map(i => `• ${i.nombre || i.studentId}: "${i.nota}" — ${i.error}`).join('\n'));
  }

  if (guardar.length === 0) {
    savedEl.textContent = resumenGuardado(guardar, { devuelve: devolver });
    savedEl.classList.add('show');
    setTimeout(() => savedEl.classList.remove('show'), 2500);
    return 0;
  }

  btn.disabled    = true;
  btn.textContent = 'Guardando...';

  const restaurarBoton = () => {
    btn.disabled  = false;
    btn.innerHTML = '<span class="material-symbols-outlined">save</span> Guardar';
  };

  // Envía cada fila secuencialmente (detiene al primer error)
  for (const entry of guardar) {
    let res;
    try {
      res = await fetch('/activities/' + activityId + '/grade', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        // RN-22b: el flag ausente significa DEVOLVER, así que solo viaja cuando es false.
        body:    JSON.stringify(devolver ? entry : { ...entry, devolver: false }),
      });
    } catch (e) {
      restaurarBoton();
      alert('No se pudo guardar: se cortó la conexión con el servidor. Revisá tu conexión y volvé a intentar.');
      return;
    }
    if (!res.ok) {
      restaurarBoton();
      const data = await res.json().catch(() => ({}));
      alert('Error al guardar: ' + (data.error || 'Error desconocido'));
      return;
    }
    // Ya guardado: si el docente vuelve a tocar "Guardar" no se reenvía esta fila
    previos[entry.studentId] = {
      nota:     entry.points !== undefined ? entry.points : (previos[entry.studentId]?.nota ?? ''),
      feedback: entry.feedback ?? '',
    };
  }

  restaurarBoton();
  savedEl.textContent = resumenGuardado(guardar, { devuelve: devolver });
  savedEl.classList.add('show');
  setTimeout(() => savedEl.classList.remove('show'), 2500);

  // Invalida el cache del gradebook para que se recargue con las notas nuevas
  window._calificacionesTabLoaded = false;
  return guardar.length;
}

// Descarga el Excel de calificaciones de una actividad (GET /activities/:id/export-grades)
function exportGrades(activityId) {
  window.location.href = '/activities/' + activityId + '/export-grades';
}

// Descarga el Excel con la lista de alumnos del curso (GET /courses/:id/export-students)
function exportStudents() {
  window.location.href = '/courses/' + window.COURSE_ID + '/export-students';
}

// Carga el detalle de actividad para el ALUMNO
// Usa el cache window._activities para los datos básicos (ya cargados en loadActivitiesTab)
// Hace fetch de su propia entrega (GET /activities/:id/my-submission) de forma asíncrona
async function loadStudentDetail(activityId) {
  const act  = window._activities[activityId];
  const body = document.getElementById('detailBody');
  document.getElementById('detailTitle').textContent = act ? act.title : 'Actividad';
  if (!act) { body.innerHTML = '<p>No se pudo cargar la actividad.</p>'; return; }

  // Acuse de lectura: avisa al server que el alumno abrió la actividad. Va fire-and-forget
  // (sin await) a propósito — el detalle no debe esperar ni romperse si el ping falla.
  fetch('/activities/' + activityId + '/view', { method: 'POST' }).catch(() => {});

  let html = '';
  if (act.description) {
    html += `<p style="font-size:14px;color:var(--text-secondary);margin-bottom:16px;white-space:pre-line">${act.description}</p>`;
  }

  html += '<div class="detail-meta">';
  if (act.dueDate)       html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtLong(act.dueDate)}</span>`;
  if (act.points != null) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${act.points} pts máx.</span>`;
  html += '</div>';

  html += attachmentSection(act.attachments);

  // Bloque de calificación del alumno: muestra la nota recibida o "sin calificar".
  // myGrade con points null = el docente dejó devolución escrita pero todavía no puso nota:
  // acá cuenta como "aún no calificado" y el comentario se muestra igual, más abajo.
  html += '<div class="student-grade-box">';
  if (act.myGrade?.points != null) {
    const pct = act.points ? Math.round((act.myGrade.points / act.points) * 100) : null;
    html += `<span class="material-symbols-outlined" style="color:var(--secondary);font-size:32px">grade</span>
      <div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">Tu calificación</div>
        <div style="font-size:28px;font-weight:700;color:var(--secondary);line-height:1">
          ${act.myGrade.points}${act.points != null ? '<span style="font-size:16px;color:var(--text-hint)"> / ' + act.points + ' pts</span>' : ' pts'}
        </div>
        ${pct != null ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${pct}%</div>` : ''}
      </div>`;
  } else {
    html += `<span class="material-symbols-outlined" style="color:var(--text-hint);font-size:32px">hourglass_empty</span>
      <div style="color:var(--text-secondary)">Aún no calificado</div>`;
  }
  html += '</div>';

  // Feedback escrito del docente (solo visible si existe)
  if (act.myGrade?.feedback) {
    html += `<div style="margin-top:10px;background:var(--surface);border-radius:8px;padding:12px 16px;border-left:3px solid var(--secondary)">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--text-hint);margin-bottom:6px">Comentario del docente</div>
      <p style="font-size:14px;color:var(--text-primary);margin:0;white-space:pre-line">${act.myGrade.feedback}</p>
    </div>`;
  }

  const nowSt     = new Date();
  const isOverdueSt = act.dueDate && new Date(act.dueDate) < nowSt;
  // isBlocked: plazo vencido Y el docente no habilitó las tardías → no puede entregar
  const isBlocked = isOverdueSt && !act.allowLateSubmissions;

  // Banner de alerta según estado del plazo
  if (isOverdueSt) {
    if (isBlocked) {
      // Lo que se cerró es la ENTREGA, no la actividad: el enunciado y los adjuntos siguen
      // acá arriba y el alumno los puede abrir siempre. Decirlo es la mitad del pedido de la
      // docente del 2026-08-31 — la otra mitad es que la actividad no desaparezca de la lista
      // (ver GET /activities/course/:courseId).
      html += `<div class="deadline-warning">
        <span class="material-symbols-outlined" style="font-size:18px">lock</span>
        El plazo de entrega ha vencido. Las entregas están cerradas, pero el material de la clase sigue disponible.
      </div>`;
    } else {
      html += `<div class="deadline-info">
        <span class="material-symbols-outlined" style="font-size:18px">lock_open</span>
        El plazo venció, pero el docente habilitó las entregas tardías.
      </div>`;
    }
  }

  // Placeholder para la sección de entrega (se llena asíncronamente abajo)
  html += '<div id="submissionSection"></div>';

  // Aviso de transparencia del acuse de lectura. Solo si el admin de la escuela lo
  // habilitó en /admin/tasks; el registro se hace igual, esto es únicamente el aviso.
  if (window.SHOW_VIEW_RECEIPT) {
    html += `<p class="view-receipt-note">
      <span class="material-symbols-outlined">visibility</span>
      El docente puede ver que abriste esta actividad.
    </p>`;
  }

  body.innerHTML = html;

  // Fetch de la entrega actual del alumno (puede ser null si no entregó todavía)
  const subRes  = await fetch('/activities/' + activityId + '/my-submission');
  const subData = subRes.ok ? await subRes.json() : { submission: null };

  // Si la actividad viene de una plantilla interactiva, mostramos el runner en
  // lugar del formulario de archivos + texto. La calificación es automática
  // server-side al enviar (endpoint /activities/:id/submit ya extendido).
  if (act.templateSnapshot && Array.isArray(act.templateSnapshot.questions)) {
    renderRunnerSection(activityId, act, subData.submission);
  } else {
    renderSubmissionSection(activityId, subData.submission, act);
  }
}

// Renderiza la sección "Mi entrega" cuando la actividad es una plantilla interactiva.
// Usa task-runner.js (ya cargado en views/course.ejs). El submit no se pisa si el
// docente puso override manual — el server ya lo respeta.
//
// Comparte la regla de edición con el formulario de archivos (edicionEntrega.js), y por eso
// la autocalificación NO cuenta como corrección: si contara, el cuestionario quedaría
// cerrado en el mismo instante en que el alumno lo responde y el check del docente —que acá
// significa "puede volver a intentar"— no serviría para nada.
function renderRunnerSection(activityId, act, submission) {
  const section = document.getElementById('submissionSection');
  const veredicto = EdicionEntrega.puedeEditar({
    act, grade: act.myGrade || null, hayEntrega: !!submission,
    reabierta: !!submission?.reopenedAt, ahora: new Date(),
  });
  if (!veredicto.puede && !submission) {
    section.innerHTML = '<div class="deadline-warning"><span class="material-symbols-outlined">lock</span> No se puede responder: el plazo venció.</div>';
    return;
  }
  const alreadyAnswered = submission && submission.autoGraded;
  // locked: ya respondió y su entrega está cerrada — solo puede ver el resultado
  const locked = !veredicto.puede;
  section.innerHTML = `
    <div style="margin-top:16px;padding:14px 16px;background:var(--bg);border-radius:8px;font-size:13px;color:var(--text-secondary)">
      <span class="material-symbols-outlined" style="vertical-align:-4px;color:var(--primary)">quiz</span>
      Actividad interactiva. Al enviar tus respuestas el sistema las califica automáticamente.
    </div>
    ${locked ? `<div class="deadline-info" style="margin-top:12px">
      <span class="material-symbols-outlined" style="font-size:18px">lock</span>
      Ya enviaste tus respuestas. ${veredicto.texto} Podés ver tu resultado abajo.
    </div>` : `
    <div id="runnerContainer" class="runner-container" style="margin-top:12px"></div>
    <div class="runner-footer" style="margin-top:16px">
      <button class="btn btn-primary btn-full" id="btnSubmitRun">
        <span class="material-symbols-outlined">check</span>
        ${alreadyAnswered ? 'Volver a enviar' : 'Enviar respuestas'}
      </button>
    </div>`}
    <div id="runnerResult" class="runner-result" style="display:none;margin-top:16px"></div>
  `;
  if (!locked) {
    window.mountRunner({
      templateId: act.templateSnapshot.templateId,
      questions:  act.templateSnapshot.questions,
      gradeUrl:   '/activities/' + activityId + '/submit',
      // Para que el runner pueda avisar cuál actividad quedó entregada: enviar respuestas
      // crea una Submission igual que subir un archivo, y la tarjeta tiene que enterarse.
      activityId: activityId,
    });
  }
  // Si ya había respondido, mostrar el resultado guardado sin volver a enviar.
  if (alreadyAnswered) {
    const box = document.getElementById('runnerResult');
    const r = submission.autoGraded;
    const pct = r.maxPoints > 0 ? Math.round(r.points / r.maxPoints * 100) : 0;
    const rows = (r.breakdown || []).map(function (b) {
      const q = act.templateSnapshot.questions.find(function (x) { return String(x._id) === String(b.questionId); });
      const icon = b.correct === true ? 'check_circle' : b.correct === false ? 'cancel' : 'help';
      const color = b.correct === true ? '#137333' : b.correct === false ? '#c5221f' : '#5f6368';
      return '<div class="result-row"><span class="material-symbols-outlined" style="color:' + color + '">' + icon + '</span><div class="result-row-info"><div class="result-row-prompt">' + (q ? q.prompt : '') + '</div><div class="result-row-meta">' + b.awarded + ' / ' + b.max + ' pts</div></div></div>';
    }).join('');
    box.innerHTML = '<div class="result-header"><div class="result-score"><span class="result-score-value">' + r.points + '</span><span class="result-score-max">/ ' + r.maxPoints + '</span></div><div class="result-score-pct">' + pct + '%</div></div><div class="result-list">' + rows + '</div>';
    box.style.display = 'block';
  }
}

// Array temporal de archivos seleccionados para la entrega (File objects antes de subir)
window._subFiles = [];

// Renderiza la sección de "Mi entrega" en el modal del alumno.
// submission puede ser null (todavía no entregó) o el objeto Submission existente.
// Si puede editarla —y si no, por qué— lo decide public/js/edicionEntrega.js: la MISMA
// regla que aplican las rutas de entrega (specs/edicion-de-la-entrega.spec.md).
// Configuración compartida con el server (routes/activities.js: EXT_SUBMISSIONS + SUBMISSION_MAX_SIZE)
// Documentos que acepta la entrega. Las IMÁGENES no están acá: las decide Adjuntos.esImagen()
// —la misma lista que usa el servidor— y viajan por /upload-submission-image, que las
// recomprime. Tenerlas duplicadas fue el bug del 2026-08-24: esta lista se quedó sin .heic ni
// .webp cuando el resto de la aplicación ya los aceptaba, así que la foto del iPhone rebotaba
// con un cartel que nombraba a las imágenes entre los formatos permitidos.
const SUB_ALLOWED_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'dwg', 'dxf'];
const SUB_MAX_SIZE     = 20 * 1024 * 1024; // 20 MB

function renderSubmissionSection(actId, submission, act, veredictoDelServidor) {
  const container = document.getElementById('submissionSection');
  if (!container) return;

  act = act || window._activities[actId] || {};

  // Estado de la edición. Va en window porque uploadSubFile() y los botones de las tarjetas
  // corren fuera de este scope y sobreviven a los re-renders.
  //   _subUploadedFiles → los archivos NUEVOS, ya pre-subidos, que se mandan al guardar.
  //   _subKeepFiles     → los de la entrega que SOBREVIVEN. Arranca con todos: la X saca de
  //                       acá y Deshacer los devuelve. Nada se borra del servidor hasta que
  //                       el alumno guarda, que es la mitad del pedido: si la X borrara en
  //                       el acto, un clic al pasar destruiría el archivo sin vuelta atrás.
  window._subUploadedFiles  = [];
  window._subPendingUploads = 0;
  window._subKeepFiles      = (submission?.files || []).map(f => f.filename);
  window._subTieneEntrega   = !!submission;

  // La regla única, la misma que aplican las rutas de entrega del servidor. El motivo y su
  // texto salen de ahí: el cartel de esta pantalla y el error del 403 dicen lo mismo porque
  // SON lo mismo. Ver public/js/edicionEntrega.js.
  // `veredictoDelServidor` solo llega cuando una ruta ya contestó 403: la entrega se cerró
  // con el modal abierto (el docente corrigió, o venció el plazo) y el cache local todavía
  // no tiene con qué darse cuenta. Manda él, que es el que sabe.
  const veredicto = veredictoDelServidor || EdicionEntrega.puedeEditar({
    act, grade: act.myGrade || null, hayEntrega: !!submission,
    reabierta: !!submission?.reopenedAt, ahora: new Date(),
  });
  const canEdit = veredicto.puede;

  let html = `<div style="margin-top:24px;border-top:1px solid var(--divider);padding-top:20px">
    <h4 style="font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px">
      <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">upload_file</span>
      Mi entrega
    </h4>`;

  // Si ya entregó, muestra el estado actual (siempre visible, sea o no editable)
  if (submission) {
    const firstDate  = submission.firstSubmittedAt || submission.createdAt;
    const isUpdated  = firstDate && Math.abs(new Date(firstDate) - new Date(submission.updatedAt)) > 2000;
    html += `<div class="sub-existing" style="background:var(--surface);border:1px solid var(--divider);border-radius:8px;padding:12px 16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:${isUpdated ? 2 : 6}px;color:#1e8e3e;font-size:13px;font-weight:500">
        <span class="material-symbols-outlined" style="font-size:16px">check_circle</span>
        Primera entrega: ${fmtShort(firstDate)}
      </div>
      ${isUpdated ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:6px;color:var(--text-hint);font-size:12px">
        <span class="material-symbols-outlined" style="font-size:14px">update</span>
        Última actualización: ${fmtShort(submission.updatedAt)}
      </div>` : ''}`;

    // El comentario y los archivos se muestran acá SOLO cuando la entrega está cerrada. Si
    // es editable van abajo, en el textarea y en el mismo grid que los recién subidos: son
    // lo que se está editando, no un resumen de lo que quedó.
    if (submission.text && !canEdit) {
      html += `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px;white-space:pre-line">${submission.text}</p>`;
    }

    if (!canEdit && submission.files && submission.files.length > 0) {
      html += `<div class="att-list" style="margin-top:4px">`;
      submission.files.forEach(f => {
        const { ext, color } = extColor(f.name);
        // Click abre el previewer (PDF inline, Office online, imagen embedded); dentro del modal
        // hay botón "Descargar". La ruta /activities/submission-file/:filename verifica acceso.
        const url = '/activities/submission-file/' + f.filename;
        html += `<div class="att-item" style="cursor:pointer"
          data-att-type="file" data-att-name="${escAtt(f.name)}"
          data-att-url="${escAtt(url)}" data-att-mime="${f.mime||''}"
          onclick="handleAttachmentClick(this)" role="button" tabindex="0">
          <div class="att-item-icon" style="background:${color}">${ext}</div>
          <span class="att-item-name">${f.name}</span>
          <span class="material-symbols-outlined att-item-open">visibility</span>
        </div>`;
      });
      html += `</div>`;
    }

    if (!canEdit) {
      html += `<div style="display:flex;align-items:center;gap:5px;margin-top:8px;color:var(--text-hint);font-size:12px">
        <span class="material-symbols-outlined" style="font-size:14px">lock</span>
        ${veredicto.texto}
      </div>`;
    }

    html += `</div>`;
  } else if (!canEdit) {
    html += `<div class="deadline-warning">
      <span class="material-symbols-outlined" style="font-size:18px">lock</span>
      No podés enviar tu entrega porque el plazo ha vencido.
    </div>`;
  }

  // El docente lo habilitó a rehacerla: se lo decimos, porque si no el alumno no tiene
  // forma de enterarse de que la puerta que estaba cerrada se volvió a abrir.
  if (canEdit && veredicto.motivo === 'reabierta') {
    html += `<div class="deadline-info" style="margin-bottom:14px">
      <span class="material-symbols-outlined" style="font-size:18px">lock_open_right</span>
      ${veredicto.texto}
    </div>`;
  }

  // Formulario de entrega / edición — solo si está permitido editar.
  // Layout equivalente al del docente en views/activities/new.ejs: card "Adjuntar" con
  // botón circular grande + grid de previsualizaciones abajo. Reusa las clases CSS
  // .creator-att-*/att-preview-* que ya tiene el docente para un look consistente.
  if (canEdit) {
    html += `<div style="margin-bottom:14px">
      <textarea id="subText" rows="3" placeholder="Comentario (opcional)..."
        style="width:100%;padding:10px 12px;border:1px solid var(--divider);border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;background:var(--bg);color:var(--text-primary);box-sizing:border-box">${submission?.text || ''}</textarea>
    </div>
    <div class="creator-card" style="margin-bottom:16px">
      <div class="creator-card-section-title">Adjuntar</div>
      <div class="creator-att-row">
        <label class="creator-att-btn" title="Subir archivo (PDF, Word, Excel, PowerPoint, plano DWG o DXF, imágenes o ZIP)">
          <input type="file" id="subFileInput" multiple hidden
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.dwg,.dxf,image/*,.jfif,.avif,.tif,.tiff">
          <div class="creator-att-circle">
            <span class="material-symbols-outlined">upload</span>
          </div>
          <span>Subir</span>
        </label>
      </div>
      <div id="subFilePreviews" class="att-preview-grid" style="padding:0 24px 20px;margin-top:4px">
        ${(submission?.files || []).map(f => tarjetaArchivoEntregado(f)).join('')}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="submitWork('${actId}')">
        <span class="material-symbols-outlined">${submission ? 'save' : 'send'}</span>
        ${submission ? 'Guardar cambios' : 'Entregar'}
      </button>
      ${submission ? `<button class="btn btn-outline" onclick="retirarEntrega('${actId}')"
        title="Borra tu entrega y la actividad te vuelve a figurar como pendiente">
        <span class="material-symbols-outlined">undo</span>
        Retirar entrega
      </button>` : ''}
      <span id="subMsg" style="font-size:13px;color:var(--secondary);display:none">
        <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px">check_circle</span>
        Entrega guardada
      </span>
    </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Listener para el input de archivos: valida y arranca pre-subida inmediata (uno por uno)
  if (canEdit) {
    document.getElementById('subFileInput').addEventListener('change', function () {
      Array.from(this.files).forEach(f => uploadSubFile(actId, f));
      this.value = '';
    });
  }
}

// Tarjeta de un archivo YA ENTREGADO dentro del grid de edición. Mismo look que la del
// archivo recién subido que arma uploadSubFile(), con dos diferencias: la vista previa sale
// de la ruta de la entrega (y no de la de archivos "staged"), y la X no lo borra: lo marca.
function tarjetaArchivoEntregado(f) {
  const { ext, color } = extColor(f.name);
  const url  = '/activities/submission-file/' + f.filename;
  const attr = `data-att-type="file" data-att-name="${escAtt(f.name)}" data-att-url="${escAtt(url)}" data-att-mime="${f.mime || ''}"`;
  return `<div class="att-preview-card" id="subexist-${escAtt(f.filename)}">
    <div class="att-preview-thumb" style="background:${color};cursor:pointer" ${attr}
      onclick="handleAttachmentClick(this)" role="button" tabindex="0" title="Ver archivo">
      <span class="att-preview-ext">${ext}</span>
    </div>
    <div class="att-preview-name" title="${escAtt(f.name)}" ${attr}
      onclick="handleAttachmentClick(this)" style="cursor:pointer">${f.name}</div>
    <button class="att-preview-remove" title="Quitar de la entrega"
      onclick="event.stopPropagation();quitarArchivoEntregado('${escAtt(f.filename)}')">
      <span class="material-symbols-outlined">close</span>
    </button>
    <div class="att-preview-borrando">
      <span>Se elimina al guardar</span>
      <button type="button" onclick="event.stopPropagation();deshacerQuitarArchivo('${escAtt(f.filename)}')">Deshacer</button>
    </div>
  </div>`;
}

// Marca un archivo entregado para eliminarlo. NO lo borra: lo saca de la lista que viaja al
// guardar y tacha la tarjeta. Mientras no se guarde, Deshacer lo devuelve intacto — que es
// justamente lo que esta feature vino a resolver: que una equivocación tenga vuelta atrás.
function quitarArchivoEntregado(filename) {
  window._subKeepFiles = (window._subKeepFiles || []).filter(n => n !== filename);
  document.getElementById('subexist-' + filename)?.classList.add('por-borrar');
}

function deshacerQuitarArchivo(filename) {
  if (!(window._subKeepFiles || []).includes(filename)) window._subKeepFiles.push(filename);
  document.getElementById('subexist-' + filename)?.classList.remove('por-borrar');
}

// Retira la entrega entera (DELETE /activities/:id/submission): la actividad vuelve a
// figurar como pendiente. Es destructivo y no tiene vuelta atrás, así que el diálogo nombra
// lo que se pierde. Quedarse sin entrega no puede ser el residuo de haber sacado el último
// archivo — por eso es un botón aparte y no lo que pasa al guardar una entrega vacía.
async function retirarEntrega(actId) {
  const archivos = (window._subKeepFiles || []).length;
  const detalle  = archivos
    ? `Se ${archivos === 1 ? 'va a borrar tu archivo' : 'van a borrar tus ' + archivos + ' archivos'}. `
    : '';
  if (!confirm(`¿Retirar tu entrega?\n\n${detalle}La actividad te va a volver a figurar como pendiente. Esto no se puede deshacer.`)) return;

  try {
    const res  = await fetch('/activities/' + actId + '/submission', { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showUploadErrModal('No se pudo retirar la entrega', data.error || 'Error al retirar');
      return;
    }
  } catch {
    showUploadErrModal('Error de conexión', 'No se pudo retirar la entrega. Verificá tu conexión e intentá de nuevo.');
    return;
  }

  renderSubmissionSection(actId, null, window._activities[actId] || {});
  marcarActividadNoEntregada(actId);
}

// Sincroniza el botón "Entregar" con la cantidad de uploads pendientes.
// Espejo de syncCreateBtn() en views/activities/new.ejs (docente).
function syncSubmitBtn() {
  const btn = document.querySelector('#submissionSection .btn-primary');
  if (!btn) return;
  const pending = window._subPendingUploads || 0;
  if (pending > 0) {
    btn.disabled  = true;
    btn.innerHTML = `<span class="material-symbols-outlined">hourglass_empty</span> ${pending === 1 ? 'Subiendo archivo...' : `Subiendo ${pending} archivos...`}`;
  } else {
    btn.disabled  = false;
    // El texto sale de `window._subTieneEntrega` y no de un parámetro: uploadSubFile() llama
    // a esta función SIN argumentos, así que antes el botón volvía a decir "Entregar" en
    // medio de una edición apenas terminaba de subir un archivo.
    const editando = !!window._subTieneEntrega;
    btn.innerHTML = `<span class="material-symbols-outlined">${editando ? 'save' : 'send'}</span> ${editando ? 'Guardar cambios' : 'Entregar'}`;
  }
}

// § K de specs/correccion-de-entregas.spec.md — avisarle al servidor que ESTE navegador
// rechazó un formato, además de mostrar el cartel.
//
// ⭐ Sin esto el log del servidor queda casi vacío y MIENTE: el fileFilter de multer casi
// nunca llega a dispararse, porque el rechazo ocurre antes (el `accept=` del input y esta
// lista de acá). La conclusión sería "no falta ningún formato", que es justo la conclusión
// falsa que esto viene a evitar.
//
// Va la EXTENSIÓN SOLA, recortada por la misma función que usa el servidor, nunca el nombre
// del archivo (RN-46). Y no sube un solo byte: esto corre al SELECCIONAR.
function reportarFormatoRechazado(nombre, ruta) {
  try {
    fetch('/diagnostico/formato', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ext: Correccion.extensionParaLog(nombre), ruta }),
    }).catch(() => {});   // el reporte es informativo: que falle no puede tocar la pantalla
  } catch {}
}

// Pre-sube UN archivo con XHR + barra de progreso en tiempo real.
// Mismo patrón que uploadFile() en views/activities/new.ejs (docente).
function uploadSubFile(actId, file) {
  // Validación cliente: extensión. Las imágenes las decide la regla compartida con el
  // servidor (public/js/adjuntosActividad.js), no una lista propia de esta pantalla.
  const extRaw = file.name.split('.').pop().toLowerCase();
  const esFoto = Adjuntos.esImagen(file.name);
  if (!esFoto && !SUB_ALLOWED_EXTS.includes(extRaw)) {
    reportarFormatoRechazado(file.name, 'entrega');
    showUploadErrModal(
      'Tipo de archivo no permitido',
      `"${file.name}" no es un formato aceptado.\nPodés subir PDF, Word, Excel, PowerPoint (.ppt, .pptx), ZIP, un plano de AutoCAD (.dwg, .dxf) o una foto (jpg, png, webp, heic...).`
    );
    return;
  }
  // Validación cliente: tamaño
  if (file.size > SUB_MAX_SIZE) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    showUploadErrModal(
      'Archivo demasiado grande',
      `"${file.name}" pesa ${mb} MB. El máximo permitido es ${SUB_MAX_SIZE / 1024 / 1024} MB.`
    );
    return;
  }

  const uid   = Date.now() + '-' + Math.random().toString(36).slice(2);
  const ext   = extRaw.toUpperCase();
  const color = EXT_COLOR[ext] || '#5f6368';

  // Tarjeta con barra de progreso
  const grid = document.getElementById('subFilePreviews');
  const card = document.createElement('div');
  card.className = 'att-preview-card';
  card.id = 'subucard-' + uid;
  card.innerHTML = `
    <div class="att-preview-thumb" style="background:${color}">
      <span class="att-preview-ext">${ext}</span>
    </div>
    <div class="att-upload-progress-wrap">
      <div class="att-upload-bar" style="width:0%"></div>
    </div>
    <div class="att-upload-status">0%</div>`;
  grid.appendChild(card);

  // El contador sube UNA vez por archivo, no por intento: si cada reintento lo tocara, el
  // botón "Entregar" se re-habilitaría en medio de la espera y se podría entregar sin el
  // archivo.
  window._subPendingUploads++;
  syncSubmitBtn();

  // Ruta en una constante: el diagnóstico reporta cuál falló, y si no es exactamente la que
  // se llamó, el reporte manda a buscar al lugar equivocado.
  // Las fotos van por su propia ruta, que las recomprime a WebP antes de tocar el disco; los
  // documentos siguen viajando enteros. Las dos rutas contestan lo mismo, así que de acá para
  // abajo no hay ninguna diferencia. Mismo reparto que hace el docente entre /upload-image y
  // /upload-attachment.
  const rutaSubida = '/activities/' + actId
    + (esFoto ? '/upload-submission-image' : '/upload-submission-file');
  // Seguimiento del diagnóstico. Lo que aporta es cuántos bytes llegó a empujar el
  // navegador: distingue "se cortó en camino" (red del aula, proxy, límite de un
  // intermediario — nada de eso deja rastro en el log del servidor) de "subió entero y el
  // servidor lo rechazó". Ver public/js/subida-diagnostico.js.
  const seg = SubidaDiag.seguir(rutaSubida, file);

  const enPantalla = () => document.getElementById('subucard-' + uid);
  const terminar   = () => { window._subPendingUploads--; syncSubmitBtn(); };
  const estado     = (t) => {
    const c = enPantalla();
    if (c) c.querySelector('.att-upload-status').textContent = t;
  };

  // Cada intento arma su propio FormData y su propio XHR. El objeto `file` sigue vivo en el
  // closure, así que no hace falta volver a leer el input (que ya se vació al elegirlo).
  function enviarIntento() {
    // Si la tarjeta ya no está se abandona SOLTANDO el contador. Acá importa más que en el
    // adjunto del docente: `window._subPendingUploads` es global y sobrevive al re-render de
    // renderSubmissionSection(), así que sin esto un reintento programado durante un
    // repintado dejaría el botón en "Subiendo archivo..." hasta recargar la página.
    if (!enPantalla()) return terminar();

    SubidaDiag.nuevoIntento(seg);

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      SubidaDiag.progreso(seg, e);
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      const c = enPantalla();
      if (!c) return;
      c.querySelector('.att-upload-bar').style.width = pct + '%';
      c.querySelector('.att-upload-status').textContent = pct < 100 ? pct + '%' : 'Procesando...';
    };

    xhr.onload = () => {
      const c = enPantalla();
      if (!c) { terminar(); return; }

      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}

      if ((xhr.status === 200 || xhr.status === 201) && data?.storagePath) {
        window._subUploadedFiles.push({
          uid,
          storagePath: data.storagePath,
          name:        data.name,
          filename:    data.filename,
          mime:        data.mime,
          size:        data.size,
        });
        // Reemplaza la barra por el nombre + botón de quitar (mismo look que docente).
        // La miniatura + nombre son clickeables: abren el previewer usando el endpoint
        // /activities/:id/staged-file/:filename (sirve archivos pre-subidos aún sin Submission).
        // El botón X sigue funcionando por stopPropagation en su onclick.
        const previewUrl = '/activities/' + actId + '/staged-file/' + data.filename;
        c.innerHTML = `
          <div class="att-preview-thumb" style="background:${color};cursor:pointer"
            data-att-type="file" data-att-name="${escAtt(data.name)}"
            data-att-url="${escAtt(previewUrl)}" data-att-mime="${data.mime||''}"
            onclick="handleAttachmentClick(this)" role="button" tabindex="0"
            title="Ver archivo">
            <span class="att-preview-ext">${ext}</span>
          </div>
          <div class="att-preview-name" title="${file.name}"
            data-att-type="file" data-att-name="${escAtt(data.name)}"
            data-att-url="${escAtt(previewUrl)}" data-att-mime="${data.mime||''}"
            onclick="handleAttachmentClick(this)" style="cursor:pointer">${file.name}</div>
          <button class="att-preview-remove" onclick="event.stopPropagation();removeUploadedSubFile('${uid}')" title="Quitar">
            <span class="material-symbols-outlined">close</span>
          </button>`;
        terminar();
        return;
      }
      fracaso(xhr, 'http');
    };

    xhr.onerror   = () => fracaso(null, 'red');
    xhr.ontimeout = () => fracaso(null, 'timeout');

    xhr.open('POST', rutaSubida);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(fd);
  }

  // Los tres modos de falla convergen acá, y por eso el final es SIEMPRE el mismo: un solo
  // `fallar()`, un solo código SUB-XXXXXX, un solo cartel.
  function fracaso(xhr, motivo) {
    const cuerpo = xhr ? (xhr.responseText || '') : '';
    const espera = (enPantalla() && SubidaDiag.reintentable({
      motivo, status: xhr ? xhr.status : 0, cuerpo,
    })) ? SubidaDiag.esperaDe(seg.intentos) : null;

    if (espera !== null) {
      const c = enPantalla();
      // La barra vuelve a cero: dejarla en el 8% del intento que acaba de morir es la única
      // forma de que la tarjeta mienta sobre lo que está pasando.
      if (c) {
        c.querySelector('.att-upload-bar').style.width = '0%';
        c.title = 'La subida se cortó. Se reintenta sola hasta 3 veces, durante unos 50 segundos.';
      }
      SubidaDiag.esperar(espera,
        (s) => estado('Reintento en ' + s + ' s'),
        () => { estado('Reintentando ' + (seg.intentos + 1) + ' de 4'); enviarIntento(); });
      return;
    }

    // Se agotó la ventana (o no había nada que reintentar): exactamente lo de antes.
    terminar();
    const c = enPantalla();
    if (c) c.remove();
    // El mensaje del servidor, si vino, el diagnóstico lo respeta y lo muestra igual; lo
    // que agrega es el código para poder encontrar después qué pasó exactamente.
    showUploadErrModal('No se pudo subir el archivo',
      SubidaDiag.mensaje(SubidaDiag.fallar(seg, xhr, motivo)));
  }

  enviarIntento();
}

// Quita un archivo ya subido de la lista local (queda huérfano en disco hasta el cleanup periódico,
// igual que el flujo del docente en /activities/new)
function removeUploadedSubFile(uid) {
  window._subUploadedFiles = window._subUploadedFiles.filter(f => f.uid !== uid);
  const c = document.getElementById('subucard-' + uid);
  if (c) c.remove();
}

// La tarea deja de estar pendiente EN EL ACTO, sin recargar: el chip de la tarjeta pasa a
// "Entregada" y la actividad se va de "Próximas entregas". Es el mismo campo que manda el
// servidor en GET /activities/course/:id (`mySubmission`), puesto a mano sobre el cache —
// si no, lo que el alumno acaba de hacer le seguía figurando como pendiente hasta que
// apretara F5, que es exactamente el problema que vino a resolver esta feature.
//
// Va en window porque la llaman los DOS caminos de entrega: el formulario de archivos de
// acá abajo y el runner de las actividades interactivas (public/js/task-runner.js).
window.marcarActividadEntregada = function (actId, submission) {
  const act = window._activities[actId];
  if (!act) return;
  const sub = submission || {};
  act.mySubmission = { at: sub.firstSubmittedAt || sub.createdAt || new Date().toISOString() };
  reemplazarTarjetaActividad(actId);
  refrescarProximasEntregas();
};

// La contracara: al retirar la entrega la actividad vuelve a figurar como pendiente en el
// acto, sin recargar. Mismo mecanismo que marcarActividadEntregada() —tocar el cache y
// redibujar—, porque el problema es el mismo al revés: si no, lo que el alumno acaba de
// retirar le seguiría diciendo "Entregada" hasta que apretara F5.
window.marcarActividadNoEntregada = function (actId) {
  const act = window._activities[actId];
  if (!act) return;
  act.mySubmission = null;
  reemplazarTarjetaActividad(actId);
  refrescarProximasEntregas();
};

// Envía la entrega del alumno (POST /activities/:id/submit como JSON con archivos ya subidos)
// Después de éxito: re-renderiza la sección de entrega con los datos actualizados
async function submitWork(actId) {
  if (window._subPendingUploads > 0) {
    showUploadErrModal('Esperá un momento', 'Todavía hay archivos subiéndose. Volvé a intentar cuando termine la barra de progreso.');
    return;
  }

  // Antes acá había un confirm: "¿Querés reemplazar tu entrega anterior?". Se fue con el
  // reemplazo: guardar ya no pisa nada: agrega lo que el alumno subió y saca lo que marcó
  // con la X, y esas dos cosas las está viendo en pantalla mientras aprieta el botón.
  const textEl = document.getElementById('subText');
  const btn    = document.querySelector('#submissionSection .btn-primary');

  btn.disabled  = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> Enviando...';

  // storagePath, name, filename, mime, size — el server valida que el storagePath apunte al userId del alumno
  const body = {
    text:          textEl?.value?.trim() || '',
    uploadedFiles: window._subUploadedFiles.map(({ uid, ...rest }) => rest),
  };
  // `keepFiles` solo viaja cuando hay una entrega que editar. Su ausencia NO es lo mismo que
  // mandarlo vacío: el servidor lee "ausente" como el flujo viejo (conservar todo) y `[]`
  // como "no conservo ninguno". Mandarlo siempre convertiría la primera entrega en una orden
  // de borrado sobre una entrega que no existe.
  if (window._subTieneEntrega) body.keepFiles = window._subKeepFiles || [];

  let data;
  try {
    const res = await fetch('/activities/' + actId + '/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    data = await res.json();
    if (!res.ok) {
      showUploadErrModal('No se pudo guardar la entrega', data.error || 'Error al enviar');
      // Si la entrega se cerró mientras el alumno tenía el modal abierto —el docente la
      // corrigió, o venció el plazo— no alcanza con el cartel: hay que repintar, o le queda
      // un formulario puesto que ya no lleva a ninguna parte. `motivo` lo manda el 403 de
      // exigirAlumnoQuePuedeEntregar, y el re-render vuelve a preguntarle a la regla.
      if (data.motivo && data.motivo !== 'editable') {
        const res2 = await fetch('/activities/' + actId + '/my-submission').catch(() => null);
        const sub2 = res2 && res2.ok ? (await res2.json()).submission : null;
        // El veredicto va FORZADO al del servidor en vez de tocarle el cache a la actividad
        // para que la regla local llegue sola a la misma conclusión: el cache no tiene el
        // dato nuevo (la nota que el docente acaba de poner) y falsearlo sería inventar una
        // corrección que nadie hizo.
        renderSubmissionSection(actId, sub2, window._activities[actId], {
          puede: false, motivo: data.motivo, texto: data.error || '',
        });
        return;
      }
      btn.disabled = false;
      syncSubmitBtn();
      return;
    }
  } catch {
    showUploadErrModal('Error de conexión', 'No se pudo enviar la entrega. Verificá tu conexión e intentá de nuevo.');
    btn.disabled = false;
    syncSubmitBtn();
    return;
  }

  window._subUploadedFiles = [];
  const act = window._activities[actId] || {};
  renderSubmissionSection(actId, data.submission, act);

  marcarActividadEntregada(actId, data.submission);

  const msg = document.getElementById('subMsg');
  if (msg) { msg.style.display = 'inline-flex'; setTimeout(() => { msg.style.display = 'none'; }, 3000); }
}

/* ─── Agregar Alumno (docente) ─── */
function openAddStudentModal() {
  document.getElementById('addStudentModal').classList.add('show');
  document.getElementById('addStudentEmail').focus();
}

// Cierra el modal y limpia el estado del formulario
function closeAddStudentModal() {
  document.getElementById('addStudentModal').classList.remove('show');
  document.getElementById('addStudentEmail').value = '';
  const err = document.getElementById('addStudentError');
  err.textContent = '';
  err.classList.remove('show');
}

document.getElementById('addStudentModal')?.addEventListener('click', function (e) {
  if (e.target === this) closeAddStudentModal();
});

// Agrega un alumno por email (POST /courses/:id/add-student)
// Si tiene éxito, actualiza el DOM del tab Personas sin recargar la página
async function addStudent() {
  const email = document.getElementById('addStudentEmail').value.trim();
  const errEl = document.getElementById('addStudentError');
  errEl.textContent = '';
  errEl.classList.remove('show');

  if (!email) {
    errEl.textContent = 'El correo es requerido';
    errEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('addStudentBtn');
  btn.disabled    = true;
  btn.textContent = 'Agregando...';

  const res  = await fetch('/courses/' + window.COURSE_ID + '/add-student', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email }),
  });
  const data = await res.json();

  btn.disabled  = false;
  btn.innerHTML = '<span class="material-symbols-outlined">person_add</span> Agregar';

  if (!res.ok) {
    errEl.textContent = data.error;
    errEl.classList.add('show');
    return;
  }

  addStudentToDOM(data.student); // Agrega el alumno al tab Personas sin recargar
  closeAddStudentModal();
}

// Inserta un nuevo alumno en el DOM del tab Personas
// Incrementa el contador de alumnos y agrega el elemento en la sección "Estudiantes"
function addStudentToDOM(student) {
  const peopleTab = document.getElementById('peopleTab');

  // Incrementa el contador visible de alumnos
  const countEl = peopleTab.querySelector('.people-count');
  if (countEl) {
    const current = parseInt(countEl.textContent) || 0;
    countEl.textContent = current + 1;
  }

  // Busca el card de "Estudiantes" en el tab (por el texto del h3)
  const studentsCard = Array.from(peopleTab.querySelectorAll('.people-card'))
    .find(card => card.querySelector('h3')?.textContent === 'Estudiantes');
  if (!studentsCard) return;

  // Quita el estado vacío si existía
  const emptyState = studentsCard.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const div = document.createElement('div');
  div.className        = 'person-item';
  div.dataset.studentId = student._id;
  div.dataset.active    = 'true'; // Los alumnos recién agregados siempre están activos
  const avatarHtml = student.avatar
    ? `<div class="avatar avatar-img"><img src="${student.avatar}" alt="${student.name}"></div>`
    : `<div class="avatar">${student.name.charAt(0).toUpperCase()}</div>`;
  div.innerHTML = `
    ${avatarHtml}
    <div class="person-info">
      <div class="person-name">${student.name}</div>
      <div class="person-email">${student.email}</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:4px">
      <button class="icon-btn toggle-active-btn" onclick="toggleStudentActive('${student._id}')"
        title="Deshabilitar cuenta" style="color:#f9ab00;opacity:.8"
        onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=.8">
        <span class="material-symbols-outlined">block</span>
      </button>
      <button class="icon-btn" onclick="removeStudent('${student._id}')" title="Quitar del curso"
        style="color:var(--danger);opacity:.7" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=.7">
        <span class="material-symbols-outlined">person_remove</span>
      </button>
    </div>
  `;
  studentsCard.appendChild(div);
}

// Quita un alumno del curso (DELETE /courses/:id/students/:studentId)
// Si tiene entregas el servidor devuelve 409; en ese caso ofrece deshabilitar la cuenta
async function removeStudent(studentId) {
  if (!confirm('¿Querés quitar a este alumno del curso?')) return;

  const res  = await fetch('/courses/' + window.COURSE_ID + '/students/' + studentId, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));

  if (res.status === 409) {
    // El alumno tiene entregas → no se puede eliminar; ofrecer deshabilitar
    if (confirm(data.error + '\n\n¿Querés deshabilitar su cuenta en su lugar?\n(No podrá iniciar sesión en la plataforma)')) {
      await toggleStudentActive(studentId);
    }
    return;
  }

  if (!res.ok) {
    alert(data.error || 'Error al quitar al alumno');
    return;
  }

  // Éxito: elimina la fila del DOM y decrementa el contador
  const row = document.querySelector(`.person-item[data-student-id="${studentId}"]`);
  if (row) row.remove();

  const countEl = document.querySelector('#peopleTab .people-count');
  if (countEl) countEl.textContent = Math.max(0, (parseInt(countEl.textContent) || 1) - 1);

  const studentsCard = Array.from(document.querySelectorAll('#peopleTab .people-card'))
    .find(c => c.querySelector('h3')?.textContent === 'Estudiantes');
  if (studentsCard && !studentsCard.querySelector('.person-item')) {
    const empty = document.createElement('div');
    empty.className = 'empty-state small';
    empty.innerHTML = '<div class="empty-icon"><span class="material-symbols-outlined">person_add</span></div><p>Aún no hay estudiantes</p>';
    studentsCard.appendChild(empty);
  }
}

// Habilita o deshabilita la cuenta de un alumno (POST /courses/:id/students/:studentId/toggle-active)
// Actualiza el DOM de la fila: badge, opacidad, ícono y title del botón de toggle
async function toggleStudentActive(studentId) {
  const res  = await fetch('/courses/' + window.COURSE_ID + '/students/' + studentId + '/toggle-active', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Error al cambiar el estado'); return; }

  const active = data.active;
  const row    = document.querySelector(`.person-item[data-student-id="${studentId}"]`);
  if (!row) return;

  row.dataset.active = active ? 'true' : 'false';
  row.classList.toggle('person-disabled', !active);

  // Actualiza el avatar
  const avatar = row.querySelector('.avatar');
  if (avatar) avatar.style.opacity = active ? '' : '.4';

  // Actualiza o quita el badge DESHABILITADO
  let badge = row.querySelector('.badge-disabled');
  if (!active && !badge) {
    badge = document.createElement('span');
    badge.className = 'badge-disabled';
    badge.textContent = 'DESHABILITADO';
    // Inserta antes del div de botones
    const btnGroup = row.querySelector('.toggle-active-btn')?.closest('div');
    if (btnGroup) row.insertBefore(badge, btnGroup);
    else row.appendChild(badge);
  } else if (active && badge) {
    badge.remove();
  }

  // Actualiza el botón de toggle (ícono + color + title)
  const toggleBtn = row.querySelector('.toggle-active-btn');
  if (toggleBtn) {
    toggleBtn.title = active ? 'Deshabilitar cuenta' : 'Habilitar cuenta';
    toggleBtn.style.color = active ? '#f9ab00' : '#34a853';
    const icon = toggleBtn.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = active ? 'block' : 'person_check';
  }
}

/* ─── Mis Notas (alumno) ─── */
// Carga y renderiza la tabla de "Mis notas" del alumno
// Reutiliza GET /activities/course/:id (devuelve myGrade para el alumno)
// Ordena por dueDate ascendente (sin fecha al final)
async function loadMisNotasTab() {
  const container = document.getElementById('misnotasList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando...</p></div>';

  const res = await fetch('/activities/course/' + window.COURSE_ID);
  if (!res.ok) { container.innerHTML = '<p style="color:var(--danger);padding:20px">Error al cargar notas.</p>'; return; }

  const { activities } = await res.json();
  // Actualiza el cache con las actividades recientes (puede haber sido calificado desde la última visita)
  activities.forEach(act => { window._activities[act._id] = act; });

  if (activities.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">assignment</span></div><p>Aún no hay actividades</p></div>';
    return;
  }

  // Ordena por dueDate: con fecha primero (más próxima primero), sin fecha al final
  const sorted = [...activities].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  const now = new Date();
  const rows = sorted.map(act => {
    // points null = hay devolución escrita pero todavía no hay nota
    const graded = act.myGrade?.points != null;
    const gradeCell = graded
      ? `<span class="grade-chip graded">${act.myGrade.points}${act.points != null ? ' / ' + act.points : ' pts'}</span>`
      : act.myGrade?.feedback
        ? `<span class="grade-chip pending">Con devolución</span>`
        : `<span class="grade-chip pending">Sin calificar</span>`;

    // Si está vencida y sin calificar: muestra la fecha en rojo
    const overdue = act.dueDate && new Date(act.dueDate) < now && !graded;
    const dueCell = act.dueDate
      ? `<span style="color:${overdue ? 'var(--danger)' : 'var(--text-secondary)'};font-size:13px">${fmtShort(act.dueDate)}</span>`
      : `<span style="color:var(--text-hint);font-size:13px">Sin fecha</span>`;

    // Click en la fila abre el detalle de la actividad
    return `<tr class="gb-student-row" onclick="openActivityDetail('${act._id}')" style="cursor:pointer" title="Ver actividad">
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="stream-item-icon act-icon" style="width:34px;height:34px;flex-shrink:0;border-radius:50%">
            <span class="material-symbols-outlined" style="font-size:17px">assignment</span>
          </div>
          <span style="font-weight:500;font-size:14px">${act.title}</span>
        </div>
      </td>
      <td>${dueCell}</td>
      <td style="text-align:right">${gradeCell}</td>
    </tr>`;
  }).join('');

  const graded = activities.filter(a => a.myGrade?.points != null).length;
  container.innerHTML = `
    <div style="padding:4px 0 16px;font-size:13px;color:var(--text-secondary)">
      <span style="color:var(--secondary);font-weight:600">${graded}</span> de ${activities.length} actividades calificadas
    </div>
    <div class="grade-table-wrap">
      <table class="grade-table">
        <thead>
          <tr>
            <th>Actividad</th>
            <th>Fecha de entrega</th>
            <th style="text-align:right">Nota</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Guarda una nota individual desde el modal de detalle de actividad (tabla del docente)
// Usado al hacer click en "Guardar" en una fila de la tabla de calificaciones
async function saveGrade(activityId, studentId, btn) {
  const input   = document.getElementById('gi-' + studentId);
  const savedEl = document.getElementById('gs-' + studentId);
  const points  = input.value;

  if (points === '') {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }

  // La nota mínima es 1 (public/js/devoluciones.js). El borde rojo solo no alcanza acá: el
  // motivo más común de rechazo es el 0, y el 0 se escribe queriendo decir "sin nota" — hay
  // que nombrarle la alternativa, no solo marcarle el campo.
  const veredicto = notaValidaManual(points, input.max ? Number(input.max) : null);
  if (!veredicto.ok) {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    alert(veredicto.error);
    return;
  }

  btn.disabled    = true;
  btn.textContent = '...';

  const res = await fetch('/activities/' + activityId + '/grade', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ studentId, points: veredicto.points }),
  });

  btn.disabled    = false;
  btn.textContent = 'Guardar';

  if (res.ok) {
    savedEl.classList.add('show');
    setTimeout(() => savedEl.classList.remove('show'), 2500);
    // Invalida el cache del gradebook para que se recargue con la nota nueva
    window._calificacionesTabLoaded = false;
  } else {
    const d = await res.json();
    alert(d.error);
  }
}

/* ─── Link directo a una actividad (?actividad=<id>) ─── */
// Lo usan el botón "Ver actividad" del chat de la sala cuando el JS no llegó a interceptarlo
// (y cualquier link que se comparta a mano). El parámetro se deja en la URL: si el alumno
// recarga, vuelve a abrir la actividad, que es lo que espera de un link.
(function () {
  const id = new URLSearchParams(window.location.search).get('actividad');
  if (id) abrirActividad(id);
})();
