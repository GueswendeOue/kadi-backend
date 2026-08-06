"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const {
  createKadiV1ProductionComposition,
  inspectKadiV1ProductionCapabilities,
} = require("../kadiV1ProductionComposition");

const CANARY = "22670626055";
const NON_CANARY = "22670000000";

function config(overrides = {}) {
  return createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: CANARY,
    ...overrides,
  });
}

function completeComponents(calls) {
  return {
    orchestrator: {
      handle: async (input) => {
        calls.orchestrator += 1;
        return {
          handled: true,
          canonical_text: `Réponse locale pour ${input.ownerWaId}`,
          business_action: "LOCAL_TEST",
        };
      },
    },
    flowReplyRuntime: {
      handle: async () => {
        calls.flowReply += 1;
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
        calls.presentConversation += 1;
      },
      presentFlowReply: async () => {
        calls.presentFlowReply += 1;
      },
      presentRecoverableError: async () => {
        calls.presentRecoverableError += 1;
      },
    },
  };
}

test("OFF mode remains bootable without inspecting production ports", async () => {
  const offConfig = createKadiV1RuntimeConfig({
    KADI_V1_ENABLED: "false",
    KADI_V1_WEBHOOK_ENABLED: "false",
    KADI_V1_ROLLOUT_MODE: "OFF",
  });

  const composition = createKadiV1ProductionComposition({
    config: offConfig,
    components: new Proxy({}, {
      get() {
        throw new Error("OFF_MODE_MUST_NOT_INSPECT_COMPONENTS");
      },
    }),
  });

  assert.equal(composition.readiness.ready, true);
  assert.equal(composition.readiness.active, false);
  assert.equal(composition.readiness.state, "DISABLED");

  const result = await composition.webhookHandler({
    messages: [{ id: "wamid:off", from: CANARY, type: "text", text: { body: "bonjour" } }],
  });
  assert.equal(result.handled, false);
});

test("requested canary is blocked without complete production ports but the process does not crash", async () => {
  const warnings = [];
  const composition = createKadiV1ProductionComposition({
    config: config(),
    logger: { warn: (...args) => warnings.push(args) },
  });

  assert.equal(composition.readiness.requested, true);
  assert.equal(composition.readiness.ready, false);
  assert.equal(composition.readiness.active, false);
  assert.equal(composition.readiness.state, "BLOCKED");
  assert.deepEqual(
    composition.readiness.missing_ports,
    ["orchestrator", "flowReplyRuntime", "mediaResolver", "presenter"]
  );
  assert.equal(warnings.length, 1);

  const result = await composition.webhookHandler({
    messages: [{ id: "wamid:blocked", from: CANARY, type: "text", text: { body: "bonjour" } }],
  });
  assert.deepEqual(result, {
    handled: false,
    terminal: true,
    blocked_owner_in_rollout: true,
    reason: "KADI_V1_PRODUCTION_COMPOSITION_BLOCKED",
  });

  const nonCanary = await composition.webhookHandler({
    messages: [{
      id: "wamid:blocked:legacy",
      from: NON_CANARY,
      type: "text",
      text: { body: "bonjour" },
    }],
  });
  assert.deepEqual(nonCanary, {
    handled: false,
    terminal: false,
    blocked_owner_in_rollout: false,
    reason: "KADI_V1_PRODUCTION_COMPOSITION_BLOCKED",
  });
});

test("complete injected composition handles the authorized canary once", async () => {
  const calls = {
    orchestrator: 0,
    flowReply: 0,
    media: 0,
    presentConversation: 0,
    presentFlowReply: 0,
    presentRecoverableError: 0,
  };

  const composition = createKadiV1ProductionComposition({
    config: config(),
    components: completeComponents(calls),
    logger: { log() {}, warn() {} },
  });

  assert.equal(composition.readiness.ready, true);
  assert.equal(composition.readiness.active, true);
  assert.equal(composition.readiness.state, "READY");

  const result = await composition.webhookHandler({
    messages: [{
      id: "wamid:canary",
      from: CANARY,
      type: "text",
      text: { body: "Prépare une facture" },
    }],
  });

  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true);
  assert.equal(calls.orchestrator, 1);
  assert.equal(calls.presentConversation, 1);
  assert.equal(calls.flowReply, 0);
  assert.equal(calls.media, 0);
  assert.equal(calls.presentRecoverableError, 0);
});

