"use strict";

const crypto = require("node:crypto");

const TAG_LENGTH = 16;
const MAX_ENVELOPE_BYTES = 96 * 1024;

function verifyFlowRequestSignature(rawBody, signatureHeader, appSecret) {
  if (typeof rawBody !== "string" || typeof appSecret !== "string" || !appSecret) return false;
  if (typeof signatureHeader !== "string") return false;
  const [algorithm, received] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(received || "")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseEncryptedEnvelopeJson(raw) {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
      return { ok: false, error: "FLOW_REQUEST_TOO_LARGE" };
    }
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return { ok: false, error: "FLOW_ENVELOPE_INVALID" };
    }
    const keys = Object.keys(value);
    if (keys.length !== 3 || !["encrypted_aes_key", "encrypted_flow_data", "initial_vector"].every((key) => keys.includes(key))) {
      return { ok: false, error: "FLOW_ENVELOPE_INVALID" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: "FLOW_ENVELOPE_INVALID" };
  }
}

function decodeBase64(value, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("FLOW_ENVELOPE_INVALID");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.length > maximum) throw new Error("FLOW_ENVELOPE_INVALID");
  return buffer;
}

function flipIv(iv) {
  return Buffer.from(iv, (byte) => byte ^ 0xff);
}

function decryptFlowRequest(envelope, { privateKey, passphrase } = {}) {
  try {
    if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype || typeof privateKey !== "string" || !privateKey) {
      return { ok: false, error: "FLOW_CRYPTO_UNAVAILABLE" };
    }
    const encryptedKey = decodeBase64(envelope.encrypted_aes_key, MAX_ENVELOPE_BYTES);
    const encryptedData = decodeBase64(envelope.encrypted_flow_data, MAX_ENVELOPE_BYTES);
    const iv = decodeBase64(envelope.initial_vector, 32);
    if (iv.length !== 16 || encryptedData.length <= TAG_LENGTH) return { ok: false, error: "FLOW_DECRYPT_FAILED" };
    let key;
    try {
      key = crypto.privateDecrypt({
        key: crypto.createPrivateKey({ key: privateKey, passphrase: passphrase || undefined }),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      }, encryptedKey);
    } catch {
      return { ok: false, error: "FLOW_PRIVATE_KEY_MISMATCH" };
    }
    if (key.length !== 16) return { ok: false, error: "FLOW_DECRYPT_FAILED" };
    const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAuthTag(encryptedData.subarray(-TAG_LENGTH));
    const clear = Buffer.concat([decipher.update(encryptedData.subarray(0, -TAG_LENGTH)), decipher.final()]);
    if (clear.length > MAX_ENVELOPE_BYTES) return { ok: false, error: "FLOW_REQUEST_TOO_LARGE" };
    return { ok: true, value: JSON.parse(clear.toString("utf8")), context: { aesKey: key, initialVector: iv } };
  } catch {
    return { ok: false, error: "FLOW_DECRYPT_FAILED" };
  }
}

function encryptFlowResponse(response, context) {
  try {
    if (!context || !Buffer.isBuffer(context.aesKey) || !Buffer.isBuffer(context.initialVector)) {
      return { ok: false, error: "FLOW_ENCRYPT_FAILED" };
    }
    const clear = Buffer.from(JSON.stringify(response), "utf8");
    if (clear.length > MAX_ENVELOPE_BYTES) return { ok: false, error: "FLOW_RESPONSE_TOO_LARGE" };
    const cipher = crypto.createCipheriv("aes-128-gcm", context.aesKey, flipIv(context.initialVector));
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    return { ok: true, value: encrypted.toString("base64") };
  } catch {
    return { ok: false, error: "FLOW_ENCRYPT_FAILED" };
  }
}

module.exports = { MAX_ENVELOPE_BYTES, decryptFlowRequest, encryptFlowResponse, flipIv, parseEncryptedEnvelopeJson, verifyFlowRequestSignature };
