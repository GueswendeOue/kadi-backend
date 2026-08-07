"use strict";

const { createKadiV1RuntimeConfig, parseBoolean } = require("./kadiV1RuntimeConfig");
const { createKadiV1ConversationalMultimodalCanaryConfig } = require("./kadiV1CanaryIngress");
const {
  createKadiV1ProductionComposition,
  inspectPorts,
} = require("./kadiV1ProductionComposition");
const { createOpenAIBrainProvider } = require("./kadiV1BrainProviders");
const { createKadiBrain } = require("./kadiV1Brain");
const {
  createGoogleGenerativeAIClientAdapter,
  createGeminiVisionProvider,
} = require("./kadiV1GeminiVisionProvider");
const {
  createInMemoryTemporaryAudioStore,
} = require("./kadiV1TemporaryAudioStore");
const {
  createInMemoryTemporaryMediaStore,
} = require("./kadiV1TemporaryMediaStore");
const {
  createAudioValidationService,
} = require("./kadiV1AudioValidationService");
const {
  createMediaValidationService,
} = require("./kadiV1MediaValidationService");
const {
  createOpenAISpeechToTextProvider,
  createSpeechToTextService,
} = require("./kadiV1SpeechToText");
const {
  createKadiV1ProductionMediaResolver,
} = require("./kadiV1ProductionMediaResolver");
const {
  createSupabaseV1DocumentRepository,
} = require("./kadiV1SupabaseDocumentRepository");
const {
  createSharedDocumentPipeline,
} = require("./kadiV1SharedDocumentPipeline");
const {
  createDischargePipeline,
} = require("./kadiV1DischargePipeline");
const {
  createSupabaseV1HistoryRepository,
} = require("./kadiV1SupabaseHistoryRepository");
const { createV1HistoryService } = require("./kadiV1HistoryService");
const {
  createSupabaseV1PreviewRepository,
} = require("./kadiV1SupabasePreviewRepository");
const { createPreviewService } = require("./kadiV1PreviewService");
const {
  createExistingPdfTemporaryRenderer,
  createPdfLibPageCountInspector,
  createTemporaryRenderService,
} = require("./kadiV1TemporaryRenderService");
const {
  createGenerationPricingPolicy,
} = require("./kadiV1GenerationPricingPolicy");
const {
  createGenerationQuoteService,
} = require("./kadiV1GenerationQuoteService");
const {
  createSupabaseGenerationLifecycleRepository,
} = require("./kadiV1SupabaseGenerationLifecycleRepository");
const {
  createWalletReservationService,
} = require("./kadiV1WalletReservationService");
const {
  createExistingPdfFinalRenderer,
  createFinalGenerationService,
} = require("./kadiV1FinalGenerationService");
const { createDeliveryService } = require("./kadiV1DeliveryService");
const {
  createGenerationLifecycleService,
} = require("./kadiV1GenerationLifecycleService");
const {
  createSupabaseRechargeRepository,
} = require("./kadiV1SupabaseRechargeRepository");
const {
  createRechargePackCatalog,
} = require("./kadiV1RechargeConfig");
const { createRechargeService } = require("./kadiV1RechargeService");
const {
  createSupabaseOnboardingRepository,
} = require("./kadiV1SupabaseOnboardingRepository");
const {
  createSupabaseOnboardingProfileCompleter,
} = require("./kadiV1SupabaseOnboardingProfileCompleter");
const { createKadiV1OnboardingService } = require("./kadiV1WelcomeService");
const {
  createKadiV1DocumentRuntimeAdapter,
  createKadiV1GenerationRuntimeAdapter,
  createKadiV1HistoryRuntimeAdapter,
  createKadiV1OnboardingRuntimeAdapter,
  createKadiV1PreviewRuntimeAdapter,
  createKadiV1WalletRuntimeAdapter,
} = require("./kadiV1RuntimeAdapters");
const { createKadiV1DeliveryRetryRuntime } = require("./kadiV1DeliveryRetryRuntime");
const {
  createKadiV1FlowCommandRuntime,
} = require("./kadiV1FlowCommandRuntime");
const {
  createKadiV1ProductionFlowReplyComposition,
} = require("./kadiV1ProductionFlowReplyComposition");
const {
  createKadiV1ProductionOrchestratorComposition,
} = require("./kadiV1ProductionOrchestratorComposition");
const {
  createKadiV1ProductionPresenter,
} = require("./kadiV1ProductionPresenter");
const {
  createKadiV1BalanceReader,
  createKadiV1IssuerLogoLoader,
  createKadiV1IssuerResolver,
  createKadiV1RechargeRuntime,
  createKadiV1WhatsAppDeliveryProvider,
  createManualOrangeMoneyPaymentProvider,
  createSupabasePrivateArtifactStorage,
} = require("./kadiV1ProductionInfrastructure");

