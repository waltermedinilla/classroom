/* Task Runner — render interactivo de una plantilla para que el usuario responda.
 *
 * Se usa en:
 *   - Preview del superadmin (posteando a /superadmin/tasks/:id/preview-grade).
 *   - Fase 5: entrega del alumno (posteando a /activities/:id/submit — se cambia
 *     window._runner.gradeUrl al montar y se agrega el flag persist=true).
 *
 * Estado en window._runner = { templateId, questions[], gradeUrl }.
 * Los answers[] del alumno se van reconstruyendo con recolección desde el DOM
 * al momento de enviar (no mantenemos un state redundante). */

// Función pública: mountRunner(cfg) — permite reusar el runner en distintos
// contextos (preview superadmin, modal alumno). El bootstrapping desde
// window._runner al DOMContentLoaded queda para no romper la vista de preview.
window.mountRunner = function (cfg, opts) {
  opts = opts || {};
  const containerId = opts.containerId || 'runnerContainer';
  const submitId    = opts.submitId    || 'btnSubmitRun';
  const resultId    = opts.resultId    || 'runnerResult';
  runnerImpl(cfg, containerId, submitId, resultId);
};

(function () {
  const cfg = window._runner;
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ── Render por tipo ─────────────────────────────────────────────────────────

  function typeMeta(type) {
    return ({
      common: { label: 'Actividad común',  icon: 'description' },
      mc:     { label: 'Múltiple choice',  icon: 'radio_button_checked' },
      tf:     { label: 'Verdadero / Falso', icon: 'check_circle' },
      match:  { label: 'Unir con flechas', icon: 'swap_horiz' },
      fill:   { label: 'Completar palabra', icon: 'edit_note' },
    })[type] || { label: type, icon: 'help' };
  }

  function renderCommon(q) {
    return `
      ${q.common && q.common.instructions ? `<p class="run-common-instr">${escapeHtml(q.common.instructions)}</p>` : ''}
      <textarea class="run-common-text" data-q="${q._id}" rows="4" placeholder="Escribí tu respuesta…"></textarea>
      <p class="q-hint">Esta actividad la califica manualmente el docente.</p>
    `;
  }

  function renderMc(q) {
    const inputType = q.mc.multipleAllowed ? 'checkbox' : 'radio';
    return `
      <div class="run-mc-list">
        ${q.mc.options.map((o, i) => `
          <label class="run-mc-option">
            <input type="${inputType}" name="mc-${q._id}" value="${o._id}" data-q="${q._id}" data-opt="${o._id}">
            <span>${escapeHtml(o.text)}</span>
          </label>
        `).join('')}
      </div>
    `;
  }

  function renderTf(q) {
    return `
      <div class="run-tf-choice">
        <label><input type="radio" name="tf-${q._id}" value="true"  data-q="${q._id}"> Verdadero</label>
        <label><input type="radio" name="tf-${q._id}" value="false" data-q="${q._id}"> Falso</label>
      </div>
    `;
  }

  function renderMatch(q) {
    // Para cada item de la izquierda, un <select> con los items de la derecha.
    // Simple, accesible y sin dependencias — el drag & drop puede sumarse después.
    return `
      <div class="run-match">
        ${q.match.leftItems.map(l => `
          <div class="run-match-row" data-q="${q._id}" data-left="${l._id}">
            <span class="run-match-left">${escapeHtml(l.text)}</span>
            <span class="material-symbols-outlined">arrow_forward</span>
            <select class="run-match-select" data-q="${q._id}" data-left="${l._id}">
              <option value="">— elegir —</option>
              ${q.match.rightItems.map(r => `<option value="${r._id}">${escapeHtml(r.text)}</option>`).join('')}
            </select>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderFill(q) {
    // Reemplazo {{blank}} por un input inline.
    const [before, after] = (q.fill.template || '').split('{{blank}}');
    return `
      <p class="run-fill-line">
        <span>${escapeHtml(before || '')}</span>
        <input type="text" class="run-fill-input" data-q="${q._id}" placeholder="?">
        <span>${escapeHtml(after || '')}</span>
      </p>
    `;
  }

  function renderQuestion(q, idx) {
    const meta = typeMeta(q.type);
    const body = ({
      common: renderCommon,
      mc:     renderMc,
      tf:     renderTf,
      match:  renderMatch,
      fill:   renderFill,
    })[q.type];
    return `
      <div class="run-card" data-q="${q._id}">
        <div class="run-card-head">
          <span class="run-card-type">
            <span class="material-symbols-outlined">${meta.icon}</span>
            ${meta.label}
          </span>
          <span class="run-card-idx">Pregunta ${idx + 1} · ${q.points} pt${q.points === 1 ? '' : 's'}</span>
        </div>
        <p class="run-card-prompt">${escapeHtml(q.prompt)}</p>
        <div class="run-card-body">${body ? body(q) : ''}</div>
      </div>
    `;
  }

  // ── Recolección de respuestas ───────────────────────────────────────────────

  function collectAnswers() {
    const answers = [];
    for (const q of cfg.questions) {
      const a = { questionId: q._id };
      if (q.type === 'common') {
        const el = document.querySelector(`.run-common-text[data-q="${q._id}"]`);
        a.common = { text: el ? el.value : '' };
      }
      if (q.type === 'mc') {
        const selected = [...document.querySelectorAll(`input[name="mc-${q._id}"]:checked`)].map(el => el.value);
        a.mc = { selected };
      }
      if (q.type === 'tf') {
        const el = document.querySelector(`input[name="tf-${q._id}"]:checked`);
        a.tf = { answer: el ? el.value === 'true' : null };
      }
      if (q.type === 'match') {
        const pairs = [...document.querySelectorAll(`.run-match-select[data-q="${q._id}"]`)]
          .filter(s => s.value)
          .map(s => ({ leftId: s.dataset.left, rightId: s.value }));
        a.match = { pairs };
      }
      if (q.type === 'fill') {
        const el = document.querySelector(`.run-fill-input[data-q="${q._id}"]`);
        a.fill = { text: el ? el.value : '' };
      }
      answers.push(a);
    }
    return answers;
  }

  // ── Render inicial + submit ─────────────────────────────────────────────────

  function render() {
    const c = $('runnerContainer');
    if (!cfg.questions.length) {
      c.innerHTML = `<div class="empty-state"><p>Esta plantilla no tiene preguntas.</p></div>`;
      return;
    }
    c.innerHTML = cfg.questions.map(renderQuestion).join('');
  }

  async function submit() {
    const btn = $('btnSubmitRun');
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Enviando…';

    const answers = collectAnswers();
    const res = await fetch(cfg.gradeUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ answers }),
    });
    const data = await res.json();
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">check</span> Enviar respuestas';

    if (!res.ok) { alert(data.error || 'Error'); return; }
    // El shape depende del endpoint:
    //   - Preview del superadmin: { result: {points, maxPoints, breakdown} }
    //   - Submit del alumno:      { submission: { autoGraded: {...} } }
    const result = data.result || (data.submission && data.submission.autoGraded) || data;
    showResult(result);

    // Enviar respuestas ES entregar: crea una Submission igual que subir un archivo. Le
    // avisamos a la pantalla de la materia para que la tarjeta pase a "Entregada" y la
    // actividad salga de "Próximas entregas" sin recargar. En la preview del superadmin no
    // hay ni submission ni activityId, así que esto no corre.
    if (data.submission && cfg.activityId && window.marcarActividadEntregada) {
      window.marcarActividadEntregada(cfg.activityId, data.submission);
    }
  }

  function showResult(result) {
    const box = $('runnerResult');
    const pct = result.maxPoints > 0 ? Math.round(result.points / result.maxPoints * 100) : 0;
    const rows = (result.breakdown || []).map(b => {
      const q = cfg.questions.find(x => String(x._id) === String(b.questionId));
      const icon = b.correct === true ? 'check_circle' : b.correct === false ? 'cancel' : 'help';
      const color = b.correct === true ? '#137333' : b.correct === false ? '#c5221f' : '#5f6368';
      return `
        <div class="result-row">
          <span class="material-symbols-outlined" style="color:${color}">${icon}</span>
          <div class="result-row-info">
            <div class="result-row-prompt">${escapeHtml(q ? q.prompt : '')}</div>
            <div class="result-row-meta">${b.awarded} / ${b.max} pts</div>
          </div>
        </div>
      `;
    }).join('');
    box.innerHTML = `
      <div class="result-header">
        <div class="result-score">
          <span class="result-score-value">${result.points}</span>
          <span class="result-score-max">/ ${result.maxPoints}</span>
        </div>
        <div class="result-score-pct">${pct}%</div>
      </div>
      <div class="result-list">${rows}</div>
    `;
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (cfg && document.getElementById('runnerContainer')) {
      render();
      const btn = $('btnSubmitRun');
      if (btn) btn.addEventListener('click', submit);
    }
  });

  // Expone la impl como función para que mountRunner la pueda llamar múltiples veces.
  window.runnerImpl = function (cfgArg, containerId, submitId, resultId) {
    const container = document.getElementById(containerId);
    const submitBtn = document.getElementById(submitId);
    if (!container) return;
    // Sustituyo el cfg del closure temporalmente.
    Object.assign(cfg || (window._runner = {}), cfgArg);
    // Re-render y wire del botón.
    (function localRender() {
      if (!cfg.questions.length) {
        container.innerHTML = '<div class="empty-state"><p>Esta actividad no tiene preguntas.</p></div>';
        return;
      }
      // Reusamos renderQuestion / renderCommon / etc. definidos arriba.
      container.innerHTML = cfg.questions.map(function (q, i) {
        return renderQuestion(q, i);
      }).join('');
    })();
    if (submitBtn) {
      // Reemplaza cualquier listener previo clonando el nodo.
      const fresh = submitBtn.cloneNode(true);
      submitBtn.parentNode.replaceChild(fresh, submitBtn);
      fresh.addEventListener('click', function () { submitViaCustomIds(fresh, resultId); });
    }
  };

  function submitViaCustomIds(btn, resultId) {
    btn.disabled = true;
    btn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Enviando…';
    const answers = collectAnswers();
    fetch(cfg.gradeUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify({ answers }),
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">check</span> Enviar respuestas';
      if (!r.ok) { alert(r.data.error || 'Error'); return; }
      const result = r.data.result || (r.data.submission && r.data.submission.autoGraded) || r.data;
      // Muestro el resultado en un contenedor con id `resultId`. Reuso el mismo formateo.
      const box = document.getElementById(resultId);
      if (!box) return;
      const pct = result.maxPoints > 0 ? Math.round(result.points / result.maxPoints * 100) : 0;
      const rows = (result.breakdown || []).map(function (b) {
        const q    = cfg.questions.find(function (x) { return String(x._id) === String(b.questionId); });
        const icon = b.correct === true ? 'check_circle' : b.correct === false ? 'cancel' : 'help';
        const color = b.correct === true ? '#137333' : b.correct === false ? '#c5221f' : '#5f6368';
        const prompt = q ? q.prompt : '';
        return '<div class="result-row"><span class="material-symbols-outlined" style="color:' + color + '">' + icon + '</span><div class="result-row-info"><div class="result-row-prompt">' + prompt + '</div><div class="result-row-meta">' + b.awarded + ' / ' + b.max + ' pts</div></div></div>';
      }).join('');
      box.innerHTML = '<div class="result-header"><div class="result-score"><span class="result-score-value">' + result.points + '</span><span class="result-score-max">/ ' + result.maxPoints + '</span></div><div class="result-score-pct">' + pct + '%</div></div><div class="result-list">' + rows + '</div>';
      box.style.display = 'block';
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
})();
