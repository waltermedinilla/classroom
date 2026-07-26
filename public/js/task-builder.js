/* Task Builder — editor de plantillas de actividad para el superadmin.
 *
 * Estado global en window._builder = { id, questions[] }.
 * Cada pregunta es un objeto con al menos { type, prompt, points } + el sub-objeto
 * específico del tipo. Los ids son temporales en el cliente (tmp-*) y el server
 * les asigna un ObjectId real al guardar; después re-hidratamos con la respuesta.
 *
 * Estilo: vanilla + template literals + re-render entero de #questionsContainer
 * cada vez que cambia algo. Es lo suficientemente barato para el volumen esperado
 * y evita bugs de sincronización que traería el enfoque incremental. */

(function () {
  const state = window._builder;
  const $ = (id) => document.getElementById(id);

  function tmpId() { return 'tmp-' + Math.random().toString(36).slice(2, 10); }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Ciclo de vida de preguntas ──────────────────────────────────────────────

  window.addQuestion = function (type) {
    const base = { _id: tmpId(), type, prompt: '', points: 1 };
    if (type === 'mc')     base.mc     = { options: [{ _id: tmpId(), text: '', isCorrect: false }, { _id: tmpId(), text: '', isCorrect: false }], multipleAllowed: false };
    if (type === 'tf')     base.tf     = { correctAnswer: true };
    if (type === 'match')  base.match  = { leftItems: [{ _id: tmpId(), text: '' }, { _id: tmpId(), text: '' }], rightItems: [{ _id: tmpId(), text: '' }, { _id: tmpId(), text: '' }], correctPairs: [] };
    if (type === 'fill')   base.fill   = { template: '', acceptedAnswers: [''] };
    if (type === 'common') base.common = { instructions: '' };
    state.questions.push(base);
    render();
    // Scroll a la última tarjeta.
    const cards = document.querySelectorAll('.question-card');
    if (cards.length) cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  window.removeQuestion = function (idx) {
    if (!confirm('¿Eliminar esta pregunta?')) return;
    state.questions.splice(idx, 1);
    render();
  };

  window.moveQuestion = function (idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= state.questions.length) return;
    const [q] = state.questions.splice(idx, 1);
    state.questions.splice(j, 0, q);
    render();
  };

  // Handler unificado: onchange/oninput → aplica patch al state y re-render selectivo
  // (por simplicidad, re-render completo).
  function patch(idx, path, value) {
    const q = state.questions[idx];
    const parts = path.split('.');
    let obj = q;
    for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
    obj[parts[parts.length - 1]] = value;
    render();
  }
  window._patch = patch; // expuesto para los handlers inline

  // ── Handlers de tipos específicos ───────────────────────────────────────────

  window.addMcOption = function (qIdx) {
    state.questions[qIdx].mc.options.push({ _id: tmpId(), text: '', isCorrect: false });
    render();
  };
  window.removeMcOption = function (qIdx, oIdx) {
    if (state.questions[qIdx].mc.options.length <= 2) { alert('Necesitás al menos 2 opciones.'); return; }
    state.questions[qIdx].mc.options.splice(oIdx, 1);
    render();
  };
  window.toggleMcCorrect = function (qIdx, oIdx, checked) {
    const q = state.questions[qIdx];
    if (!q.mc.multipleAllowed) {
      q.mc.options.forEach((o, i) => { o.isCorrect = (i === oIdx) && checked; });
    } else {
      q.mc.options[oIdx].isCorrect = checked;
    }
    render();
  };
  window.toggleMcMulti = function (qIdx, checked) {
    state.questions[qIdx].mc.multipleAllowed = checked;
    if (!checked) {
      // Al pasar a single-answer, dejo solo la primera marcada como correcta.
      let seen = false;
      state.questions[qIdx].mc.options.forEach(o => {
        if (o.isCorrect && !seen) seen = true;
        else o.isCorrect = false;
      });
    }
    render();
  };

  window.addMatchItem = function (qIdx, side) {
    state.questions[qIdx].match[side].push({ _id: tmpId(), text: '' });
    render();
  };
  window.removeMatchItem = function (qIdx, side, iIdx) {
    if (state.questions[qIdx].match[side].length <= 2) { alert('Necesitás al menos 2 items por columna.'); return; }
    const removed = state.questions[qIdx].match[side].splice(iIdx, 1)[0];
    // Limpio pares que referenciaban el item borrado.
    const idField = side === 'leftItems' ? 'leftId' : 'rightId';
    state.questions[qIdx].match.correctPairs = state.questions[qIdx].match.correctPairs.filter(p => String(p[idField]) !== String(removed._id));
    render();
  };
  window.setMatchPair = function (qIdx, leftId, rightId) {
    const q = state.questions[qIdx];
    // Regla: cada left tiene UN right correcto. Reemplazamos si ya existía.
    q.match.correctPairs = q.match.correctPairs.filter(p => String(p.leftId) !== String(leftId));
    if (rightId) q.match.correctPairs.push({ leftId, rightId });
    render();
  };

  window.addFillAnswer = function (qIdx) {
    state.questions[qIdx].fill.acceptedAnswers.push('');
    render();
  };
  window.removeFillAnswer = function (qIdx, aIdx) {
    if (state.questions[qIdx].fill.acceptedAnswers.length <= 1) { alert('Al menos una respuesta aceptada.'); return; }
    state.questions[qIdx].fill.acceptedAnswers.splice(aIdx, 1);
    render();
  };

  // ── Renderizado ─────────────────────────────────────────────────────────────

  function typeMeta(type) {
    return ({
      common: { label: 'Actividad común',  icon: 'description' },
      mc:     { label: 'Múltiple choice',  icon: 'radio_button_checked' },
      tf:     { label: 'Verdadero / Falso', icon: 'check_circle' },
      match:  { label: 'Unir con flechas', icon: 'swap_horiz' },
      fill:   { label: 'Completar palabra', icon: 'edit_note' },
    })[type] || { label: type, icon: 'help' };
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
      <div class="question-card" data-idx="${idx}">
        <div class="question-card-head">
          <span class="question-card-type">
            <span class="material-symbols-outlined">${meta.icon}</span>
            ${meta.label}
          </span>
          <span class="question-card-idx">Pregunta ${idx + 1}</span>
          <div class="question-card-actions">
            <button class="icon-btn" title="Subir" onclick="moveQuestion(${idx}, -1)"><span class="material-symbols-outlined">arrow_upward</span></button>
            <button class="icon-btn" title="Bajar" onclick="moveQuestion(${idx}, 1)"><span class="material-symbols-outlined">arrow_downward</span></button>
            <button class="icon-btn" title="Eliminar" onclick="removeQuestion(${idx})" style="color:var(--danger)"><span class="material-symbols-outlined">delete</span></button>
          </div>
        </div>
        <div class="question-card-body">
          <div class="q-row">
            <label class="q-label">Enunciado</label>
            <textarea class="q-prompt" oninput="_patch(${idx}, 'prompt', this.value)" placeholder="Escribí el enunciado…" rows="2">${escapeAttr(q.prompt)}</textarea>
          </div>
          ${body(q, idx)}
          <div class="q-row q-row-inline">
            <label class="q-label">Puntos</label>
            <input type="number" class="q-points" min="0" value="${q.points}" oninput="_patch(${idx}, 'points', Number(this.value)||0)">
          </div>
        </div>
      </div>
    `;
  }

  function renderCommon(q, idx) {
    return `
      <div class="q-row">
        <label class="q-label">Instrucciones (opcional)</label>
        <textarea class="q-common-instr" rows="3" oninput="_patch(${idx}, 'common.instructions', this.value)" placeholder="Detalles adicionales para el alumno…">${escapeAttr(q.common && q.common.instructions || '')}</textarea>
      </div>
      <p class="q-hint">La actividad común es entrega libre (texto y/o archivos). El docente la califica manualmente después.</p>
    `;
  }

  function renderMc(q, idx) {
    const opts = q.mc.options.map((o, oIdx) => `
      <div class="mc-option-editor">
        <input type="${q.mc.multipleAllowed ? 'checkbox' : 'radio'}" name="mc-correct-${idx}" ${o.isCorrect ? 'checked' : ''} onchange="toggleMcCorrect(${idx}, ${oIdx}, this.checked)">
        <input type="text" class="mc-option-text" value="${escapeAttr(o.text)}" oninput="_patch(${idx}, 'mc.options.${oIdx}.text', this.value)" placeholder="Opción ${oIdx + 1}">
        <button class="icon-btn" title="Eliminar opción" onclick="removeMcOption(${idx}, ${oIdx})" style="color:var(--danger)"><span class="material-symbols-outlined">close</span></button>
      </div>
    `).join('');
    return `
      <div class="q-row">
        <label class="q-checkbox">
          <input type="checkbox" ${q.mc.multipleAllowed ? 'checked' : ''} onchange="toggleMcMulti(${idx}, this.checked)">
          Permitir múltiples respuestas correctas
        </label>
      </div>
      <div class="q-row">
        <label class="q-label">Opciones (marcá la/las correctas)</label>
        <div class="mc-options-list">${opts}</div>
        <button class="btn-add-small" onclick="addMcOption(${idx})">
          <span class="material-symbols-outlined">add</span>
          Agregar opción
        </button>
      </div>
    `;
  }

  function renderTf(q, idx) {
    return `
      <div class="q-row">
        <label class="q-label">Respuesta correcta</label>
        <div class="tf-choice-editor">
          <label><input type="radio" name="tf-${idx}" ${q.tf.correctAnswer ? 'checked' : ''} onchange="_patch(${idx}, 'tf.correctAnswer', true)"> Verdadero</label>
          <label><input type="radio" name="tf-${idx}" ${!q.tf.correctAnswer ? 'checked' : ''} onchange="_patch(${idx}, 'tf.correctAnswer', false)"> Falso</label>
        </div>
      </div>
    `;
  }

  function renderMatch(q, idx) {
    const leftList = q.match.leftItems.map((it, iIdx) => `
      <div class="match-item-editor">
        <input type="text" value="${escapeAttr(it.text)}" oninput="_patch(${idx}, 'match.leftItems.${iIdx}.text', this.value)" placeholder="Izquierda ${iIdx + 1}">
        <button class="icon-btn" onclick="removeMatchItem(${idx}, 'leftItems', ${iIdx})" style="color:var(--danger)"><span class="material-symbols-outlined">close</span></button>
      </div>
    `).join('');
    const rightList = q.match.rightItems.map((it, iIdx) => `
      <div class="match-item-editor">
        <input type="text" value="${escapeAttr(it.text)}" oninput="_patch(${idx}, 'match.rightItems.${iIdx}.text', this.value)" placeholder="Derecha ${iIdx + 1}">
        <button class="icon-btn" onclick="removeMatchItem(${idx}, 'rightItems', ${iIdx})" style="color:var(--danger)"><span class="material-symbols-outlined">close</span></button>
      </div>
    `).join('');

    // Selector: para cada left, elegís qué right es su par correcto.
    const pairsRows = q.match.leftItems.map(l => {
      const pair = q.match.correctPairs.find(p => String(p.leftId) === String(l._id));
      const selected = pair ? String(pair.rightId) : '';
      const options = q.match.rightItems.map(r => `<option value="${r._id}" ${selected === String(r._id) ? 'selected' : ''}>${escapeAttr(r.text) || '(vacío)'}</option>`).join('');
      return `
        <div class="match-pair-row">
          <span class="match-pair-left">${escapeAttr(l.text) || '(vacío)'}</span>
          <span class="material-symbols-outlined">arrow_forward</span>
          <select onchange="setMatchPair(${idx}, '${l._id}', this.value)">
            <option value="">— sin par —</option>
            ${options}
          </select>
        </div>
      `;
    }).join('');

    return `
      <div class="q-row match-columns">
        <div class="match-column">
          <label class="q-label">Columna izquierda</label>
          ${leftList}
          <button class="btn-add-small" onclick="addMatchItem(${idx}, 'leftItems')">
            <span class="material-symbols-outlined">add</span> Agregar
          </button>
        </div>
        <div class="match-column">
          <label class="q-label">Columna derecha</label>
          ${rightList}
          <button class="btn-add-small" onclick="addMatchItem(${idx}, 'rightItems')">
            <span class="material-symbols-outlined">add</span> Agregar
          </button>
        </div>
      </div>
      <div class="q-row">
        <label class="q-label">Pares correctos</label>
        <div class="match-pairs-list">${pairsRows}</div>
      </div>
    `;
  }

  function renderFill(q, idx) {
    const answersHtml = q.fill.acceptedAnswers.map((a, aIdx) => `
      <div class="fill-answer-editor">
        <input type="text" value="${escapeAttr(a)}" oninput="_patch(${idx}, 'fill.acceptedAnswers.${aIdx}', this.value)" placeholder="Respuesta aceptada ${aIdx + 1}">
        <button class="icon-btn" onclick="removeFillAnswer(${idx}, ${aIdx})" style="color:var(--danger)"><span class="material-symbols-outlined">close</span></button>
      </div>
    `).join('');
    return `
      <div class="q-row">
        <label class="q-label">Frase con hueco (usá <code>{{blank}}</code> donde va la palabra)</label>
        <input type="text" class="fill-template" value="${escapeAttr(q.fill.template)}" oninput="_patch(${idx}, 'fill.template', this.value)" placeholder="La capital de Argentina es {{blank}}.">
      </div>
      <div class="q-row">
        <label class="q-label">Respuestas aceptadas (se compara sin distinción de mayúsculas ni espacios)</label>
        ${answersHtml}
        <button class="btn-add-small" onclick="addFillAnswer(${idx})">
          <span class="material-symbols-outlined">add</span>
          Agregar variante
        </button>
      </div>
    `;
  }

  function render() {
    const container = $('questionsContainer');
    if (!state.questions.length) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px 16px">
          <div class="empty-icon"><span class="material-symbols-outlined">quiz</span></div>
          <p>Todavía no hay preguntas. Elegí un tipo en la barra lateral para empezar.</p>
        </div>
      `;
      return;
    }
    container.innerHTML = state.questions.map(renderQuestion).join('');
  }

  // ── Guardar / publicar ──────────────────────────────────────────────────────

  window.saveTemplate = async function (publish) {
    const title = $('tplTitle').value.trim();
    if (!title) { alert('Ponele un título a la plantilla.'); $('tplTitle').focus(); return; }

    // Validación defensiva por tipo antes de mandar.
    for (let i = 0; i < state.questions.length; i++) {
      const q = state.questions[i];
      if (!q.prompt || !q.prompt.trim()) { alert('Pregunta ' + (i+1) + ': falta el enunciado.'); return; }
      if (q.type === 'mc' && !q.mc.options.some(o => o.isCorrect)) { alert('Pregunta ' + (i+1) + ': marcá al menos una opción correcta.'); return; }
      if (q.type === 'match' && q.match.correctPairs.length === 0) { alert('Pregunta ' + (i+1) + ': definí al menos un par correcto.'); return; }
      if (q.type === 'fill') {
        if (!q.fill.template.includes('{{blank}}')) { alert('Pregunta ' + (i+1) + ': la frase debe incluir {{blank}}.'); return; }
        if (!q.fill.acceptedAnswers.some(a => a.trim())) { alert('Pregunta ' + (i+1) + ': agregá al menos una respuesta aceptada.'); return; }
      }
    }

    const btnSave = $('btnSave'), btnPub = $('btnPublish');
    btnSave.disabled = btnPub.disabled = true;
    const orig = publish ? btnPub.innerHTML : btnSave.innerHTML;
    (publish ? btnPub : btnSave).innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Guardando…';

    // Mandamos los tmp-* tal cual: el server los traduce a ObjectIds reales
    // y actualiza las referencias (ver normalizeIds en routes/tasks.js). Borrar
    // los _id acá dejaría a las correctPairs de match apuntando a nada.
    const body = {
      title,
      description:   $('tplDescription').value,
      defaultPoints: Number($('tplDefaultPoints').value) || 100,
      questions:     JSON.parse(JSON.stringify(state.questions)),
    };

    const url    = state.id ? '/superadmin/tasks/' + state.id : '/superadmin/tasks';
    const method = state.id ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Error al guardar');
      btnSave.disabled = btnPub.disabled = false;
      (publish ? btnPub : btnSave).innerHTML = orig;
      return;
    }
    const savedId = data.template._id;
    if (publish) {
      const pubRes = await fetch('/superadmin/tasks/' + savedId + '/publish', { method: 'POST', headers: { 'Accept': 'application/json' } });
      const pubData = await pubRes.json();
      if (!pubRes.ok) { alert(pubData.error || 'Error al publicar'); return; }
    }
    window.location.href = '/superadmin/tasks';
  };

  render();
})();
