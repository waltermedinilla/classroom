// Abre el modal de "Crear clase" bloqueando el scroll del body
function showCreateModal() {
  document.getElementById('createModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

// Cierra el modal de "Crear clase", limpia el formulario y oculta errores
function hideCreateModal() {
  document.getElementById('createModal').classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('createForm').reset();
  document.getElementById('createError').classList.remove('show');
}

// Abre el modal de "Unirse a clase"
function showJoinModal() {
  document.getElementById('joinModal').classList.add('show');
  document.body.style.overflow = 'hidden';
}

// Cierra el modal de "Unirse a clase" y limpia el formulario
function hideJoinModal() {
  document.getElementById('joinModal').classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('joinForm').reset();
  document.getElementById('joinError').classList.remove('show');
}

// Cierra cualquier modal abierto al presionar Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    hideCreateModal();
    hideJoinModal();
  }
});

// Maneja el envío del formulario de creación de clase
// POST /courses/create con { name, section, subject, room }
// Al éxito redirige a la página del curso recién creado
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
      name:    document.getElementById('className').value,
      section: document.getElementById('section').value,
      subject: document.getElementById('subject').value,
      room:    document.getElementById('room').value,
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

  // Redirige a la página del curso creado para empezar a usarlo de inmediato
  window.location.href = '/courses/' + data.course._id;
});

// Maneja el envío del formulario de "Unirse a clase"
// POST /courses/join con { code } (código de 6 caracteres)
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

// Cierra el modal si el usuario hace clic en el overlay (fondo oscuro)
document.getElementById('createModal').addEventListener('click', function(e) {
  if (e.target === this) hideCreateModal();
});
document.getElementById('joinModal').addEventListener('click', function(e) {
  if (e.target === this) hideJoinModal();
});

// Copia el código del curso al portapapeles y muestra un toast de confirmación
// code viene del atributo onclick de cada tarjeta en dashboard.ejs: copyCode('<%= course.code %>')
function copyCode(code) {
  navigator.clipboard.writeText(code).then(() => {
    const toast = document.createElement('div');
    toast.className = 'card-copied-toast';
    toast.textContent = 'Código copiado: ' + code;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200); // Se auto-elimina después de 2.2 segundos
  });
}
