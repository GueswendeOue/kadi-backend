"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DOCUMENT_EVENTS,
  DOCUMENT_STATES,
  DOCUMENT_TYPES,
  createDocumentDomain,
} = require("../kadiV1DocumentDomain");
const {
  V1_DOCUMENT_REPOSITORY_METHODS,
  assertV1DocumentRepository,
  createInMemoryV1DocumentRepository,
} = require("../kadiV1DocumentRepository");
const { createSupabaseV1DocumentRepository } = require("../kadiV1SupabaseDocumentRepository");

const MIGRATION = path.join(
  __dirname,
  "..",
  "migrations",
  "20260802_create_kadi_v1_document_persistence.sql"
);

function domainFixture() {
  let tick = 0;
  return createDocumentDomain({
    clock: () => new Date(Date.parse("2026-08-02T12:00:00.000Z") + tick++ * 1000).toISOString(),
  });
}

function draftInput(overrides = {}) {
  return {
    document_id: "document-v1-1",
    document_type: "FACTURE",
    issuer_profile_id: "issuer-1",
    currency: "XOF",
    client: null,
    items: [],
    discount_amount: 0,
    tax_rate_basis_points: 0,
    ...overrides,
  };
}

function completeInput(overrides = {}) {
  return draftInput({
    client: { name: "Client fictif" },
    items: [{
      item_id: "item-server-1",
      description: "Service",
      quantity_millis: 1000,
      unit: "unité",
      unit_price: 25000,
    }],
    ...overrides,
  });
}

function must(result) {
  assert.equal(result.ok, true, result.error);
  return result.value;
}

test("repository interface exposes the seven provider-independent operations", () => {
  const repository = createInMemoryV1DocumentRepository();
  assert.equal(assertV1DocumentRepository(repository), repository);
  assert.deepEqual(V1_DOCUMENT_REPOSITORY_METHODS, [
    "createDocument",
    "getDocumentById",
    "saveNewVersion",
    "appendDomainEvent",
    "persistTransition",
    "findByIdempotencyKey",
    "listVersions",
  ]);
});

test("creates and faithfully reloads a COLLECTING document", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  const document = must(domain.createDocument(draftInput()));
  const created = await repository.createDocument({
    document,
    ownerWaId: "22670000000",
    idempotencyKey: "document:create:1",
  });
  assert.equal(created.ok, true);
  const loaded = must(await repository.getDocumentById({
    documentId: document.document_id,
    ownerWaId: "22670000000",
  }));
  assert.deepEqual(loaded, document);
  assert.equal(Object.isFrozen(loaded), true);
});

test("persists an INCOMPLETE document without inventing client, item or amount", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  let document = must(domain.createDocument(draftInput()));
  await repository.createDocument({ document, ownerWaId: "22670000000", idempotencyKey: "document:create:incomplete" });
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_INCOMPLETE));
  const saved = must(await repository.persistTransition({
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MARK_INCOMPLETE,
    idempotencyKey: "document:incomplete:1",
  }));
  assert.equal(saved.status, "INCOMPLETE");
  assert.equal(saved.client, null);
  assert.deepEqual(saved.items, []);
  assert.equal(saved.subtotal, 0);
  assert.equal(saved.total, 0);
});

test("saves a new immutable version and preserves server item ids", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  let document = must(domain.createDocument(completeInput()));
  await repository.createDocument({ document, ownerWaId: "22670000000", idempotencyKey: "document:create:versioned" });
  document = must(domain.modifyDocument(document, {
    items: [{
      item_id: "item-server-1",
      description: "Service corrigé",
      quantity_millis: 2000,
      unit: "unité",
      unit_price: 25000,
    }],
  }));
  const saved = must(await repository.saveNewVersion({
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MODIFY,
    idempotencyKey: "document:version:2",
  }));
  assert.equal(saved.version, 2);
  assert.equal(saved.items[0].item_id, "item-server-1");
  assert.equal(saved.items[0].line_total, 50000);
  const versions = must(await repository.listVersions({ documentId: document.document_id, ownerWaId: "22670000000" }));
  assert.equal(versions.length, 2);
  assert.equal(versions[0].snapshot.items[0].description, "Service");
  assert.equal(versions[1].snapshot.items[0].description, "Service corrigé");
});

test("rejects an obsolete optimistic version without losing the current aggregate", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  let document = must(domain.createDocument(completeInput()));
  await repository.createDocument({ document, ownerWaId: "22670000000", idempotencyKey: "document:create:conflict" });
  document = must(domain.modifyDocument(document, { notes: "Version deux" }));
  await repository.saveNewVersion({
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MODIFY,
    idempotencyKey: "document:version:conflict:first",
  });
  const stale = await repository.saveNewVersion({
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MODIFY,
    idempotencyKey: "document:version:conflict:stale",
  });
  assert.equal(stale.error, "DOCUMENT_VERSION_CONFLICT");
  assert.equal(must(await repository.getDocumentById({ documentId: document.document_id, ownerWaId: "22670000000" })).version, 2);
});

test("persists transition and event atomically and deduplicates the same idempotency key", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  let document = must(domain.createDocument(completeInput()));
  await repository.createDocument({ document, ownerWaId: "22670000000", idempotencyKey: "document:create:atomic" });
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW));
  const command = {
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW,
    idempotencyKey: "document:transition:ready",
  };
  const first = await repository.persistTransition(command);
  const replay = await repository.persistTransition(command);
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  const record = must(await repository.findByIdempotencyKey(command.idempotencyKey));
  assert.equal(record.document_id, document.document_id);
  const loaded = must(await repository.getDocumentById({ documentId: document.document_id, ownerWaId: "22670000000" }));
  assert.equal(loaded.status, "READY_FOR_REVIEW");
  assert.equal(loaded.events.filter(({ type }) => type === DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW).length, 1);
});

