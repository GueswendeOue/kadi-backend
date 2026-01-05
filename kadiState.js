"use strict";

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      step: "idle",          // idle | menu | profile | collecting_doc
      profileStep: null,     // business_name | address | phone | email | ifu | rccm | logo
      mode: null,            // devis | facture | recu
      lastDocDraft: null,    // futur: brouillon facture/devis
      lastUpdated: Date.now()
    });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  sessions.delete(userId);
}

module.exports = { getSession, resetSession };