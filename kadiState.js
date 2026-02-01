// kadiState.js
"use strict";

// STATE MACHINE simple (en mémoire)
const sessions = new Map();

function getSession(userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId manquant");

  if (!sessions.has(id)) {
    sessions.set(id, {
      step: "idle",           // idle | profile | collecting_doc | recharge_proof | decharge_collect | decharge_confirm
      profileStep: null,      // business_name | address | phone | email | ifu | rccm | logo

      // documents classiques
      mode: null,             // devis | facture | recu
      factureKind: null,      // proforma | definitive
      lastDocDraft: null,     // draft doc

      // décharge
      decharge: null,         // draft décharge

      // context "image intent" (logo vs ocr/photo->pdf)
      imageIntent: null,      // "logo" | "ocr_doc" | "proof" | null
      imageContext: null,     // { kind, docType, ... } optionnel

      lastUpdated: Date.now(),
    });
  }

  return sessions.get(id);
}

function resetSession(userId) {
  sessions.delete(String(userId || "").trim());
}

module.exports = { getSession, resetSession };