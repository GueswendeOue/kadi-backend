"use strict";

const { createTopup, updateTopup } = require("./kadiPaymentsRepo");

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

async function markTopupProofReceived(id, patch = {}) {
  return updateTopup(id, {
    ...patch,
    status: "pending_review",
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  buildTopupReference,
  createManualOrangeMoneyTopup,
  markTopupProofReceived,
};