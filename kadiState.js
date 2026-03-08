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
 * - awaiting_image_action
 * - collecting_decharge
 *
 * Champs additionnels:
 * - adminPendingAction: ex "broadcast_image"
 * - broadcastCaption: légende temporaire pour /broadcastimage
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
      itemDraft: null,
      pendingOcrMediaId: null,

      // image routing
      pendingImage: null, // { mediaId, mime, url, buffer? } (optionnel)
      lastImagePurpose: null, // "logo" | "recharge" | "ocr"

      // décharge flow
      dechargeStep: null,
      dechargeDraft: null,

      // admin broadcast
      adminPendingAction: null, // "broadcast_image" | null
      broadcastCaption: null,   // caption temporaire pour image broadcast

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