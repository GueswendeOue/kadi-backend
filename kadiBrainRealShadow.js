"use strict";

const privacyGateway = require("./kadiBrainPrivacyGateway");
const promptBuilder = require("./kadiBrainPromptBuilder");
const providerContract = require("./kadiBrainProviderContract");
const geminiProvider = require("./kadiBrainGeminiProvider");
const geminiRealClient = require("./kadiBrainGeminiRealClient");
const responseParser = require("./kadiBrainResponseParser");
const intentContract = require("./kadiBrainIntentContract");
const brainConfig = require("./kadiBrainConfig");
const {
  KADI_BRAIN_SHADOW_STATUSES,
  createKadiBrainShadowResult,
} = require("./kadiBrainShadowResult");

const KADI_BRAIN_REAL_SHADOW_MODEL = "gemini-3.6-flash";
const KADI_BRAIN_REAL_SHADOW_LIMITS = Object.freeze({
  maxMessageCodePoints: 12000,
  maxMessageIdCodePoints: 256,
  maxFlowStringCodePoints: 80,
  maxExpectedFieldNames: 20,
  maxCacheEntries: 1000,
  defaultCacheEntries: 500,
  defaultTimeoutMs: 10000,
  minTimeoutMs: 100,
  maxTimeoutMs: 30000,
});

const INPUT_KEYS = new Set([
  "messageId", "sourceType", "userMessage", "flowContext",
]);
const FLOW_KEYS = new Set([
  "stepCategory", "activeFlow", "activeDocumentType", "hasActiveDraft",
  "expectedFieldNames", "messageType",
]);
const SOURCE_TYPES = new Set(["text", "voice"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function boundedOptionalText(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    codePointLength(value) > KADI_BRAIN_REAL_SHADOW_LIMITS.maxFlowStringCodePoints
  ) return undefined;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeFlowContext(value) {
  if (value === undefined || value === null) {
    return {
      stepCategory: null,
      activeFlow: null,
      activeDocumentType: null,
      hasActiveDraft: false,
      expectedFieldNames: [],
      messageType: null,
    };
  }
  if (!isPlainObject(value) ||
      Object.keys(value).some((key) => !FLOW_KEYS.has(key))) return null;
  const stepCategory = boundedOptionalText(value.stepCategory);
  const activeFlow = boundedOptionalText(value.activeFlow);
  const activeDocumentType = boundedOptionalText(value.activeDocumentType);
  const messageType = boundedOptionalText(value.messageType);
  if ([stepCategory, activeFlow, activeDocumentType, messageType]
    .includes(undefined)) return null;
  if (
    value.hasActiveDraft !== undefined &&
    typeof value.hasActiveDraft !== "boolean"
  ) return null;
  if (
    value.expectedFieldNames !== undefined &&
    (!Array.isArray(value.expectedFieldNames) ||
      value.expectedFieldNames.length >
        KADI_BRAIN_REAL_SHADOW_LIMITS.maxExpectedFieldNames)
  ) return null;
  const expectedFieldNames = [];
  for (const field of value.expectedFieldNames || []) {
    const normalized = boundedOptionalText(field);
    if (!normalized || normalized === undefined) return null;
    if (!expectedFieldNames.includes(normalized)) expectedFieldNames.push(normalized);
  }
  return {
    stepCategory,
    activeFlow,
    activeDocumentType,
    hasActiveDraft: value.hasActiveDraft === true,
    expectedFieldNames,
    messageType,
  };
}

function normalizeInput(value) {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !INPUT_KEYS.has(key)) ||
    typeof value.messageId !== "string" ||
    !value.messageId.trim() ||
    codePointLength(value.messageId) >
      KADI_BRAIN_REAL_SHADOW_LIMITS.maxMessageIdCodePoints ||
    !SOURCE_TYPES.has(value.sourceType) ||
    typeof value.userMessage !== "string" ||
    !value.userMessage.trim() ||
    codePointLength(value.userMessage) >
      KADI_BRAIN_REAL_SHADOW_LIMITS.maxMessageCodePoints
  ) return null;
  const flowContext = normalizeFlowContext(value.flowContext);
  if (!flowContext) return null;
  return {
    messageId: value.messageId,
    sourceType: value.sourceType,
    userMessage: value.userMessage,
    flowContext,
  };
}

