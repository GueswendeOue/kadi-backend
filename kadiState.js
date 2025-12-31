// kadiState.js
// ==========================================
// STATE MACHINE (en mémoire) + multi-tours + draft
// ==========================================

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      mode: null,               // "devis" | "facture" | "recu"
      step: "idle",             // "idle" | "collecting" | "asking"
      last_updated: Date.now(),

      draft: null,              // doc en cours
      pendingQuestions: [],
      currentQuestionIndex: 0,
    });
  }
  return sessions.get(userId);
}

function setMode(userId, mode) {
  const s = getSession(userId);
  s.mode = mode;
  s.step = "collecting";
  s.last_updated = Date.now();

  s.draft = null;
  s.pendingQuestions = [];
  s.currentQuestionIndex = 0;

  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

function setQuestions(userId, questions = []) {
  const s = getSession(userId);
  s.pendingQuestions = Array.isArray(questions) ? questions : [];
  s.currentQuestionIndex = 0;
  s.step = s.pendingQuestions.length > 0 ? "asking" : "collecting";
  s.last_updated = Date.now();
  return s;
}

function getCurrentQuestion(userId) {
  const s = getSession(userId);
  if (!s.pendingQuestions.length) return null;
  return s.pendingQuestions[s.currentQuestionIndex] || null;
}

module.exports = {
  getSession,
  setMode,
  resetSession,
  setQuestions,
  getCurrentQuestion,
};