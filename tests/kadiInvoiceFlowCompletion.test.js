"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvoiceFlowCompletionHandler } = require("../kadiInvoiceFlowCompletion");

test("Flow completion is handled before the legacy interactive fallback and is idempotent", async () => {
  const sent = [];
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) },
    sendText: async (to, text) => sent.push({ to, text }),
    logger: { log: () => {} },
  });
  const message = { id: "wamid-flow-complete", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify({ flow_token: "opaque-flow-token", draft_id: "draft-1", review_action: "confirm_generate" }) } } };
  const first = await handler({ from: "22670000000", message });
  const second = await handler({ from: "22670000000", message });
  assert.equal(first.handled, true);
  assert.equal(second.handled, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "✅ J’ai bien reçu les informations de votre facture. Voulez-vous relire, modifier ou générer le document ?");
});

test("invalid Flow completion is not treated as a legacy command", async () => {
  const handler = createInvoiceFlowCompletionHandler({ flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) }, logger: { log: () => {} } });
  const result = await handler({ from: "22670000000", message: { id: "bad", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } } });
  assert.equal(result.handled, false);
});
