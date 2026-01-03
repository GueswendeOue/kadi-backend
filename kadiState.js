// kadiState.js
// ==========================================
// STATE MACHINE simple (en mémoire)
// ==========================================

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      mode: null, // "devis" | "facture" | "recu"
      step: "idle",
      last_updated: Date.now(),
      draft: null,
    });
  }
  return sessions.get(userId);
}

function setMode(userId, mode) {
  const s = getSession(userId);
  s.mode = mode;
  s.step = "collecting";
  s.last_updated = Date.now();
  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

module.exports = {
  getSession,
  setMode,
  resetSession,
};