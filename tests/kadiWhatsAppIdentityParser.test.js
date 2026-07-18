"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WHATSAPP_PARSED_EVENT_KINDS,
  WHATSAPP_IDENTITY_PARSER_STATUSES,
  WHATSAPP_IDENTITY_PARSER_REASONS,
  parseWhatsAppIdentityEvents,
} = require("../kadiWhatsAppIdentityParser");

function input(value, overrides = {}) {
  return { businessPortfolioId: " portfolio-1 ", phoneNumberId: " phone-id-1 ", value, ...overrides };
}

test("exports exact frozen parser constants", () => {
  assert.deepEqual(WHATSAPP_PARSED_EVENT_KINDS, { MESSAGE: "message", STATUS: "status", SYSTEM: "system", IDENTITY_UPDATE: "identity_update" });
  assert.deepEqual(WHATSAPP_IDENTITY_PARSER_STATUSES, { VALID: "valid", INVALID: "invalid" });
  assert.deepEqual(WHATSAPP_IDENTITY_PARSER_REASONS, { EVENTS_PARSED: "events_parsed", INVALID_INPUT: "invalid_input", INVALID_FIELD_TYPE: "invalid_field_type", INVALID_VALUE: "invalid_value" });
  for (const constant of [WHATSAPP_PARSED_EVENT_KINDS, WHATSAPP_IDENTITY_PARSER_STATUSES, WHATSAPP_IDENTITY_PARSER_REASONS]) assert.equal(Object.isFrozen(constant), true);
});

test("rejects invalid input, missing keys, invalid fields and invalid value", () => {
  assert.equal(parseWhatsAppIdentityEvents(null).reason, "invalid_input");
  assert.equal(parseWhatsAppIdentityEvents({ value: {} }).reason, "invalid_input");
  assert.equal(parseWhatsAppIdentityEvents(input({}, { phoneNumberId: 1 })).reason, "invalid_field_type");
  assert.equal(parseWhatsAppIdentityEvents(input([])).reason, "invalid_value");
});

test("parses waId-only, BSUID-only and dual messages", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [
    { id: "m1", from: "wa-1", type: "text" },
    { id: "m2", from_user_id: "bs-2", type: "text" },
    { id: "m3", from: "wa-3", from_user_id: "bs-3", type: "text" },
  ] }));
  assert.equal(result.events[0].identityEnvelope.classification.isWaIdOnly, true);
  assert.equal(result.events[0].identityEnvelope.identitySource, "message_from");
  assert.equal(result.events[1].identityEnvelope.classification.isBsuidOnly, true);
  assert.equal(result.events[1].identityEnvelope.identitySource, "message_from_user_id");
  assert.equal(result.events[2].identityEnvelope.classification.isDualIdentity, true);
  assert.equal(result.events[2].identityEnvelope.identitySource, "mixed");
});

test("associates contacts by wa_id regardless of contact order", () => {
  const result = parseWhatsAppIdentityEvents(input({
    contacts: [
      { wa_id: "wa-2", profile: { username: "second", name: "Second" } },
      { wa_id: "wa-1", profile: { username: "first", name: "First" } },
    ],
    messages: [{ id: "m1", from: "wa-1", type: "text" }, { id: "m2", from: "wa-2", type: "text" }],
  }));
  assert.equal(result.events[0].identityEnvelope.identity.username, "first");
  assert.equal(result.events[1].identityEnvelope.identity.username, "second");
  assert.equal(result.events[0].identityEnvelope.identitySource, "contact_wa_id");
});

test("associates a contact by user_id and supports username metadata", () => {
  const result = parseWhatsAppIdentityEvents(input({
    contacts: [{ user_id: "bs-1", profile: { username: "artisan", name: "Awa" } }],
    messages: [{ id: "m1", from_user_id: "bs-1", type: "text" }],
  }));
  const envelope = result.events[0].identityEnvelope;
  assert.equal(envelope.valid, true);
  assert.equal(envelope.identity.bsuid, "bs-1");
  assert.equal(envelope.identity.username, "artisan");
  assert.equal(envelope.metadata.canResolveByUsername, false);
  assert.equal(envelope.identitySource, "contact_user_id");
});

test("does not use an unrelated contact", () => {
  const result = parseWhatsAppIdentityEvents(input({ contacts: [{ wa_id: "other", profile: { username: "wrong" } }], messages: [{ from: "wa-1", type: "text" }] }));
  assert.equal(result.events[0].identityEnvelope.identity.waId, "wa-1");
  assert.equal(result.events[0].identityEnvelope.identity.username, null);
  assert.equal(result.events[0].identityEnvelope.identitySource, "message_from");
});

