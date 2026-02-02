"use strict";

// STATE MACHINE (en mémoire)
const sessions = new Map();

/**
 * step possibles:
 * - idle
 * - onboarding
 * - profile
 * - collecting_doc
 * - recharge_proof
 * - awaiting_image_action   (image reçue -> demander: OCR / Logo / Preuve)
 * - collecting_decharge     (décharge: questions guidées)
 */
function getSession(userId) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId manquant");

  if (!sessions.has(id)) {
    sessions.set(id, {
      step: "idle",

      // profil
      profileStep: null, // business_name | address | phone | email | ifu | rccm | logo

      // documents
      mode: null, // devis | facture | recu | decharge
      factureKind: null, // proforma | definitive
      lastDocDraft: null,

      // image routing
      pendingImage: null, // { mediaId, mime, url, buffer? } (optionnel)
      lastImagePurpose: null, // "logo" | "recharge" | "ocr"

      // décharge flow
      dechargeStep: null,
      dechargeDraft: null,

      // meta
      lastUpdated: Date.now(),
    });
  }

  return sessions.get(id);
}

function touchSession(userId) {
  const s = getSession(userId);
  s.lastUpdated = Date.now();
  return s;
}

function resetSession(userId) {
  sessions.delete(String(userId || "").trim());
}

module.exports = { getSession, touchSession, resetSession };