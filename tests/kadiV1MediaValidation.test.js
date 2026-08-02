"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { createInMemoryTemporaryMediaStore } = require("../kadiV1TemporaryMediaStore");
const { createMediaValidationService, sniffMime } = require("../kadiV1MediaValidationService");

const NOW = "2026-08-02T12:00:00.000Z";
const OWNER = "owner_media";
let sequence = 0;

async function png() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
}

async function pdf(pageCount = 1) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) document.addPage([100, 100]);
  return Buffer.from(await document.save());
}

function setup(overrides = {}) {
  const clock = overrides.clock || (() => NOW);
  const store = createInMemoryTemporaryMediaStore({ clock });
  const logs = [];
  const service = createMediaValidationService({
    temporaryMediaStore: store,
    clock,
    idFactory: () => `media_${++sequence}`,
    config: { maxImageBytes: 100_000, maxPdfBytes: 200_000, maxPages: 3, retentionMs: 60_000, ...overrides.config },
    logger: (event, details) => logs.push({ event, details }),
  });
  return { store, service, logs };
}

test("validates and privately stores a decodable image", async () => {
  const { store, service } = setup();
  const buffer = await png();
  const result = await service.ingest({ ownerRef: OWNER, sourceType: "IMAGE", correlationId: "corr_image", files: [{ buffer, mime_type: "image/png", filename: "scan.png" }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.page_count, 1);
  assert.match(result.value.storage_reference, /^temporary-private:\/\//);
  assert.equal((await store.getTemporaryMedia({ mediaId: result.value.media_id, ownerRef: OWNER })).ok, true);
});

test("accepts DOCUMENT_IMAGE through the same private validation boundary", async () => {
  const { service } = setup();
  const result = await service.ingest({ ownerRef: OWNER, sourceType: "DOCUMENT_IMAGE", correlationId: "corr_document_image", files: [{ buffer: await png(), mime_type: "image/png" }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.source_type, "DOCUMENT_IMAGE");
});

test("validates readable multipage PDF and preserves page count", async () => {
  const { service } = setup();
  const result = await service.ingest({ ownerRef: OWNER, sourceType: "PDF", correlationId: "corr_pdf", files: [{ buffer: await pdf(3), mime_type: "application/pdf", filename: "document.pdf" }] });
  assert.equal(result.ok, true);
  assert.equal(result.value.page_count, 3);
});

test("preserves MULTI_IMAGE order and aggregate integrity", async () => {
  const { store, service } = setup();
  const first = await png();
  const second = await sharp(first).negate().png().toBuffer();
  const result = await service.ingest({ ownerRef: OWNER, sourceType: "MULTI_IMAGE", correlationId: "corr_multi", files: [
    { buffer: first, mime_type: "image/png", filename: "page-1.png" },
    { buffer: second, mime_type: "image/png", filename: "page-2.png" },
  ] });
  const stored = await store.getTemporaryMedia({ mediaId: result.value.media_id, ownerRef: OWNER });
  assert.equal(result.value.page_count, 2);
  assert.equal(stored.value.content[0].equals(first), true);
  assert.equal(stored.value.content[1].equals(second), true);
});

test("rejects empty, forbidden, corrupt and content-mismatched files fail-closed", async () => {
  const { service } = setup();
  const base = { ownerRef: OWNER, correlationId: "corr_bad" };
  assert.equal((await service.ingest({ ...base, sourceType: "IMAGE", files: [{ buffer: Buffer.alloc(0), mime_type: "image/png" }] })).error, "MEDIA_EMPTY");
  assert.equal((await service.ingest({ ...base, sourceType: "IMAGE", files: [{ buffer: Buffer.from("MZ executable"), mime_type: "application/octet-stream", filename: "bad.exe" }] })).error, "MEDIA_CONTENT_TYPE_MISMATCH");
  assert.equal((await service.ingest({ ...base, sourceType: "IMAGE", files: [{ buffer: Buffer.from("not an image"), mime_type: "image/png" }] })).error, "MEDIA_CONTENT_TYPE_MISMATCH");
  assert.equal((await service.ingest({ ...base, sourceType: "IMAGE", files: [{ buffer: await png(), mime_type: "image/jpeg", filename: "fake.jpg" }] })).error, "MEDIA_CONTENT_TYPE_MISMATCH");
});

test("rejects extension mismatch and source/MIME mismatch", async () => {
  const { service } = setup();
  const image = await png();
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "IMAGE", correlationId: "corr_ext", files: [{ buffer: image, mime_type: "image/png", filename: "scan.jpg" }] })).error, "MEDIA_EXTENSION_MISMATCH");
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "PDF", correlationId: "corr_source", files: [{ buffer: image, mime_type: "image/png", filename: "scan.png" }] })).error, "MEDIA_SOURCE_MIME_MISMATCH");
});

