"use strict";

const {
  createKadiV1ConversationOrchestrator,
} = require("./kadiV1ConversationOrchestrator");
const {
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1HistoryRuntimeAdapter,
  createKadiV1InterpretationRuntimeAdapter,
  createKadiV1OnboardingRuntimeAdapter,
  createKadiV1VoicePolicyRuntimeAdapter,
  createKadiV1WalletRuntimeAdapter,
} = require("./kadiV1RuntimeAdapters");
const {
  createSupabaseOnboardingRepository,
} = require("./kadiV1SupabaseOnboardingRepository");
const {
  createSupabaseV1DocumentRepository,
} = require("./kadiV1SupabaseDocumentRepository");
const {
  createKadiV1UserContextService,
} = require("./kadiV1UserContextService");
const {
  createVoicePolicyEngine,
} = require("./kadiV1VoicePolicyEngine");
const {
  createKadiV1OnboardingService,
} = require("./kadiV1WelcomeService");

function createKadiV1ProductionOrchestratorComposition({
  config,
  supabase,
  legacyHandler,
  brain,
  sharedPipeline,
  dischargePipeline,
  issuerResolver,
  historyService,
  balanceReader,
  providerAvailability = async () => false,
  onboardingVoiceRequester = null,
} = {}) {
  if (typeof legacyHandler !== "function") {
    throw new TypeError(
      "KADI_V1_PRODUCTION_LEGACY_HANDLER_REQUIRED"
    );
  }

  if (typeof providerAvailability !== "function") {
    throw new TypeError(
      "KADI_V1_PRODUCTION_VOICE_AVAILABILITY_REQUIRED"
    );
  }

  const onboardingRepository =
    createSupabaseOnboardingRepository({
      client: supabase,
    });

  const documentRepository =
    createSupabaseV1DocumentRepository(supabase);

  const userContextService =
    createKadiV1UserContextService({
      client: supabase,
      onboardingRepository,
      documentRepository,
    });

  const onboardingOptions = {
    repository: onboardingRepository,
  };

  if (onboardingVoiceRequester != null) {
    onboardingOptions.voiceRequester =
      onboardingVoiceRequester;
  }

  const onboardingService =
    createKadiV1OnboardingService(onboardingOptions);

  const onboardingRuntime =
    createKadiV1OnboardingRuntimeAdapter({
      onboardingService,
    });

  const interpretationRuntime =
    createKadiV1InterpretationRuntimeAdapter({
      brain,
    });

  const documentRuntime =
    createKadiV1DocumentRuntimeAdapter({
      sharedPipeline,
      dischargePipeline,
      documentRepository,
      issuerResolver,
    });

  const historyRuntime =
    createKadiV1HistoryRuntimeAdapter({
      historyService,
    });

  const walletRuntime =
    createKadiV1WalletRuntimeAdapter({
      balanceReader,
    });

  const voicePolicyEngine =
    createVoicePolicyEngine({
      featureEnabled:
        config?.features?.voice === true,
    });

  const voicePolicy =
    createKadiV1VoicePolicyRuntimeAdapter({
      voicePolicyEngine,
      providerAvailability,
    });

  const orchestrator =
    createKadiV1ConversationOrchestrator({
      config,
      legacyHandler,
      userContextService,
      onboardingRuntime,
      interpretationRuntime,
      documentRuntime,
      historyRuntime,
      walletRuntime,
      voicePolicy,
    });

  return Object.freeze({
    orchestrator,
    userContextService,
    onboardingRepository,
    documentRepository,
    onboardingService,
    onboardingRuntime,
    interpretationRuntime,
    documentRuntime,
    historyRuntime,
    walletRuntime,
    voicePolicy,
    readiness: Object.freeze({
      ready: true,
      user_context_service: true,
      onboarding_runtime: true,
      interpretation_runtime: true,
      document_runtime: true,
      history_runtime: true,
      wallet_runtime: true,
      voice_policy_runtime: true,
      boot_external_calls: 0,
    }),
  });
}

module.exports = {
  createKadiV1ProductionOrchestratorComposition,
};
