"use strict";

const privacyGateway = require("../kadiBrainPrivacyGateway");
const promptBuilder = require("../kadiBrainPromptBuilder");
const providerContract = require("../kadiBrainProviderContract");
const geminiProvider = require("../kadiBrainGeminiProvider");
const geminiRealClient = require("../kadiBrainGeminiRealClient");
const responseParser = require("../kadiBrainResponseParser");
const intentContract = require("../kadiBrainIntentContract");

const KADI_GEMINI_SMOKE_VERSION = "kadi.gemini-isolated-smoke.v1";
const KADI_GEMINI_SMOKE_MODEL = "gemini-2.5-flash";
const KADI_GEMINI_SMOKE_MESSAGE =
  "Créer une facture de 25000 FCFA pour PERSON_1";

const PUBLIC_CODES = Object.freeze({
  KEY_MISSING: "GEMINI_SMOKE_KEY_MISSING",
  PRIVACY_REJECTED: "GEMINI_SMOKE_PRIVACY_REJECTED",
  REQUEST_INVALID: "GEMINI_SMOKE_REQUEST_INVALID",
  PROVIDER_FAILED: "GEMINI_SMOKE_PROVIDER_FAILED",
  RESPONSE_INVALID: "GEMINI_SMOKE_RESPONSE_INVALID",
  PARSE_FAILED: "GEMINI_SMOKE_PARSE_FAILED",
  INTERNAL_FAILURE: "GEMINI_SMOKE_INTERNAL_FAILURE",
});

function createGeminiSmokeDependencies(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  return {
    createEmptyPrivacyInput:
      source.createEmptyPrivacyInput || privacyGateway.createEmptyPrivacyInput,
    sanitizePrivacyInput:
      source.sanitizePrivacyInput || privacyGateway.sanitizePrivacyInput,
    isPrivacySafeForProvider:
      source.isPrivacySafeForProvider || privacyGateway.isPrivacySafeForProvider,
    createEmptyPromptInput:
      source.createEmptyPromptInput || promptBuilder.createEmptyPromptInput,
    buildIntentResolutionMessages:
      source.buildIntentResolutionMessages ||
      promptBuilder.buildIntentResolutionMessages,
    createEmptyProviderRequest:
      source.createEmptyProviderRequest ||
      providerContract.createEmptyProviderRequest,
    validateProviderRequest:
      source.validateProviderRequest || providerContract.validateProviderRequest,
    validateProviderResponse:
      source.validateProviderResponse ||
      providerContract.validateProviderResponse,
    parseIntentResolutionResponse:
      source.parseIntentResolutionResponse ||
      responseParser.parseIntentResolutionResponse,
  };
}

function failure(exitCode, code) {
  return { exitCode, code, publicResult: null };
}

function createProviderRequest(dependencies, messages) {
  const request = dependencies.createEmptyProviderRequest();
  request.provider = "GEMINI";
  request.model = KADI_GEMINI_SMOKE_MODEL;
  request.messages = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  request.responseFormat = { type: "json_object" };
  request.generation = {
    temperature: 0,
    maxOutputCodePoints: 8000,
  };
  request.metadata = {
    requestPurpose: "intent_resolution",
    tags: ["isolated_smoke"],
  };
  return request;
}

async function runGeminiIsolatedSmokeTest(options = {}) {
  try {
    const source = options && typeof options === "object" ? options : {};
    const apiKey = source.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return failure(1, PUBLIC_CODES.KEY_MISSING);
    }

    const dependencies = createGeminiSmokeDependencies(source.dependencies);
    const privacyInput = dependencies.createEmptyPrivacyInput();
    privacyInput.userMessage = KADI_GEMINI_SMOKE_MESSAGE;
    const privacyResult = dependencies.sanitizePrivacyInput(privacyInput);
    if (
      !privacyResult ||
      privacyResult.allowed !== true ||
      dependencies.isPrivacySafeForProvider(privacyResult) !== true
    ) {
      return failure(2, PUBLIC_CODES.PRIVACY_REJECTED);
    }

    const promptInput = dependencies.createEmptyPromptInput();
    promptInput.channel = "internal_test";
    promptInput.languageHint = "fr";
    promptInput.userMessage = privacyResult.sanitizedInput.userMessage;
    promptInput.capabilities = [intentContract.KADI_INTENTS.CREATE_INVOICE];
    promptInput.businessContext.defaultCurrency = "XOF";
    promptInput.metadata.messageType = "text";
    const promptResult =
      dependencies.buildIntentResolutionMessages(promptInput);
    if (!promptResult || promptResult.valid !== true) {
      return failure(3, PUBLIC_CODES.REQUEST_INVALID);
    }

    const providerRequest = createProviderRequest(
      dependencies,
      promptResult.messages
    );
    if (!dependencies.validateProviderRequest(providerRequest).valid) {
      return failure(3, PUBLIC_CODES.REQUEST_INVALID);
    }

    if (
      typeof source.createRealClient !== "function" ||
      typeof source.createProvider !== "function"
    ) {
      return failure(7, PUBLIC_CODES.INTERNAL_FAILURE);
    }
    const realClient = source.createRealClient({ apiKey });
    if (!realClient) return failure(7, PUBLIC_CODES.INTERNAL_FAILURE);
    const provider = source.createProvider({ client: realClient });
    if (!provider || typeof provider.invoke !== "function") {
      return failure(7, PUBLIC_CODES.INTERNAL_FAILURE);
    }

    const providerResponse = await provider.invoke({
      providerRequest,
      privacyResult,
    });
    if (!dependencies.validateProviderResponse(providerResponse).valid) {
      return failure(5, PUBLIC_CODES.RESPONSE_INVALID);
    }
    if (
      providerResponse.ok !== true ||
      providerResponse.status !== "SUCCEEDED"
    ) {
      return failure(4, PUBLIC_CODES.PROVIDER_FAILED);
    }

    const parsed = dependencies.parseIntentResolutionResponse(
      providerResponse.content
    );
    if (!parsed || parsed.ok !== true || parsed.validation?.valid !== true) {
      return failure(6, PUBLIC_CODES.PARSE_FAILED);
    }

    const publicResult = {
      smokeVersion: KADI_GEMINI_SMOKE_VERSION,
      model: KADI_GEMINI_SMOKE_MODEL,
      privacySafe: true,
      providerRequestValid: true,
      providerStatus: providerResponse.status,
      providerResponseValid: true,
      parserValid: true,
      intent: parsed.resolution.intent,
      actionable: false,
      execution: "NONE",
      usage: {
        inputUnits: providerResponse.usage.inputUnits,
        outputUnits: providerResponse.usage.outputUnits,
        totalUnits: providerResponse.usage.totalUnits,
      },
    };
    if (typeof source.output === "function") source.output(publicResult);
    return { exitCode: 0, code: null, publicResult };
  } catch {
    return failure(7, PUBLIC_CODES.INTERNAL_FAILURE);
  }
}

module.exports = {
  KADI_GEMINI_SMOKE_VERSION,
  KADI_GEMINI_SMOKE_MODEL,
  KADI_GEMINI_SMOKE_MESSAGE,
  createGeminiSmokeDependencies,
  runGeminiIsolatedSmokeTest,
};

if (require.main === module) {
  runGeminiIsolatedSmokeTest({
    apiKey: process.env.GEMINI_API_KEY,
    createRealClient: geminiRealClient.createGeminiRealClient,
    createProvider: geminiProvider.createGeminiProvider,
    output(result) {
      console.log(JSON.stringify(result));
    },
  }).then((result) => {
    process.exitCode = result.exitCode;
    if (result.code) console.error(result.code);
  });
}
