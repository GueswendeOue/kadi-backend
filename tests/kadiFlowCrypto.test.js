"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MAX_ENVELOPE_BYTES, decryptFlowRequest, encryptFlowResponse, flipIv, parseEncryptedEnvelopeJson, verifyFlowRequestSignature } = require("../kadiFlowCrypto");

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
  assert.equal(typeof encrypted.value, "string");
  assert.equal(encrypted.value.length % 4, 0);
  assert.match(encrypted.value, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok((encrypted.value.match(/=+$/) || [""])[0].length <= 2);
});

test("response encryption uses the exact per-request AES and flipped IV", () => {
  const logs = [];
  const keyA = crypto.randomBytes(16);
  const ivA = crypto.randomBytes(16);
  const keyB = crypto.randomBytes(16);
  const ivB = crypto.randomBytes(16);
  const response = { screen: "ARTICLE_CART", data: { item_count: 1 } };
  const first = encryptFlowResponse(response, { aesKey: keyA, initialVector: ivA, requestId: "a", logger: (_id, fields) => logs.push(fields) });
  const second = encryptFlowResponse({ error_msg: "invalid" }, { aesKey: keyB, initialVector: ivB, requestId: "b", logger: (_id, fields) => logs.push(fields) });
  for (const [encrypted, key, iv, expected] of [[first, keyA, ivA, response], [second, keyB, ivB, { error_msg: "invalid" }]]) {
    assert.equal(encrypted.ok, true);
    const bytes = Buffer.from(encrypted.value, "base64");
    assert.equal(bytes.length >= 16, true);
    const decipher = crypto.createDecipheriv("aes-128-gcm", key, flipIv(iv));
    decipher.setAuthTag(bytes.subarray(-16));
    const clear = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), expected);
  }
  assert.deepEqual(logs.map((entry) => [entry.aes_key_bytes, entry.request_iv_bytes, entry.response_iv_bytes, entry.auth_tag_bytes]), [[16, 16, 16, 16], [16, 16, 16, 16]]);
});

test("IV flipping is bytewise bitwise-NOT and not a reused context", () => {
  assert.deepEqual([...flipIv(Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff]))], [0xff, 0xfe, 0x80, 0x7f, 0x00]);
});

test("missing key, oversized and malformed requests fail closed", () => {
  assert.equal(decryptFlowRequest({}, {}).ok, false);
  assert.equal(decryptFlowRequest({ encrypted_aes_key: "!", encrypted_flow_data: "!", initial_vector: "!" }, { privateKey: "invalid" }).ok, false);
  assert.equal(encryptFlowResponse({}, null).ok, false);
  assert.equal(parseEncryptedEnvelopeJson("{").ok, false);
  assert.equal(parseEncryptedEnvelopeJson("x".repeat(MAX_ENVELOPE_BYTES + 1)).error, "FLOW_REQUEST_TOO_LARGE");
  assert.equal(parseEncryptedEnvelopeJson("[]").ok, false);
});

test("Flow signature uses the exact raw body and fails closed for malformed lengths", () => {
  const body = '{"encrypted_aes_key":"a","encrypted_flow_data":"b","initial_vector":"c"}';
  const secret = "synthetic-app-secret";
  const digest = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(verifyFlowRequestSignature(body, `sha256=${digest}`, secret), true);
  assert.equal(verifyFlowRequestSignature(body, "sha256=00", secret), false);
  assert.equal(verifyFlowRequestSignature(body, undefined, secret), false);
  assert.equal(verifyFlowRequestSignature(body, `sha256=${digest}`, ""), false);
});
