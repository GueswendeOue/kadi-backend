"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createKadiV1ConversationOrchestrator } = require("../kadiV1ConversationOrchestrator");
const {
  createConversationSessionService,
  createMemoryConversationSessionRepository,
} = require("../kadiV1ConversationSession");
const { createKadiV1FlowCommandRuntime } = require("../kadiV1FlowCommandRuntime");
const { createKadiV1FlowReplyRuntime } = require("../kadiV1FlowReplyRuntime");
const { createKadiV1RuntimeConfig } = require("../kadiV1RuntimeConfig");
const { createKadiV1WebhookRuntime } = require("../kadiV1WebhookRuntime");

const OWNER = "22670000000";
const OTHER_OWNER = "22671111111";

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }

function textMessage(body, id = "wamid.release.text.1", from = OWNER) {
  return { id, from, type: "text", text: { body } };
}

function flowMessage({ sessionId, flowKey, action, data = {}, id = "wamid.release.flow.1", from = OWNER }) {
  return {
    id,
    from,
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        response_json: JSON.stringify({
          session_id: sessionId,
          flow_key: flowKey,
          action,
          data,
        }),
      },
    },
  };
}

function document(overrides = {}) {
  return {
    document_id: "document:release:1",
    version: 4,
    document_type: "FACTURE",
    status: "READY_FOR_REVIEW",
    missing_fields: [],
    uncertainties: [],
    ...overrides,
  };
}

