"use strict";

// T6/BALANCE-001: the single shared source of the user-facing balance
// sentence, required by both kadiV1ProductionPresenter.js's Flow/menu
// BALANCE path and kadiV1ConversationOrchestrator.js's natural-language
// BALANCE path, so the two can never independently drift apart — the same
// available_credits/reserved_credits always produce the exact same text.
// Never exposes reservation ids, quote ids, wallet/profile ids, internal
// statuses, WhatsApp ids or ledger details — only the two integers already
// validated by the caller.

function formatAvailableBalanceText({ availableCredits, reservedCredits = 0 } = {}) {
  if (!Number.isSafeInteger(availableCredits) || availableCredits < 0) {
    throw new TypeError("KADI_V1_BALANCE_PRESENTATION_AVAILABLE_INVALID");
  }
  if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 0) {
    throw new TypeError("KADI_V1_BALANCE_PRESENTATION_RESERVED_INVALID");
  }
  // Mission copy spec: 0 and 1 are both singular ("0 crédit disponible.",
  // "1 crédit disponible."); only 2+ is plural.
  const availableIsSingular = availableCredits <= 1;
  const availableLine = `Vous avez ${availableCredits} crédit${availableIsSingular ? "" : "s"} disponible${availableIsSingular ? "" : "s"}.`;
  if (reservedCredits <= 0) return availableLine;
  const reservedLine = reservedCredits === 1
    ? "1 crédit est temporairement réservé pour une génération en cours."
    : `${reservedCredits} crédits sont temporairement réservés pour une génération en cours.`;
  return `${availableLine}\n${reservedLine}`;
}

// T5/RECHARGE_PRESENTER_001: a distinct, shorter label for the RECHARGE
// Flow's own balance_summary field (a single-line Flow TextBody, not a
// standalone conversational sentence) — deliberately different wording
// from formatAvailableBalanceText's "Vous avez N crédits disponibles.",
// but always derived from the exact same available_credits/
// reserved_credits the caller already validated against the same T6
// canonical authority, so the RECHARGE Flow and the normal BALANCE
// response can never disagree about the underlying number, even though
// their phrasing differs by design.
function formatRechargeBalanceSummary({ availableCredits, reservedCredits = 0 } = {}) {
  if (!Number.isSafeInteger(availableCredits) || availableCredits < 0) {
    throw new TypeError("KADI_V1_BALANCE_PRESENTATION_AVAILABLE_INVALID");
  }
  if (!Number.isSafeInteger(reservedCredits) || reservedCredits < 0) {
    throw new TypeError("KADI_V1_BALANCE_PRESENTATION_RESERVED_INVALID");
  }
  const availableIsSingular = availableCredits <= 1;
  const line = `Solde disponible : ${availableCredits} crédit${availableIsSingular ? "" : "s"}.`;
  if (reservedCredits <= 0) return line;
  const reservedNote = reservedCredits === 1
    ? "1 crédit est temporairement réservé."
    : `${reservedCredits} crédits sont temporairement réservés.`;
  return `${line}\n${reservedNote}`;
}

module.exports = { formatAvailableBalanceText, formatRechargeBalanceSummary };
