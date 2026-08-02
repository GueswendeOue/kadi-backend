"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createInvoiceFlowEndpoint } = require("../kadiInvoiceFlowEndpoint");
const { createInvoiceCartService } = require("../kadiInvoiceCartService");
const { flipIv } = require("../kadiFlowCrypto");
const { createInMemoryInvoiceDraftRepository } = require("../kadiInvoiceDraftRepository");
const {
  INVOICE_FLOW_TARGET_SCREENS,
  createInMemoryInvoiceFlowSessionRepository,
  createInvoiceFlowSessionService,
  hashFlowToken,
} = require("../kadiInvoiceFlowSession");

async function fixture() {
  let clock = Date.now();
  const draftRepository = createInMemoryInvoiceDraftRepository();
  const cartService = createInvoiceCartService({ repository: draftRepository });
  const repository = createInMemoryInvoiceFlowSessionRepository();
  const flowSessionService = createInvoiceFlowSessionService({ repository, draftRepository, now: () => clock });
  const draft = await cartService.createDraft({ ownerRef: "owner-a", flowToken: "initial-synthetic-token" });
  const session = await flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: draft.value.draft_id, targetScreen: "CLIENT", expiresAt: new Date(clock + 60_000).toISOString() });
  const endpoint = createInvoiceFlowEndpoint({ cartService, flowSessionService });
  return { cartService, flowSessionService, repository, draft: draft.value, session: session.value, endpoint, now: () => clock, advance(ms) { clock += ms; } };
}

function encryptRequest(payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const aesKey = crypto.randomBytes(16);
  const initialVector = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, initialVector);
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return {
    privateKey,
    aesKey,
    initialVector,
    envelope: {
      encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey).toString("base64"),
      encrypted_flow_data: encryptedData.toString("base64"),
      initial_vector: initialVector.toString("base64"),
    },
  };
}

function decryptResponse(value, aesKey, initialVector) {
  const bytes = Buffer.from(value, "base64");
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, flipIv(initialVector));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

test("creates an opaque session without PII and binds owner and draft", async () => {
  const f = await fixture();
  assert.match(f.session.flow_token, /^kadi_invoice_v1:[a-f0-9]{32}:[0-9]{10,13}$/);
  assert.equal(f.session.flow_token.includes("owner-a"), false);
  const resolved = await f.flowSessionService.resolveInvoiceFlowSession(f.session.flow_token);
  assert.deepEqual(resolved.value, {
    ownerRef: "owner-a",
    draftId: f.draft.draft_id,
    targetScreen: "CLIENT",
    returnToReview: false,
    flowTokenHash: f.session.flow_token_hash,
  });
});

test("INIT routes every persisted target to data matching the Flow screen declaration", async () => {
  const f = await fixture();
  const flow = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "flows", "kadi_facture_v1.json"), "utf8"));
  for (const targetScreen of INVOICE_FLOW_TARGET_SCREENS) {
    const session = targetScreen === "CLIENT" ? { ok: true, value: f.session } : await f.flowSessionService.createInvoiceFlowSession({
      ownerRef: "owner-a",
      draftId: f.draft.draft_id,
      targetScreen,
      returnToReview: targetScreen === "ARTICLE_ENTRY",
      expiresAt: new Date(f.now() + 60_000).toISOString(),
    });
    assert.equal(session.ok, true, targetScreen);
    const init = await f.endpoint.handle({ action: "INIT", flow_token: session.value.flow_token, version: "3.0" });
    assert.equal(init.ok, true, targetScreen);
    assert.equal(init.value.screen, targetScreen);
    const declaration = flow.screens.find(({ id }) => id === targetScreen).data;
    assert.deepEqual(Object.keys(init.value.data).sort(), Object.keys(declaration).sort(), targetScreen);
    for (const [key, value] of Object.entries(init.value.data)) {
      assert.notEqual(value, null, `${targetScreen}.${key}`);
      assert.equal(Array.isArray(value) ? "array" : typeof value, declaration[key].type, `${targetScreen}.${key}`);
    }
    assert.equal(init.value.data.flow_token, session.value.flow_token, targetScreen);
    assert.equal(init.value.data.draft_id, f.draft.draft_id, targetScreen);
    if (targetScreen === "ARTICLE_ENTRY") assert.equal(init.value.data.return_to_review, "true");
  }
});

