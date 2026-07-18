"use strict";

const { createHash } = require("node:crypto");
const { buildBrainRequest, buildKadiContext } = require("./kadiBrainContext");
const { makeKadiBrainProvider } = require("./kadiBrainProvider");
const { validateBrainResult } = require("./kadiBrainValidator");
const { isGlobalMenuText, normalizeGlobalNavText } = require("./kadiGlobalNav");

const EXACT_LOCAL_COMMANDS = new Set([
  "aide", "help", "solde", "credit", "credits", "mon solde",
  "stop", "annuler", "annule", "retour", "menu", "accueil", "home",
]);

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function isShadowEligibleText(text) {
  const normalized = normalizeGlobalNavText(text);
  if (!normalized || normalized.length < 2) return false;
  if (isGlobalMenuText(normalized) || EXACT_LOCAL_COMMANDS.has(normalized)) return false;
  if (/^\//.test(normalized)) return false;
  if (/^(admin|test|debug|broadcast|stats|dashboard|kpi)(\s|$)/.test(normalized)) return false;
  return true;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function makeKadiBrainShadow({ enabled = envFlag(process.env.KADI_BRAIN_SHADOW_ENABLED), provider = null, logger = console, timeoutMs = 5000, maxSeen = 1000 } = {}) {
  const brainProvider = provider || makeKadiBrainProvider({ timeoutMs });
  const seen = new Set();
  const latencies = [];
  const metrics = {
    eligible: 0, calls: 0, succeeded: 0, valid: 0, clarification: 0,
    rejected: 0, insufficientEvidence: 0, errors: 0, timeouts: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
  };

  function safeWaHash(waId) {
    return createHash("sha256").update(String(waId || "unknown")).digest("hex").slice(0, 12);
  }

  function remember(key) {
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > maxSeen) seen.delete(seen.values().next().value);
    return true;
  }

  function snapshotMetrics() {
    return {
      ...metrics,
      validJsonRate: metrics.succeeded ? metrics.valid / metrics.succeeded : null,
      averageTokens: metrics.calls ? metrics.totalTokens / metrics.calls : 0,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
    };
  }

  async function observeText({ waId, text, messageId, session, inputType = "text", mediaFacts = null }) {
    if (!enabled || !isShadowEligibleText(text)) return { observed: false, reason: enabled ? "ineligible" : "disabled" };
    metrics.eligible += 1;
    const dedupeKey = String(messageId || "").trim();
    if (!remember(dedupeKey)) return { observed: false, reason: "duplicate" };

    const context = buildKadiContext({ session: structuredClone(session || {}) });
    const normalizedInputType = ["text", "voice", "image", "correction"].includes(inputType)
      ? inputType
      : "text";
    const request = buildBrainRequest({
      requestId: dedupeKey || undefined,
      inputType: normalizedInputType === "text" && session?.lastDocDraft ? "correction" : normalizedInputType,
      text,
      mediaFacts,
      context,
    });
    metrics.calls += 1;
    const { result, telemetry } = await brainProvider.understand(request);
    const validation = validateBrainResult(result, request);

    latencies.push(Number(telemetry?.latencyMs || 0));
    if (latencies.length > maxSeen) latencies.shift();
    metrics.inputTokens += Number(telemetry?.inputTokens || 0);
    metrics.outputTokens += Number(telemetry?.outputTokens || 0);
    metrics.totalTokens += Number(telemetry?.totalTokens || 0);
    metrics.estimatedCostUsd += Number(telemetry?.estimatedCostUsd || 0);
    if (validation.verdict === "provider_failed") {
      metrics.errors += 1;
      if (result?.errorType === "timeout") metrics.timeouts += 1;
    } else {
      metrics.succeeded += 1;
      if (validation.verdict === "valid") metrics.valid += 1;
      else metrics.rejected += 1;
      if (validation.verdict === "insufficient_evidence") metrics.insufficientEvidence += 1;
      if (result?.status === "needs_clarification") metrics.clarification += 1;
    }

    logger.info?.("brain_shadow", "observation", {
      waHash: safeWaHash(waId),
      requestId: request.requestId,
      inputType: request.inputType,
      sessionStep: request.context.session.step,
      intent: result?.intent?.name || null,
      confidence: result?.intent?.confidence ?? null,
      status: result?.status || null,
      validation: validation.verdict,
      extractedItems: result?.document?.items?.length || 0,
      hasFinancials: !!(result?.document && [result.document.subtotal, result.document.grandTotal, result.document.amountPaid].some((value) => value != null)),
      latencyMs: telemetry?.latencyMs || 0,
      totalTokens: telemetry?.totalTokens || 0,
      estimatedCostUsd: telemetry?.estimatedCostUsd || 0,
      model: telemetry?.model || null,
      fallbackUsed: result?.diagnostics?.fallbackUsed === true,
    });
    return { observed: true, request, result, validation, telemetry };
  }

  return { enabled, observeText, snapshotMetrics };
}

module.exports = { EXACT_LOCAL_COMMANDS, envFlag, isShadowEligibleText, makeKadiBrainShadow };
