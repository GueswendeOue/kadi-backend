"use strict";

const { createKadiV1WebhookRuntime } = require("./kadiV1WebhookRuntime");
const { createKadiV1ProductionFlowReplyComposition } = require("./kadiV1ProductionFlowReplyComposition");
const {
  createKadiV1ProductionOrchestratorComposition,
} = require("./kadiV1ProductionOrchestratorComposition");
const {
  createKadiV1ProductionMediaResolver,
} = require("./kadiV1ProductionMediaResolver");
const {
  createKadiV1ProductionPresenter,
} = require("./kadiV1ProductionPresenter");

const REQUIRED_PORTS = Object.freeze({
  orchestrator: Object.freeze(["handle"]),
  flowReplyRuntime: Object.freeze(["handle"]),
  mediaResolver: Object.freeze(["resolveAudio", "resolveImage", "resolvePdf"]),
  presenter: Object.freeze([
    "presentConversation",
    "presentFlowReply",
    "presentRecoverableError",
  ]),
});

const CURRENT_PRODUCTION_CAPABILITIES = Object.freeze({
  orchestrator: true,
  flowReplyRuntime: true,
  mediaResolver: true,
  presenter: true,
  persistentConversationSessionRepository: true,
});

function freezeReadiness(value) {
  return Object.freeze({
    ...value,
    required_ports: Object.freeze({ ...value.required_ports }),
    missing_ports: Object.freeze([...(value.missing_ports || [])]),
    missing_capabilities: Object.freeze([...(value.missing_capabilities || [])]),
  });
}

function validateConfig(config) {
  if (!config || typeof config.enabled !== "boolean" || !config.features) {
    throw new TypeError("KADI_V1_RUNTIME_CONFIG_REQUIRED");
  }
  return config;
}

function inspectPorts(components) {
  const requiredPorts = {};
  const missingPorts = [];

  for (const [name, methods] of Object.entries(REQUIRED_PORTS)) {
    const target = components?.[name];
    const ready = Boolean(
      target &&
      typeof target === "object" &&
      methods.every((method) => typeof target[method] === "function")
    );
    requiredPorts[name] = ready;
    if (!ready) missingPorts.push(name);
  }

  return Object.freeze({
    ready: missingPorts.length === 0,
    required_ports: Object.freeze(requiredPorts),
    missing_ports: Object.freeze(missingPorts),
  });
}

function inspectKadiV1ProductionCapabilities() {
  const missing = Object.entries(CURRENT_PRODUCTION_CAPABILITIES)
    .filter(([, ready]) => ready !== true)
    .map(([name]) => name);

  return Object.freeze({
    ready: missing.length === 0,
    capabilities: CURRENT_PRODUCTION_CAPABILITIES,
    missing_capabilities: Object.freeze(missing),
  });
}

function createBlockedHandler(reason) {
  return async () => Object.freeze({
    handled: false,
    reason,
  });
}

function requestedByConfig(config) {
  return Boolean(
    config.enabled &&
    config.features.webhook === true &&
    config.rollout?.valid === true &&
    config.rollout?.mode &&
    config.rollout.mode !== "OFF"
  );
}

