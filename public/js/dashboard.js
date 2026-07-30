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

// El modal "Unirse a clase" (código de 6 caracteres) se eliminó junto con la ruta
// POST /courses/join el 2026-07-30. Queda solo "Enviar solicitud para unirme", que manda
// una sugerencia al superadmin en vez de matricular.
//
// Las guardas `if (!modal) return` y los `?.` de los listeners se mantienen: el modal de
// solicitud no existe en el DOM para los docentes (ver dashboard.ejs), y sin la guarda el
// TypeError se llevaba puesto también al modal de crear clase.
function showRequestModal() {
  const modal = document.getElementById('requestModal');
  if (!modal) return;
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function hideRequestModal() {
  const modal = document.getElementById('requestModal');
  if (!modal) return;
  modal.classList.remove('show');
  document.body.style.overflow = '';
  document.getElementById('requestForm').reset();
  document.getElementById('requestError').classList.remove('show');
  document.getElementById('requestOk').classList.remove('show');
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    hideCreateModal();
    hideRequestModal();
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

document.getElementById('createModal').addEventListener('click', function(e) {
  if (e.target === this) hideCreateModal();
});
document.getElementById('requestModal')?.addEventListener('click', function(e) {
  if (e.target === this) hideRequestModal();
});

// Solicitud para unirse a una materia. No matricula: arma un texto con DNI + nombre y lo
// manda a POST /suggestions, el mismo endpoint que el botón de sugerencias del footer, así
// aparece en /superadmin/suggestions junto a todo lo demás y sin tocar el modelo.
document.getElementById('requestForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('requestError');
  const okEl    = document.getElementById('requestOk');
  const btn     = e.target.querySelector('button[type="submit"]');
  errorEl.classList.remove('show');
  okEl.classList.remove('show');

  // El DNI se normaliza a dígitos igual que en /register/lookup, para que el superadmin
  // reciba siempre el mismo formato y pueda buscarlo tal cual en el panel de usuarios.
  const dni  = document.getElementById('requestDni').value.replace(/\D/g, '');
  const name = document.getElementById('requestName').value.trim();

  if (dni.length < 6) {
    errorEl.textContent = 'Ingresá un DNI válido (mínimo 6 dígitos)';
    errorEl.classList.add('show');
    return;
  }
  if (!name) {
    errorEl.textContent = 'Ingresá el nombre completo del alumno';
    errorEl.classList.add('show');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Enviando...';

  try {
    const res = await fetch('/suggestions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: 'Solicitud para unirse a una materia\nDNI del alumno: ' + dni + '\nNombre completo: ' + name,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'No se pudo enviar la solicitud';
      errorEl.classList.add('show');
      return;
    }

    okEl.textContent = '¡Solicitud enviada! El administrador la va a revisar.';
    okEl.classList.add('show');
    document.getElementById('requestDni').value  = '';
    document.getElementById('requestName').value = '';
    setTimeout(hideRequestModal, 2000);
  } catch {
    errorEl.textContent = 'Error de conexión. Intentá de nuevo.';
    errorEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">send</span> Enviar solicitud';
  }
});
