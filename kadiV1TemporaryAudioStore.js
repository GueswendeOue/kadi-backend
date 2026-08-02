"use strict";

const { checksumAudio, validateAudioContract } = require("./kadiV1AudioContracts");

const REQUIRED_METHODS = Object.freeze(["storeTemporaryAudio", "getTemporaryAudio", "expireTemporaryAudio", "purgeTemporaryAudio"]);

function assertTemporaryAudioStore(store) {
  if (!store || typeof store !== "object") throw new TypeError("TEMPORARY_AUDIO_STORE_REQUIRED");
  for (const method of REQUIRED_METHODS) {
    if (typeof store[method] !== "function") throw new TypeError(`TEMPORARY_AUDIO_STORE_METHOD_REQUIRED:${method}`);
  }
  return store;
}

function clone(record) {
  return { contract: structuredClone(record.contract), content: Buffer.from(record.content), status: record.status };
}

function createInMemoryTemporaryAudioStore({ clock = () => new Date().toISOString() } = {}) {
  const records = new Map();

  async function storeTemporaryAudio({ contract, content }) {
    const checked = validateAudioContract(contract);
    if (!checked.ok) return checked;
    if (!Buffer.isBuffer(content) || content.length !== contract.byte_size || checksumAudio(content) !== contract.checksum) {
      return { ok: false, error: "AUDIO_CONTENT_INTEGRITY_FAILED" };
    }
    const existing = records.get(contract.audio_id);
    if (existing) {
      return existing.contract.owner_id === contract.owner_id && existing.contract.checksum === contract.checksum
        ? { ok: true, value: clone(existing), duplicate: true }
        : { ok: false, error: "AUDIO_ID_CONFLICT" };
    }
    const record = { contract: checked.value, content: Buffer.from(content), status: "ACTIVE" };
    records.set(contract.audio_id, record);
    return { ok: true, value: clone(record), duplicate: false };
  }

  async function getTemporaryAudio({ audioId, ownerId }) {
    const record = records.get(audioId);
    if (!record || record.contract.owner_id !== ownerId) return { ok: false, error: "AUDIO_NOT_FOUND" };
    if (record.status !== "ACTIVE" || Date.parse(record.contract.expires_at) <= Date.parse(clock())) {
      return { ok: false, error: "AUDIO_EXPIRED" };
    }
    return { ok: true, value: clone(record) };
  }

  async function expireTemporaryAudio({ audioId, ownerId }) {
    const record = records.get(audioId);
    if (!record || record.contract.owner_id !== ownerId) return { ok: false, error: "AUDIO_NOT_FOUND" };
    record.status = "EXPIRED";
    return { ok: true, value: { audio_id: audioId, status: "EXPIRED" } };
  }

  async function purgeTemporaryAudio({ before = clock() } = {}) {
    let purged = 0;
    for (const [audioId, record] of records) {
      if (record.status === "EXPIRED" || Date.parse(record.contract.expires_at) <= Date.parse(before)) {
        records.delete(audioId);
        purged += 1;
      }
    }
    return { ok: true, value: { purged } };
  }

  return Object.freeze(assertTemporaryAudioStore({ storeTemporaryAudio, getTemporaryAudio, expireTemporaryAudio, purgeTemporaryAudio }));
}

module.exports = { REQUIRED_METHODS, assertTemporaryAudioStore, createInMemoryTemporaryAudioStore };
