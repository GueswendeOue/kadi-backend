"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createKadiV1ProductionPresenter,
} = require("../kadiV1ProductionPresenter");

// P8.A1-B objective 5 — before CONFIRM_GENERATION, nothing draft-exposing
// may reach the user: no PDF/media send, no URL, no storage_ref, no media
// id, no temporary-file reference, no credit debit, temporary render stays
// private. This does NOT close the BROUILLON/date/number/final-design gap
// (P8.B) — only that nothing about the not-yet-generated file leaks out.

const OWNER = "22670000000";
const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001", MENU: "100002", DOCUMENT_TYPE: "100003", DOCUMENT_CLIENT: "100004",
  DOCUMENT_CONTENT: "100005", DOCUMENT_OPTIONS: "100006", DOCUMENT_REVIEW: "100007",
  EDIT_CLIENT: "100008", EDIT_CONTENT: "100009", EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011", GENERATION_CONFIRMATION: "100012", RECHARGE: "100013",
  HISTORY_SEARCH: "100014", DISCHARGE_DETAILS: "100015",
});

function harness() {
  const calls = [];
  const presenter = createKadiV1ProductionPresenter({
    config: { enabled: true, features: {}, flowIds: FLOW_IDS },
    whatsappApi: {
      async sendTypingIndicator(messageId) { calls.push(["typing", messageId]); },
      async sendText(to, text) { calls.push(["text", { to, text }]); },
      async sendFlow(payload) { calls.push(["flow", payload]); },
    },
    sessionService: {
      async open(command) {
        calls.push(["session", command]);
        return { ok: true, value: { session_id: "kadi_session:guards1" }, duplicate: false };
      },
    },
  });
  return { presenter, calls };
}

test("the presenter's WhatsApp port contract has no document/media send capability", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1ProductionPresenter.js"), "utf8");
  // Only sendText/sendFlow are required; nothing named sendDocument/sendMedia/sendPdf exists.
  assert.doesNotMatch(source, /sendDocument|sendMedia|sendPdf|messaging\.send(?!Text|Flow|TypingIndicator)/);
});

test("PREPARE_PDF: even a maliciously enriched result never leaks storage_ref, a media id, a PDF url or a debit flag to the outward Flow", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:prepare-pdf",
    result: {
      handled: true,
      action: "PREPARE_PDF",
      duplicate: false,
      result: {
        quote: { quote_id: "quote:1", total_credits: 3, page_count: 2 },
        document: { document_id: "document:1", version: 5, document_type: "FACTURE", status: "AWAITING_GENERATION_CONFIRMATION" },
        // Fields a buggy adapter must never actually return, injected here
        // to prove the presenter would not forward them even if it did.
        storage_ref: "private-temp:should-never-leak",
        media_id: "media:should-never-leak",
        pdf_url: "https://example.test/should-never-leak.pdf",
        temporary_render_id: "render:should-never-leak",
        debit: { amount: 3 },
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["should-never-leak", "storage_ref", "media_id", "pdf_url", "temporary_render_id", "\"debit\""]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden), forbidden);
  }
  const parameters = payload.interactive.action.parameters;
  // GENERATION_CONFIRMATION's declared screen data is a closed whitelist
  // (flows/v1_draft/kadi_generation_confirmation_v1.json); nothing outside
  // it can ever reach flow_action_payload.data regardless of what an
  // upstream adapter result contains.
  assert.deepEqual(
    Object.keys(parameters.flow_action_payload.data).sort(),
    ["balance_summary", "confirmation_actions", "cost_summary", "quote_id", "session_id"]
  );
});

test("PREPARE_PDF: the canonical text sent to the user never mentions internal identifiers", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:prepare-pdf-text",
    result: {
      handled: true,
      action: "PREPARE_PDF",
      duplicate: false,
      result: {
        quote: { quote_id: "quote:1" },
        document: { document_id: "document:1", version: 5, document_type: "FACTURE", status: "AWAITING_GENERATION_CONFIRMATION" },
      },
    },
  });
  const text = calls.find(([name]) => name === "text")[1].text;
  assert.doesNotMatch(text, /storage_ref|media_id|pdf|url|flow_token|draft_id/i);
});

test("no wallet, credit or debit dependency exists anywhere in the presenter module", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1ProductionPresenter.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'][^"']*(?:wallet|credit|payment)/i);
  assert.doesNotMatch(source, /debitCredits|reserveCredit|consumeCredit/i);
});