function createReleaseHarness({ clockStart = "2026-08-03T00:00:00.000Z", presenterFailure = false } = {}) {
  let nowMs = Date.parse(clockStart);
  let sessionSequence = 0;
  const events = [];
  const businessWrites = new Map();
  const sessions = createConversationSessionService({
    repository: createMemoryConversationSessionRepository(),
    clock: () => new Date(nowMs).toISOString(),
    idFactory: () => `kadi_session:release:${++sessionSequence}`,
  });

  function record(name, payload = {}) {
    events.push([name, structuredClone(payload)]);
  }

  function idempotentWrite(name, payload, value) {
    const key = `${name}:${payload.idempotencyKey || "none"}`;
    if (businessWrites.has(key)) return ok(structuredClone(businessWrites.get(key)), { duplicate: true });
    businessWrites.set(key, structuredClone(value));
    record(name, payload);
    return ok(structuredClone(value));
  }

  const documentRuntime = {
    start: async (payload) => idempotentWrite("document.start", payload, document({
      document_id: `document:${payload.documentType.toLowerCase()}:release`,
      version: 1,
      document_type: payload.documentType,
      status: "COLLECTING",
      missing_fields: ["client", "content"],
    })),
    apply: async (payload) => idempotentWrite("document.apply", payload, document()),
    cancel: async (payload) => idempotentWrite("document.cancel", payload, document({ status: "CANCELLED", version: payload.expectedVersion + 1 })),
    setClient: async (payload) => idempotentWrite("document.setClient", payload, document({ version: payload.expectedVersion + 1 })),
    addContent: async (payload) => idempotentWrite("document.addContent", payload, document({ version: payload.expectedVersion + 1 })),
    updateContent: async (payload) => idempotentWrite("document.updateContent", payload, document({ version: payload.expectedVersion + 1 })),
    removeContent: async (payload) => idempotentWrite("document.removeContent", payload, document({ version: payload.expectedVersion + 1 })),
    finishContent: async (payload) => idempotentWrite("document.finishContent", payload, document({ version: payload.expectedVersion })),
    setOptions: async (payload) => idempotentWrite("document.setOptions", payload, document({ version: payload.expectedVersion + 1 })),
    verify: async (payload) => idempotentWrite("document.verify", payload, document({ status: "VERIFIED", version: payload.expectedVersion + 1 })),
    beginEdit: async (payload) => idempotentWrite("document.beginEdit", payload, document({ status: "COLLECTING", version: payload.expectedVersion + 1 })),
    saveForLater: async (payload) => idempotentWrite("document.saveForLater", payload, document()),
    saveDischargeDetails: async (payload) => idempotentWrite("document.saveDischargeDetails", payload, document({ document_type: "DECHARGE", version: payload.expectedVersion + 1 })),
  };

  const previewRuntime = {
    prepare: async (payload) => idempotentWrite("preview.prepare", payload, {
      document: document({ status: "AWAITING_GENERATION_CONFIRMATION", version: payload.expectedVersion + 2 }),
      quote: { quote_id: "quote:release:1", page_count: 2, credits: 2 },
    }),
  };
  const generationRuntime = {
    confirm: async (payload) => idempotentWrite("generation.confirm", payload, {
      document: document({ status: "GENERATION_IN_PROGRESS", version: payload.expectedVersion + 1 }),
      quote_id: payload.quoteId,
    }),
  };
  const rechargeRuntime = {
    selectPack: async (payload) => idempotentWrite("recharge.selectPack", payload, { pack_id: payload.packId }),
    checkPayment: async (payload) => idempotentWrite("recharge.checkPayment", payload, { payment_reference: payload.paymentReference, status: "PENDING" }),
    cancel: async (payload) => idempotentWrite("recharge.cancel", payload, { cancelled: true }),
  };
  const historyRuntime = {
    search: async (payload) => { record("history.search", payload); return ok({ documents: [] }); },
    open: async (payload) => { record("history.open", payload); return ok({ document: document() }); },
  };
  const walletRuntime = {
    getBalance: async (payload) => { record("wallet.getBalance", payload); return ok({ credits: 5 }); },
  };
  const onboardingCommandRuntime = {
    continueOnboarding: async (payload) => idempotentWrite("onboarding.continue", payload, { completed: true }),
  };

  const commandRuntime = createKadiV1FlowCommandRuntime({
    onboardingRuntime: onboardingCommandRuntime,
    documentRuntime,
    previewRuntime,
    generationRuntime,
    rechargeRuntime,
    historyRuntime,
    walletRuntime,
  });
  const flowReplyRuntime = createKadiV1FlowReplyRuntime({ sessionService: sessions, commandRuntime });

  const config = {
    enabled: true,
    rollout: { mode: "FULL", valid: true, canaryOwnerCount: 0, canaryWaIds: [] },
    features: {
      brain: true,
      vision: true,
      transcription: true,
      voice: false,
      privateStorage: true,
      generation: true,
      recharge: true,
      history: true,
      webhook: true,
    },
  };
  const orchestrator = createKadiV1ConversationOrchestrator({
    config,
    legacyHandler: async (input) => { record("legacy", input); return { handled: false }; },
    userContextService: {
      getContext: async () => ok({
        is_new: false,
        profile: { onboarding_status: "COMPLETED", voice_response_mode: "TEXT_ONLY" },
        active_document: null,
      }),
    },
    onboardingRuntime: { start: async () => ok({ welcome_credits_granted: true }) },
    interpretationRuntime: { interpret: async () => ok({ intent: "CONTINUE", brain_result: null }) },
    documentRuntime,
    historyRuntime,
    walletRuntime,
  });

  const outgoingSessions = [];
  const presenter = {
    presentConversation: async ({ ownerWaId, messageId, response }) => {
      record("present.conversation", { ownerWaId, messageId, response });
      if (presenterFailure) throw new Error("simulated presenter failure");
      if (!response.flow_request) return;
      const opened = await sessions.open({
        ownerWaId,
        document: response.flow_request.prefill?.document_id ? {
          document_id: response.flow_request.prefill.document_id,
          version: response.flow_request.prefill.document_version,
          document_type: response.flow_request.prefill.document_type,
          status: response.next_state,
        } : null,
        expectedFlowKey: response.flow_request.flow_key,
        idempotencyKey: `release_present:${messageId}:${response.flow_request.flow_key}`,
      });
      assert.equal(opened.ok, true);
      outgoingSessions.push(opened.value);
    },
    presentFlowReply: async (payload) => record("present.flowReply", payload),
    presentRecoverableError: async (payload) => record("present.recoverable", payload),
  };

  const webhook = createKadiV1WebhookRuntime({
    config,
    orchestrator,
    flowReplyRuntime,
    mediaResolver: {
      resolveAudio: async () => ok({ text: "Je veux une facture" }),
      resolveImage: async () => ok({ media: { media_id: "media:image:release" } }),
      resolvePdf: async () => ok({ media: { media_id: "media:pdf:release" } }),
    },
    presenter,
    logger: { log: (label, payload) => record("log", { label, payload }) },
  });

  return {
    webhook,
    sessions,
    events,
    outgoingSessions,
    businessWrites,
    advanceMs(ms) { nowMs += ms; },
    count(name) { return events.filter(([event]) => event === name).length; },
  };
}

async function openDocumentSession(harness, { flowKey, doc = document(), key = flowKey } = {}) {
  const opened = await harness.sessions.open({
    ownerWaId: OWNER,
    document: doc,
    expectedFlowKey: flowKey,
    idempotencyKey: `release_open:${key}`,
  });
  assert.equal(opened.ok, true);
  return opened.value;
}

test("release gate keeps every V1 capability disabled by default", () => {
  const config = createKadiV1RuntimeConfig({});
  assert.equal(config.enabled, false);
  assert.equal(Object.values(config.features).some(Boolean), false);
});

