function showCreateModal() {
  document.getElementById('createModal').classList.add('show');
  document.body.style.overflow = 'hidden';
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
      name: document.getElementById('className').value,
      section: document.getElementById('section').value,
      subject: document.getElementById('subject').value,
      room: document.getElementById('room').value,
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
