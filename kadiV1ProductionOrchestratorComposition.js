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
  createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter,
} = require("./kadiV1ConversationalMultimodalRuntimeAdapter");
const {
  createConversationalObservabilityEmitter,
} = require("./kadiV1ConversationalMultimodalObservability");
const {
  isKadiV1ConversationalMultimodalOwnerAllowed,
} = require("./kadiV1CanaryIngress");
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
  conversationalMultimodalCanaryConfig = null,
  conversationalObservabilityLogger = null,
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

  const plainInterpretationRuntime =
    createKadiV1InterpretationRuntimeAdapter({
      brain,
    });

  // Only constructed when the caller (kadiV1ProductionBootstrap.js) passes
  // an active conversational-multimodal CANARY config — i.e. only when
  // config.features.conversationalMultimodalV1 is true. Otherwise this is
  // exactly the same plainInterpretationRuntime as before this integration,
  // byte-for-byte, for every owner. When active, the composite adapter
  // itself re-checks eligibility on every call and delegates to
  // plainInterpretationRuntime for any owner not on the separate
  // conversational allowlist — never inheriting general KADI_V1 CANARY
  // membership.
  //
  // The SAME gate function is also handed to the orchestrator directly
  // (conversationalEligibilityGate below) — it needs the identical
  // eligibility answer to decide whether its own deterministic
  // PREPARE_DOCUMENT short-circuit should defer to conversational
  // interpretation (see kadiV1ConversationOrchestrator.js's own comment on
  // the "PREPARE_DOCUMENT contradiction"). One function, two consumers,
  // never two independently-maintained eligibility checks.
  const conversationalEligibilityGate = conversationalMultimodalCanaryConfig
    ? (ownerWaId) => isKadiV1ConversationalMultimodalOwnerAllowed(conversationalMultimodalCanaryConfig, ownerWaId)
    : null;

  const interpretationRuntime = conversationalMultimodalCanaryConfig
    ? createKadiV1ConversationalMultimodalInterpretationRuntimeAdapter({
        brain,
        fallback: plainInterpretationRuntime,
        gate: conversationalEligibilityGate,
        // Optional and additive, exactly like kadiV1GeminiVisionProvider.js's
        // own safeEmitter(logger) — omitting it (the default) simply means no
        // events are emitted; it never affects eligibility or routing.
        logger: conversationalObservabilityLogger,
      })
    : plainInterpretationRuntime;

  // Built once here (the composition/DI root), never inside
  // kadiV1ConversationOrchestrator.js itself — that module only ever
  // receives an already-constructed (event, safeDetails) => void callback,
  // it never requires kadiV1ConversationalMultimodalObservability.js. This
  // is the ONLY event the orchestrator emits: "conversational_draft_applied",
  // and only once the corresponding backend port (documents.apply /
  // removeContent / changeDocumentType) has actually returned ok:true with
  // duplicate !== true — see kadiV1ConversationOrchestrator.js's
  // emitDraftApplied. `null` when observability is not wired (the default
  // for every deployment/test that doesn't pass conversationalObservabilityLogger),
  // matching the runtime adapter's own optional/additive logger pattern.
  const conversationalObservabilityEmit = conversationalObservabilityLogger
    ? createConversationalObservabilityEmitter(conversationalObservabilityLogger)
    : null;

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
      conversationalEligibilityGate,
      conversationalObservabilityEmit,
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