test("menu text -> Flow session -> facture command crosses the complete V1 boundary once", async () => {
  const harness = createReleaseHarness();
  const menu = await harness.webhook.handleIncomingValue({ messages: [textMessage("menu")] });
  assert.equal(menu.handled, true);
  assert.equal(harness.count("legacy"), 0);
  assert.equal(harness.outgoingSessions.length, 1);
  assert.equal(harness.outgoingSessions[0].expected_flow_key, "MENU");

  const reply = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: harness.outgoingSessions[0].session_id,
    flowKey: "MENU",
    action: "PREPARE_DOCUMENT",
    data: { document_type: "FACTURE" },
  })] });

  assert.equal(reply.handled, true);
  assert.equal(reply.results[0].accepted, true);
  assert.equal(harness.count("document.start"), 1);
  assert.equal(harness.count("present.flowReply"), 1);
  assert.equal(harness.count("legacy"), 0);
});

test("a Flow reply from another WhatsApp owner is absorbed before every business write", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, { flowKey: "DOCUMENT_REVIEW" });
  const result = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: session.session_id,
    flowKey: "DOCUMENT_REVIEW",
    action: "VERIFY",
    from: OTHER_OWNER,
  })] });

  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false);
  assert.equal(harness.count("document.verify"), 0);
  assert.equal(harness.count("present.recoverable"), 1);
  assert.equal(harness.count("legacy"), 0);
});

test("an unexpected Flow screen fails closed and never reaches preview or generation", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, { flowKey: "DOCUMENT_REVIEW" });
  const result = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: session.session_id,
    flowKey: "DOCUMENT_PREVIEW",
    action: "PREPARE_PDF",
  })] });

  assert.equal(result.results[0].accepted, false);
  assert.equal(harness.count("preview.prepare"), 0);
  assert.equal(harness.count("generation.confirm"), 0);
  assert.equal(harness.count("present.recoverable"), 1);
});

test("an expired Flow session preserves data and performs no business mutation", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, { flowKey: "DOCUMENT_CLIENT" });
  harness.advanceMs(31 * 60 * 1000);
  const result = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: session.session_id,
    flowKey: "DOCUMENT_CLIENT",
    action: "SAVE_CLIENT",
    data: { name: "Client test" },
  })] });

  assert.equal(result.results[0].accepted, false);
  assert.equal(harness.count("document.setClient"), 0);
  assert.equal(harness.count("present.recoverable"), 1);
});

test("replaying the same Meta Flow message is idempotent and creates one client mutation", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, { flowKey: "DOCUMENT_CLIENT" });
  const message = flowMessage({
    id: "wamid.release.duplicate.1",
    sessionId: session.session_id,
    flowKey: "DOCUMENT_CLIENT",
    action: "SAVE_CLIENT",
    data: { name: "Client unique" },
  });

  const first = await harness.webhook.handleIncomingValue({ messages: [message] });
  const second = await harness.webhook.handleIncomingValue({ messages: [message] });

  assert.equal(first.results[0].accepted, true);
  assert.equal(second.results[0].accepted, true);
  assert.equal(second.results[0].duplicate, true);
  assert.equal(harness.count("document.setClient"), 1);
  assert.equal(harness.count("present.flowReply"), 2);
});

test("preparing the PDF computes preview and quote without confirming generation", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, {
    flowKey: "DOCUMENT_PREVIEW",
    doc: document({ status: "VERIFIED" }),
  });
  const result = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: session.session_id,
    flowKey: "DOCUMENT_PREVIEW",
    action: "PREPARE_PDF",
  })] });

  assert.equal(result.results[0].accepted, true);
  assert.equal(harness.count("preview.prepare"), 1);
  assert.equal(harness.count("generation.confirm"), 0);
  assert.equal(harness.count("wallet.getBalance"), 0);
});

test("generation starts only after an explicit confirmation tied to the server session", async () => {
  const harness = createReleaseHarness();
  const session = await openDocumentSession(harness, {
    flowKey: "GENERATION_CONFIRMATION",
    doc: document({ status: "AWAITING_GENERATION_CONFIRMATION", version: 6 }),
  });
  const result = await harness.webhook.handleIncomingValue({ messages: [flowMessage({
    sessionId: session.session_id,
    flowKey: "GENERATION_CONFIRMATION",
    action: "CONFIRM_GENERATION",
    data: { quote_id: "quote:release:1" },
  })] });

  assert.equal(result.results[0].accepted, true);
  assert.equal(harness.count("generation.confirm"), 1);
  const payload = harness.events.find(([name]) => name === "generation.confirm")[1];
  assert.equal(payload.documentId, "document:release:1");
  assert.equal(payload.expectedVersion, 6);
  assert.equal(payload.quoteId, "quote:release:1");
});

test("presentation failure is absorbed and never falls through to the legacy engine", async () => {
  const harness = createReleaseHarness({ presenterFailure: true });
  const result = await harness.webhook.handleIncomingValue({ messages: [textMessage("menu")] });
  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, false);
  assert.equal(harness.count("present.recoverable"), 1);
  assert.equal(harness.count("legacy"), 0);
});
