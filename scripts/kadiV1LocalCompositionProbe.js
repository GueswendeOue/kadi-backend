"use strict";

const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const {
  createKadiV1ProductionComposition,
  inspectKadiV1ProductionCapabilities,
} = require("../kadiV1ProductionComposition");

const CANARY = "22670626055";
const NON_CANARY = "22670000000";

const config = createKadiV1RuntimeConfig({
  KADI_V1_ENABLED: "true",
  KADI_V1_WEBHOOK_ENABLED: "true",
  KADI_V1_ROLLOUT_MODE: "CANARY",
  KADI_V1_CANARY_WA_IDS: CANARY,
});

const calls = {
  orchestrator: 0,
  presenter: 0,
  flow_reply: 0,
  media: 0,
  external: 0,
};

const composition = createKadiV1ProductionComposition({
  config,
  logger: { log() {}, warn() {} },
  components: {
    orchestrator: {
      handle: async () => {
        calls.orchestrator += 1;
        return {
          handled: true,
          canonical_text: "Réponse locale de contrôle.",
          business_action: "LOCAL_COMPOSITION_PROBE",
        };
      },
    },
    flowReplyRuntime: {
      handle: async () => {
        calls.flow_reply += 1;
        return { ok: true, value: { handled: true, duplicate: false } };
      },
    },
    mediaResolver: {
      resolveAudio: async () => {
        calls.media += 1;
        return { ok: false, error: "NOT_USED" };
      },
      resolveImage: async () => {
        calls.media += 1;
        return { ok: false, error: "NOT_USED" };
      },
      resolvePdf: async () => {
        calls.media += 1;
        return { ok: false, error: "NOT_USED" };
      },
    },
    presenter: {
      presentConversation: async () => {
        calls.presenter += 1;
      },
      presentFlowReply: async () => {
        calls.presenter += 1;
      },
      presentRecoverableError: async () => {
        calls.presenter += 1;
      },
    },
  },
});

async function main() {
  const canary = await composition.webhookHandler({
    messages: [{
      id: "wamid:local-canary-probe",
      from: CANARY,
      type: "text",
      text: { body: "Prépare une facture" },
    }],
  });

  const nonCanary = await composition.webhookHandler({
    messages: [{
      id: "wamid:local-non-canary-probe",
      from: NON_CANARY,
      type: "text",
      text: { body: "Prépare une facture" },
    }],
  });

  const production = inspectKadiV1ProductionCapabilities();

  console.log("MODE=KADI_V1_LOCAL_COMPOSITION_BOOT_PROBE");
  console.log(`COMPOSITION_READY_WITH_TEST_PORTS=${composition.readiness.ready}`);
  console.log(`CANARY_HANDLED=${canary.handled === true && canary.results?.[0]?.accepted === true}`);
  console.log(`NON_CANARY_DENIED_BY_V1=${nonCanary.handled === false}`);
  console.log(`ORCHESTRATOR_CALLS=${calls.orchestrator}`);
  console.log(`PRESENTER_CALLS=${calls.presenter}`);
  console.log(`FLOW_REPLY_CALLS=${calls.flow_reply}`);
  console.log(`MEDIA_CALLS=${calls.media}`);
  console.log(`EXTERNAL_CALLS=${calls.external}`);
  console.log(`PRODUCTION_CAPABILITIES_READY=${production.ready}`);
  console.log(`PRODUCTION_MISSING_CAPABILITY_COUNT=${production.missing_capabilities.length}`);

  const pass =
    composition.readiness.ready === true &&
    canary.handled === true &&
    canary.results?.[0]?.accepted === true &&
    nonCanary.handled === false &&
    calls.orchestrator === 1 &&
    calls.presenter === 1 &&
    calls.flow_reply === 0 &&
    calls.media === 0 &&
    calls.external === 0 &&
    production.ready === false;

  console.log(`VERDICT=${pass
    ? "KADI_V1_LOCAL_COMPOSITION_BOOT_PROBE_PASS"
    : "KADI_V1_LOCAL_COMPOSITION_BOOT_PROBE_FAILED"}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error(`ERROR=${String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 500)}`);
  console.error("EXTERNAL_CALLS=0");
  console.error("VERDICT=KADI_V1_LOCAL_COMPOSITION_BOOT_PROBE_FAILED");
  process.exitCode = 1;
});
