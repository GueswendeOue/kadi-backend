"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvoiceFlowDraftTrigger } = require("../kadiInvoiceFlowDraftTrigger");

function fixture(overrides = {}) {
  const sent = [];
  const texts = [];
  const revoked = [];
  let draftCount = 0;
  const cartService = {
    async createDraft(args) {
      draftCount += 1;
      return { ok: true, value: { draft_id: `draft-${draftCount}` }, args };
    },
  };
  const flowSessionService = {
    async createInvoiceFlowSession({ ownerRef, draftId }) {
      return { ok: true, value: { flow_token: "kadi_invoice_v1:abcdef0123456789abcdef0123456789:1735689600000", ownerRef, draftId } };
    },
    async revokeInvoiceFlowSession(flowToken) {
      revoked.push(flowToken);
      return { ok: true };
    },
  };
  const trigger = createInvoiceFlowDraftTrigger({
    enabled: true,
    recipients: "22670626055",
    triggerText: "Test facture Flow",
    flowId: "1972040430119125",
    cartService,
    flowSessionService,
    sendFlow: async (payload) => { sent.push(payload); return { accepted: true, messageId: "wamid-flow-1" }; },
    sendText: async (to, text) => { texts.push({ to, text }); },
    now: () => 1735689600000,
    ...overrides,
  });
  return { trigger, sent, texts, revoked, cartService };
}

test("allowlisted exact trigger accepts case and surrounding spaces", async () => {
  const f = fixture();
  const result = await f.trigger.run({ from: "+226 706 260 55", text: "  TEST   FACTURE FLOW  ", ownerRef: "owner-a", messageId: "wamid-1" });
  assert.equal(result.handled, true);
  assert.equal(f.sent.length, 1);
  const payload = f.sent[0];
  assert.equal(payload.to, "22670626055");
  assert.equal(payload.interactive.action.parameters.mode, "draft");
  assert.equal(payload.interactive.action.parameters.flow_id, "1972040430119125");
  assert.equal(payload.interactive.action.parameters.flow_action_payload.screen, "CLIENT");
  assert.equal(payload.interactive.action.parameters.flow_cta, "Ouvrir le formulaire");
  assert.match(payload.interactive.action.parameters.flow_token, /^kadi_invoice_v1:[a-f0-9]{32}:/);
  assert.equal(f.texts.length, 0);
});

test("disabled, other recipient and other message preserve the old path", async () => {
  for (const args of [
    { from: "22670626055", text: "Test facture Flow", ownerRef: "owner-a" },
    { from: "22670000000", text: "Test facture Flow", ownerRef: "owner-a" },
    { from: "22670626055", text: "Autre message", ownerRef: "owner-a" },
  ]) {
    const f = fixture({ enabled: args.from === "22670626055" && args.text !== "Test facture Flow" });
    assert.equal((await f.trigger.run(args)).handled, false);
    assert.equal(f.sent.length, 0);
  }
});

test("same webhook message is idempotent and no owner or draft identity is sent", async () => {
  const f = fixture();
  const args = { from: "22670626055", text: "Test facture Flow", ownerRef: "owner-a", messageId: "wamid-retry" };
  await Promise.all([f.trigger.run(args), f.trigger.run(args)]);
  assert.equal(f.sent.length, 1);
  assert.equal(Object.hasOwn(f.sent[0].interactive.action.parameters, "ownerRef"), false);
  assert.equal(Object.hasOwn(f.sent[0].interactive.action.parameters, "draftId"), false);
});

test("send failure revokes the session and never claims success", async () => {
  const f = fixture({ sendFlow: async () => { throw new Error("META_REJECTED"); } });
  assert.equal((await f.trigger.run({ from: "22670626055", text: "Test facture Flow", ownerRef: "owner-a", messageId: "wamid-fail" })).handled, true);
  assert.equal(f.revoked.length, 1);
  assert.equal(f.texts.length, 1);
});

test("invalid configuration handles the exact allowlisted trigger without entering the old path", async () => {
  const f = fixture({ flowId: "", triggerText: "Test facture Flow" });
  const result = await f.trigger.run({ from: "22670626055", text: "Test facture Flow", ownerRef: "owner-a", messageId: "wamid-config" });
  assert.deepEqual(result, { handled: true, outcome: "failed", reason: "CONFIG_INVALID" });
  assert.equal(f.sent.length, 0);
  assert.equal(f.texts.length, 1);
});
