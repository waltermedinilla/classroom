/* Curso del alumno — FUNCIÓN TEMPORAL (ver services/selfEnroll.js).
   El campo solo tiene sentido para el rol Alumno: el docente no se matricula en un curso.
   Si la automatrícula está apagada, la vista no pinta el <select> y todo esto queda inerte. */
const rolSelect   = document.getElementById('role');
const cursoGroup  = document.getElementById('cursoGroup');
const cursoSelect = document.getElementById('divisionId');
const cursoHint   = document.getElementById('cursoHint');

function actualizarCampoCurso() {
  if (!cursoGroup) return;
  const esAlumno = rolSelect.value === 'student';
  cursoGroup.style.display = esAlumno ? '' : 'none';
  if (cursoHint) cursoHint.style.display = esAlumno ? '' : 'none';
  if (!esAlumno) cursoSelect.value = ''; // no mandar un curso elegido y después cambiar a Docente
}

rolSelect.addEventListener('change', actualizarCampoCurso);
actualizarCampoCurso();

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.classList.remove('show');
  errorEl.textContent = '';

  // Validación en el cliente solo para evitar el viaje de ida y vuelta: el que decide es
  // el POST /register, que rechaza igual al alumno sin curso.
  if (cursoSelect && rolSelect.value === 'student' && !cursoSelect.value) {
    errorEl.textContent = 'Elegí tu curso de la lista.';
    errorEl.classList.add('show');
    cursoSelect.focus();
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Registrando...';

  const res = await fetch('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('name').value,
      dni: document.getElementById('dni').value,
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
      role: rolSelect.value,
      divisionId: cursoSelect ? cursoSelect.value : '',
    }),
  });

  const data = await res.json();
  btn.disabled = false;
  btn.innerHTML = '<span class="material-symbols-outlined">person_add</span> Registrarse';

  if (!res.ok) {
    errorEl.textContent = data.error;
    errorEl.classList.add('show');
    return;
  }

  window.location.href = '/';
});
