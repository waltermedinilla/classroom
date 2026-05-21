let selectedImage = null;
window._activities = {}; // cache de actividades por _id

/* ─── Tabs ─── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.add('hidden'));
    document.getElementById(this.dataset.tab + 'Tab').classList.remove('hidden');

    const fab = document.getElementById('fabBtn');
    if (fab) fab.style.display = this.dataset.tab === 'activities' ? 'flex' : 'none';

    if (this.dataset.tab === 'activities' && !window._activitiesTabLoaded) {
      loadActivitiesTab();
    }
  });
});

/* ─── Stream: Novedades (anuncios + actividades mezclados) ─── */
function fmtShort(d) {
  return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtLong(d) {
  return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildAnnouncementEl(ann) {
  const div = document.createElement('div');
  div.className = 'announcement';
  div.innerHTML = `
    <div class="announcement-header">
      <div class="avatar">${ann.author.name.charAt(0).toUpperCase()}</div>
      <div>
        <div class="announcement-author">${ann.author.name}</div>
      </div>
      <div class="announcement-date">${fmtShort(ann.createdAt)}</div>
    </div>
    <div class="announcement-text">${ann.text}</div>
    ${ann.image ? `<img src="${ann.image}" class="announcement-image" alt="">` : ''}
  `;
  return div;
}

function buildActivityStreamEl(act) {
  window._activities[act._id] = act;

  let metaHtml = '';
  if (act.dueDate) {
    metaHtml += `<span class="stream-act-meta-item"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtShort(act.dueDate)}</span>`;
  }
  if (act.points != null) {
    metaHtml += `<span class="stream-act-meta-item"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${act.points} pts máx.</span>`;
  }
  if (act.myGrade != null) {
    metaHtml += `<span class="stream-grade-chip"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px">grade</span> Tu nota: <strong>${act.myGrade.points}</strong>${act.points != null ? '/' + act.points : ''} pts</span>`;
  }

  const div = document.createElement('div');
  div.className = 'stream-activity-card';
  div.innerHTML = `
    <div class="stream-activity-header">
      <div class="stream-activity-icon">
        <span class="material-symbols-outlined">assignment</span>
      </div>
      <div class="stream-activity-info">
        <div class="stream-activity-title">${act.title}</div>
        <div class="stream-activity-sub">${act.author.name} · ${new Date(act.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</div>
      </div>
    </div>
    <div class="stream-activity-body">
      <div class="stream-activity-meta">${metaHtml || '<span style="color:var(--text-hint)">Sin fecha de entrega</span>'}</div>
      <button class="btn btn-outline stream-act-btn" onclick="openActivityDetail('${act._id}')">
        <span class="material-symbols-outlined">open_in_new</span>
        Ver
      </button>
    </div>
  `;
  return div;
}

async function loadStream() {
  const container = document.getElementById('streamList');
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando...</p></div>';

  const [annRes, actRes] = await Promise.all([
    fetch('/announcements/course/' + window.COURSE_ID),
    fetch('/activities/course/' + window.COURSE_ID),
  ]);
  const annData = await annRes.json();
  const actData = await actRes.json();

  const items = [
    ...annData.announcements.map(a => ({ type: 'announcement', date: new Date(a.createdAt), data: a })),
    ...actData.activities.map(a => ({ type: 'activity', date: new Date(a.createdAt), data: a })),
  ].sort((a, b) => b.date - a.date);

  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">campaign</span></div><p>Aún no hay publicaciones</p></div>';
    return;
  }

  items.forEach(item => {
    container.appendChild(
      item.type === 'announcement' ? buildAnnouncementEl(item.data) : buildActivityStreamEl(item.data)
    );
  });
}

loadStream();

/* ─── Post Announcement ─── */
function openAnnouncementForm() {
  document.getElementById('announcementFormExpanded').classList.add('show');
  document.getElementById('announcementInput').style.display = 'none';
  document.getElementById('announcementText').focus();
}

function closeAnnouncementForm() {
  document.getElementById('announcementFormExpanded').classList.remove('show');
  document.getElementById('announcementInput').style.display = 'block';
  document.getElementById('announcementText').value = '';
  selectedImage = null;
  document.getElementById('imageInput').value = '';
  document.getElementById('imageName').textContent = '';
}

document.getElementById('imageInput').addEventListener('change', function () {
  if (this.files && this.files[0]) {
    selectedImage = this.files[0];
    document.getElementById('imageName').textContent = '📎 ' + selectedImage.name;
  }
});

async function postAnnouncement() {
  const text = document.getElementById('announcementText').value.trim();
  if (!text) return;

  const btn = document.querySelector('.announcement-form-btns .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Publicando...';

  const formData = new FormData();
  formData.append('courseId', window.COURSE_ID);
  formData.append('text', text);
  if (selectedImage) formData.append('image', selectedImage);

  const res = await fetch('/announcements/create', { method: 'POST', body: formData });
  const data = await res.json();

  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">send</span> Publicar';

  if (!res.ok) { alert(data.error); return; }

  const el = buildAnnouncementEl(data.announcement);
  const container = document.getElementById('streamList');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();
  container.prepend(el);
  closeAnnouncementForm();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ─── Crear Actividad ─── */
function openActivityModal() {
  document.getElementById('activityModal').classList.add('show');
  document.getElementById('activityTitle').focus();
}

function closeActivityModal() {
  document.getElementById('activityModal').classList.remove('show');
  ['activityTitle', 'activityDesc', 'activityDueDate', 'activityPoints', 'activityAvailableFrom']
    .forEach(id => { document.getElementById(id).value = ''; });
  const err = document.getElementById('activityError');
  err.classList.remove('show');
  err.textContent = '';
}

document.getElementById('activityModal').addEventListener('click', function (e) {
  if (e.target === this) closeActivityModal();
});

async function createActivity() {
  const title = document.getElementById('activityTitle').value.trim();
  const errorEl = document.getElementById('activityError');
  errorEl.classList.remove('show');

  if (!title) {
    errorEl.textContent = 'El título es requerido';
    errorEl.classList.add('show');
    return;
  }

  const btn = document.getElementById('activitySubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Creando...';

  const res = await fetch('/activities/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courseId: window.COURSE_ID,
      title,
      description: document.getElementById('activityDesc').value.trim(),
      dueDate: document.getElementById('activityDueDate').value || null,
      availableFrom: document.getElementById('activityAvailableFrom').value || null,
      points: document.getElementById('activityPoints').value || null,
    }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span> Crear actividad';

  if (!res.ok) {
    errorEl.textContent = data.error;
    errorEl.classList.add('show');
    return;
  }

  closeActivityModal();

  // Agregar a la pestaña Actividades
  addActivityTabCard(data.activity);

  // Agregar al stream de Novedades (solo si ya está disponible = availableFrom <= ahora)
  const availFrom = data.activity.availableFrom ? new Date(data.activity.availableFrom) : null;
  if (!availFrom || availFrom <= new Date()) {
    const streamEl = buildActivityStreamEl(data.activity);
    const container = document.getElementById('streamList');
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();
    container.prepend(streamEl);
  }
}

/* ─── Pestaña Actividades ─── */
window._activitiesTabLoaded = false;

function addActivityTabCard(act) {
  window._activities[act._id] = act;

  const container = document.getElementById('activitiesList');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  let metaHtml = `<span>Publicado el ${new Date(act.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}</span>`;
  if (act.dueDate) {
    metaHtml += `<span class="activity-due"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px">schedule</span> Entrega: ${fmtShort(act.dueDate)}</span>`;
  }
  if (act.points != null) {
    metaHtml += `<span class="activity-points-badge"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px">star</span> ${act.points} pts máx.</span>`;
  }
  if (act.myGrade != null) {
    metaHtml += `<span class="stream-grade-chip"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-3px">grade</span> Tu nota: <strong>${act.myGrade.points}</strong>${act.points != null ? '/' + act.points : ''}</span>`;
  }

  const div = document.createElement('div');
  div.className = 'activity-card';
  div.style.cursor = 'pointer';
  div.onclick = () => openActivityDetail(act._id);
  div.innerHTML = `
    <div class="activity-icon">
      <span class="material-symbols-outlined">assignment</span>
    </div>
    <div class="activity-info">
      <div class="activity-title">${act.title}</div>
      ${act.description ? `<div class="activity-desc">${act.description}</div>` : ''}
      <div class="activity-meta">${metaHtml}</div>
    </div>
    <span class="material-symbols-outlined" style="color:var(--text-hint);flex-shrink:0">chevron_right</span>
  `;

  container.prepend(div);
}

async function loadActivitiesTab() {
  window._activitiesTabLoaded = true;
  const container = document.getElementById('activitiesList');
  container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando actividades...</p></div>';

  const res = await fetch('/activities/course/' + window.COURSE_ID);
  const data = await res.json();

  container.innerHTML = '';
  if (data.activities.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"><span class="material-symbols-outlined">assignment</span></div><p>Aún no hay actividades</p></div>';
    return;
  }

  data.activities.forEach(act => addActivityTabCard(act));
}

/* ─── Modal Detalle de Actividad ─── */
function openActivityDetail(activityId) {
  document.getElementById('activityDetailModal').classList.add('show');
  const body = document.getElementById('detailBody');
  body.innerHTML = '<div class="empty-state" style="padding:40px 0"><div class="empty-icon"><span class="material-symbols-outlined">hourglass_empty</span></div><p>Cargando...</p></div>';

  if (window.IS_OWNER) {
    loadTeacherDetail(activityId);
  } else {
    loadStudentDetail(activityId);
  }
}

function closeActivityDetail() {
  document.getElementById('activityDetailModal').classList.remove('show');
}

document.getElementById('activityDetailModal').addEventListener('click', function (e) {
  if (e.target === this) closeActivityDetail();
});

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { closeActivityModal(); closeActivityDetail(); }
});

async function loadTeacherDetail(activityId) {
  const body = document.getElementById('detailBody');
  const res = await fetch('/activities/' + activityId + '/grades');
  if (!res.ok) { body.innerHTML = '<p style="color:var(--danger)">Error al cargar la actividad.</p>'; return; }

  const { activity, studentGrades } = await res.json();
  document.getElementById('detailTitle').textContent = activity.title;

  let html = '';
  if (activity.description) {
    html += `<p style="font-size:14px;color:var(--text-secondary);margin-bottom:16px;white-space:pre-line">${activity.description}</p>`;
  }

  html += '<div class="detail-meta">';
  if (activity.dueDate) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtLong(activity.dueDate)}</span>`;
  if (activity.points != null) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${activity.points} pts máx.</span>`;
  if (activity.availableFrom) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">event_available</span> Disponible desde: ${fmtLong(activity.availableFrom)}</span>`;
  html += '</div>';

  const graded = studentGrades.filter(s => s.points != null).length;
  if (studentGrades.length === 0) {
    html += '<div class="empty-state small" style="margin-top:24px"><p>No hay alumnos inscriptos en este curso</p></div>';
  } else {
    html += `
      <h4 style="margin:24px 0 12px;font-size:15px;color:var(--text)">
        Calificaciones — <span style="color:var(--secondary)">${graded}</span> / ${studentGrades.length} calificados
      </h4>
      <div class="grade-table-wrap">
        <table class="grade-table">
          <thead><tr>
            <th>Alumno</th>
            <th>Email</th>
            <th style="text-align:center">Nota${activity.points != null ? ' / ' + activity.points : ''}</th>
            <th></th>
          </tr></thead>
          <tbody>`;

    studentGrades.forEach(sg => {
      html += `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:10px">
              <div class="avatar" style="width:32px;height:32px;font-size:14px">${sg.name.charAt(0).toUpperCase()}</div>
              <span style="font-weight:500">${sg.name}</span>
            </div>
          </td>
          <td class="td-email">${sg.email}</td>
          <td style="text-align:center">
            <input class="grade-input" type="number" min="0" max="${activity.points || 9999}"
              value="${sg.points ?? ''}" placeholder="—"
              id="gi-${sg._id}">
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn btn-primary" style="font-size:12px;padding:5px 14px"
                onclick="saveGrade('${activity._id}','${sg._id}',this)">Guardar</button>
              <span class="grade-saved" id="gs-${sg._id}">✓ Guardado</span>
            </div>
          </td>
        </tr>`;
    });

    html += '</tbody></table></div>';
  }

  body.innerHTML = html;
}

function loadStudentDetail(activityId) {
  const act = window._activities[activityId];
  const body = document.getElementById('detailBody');
  document.getElementById('detailTitle').textContent = act ? act.title : 'Actividad';

  if (!act) { body.innerHTML = '<p>No se pudo cargar la actividad.</p>'; return; }

  let html = '';
  if (act.description) {
    html += `<p style="font-size:14px;color:var(--text-secondary);margin-bottom:16px;white-space:pre-line">${act.description}</p>`;
  }

  html += '<div class="detail-meta">';
  if (act.dueDate) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">schedule</span> Entrega: ${fmtLong(act.dueDate)}</span>`;
  if (act.points != null) html += `<span><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">star</span> ${act.points} pts máx.</span>`;
  html += '</div>';

  html += '<div class="student-grade-box">';
  if (act.myGrade != null) {
    const pct = act.points ? Math.round((act.myGrade.points / act.points) * 100) : null;
    html += `
      <span class="material-symbols-outlined" style="color:var(--secondary);font-size:32px">grade</span>
      <div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">Tu calificación</div>
        <div style="font-size:28px;font-weight:700;color:var(--secondary);line-height:1">
          ${act.myGrade.points}${act.points != null ? '<span style="font-size:16px;color:var(--text-hint)"> / ' + act.points + ' pts</span>' : ' pts'}
        </div>
        ${pct != null ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:4px">${pct}%</div>` : ''}
      </div>`;
  } else {
    html += `
      <span class="material-symbols-outlined" style="color:var(--text-hint);font-size:32px">hourglass_empty</span>
      <div style="color:var(--text-secondary)">Aún no calificado</div>`;
  }
  html += '</div>';

  body.innerHTML = html;
}

async function saveGrade(activityId, studentId, btn) {
  const input = document.getElementById('gi-' + studentId);
  const savedEl = document.getElementById('gs-' + studentId);
  const points = input.value;

  if (points === '' || isNaN(Number(points))) {
    input.style.borderColor = 'var(--danger)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    return;
  }

  btn.disabled = true;
  btn.textContent = '...';

  const res = await fetch('/activities/' + activityId + '/grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId, points: Number(points) }),
  });

  btn.disabled = false;
  btn.textContent = 'Guardar';

  if (res.ok) {
    savedEl.classList.add('show');
    setTimeout(() => savedEl.classList.remove('show'), 2500);
  } else {
    const d = await res.json();
    alert(d.error);
  }
}
