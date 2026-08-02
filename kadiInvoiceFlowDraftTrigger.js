"use strict";

const crypto = require("node:crypto");
const { buildDraftInvoiceFlowMessage } = require("./kadiWhatsAppFlowPayload");
const { validateInvoiceFlowIdMap } = require("./kadiInvoiceFlowIds");

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

function normalizeTriggerText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function messageRef(value) {
  return crypto.createHash("sha256").update(String(value || "missing"), "utf8").digest("hex").slice(0, 12);
}

function createInvoiceFlowDraftTrigger({
  enabled = false,
  recipients,
  triggerText,
  flowIds,
  flowMode = "draft",
  ttlMinutes = 30,
  cartService,
  flowSessionService,
  sendFlow,
  sendText,
  logger = console,
  now = () => Date.now(),
  randomFlowSeed = () => crypto.randomBytes(32).toString("base64url"),
} = {}) {
  const allowlist = recipients instanceof Set ? recipients : parseRecipients(recipients);
  const configuredTrigger = normalizeTriggerText(triggerText);
  const configValid = enabled && validateInvoiceFlowIdMap(flowIds) && flowMode === "draft" && allowlist.size > 0 && Boolean(configuredTrigger) && Number.isFinite(ttlMinutes) && ttlMinutes > 0 && ttlMinutes <= 24 * 60;
  const seenMessageIds = new Set();
  const inFlight = new Map();

  function matches({ from, text }) {
    if (!enabled || flowMode !== "draft" || !allowlist.has(normalizeRecipient(from)) || !configuredTrigger) return false;
    return normalizeTriggerText(text) === configuredTrigger;
  }

  function decision({ messageId, senderAllowed, textMatch, outcome, reason }) {
    logger?.log?.("KADI_FLOW_TRIGGER_DECISION", {
      message_ref: messageRef(messageId),
      enabled: Boolean(enabled),
      sender_allowed: senderAllowed,
      text_match: textMatch,
      config_valid: configValid,
      outcome,
      reason,
    });
  }

  async function run({ from, text, ownerRef, messageId = null }) {
    const senderAllowed = allowlist.has(normalizeRecipient(from));
    const textMatch = normalizeTriggerText(text) === configuredTrigger;
    if (!enabled) {
      decision({ messageId, senderAllowed, textMatch, outcome: "ignored", reason: "FEATURE_DISABLED" });
      return { handled: false, outcome: "ignored", reason: "FEATURE_DISABLED" };
    }
    if (!configValid) {
      if (senderAllowed && textMatch) {
        if (typeof sendText === "function") await Promise.resolve(sendText(from, "⚠️ Le test du formulaire est momentanément indisponible.")).catch(() => {});
        decision({ messageId, senderAllowed, textMatch, outcome: "failed", reason: "CONFIG_INVALID" });
        return { handled: true, outcome: "failed", reason: "CONFIG_INVALID" };
      }
      decision({ messageId, senderAllowed, textMatch, outcome: "ignored", reason: "CONFIG_INVALID" });
      return { handled: false, outcome: "ignored", reason: "CONFIG_INVALID" };
    }
    if (!senderAllowed) {
      decision({ messageId, senderAllowed, textMatch, outcome: "ignored", reason: "SENDER_NOT_ALLOWED" });
      return { handled: false, outcome: "ignored", reason: "SENDER_NOT_ALLOWED" };
    }
    if (!textMatch) {
      decision({ messageId, senderAllowed, textMatch, outcome: "ignored", reason: "TEXT_NOT_MATCHED" });
      return { handled: false, outcome: "ignored", reason: "TEXT_NOT_MATCHED" };
    }
    if (typeof ownerRef !== "string" || !ownerRef.trim()) {
      decision({ messageId, senderAllowed, textMatch, outcome: "failed", reason: "OWNER_CONTEXT_INVALID" });
      return { handled: true, outcome: "failed", reason: "OWNER_CONTEXT_INVALID" };
    }
    const normalizedFrom = normalizeRecipient(from);
    const key = String(messageId || `${normalizedFrom}:${configuredTrigger}`);
    if (seenMessageIds.has(key)) {
      decision({ messageId, senderAllowed, textMatch, outcome: "ignored", reason: "DUPLICATE_MESSAGE" });
      return { handled: true, outcome: "ignored", reason: "DUPLICATE_MESSAGE" };
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      let session = null;
      try {
        const draft = await cartService.createDraft({ ownerRef: ownerRef.trim(), flowToken: randomFlowSeed() });
        if (!draft.ok) {
          await sendText(from, "⚠️ Impossible de préparer le formulaire de facture.");
          decision({ messageId, senderAllowed, textMatch, outcome: "failed", reason: "DRAFT_CREATE_FAILED" });
          return { handled: true, outcome: "failed", reason: "DRAFT_CREATE_FAILED" };
        }
        const expiresAt = new Date(now() + ttlMinutes * 60 * 1000).toISOString();
        session = await flowSessionService.createInvoiceFlowSession({
          ownerRef: ownerRef.trim(),
          draftId: draft.value.draft_id,
          targetScreen: "CLIENT",
          expiresAt,
        });
        if (!session.ok) {
          await sendText(from, "⚠️ Impossible de préparer le formulaire de facture.");
          decision({ messageId, senderAllowed, textMatch, outcome: "failed", reason: "SESSION_CREATE_FAILED" });
          return { handled: true, outcome: "failed", reason: "SESSION_CREATE_FAILED" };
        }
        const payload = buildDraftInvoiceFlowMessage({
          to: normalizedFrom,
          flowIds,
          targetScreen: "CLIENT",
          flowToken: session.value.flow_token,
        });
        const sent = await sendFlow(payload);
        if (!sent?.accepted || typeof sent.messageId !== "string" || !sent.messageId.trim()) {
          throw new Error("META_SEND_FAILED");
        }
        seenMessageIds.add(key);
        decision({ messageId, senderAllowed, textMatch, outcome: "flow_sent", reason: "FLOW_SENT" });
        return { handled: true, outcome: "sent", reason: "FLOW_SENT" };
      } catch (error) {
        if (session?.ok && typeof flowSessionService.revokeInvoiceFlowSession === "function") {
          await flowSessionService.revokeInvoiceFlowSession(session.value.flow_token).catch(() => {});
        }
        await sendText(from, "⚠️ Le formulaire de facture n’a pas pu être envoyé.").catch(() => {});
        decision({ messageId, senderAllowed, textMatch, outcome: "failed", reason: "META_SEND_FAILED" });
        return { handled: true, outcome: "failed", reason: "META_SEND_FAILED" };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, operation);
    return operation;
  }

  return Object.freeze({ matches, run, configValid });
}

module.exports = { createInvoiceFlowDraftTrigger, normalizeRecipient, normalizeTriggerText, parseEnabled, parseRecipients };
