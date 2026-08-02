"use strict";

const { restoreDocumentSnapshot } = require("./kadiV1DocumentDomain");

const V1_DOCUMENT_REPOSITORY_METHODS = Object.freeze([
  "createDocument",
  "getDocumentById",
  "saveNewVersion",
  "appendDomainEvent",
  "persistTransition",
  "findByIdempotencyKey",
  "listVersions",
]);

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const EVENT_PATTERN = /^[A-Z][A-Z0-9_]{1,99}$/;
const METADATA_KEYS = new Set([
  "source",
  "schema_version",
  "legacy_status",
  "migration_batch",
  "correlation_ref",
  "reason_code",
  "attempt",
]);

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validIdempotencyKey(value) {
  return typeof value === "string" && IDEMPOTENCY_PATTERN.test(value);
}

function normalizeMetadata(value = {}) {
  if (!isPlainRecord(value)) return fail("DOCUMENT_METADATA_INVALID");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!METADATA_KEYS.has(key)) return fail("DOCUMENT_METADATA_FIELD_FORBIDDEN");
    if (!["string", "number", "boolean"].includes(typeof entry) || (typeof entry === "string" && entry.length > 200)) {
      return fail("DOCUMENT_METADATA_VALUE_INVALID");
    }
    result[key] = entry;
  }
  return ok(result);
}

function validateWriteContext({ ownerWaId, idempotencyKey, eventType }) {
  if (!validId(ownerWaId)) return fail("DOCUMENT_OWNER_INVALID");
  if (!validIdempotencyKey(idempotencyKey)) return fail("DOCUMENT_IDEMPOTENCY_KEY_INVALID");
  if (eventType != null && (typeof eventType !== "string" || !EVENT_PATTERN.test(eventType))) {
    return fail("DOCUMENT_EVENT_TYPE_INVALID");
  }
  return ok(true);
}

function assertV1DocumentRepository(repository) {
  if (!repository || typeof repository !== "object") throw new TypeError("DOCUMENT_REPOSITORY_REQUIRED");
  for (const method of V1_DOCUMENT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== "function") throw new TypeError(`DOCUMENT_REPOSITORY_METHOD_REQUIRED:${method}`);
  }
  return repository;
}