test("appendDomainEvent is idempotent without changing state or version", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  const document = must(domain.createDocument(draftInput()));
  await repository.createDocument({ document, ownerWaId: "22670000000", idempotencyKey: "document:create:event" });
  const command = {
    documentId: document.document_id,
    ownerWaId: "22670000000",
    eventType: "DOCUMENT_AUDITED",
    fromState: "COLLECTING",
    toState: "COLLECTING",
    idempotencyKey: "document:event:audit",
    metadata: { source: "test" },
  };
  const first = await repository.appendDomainEvent(command);
  const replay = await repository.appendDomainEvent(command);
  assert.equal(first.ok, true);
  assert.equal(replay.duplicate, true);
  const loaded = must(await repository.getDocumentById({ documentId: document.document_id, ownerWaId: "22670000000" }));
  assert.equal(loaded.status, "COLLECTING");
  assert.equal(loaded.version, 1);
  assert.equal(loaded.events.filter(({ type }) => type === "DOCUMENT_AUDITED").length, 1);
});

test("rejects reuse of an idempotency key for another operation or document", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  const first = must(domain.createDocument(draftInput()));
  const second = must(domain.createDocument(draftInput({ document_id: "document-v1-2" })));
  await repository.createDocument({
    document: first,
    ownerWaId: "22670000000",
    idempotencyKey: "document:key:scoped",
  });
  const conflict = await repository.createDocument({
    document: second,
    ownerWaId: "22670000000",
    idempotencyKey: "document:key:scoped",
  });
  assert.equal(conflict.error, "DOCUMENT_IDEMPOTENCY_CONFLICT");
  assert.equal((await repository.getDocumentById({
    documentId: second.document_id,
    ownerWaId: "22670000000",
  })).error, "DOCUMENT_NOT_FOUND");
});

test("rolls back every in-memory write when an atomic commit fails", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository({
    failpoint: async () => { throw new Error("synthetic failure"); },
  });
  const document = must(domain.createDocument(draftInput()));
  await assert.rejects(repository.createDocument({
    document,
    ownerWaId: "22670000000",
    idempotencyKey: "document:create:rollback",
  }), /synthetic failure/);
  assert.equal((await repository.getDocumentById({ documentId: document.document_id, ownerWaId: "22670000000" })).error, "DOCUMENT_NOT_FOUND");
  assert.equal(must(await repository.findByIdempotencyKey("document:create:rollback")), null);
});

test("rejects a user supplied issued_at at the repository boundary", async () => {
  const domain = domainFixture();
  const repository = createInMemoryV1DocumentRepository();
  const document = must(domain.createDocument(draftInput()));
  const forged = { ...structuredClone(document), issued_at: "2000-01-01T00:00:00.000Z" };
  const result = await repository.createDocument({
    document: forged,
    ownerWaId: "22670000000",
    idempotencyKey: "document:create:forged-date",
  });
  assert.equal(result.error, "DOCUMENT_SERVER_FIELD_FORBIDDEN");
});

test("Supabase adapter persists a transition through one atomic RPC call", async () => {
  const calls = [];
  const client = {
    from() { throw new Error("unexpected direct table call"); },
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { document_id: args.p_document_id, version: 1, status: args.p_to_state, duplicate: false }, error: null };
    },
  };
  const domain = domainFixture();
  let document = must(domain.createDocument(completeInput()));
  document = must(domain.transitionDocument(document, DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW));
  const repository = createSupabaseV1DocumentRepository(client);
  const result = await repository.persistTransition({
    document,
    ownerWaId: "22670000000",
    expectedVersion: 1,
    fromState: "COLLECTING",
    eventType: DOCUMENT_EVENTS.MARK_READY_FOR_REVIEW,
    idempotencyKey: "document:supabase:transition",
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "kadi_v1_persist_transition");
  assert.equal(calls[0].args.p_expected_version, 1);
  assert.equal(calls[0].args.p_to_state, "READY_FOR_REVIEW");
});

test("migration creates only additive V1 tables, constraints and atomic functions", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  for (const table of [
    "kadi_v1_documents",
    "kadi_v1_document_versions",
    "kadi_v1_document_items",
    "kadi_v1_document_events",
    "kadi_v1_idempotency_records",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, "i"));
  }
  for (const type of DOCUMENT_TYPES) assert.match(sql, new RegExp(`'${type}'`));
  for (const state of DOCUMENT_STATES) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /primary key \(document_id, version\)/i);
  assert.match(sql, /primary key \(document_id, document_version, item_id\)/i);
  assert.match(sql, /kadi_v1_document_events_idempotency_uidx/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /KADI_V1_VERSION_CONFLICT/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /KADI_V1_IDEMPOTENCY_CONFLICT/i);
  assert.match(sql, /kadi_v1_document_versions_immutable/i);
  assert.match(sql, /kadi_v1_document_items_immutable/i);
  assert.match(sql, /kadi_v1_document_events_immutable/i);
  assert.doesNotMatch(sql, /(?:alter|drop|truncate|delete from|update|insert into)\s+(?:table\s+)?public\.(?:business_profiles|kadi_documents|kadi_wallets|kadi_topups|kadi_invoice_flow_sessions|kadi_invoice_flow_drafts)\b/i);
});

test("migration keeps legacy references nullable and never backfills historical rows", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  assert.match(sql, /legacy_source text,\s+legacy_id text,/i);
  assert.doesNotMatch(sql, /welcome_credits|WELCOME_CREDITS|decrement_credit|consume_credits/i);
  assert.doesNotMatch(sql, /insert into public\.kadi_documents|select.+from public\.kadi_documents/is);
});