test("complete injected composition refuses V1 for a non-canary owner", async () => {
  const calls = {
    orchestrator: 0,
    flowReply: 0,
    media: 0,
    presentConversation: 0,
    presentFlowReply: 0,
    presentRecoverableError: 0,
  };

  const composition = createKadiV1ProductionComposition({
    config: config(),
    components: completeComponents(calls),
    logger: { log() {}, warn() {} },
  });

  const result = await composition.webhookHandler({
    messages: [{
      id: "wamid:non-canary",
      from: NON_CANARY,
      type: "text",
      text: { body: "Prépare une facture" },
    }],
  });

  assert.equal(result.handled, false);
  assert.equal(result.results[0].reason, "KADI_V1_OWNER_NOT_IN_ROLLOUT");
  assert.equal(calls.orchestrator, 0);
  assert.equal(calls.presentConversation, 0);
});

test("production capability inspection fails closed without the real boot composition", () => {
  const report = inspectKadiV1ProductionCapabilities();
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing_capabilities, [
    "orchestrator",
    "flowReplyRuntime",
    "mediaResolver",
    "presenter",
  ]);
});

test("production capability inspection accepts only a real READY readiness report", () => {
  const report = inspectKadiV1ProductionCapabilities({
    readiness: {
      ready: true,
      active: true,
      state: "READY",
      required_ports: {
        orchestrator: true,
        flowReplyRuntime: true,
        mediaResolver: true,
        presenter: true,
      },
      missing_ports: [],
      missing_capabilities: [],
    },
  });
  assert.equal(report.ready, true);
  assert.deepEqual(report.missing_capabilities, []);
});


test("production composition can derive the orchestrator without boot I/O", () => {
  let externalCalls = 0;
  const noop = async () => ({ ok: true, value: {} });

  const composition = createKadiV1ProductionComposition({
    config: config(),
    components: {
      flowReplyRuntime: {
        async handle() {
          return { ok: true, value: {} };
        },
      },
      mediaResolver: {
        async resolveAudio() {
          return { ok: false, error: "NOT_USED" };
        },
        async resolveImage() {
          return { ok: false, error: "NOT_USED" };
        },
        async resolvePdf() {
          return { ok: false, error: "NOT_USED" };
        },
      },
      presenter: {
        async presentConversation() {},
        async presentFlowReply() {},
        async presentRecoverableError() {},
      },
    },
    dependencies: {
      supabase: {
        from() {
          externalCalls += 1;
          throw new Error("BOOT_QUERY_FORBIDDEN");
        },
        rpc() {
          externalCalls += 1;
          throw new Error("BOOT_RPC_FORBIDDEN");
        },
      },
      legacyHandler: async () => ({ handled: false }),
      brain: {
        async understand() {
          externalCalls += 1;
          throw new Error("BOOT_BRAIN_FORBIDDEN");
        },
      },
      sharedPipeline: {
        createDraft: noop,
        applyBrainExtraction: noop,
        setInvoiceKind: noop, setReceiptFormat: noop,
        setClientOrPayer: noop,
        addContent: noop,
        updateContent: noop,
        removeContent: noop,
        setOptions: noop,
        changeDocumentType: noop,
        markReadyForReview: noop,
        verifyDocument: noop,
        reopenForCorrection: noop,
        cancelDocument: noop,
      },
      dischargePipeline: {
        createDischargeDraft: noop,
        applyBrainExtraction: noop,
        setIssuerOrGiver: noop,
        setRecipient: noop,
        setTransferredContent: noop,
        setReason: noop,
        setOptions: noop,
        markReadyForReview: noop,
        verifyDischarge: noop,
        reopenForCorrection: noop,
        cancelDischarge: noop,
      },
      issuerResolver: {
        async getIssuerProfileId() {
          externalCalls += 1;
          throw new Error("BOOT_ISSUER_FORBIDDEN");
        },
        async getIssuerProfileById() {
          externalCalls += 1;
          throw new Error("BOOT_ISSUER_FORBIDDEN");
        },
      },
      historyService: {
        async searchDocuments() {
          externalCalls += 1;
          throw new Error("BOOT_HISTORY_FORBIDDEN");
        },
        async getDocumentDetails() {
          externalCalls += 1;
          throw new Error("BOOT_HISTORY_FORBIDDEN");
        },
      },
      balanceReader: {
        async getBalance() {
          externalCalls += 1;
          throw new Error("BOOT_BALANCE_FORBIDDEN");
        },
      },
      providerAvailability: async () => false,
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(externalCalls, 0);
  assert.equal(composition.readiness.ready, true);
  assert.equal(
    typeof composition.components.orchestrator.handle,
    "function"
  );
});
