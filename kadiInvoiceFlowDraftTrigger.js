"use strict";

const crypto = require("node:crypto");
const { buildDraftInvoiceFlowMessage } = require("./kadiWhatsAppFlowPayload");

function normalizeRecipient(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function parseRecipients(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map(normalizeRecipient)
      .filter(Boolean)
  );
}

function parseEnabled(value) {
  return String(value || "false").trim().toLowerCase() === "true";
}

function createInvoiceFlowDraftTrigger({
  enabled = false,
  recipients,
  triggerText,
  flowId,
  flowMode = "draft",
  ttlMinutes = 30,
  cartService,
  flowSessionService,
  sendFlow,
  sendText,
  now = () => Date.now(),
  randomFlowSeed = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  const allowlist = recipients instanceof Set ? recipients : parseRecipients(recipients);
  const configuredTrigger = typeof triggerText === "string" ? triggerText.trim() : "";
  const seenMessageIds = new Set();
  const inFlight = new Map();

  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > 24 * 60) {
    throw new TypeError("FLOW_SESSION_TTL_INVALID");
  }

  function matches({ from, text }) {
    if (!enabled || flowMode !== "draft" || !allowlist.has(normalizeRecipient(from)) || !configuredTrigger) return false;
    return String(text || "").trim().toLocaleLowerCase() === configuredTrigger.toLocaleLowerCase();
  }

  async function run({ from, text, ownerRef, messageId = null }) {
    if (!matches({ from, text })) return false;
    if (typeof ownerRef !== "string" || !ownerRef.trim()) return false;
    const normalizedFrom = normalizeRecipient(from);
    const key = String(messageId || `${normalizedFrom}:${configuredTrigger.toLocaleLowerCase()}`);
    if (seenMessageIds.has(key)) return true;
    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      let session = null;
      try {
        const draft = await cartService.createDraft({ ownerRef: ownerRef.trim(), flowToken: randomFlowSeed() });
        if (!draft.ok) {
          await sendText(from, "⚠️ Impossible de préparer le formulaire de facture.");
          return true;
        }
        const expiresAt = new Date(now() + ttlMinutes * 60 * 1000).toISOString();
        session = await flowSessionService.createInvoiceFlowSession({
          ownerRef: ownerRef.trim(),
          draftId: draft.value.draft_id,
          expiresAt,
        });
        if (!session.ok) {
          await sendText(from, "⚠️ Impossible de préparer le formulaire de facture.");
          return true;
        }
        const payload = buildDraftInvoiceFlowMessage({
          to: normalizedFrom,
          flowId,
          flowToken: session.value.flow_token,
        });
        await sendFlow(payload);
        seenMessageIds.add(key);
        return true;
      } catch (error) {
        if (session?.ok && typeof flowSessionService.revokeInvoiceFlowSession === "function") {
          await flowSessionService.revokeInvoiceFlowSession(session.value.flow_token).catch(() => {});
        }
        await sendText(from, "⚠️ Le formulaire de facture n’a pas pu être envoyé.").catch(() => {});
        return true;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, operation);
    return operation;
  }

  return Object.freeze({ matches, run });
}

module.exports = { createInvoiceFlowDraftTrigger, normalizeRecipient, parseEnabled, parseRecipients };
