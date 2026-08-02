"use strict";

const { checksumBuffer, validateMediaInput } = require("./kadiV1MediaContracts");

const REQUIRED_METHODS = Object.freeze(["storeTemporaryMedia", "getTemporaryMedia", "expireTemporaryMedia", "purgeTemporaryMedia"]);

function cloneRecord(record) {
  return {
    contract: structuredClone(record.contract),
    content: Array.isArray(record.content) ? record.content.map((entry) => Buffer.from(entry)) : Buffer.from(record.content),
    status: record.status,
  };
}

function assertTemporaryMediaStore(store) {
  if (!store || typeof store !== "object") throw new TypeError("TEMPORARY_MEDIA_STORE_REQUIRED");
  for (const method of REQUIRED_METHODS) {
    if (typeof store[method] !== "function") throw new TypeError(`TEMPORARY_MEDIA_STORE_METHOD_REQUIRED:${method}`);
  }
  return store;
}

function createInMemoryTemporaryMediaStore({ clock = () => new Date().toISOString() } = {}) {
  const records = new Map();

  async function storeTemporaryMedia({ contract, content }) {
    const checked = validateMediaInput(contract);
    if (!checked.ok) return checked;
    const parts = Array.isArray(content) ? content : [content];
    if (!parts.length || parts.some((entry) => !Buffer.isBuffer(entry) || entry.length === 0)) return { ok: false, error: "MEDIA_CONTENT_INVALID" };
    const combined = Buffer.concat(parts);
    if (combined.length !== contract.byte_size || checksumBuffer(combined) !== contract.checksum) return { ok: false, error: "MEDIA_CONTENT_INTEGRITY_FAILED" };
    const existing = records.get(contract.media_id);
    if (existing) {
      return existing.contract.owner_ref === contract.owner_ref && existing.contract.checksum === contract.checksum
        ? { ok: true, value: cloneRecord(existing), duplicate: true }
        : { ok: false, error: "MEDIA_ID_CONFLICT" };
    }
    const stored = { contract: checked.value, content: Array.isArray(content) ? parts.map(Buffer.from) : Buffer.from(content), status: "ACTIVE" };
    records.set(contract.media_id, stored);
    return { ok: true, value: cloneRecord(stored) };
  }

  async function getTemporaryMedia({ mediaId, ownerRef }) {
    const record = records.get(mediaId);
    if (!record || record.contract.owner_ref !== ownerRef) return { ok: false, error: "MEDIA_NOT_FOUND" };
    if (record.status !== "ACTIVE" || Date.parse(record.contract.expires_at) <= Date.parse(clock())) return { ok: false, error: "MEDIA_EXPIRED" };
    return { ok: true, value: cloneRecord(record) };
  }

  async function expireTemporaryMedia({ mediaId, ownerRef }) {
    const record = records.get(mediaId);
    if (!record || record.contract.owner_ref !== ownerRef) return { ok: false, error: "MEDIA_NOT_FOUND" };
    record.status = "EXPIRED";
    return { ok: true, value: { media_id: mediaId, status: "EXPIRED" } };
  }

  async function purgeTemporaryMedia({ before = clock() } = {}) {
    let purged = 0;
    for (const [mediaId, record] of records) {
      if (record.status === "EXPIRED" || Date.parse(record.contract.expires_at) <= Date.parse(before)) {
        records.delete(mediaId);
        purged += 1;
      }
    }
    return { ok: true, value: { purged } };
  }

  return Object.freeze(assertTemporaryMediaStore({ storeTemporaryMedia, getTemporaryMedia, expireTemporaryMedia, purgeTemporaryMedia }));
}

module.exports = { REQUIRED_METHODS, assertTemporaryMediaStore, createInMemoryTemporaryMediaStore };
