"use strict";

const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const MODALITIES = Object.freeze(["TEXT", "TRANSCRIPTION", "IMAGE", "DOCUMENT"]);
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function integerCost(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createGenerationPricingPolicy(configuration, { clock = () => new Date().toISOString() } = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    throw new TypeError("PRICING_CONFIGURATION_REQUIRED");
  }
  if (!VERSION_PATTERN.test(configuration.pricingVersion || "")) throw new TypeError("PRICING_VERSION_INVALID");
  if (!configuration.documentTypes || typeof configuration.documentTypes !== "object") {
    throw new TypeError("PRICING_DOCUMENT_TYPES_REQUIRED");
  }
  if (Object.keys(configuration).some((key) => /stamp|tampon/i.test(key))) throw new TypeError("PRICING_STAMP_FORBIDDEN");
  const validitySeconds = configuration.validitySeconds ?? null;
  if (validitySeconds != null && (!Number.isSafeInteger(validitySeconds) || validitySeconds < 60)) {
    throw new TypeError("PRICING_VALIDITY_INVALID");
  }

  function calculate({ documentType, pageCount, inputModality = null, options = {} }) {
    if (!DOCUMENT_TYPES.includes(documentType)) return fail("PRICING_DOCUMENT_TYPE_INVALID");
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) return fail("PRICING_PAGE_COUNT_INVALID");
    if (inputModality != null && !MODALITIES.includes(inputModality)) return fail("PRICING_MODALITY_INVALID");
    if (!options || typeof options !== "object" || Array.isArray(options)) return fail("PRICING_OPTIONS_INVALID");
    if (Object.keys(options).some((key) => /stamp|tampon/i.test(key))) return fail("PRICING_STAMP_FORBIDDEN");
    const rates = configuration.documentTypes[documentType];
    if (!rates || !integerCost(rates.baseCost) || !integerCost(rates.perPageCost)) {
      return fail("PRICING_DOCUMENT_CONFIGURATION_MISSING");
    }
    const additionalCosts = [];
    const modalityCost = inputModality == null ? 0 : configuration.modalityCosts?.[inputModality] ?? 0;
    if (!integerCost(modalityCost)) return fail("PRICING_MODALITY_CONFIGURATION_INVALID");
    if (modalityCost > 0) additionalCosts.push({ code: `MODALITY_${inputModality}`, credits: modalityCost });
    for (const [key, enabled] of Object.entries(options)) {
      if (enabled !== true) return fail("PRICING_OPTION_VALUE_INVALID");
      const cost = configuration.optionCosts?.[key];
      if (!integerCost(cost)) return fail("PRICING_OPTION_NOT_ALLOWED");
      if (cost > 0) additionalCosts.push({ code: key, credits: cost });
    }
    const pageCost = rates.perPageCost * pageCount;
    const totalCredits = rates.baseCost + pageCost + additionalCosts.reduce((sum, entry) => sum + entry.credits, 0);
    if (!Number.isSafeInteger(totalCredits) || totalCredits < 1) return fail("PRICING_TOTAL_INVALID");
    const now = clock();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return fail("PRICING_CLOCK_INVALID");
    return ok(Object.freeze({
      base_cost: rates.baseCost,
      page_cost: pageCost,
      additional_costs: Object.freeze(additionalCosts.map(Object.freeze)),
      total_credits: totalCredits,
      pricing_version: configuration.pricingVersion,
      explanation: `Ce document comporte ${pageCount} page${pageCount > 1 ? "s" : ""} et coûtera ${totalCredits} crédit${totalCredits > 1 ? "s" : ""}.`,
      expires_at: validitySeconds == null ? null : new Date(nowMs + validitySeconds * 1000).toISOString(),
    }));
  }

  return Object.freeze({ calculate, pricingVersion: configuration.pricingVersion });
}

module.exports = { createGenerationPricingPolicy };