function createKadiV1ProductionComposition({
  config,
  components = null,
  dependencies = null,
  logger = console,
} = {}) {
  validateConfig(config);

  const requested = requestedByConfig(config);

  if (!requested) {
    const runtime = createKadiV1WebhookRuntime({ config });
    return Object.freeze({
      webhookHandler: runtime.handleIncomingValue,
      readiness: freezeReadiness({
        requested: false,
        ready: true,
        active: false,
        state: "DISABLED",
        rollout_mode: config.rollout?.mode || "OFF",
        blocker: null,
        required_ports: Object.fromEntries(
          Object.keys(REQUIRED_PORTS).map((name) => [name, false])
        ),
        missing_ports: [],
        missing_capabilities: [],
      }),
      components: null,
    });
  }

  const resolvedComponents = { ...(components && typeof components === "object" ? components : {}) };
  if (
    !resolvedComponents.orchestrator &&
    dependencies?.supabase &&
    typeof dependencies?.legacyHandler === "function" &&
    dependencies?.brain &&
    dependencies?.sharedPipeline &&
    dependencies?.dischargePipeline &&
    dependencies?.issuerResolver &&
    dependencies?.historyService &&
    dependencies?.balanceReader
  ) {
    const orchestratorComposition =
      createKadiV1ProductionOrchestratorComposition({
        config,
        supabase: dependencies.supabase,
        legacyHandler: dependencies.legacyHandler,
        brain: dependencies.brain,
        sharedPipeline: dependencies.sharedPipeline,
        dischargePipeline: dependencies.dischargePipeline,
        issuerResolver: dependencies.issuerResolver,
        historyService: dependencies.historyService,
        balanceReader: dependencies.balanceReader,
        providerAvailability:
          dependencies.providerAvailability,
        onboardingVoiceRequester:
          dependencies.onboardingVoiceRequester,
      });

    resolvedComponents.orchestrator =
      orchestratorComposition.orchestrator;
  }

  if (
    !resolvedComponents.mediaResolver &&
    dependencies?.whatsappApi &&
    dependencies?.audioValidationService &&
    dependencies?.speechToTextService &&
    dependencies?.mediaValidationService
  ) {
    resolvedComponents.mediaResolver =
      createKadiV1ProductionMediaResolver({
        whatsappApi: dependencies.whatsappApi,
        audioValidationService:
          dependencies.audioValidationService,
        speechToTextService:
          dependencies.speechToTextService,
        mediaValidationService:
          dependencies.mediaValidationService,
      });
  }

  if (
    !resolvedComponents.presenter &&
    dependencies?.supabase &&
    dependencies?.whatsappApi
  ) {
    resolvedComponents.presenter =
      createKadiV1ProductionPresenter({
        config,
        supabase: dependencies.supabase,
        whatsappApi: dependencies.whatsappApi,
        flowMode: dependencies.flowMode || "draft",
        sessionTtlMs: dependencies.sessionTtlMs,
        clock: dependencies.clock,
        sessionIdFactory: dependencies.sessionIdFactory,
        voiceResponseEngine:
          dependencies.voiceResponseEngine || null,
        voiceDelivery: dependencies.voiceDelivery || null,
        logger,
      });
  }

  if (!resolvedComponents.flowReplyRuntime && dependencies?.supabase && dependencies?.commandRuntime) {
    resolvedComponents.flowReplyRuntime = createKadiV1ProductionFlowReplyComposition({ supabase: dependencies.supabase, commandRuntime: dependencies.commandRuntime, ttlMs: dependencies.sessionTtlMs, clock: dependencies.clock, idFactory: dependencies.sessionIdFactory }).flowReplyRuntime;
  }
  const inspected = inspectPorts(resolvedComponents);

  if (!inspected.ready) {
    try {
      logger?.warn?.("KADI_V1_PRODUCTION_COMPOSITION_BLOCKED", Object.freeze({
        rollout_mode: config.rollout?.mode || null,
        missing_ports: inspected.missing_ports,
      }));
    } catch {
      // Readiness logging must never change routing behavior.
    }

    return Object.freeze({
      webhookHandler: createBlockedHandler("KADI_V1_PRODUCTION_COMPOSITION_BLOCKED"),
      readiness: freezeReadiness({
        requested: true,
        ready: false,
        active: false,
        state: "BLOCKED",
        rollout_mode: config.rollout?.mode || null,
        blocker: "KADI_V1_PRODUCTION_COMPOSITION_BLOCKED",
        required_ports: inspected.required_ports,
        missing_ports: inspected.missing_ports,
        missing_capabilities:
          inspectKadiV1ProductionCapabilities().missing_capabilities,
      }),
      components: null,
    });
  }

  const runtime = createKadiV1WebhookRuntime({
    config,
    orchestrator: resolvedComponents.orchestrator,
    flowReplyRuntime: resolvedComponents.flowReplyRuntime,
    mediaResolver: resolvedComponents.mediaResolver,
    presenter: resolvedComponents.presenter,
    logger,
  });

  return Object.freeze({
    webhookHandler: runtime.handleIncomingValue,
    readiness: freezeReadiness({
      requested: true,
      ready: true,
      active: true,
      state: "READY",
      rollout_mode: config.rollout?.mode || null,
      blocker: null,
      required_ports: inspected.required_ports,
      missing_ports: [],
      missing_capabilities: [],
    }),
    components: Object.freeze({
      orchestrator: resolvedComponents.orchestrator,
      flowReplyRuntime: resolvedComponents.flowReplyRuntime,
      mediaResolver: resolvedComponents.mediaResolver,
      presenter: resolvedComponents.presenter,
    }),
  });
}

module.exports = {
  CURRENT_PRODUCTION_CAPABILITIES,
  REQUIRED_PORTS,
  createKadiV1ProductionComposition,
  inspectKadiV1ProductionCapabilities,
  inspectPorts,
};