test("keeps username-only messages as invalid events", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ id: "m1", type: "text", profile: { username: "ignored" } }] }));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].identityEnvelope.reason, "missing_primary_identity");
  assert.equal(result.metadata.invalidEventCount, 1);
});

test("never mixes identities between two messages", () => {
  const result = parseWhatsAppIdentityEvents(input({
    contacts: [{ wa_id: "wa-b", user_id: "bs-b" }, { wa_id: "wa-a", user_id: "bs-a" }],
    messages: [{ id: "a", from: "wa-a", from_user_id: "bs-a" }, { id: "b", from: "wa-b", from_user_id: "bs-b" }],
  }));
  assert.deepEqual(result.events.map((event) => event.identityEnvelope.identity.waId), ["wa-a", "wa-b"]);
  assert.deepEqual(result.events.map((event) => event.identityEnvelope.identity.bsuid), ["bs-a", "bs-b"]);
});

test("parses waId-only, BSUID-only, dual and multiple statuses", () => {
  const result = parseWhatsAppIdentityEvents(input({ statuses: [
    { id: "s1", recipient_id: "wa-1", status: "sent" },
    { id: "s2", recipient_user_id: "bs-2", status: "read" },
    { id: "s3", recipient_id: "wa-3", recipient_user_id: "bs-3", status: "delivered" },
  ] }));
  assert.equal(result.metadata.statusCount, 3);
  assert.equal(result.events[0].identityEnvelope.identitySource, "status_recipient_id");
  assert.equal(result.events[1].identityEnvelope.identitySource, "status_recipient_user_id");
  assert.equal(result.events[2].identityEnvelope.identitySource, "mixed");
});

test("parses mixed message and status batches with exact counts", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ from: "wa-1" }, { type: "text" }], statuses: [{ recipient_id: "wa-2" }] }));
  assert.deepEqual(result.metadata, { messageCount: 2, statusCount: 1, systemCount: 0, identityUpdateCount: 0, invalidEventCount: 1, totalEventCount: 3 });
  assert.deepEqual(result.events.map((event) => event.kind), ["message", "message", "status"]);
});

test("produces exactly one non-null payload key per event", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ from: "wa-1" }], statuses: [{ recipient_id: "wa-2" }] }));
  for (const event of result.events) assert.equal(Object.values(event.payload).filter((value) => value !== null).length, 1);
});

test("preserves explicit system events without inventing identity updates", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ id: "m1", from: "wa-1", type: "system", system: { type: "notice" } }] }));
  assert.equal(result.events[0].kind, "system");
  assert.equal(result.events[0].payload.system.system.type, "notice");
  assert.equal(result.metadata.systemCount, 1);
  assert.equal(result.metadata.identityUpdateCount, 0);
});

test("recognizes only an explicit identity_update system type", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ id: "m1", from_user_id: "bs-new", type: "system", system: { type: "identity_update" } }] }));
  assert.equal(result.events[0].kind, "identity_update");
  assert.equal(result.events[0].identityEnvelope.eventType, "identity_update");
  assert.equal(result.metadata.identityUpdateCount, 1);
});

test("trims explicit wrapper fields without normalizing identities", () => {
  const result = parseWhatsAppIdentityEvents(input({ messages: [{ from: "  +226 70-00  " }] }));
  assert.equal(result.events[0].identityEnvelope.identity.businessPortfolioId, "portfolio-1");
  assert.equal(result.events[0].identityEnvelope.identity.phoneNumberId, "phone-id-1");
  assert.equal(result.events[0].identityEnvelope.identity.waId, "+226 70-00");
});

test("accepts frozen input without mutation and returns independent deterministic outputs", () => {
  const message = Object.freeze({ id: "m1", from: "wa-1", text: Object.freeze({ body: "hello" }) });
  const value = Object.freeze({ messages: Object.freeze([message]) });
  const frozenInput = Object.freeze(input(value));
  const first = parseWhatsAppIdentityEvents(frozenInput);
  const second = parseWhatsAppIdentityEvents(frozenInput);
  assert.deepEqual(first, second);
  first.events[0].payload.message.text.body = "changed";
  first.events[0].identityEnvelope.identity.waId = "changed";
  assert.deepEqual(parseWhatsAppIdentityEvents(frozenInput), second);
  assert.equal(message.text.body, "hello");
});

test("does not generate internal or Brain identifiers", () => {
  const event = parseWhatsAppIdentityEvents(input({ messages: [{ from: "wa-1" }] })).events[0];
  assert.equal(Object.hasOwn(event, "candidateId"), false);
  assert.equal(Object.hasOwn(event, "profileId"), false);
  assert.equal(Object.hasOwn(event.identityEnvelope.identity, "id"), false);
});
