"use strict";

// Thin, dedicated port for the webhook's plain-interactive-button dispatch
// (see kadiV1WebhookRuntime.js) — deliberately its own small module rather
// than reusing kadiV1RuntimeAdapters.js's generation adapter directly, so
// the webhook's required port list stays semantically named ("handle a
// delivery retry") and independent from whatever shape the generation
// adapter's own contract takes over time. All it does is rename the call;
// every actual security/eligibility decision is made server-side in
// kadiV1GenerationLifecycleService.js's retryDelivery.
function assertMethods(target, methods, name) {
  if (!target || typeof target !== "object") throw new TypeError(`${name}_REQUIRED`);
  for (const method of methods) if (typeof target[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  return target;
}

function createKadiV1DeliveryRetryRuntime({ generationRuntime } = {}) {
  const generation = assertMethods(generationRuntime, ["retryDelivery"], "KADI_V1_GENERATION_RUNTIME");
  async function handle({ ownerWaId, documentId, idempotencyKey, confirmed = false }) {
    return generation.retryDelivery({ ownerWaId, documentId, idempotencyKey, confirmed: confirmed === true });
  }
  return Object.freeze({ handle });
}

module.exports = { createKadiV1DeliveryRetryRuntime };
