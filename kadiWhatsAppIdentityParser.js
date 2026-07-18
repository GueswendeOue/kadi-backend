"use strict";

const { createWhatsAppIdentityEnvelope } = require("./kadiWhatsAppIdentityEnvelope");

const WHATSAPP_PARSED_EVENT_KINDS = Object.freeze({
  MESSAGE: "message",
  STATUS: "status",
  SYSTEM: "system",
  IDENTITY_UPDATE: "identity_update",
});

const WHATSAPP_IDENTITY_PARSER_STATUSES = Object.freeze({
  VALID: "valid",
  INVALID: "invalid",
});

const WHATSAPP_IDENTITY_PARSER_REASONS = Object.freeze({
  EVENTS_PARSED: "events_parsed",
  INVALID_INPUT: "invalid_input",
  INVALID_FIELD_TYPE: "invalid_field_type",
  INVALID_VALUE: "invalid_value",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeString(value) {
  if (value === null || value === undefined || typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, child] of Object.entries(value)) copy[key] = copyValue(child);
    return copy;
  }
  return value;
}

function emptyMetadata() {
  return {
    messageCount: 0,
    statusCount: 0,
    systemCount: 0,
    identityUpdateCount: 0,
    invalidEventCount: 0,
    totalEventCount: 0,
  };
}

function invalidResult(reason) {
  return {
    status: WHATSAPP_IDENTITY_PARSER_STATUSES.INVALID,
    valid: false,
    reason,
    events: [],
    metadata: emptyMetadata(),
  };
}

function selectContact(contacts, message) {
  const waId = normalizeString(message.from);
  const bsuid = normalizeString(message.from_user_id);
  if (waId) {
    const match = contacts.find((contact) => isPlainObject(contact) && normalizeString(contact.wa_id) === waId);
    if (match) return match;
  }
  if (bsuid) {
    const match = contacts.find((contact) => isPlainObject(contact) && normalizeString(contact.user_id) === bsuid);
    if (match) return match;
  }
  return null;
}

function selectIdentitySource(sources) {
  const unique = [...new Set(sources)];
  if (unique.length === 0) return "unknown";
  if (unique.length > 1) return "mixed";
  return unique[0];
}

function messageIdentity(message, contact) {
  const contactWaId = contact && normalizeString(contact.wa_id);
  const messageWaId = normalizeString(message.from);
  const contactBsuid = contact && normalizeString(contact.user_id);
  const messageBsuid = normalizeString(message.from_user_id);
  const sources = [];
  const waId = contactWaId || messageWaId;
  const bsuid = contactBsuid || messageBsuid;
  if (contactWaId) sources.push("contact_wa_id");
  else if (messageWaId) sources.push("message_from");
  if (contactBsuid) sources.push("contact_user_id");
  else if (messageBsuid) sources.push("message_from_user_id");

  return {
    waId,
    bsuid,
    parentBsuid: (contact && normalizeString(contact.parent_user_id)) || normalizeString(message.from_parent_user_id),
    username: contact && isPlainObject(contact.profile) ? normalizeString(contact.profile.username) : null,
    profileName: contact && isPlainObject(contact.profile) ? normalizeString(contact.profile.name) : null,
    identitySource: selectIdentitySource(sources),
  };
}

function statusIdentity(status) {
  const waId = normalizeString(status.recipient_id);
  const bsuid = normalizeString(status.recipient_user_id);
  const sources = [];
  if (waId) sources.push("status_recipient_id");
  if (bsuid) sources.push("status_recipient_user_id");
  return {
    waId,
    bsuid,
    parentBsuid: normalizeString(status.parent_recipient_user_id),
    username: null,
    profileName: null,
    identitySource: selectIdentitySource(sources),
  };
}

