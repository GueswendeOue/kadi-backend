"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAudioValidationService, sniffAudioMime } = require("../kadiV1AudioValidationService");
const { createInMemoryTemporaryAudioStore } = require("../kadiV1TemporaryAudioStore");

const NOW = "2026-08-02T12:00:00.000Z";
const OWNER = "owner_audio";

function wav({ seconds = 1, sampleRate = 8_000 } = {}) {
  const dataSize = Math.max(1, Math.round(seconds * sampleRate * 2));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function setup({ clock = () => NOW, logger = null, config = {} } = {}) {
  const store = createInMemoryTemporaryAudioStore({ clock });
  const service = createAudioValidationService({
    temporaryAudioStore: store,
    clock,
    idFactory: () => "audio_test",
    config: { maxBytes: 100_000, maxDurationSeconds: 10, retentionMs: 60_000, ...config },
    logger,
  });
  return { store, service };
}

test("validates a decodable vocal and stores it in a private audio area", async () => {
  const { store, service } = setup();
  const result = await service.ingest({ ownerId: OWNER, file: { buffer: wav(), mime_type: "audio/wav" }, locale: "fr-BF", correlationId: "corr_audio" });
  assert.equal(result.ok, true);
  assert.equal(result.value.source_type, "USER_VOICE");
  assert.equal(result.value.duration_seconds, 1);
  assert.match(result.value.storage_reference, /^temporary-private:\/\/audio\/input\//);
  assert.equal((await store.getTemporaryAudio({ audioId: result.value.audio_id, ownerId: OWNER })).ok, true);
});

test("rejects forbidden MIME, empty, corrupt and content-mismatched audio", async () => {
  const { service } = setup();
  const corruptWav = Buffer.alloc(44);
  corruptWav.write("RIFF", 0);
  corruptWav.write("WAVE", 8);
  assert.equal((await service.ingest({ ownerId: OWNER, file: { buffer: wav(), mime_type: "audio/mpeg" }, correlationId: "c1" })).error, "AUDIO_CONTENT_TYPE_MISMATCH");
  assert.equal((await service.ingest({ ownerId: OWNER, file: { buffer: Buffer.alloc(0), mime_type: "audio/wav" }, correlationId: "c2" })).error, "AUDIO_EMPTY");
  assert.equal((await service.ingest({ ownerId: OWNER, file: { buffer: corruptWav, mime_type: "audio/wav" }, correlationId: "c3" })).error, "AUDIO_UNREADABLE");
});

test("rejects excessive size and duration", async () => {
  const sizeLimited = setup({ config: { maxBytes: 50 } }).service;
  assert.equal((await sizeLimited.ingest({ ownerId: OWNER, file: { buffer: wav(), mime_type: "audio/wav" }, correlationId: "c1" })).error, "AUDIO_TOO_LARGE");
  const durationLimited = setup({ config: { maxDurationSeconds: 0.5 } }).service;
  assert.equal((await durationLimited.ingest({ ownerId: OWNER, file: { buffer: wav(), mime_type: "audio/wav" }, correlationId: "c2" })).error, "AUDIO_DURATION_EXCEEDED");
});

test("ownership, expiration and purge are fail-closed", async () => {
  let now = NOW;
  const { store, service } = setup({ clock: () => now });
  const ingested = await service.ingest({ ownerId: OWNER, file: { buffer: wav(), mime_type: "audio/wav" }, correlationId: "corr" });
  assert.equal((await store.getTemporaryAudio({ audioId: ingested.value.audio_id, ownerId: "other_owner" })).error, "AUDIO_NOT_FOUND");
  now = "2026-08-02T12:02:00.000Z";
  assert.equal((await store.getTemporaryAudio({ audioId: ingested.value.audio_id, ownerId: OWNER })).error, "AUDIO_EXPIRED");
  assert.deepEqual((await service.purgeTemporaryAudio()).value, { purged: 1 });
});

test("audio validation logs only bounded technical metadata", async () => {
  const logs = [];
  const secretOwner = "owner_private";
  const { service } = setup({ logger: (event, details) => logs.push({ event, details }) });
  await service.ingest({ ownerId: secretOwner, file: { buffer: wav(), mime_type: "audio/wav" }, correlationId: "private_correlation" });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /owner_private|private_correlation|temporary-private|RIFF/);
  assert.match(serialized, /audio_validation_succeeded/);
});

test("MIME sniffing accepts only supported decodable families", () => {
  assert.equal(sniffAudioMime(wav()), "audio/wav");
  assert.equal(sniffAudioMime(Buffer.from("MZ executable")), null);
  assert.equal(sniffAudioMime(Buffer.from("PK archive")), null);
});

module.exports = { wav };