function defaultClock() {
  const milliseconds = Date.now();
  return { milliseconds, timestamp: new Date(milliseconds).toISOString() };
}

function defaultTimeout(promise, timeoutMs) {
  // The timeout bounds waiting; it cannot promise transport cancellation.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

function createDefaultDependencies(overrides = {}) {
  const source = isPlainObject(overrides) ? overrides : {};
  return {
    mode: source.mode,
    env: isPlainObject(source.env) ? source.env : {},
    apiKey: source.apiKey,
    privacyGateway: source.privacyGateway || privacyGateway,
    promptBuilder: source.promptBuilder || promptBuilder,
    providerContract: source.providerContract || providerContract,
    responseParser: source.responseParser || responseParser,
    intentContract: source.intentContract || intentContract,
    provider: source.provider || null,
    createProvider: source.createProvider || geminiProvider.createGeminiProvider,
    createRealClient:
      source.createRealClient || geminiRealClient.createGeminiRealClient,
    clock: typeof source.clock === "function" ? source.clock : defaultClock,
    timeout: typeof source.timeout === "function"
      ? source.timeout
      : defaultTimeout,
    timeoutMs: Number.isInteger(source.timeoutMs) &&
      source.timeoutMs >= KADI_BRAIN_REAL_SHADOW_LIMITS.minTimeoutMs &&
      source.timeoutMs <= KADI_BRAIN_REAL_SHADOW_LIMITS.maxTimeoutMs
      ? source.timeoutMs
      : KADI_BRAIN_REAL_SHADOW_LIMITS.defaultTimeoutMs,
    resultSink: typeof source.resultSink === "function"
      ? source.resultSink
      : null,
    hashFunction: typeof source.hashFunction === "function"
      ? source.hashFunction
      : undefined,
    cacheEntries: Number.isInteger(source.cacheEntries) &&
      source.cacheEntries >= 1 &&
      source.cacheEntries <= KADI_BRAIN_REAL_SHADOW_LIMITS.maxCacheEntries
      ? source.cacheEntries
      : KADI_BRAIN_REAL_SHADOW_LIMITS.defaultCacheEntries,
  };
}

function createProviderRequest(dependencies, messages) {
  const request = dependencies.providerContract.createEmptyProviderRequest();
  request.provider = "GEMINI";
  request.model = KADI_BRAIN_REAL_SHADOW_MODEL;
  request.messages = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  request.timeoutMs = dependencies.timeoutMs;
  request.responseFormat = { type: "json_object" };
  request.generation = { temperature: 0, maxOutputCodePoints: 8000 };
  request.metadata = {
    requestPurpose: "intent_resolution",
    tags: ["real_shadow"],
  };
  return request;
}

function clockValue(clock) {
  try {
    const value = clock();
    if (
      isPlainObject(value) &&
      typeof value.milliseconds === "number" &&
      Number.isFinite(value.milliseconds)
    ) {
      return {
        milliseconds: value.milliseconds,
        timestamp: typeof value.timestamp === "string" ? value.timestamp : null,
      };
    }
  } catch {}
  return { milliseconds: 0, timestamp: null };
}

function createKadiBrainRealShadowRunner(overrides = {}) {
  const dependencies = createDefaultDependencies(overrides);
  // Deduplication is local to this runner instance and is never persisted.
  const seenMessageIds = new Map();

  function cloneBoundedResult(result) {
    const clone = {
      shadowVersion: result.shadowVersion,
      status: result.status,
      sourceType: result.sourceType,
      messageIdHash: result.messageIdHash,
      providerStatus: result.providerStatus,
      providerFailureKind: result.providerFailureKind,
      parserValid: result.parserValid,
      parserFailureCode: result.parserFailureCode,
      intent: result.intent,
      confidenceBucket: result.confidenceBucket,
      actionable: result.actionable,
      missingFieldCount: result.missingFieldCount,
      blockingAmbiguityCount: result.blockingAmbiguityCount,
      safetyFlags: Object.freeze({
        containsSensitiveData: result.safetyFlags.containsSensitiveData,
        requiresHumanReview: result.safetyFlags.requiresHumanReview,
      }),
      latencyBucket: result.latencyBucket,
      execution: "NONE",
      timestamp: result.timestamp,
    };
    return Object.freeze(clone);
  }

  async function emit(fields) {
    const result = createKadiBrainShadowResult({
      ...fields,
      hashFunction: dependencies.hashFunction,
    });
    if (dependencies.resultSink) {
      try {
        await dependencies.resultSink(cloneBoundedResult(result));
      } catch {}
    }
    return result;
  }

  async function run(input) {
    const start = clockValue(dependencies.clock);
    const base = {
      messageId: isPlainObject(input) ? input.messageId : null,
      sourceType: isPlainObject(input) ? input.sourceType : null,
      timestamp: start.timestamp,
      latencyMs: 0,
    };
    try {
      const mode = dependencies.mode === undefined
        ? brainConfig.resolveBrainMode(dependencies.env)
        : brainConfig.normalizeBrainMode(dependencies.mode);
      if (mode !== brainConfig.BRAIN_MODES.SHADOW) {
        return emit({ ...base, status: KADI_BRAIN_SHADOW_STATUSES.SKIPPED });
      }

      const normalized = normalizeInput(input);
      if (!normalized) {
        return emit({
          ...base,
          status: KADI_BRAIN_SHADOW_STATUSES.INPUT_INVALID,
        });
      }

      const preliminary = createKadiBrainShadowResult({
        ...base,
        messageId: normalized.messageId,
        sourceType: normalized.sourceType,
        status: KADI_BRAIN_SHADOW_STATUSES.SKIPPED,
        hashFunction: dependencies.hashFunction,
      });
      if (!preliminary.messageIdHash) {
        return emit({
          ...base,
          status: KADI_BRAIN_SHADOW_STATUSES.INPUT_INVALID,
        });
      }
      // The raw ID stays local and is never persisted or exposed. The public,
      // truncated observability hash is not used as a uniqueness guarantee.
      const deduplicationKey = normalized.messageId;
      if (seenMessageIds.has(deduplicationKey)) {
        return emit({
          ...base,
          messageId: normalized.messageId,
          sourceType: normalized.sourceType,
          status: KADI_BRAIN_SHADOW_STATUSES.SKIPPED_DUPLICATE,
        });
      }
      seenMessageIds.set(deduplicationKey, true);
      if (seenMessageIds.size > dependencies.cacheEntries) {
        seenMessageIds.delete(seenMessageIds.keys().next().value);
      }

      const privacyInput =
        dependencies.privacyGateway.createEmptyPrivacyInput();
      privacyInput.userMessage = normalized.userMessage;
      privacyInput.context = {};
      const privacyResult =
        dependencies.privacyGateway.sanitizePrivacyInput(privacyInput);
      if (
        !privacyResult ||
        privacyResult.allowed !== true ||
        dependencies.privacyGateway.isPrivacySafeForProvider(privacyResult) !== true
      ) {
        return emit({
          ...base,
          messageId: normalized.messageId,
          sourceType: normalized.sourceType,
          status: KADI_BRAIN_SHADOW_STATUSES.PRIVACY_BLOCKED,
        });
      }

      const promptInput = dependencies.promptBuilder.createEmptyPromptInput();
      promptInput.userMessage = privacyResult.sanitizedInput.userMessage;
      promptInput.capabilities =
        Object.values(dependencies.intentContract.KADI_INTENTS);
      promptInput.currentFlow = {
        active: normalized.flowContext.hasActiveDraft ||
          normalized.flowContext.activeFlow !== null,
        flowType: normalized.flowContext.activeFlow,
        step: normalized.flowContext.stepCategory,
        expectedFields: [...normalized.flowContext.expectedFieldNames],
        collectedFields: {
          activeDocumentType: normalized.flowContext.activeDocumentType,
          hasActiveDraft: normalized.flowContext.hasActiveDraft,
        },
      };
      promptInput.metadata = {
        messageType: normalized.flowContext.messageType ||
          normalized.sourceType,
        hasImage: false,
        hasAudio: normalized.sourceType === "voice",
        hasDocument: false,
      };
      const prompt = dependencies.promptBuilder
        .buildIntentResolutionMessages(promptInput);
      if (!prompt || prompt.valid !== true) {
        return emit({
          ...base,
          messageId: normalized.messageId,
          sourceType: normalized.sourceType,
          status: KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
        });
      }

      let provider = dependencies.provider;
      if (!provider) {
        if (
          typeof dependencies.apiKey !== "string" ||
          !dependencies.apiKey.trim()
        ) {
          return emit({
            ...base,
            messageId: normalized.messageId,
            sourceType: normalized.sourceType,
            status: KADI_BRAIN_SHADOW_STATUSES.CONFIG_UNAVAILABLE,
          });
        }
        const client = dependencies.createRealClient({
          apiKey: dependencies.apiKey,
        });
        provider = client
          ? dependencies.createProvider({ client })
          : null;
      }
      if (!provider || typeof provider.invoke !== "function") {
        return emit({
          ...base,
          messageId: normalized.messageId,
          sourceType: normalized.sourceType,
          status: KADI_BRAIN_SHADOW_STATUSES.CONFIG_UNAVAILABLE,
        });
      }

      const providerRequest = createProviderRequest(
        dependencies,
        prompt.messages
      );
      if (!dependencies.providerContract
        .validateProviderRequest(providerRequest).valid) {
        return emit({
          ...base,
          messageId: normalized.messageId,
          sourceType: normalized.sourceType,
          status: KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
        });
      }

      const providerCall = Promise.resolve()
        .then(() => provider.invoke({ providerRequest, privacyResult }))
        .then(
          (value) => ({ kind: "RESOLVED", value }),
          () => ({ kind: "REJECTED" })
        );
      const timed = await dependencies.timeout(
        providerCall,
        dependencies.timeoutMs
      );
      const end = clockValue(dependencies.clock);
      const finish = {
        ...base,
        messageId: normalized.messageId,
        sourceType: normalized.sourceType,
        timestamp: start.timestamp,
        latencyMs: Math.max(0, end.milliseconds - start.milliseconds),
      };
      if (
        !isPlainObject(timed) ||
        typeof timed.timedOut !== "boolean"
      ) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
        });
      }
      if (timed.timedOut === true) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.TIMEOUT,
          providerStatus: "TIMED_OUT",
          providerFailureKind: "TIMEOUT",
        });
      }
      if (
        !isPlainObject(timed.value) ||
        !["RESOLVED", "REJECTED"].includes(timed.value.kind)
      ) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
        });
      }
      if (timed.value.kind === "REJECTED") {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.PROVIDER_FAILED,
          providerFailureKind: "INTERNAL",
        });
      }
      const providerResponse = timed.value.value;
      if (!dependencies.providerContract
        .validateProviderResponse(providerResponse).valid) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.PROVIDER_FAILED,
          providerFailureKind: "INTERNAL",
        });
      }
      if (
        providerResponse.ok !== true ||
        providerResponse.status !== "SUCCEEDED"
      ) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.PROVIDER_FAILED,
          providerStatus: providerResponse.status,
          providerFailureKind: providerResponse.failureKind,
        });
      }

      const parsed = dependencies.responseParser
        .parseIntentResolutionResponse(providerResponse.content);
      if (!parsed || parsed.ok !== true || parsed.validation?.valid !== true) {
        return emit({
          ...finish,
          status: KADI_BRAIN_SHADOW_STATUSES.PARSE_FAILED,
          providerStatus: providerResponse.status,
          parserFailureCode: parsed?.errorCode,
        });
      }
      const resolution = parsed.resolution;
      return emit({
        ...finish,
        status: KADI_BRAIN_SHADOW_STATUSES.SUCCEEDED,
        providerStatus: providerResponse.status,
        parserValid: true,
        intent: resolution.intent,
        confidence: resolution.confidence,
        actionable: parsed.actionable === true,
        missingFieldCount: resolution.missingFields.length,
        blockingAmbiguityCount: resolution.ambiguities.filter(
          (ambiguity) => ambiguity.blocking === true
        ).length,
        safetyFlags: resolution.safety,
      });
    } catch {
      return emit({
        ...base,
        status: KADI_BRAIN_SHADOW_STATUSES.INTERNAL_FAILED,
      });
    }
  }

  return Object.freeze({ run });
}

async function runKadiBrainRealShadow(input, dependencies) {
  return createKadiBrainRealShadowRunner(dependencies).run(input);
}

module.exports = {
  KADI_BRAIN_REAL_SHADOW_MODEL,
  KADI_BRAIN_REAL_SHADOW_LIMITS,
  createKadiBrainRealShadowRunner,
  runKadiBrainRealShadow,
};
