// Autocalificador de actividades interactivas.
//
// Función pura: recibe las preguntas del snapshot de la actividad y las respuestas
// del alumno, y devuelve el puntaje total + un desglose por pregunta.
//
// Se llama desde POST /activities/:id/submit (routes/activities.js) SOLO cuando
// la actividad tiene templateSnapshot. Nunca corre en cliente: las respuestas
// correctas viven en el server y el cliente solo recibe el resultado agregado.
//
// Contrato:
//   computeAutoGrade(questions, answers) → { points, breakdown, maxPoints }
//   - questions: Array de preguntas tal como se guardaron en templateSnapshot
//   - answers:   Array del alumno; cada item { questionId, mc|tf|match|fill }
//   - devuelve puntos ABSOLUTOS (suma de question.points por acierto) y el desglose.
//
// Casos por tipo:
//   - common: NO autocalifica (points = 0, correct = null). El docente pone la nota.
//   - mc:     acierto EXACTO del set de opciones marcadas contra las correctas.
//   - tf:     match booleano contra correctAnswer.
//   - match:  puntaje proporcional (aciertos / total pares correctos) * points.
//   - fill:   normaliza (trim + lowercase) y busca match exacto en acceptedAnswers.

function normalize(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const A = new Set(a.map(String));
  for (const x of b) if (!A.has(String(x))) return false;
  return true;
}

function gradeMc(question, answer) {
  const opts = (question.mc && question.mc.options) || [];
  const correctIds = opts.filter(o => o.isCorrect).map(o => String(o._id));
  const selected   = (answer && answer.mc && Array.isArray(answer.mc.selected)) ? answer.mc.selected.map(String) : [];
  const isMulti    = !!(question.mc && question.mc.multipleAllowed);

  // Single-select: exactamente 1 marcada y coincide con la única correcta.
  if (!isMulti) {
    if (selected.length !== 1 || correctIds.length !== 1) return false;
    return selected[0] === correctIds[0];
  }
  // Multi-select: el set marcado debe ser IGUAL al de correctas (all-or-nothing).
  return sameSet(correctIds, selected);
}

function gradeTf(question, answer) {
  const correct = !!(question.tf && question.tf.correctAnswer === true);
  const given   = answer && answer.tf && typeof answer.tf.answer === 'boolean' ? answer.tf.answer : null;
  if (given === null) return false;
  return given === correct;
}

// Devuelve puntos absolutos (fracción del `points` de la pregunta según pares acertados).
function gradeMatch(question, answer) {
  const correctPairs = (question.match && question.match.correctPairs) || [];
  const total = correctPairs.length;
  if (total === 0) return 0;
  const givenPairs = (answer && answer.match && Array.isArray(answer.match.pairs)) ? answer.match.pairs : [];
  // Comparación por (leftId, rightId) exacto.
  const correctSet = new Set(correctPairs.map(p => String(p.leftId) + '→' + String(p.rightId)));
  let hits = 0;
  for (const p of givenPairs) {
    const key = String(p.leftId) + '→' + String(p.rightId);
    if (correctSet.has(key)) hits++;
  }
  return (question.points || 0) * (hits / total);
}

function gradeFill(question, answer) {
  const accepted = ((question.fill && question.fill.acceptedAnswers) || []).map(normalize);
  const given    = normalize(answer && answer.fill && answer.fill.text);
  if (!given) return false;
  return accepted.includes(given);
}

function computeAutoGrade(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  const ansByQ = new Map();
  for (const a of (Array.isArray(answers) ? answers : [])) {
    if (a && a.questionId) ansByQ.set(String(a.questionId), a);
  }

  let totalPoints = 0;
  let maxPoints = 0;
  const breakdown = [];

  for (const q of list) {
    const max = Number(q.points) || 0;
    maxPoints += max;
    const a = ansByQ.get(String(q._id));

    let awarded = 0;
    let correct = null; // true/false/null (null = no evaluable, ej. "common")

    switch (q.type) {
      case 'common':
        awarded = 0;
        correct = null;
        break;
      case 'mc': {
        const ok = gradeMc(q, a);
        awarded = ok ? max : 0;
        correct = ok;
        break;
      }
      case 'tf': {
        const ok = gradeTf(q, a);
        awarded = ok ? max : 0;
        correct = ok;
        break;
      }
      case 'match': {
        awarded = gradeMatch(q, a);
        correct = awarded >= max ? true : (awarded > 0 ? null : false);
        break;
      }
      case 'fill': {
        const ok = gradeFill(q, a);
        awarded = ok ? max : 0;
        correct = ok;
        break;
      }
      default:
        awarded = 0;
        correct = null;
    }

    totalPoints += awarded;
    breakdown.push({
      questionId: q._id,
      type:       q.type,
      awarded:    Math.round(awarded * 100) / 100, // redondeo a 2 decimales para storage
      max,
      correct,
    });
  }

  return {
    points:    Math.round(totalPoints * 100) / 100,
    maxPoints: Math.round(maxPoints   * 100) / 100,
    breakdown,
  };
}

module.exports = { computeAutoGrade };