test("encrypted INIT resolves the persisted target and returns a decryptable response", async () => {
  const f = await fixture();
  const encrypted = encryptRequest({ action: "INIT", flow_token: f.session.flow_token, version: "3.0" });
  const endpoint = createInvoiceFlowEndpoint({
    cartService: f.cartService,
    flowSessionService: f.flowSessionService,
    webhookOrchestration: true,
    cryptoConfig: { privateKey: encrypted.privateKey },
  });
  const response = await endpoint.handleEncrypted(encrypted.envelope, { production: false });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  const clear = decryptResponse(response.value, encrypted.aesKey, encrypted.initialVector);
  assert.deepEqual(clear, {
    screen: "CLIENT",
    data: { flow_token: f.session.flow_token, draft_id: f.draft.draft_id },
  });
});

test("webhook orchestration accepts INIT and keeps legacy business data_exchange disabled", async () => {
  const f = await fixture();
  const endpoint = createInvoiceFlowEndpoint({ cartService: f.cartService, flowSessionService: f.flowSessionService, webhookOrchestration: true });
  assert.equal((await endpoint.handle({ action: "INIT", flow_token: f.session.flow_token })).ok, true);
  const rejected = await endpoint.handle({ action: "data_exchange", flow_token: f.session.flow_token, data: { intent: "save_client" } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.error, "FLOW_WEBHOOK_ORCHESTRATION_REQUIRED");
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
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: "kadi_invoice_v1:00000000000000000000000000000000:1735689600000" })).error, "FLOW_TOKEN_UNKNOWN");
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: "!" })).error, "FLOW_TOKEN_INVALID");

  const expired = await f.flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: f.draft.draft_id, targetScreen: "CLIENT", expiresAt: new Date(Date.now() + 1_000).toISOString() });
  f.advance(2_000);
  assert.equal((await f.flowSessionService.resolveInvoiceFlowSession(expired.value.flow_token)).error, "FLOW_TOKEN_EXPIRED");

  assert.equal((await f.flowSessionService.revokeInvoiceFlowSession(f.session.flow_token)).ok, true);
  assert.equal((await f.flowSessionService.resolveInvoiceFlowSession(f.session.flow_token)).error, "FLOW_TOKEN_REVOKED");
});

test("missing and forbidden session targets fail closed without a CLIENT default", async () => {
  const f = await fixture();
  const expiresAt = new Date(f.now() + 60_000).toISOString();
  assert.equal((await f.flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: f.draft.draft_id, expiresAt })).error, "FLOW_SESSION_TARGET_INVALID");
  assert.equal((await f.flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: f.draft.draft_id, targetScreen: "KADI_SESSION_ROOT", expiresAt })).error, "FLOW_SESSION_TARGET_INVALID");

  const missingToken = "kadi_invoice_v1:11111111111111111111111111111111:1735689600000";
  await f.repository.create({
    flow_token_hash: hashFlowToken(missingToken), owner_ref: "owner-a", draft_id: f.draft.draft_id,
    status: "active", created_at: new Date(f.now()).toISOString(), expires_at: expiresAt,
    consumed_at: null, revoked_at: null,
  });
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: missingToken })).error, "FLOW_SESSION_TARGET_MISSING");

  const forbiddenToken = "kadi_invoice_v1:22222222222222222222222222222222:1735689600000";
  await f.repository.create({
    flow_token_hash: hashFlowToken(forbiddenToken), owner_ref: "owner-a", draft_id: f.draft.draft_id,
    target_screen: "KADI_SESSION_ROOT", status: "active", created_at: new Date(f.now()).toISOString(), expires_at: expiresAt,
    consumed_at: null, revoked_at: null,
  });
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: forbiddenToken })).error, "FLOW_SESSION_TARGET_INVALID");
});

test("target screen migration is additive and preserves legacy sessions for fail-closed rejection", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_add_target_screen_to_kadi_invoice_flow_sessions.sql"), "utf8");
  assert.match(migration, /add column if not exists target_screen text/i);
  assert.match(migration, /add column if not exists return_to_review boolean not null default false/i);
  assert.doesNotMatch(migration, /delete from|drop table|truncate/i);
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

test("INIT rejects a session bound to a draft owned by another account", async () => {
  const f = await fixture();
  const foreign = await f.cartService.createDraft({ ownerRef: "owner-b", flowToken: "foreign-seed" });
  const token = "kadi_invoice_v1:33333333333333333333333333333333:1735689600000";
  await f.repository.create({
    flow_token_hash: hashFlowToken(token), owner_ref: "owner-a", draft_id: foreign.value.draft_id,
    target_screen: "CLIENT", return_to_review: false, status: "active",
    created_at: new Date(f.now()).toISOString(), expires_at: new Date(f.now() + 60_000).toISOString(),
    consumed_at: null, revoked_at: null,
  });
  assert.equal((await f.endpoint.handle({ action: "INIT", flow_token: token })).error, "DRAFT_ACCESS_DENIED");
});
