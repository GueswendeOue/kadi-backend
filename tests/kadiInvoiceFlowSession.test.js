"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvoiceFlowEndpoint } = require("../kadiInvoiceFlowEndpoint");
const { createInvoiceCartService } = require("../kadiInvoiceCartService");
const { createInMemoryInvoiceDraftRepository } = require("../kadiInvoiceDraftRepository");
const { createInMemoryInvoiceFlowSessionRepository, createInvoiceFlowSessionService } = require("../kadiInvoiceFlowSession");

async function fixture() {
  const draftRepository = createInMemoryInvoiceDraftRepository();
  const cartService = createInvoiceCartService({ repository: draftRepository });
  const flowSessionService = createInvoiceFlowSessionService({ repository: createInMemoryInvoiceFlowSessionRepository(), draftRepository });
  const draft = await cartService.createDraft({ ownerRef: "owner-a", flowToken: "initial-synthetic-token" });
  const session = await flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: draft.value.draft_id, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const endpoint = createInvoiceFlowEndpoint({ cartService, flowSessionService });
  return { cartService, flowSessionService, draft: draft.value, session: session.value, endpoint };
}

test("creates an opaque session without PII and binds owner and draft", async () => {
  const f = await fixture();
  assert.match(f.session.flow_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.session.flow_token.includes("owner-a"), false);
  const resolved = await f.flowSessionService.resolveInvoiceFlowSession(f.session.flow_token);
  assert.deepEqual(resolved.value, { ownerRef: "owner-a", draftId: f.draft.draft_id, flowTokenHash: f.session.flow_token_hash });
});

test("valid data_exchange resolves identity from token and ignores client draft and owner", async () => {
  const f = await fixture();
  const init = await f.endpoint.handle({ action: "INIT", flow_token: f.session.flow_token }, { request: { get: () => "attacker" } });
  assert.equal(init.ok, true);
  const result = await f.endpoint.handle({ action: "data_exchange", flow_token: f.session.flow_token, data: {
    intent: "save_client", draft_id: "foreign-draft", owner_ref: "attacker", client_type: "individual", client_name: "Awa",
  } }, { request: { get: () => "attacker" } });
  assert.equal(result.ok, true);
  assert.equal(result.value.data.draft_id, f.draft.draft_id);
});

test("unknown, malformed, expired and revoked tokens fail closed", async () => {
  const f = await fixture();
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: "unknown-token-value-12345678901234567890" })).error, "FLOW_TOKEN_UNKNOWN");
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: "!" })).error, "FLOW_TOKEN_INVALID");

  const expired = await f.flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: f.draft.draft_id, expiresAt: new Date(Date.now() + 1).toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await f.flowSessionService.resolveInvoiceFlowSession(expired.value.flow_token)).error, "FLOW_TOKEN_EXPIRED");

  assert.equal((await f.flowSessionService.revokeInvoiceFlowSession(f.session.flow_token)).ok, true);
  assert.equal((await f.flowSessionService.resolveInvoiceFlowSession(f.session.flow_token)).error, "FLOW_TOKEN_REVOKED");
});

test("retry remains idempotent and another owner's draft is inaccessible", async () => {
  const f = await fixture();
  const request = { action: "data_exchange", flow_token: f.session.flow_token, data: { intent: "save_client", draft_id: "foreign", client_type: "individual", client_name: "Awa" } };
  const first = await f.endpoint.handle(request);
  const retry = await f.endpoint.handle(request);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.value.data.draft_id, f.draft.draft_id);
  const otherDraft = await f.cartService.createDraft({ ownerRef: "owner-b", flowToken: "other-synthetic-token" });
  assert.equal((await f.cartService.loadOwned(otherDraft.value.draft_id, "owner-a", f.session.flow_token)).error, "DRAFT_ACCESS_DENIED");
});
