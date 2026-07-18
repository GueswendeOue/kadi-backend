"use strict";

const { BRAIN_SCHEMA_VERSION, KADI_BRAIN_OUTPUT_SCHEMA } = require("./kadiBrainContract");

const MAX_ARRAY = 50;
const MAX_STRING = 4000;

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateNode(value, schema, path = "$", errors = []) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) {
    errors.push(`${path}:type`);
    return errors;
  }
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}:minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}:maximum`);
  }
  if (typeof value === "string" && value.length > MAX_STRING) errors.push(`${path}:too_long`);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) errors.push(`${path}:too_many_items`);
    value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
    return errors;
  }
  if (typeof value === "object") {
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}:unknown`);
      }
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}:required`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(value[key], child, `${path}.${key}`, errors);
    }
  }
  return errors;
}

function hasEvidence(result, field) {
  return result.evidence.some((entry) => {
    if (entry.field !== field) return false;
    if (entry.source !== "derived_arithmetic") return true;
    return /(?:lineTotal|subtotal|grandTotal)$/.test(field);
  });
}

function validateBrainResult(result, brainRequest = null) {
  if (!result || result.providerFailed === true) {
    return { verdict: "provider_failed", errors: [result?.errorType || "provider_failed"] };
  }
  const schemaErrors = validateNode(result, KADI_BRAIN_OUTPUT_SCHEMA);
  if (result.schemaVersion !== BRAIN_SCHEMA_VERSION) schemaErrors.push("$.schemaVersion:version");
  if (schemaErrors.length) return { verdict: "invalid_schema", errors: [...new Set(schemaErrors)] };

  const allowed = brainRequest?.context?.allowedIntents || [];
  if (allowed.length && !allowed.includes(result.intent.name)) {
    return { verdict: "disallowed_intent", errors: [`intent:${result.intent.name}`] };
  }

  const businessErrors = [];
  const document = result.document;
  if (document) {
    document.items.forEach((item, index) => {
      if (item.quantity != null && item.quantity <= 0) businessErrors.push(`items[${index}].quantity`);
      if (item.unitPrice != null && item.unitPrice < 0) businessErrors.push(`items[${index}].unitPrice`);
      if (item.lineTotal != null && item.lineTotal < 0) businessErrors.push(`items[${index}].lineTotal`);
    });
    for (const field of ["subtotal", "grandTotal", "amountPaid"]) {
      if (document[field] != null && document[field] < 0) businessErrors.push(field);
    }
    if (document.paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(document.paymentDate)) {
      businessErrors.push("paymentDate");
    }
  }
  if (result.intent.name === "create_document" && document?.operation !== "create") businessErrors.push("create_document:operation");
  if (result.intent.name === "edit_document" && document?.operation !== "edit") businessErrors.push("edit_document:operation");

  const currentRefs = new Set((brainRequest?.context?.currentDraft?.items || []).map((item) => String(item.lineRef)));
  for (const patch of result.patches) {
    const match = patch.path.match(/^items\.([^\.]+)/);
    if (match && currentRefs.size && !currentRefs.has(match[1])) businessErrors.push(`patch:${patch.path}`);
  }
  if (businessErrors.length) return { verdict: "invalid_business", errors: businessErrors };

  const financialFields = [
    ["document.subtotal", document?.subtotal],
    ["document.grandTotal", document?.grandTotal],
    ["document.amountPaid", document?.amountPaid],
  ];
  document?.items.forEach((item, index) => {
    financialFields.push([`document.items[${index}].quantity`, item.quantity]);
    financialFields.push([`document.items[${index}].unitPrice`, item.unitPrice]);
    financialFields.push([`document.items[${index}].lineTotal`, item.lineTotal]);
  });
  const unsupportedFinancials = financialFields
    .filter(([, value]) => value != null)
    .map(([field]) => field)
    .filter((field) => !hasEvidence(result, field));
  if (unsupportedFinancials.length) {
    return { verdict: "insufficient_evidence", errors: unsupportedFinancials };
  }

  return { verdict: "valid", errors: [] };
}

module.exports = { validateBrainResult, validateNode };
