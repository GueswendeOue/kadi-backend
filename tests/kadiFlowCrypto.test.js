"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MAX_ENVELOPE_BYTES, decryptFlowRequest, encryptFlowResponse, flipIv, parseEncryptedEnvelopeJson } = require("../kadiFlowCrypto");

function fixture(payload) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return { privateKey, key, iv, envelope: { encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"), encrypted_flow_data: data.toString("base64"), initial_vector: iv.toString("base64") } };
}

test("synthetic Meta envelope decrypts and response verifies with flipped IV", () => {
  const f = fixture({ action: "ping" });
  const decrypted = decryptFlowRequest(f.envelope, { privateKey: f.privateKey });
  assert.equal(decrypted.ok, true);
  assert.deepEqual(decrypted.value, { action: "ping" });
  const encrypted = encryptFlowResponse({ data: { status: "active" } }, decrypted.context);
  assert.equal(encrypted.ok, true);
  const bytes = Buffer.from(encrypted.value, "base64");
  const decipher = crypto.createDecipheriv("aes-128-gcm", f.key, flipIv(f.iv));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()])), { data: { status: "active" } });
});

test("missing key, oversized and malformed requests fail closed", () => {
  assert.equal(decryptFlowRequest({}, {}).ok, false);
  assert.equal(decryptFlowRequest({ encrypted_aes_key: "!", encrypted_flow_data: "!", initial_vector: "!" }, { privateKey: "invalid" }).ok, false);
  assert.equal(encryptFlowResponse({}, null).ok, false);
  assert.equal(parseEncryptedEnvelopeJson("{").ok, false);
  assert.equal(parseEncryptedEnvelopeJson("x".repeat(MAX_ENVELOPE_BYTES + 1)).error, "FLOW_REQUEST_TOO_LARGE");
  assert.equal(parseEncryptedEnvelopeJson("[]").ok, false);
});
