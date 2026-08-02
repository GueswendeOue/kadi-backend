"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { assertV1PreviewRepository } = require("./kadiV1PreviewRepository");

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,170}$/;

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validOwner(value) {
  return typeof value === "string" && /^\d{8,20}$/.test(value);
}

function validKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function defaultIdFactory(kind, key) {
  return `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function validPricing(value, nowMs) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (![value.base_cost, value.page_cost, value.total_credits].every((cost) => Number.isSafeInteger(cost) && cost >= 0)) return false;
  if (value.total_credits < 1 || typeof value.pricing_version !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value.pricing_version)) {
    return false;
  }
  if (!Array.isArray(value.additional_costs) || typeof value.explanation !== "string" || value.explanation.length < 1 || value.explanation.length > 500) {
    return false;
  }
  if (value.expires_at != null) {
    const expiresMs = Date.parse(value.expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return false;
  }
  return true;
}

function createGenerationQuoteService({
  documentRepository,
  previewRepository,
  pricingPolicy,
  domain = createDocumentDomain(),
  clock = () => new Date().toISOString(),
  idFactory = defaultIdFactory,
  defaultLifetimeSeconds = 3600,
} = {}) {
  const documents = assertV1DocumentRepository(documentRepository);
  const artifacts = assertV1PreviewRepository(previewRepository);
  if (typeof pricingPolicy?.calculate !== "function" || typeof pricingPolicy?.pricingVersion !== "string") {
    throw new TypeError("GENERATION_PRICING_POLICY_REQUIRED");
  }
  if (!Number.isSafeInteger(defaultLifetimeSeconds) || defaultLifetimeSeconds < 60) {
    throw new TypeError("GENERATION_QUOTE_LIFETIME_INVALID");
  }

  async function createGenerationQuote(command) {
    if (!validOwner(command?.ownerWaId) || !validId(command?.documentId) || !validId(command?.previewId) ||
        !validId(command?.renderId) || !validKey(command?.idempotencyKey)) {
      return fail("GENERATION_QUOTE_COMMAND_INVALID");
    }
    const replay = await artifacts.findQuoteByIdempotencyKey(command.idempotencyKey);
    if (!replay.ok) return replay;
    if (replay.value) return ok(replay.value, { duplicate: true });
    const document = await documents.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!document.ok) return document;
    if (document.value.status !== "PREVIEW_READY") return fail("GENERATION_QUOTE_DOCUMENT_STATE_INVALID");
    if (document.value.version !== command.documentVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    const preview = await artifacts.getPreview({ previewId: command.previewId });
    if (!preview.ok || preview.value.status !== "ACTIVE" || preview.value.document_id !== command.documentId ||
        preview.value.document_version !== command.documentVersion) return fail("GENERATION_QUOTE_PREVIEW_INVALID");
    const render = await artifacts.getTemporaryRender({ renderId: command.renderId });
    if (!render.ok || render.value.status !== "INSPECTED" || render.value.preview_id !== command.previewId ||
        render.value.document_version !== command.documentVersion || !Number.isSafeInteger(render.value.page_count) || render.value.page_count < 1) {
      return fail("GENERATION_QUOTE_RENDER_INVALID");
    }
    const pricing = pricingPolicy.calculate({
      documentType: document.value.document_type,
      pageCount: render.value.page_count,
      inputModality: command.inputModality ?? null,
      options: command.options ?? {},
    });
    if (!pricing.ok) return pricing;
    const now = clock();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return fail("GENERATION_QUOTE_CLOCK_INVALID");
    if (!validPricing(pricing.value, nowMs)) return fail("GENERATION_PRICING_RESULT_INVALID");
    const expiresAt = pricing.value.expires_at || new Date(nowMs + defaultLifetimeSeconds * 1000).toISOString();
    const quoteId = idFactory("quote", command.idempotencyKey);
    if (!validId(quoteId)) return fail("GENERATION_QUOTE_ID_INVALID");
    const quote = Object.freeze({
      quote_id: quoteId,
      document_id: command.documentId,
      owner_wa_id: command.ownerWaId,
      document_version: command.documentVersion,
      preview_id: command.previewId,
      temporary_render_id: command.renderId,
      page_count: render.value.page_count,
      pricing_version: pricing.value.pricing_version,
      base_cost: pricing.value.base_cost,
      page_cost: pricing.value.page_cost,
      additional_costs: pricing.value.additional_costs,
      total_credits: pricing.value.total_credits,
      explanation: pricing.value.explanation,
      status: "ACTIVE",
      created_at: new Date(nowMs).toISOString(),
      expires_at: expiresAt,
    });
    const stored = await artifacts.createGenerationQuote({ quote, idempotencyKey: command.idempotencyKey });
    if (!stored.ok) return stored;
    const costTransition = domain.transitionDocument(document.value, DOCUMENT_EVENTS.CALCULATE_COST, {
      generation_quote: {
        quote_id: quoteId,
        document_version: command.documentVersion,
        preview_id: command.previewId,
        temporary_render_id: command.renderId,
        page_count: quote.page_count,
        pricing_version: quote.pricing_version,
        credit_cost: quote.total_credits,
        expires_at: quote.expires_at,
      },
    });
    if (!costTransition.ok) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return costTransition;
    }
    const costPersisted = await documents.persistTransition({
      document: costTransition.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.documentVersion,
      fromState: "PREVIEW_READY",
      eventType: "GENERATION_QUOTE_CREATED",
      idempotencyKey: `${command.idempotencyKey}:cost`,
    });
    if (!costPersisted.ok) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return costPersisted;
    }
    const awaiting = domain.transitionDocument(costPersisted.value, DOCUMENT_EVENTS.REQUEST_GENERATION_CONFIRMATION);
    if (!awaiting.ok) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return awaiting;
    }
    const awaitingPersisted = await documents.persistTransition({
      document: awaiting.value,
      ownerWaId: command.ownerWaId,
      expectedVersion: command.documentVersion,
      fromState: "COST_CALCULATED",
      eventType: "GENERATION_CONFIRMATION_REQUESTED",
      idempotencyKey: `${command.idempotencyKey}:confirmation`,
    });
    if (!awaitingPersisted.ok) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return awaitingPersisted;
    }
    return ok(stored.value, { document: awaitingPersisted.value });
  }

  async function getGenerationQuote({ quoteId, ownerWaId }) {
    if (!validOwner(ownerWaId)) return fail("DOCUMENT_OWNER_INVALID");
    const quote = await artifacts.getGenerationQuote({ quoteId });
    return quote.ok && quote.value.owner_wa_id === ownerWaId ? quote : fail("GENERATION_QUOTE_NOT_FOUND");
  }

  async function validateGenerationQuote({ quoteId, ownerWaId }) {
    const quote = await getGenerationQuote({ quoteId, ownerWaId });
    if (!quote.ok) return quote;
    if (quote.value.status !== "ACTIVE") return fail("GENERATION_QUOTE_NOT_ACTIVE");
    const nowMs = Date.parse(clock());
    const expiresMs = Date.parse(quote.value.expires_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) return fail("GENERATION_QUOTE_TIME_INVALID");
    if (nowMs >= expiresMs) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "EXPIRED" });
      return fail("GENERATION_QUOTE_EXPIRED");
    }
    if (quote.value.pricing_version !== pricingPolicy.pricingVersion) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return fail("GENERATION_QUOTE_PRICING_STALE");
    }
    const document = await documents.getDocumentById({ documentId: quote.value.document_id, ownerWaId });
    if (!document.ok || document.value.version !== quote.value.document_version ||
        !["COST_CALCULATED", "AWAITING_GENERATION_CONFIRMATION"].includes(document.value.status)) {
      await artifacts.invalidateDocumentArtifacts({
        documentId: quote.value.document_id,
        exceptVersion: document.ok ? document.value.version : null,
      });
      return fail("GENERATION_QUOTE_DOCUMENT_STALE");
    }
    const preview = await artifacts.getPreview({ previewId: quote.value.preview_id });
    const render = await artifacts.getTemporaryRender({ renderId: quote.value.temporary_render_id });
    if (!preview.ok || preview.value.status !== "ACTIVE" || !render.ok || render.value.status !== "INSPECTED" ||
        render.value.page_count !== quote.value.page_count) {
      await artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
      return fail("GENERATION_QUOTE_ARTIFACT_STALE");
    }
    return quote;
  }

  async function expireGenerationQuote({ quoteId, ownerWaId }) {
    const quote = await getGenerationQuote({ quoteId, ownerWaId });
    if (!quote.ok) return quote;
    const nowMs = Date.parse(clock());
    const expiresMs = Date.parse(quote.value.expires_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) return fail("GENERATION_QUOTE_TIME_INVALID");
    if (nowMs < expiresMs) return fail("GENERATION_QUOTE_NOT_EXPIRED");
    return artifacts.setGenerationQuoteStatus({ quoteId, status: "EXPIRED" });
  }

  async function invalidateGenerationQuote({ quoteId, ownerWaId }) {
    const quote = await getGenerationQuote({ quoteId, ownerWaId });
    if (!quote.ok) return quote;
    return artifacts.setGenerationQuoteStatus({ quoteId, status: "INVALIDATED" });
  }

  return Object.freeze({
    createGenerationQuote,
    expireGenerationQuote,
    getGenerationQuote,
    invalidateGenerationQuote,
    validateGenerationQuote,
  });
}

module.exports = { createGenerationQuoteService };