test("rejects excessive byte size and page count", async () => {
  const image = await png();
  const small = setup({ config: { maxImageBytes: image.length - 1 } }).service;
  assert.equal((await small.ingest({ ownerRef: OWNER, sourceType: "IMAGE", correlationId: "corr_size", files: [{ buffer: image, mime_type: "image/png" }] })).error, "MEDIA_TOO_LARGE");
  const { service } = setup({ config: { maxPages: 2 } });
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "PDF", correlationId: "corr_pages", files: [{ buffer: await pdf(3), mime_type: "application/pdf" }] })).error, "MEDIA_PAGE_LIMIT_EXCEEDED");
});

test("rejects a PDF with valid magic but unreadable structure", async () => {
  const { service } = setup();
  const corrupt = Buffer.from("%PDF-1.7\nnot-a-real-pdf");
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "PDF", correlationId: "corr_corrupt", files: [{ buffer: corrupt, mime_type: "application/pdf" }] })).error, "MEDIA_PDF_UNREADABLE");
});

test("rejects corrupt image data and encrypted PDF markers", async () => {
  const { service } = setup();
  const corruptPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("broken")]);
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "IMAGE", correlationId: "corr_bad_image", files: [{ buffer: corruptPng, mime_type: "image/png" }] })).error, "MEDIA_IMAGE_UNREADABLE");
  const encrypted = Buffer.from("%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj");
  assert.equal((await service.ingest({ ownerRef: OWNER, sourceType: "PDF", correlationId: "corr_encrypted", files: [{ buffer: encrypted, mime_type: "application/pdf" }] })).error, "MEDIA_PDF_ENCRYPTED");
});

test("ownership, expiration and purge remain fail-closed", async () => {
  let now = NOW;
  const { store, service } = setup({ clock: () => now });
  const result = await service.ingest({ ownerRef: OWNER, sourceType: "IMAGE", correlationId: "corr_expire", files: [{ buffer: await png(), mime_type: "image/png" }] });
  assert.equal((await store.getTemporaryMedia({ mediaId: result.value.media_id, ownerRef: "other_owner" })).error, "MEDIA_NOT_FOUND");
  now = "2026-08-02T12:02:00.000Z";
  assert.equal((await store.getTemporaryMedia({ mediaId: result.value.media_id, ownerRef: OWNER })).error, "MEDIA_EXPIRED");
  assert.equal((await store.purgeTemporaryMedia()).value.purged, 1);
});

test("validation logs expose bounded technical metadata only", async () => {
  const { service, logs } = setup();
  await service.ingest({ ownerRef: "owner_private_name", sourceType: "IMAGE", correlationId: "corr_safe", files: [{ buffer: await png(), mime_type: "image/png", filename: "private-client.png" }] });
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /owner_private_name|private-client|temporary-private|iVBOR|client/i);
  assert.ok(logs.some(({ event }) => event === "media_validation_succeeded"));
});

test("magic-byte detector recognizes only allowed media families", async () => {
  assert.equal(sniffMime(await png()), "image/png");
  assert.equal(sniffMime(await pdf()), "application/pdf");
  assert.equal(sniffMime(Buffer.from("PK archive")), null);
});
