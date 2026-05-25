// Carga las divisiones disponibles para la escuela del usuario en el selector del modal
async function loadDivisions() {
  const sel = document.getElementById('divisionId');
  sel.innerHTML = '<option value="">Cargando...</option>';
  try {
    const res  = await fetch('/courses/divisions');
    const data = await res.json();
    if (!data.divisions || data.divisions.length === 0) {
      sel.innerHTML = '<option value="">Sin cursos — el admin debe crearlos</option>';
      return;
    }
    sel.innerHTML = '<option value="">Seleccioná un curso...</option>' +
      data.divisions.map(d => `<option value="${d._id}">${d.name}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">Error al cargar cursos</option>';
  }
}

function showCreateModal() {
  document.getElementById('createModal').classList.add('show');
  document.body.style.overflow = 'hidden';
  loadDivisions();
}

function hideCreateModal() {
  document.getElementById('createModal').classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('createForm').reset();
  document.getElementById('createError').classList.remove('show');
}

function showJoinModal() {
  document.getElementById('joinModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function hideJoinModal() {
  document.getElementById('joinModal').classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('joinForm').reset();
  document.getElementById('joinError').classList.remove('show');
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    hideCreateModal();
    hideJoinModal();
  }
});

document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('createError');
  errorEl.classList.remove('show');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Creando...';

  const res = await fetch('/courses/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:       document.getElementById('className').value,
      divisionId: document.getElementById('divisionId').value,
      room:       document.getElementById('room').value,
    }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">check</span> Crear';

  if (!res.ok) {
    errorEl.textContent = data.error;
    errorEl.classList.add('show');
    return;
  }

  window.location.href = '/courses/' + data.course._id;
});

document.getElementById('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('joinError');
  errorEl.classList.remove('show');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Uniendo...';

  const res = await fetch('/courses/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: document.getElementById('classCode').value }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">arrow_forward</span> Unirse';

  if (!res.ok) {
    errorEl.textContent = data.error;
    errorEl.classList.add('show');
    return;
  }

  window.location.href = '/courses/' + data.course._id;
});

document.getElementById('createModal').addEventListener('click', function(e) {
  if (e.target === this) hideCreateModal();
});
document.getElementById('joinModal').addEventListener('click', function(e) {
  if (e.target === this) hideJoinModal();
});

function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => {
    const toast = document.createElement('div');
    toast.className = 'card-copied-toast';
    toast.textContent = 'Código copiado: ' + code;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  });
}