const DOCUMENT_TYPES = Object.freeze(["FACTURE", "DEVIS", "RECU", "DECHARGE"]);
const DEFAULT_PACKS = Object.freeze([
  Object.freeze({
    pack_id: "PACK_1000",
    amount: 1000,
    currency: "XOF",
    credits: 10,
    pricing_version: "kadi-v1-2026-08",
    active: true,
  }),
  Object.freeze({
    pack_id: "PACK_2000",
    amount: 2000,
    currency: "XOF",
    credits: 25,
    pricing_version: "kadi-v1-2026-08",
    active: true,
  }),
  Object.freeze({
    pack_id: "PACK_5000",
    amount: 5000,
    currency: "XOF",
    credits: 70,
    pricing_version: "kadi-v1-2026-08",
    active: true,
  }),
]);

function safeErrorCode(error) {
  const candidate = String(error?.code || error?.message || "")
    .trim()
    .toUpperCase();
  return /^[A-Z][A-Z0-9_:.-]{2,119}$/.test(candidate)
    ? candidate
    : "KADI_V1_PRODUCTION_BOOTSTRAP_FAILED";
}

function integerEnv(env, name, fallback, minimum = 1) {
  const value = Number(env?.[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function numberEnv(env, name, fallback, minimum = 0) {
  const value = Number(env?.[name] ?? fallback);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function createPricingConfiguration(env) {
  const perPage = integerEnv(env, "KADI_V1_PDF_CREDITS_PER_PAGE", 1, 0);
  const base = integerEnv(env, "KADI_V1_PDF_BASE_CREDITS", 0, 0);
  const modality = Object.freeze({
    TEXT: integerEnv(env, "KADI_V1_TEXT_EXTRA_CREDITS", 0, 0),
    TRANSCRIPTION: integerEnv(env, "KADI_V1_TRANSCRIPTION_EXTRA_CREDITS", 1, 0),
    IMAGE: integerEnv(env, "KADI_V1_IMAGE_EXTRA_CREDITS", 1, 0),
    DOCUMENT: integerEnv(env, "KADI_V1_DOCUMENT_EXTRA_CREDITS", 1, 0),
  });
  return Object.freeze({
    pricingVersion: String(env?.KADI_V1_PRICING_VERSION || "kadi-v1-2026-08"),
    validitySeconds: integerEnv(env, "KADI_V1_QUOTE_TTL_SECONDS", 3600, 60),
    documentTypes: Object.freeze(Object.fromEntries(
      DOCUMENT_TYPES.map((type) => [type, Object.freeze({
        baseCost: base,
        perPageCost: perPage,
      })])
    )),
    modalityCosts: modality,
    optionCosts: Object.freeze({}),
  });
}

function createProviderAdapters({ env, adapters = null } = {}) {
  if (adapters && typeof adapters === "object") {
    for (const method of ["understandText", "transcribeAudio", "geminiClient"]) {
      if (!(method in adapters)) {
        throw new TypeError(`KADI_V1_PROVIDER_ADAPTER_REQUIRED:${method}`);
      }
    }
    if (
      typeof adapters.understandText !== "function" ||
      typeof adapters.transcribeAudio !== "function" ||
      !adapters.geminiClient ||
      typeof adapters.geminiClient.generateStructured !== "function"
    ) {
      throw new TypeError("KADI_V1_PROVIDER_ADAPTER_INVALID");
    }
    if (
      adapters.pdfRendererResolver != null &&
      typeof adapters.pdfRendererResolver !== "function"
    ) {
      throw new TypeError("KADI_V1_PDF_RENDERER_RESOLVER_INVALID");
    }
    return adapters;
  }

  if (!String(env?.OPENAI_API_KEY || "").trim()) {
    throw new TypeError("KADI_V1_OPENAI_API_KEY_REQUIRED");
  }
  if (!String(env?.GEMINI_API_KEY || "").trim()) {
    throw new TypeError("KADI_V1_GEMINI_API_KEY_REQUIRED");
  }

  const { parseNaturalWithOpenAI } = require("./kadiOpenAI");
  const { transcribeAudioBuffer } = require("./kadiAudio");
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  return Object.freeze({
    understandText: async (request) => parseNaturalWithOpenAI(
      request.text || request.transcription || "",
      {
        currentDocType: request.document_type_hint || null,
      }
    ),
    transcribeAudio: transcribeAudioBuffer,
    geminiClient: createGoogleGenerativeAIClientAdapter({ client: gemini }),
    pdfRendererResolver: null,
  });
}

// Bridges the already-injected structured `logger` into the (event,
// details) shape kadiV1GenerationLifecycleService.js's observer expects —
// mirrors the same bridging pattern already used for the conversational
// multimodal foundation's own observability logger. Before this, the
// service's default no-op observer meant every delivery_retry_* event
// (offered/requested/started/succeeded/failed/confirmation-required,
// stale-claim reconciled) was silently discarded in production, and a real
// incident had to be diagnosed from persisted database state alone,
// without any log trail. Every current emit() call in that module only
// ever passes `reason_code` (a closed-set internal string literal) or
// `duplicate` (boolean) — filtered again here, defensively, so a future
// emit() call can never introduce an unsafe field without an explicit,
// reviewed addition to this allowlist. Exported standalone (a pure
// function) so its filtering behavior can be unit-tested directly, without
// needing to boot the full production bootstrap.
const SAFE_LIFECYCLE_OBSERVER_KEYS = Object.freeze(["reason_code", "duplicate"]);
function createKadiV1GenerationLifecycleObserver(logger) {
  // kadiV1GenerationLifecycleService.js's real emit() — the only real
  // caller — invokes the observer with a single merged, frozen object
  // (`observer(Object.freeze({ event, ...details }))`), matching the
  // pre-existing observer contract already relied on elsewhere
  // (kadiV1GenerationLifecycle.test.js, kadiV1Recharge.test.js both use
  // `observer: (event) => ...` with the event's own name accessible as
  // `event.event`). A two-argument `(event, details)` signature here
  // would silently receive the whole merged object as `event` and an
  // always-empty `details`, making the allowlist filter below a dead
  // no-op — confirmed by merge-gate review before this fix existed.
  return function generationLifecycleObserver(payload) {
    const { event, ...details } = payload && typeof payload === "object" ? payload : {};
    const safeDetails = {};
    for (const key of SAFE_LIFECYCLE_OBSERVER_KEYS) {
      if (Object.hasOwn(details, key)) safeDetails[key] = details[key];
    }
    try {
      logger?.log?.(event, safeDetails);
    } catch {
      // Observability must never break the business outcome it is
      // describing.
    }
  };
}

function createBlockedBootstrap({ config, logger, error }) {
  const composition = createKadiV1ProductionComposition({
    config,
    logger,
  });
  const code = safeErrorCode(error);
  return Object.freeze({
    composition,
    webhookHandler: composition.webhookHandler,
    components: null,
    services: null,
    readiness: Object.freeze({
      ...composition.readiness,
      requested: true,
      ready: false,
      active: false,
      state: "BLOCKED",
      blocker: code,
      missing_capabilities: Object.freeze([code]),
      boot_external_calls: 0,
    }),
  });
}

function createKadiV1ProductionBootstrap({
  env = process.env,
  config = createKadiV1RuntimeConfig(env),
  supabase = null,
  whatsappApi = null,
  providerAdapters = null,
  logger = console,
  clock = () => new Date().toISOString(),
} = {}) {
  const requested = Boolean(
    config?.enabled === true &&
    config?.features?.webhook === true &&
    config?.rollout?.valid === true &&
    config?.rollout?.mode &&
    config.rollout.mode !== "OFF"
  );

  if (!requested) {
    const composition = createKadiV1ProductionComposition({ config, logger });
    return Object.freeze({
      composition,
      webhookHandler: composition.webhookHandler,
      components: null,
      services: null,
      readiness: Object.freeze({
        ...composition.readiness,
        boot_external_calls: 0,
      }),
    });
  }

  try {
    if (!supabase || typeof supabase.from !== "function" || typeof supabase.rpc !== "function") {
      throw new TypeError("KADI_V1_SUPABASE_CLIENT_REQUIRED");
    }
    for (const method of [
      "getMediaInfo",
      "downloadMediaToBuffer",
      "uploadMediaBuffer",
      "sendDocument",
      "sendFlow",
      "sendText",
    ]) {
      if (typeof whatsappApi?.[method] !== "function") {
        throw new TypeError(`KADI_V1_WHATSAPP_API_METHOD_REQUIRED:${method}`);
      }
    }

    const providers = createProviderAdapters({
      env,
      adapters: providerAdapters,
    });
    const temporaryAudioStore = createInMemoryTemporaryAudioStore({ clock });
    const temporaryMediaStore = createInMemoryTemporaryMediaStore({ clock });

    const audioValidationService = createAudioValidationService({
      temporaryAudioStore,
      config: {
        maxBytes: integerEnv(env, "KADI_V1_AUDIO_MAX_BYTES", 8 * 1024 * 1024),
        maxDurationSeconds: numberEnv(env, "KADI_V1_AUDIO_MAX_DURATION_SECONDS", 600, 1),
        retentionMs: integerEnv(env, "KADI_V1_AUDIO_RETENTION_MS", 15 * 60 * 1000),
      },
      clock,
    });
    const mediaValidationService = createMediaValidationService({
      temporaryMediaStore,
      config: {
        maxImageBytes: integerEnv(env, "KADI_V1_IMAGE_MAX_BYTES", 12 * 1024 * 1024),
        maxPdfBytes: integerEnv(env, "KADI_V1_PDF_MAX_BYTES", 20 * 1024 * 1024),
        maxPages: integerEnv(env, "KADI_V1_PDF_MAX_PAGES", 30),
        retentionMs: integerEnv(env, "KADI_V1_MEDIA_RETENTION_MS", 15 * 60 * 1000),
      },
      clock,
    });

    const sttProvider = createOpenAISpeechToTextProvider({
      transcribe: providers.transcribeAudio,
      model: String(env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1"),
    });
    const speechToTextService = createSpeechToTextService({
      temporaryAudioStore,
      primaryProvider: sttProvider,
      policy: "PRIMARY_ONLY",
      minimumConfidence: numberEnv(env, "KADI_V1_TRANSCRIPTION_MIN_CONFIDENCE", 0.7, 0),
    });

    const openAIProvider = createOpenAIBrainProvider({
      understand: providers.understandText,
    });
    const geminiProvider = createGeminiVisionProvider({
      client: providers.geminiClient,
      temporaryMediaStore,
      config: {
        enabled: config.features.vision === true,
        model: String(env.KADI_V1_GEMINI_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash"),
        timeoutMs: integerEnv(env, "KADI_V1_GEMINI_TIMEOUT_MS", 30000),
        maxRetries: integerEnv(env, "KADI_V1_GEMINI_MAX_RETRIES", 1, 0),
        temperature: numberEnv(env, "KADI_V1_GEMINI_TEMPERATURE", 0, 0),
        policy: "GEMINI_PRIMARY_ONLY",
        minimumConfidence: numberEnv(env, "KADI_V1_VISION_MIN_CONFIDENCE", 0.7, 0),
        maxImageBytes: integerEnv(env, "KADI_V1_IMAGE_MAX_BYTES", 12 * 1024 * 1024),
        maxPdfBytes: integerEnv(env, "KADI_V1_PDF_MAX_BYTES", 20 * 1024 * 1024),
        maxPages: integerEnv(env, "KADI_V1_PDF_MAX_PAGES", 30),
      },
    });
    const brain = createKadiBrain({
      providers: { openAIProvider, geminiProvider },
      primaryByModality: {
        TEXT: "OPENAI",
        TRANSCRIPTION: "OPENAI",
        IMAGE: "GEMINI",
        DOCUMENT: "GEMINI",
      },
      policy: "PRIMARY_ONLY",
      minimumConfidence: numberEnv(env, "KADI_V1_BRAIN_MIN_CONFIDENCE", 0.6, 0),
    });

    const documentRepository = createSupabaseV1DocumentRepository(supabase);
    const sharedPipeline = createSharedDocumentPipeline({
      repository: documentRepository,
    });
    const dischargePipeline = createDischargePipeline({
      repository: documentRepository,
    });
    const issuerResolver = createKadiV1IssuerResolver({ client: supabase });
    // Reuses the exact buckets the legacy profile upload paths already
    // write business_profiles.logo_path into — never a separate
    // KADI_V1_-prefixed bucket. "logos" (store.js) is the current, actively
    // written bucket and is tried first; "kadi-logos" (supabaseStorage.js)
    // is the legacy bucket some existing rows may still point into.
    const logoLoader = createKadiV1IssuerLogoLoader({
      client: supabase,
      buckets: [
        env.SUPABASE_LOGO_BUCKET || "logos",
        env.SUPABASE_BUCKET_LOGOS || "kadi-logos",
      ],
      logger,
    });

    const historyRepository = createSupabaseV1HistoryRepository(supabase);
    const historyService = createV1HistoryService({
      historyRepository,
      documentRepository,
      clock,
    });

    const rechargeRepository = createSupabaseRechargeRepository(supabase);
    const balanceReader = createKadiV1BalanceReader({ rechargeRepository });

    const privateStorage = createSupabasePrivateArtifactStorage({
      client: supabase,
      bucket: env.KADI_V1_PRIVATE_BUCKET,
      privateBucketConfirmed: parseBoolean(
        env.KADI_V1_PRIVATE_BUCKET_CONFIRMED,
        false
      ),
    });

    const previewRepository = createSupabaseV1PreviewRepository(supabase);
    const previewService = createPreviewService({
      documentRepository,
      previewRepository,
      clock,
    });
    const temporaryRenderService = createTemporaryRenderService({
      previewRepository,
      storage: privateStorage,
      renderer: createExistingPdfTemporaryRenderer({
        rendererResolver: providers.pdfRendererResolver || null,
        issuerProfileReader: issuerResolver,
        logoLoader,
      }),
      pageCountInspector: createPdfLibPageCountInspector({ clock }),
      clock,
      lifetimeSeconds: integerEnv(env, "KADI_V1_RENDER_TTL_SECONDS", 3600, 60),
    });
    const pricingPolicy = createGenerationPricingPolicy(
      createPricingConfiguration(env),
      { clock }
    );
    const quoteService = createGenerationQuoteService({
      documentRepository,
      previewRepository,
      pricingPolicy,
      clock,
      defaultLifetimeSeconds: integerEnv(env, "KADI_V1_QUOTE_TTL_SECONDS", 3600, 60),
    });

    const generationRepository = createSupabaseGenerationLifecycleRepository(supabase);
    const walletReservationService = createWalletReservationService({
      repository: generationRepository,
      clock,
    });
    const finalGenerationService = createFinalGenerationService({
      repository: generationRepository,
      storage: privateStorage,
      renderer: createExistingPdfFinalRenderer({
        rendererResolver: providers.pdfRendererResolver || null,
        issuerProfileReader: issuerResolver,
        logoLoader,
      }),
      clock,
    });
    const deliveryProvider = createKadiV1WhatsAppDeliveryProvider({
      client: supabase,
      storage: privateStorage,
      whatsappApi,
    });
    const deliveryService = createDeliveryService({
      repository: generationRepository,
      provider: deliveryProvider,
      clock,
    });
    // Bridges the already-injected structured `logger` into the
    // (event, details) shape kadiV1GenerationLifecycleService.js's
    // observer expects — mirrors the same bridging pattern already used
    // above for conversationalObservabilityLogger. Before this, the
    // service's own default no-op observer meant every delivery_retry_*
    // event (offered/requested/started/succeeded/failed/confirmation
    // required, stale-claim reconciled) was silently discarded, and a real
    // production incident had to be diagnosed from persisted database
    // state alone instead of logs. Every current emit() call in that
    // module only ever passes `reason_code` (a closed-set internal string
    // literal) or `duplicate` (boolean) — filtered again here, defensively,
    // so a future emit() call can never introduce an unsafe field without
    // an explicit, reviewed addition to this allowlist.
    const generationLifecycleService = createGenerationLifecycleService({
      documentRepository,
      previewRepository,
      generationRepository,
      quoteService,
      walletReservationService,
      finalGenerationService,
      deliveryService,
      clock,
      observer: createKadiV1GenerationLifecycleObserver(logger),
    });

    const paymentProvider = createManualOrangeMoneyPaymentProvider({
      client: supabase,
      clock,
    });
    const packCatalog = createRechargePackCatalog({ packs: DEFAULT_PACKS });
    const rechargeService = createRechargeService({
      repository: rechargeRepository,
      packCatalog,
      paymentProvider,
      documentRepository,
      quoteService,
      generationLifecycleService,
      resumePolicy: "REQUIRE_CONFIRMATION",
      latePaymentPolicy: "REJECT",
      clock,
    });
    const rechargeRuntime = createKadiV1RechargeRuntime({
      rechargeService,
      rechargeRepository,
      paymentProvider,
      client: supabase,
      orangeMoneyNumber: env.OM_NUMBER,
      orangeMoneyName: env.OM_NAME,
    });

    const onboardingRepository = createSupabaseOnboardingRepository({
      client: supabase,
    });
    const onboardingService = createKadiV1OnboardingService({
      repository: onboardingRepository,
    });
    const onboardingProfileCompleter =
      createSupabaseOnboardingProfileCompleter({
        client: supabase,
      });
    const onboardingRuntime = createKadiV1OnboardingRuntimeAdapter({
      onboardingService,
      profileCompleter: onboardingProfileCompleter,
    });
    const documentRuntime = createKadiV1DocumentRuntimeAdapter({
      sharedPipeline,
      dischargePipeline,
      documentRepository,
      issuerResolver,
    });
    const historyRuntime = createKadiV1HistoryRuntimeAdapter({ historyService });
    const walletRuntime = createKadiV1WalletRuntimeAdapter({ balanceReader });
    const previewRuntime = createKadiV1PreviewRuntimeAdapter({
      previewService,
      temporaryRenderService,
      generationQuoteService: quoteService,
    });
    const generationRuntime = createKadiV1GenerationRuntimeAdapter({
      generationLifecycleService,
    });
    const deliveryRetryRuntime = createKadiV1DeliveryRetryRuntime({
      generationRuntime,
    });
    const commandRuntime = createKadiV1FlowCommandRuntime({
      onboardingRuntime,
      documentRuntime,
      previewRuntime,
      generationRuntime,
      rechargeRuntime,
      historyRuntime,
      walletRuntime,
    });

    // Only computed when the flag is on: reading a stray
    // KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS while the feature is
    // disabled must have zero effect, matching every other KADI_V1_* flag.
    // A malformed or empty allowlist never fails startup — it just means
    // nobody is eligible (see kadiV1ConversationalMultimodalRuntimeAdapter.js:
    // isKadiV1ConversationalMultimodalOwnerAllowed already treats
    // `valid !== true` as "deny"), which is the correct fail-closed behavior
    // for a narrow, currently-unused feature. Crashing the entire V1 webhook
    // — and every unrelated CANARY user with it — over this feature's own
    // misconfiguration would be disproportionate; the resulting state is
    // still surfaced below in readiness diagnostics.
    const conversationalMultimodalCanaryConfig = config.features.conversationalMultimodalV1
      ? createKadiV1ConversationalMultimodalCanaryConfig(env)
      : null;

    // Bridges the already-injected structured `logger` into the closed
    // (event, safeDetails) shape kadiV1ConversationalMultimodalObservability.js
    // expects — this module never constructs its own logging destination.
    // Only wired when the feature itself is active, mirroring
    // conversationalMultimodalCanaryConfig above; the emitter already
    // guarantees `safeDetails` contains nothing beyond its closed allowlist,
    // so this is safe to route to the same operational log as everything
    // else. No dashboard or persistence is added here — a future
    // KADI_ADMIN_AI_OBSERVABILITY_V1 mission is expected to consume these
    // events.
    const conversationalObservabilityLogger = config.features.conversationalMultimodalV1
      ? (event, safeDetails) => logger?.log?.(event, safeDetails)
      : null;

    const orchestratorComposition = createKadiV1ProductionOrchestratorComposition({
      config,
      supabase,
      legacyHandler: async () => ({
        ok: false,
        error: "KADI_V1_INTERNAL_LEGACY_BOUNDARY_DISABLED",
      }),
      brain,
      sharedPipeline,
      dischargePipeline,
      issuerResolver,
      historyService,
      balanceReader,
      providerAvailability: async () => false,
      conversationalMultimodalCanaryConfig,
      conversationalObservabilityLogger,
    });
    const flowReplyComposition = createKadiV1ProductionFlowReplyComposition({
      supabase,
      commandRuntime,
    });
    const mediaResolver = createKadiV1ProductionMediaResolver({
      whatsappApi,
      audioValidationService,
      speechToTextService,
      mediaValidationService,
    });
    const presenter = createKadiV1ProductionPresenter({
      config,
      supabase,
      whatsappApi,
      flowMode: String(env.KADI_V1_FLOW_MODE || "published").toLowerCase(),
      logger,
      issuerProfileReader: issuerResolver,
    });

    const components = Object.freeze({
      orchestrator: orchestratorComposition.orchestrator,
      flowReplyRuntime: flowReplyComposition.flowReplyRuntime,
      mediaResolver,
      presenter,
      deliveryRetryRuntime,
    });
    const ports = inspectPorts(components);
    if (!ports.ready) {
      throw new TypeError("KADI_V1_PRODUCTION_PORTS_INCOMPLETE");
    }

    const composition = createKadiV1ProductionComposition({
      config,
      components,
      logger,
    });
    if (composition.readiness.ready !== true) {
      throw new TypeError("KADI_V1_PRODUCTION_COMPOSITION_NOT_READY");
    }

    return Object.freeze({
      composition,
      webhookHandler: composition.webhookHandler,
      components,
      services: Object.freeze({
        brain,
        audioValidationService,
        speechToTextService,
        mediaValidationService,
        documentRepository,
        sharedPipeline,
        dischargePipeline,
        historyService,
        privateStorage,
        previewService,
        temporaryRenderService,
        quoteService,
        generationLifecycleService,
        rechargeService,
        commandRuntime,
      }),
      readiness: Object.freeze({
        ...composition.readiness,
        provider_routes: Object.freeze({
          text: "OPENAI",
          transcription: "OPENAI_STT",
          image: "GEMINI",
          document: "GEMINI",
          voice: "TEXT_ONLY_UNTIL_VOICE_DELIVERY_CONFIGURED",
        }),
        private_storage: true,
        generation: true,
        recharge: true,
        history: true,
        // Safe presence/state only — never the allowlist itself, never a
        // WhatsApp identifier. ownerCount is a count, not an identifier.
        conversational_multimodal_v1: Object.freeze({
          enabled: config.features.conversationalMultimodalV1 === true,
          canary_allowlist_valid: conversationalMultimodalCanaryConfig?.valid ?? null,
          canary_owner_count: conversationalMultimodalCanaryConfig?.ownerCount ?? 0,
          gemini_audio_enabled: config.features.geminiAudioV1 === true,
          wired_into_orchestrator: conversationalMultimodalCanaryConfig != null,
        }),
        boot_external_calls: 0,
      }),
    });
  } catch (error) {
    try {
      logger?.warn?.("KADI_V1_PRODUCTION_BOOTSTRAP_BLOCKED", {
        reason: safeErrorCode(error),
      });
    } catch {
      // Logging cannot alter boot behavior.
    }
    return createBlockedBootstrap({ config, logger, error });
  }
}

function inspectKadiV1ProductionBootstrap({
  env = process.env,
  config = createKadiV1RuntimeConfig(env),
  supabase = null,
  whatsappApi = null,
  providerAdapters = null,
  logger = { warn() {}, log() {} },
} = {}) {
  if (!config.enabled || !config.features.webhook || config.rollout?.mode === "OFF") {
    return Object.freeze({
      ready: true,
      missing_capabilities: Object.freeze([]),
      readiness: Object.freeze({
        requested: false,
        ready: true,
        active: false,
        state: "DISABLED",
      }),
    });
  }

  let resolvedSupabase = supabase;
  let resolvedWhatsappApi = whatsappApi;
  try {
    if (!resolvedSupabase) {
      ({ supabase: resolvedSupabase } = require("./supabaseClient"));
    }
    if (!resolvedWhatsappApi) {
      resolvedWhatsappApi = require("./whatsappApi");
    }
  } catch (error) {
    const code = safeErrorCode(error);
    return Object.freeze({
      ready: false,
      missing_capabilities: Object.freeze([code]),
      readiness: Object.freeze({
        requested: true,
        ready: false,
        active: false,
        state: "BLOCKED",
        blocker: code,
      }),
    });
  }

  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: resolvedSupabase,
    whatsappApi: resolvedWhatsappApi,
    providerAdapters,
    logger,
  });
  return Object.freeze({
    ready: bootstrap.readiness.ready === true,
    missing_capabilities: Object.freeze([
      ...(bootstrap.readiness.missing_capabilities || []),
    ]),
    readiness: bootstrap.readiness,
  });
}

module.exports = {
  DEFAULT_PACKS,
  createKadiV1GenerationLifecycleObserver,
  createKadiV1ProductionBootstrap,
  createPricingConfiguration,
  inspectKadiV1ProductionBootstrap,
  safeErrorCode,
};