function createInMemoryV1DocumentRepository({ failpoint = async () => {} } = {}) {
  if (typeof failpoint !== "function") throw new TypeError("DOCUMENT_REPOSITORY_FAILPOINT_INVALID");
  let documents = new Map();
  let versions = new Map();
  let events = new Map();
  let idempotency = new Map();
  let nextEventId = 1;

  function versionKey(documentId, version) {
    return `${documentId}:${version}`;
  }

  function hydrate(documentRow, snapshot, documentEvents) {
    if (!documentRow || !snapshot) return null;
    const restored = restoreDocumentSnapshot({
      ...clone(snapshot),
      status: documentRow.status,
      version: documentRow.active_version,
      issuer_profile_id: documentRow.issuer_profile_id,
      currency: documentRow.currency,
      issued_at: documentRow.issued_at,
      document_number: documentRow.document_number,
      preview: clone(documentRow.preview),
      generation_quote: clone(documentRow.generation_quote),
      generation_cost: documentRow.generation_cost,
      generated_file: clone(documentRow.generated_file),
      recoverable_failure: clone(documentRow.recoverable_failure),
      cancelled_at: documentRow.cancelled_at,
      events: documentEvents.map((event) => ({
        type: event.event_type,
        from_state: event.from_state,
        to_state: event.to_state,
        version: event.document_version,
        occurred_at: event.occurred_at,
      })),
    });
    return restored.ok ? restored.value : null;
  }

  function readCurrent(documentId) {
    const row = documents.get(documentId);
    if (!row) return null;
    const version = versions.get(versionKey(documentId, row.active_version));
    return hydrate(row, version?.snapshot, events.get(documentId) || []);
  }

  function idempotentResult(key, operation, documentId) {
    const record = idempotency.get(key);
    if (!record) return null;
    if (record.operation_type !== operation || record.document_id !== documentId) {
      return fail("DOCUMENT_IDEMPOTENCY_CONFLICT");
    }
    return ok(readCurrent(record.document_id), { duplicate: true });
  }

  async function commitAtomic(operation, command, apply) {
    const documentId = command.document?.document_id || command.documentId;
    const replay = idempotentResult(command.idempotencyKey, operation, documentId);
    if (replay) return replay;
    const next = {
      documents: new Map(documents),
      versions: new Map(versions),
      events: new Map([...events].map(([key, value]) => [key, clone(value)])),
      idempotency: new Map(idempotency),
      nextEventId,
    };
    const result = apply(next);
    if (!result.ok) return result;
    await failpoint("before_commit", { operation, documentId: command.document?.document_id || command.documentId });
    documents = next.documents;
    versions = next.versions;
    events = next.events;
    idempotency = next.idempotency;
    nextEventId = next.nextEventId;
    return result;
  }

  async function createDocument({
    document,
    ownerWaId,
    idempotencyKey,
    legacyReference = null,
    metadata = {},
  }) {
    const context = validateWriteContext({ ownerWaId, idempotencyKey, eventType: "DOCUMENT_CREATED" });
    if (!context.ok) return context;
    const restored = restoreDocumentSnapshot(document);
    if (!restored.ok || restored.value.status !== "COLLECTING" || restored.value.version !== 1) {
      return fail("DOCUMENT_CREATE_SNAPSHOT_INVALID");
    }
    if (restored.value.issued_at != null || restored.value.document_number != null) {
      return fail("DOCUMENT_SERVER_FIELD_FORBIDDEN");
    }
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    if (legacyReference != null && (!isPlainRecord(legacyReference) || !validId(legacyReference.source) || !validId(legacyReference.id))) {
      return fail("DOCUMENT_LEGACY_REFERENCE_INVALID");
    }
    return commitAtomic("create", { document: restored.value, idempotencyKey }, (next) => {
      if (next.documents.has(restored.value.document_id)) return fail("DOCUMENT_ALREADY_EXISTS");
      const createdAt = restored.value.events[0]?.occurred_at || null;
      next.documents.set(restored.value.document_id, {
        document_id: restored.value.document_id,
        owner_wa_id: ownerWaId,
        document_type: restored.value.document_type,
        status: restored.value.status,
        active_version: 1,
        issuer_profile_id: restored.value.issuer_profile_id ?? null,
        currency: restored.value.currency,
        issued_at: null,
        document_number: null,
        preview: null,
        generation_quote: null,
        generation_cost: null,
        generated_file: null,
        recoverable_failure: null,
        cancelled_at: null,
        legacy_source: legacyReference?.source || null,
        legacy_id: legacyReference?.id || null,
        metadata: safeMetadata.value,
        created_at: createdAt,
        updated_at: createdAt,
      });
      next.versions.set(versionKey(restored.value.document_id, 1), {
        document_id: restored.value.document_id,
        version: 1,
        snapshot: clone(restored.value),
        items: clone(restored.value.items || []),
        created_at: createdAt,
      });
      const event = {
        event_id: next.nextEventId++,
        document_id: restored.value.document_id,
        document_version: 1,
        event_type: "DOCUMENT_CREATED",
        from_state: null,
        to_state: "COLLECTING",
        idempotency_key: idempotencyKey,
        metadata: {},
        occurred_at: createdAt,
      };
      next.events.set(restored.value.document_id, [event]);
      next.idempotency.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        operation_type: "create",
        document_id: restored.value.document_id,
        document_version: 1,
        event_id: event.event_id,
      });
      return ok(restored.value);
    });
  }

  async function getDocumentById({ documentId, ownerWaId }) {
    if (!validId(documentId) || !validId(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const row = documents.get(documentId);
    if (!row || row.owner_wa_id !== ownerWaId) return fail("DOCUMENT_NOT_FOUND");
    const document = readCurrent(documentId);
    return document ? ok(document) : fail("DOCUMENT_SNAPSHOT_INVALID");
  }

  async function persistTransition({
    document,
    ownerWaId,
    expectedVersion,
    fromState,
    eventType,
    idempotencyKey,
    metadata = {},
  }) {
    const context = validateWriteContext({ ownerWaId, idempotencyKey, eventType });
    if (!context.ok) return context;
    const restored = restoreDocumentSnapshot(document);
    if (!restored.ok) return restored;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return fail("DOCUMENT_EXPECTED_VERSION_INVALID");
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    return commitAtomic("persist_transition", { document: restored.value, idempotencyKey }, (next) => {
      const row = next.documents.get(restored.value.document_id);
      if (!row || row.owner_wa_id !== ownerWaId) return fail("DOCUMENT_NOT_FOUND");
      if (row.active_version !== expectedVersion) return fail("DOCUMENT_VERSION_CONFLICT");
      if (row.status !== fromState) return fail("DOCUMENT_STATE_CONFLICT");
      if (![expectedVersion, expectedVersion + 1].includes(restored.value.version)) {
        return fail("DOCUMENT_VERSION_SEQUENCE_INVALID");
      }
      if (restored.value.version === expectedVersion + 1) {
        const key = versionKey(restored.value.document_id, restored.value.version);
        if (next.versions.has(key)) return fail("DOCUMENT_VERSION_CONFLICT");
        next.versions.set(key, {
          document_id: restored.value.document_id,
          version: restored.value.version,
          snapshot: clone(restored.value),
          items: clone(restored.value.items || []),
          created_at: restored.value.events.at(-1)?.occurred_at || null,
        });
      }
      const persistedIssuedAt = row.issued_at || (restored.value.status === "GENERATED" ? restored.value.issued_at : null);
      if (restored.value.status === "GENERATED" && !persistedIssuedAt) return fail("DOCUMENT_ISSUED_AT_REQUIRED");
      const updatedRow = {
        ...row,
        status: restored.value.status,
        active_version: restored.value.version,
        issuer_profile_id: restored.value.issuer_profile_id ?? null,
        currency: restored.value.currency,
        issued_at: persistedIssuedAt,
        preview: clone(restored.value.preview),
        generation_quote: clone(restored.value.generation_quote),
        generation_cost: restored.value.generation_cost,
        generated_file: clone(restored.value.generated_file),
        recoverable_failure: clone(restored.value.recoverable_failure),
        cancelled_at: restored.value.cancelled_at,
        updated_at: restored.value.events.at(-1)?.occurred_at || row.updated_at,
      };
      next.documents.set(restored.value.document_id, updatedRow);
      const event = {
        event_id: next.nextEventId++,
        document_id: restored.value.document_id,
        document_version: restored.value.version,
        event_type: eventType,
        from_state: fromState,
        to_state: restored.value.status,
        idempotency_key: idempotencyKey,
        metadata: safeMetadata.value,
        occurred_at: restored.value.events.at(-1)?.occurred_at || null,
      };
      const documentEvents = next.events.get(restored.value.document_id) || [];
      next.events.set(restored.value.document_id, [...documentEvents, event]);
      next.idempotency.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        operation_type: "persist_transition",
        document_id: restored.value.document_id,
        document_version: restored.value.version,
        event_id: event.event_id,
      });
      return ok(hydrate(updatedRow, next.versions.get(versionKey(restored.value.document_id, restored.value.version)).snapshot, next.events.get(restored.value.document_id)));
    });
  }

  async function saveNewVersion(command) {
    if (!command?.document || command.document.version !== command.expectedVersion + 1) {
      return fail("DOCUMENT_NEW_VERSION_REQUIRED");
    }
    return persistTransition(command);
  }

  async function appendDomainEvent({
    documentId,
    ownerWaId,
    eventType,
    fromState,
    toState,
    idempotencyKey,
    metadata = {},
  }) {
    const context = validateWriteContext({ ownerWaId, idempotencyKey, eventType });
    if (!context.ok || !validId(documentId)) return context.ok ? fail("DOCUMENT_ID_INVALID") : context;
    const safeMetadata = normalizeMetadata(metadata);
    if (!safeMetadata.ok) return safeMetadata;
    return commitAtomic("append_event", { documentId, idempotencyKey }, (next) => {
      const row = next.documents.get(documentId);
      if (!row || row.owner_wa_id !== ownerWaId) return fail("DOCUMENT_NOT_FOUND");
      if (fromState !== row.status || toState !== row.status) return fail("DOCUMENT_EVENT_STATE_INVALID");
      const event = {
        event_id: next.nextEventId++,
        document_id: documentId,
        document_version: row.active_version,
        event_type: eventType,
        from_state: fromState,
        to_state: toState,
        idempotency_key: idempotencyKey,
        metadata: safeMetadata.value,
        occurred_at: null,
      };
      const documentEvents = next.events.get(documentId) || [];
      next.events.set(documentId, [...documentEvents, event]);
      next.idempotency.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        operation_type: "append_event",
        document_id: documentId,
        document_version: row.active_version,
        event_id: event.event_id,
      });
      return ok(hydrate(row, next.versions.get(versionKey(documentId, row.active_version)).snapshot, next.events.get(documentId)));
    });
  }

  async function findByIdempotencyKey(idempotencyKey) {
    if (!validIdempotencyKey(idempotencyKey)) return fail("DOCUMENT_IDEMPOTENCY_KEY_INVALID");
    return ok(clone(idempotency.get(idempotencyKey) || null));
  }

  async function listVersions({ documentId, ownerWaId }) {
    if (!validId(documentId) || !validId(ownerWaId)) return fail("DOCUMENT_LOOKUP_INVALID");
    const row = documents.get(documentId);
    if (!row || row.owner_wa_id !== ownerWaId) return fail("DOCUMENT_NOT_FOUND");
    const result = [...versions.values()]
      .filter((entry) => entry.document_id === documentId)
      .sort((left, right) => left.version - right.version)
      .map((entry) => ({ version: entry.version, snapshot: clone(entry.snapshot), items: clone(entry.items) }));
    return ok(result);
  }

  return Object.freeze(assertV1DocumentRepository({
    appendDomainEvent,
    createDocument,
    findByIdempotencyKey,
    getDocumentById,
    listVersions,
    persistTransition,
    saveNewVersion,
  }));
}

module.exports = {
  V1_DOCUMENT_REPOSITORY_METHODS,
  assertV1DocumentRepository,
  createInMemoryV1DocumentRepository,
  normalizeMetadata,
};
