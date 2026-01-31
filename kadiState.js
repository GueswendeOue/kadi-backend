// kadiState.js
"use strict";

// STATE MACHINE simple (en mémoire)
const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      // ----- Global -----
      step: "idle",
      lastUpdated: Date.now(),

      // ----- Profil -----
      profileStep: null, // business_name | address | phone | email | ifu | rccm | logo

      // ----- Documents (devis/facture/reçu) -----
      mode: null,        // devis | facture | recu | decharge (NEW)
      factureKind: null, // proforma | definitive
      lastDocDraft: null,

      // ----- NEW: Décharge -----
      dechargeStep: null,
      lastDechargeDraft: null,

      // ----- NEW: confirmations WhatsApp (décharge) -----
      // Map<token, { draftId, party: "A"|"B", waId: string, status: "pending"|"yes"|"no", at?: ISO }>
      confirmations: new Map(),

      // ----- NEW: image intent (éviter confusion logo vs OCR) -----
      // imageIntent: null | "logo" | "ocr_doc"
      imageIntent: null,

      // si on reçoit une image et qu'on doit demander "Logo ou Document ?"
      pendingImage: null, // { mediaId, mimeType } optionnel
    });
  }

  const s = sessions.get(userId);
  s.lastUpdated = Date.now();
  return s;
}

function resetSession(userId) {
  sessions.delete(userId);
}

module.exports = { getSession, resetSession };