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

function clearCurrentFlowSession(session) {
  if (!session || typeof session !== "object") return session;

  session.step = "idle";
  session.mode = null;
  session.factureKind = null;
  session.lastDocDraft = null;
  session.itemDraft = null;
  session.pendingSmartBlockText = null;
  session.pendingPdfAfterRecharge = null;
  session.pendingOcrMediaId = null;
  session.intentPendingItemLabel = null;
  session.pendingImage = null;
  session.lastImagePurpose = null;
  session.dechargeStep = null;
  session.dechargeDraft = null;
  session.subjectReturnTarget = null;
  session.clientPhoneReturnTarget = null;
  session.lastUpdated = Date.now();

  return session;
}

module.exports = {
  getSession,
  touchSession,
  resetSession,
  clearCurrentFlowSession,
};
