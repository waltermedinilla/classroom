// Cache en memoria de actividades: activityId → objeto actividad completo
// Se llena al cargar el tab y al crear una actividad; permite acceso O(1) sin re-fetch
let selectedImage = null;
window._activities = {};

// Mapa de colores por extensión de archivo para los iconos de adjuntos
const EXT_COLOR = { PDF: '#ea4335', DOC: '#1a73e8', DOCX: '#1a73e8', XLS: '#34a853', XLSX: '#34a853' };

// Configuración visual por tipo de actividad: etiqueta, ícono Material Symbols, color del thumb
// color=null → usa el color del curso (window.COURSE_COLOR)
const TYPE_CONFIG = {
  tarea:      { label: 'Tarea',            icon: 'assignment', color: null },
  evaluacion: { label: 'Evaluación',       icon: 'quiz',       color: '#f9ab00' },
  tp:         { label: 'Trabajo Práctico', icon: 'science',    color: '#0f9d58' },
  examen:     { label: 'Examen',           icon: 'school',     color: '#e53935' },
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
function _isOffice(name) { return /\.(doc|docx|xls|xlsx)$/i.test(name || ''); }
function _isYoutube(url) { return /youtu\.?be/.test(url || ''); }
function _ytId(url) {
  const m = (url || '').match(/(?:v=|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
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
      return `<div class="att-item" style="cursor:pointer"
        data-att-type="file" data-att-name="${escAtt(a.name)}"
        data-att-url="${escAtt(a.url)}" data-att-mime="${a.mime||''}"
        onclick="handleAttachmentClick(this)" role="button" tabindex="0">
        <div class="att-item-icon" style="background:${color}">${ext}</div>
        <span class="att-item-name">${a.name}</span>
        <span class="material-symbols-outlined att-item-open">${actionIcon}</span>
      </div>`;
    }
    // Link
    const domain  = getDomain(a.url);
    const isYt    = _isYoutube(a.url);
    const linkIcon = isYt ? 'play_circle' : 'open_in_new';
    return `<div class="att-item" style="cursor:pointer"
      data-att-type="link" data-att-name="${escAtt(a.name || domain)}"
      data-att-url="${escAtt(a.url)}" data-att-mime=""
      onclick="handleAttachmentClick(this)" role="button" tabindex="0">
      <div class="att-item-icon link-icon">
        <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="20" height="20"
          style="border-radius:3px" onerror="this.outerHTML='<span class=\\'material-symbols-outlined\\' style=\\'font-size:20px;color:var(--primary)\\'>language</span>'">
      </div>
      <span class="att-item-name">${a.name || domain}</span>
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

// Abre el previsualizador:
//  - PDF       → iframe inline en modal pantalla completa + botón Descargar
//  - YouTube   → iframe embed en modal pantalla completa + botón Abrir en YouTube
//  - Word/Excel → descarga directa inmediata (sin modal)
//  - Otro link → abre en nueva pestaña (la mayoría bloquea embedding)
function openAttachmentPreview(att) {
  const name     = att.name || '';
  const url      = att.url  || '';
  const isPdf    = att.type === 'file' && _isPdf(name);
  const isOffice = att.type === 'file' && _isOffice(name);
  const isYt     = _isYoutube(url);

  // Links que no son YouTube → abrir en nueva pestaña
  if (att.type === 'link' && !isYt) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  let bodyContent = '';

  if (isPdf) {
    bodyContent = `<iframe src="${url}#toolbar=1" class="att-preview-frame"></iframe>`;

  } else if (isOffice) {
    // Microsoft Office Online necesita la URL absoluta pública del archivo
    const fullUrl = window.location.origin + url;
    const isLocal = /localhost|127\.0\.0\.1/.test(window.location.hostname);

    if (isLocal) {
      // En entorno local la URL no es accesible desde internet → aviso + descarga
      bodyContent = `<div class="att-preview-no-support">
        <span class="material-symbols-outlined">cloud_off</span>
        <p>Previsualización no disponible en entorno local</p>
        <p class="att-preview-no-support-sub">
          El visor de Microsoft Office requiere que el archivo sea accesible
          públicamente desde internet. Descargá el archivo para abrirlo.
        </p>
        <a href="${url}" download="${escAtt(name)}" class="att-preview-btn" style="margin-top:8px">
          <span class="material-symbols-outlined">download</span> Descargar
        </a>
      </div>`;
    } else {
      // Visor de Microsoft Office Online — gratis, sin registro, funciona en producción
      const src = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fullUrl)}`;
      bodyContent = `
        <div class="att-preview-loading" id="attOffLoad">
          <div class="att-preview-spinner"></div>
          <p>Cargando previsualización…</p>
        </div>
        <iframe src="${src}" class="att-preview-frame" style="opacity:0"
          onload="var l=document.getElementById('attOffLoad');if(l)l.remove();this.style.opacity='1'">
        </iframe>`;
    }

  } else if (isYt) {
    const vid = _ytId(url);
    if (!vid) { window.open(url, '_blank', 'noopener'); return; }
    bodyContent = `<iframe src="https://www.youtube.com/embed/${vid}?autoplay=1&rel=0"
      class="att-preview-frame" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  }

  // Botón de acción en la barra superior
  const actionBtn = isYt
    ? `<a href="${url}" target="_blank" rel="noopener" class="att-preview-btn">
        <span class="material-symbols-outlined">open_in_new</span> Abrir en YouTube
       </a>`
    : `<a href="${url}" download="${escAtt(name)}" class="att-preview-btn">
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

  const onEsc = e => { if (e.key === 'Escape') { closeAttPreview(); document.removeEventListener('keydown', onEsc); } };
  overlay._onEsc = onEsc;
  document.addEventListener('keydown', onEsc);
}

function closeAttPreview() {
  const overlay = document.querySelector('.att-preview-overlay');
  if (!overlay) return;
  if (overlay._onEsc) document.removeEventListener('keydown', overlay._onEsc);
  overlay.remove();
  document.body.style.overflow = '';
}

// Chip de resumen de adjuntos ("2 archivos · 1 vínculo") para mostrar en tarjetas del stream
function attachmentCountChip(attachments) {
  if (!attachments || attachments.length === 0) return '';
  const files = attachments.filter(a => a.type === 'file').length;
  const links = attachments.filter(a => a.type === 'link').length;
  const parts = [];
  if (files) parts.push(`${files} archivo${files > 1 ? 's' : ''}`);
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
  return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// Formatea fecha de forma larga: "15 de mayo de 2025, 10:30"
function fmtLong(d) {
  return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
        <div class="stream-item-date">${fmtShort(ann.createdAt)}</div>
      </div>
      <span class="material-symbols-outlined ann-expand-arrow">expand_more</span>
    </div>
    <div class="ann-expanded" id="ann-exp-${ann._id}" style="display:none">
      <div class="ann-full-text">${ann.text}</div>
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
      <div class="stream-item-date">${new Date(act.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</div>
    </div>
    <button class="icon-btn" title="Más opciones" onclick="event.stopPropagation()">
      <span class="material-symbols-outlined">more_vert</span>
    </button>
  `;
  return div;
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

  // Próximas entregas en el sidebar: solo actividades con dueDate en el futuro, máx 3
  const now = new Date();
  const upcoming = (actData.activities || [])
    .filter(a => a.dueDate && new Date(a.dueDate) > now)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const upcomingList = document.getElementById('upcomingList');
  if (upcomingList) {
    if (upcoming.length === 0) {
      upcomingList.innerHTML = '<p class="stream-no-upcoming">No tenés tareas pendientes</p>';
    } else {
      upcomingList.innerHTML = upcoming.slice(0, 3).map(a => `
        <div class="upcoming-item" onclick="openActivityDetail('${a._id}')">
          <div class="upcoming-item-title">${a.title}</div>
          <div class="upcoming-item-due">${fmtShort(a.dueDate)}</div>
        </div>
      `).join('');
    }
  }

  // Mezcla y ordena novedades + actividades por fecha (más recientes primero)
  const items = [
    ...annData.announcements.map(a => ({ type: 'announcement', date: new Date(a.createdAt), data: a })),
    ...actData.activities.map(a    => ({ type: 'activity',     date: new Date(a.createdAt), data: a })),
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
document.getElementById('imageInput').addEventListener('change', function () {
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

// Agrega archivos al array local cuando el usuario los selecciona
document.getElementById('activityFileInput').addEventListener('change', function () {
  Array.from(this.files).forEach(f => activityFiles.push(f));
  this.value = ''; // Resetea el input para permitir seleccionar el mismo archivo de nuevo
  renderAttachmentPreviews();
});

// Muestra u oculta el campo para agregar un link manualmente
function toggleLinkInput() {
  const area     = document.getElementById('linkInputArea');
  const isHidden = area.style.display === 'none';
  area.style.display = isHidden ? 'block' : 'none';
  if (isHidden) document.getElementById('linkUrlInput').focus();
  else document.getElementById('linkUrlInput').value = '';
}

// Enter en el campo de link lo agrega directamente
document.getElementById('linkUrlInput').addEventListener('keydown', function (e) {
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

  activityFiles.forEach((f, i) => {
    const { ext, color } = extColor(f.name);
    const card = document.createElement('div');
    card.className = 'att-preview-card';
    card.innerHTML = `
      <div class="att-preview-thumb" style="background:${color}">
        <span class="att-preview-ext">${ext}</span>
      </div>
      <div class="att-preview-name" title="${f.name}">${f.name}</div>
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
}

/* ─── Crear Actividad ─── */
function openActivityModal() {
  document.getElementById('activityModal').classList.add('show');
  document.getElementById('activityTitle').focus();
}

// Cierra y resetea completamente el modal de creación (limpia arrays de adjuntos locales)
function closeActivityModal() {
  document.getElementById('activityModal').classList.remove('show');
  ['activityTitle', 'activityDesc', 'activityDueDate', 'activityPoints', 'activityAvailableFrom']
    .forEach(id => { document.getElementById(id).value = ''; });
  activityFiles = [];
  activityLinks = [];
  renderAttachmentPreviews();
  document.getElementById('linkInputArea').style.display = 'none';
  document.getElementById('linkUrlInput').value = '';
  const err = document.getElementById('activityError');
  err.classList.remove('show');
  err.textContent = '';
}

// Cierra el modal si el usuario hace clic en el overlay
document.getElementById('activityModal').addEventListener('click', function (e) {
  if (e.target === this) closeActivityModal();
});

// Crea una actividad (POST /activities/create como multipart/form-data)
// Links se serializa como JSON string porque FormData no soporta objetos anidados
// Después de crear: añade tarjeta al tab actividades Y elemento al stream si ya está disponible
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

  const fd = new FormData();
  fd.append('courseId',       window.COURSE_ID);
  fd.append('title',          title);
  fd.append('type',           document.getElementById('activityType').value || 'tarea');
  fd.append('description',    document.getElementById('activityDesc').value.trim());
  fd.append('dueDate',        document.getElementById('activityDueDate').value || '');
  fd.append('availableFrom',  document.getElementById('activityAvailableFrom').value || '');
  fd.append('points',         document.getElementById('activityPoints').value || '');
  activityFiles.forEach(f => fd.append('files', f)); // Cada archivo como campo "files"
  fd.append('links', JSON.stringify(activityLinks));  // Links como JSON string

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
  addActivityTabCard(data.activity); // Agrega la tarjeta al tab de actividades del docente

  // Si availableFrom ya pasó (o no hay), muestra también en el stream
  const availFrom = data.activity.availableFrom ? new Date(data.activity.availableFrom) : null;
  if (!availFrom || availFrom <= new Date()) {
    const streamEl = buildActivityStreamEl(data.activity);
    const container = document.getElementById('streamList');
    const empty     = container.querySelector('.empty-state');
    if (empty) empty.remove();
    container.prepend(streamEl);
  }
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
    ? 'Entrega: ' + new Date(act.dueDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Publicado: ' + new Date(act.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });

  // Chip de estado del plazo: muestra si vencida y si las tardías están abilitadas
  const overdueChip = isOverdue
    ? `<span class="overdue-chip ${act.allowLateSubmissions ? 'overdue-open' : 'overdue-closed'}" data-actid="${act._id}">
        <span class="material-symbols-outlined" style="font-size:12px">${act.allowLateSubmissions ? 'lock_open' : 'lock'}</span>
        ${act.allowLateSubmissions ? 'Tardías habilitadas' : 'Plazo vencido'}
      </span>`
    : '';

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

  const div = document.createElement('div');
  div.className  = 'act-student-item';
  div.dataset.id = act._id;
  // Click en la tarjeta abre el detalle; click en el botón ⋮ abre el menú contextual
  div.onclick = (e) => { if (!e.target.closest('.activity-row-menu')) openActivityDetail(act._id); };
  div.innerHTML = `
    <div class="act-thumb" style="${thumbBg}">
      <span class="material-symbols-outlined">${tc.icon}</span>
    </div>
    <div class="act-content">
      <div class="act-type-label">${typeLabel}</div>
      <div class="act-item-title">${act.title} ${overdueChip}</div>
      <div class="act-item-date${isOverdue ? ' date-overdue' : ''}">${dateText}</div>
    </div>
    <div class="act-status-col">
      ${submittedChip}
      <button class="icon-btn activity-row-menu" onclick="toggleActivityMenu(event,'${act._id}')" title="Más opciones">
        <span class="material-symbols-outlined">more_vert</span>
      </button>
    </div>
  `;

  container.appendChild(div);
}

/* ─── Vista alumno: tarjeta de actividad ─── */
// Construye la tarjeta para el alumno con su estado personal (Pendiente / Calificada / Vencida / Tardía)
// act.myGrade viene del servidor (solo la nota propia, sin las del resto de la clase)
function addStudentActivityCard(act) {
  window._activities[act._id] = act;
  const container = document.getElementById('activitiesList');
  const empty     = container.querySelector('.empty-state');
  if (empty) empty.remove();

  const now       = new Date();
  const isOverdue = act.dueDate && new Date(act.dueDate) < now;
  const isGraded  = act.myGrade != null;

  // Lógica de estado: calificada > vencida cerrada > tardía abierta > pendiente
  let statusChip, gradeText = '';
  if (isGraded) {
    statusChip = `<span class="act-status-chip status-graded">
      <span class="material-symbols-outlined" style="font-size:12px">grade</span>Calificada
    </span>`;
    // Muestra la nota y el máximo si está definido
    gradeText = `<span class="act-grade-text">${act.myGrade.points}${act.points != null ? ' / ' + act.points + ' pts' : ' pts'}</span>`;
  } else if (isOverdue && !act.allowLateSubmissions) {
    // Plazo vencido y sin opción de entrega tardía
    statusChip = `<span class="act-status-chip status-overdue">
      <span class="material-symbols-outlined" style="font-size:12px">lock</span>Vencida
    </span>`;
  } else if (isOverdue && act.allowLateSubmissions) {
    // Plazo vencido pero el docente habilitó las tardías
    statusChip = `<span class="act-status-chip status-late-open">
      <span class="material-symbols-outlined" style="font-size:12px">lock_open</span>Tardía
    </span>`;
  } else {
    statusChip = `<span class="act-status-chip status-pending">Pendiente</span>`;
  }

  let dateText = '', dateClass = '';
  if (act.dueDate) {
    const dueFmt = new Date(act.dueDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    dateText  = (isOverdue ? 'Venció: ' : 'Entrega: ') + dueFmt;
    dateClass = isOverdue ? ' date-overdue' : ''; // Clase CSS que pone el texto en rojo
  } else {
    dateText = 'Publicado: ' + new Date(act.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
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

  document.getElementById('editError').textContent = '';
  document.getElementById('editActivityModal').classList.add('show');
  document.getElementById('editTitle').focus();
}

function closeEditModal() {
  document.getElementById('editActivityModal').classList.remove('show');
}

document.getElementById('editActivityModal').addEventListener('click', function (e) {
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
    }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span> Guardar';

  if (!res.ok) { errEl.textContent = data.error; return; }

  // Fusiona la actividad actualizada con el cache local (preserva campos no editables como grades)
  window._activities[id] = { ...window._activities[id], ...data.activity };

  // Actualiza los elementos de texto en la tarjeta del DOM sin reconstruirla
  const act = data.activity;
  const row = document.querySelector(`.act-student-item[data-id="${id}"]`);
  if (row) {
    const isOverdue = act.dueDate && new Date(act.dueDate) < new Date();
    const dateText  = act.dueDate
      ? 'Entrega: ' + new Date(act.dueDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : row.querySelector('.act-item-date').textContent;
    // firstChild porque el elemento contiene el título + posiblemente el chip de vencido
    row.querySelector('.act-item-title').firstChild.textContent = act.title + ' ';
    const dateEl      = row.querySelector('.act-item-date');
    dateEl.textContent = dateText;
    dateEl.className   = 'act-item-date' + (isOverdue ? ' date-overdue' : '');
    const tc2    = typeConfig(act.type);
    const typeEl = row.querySelector('.act-type-label');
    if (typeEl) typeEl.textContent = tc2.label + (act.points != null ? ' · ' + act.points + ' pts' : '');
    // Actualiza el color y el ícono del thumbnail según el tipo
    const thumbEl = row.querySelector('.act-thumb');
    if (thumbEl) {
      const tC1 = tc2.color || window.COURSE_COLOR || '#1a73e8';
      const tC2 = tc2.color ? '' : (window.COURSE_COLOR2 || '');
      thumbEl.style.background = tC2 ? `linear-gradient(135deg,${tC1},${tC2})` : tC1;
      const thumbIcon = thumbEl.querySelector('.material-symbols-outlined');
      if (thumbIcon) thumbIcon.textContent = tc2.icon;
    }
  }

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
// Busca en título y en el label de tipo (ej: "Examen", "Trabajo Práctico")
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
    return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
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
  const points = Number(val);
  if (isNaN(points)) return;

  input.style.opacity = '0.5'; // Feedback visual de guardado en progreso
  const res = await fetch('/activities/' + activityId + '/grade', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ studentId, points }),
  });
  input.style.opacity = '1';
  if (res.ok) {
    input.classList.add('gb-saved');
    setTimeout(() => input.classList.remove('gb-saved'), 1800); // Animación de "guardado"
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

document.getElementById('activityDetailModal').addEventListener('click', function (e) {
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
// Hace dos fetches en paralelo: grades (notas por alumno) y submissions (entregas)
// Construye subMap (studentId → submission) para mostrar estado de entrega por alumno
async function loadTeacherDetail(activityId) {
  const body = document.getElementById('detailBody');
  const [gradesRes, subsRes] = await Promise.all([
    fetch('/activities/' + activityId + '/grades'),
    fetch('/activities/' + activityId + '/submissions'),
  ]);
  if (!gradesRes.ok) { body.innerHTML = '<p style="color:var(--danger)">Error al cargar la actividad.</p>'; return; }

  const { activity, studentGrades } = await gradesRes.json();

  // Construye mapa rápido de entregas: studentId → submission (para cruzar en la tabla)
  const subMap = {};
  if (subsRes.ok) {
    const { submissions } = await subsRes.json();
    submissions.forEach(s => { subMap[s.student._id] = s; });
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

  if (studentGrades.length === 0) {
    html += '<div class="empty-state small" style="margin-top:24px"><p>No hay alumnos inscriptos</p></div>';
  } else {
    html += `<div class="gt-summary">
      <span><span class="gt-summary-val" style="color:var(--secondary)">${graded}</span>/<span>${studentGrades.length}</span> calificados</span>
      <span class="gt-summary-sep">·</span>
      <span><span class="gt-summary-val" style="color:var(--primary)">${submitted}</span>/<span>${studentGrades.length}</span> entregaron</span>
    </div>
    <div class="grade-table-wrap"><table class="grade-table">
      <thead><tr>
        <th class="gt-col-student">Alumno</th>
        <th class="gt-col-grade">Nota${activity.points != null ? `<span class="gt-pts-max"> / ${activity.points}</span>` : ''}</th>
        <th class="gt-col-feedback">Feedback al alumno</th>
        <th class="gt-col-sub">Entrega</th>
      </tr></thead>
      <tbody>`;

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
            ${sub.files.map(f => `<a href="/activities/submission-file/${f.filename}" download class="gt-sub-file">
              <span class="material-symbols-outlined">attach_file</span>${f.name}</a>`).join('')}
          </div>`
        : `<span class="gt-sub-badge gt-sub-pending">
            <span class="material-symbols-outlined">schedule</span>Pendiente
           </span>`;

      html += `<tr>
        <td>
          <div class="gt-student-cell">
            <div class="avatar" style="width:34px;height:34px;font-size:15px;flex-shrink:0">${sg.name.charAt(0).toUpperCase()}</div>
            <div style="min-width:0">
              <div class="gt-student-name">${sg.name}</div>
              <div class="gt-student-email">${sg.email}</div>
            </div>
          </div>
        </td>
        <td class="gt-col-grade">
          <div class="gt-grade-wrap">
            <input class="grade-input" type="number" min="0" max="${activity.points || 9999}"
              value="${sg.points ?? ''}" placeholder="—" data-student="${sg._id}">
          </div>
        </td>
        <td class="gt-col-feedback">
          <textarea class="feedback-input" data-student="${sg._id}" rows="2"
            placeholder="Comentario al alumno...">${sg.feedback || ''}</textarea>
        </td>
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
        <span class="grade-saved" id="gs-all" style="font-size:13px">✓ Notas guardadas</span>
        <button class="btn btn-outline" onclick="exportGrades('${activity._id}')">
          <span class="material-symbols-outlined">download</span> Exportar Excel
        </button>
        <button class="btn btn-primary" onclick="saveAllGrades('${activity._id}',${activity.points || 9999})">
          <span class="material-symbols-outlined">save</span> Guardar notas
        </button>
      </div>`;
  }

  body.innerHTML = html;
}

// Guarda todas las notas visibles en el modal de detalle de una sola vez
// Itera los inputs de nota, valida rango y hace una request por cada nota no vacía
async function saveAllGrades(activityId, max) {
  const inputs  = document.querySelectorAll('#detailBody .grade-input[data-student]');
  const btn     = document.querySelector('#detailBody .btn-primary');
  const savedEl = document.getElementById('gs-all');

  // Recolecta notas válidas y el feedback asociado a cada alumno
  const entries = [];
  inputs.forEach(input => {
    const val    = input.value.trim();
    if (val === '') return;
    const points = Number(val);
    if (isNaN(points) || points < 0 || points > max) return;
    const feedbackEl = document.querySelector(`.feedback-input[data-student="${input.dataset.student}"]`);
    entries.push({ studentId: input.dataset.student, points, feedback: feedbackEl?.value?.trim() || '' });
  });

  if (entries.length === 0) {
    savedEl.classList.add('show');
    setTimeout(() => savedEl.classList.remove('show'), 2500);
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Guardando...';

  // Envía cada nota secuencialmente (detiene al primer error)
  for (const entry of entries) {
    const res = await fetch('/activities/' + activityId + '/grade', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(entry),
    });
    if (!res.ok) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">save</span> Guardar notas';
      const data = await res.json();
      alert('Error al guardar nota: ' + (data.error || 'Error desconocido'));
      return;
    }
  }

  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">save</span> Guardar notas';
  savedEl.classList.add('show');
  setTimeout(() => savedEl.classList.remove('show'), 2500);

  // Invalida el cache del gradebook para que se recargue con las notas nuevas
  window._calificacionesTabLoaded = false;
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

  let html = '';
  if (act.description) {
    html += `<p style="font-size:14px;color:var(--text-secondary);margin-bottom:16px;white-space:pre-line">${act.description}</p>`;
  }

  html += '<div class="detail-meta">';
  if (act.dueDate)       html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtLong(act.dueDate)}</span>`;
  if (act.points != null) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${act.points} pts máx.</span>`;
  html += '</div>';

  html += attachmentSection(act.attachments);

  // Bloque de calificación del alumno: muestra la nota recibida o "sin calificar"
  html += '<div class="student-grade-box">';
  if (act.myGrade != null) {
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
      html += `<div class="deadline-warning">
        <span class="material-symbols-outlined" style="font-size:18px">lock</span>
        El plazo de entrega ha vencido. Las entregas están cerradas.
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
  body.innerHTML = html;

  // Fetch de la entrega actual del alumno (puede ser null si no entregó todavía)
  const subRes  = await fetch('/activities/' + activityId + '/my-submission');
  const subData = subRes.ok ? await subRes.json() : { submission: null };
  renderSubmissionSection(activityId, subData.submission, isBlocked);
}

// Array temporal de archivos seleccionados para la entrega (File objects antes de subir)
window._subFiles = [];

// Renderiza la sección de "Mi entrega" en el modal del alumno
// isBlocked=true → solo muestra el mensaje de plazo vencido, sin formulario
// submission puede ser null (primera entrega) o el objeto Submission existente (reenvío)
function renderSubmissionSection(actId, submission, isBlocked = false) {
  const container = document.getElementById('submissionSection');
  if (!container) return;

  window._subFiles = []; // Limpia archivos locales al re-renderizar

  if (isBlocked) {
    container.innerHTML = `<div style="margin-top:24px;border-top:1px solid var(--divider);padding-top:20px">
      <h4 style="font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px">
        <span class="material-symbols-outlined" style="font-size:18px;color:var(--text-hint)">upload_file</span>
        Mi entrega
      </h4>
      <div class="deadline-warning">
        <span class="material-symbols-outlined" style="font-size:18px">lock</span>
        No podés enviar tu entrega porque el plazo ha vencido.
      </div>
    </div>`;
    return;
  }

  let html = `<div style="margin-top:24px;border-top:1px solid var(--divider);padding-top:20px">
    <h4 style="font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px">
      <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">upload_file</span>
      Mi entrega
    </h4>`;

  // Si ya entregó, muestra el estado actual antes del formulario de reenvío
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

    if (submission.text) {
      html += `<p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px;white-space:pre-line">${submission.text}</p>`;
    }

    if (submission.files && submission.files.length > 0) {
      html += `<div class="att-list" style="margin-top:4px">`;
      submission.files.forEach(f => {
        const { ext, color } = extColor(f.name);
        // Link de descarga protegida: la ruta /activities/submission-file/:filename verifica acceso
        html += `<a href="/activities/submission-file/${f.filename}" download class="att-item">
          <div class="att-item-icon" style="background:${color}">${ext}</div>
          <span class="att-item-name">${f.name}</span>
          <span class="material-symbols-outlined att-item-open">download</span>
        </a>`;
      });
      html += `</div>`;
    }

    html += `</div>`;
  }

  // Formulario de entrega / reenvío
  html += `<div style="margin-bottom:10px">
    <textarea id="subText" rows="3" placeholder="Comentario (opcional)..."
      style="width:100%;padding:10px 12px;border:1px solid var(--divider);border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;background:var(--background);color:var(--text-primary);box-sizing:border-box">${submission?.text || ''}</textarea>
  </div>
  <div id="subFilePreviews" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px"></div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <label class="btn btn-outline" style="cursor:pointer;margin:0">
      <span class="material-symbols-outlined">attach_file</span>
      Adjuntar archivos
      <input type="file" id="subFileInput" multiple style="display:none"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.zip">
    </label>
    <button class="btn btn-primary" onclick="submitWork('${actId}')">
      <span class="material-symbols-outlined">send</span>
      ${submission ? 'Reenviar' : 'Entregar'}
    </button>
    <span id="subMsg" style="font-size:13px;color:var(--secondary);display:none">
      <span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px">check_circle</span>
      Entrega enviada
    </span>
  </div>`;

  html += '</div>';
  container.innerHTML = html;

  // Listener para el input de archivos de entrega (agrega al array local)
  document.getElementById('subFileInput').addEventListener('change', function () {
    Array.from(this.files).forEach(f => window._subFiles.push(f));
    this.value = '';
    renderSubFilePreviews();
  });
}

// Renderiza el grid de archivos seleccionados para la entrega (antes de subir)
function renderSubFilePreviews() {
  const grid = document.getElementById('subFilePreviews');
  if (!grid) return;
  grid.innerHTML = '';
  window._subFiles.forEach((f, i) => {
    const { ext, color } = extColor(f.name);
    const card = document.createElement('div');
    card.className = 'att-preview-card';
    card.innerHTML = `
      <div class="att-preview-thumb" style="background:${color}">
        <span class="att-preview-ext">${ext}</span>
      </div>
      <div class="att-preview-name" title="${f.name}">${f.name}</div>
      <button class="att-preview-remove" onclick="removeSubFile(${i})" title="Quitar">
        <span class="material-symbols-outlined">close</span>
      </button>
    `;
    grid.appendChild(card);
  });
}

// Elimina un archivo de entrega de la selección local por índice
function removeSubFile(i) {
  window._subFiles.splice(i, 1);
  renderSubFilePreviews();
}

// Envía la entrega del alumno (POST /activities/:id/submit como multipart/form-data)
// Después de éxito: re-renderiza la sección de entrega con los datos actualizados
async function submitWork(actId) {
  const hasExisting = !!document.querySelector('#submissionSection .sub-existing');
  if (hasExisting && !confirm('¿Querés reemplazar tu entrega anterior? La nueva entrega sobrescribirá los archivos anteriores.')) return;

  const textEl = document.getElementById('subText');
  const btn    = document.querySelector('#submissionSection .btn-primary');
  const msgEl  = document.getElementById('subMsg');

  btn.disabled  = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> Enviando...';

  const fd = new FormData();
  fd.append('text', textEl?.value?.trim() || '');
  window._subFiles.forEach(f => fd.append('files', f)); // Archivos como campo "files"

  const res  = await fetch('/activities/' + actId + '/submit', { method: 'POST', body: fd });
  const data = await res.json();

  btn.disabled  = false;
  btn.innerHTML = `<span class="material-symbols-outlined">send</span> Reenviar`;

  if (!res.ok) {
    alert(data.error || 'Error al enviar la entrega');
    return;
  }

  window._subFiles = []; // Limpia archivos locales tras éxito
  renderSubmissionSection(actId, data.submission); // Muestra el estado actualizado

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

document.getElementById('addStudentModal').addEventListener('click', function (e) {
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
    const graded = act.myGrade != null;
    const gradeCell = graded
      ? `<span class="grade-chip graded">${act.myGrade.points}${act.points != null ? ' / ' + act.points : ' pts'}</span>`
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

  const graded = activities.filter(a => a.myGrade != null).length;
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

  if (points === '' || isNaN(Number(points))) {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }

  btn.disabled    = true;
  btn.textContent = '...';

  const res = await fetch('/activities/' + activityId + '/grade', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ studentId, points: Number(points) }),
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
