"use strict";

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      step: "idle",          // idle | profile | collecting_doc | confirming_doc
      profileStep: null,     // business_name | address | phone | email | ifu | rccm | logo
      mode: null,            // devis | facture | recu

      // document draft
      lastDocDraft: null,
      pendingQuestion: null,

      lastUpdated: Date.now(),
    });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.delete(userId);
}

module.exports = { getSession, resetSession };