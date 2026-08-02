"use strict";

const { createHash } = require("node:crypto");
const {
  BRAIN_MODALITIES,
  validateBrainRequest,
  validateBrainResult,
} = require("./kadiV1BrainContracts");
const { createBrainProvider } = require("./kadiV1BrainProviders");

const BRAIN_EXECUTION_POLICIES = Object.freeze([
  "PRIMARY_ONLY",
  "CONTROLLED_FALLBACK",
  "SHADOW_COMPARE",
]);
const OBSERVABILITY_EVENTS = new Set([
  "brain_request_started",
  "provider_selected",
  "provider_succeeded",
  "provider_failed",
  "brain_result_validated",
  "brain_result_rejected",
  "shadow_comparison_completed",
]);

class KadiBrainError extends Error {
  constructor(code) {
    super(code);
    this.name = "KadiBrainError";
    this.code = code;
  }
}

function validateProviderMap(providers) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new TypeError("BRAIN_PROVIDERS_REQUIRED");
  }
  const result = new Map();
  for (const provider of Object.values(providers)) {
    const checked = createBrainProvider(provider);
    if (result.has(checked.name)) throw new TypeError("BRAIN_PROVIDER_DUPLICATE");
    result.set(checked.name, checked);
  }
  if (result.size === 0) throw new TypeError("BRAIN_PROVIDERS_REQUIRED");
  return result;
}

function validateRouting(routing, providers) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new TypeError("BRAIN_ROUTING_REQUIRED");
  }
  const normalized = {};
  for (const modality of BRAIN_MODALITIES) {
    const name = routing[modality];
    if (typeof name !== "string" || !providers.has(name)) throw new TypeError(`BRAIN_ROUTE_INVALID:${modality}`);
    normalized[modality] = name;
  }
  return Object.freeze(normalized);
}

function optionalRouting(routing, providers, label) {
  if (routing == null) return Object.freeze({});
  if (typeof routing !== "object" || Array.isArray(routing)) throw new TypeError(`${label}_INVALID`);
  const normalized = {};
  for (const [modality, name] of Object.entries(routing)) {
    if (!BRAIN_MODALITIES.includes(modality) || typeof name !== "string" || !providers.has(name)) {
      throw new TypeError(`${label}_INVALID`);
    }
    normalized[modality] = name;
  }
  return Object.freeze(normalized);
}

function createSafeEmitter(logger) {
  const sink = typeof logger === "function"
    ? logger
    : typeof logger?.info === "function"
      ? (event, details) => logger.info(event, details)
      : () => {};
  return (event, details = {}) => {
    if (!OBSERVABILITY_EVENTS.has(event)) return;
    const safe = {
      correlation_id: typeof details.correlation_id === "string"
        ? createHash("sha256").update(details.correlation_id).digest("hex").slice(0, 16)
        : null,
      modality: BRAIN_MODALITIES.includes(details.modality) ? details.modality : null,
      provider: typeof details.provider === "string" ? details.provider.slice(0, 40) : null,
      policy: BRAIN_EXECUTION_POLICIES.includes(details.policy) ? details.policy : null,
      outcome: typeof details.outcome === "string" ? details.outcome.slice(0, 40) : null,
      error_code: typeof details.error_code === "string" ? details.error_code.slice(0, 80) : null,
    };
    if (event === "shadow_comparison_completed") {
      safe.intent_match = details.intent_match === true;
      safe.document_type_match = details.document_type_match === true;
    }
    try {
      sink(event, Object.freeze(safe));
    } catch {
      // Observability must never alter the brain result or error propagation.
    }
  };
}

function asErrorCode(error, fallback = "BRAIN_PROVIDER_FAILED") {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : fallback;
}

