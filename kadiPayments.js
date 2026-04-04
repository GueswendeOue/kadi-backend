"use strict";

const { createTopup, updateTopup, getTopupById } = require("./kadiPaymentsRepo");

function buildTopupReference({ waId, amountFcfa }) {
  const safeWa = String(waId || "").replace(/\D/g, "");
  return `KADI_TOPUP_${amountFcfa}_${safeWa}_${Date.now()}`;
}

async function createManualOrangeMoneyTopup({
  waId,
  amountFcfa,
  credits,
  includesStamp = false,
}) {
  const reference = buildTopupReference({ waId, amountFcfa });

  return createTopup({
    wa_id: waId,
    reference,
    amount_fcfa: amountFcfa,
    credits,
    payment_method: "orange_money",
    includes_stamp: includesStamp,
    status: "pending",
    proof_text: null,
    proof_image_url: null,
  });
}

async function markTopupProofTextReceived(id, proofText) {
  return updateTopup(id, {
    proof_text: String(proofText || "").trim(),
    status: "pending_review",
    updated_at: new Date().toISOString(),
  });
}

async function markTopupProofImageReceived(id, proofImageUrl) {
  return updateTopup(id, {
    proof_image_url: proofImageUrl || null,
    status: "pending_review",
    updated_at: new Date().toISOString(),
  });
}

async function approveTopup(id) {
  return updateTopup(id, {
    status: "approved",
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function rejectTopup(id, reason = null) {
  return updateTopup(id, {
    status: "rejected",
    rejection_reason: reason,
    updated_at: new Date().toISOString(),
  });
}

async function readTopup(id) {
  return getTopupById(id);
}

module.exports = {
  buildTopupReference,
  createManualOrangeMoneyTopup,
  markTopupProofTextReceived,
  markTopupProofImageReceived,
  approveTopup,
  rejectTopup,
  readTopup,
};