function makeEvent({ kind, sourceIndex, record, identity, businessPortfolioId, phoneNumberId }) {
  const eventType = kind;
  const identityEnvelope = createWhatsAppIdentityEnvelope({
    businessPortfolioId,
    phoneNumberId,
    waId: identity.waId,
    bsuid: identity.bsuid,
    parentBsuid: identity.parentBsuid,
    username: identity.username,
    profileName: identity.profileName,
    eventType,
    identitySource: identity.identitySource,
  });
  const payload = { message: null, status: null, system: null, identityUpdate: null };
  const payloadKey = kind === "identity_update" ? "identityUpdate" : kind;
  payload[payloadKey] = copyValue(record);
  return {
    kind,
    sourceIndex,
    messageId: normalizeString(record.id) || normalizeString(record.message_id),
    timestamp: normalizeString(record.timestamp),
    rawType: normalizeString(record.type) || normalizeString(record.status),
    identityEnvelope,
    payload,
  };
}

function classifyMessage(message) {
  if (message.type === "system" && isPlainObject(message.system)) {
    return message.system.type === "identity_update"
      ? WHATSAPP_PARSED_EVENT_KINDS.IDENTITY_UPDATE
      : WHATSAPP_PARSED_EVENT_KINDS.SYSTEM;
  }
  return WHATSAPP_PARSED_EVENT_KINDS.MESSAGE;
}

function parseWhatsAppIdentityEvents(input) {
  if (!isPlainObject(input)) return invalidResult(WHATSAPP_IDENTITY_PARSER_REASONS.INVALID_INPUT);
  if (!["businessPortfolioId", "phoneNumberId", "value"].every((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    return invalidResult(WHATSAPP_IDENTITY_PARSER_REASONS.INVALID_INPUT);
  }
  if (
    (input.businessPortfolioId !== null && typeof input.businessPortfolioId !== "string") ||
    (input.phoneNumberId !== null && typeof input.phoneNumberId !== "string")
  ) {
    return invalidResult(WHATSAPP_IDENTITY_PARSER_REASONS.INVALID_FIELD_TYPE);
  }
  if (!isPlainObject(input.value)) return invalidResult(WHATSAPP_IDENTITY_PARSER_REASONS.INVALID_VALUE);

  const businessPortfolioId = normalizeString(input.businessPortfolioId);
  const phoneNumberId = normalizeString(input.phoneNumberId);
  const contacts = Array.isArray(input.value.contacts) ? input.value.contacts : [];
  const messages = Array.isArray(input.value.messages) ? input.value.messages : [];
  const statuses = Array.isArray(input.value.statuses) ? input.value.statuses : [];
  const events = [];
  const metadata = emptyMetadata();

  messages.forEach((message, sourceIndex) => {
    if (!isPlainObject(message)) return;
    const kind = classifyMessage(message);
    const contact = selectContact(contacts, message);
    events.push(makeEvent({ kind, sourceIndex, record: message, identity: messageIdentity(message, contact), businessPortfolioId, phoneNumberId }));
    if (kind === "message") metadata.messageCount += 1;
    else if (kind === "system") metadata.systemCount += 1;
    else metadata.identityUpdateCount += 1;
  });

  statuses.forEach((status, sourceIndex) => {
    if (!isPlainObject(status)) return;
    events.push(makeEvent({ kind: "status", sourceIndex, record: status, identity: statusIdentity(status), businessPortfolioId, phoneNumberId }));
    metadata.statusCount += 1;
  });

  metadata.invalidEventCount = events.filter((event) => !event.identityEnvelope.valid).length;
  metadata.totalEventCount = events.length;
  return {
    status: WHATSAPP_IDENTITY_PARSER_STATUSES.VALID,
    valid: true,
    reason: WHATSAPP_IDENTITY_PARSER_REASONS.EVENTS_PARSED,
    events,
    metadata,
  };
}

module.exports = {
  WHATSAPP_PARSED_EVENT_KINDS,
  WHATSAPP_IDENTITY_PARSER_STATUSES,
  WHATSAPP_IDENTITY_PARSER_REASONS,
  parseWhatsAppIdentityEvents,
};