function createKadiBrain({
  providers,
  primaryByModality,
  policy = "PRIMARY_ONLY",
  fallbackByModality = null,
  shadowByModality = null,
  minimumConfidence = 0.6,
  logger = null,
} = {}) {
  if (!BRAIN_EXECUTION_POLICIES.includes(policy)) throw new TypeError("BRAIN_POLICY_INVALID");
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new TypeError("BRAIN_CONFIDENCE_THRESHOLD_INVALID");
  }
  const providerMap = validateProviderMap(providers);
  const primaryRoutes = validateRouting(primaryByModality, providerMap);
  const fallbackRoutes = optionalRouting(fallbackByModality, providerMap, "BRAIN_FALLBACK_ROUTING");
  const shadowRoutes = optionalRouting(shadowByModality, providerMap, "BRAIN_SHADOW_ROUTING");
  const emit = createSafeEmitter(logger);

  async function invokeProvider(providerName, request, role) {
    const provider = providerMap.get(providerName);
    emit("provider_selected", {
      correlation_id: request.request_id,
      modality: request.modality,
      provider: providerName,
      policy,
      outcome: role,
    });
    let rawResult;
    try {
      rawResult = await provider.understand(request);
    } catch (error) {
      const errorCode = asErrorCode(error);
      emit("provider_failed", {
        correlation_id: request.request_id,
        modality: request.modality,
        provider: providerName,
        policy,
        outcome: role,
        error_code: errorCode,
      });
      throw new KadiBrainError(errorCode);
    }
    emit("provider_succeeded", {
      correlation_id: request.request_id,
      modality: request.modality,
      provider: providerName,
      policy,
      outcome: role,
    });
    const validated = validateBrainResult(rawResult, { minimumConfidence });
    if (!validated.ok) {
      emit("brain_result_rejected", {
        correlation_id: request.request_id,
        modality: request.modality,
        provider: providerName,
        policy,
        outcome: role,
        error_code: validated.error,
      });
      throw new KadiBrainError(validated.error);
    }
    if (validated.value.provider_metadata.provider !== providerName) {
      emit("brain_result_rejected", {
        correlation_id: request.request_id,
        modality: request.modality,
        provider: providerName,
        policy,
        outcome: role,
        error_code: "BRAIN_PROVIDER_PROVENANCE_MISMATCH",
      });
      throw new KadiBrainError("BRAIN_PROVIDER_PROVENANCE_MISMATCH");
    }
    emit("brain_result_validated", {
      correlation_id: request.request_id,
      modality: request.modality,
      provider: providerName,
      policy,
      outcome: role,
    });
    return validated.value;
  }

  async function runShadow(request, primaryResult) {
    const shadowName = shadowRoutes[request.modality];
    if (!shadowName || shadowName === primaryRoutes[request.modality]) return;
    try {
      const shadowResult = await invokeProvider(shadowName, request, "shadow");
      emit("shadow_comparison_completed", {
        correlation_id: request.request_id,
        modality: request.modality,
        provider: shadowName,
        policy,
        outcome: "compared",
        intent_match: shadowResult.intent === primaryResult.intent,
        document_type_match: shadowResult.document_type === primaryResult.document_type,
      });
    } catch {
      emit("shadow_comparison_completed", {
        correlation_id: request.request_id,
        modality: request.modality,
        provider: shadowName,
        policy,
        outcome: "shadow_failed",
      });
    }
  }

  async function understand(rawRequest) {
    const checked = validateBrainRequest(rawRequest);
    if (!checked.ok) throw new KadiBrainError(checked.error);
    const request = checked.value;
    emit("brain_request_started", {
      correlation_id: request.request_id,
      modality: request.modality,
      policy,
      outcome: "started",
    });
    const primaryName = primaryRoutes[request.modality];
    let result;
    try {
      result = await invokeProvider(primaryName, request, "primary");
    } catch (primaryError) {
      if (policy !== "CONTROLLED_FALLBACK") throw primaryError;
      const fallbackName = fallbackRoutes[request.modality];
      if (!fallbackName || fallbackName === primaryName) throw primaryError;
      result = await invokeProvider(fallbackName, request, "controlled_fallback");
    }
    if (policy === "SHADOW_COMPARE") await runShadow(request, result);
    return result;
  }

  return Object.freeze({ understand });
}

module.exports = {
  BRAIN_EXECUTION_POLICIES,
  KadiBrainError,
  createKadiBrain,
};
