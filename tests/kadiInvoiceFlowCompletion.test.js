"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInvoiceFlowCompletionHandler } = require("../kadiInvoiceFlowCompletion");

test("engine runs nfm_reply completion before every legacy interactive or conversational route", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiEngine.js"), "utf8");
  const completionCall = source.indexOf("options.invoiceFlowCompletion({ from, message: msg, value, identity })");
  const stopPipeline = source.indexOf("if (completionResult?.handled === true) return;", completionCall);
  const legacyInteractive = source.indexOf("await handleInteractiveMessage(from, msg);", completionCall);
  const conversational = source.indexOf("await handleTextMessage(from, text, msg);", completionCall);
  assert.ok(completionCall >= 0);
  assert.ok(stopPipeline > completionCall);
  assert.ok(legacyInteractive > stopPipeline);
  assert.ok(conversational > stopPipeline);
});

test("realistic Flow completion is handled before fallback without sending a second user message", async () => {
  const sent = [];
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) },
    sendText: async (to, text) => sent.push({ to, text }),
    logger: { log: () => {} },
  });
  const message = {
    context: { from: "22670000000", id: "wamid-launch" },
    from: "22670000000",
    id: "wamid-flow-complete",
    timestamp: "1785628800",
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: JSON.stringify({ flow_token: "opaque-flow-token", draft_id: "draft-1", status: "draft_saved" }),
      },
    },
  };
  const first = await handler({ from: "22670000000", message });
  const second = await handler({ from: "22670000000", message });
  assert.equal(first.handled, true);
  assert.equal(second.handled, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 0);
});

test("already-parsed response_json and common property aliases are accepted", async () => {
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService: { resolveInvoiceFlowSession: async (token) => ({ ok: token === "opaque-flow-token", value: { draftId: "draft-1" } }) },
    logger: { log: () => {} },
  });
  const result = await handler({
    from: "22670000000",
    message: { id: "parsed", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: { flowToken: "opaque-flow-token", draftId: "draft-1", status: "draft_saved" } } } },
  });
  assert.equal(result.handled, true);
  assert.equal(result.outcome, "handled");
});

test("recognized but invalid Flow completion is swallowed before legacy MENU and OpenAI routing", async () => {
  const handler = createInvoiceFlowCompletionHandler({ flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) }, logger: { log: () => {} } });
  const result = await handler({ from: "22670000000", message: { id: "bad", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } } });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "FLOW_TOKEN_MISSING");
});
