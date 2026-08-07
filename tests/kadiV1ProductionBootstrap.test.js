"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FLOW_ENV_KEYS,
  createKadiV1RuntimeConfig,
} = require("../kadiV1RuntimeConfig");
const {
  createKadiV1GenerationLifecycleObserver,
  createKadiV1ProductionBootstrap,
  inspectKadiV1ProductionBootstrap,
} = require("../kadiV1ProductionBootstrap");

const CANARY = "22670626055";

function activeEnv(overrides = {}) {
  const env = {
    KADI_V1_ENABLED: "true",
    KADI_V1_BRAIN_ENABLED: "true",
    KADI_V1_VISION_ENABLED: "true",
    KADI_V1_TRANSCRIPTION_ENABLED: "true",
    KADI_V1_VOICE_ENABLED: "true",
    KADI_V1_PRIVATE_STORAGE_ENABLED: "true",
    KADI_V1_GENERATION_ENABLED: "true",
    KADI_V1_RECHARGE_ENABLED: "true",
    KADI_V1_HISTORY_ENABLED: "true",
    KADI_V1_WEBHOOK_ENABLED: "true",
    KADI_V1_ROLLOUT_MODE: "CANARY",
    KADI_V1_CANARY_WA_IDS: CANARY,
    KADI_V1_PRIVATE_BUCKET: "kadi-v1-private",
    KADI_V1_PRIVATE_BUCKET_CONFIRMED: "true",
    KADI_V1_FLOW_MODE: "published",
    OPENAI_API_KEY: "test-only-not-used",
    GEMINI_API_KEY: "test-only-not-used",
    OM_NUMBER: "22670626055",
    OM_NAME: "Kadi",
    ...overrides,
  };
  let flowId = 100000000000000n;
  for (const key of Object.values(FLOW_ENV_KEYS)) {
    env[key] = String(flowId++);
  }
  return env;
}

function createFakeSupabase(calls) {
  const storageApi = {
    async upload() {
      calls.external += 1;
      throw new Error("BOOT_STORAGE_UPLOAD_FORBIDDEN");
    },
    async download() {
      calls.external += 1;
      throw new Error("BOOT_STORAGE_DOWNLOAD_FORBIDDEN");
    },
    async remove() {
      calls.external += 1;
      throw new Error("BOOT_STORAGE_REMOVE_FORBIDDEN");
    },
  };
  return {
    storage: {
      from(bucket) {
        calls.bucket = bucket;
        return storageApi;
      },
    },
    from() {
      return {
        select() { return this; },
        insert() { return this; },
        update() { return this; },
        eq() { return this; },
        in() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle: async () => {
          calls.external += 1;
          throw new Error("BOOT_QUERY_FORBIDDEN");
        },
        single: async () => {
          calls.external += 1;
          throw new Error("BOOT_QUERY_FORBIDDEN");
        },
      };
    },
    async rpc() {
      calls.external += 1;
      throw new Error("BOOT_RPC_FORBIDDEN");
    },
  };
}

function fakeWhatsApp(calls) {
  return {
    async getMediaInfo() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async downloadMediaToBuffer() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async uploadMediaBuffer() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async sendDocument() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async sendFlow() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async sendText() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async sendButtons() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
    async sendTypingIndicator() { calls.external += 1; throw new Error("BOOT_META_FORBIDDEN"); },
  };
}

function fakeProviders(calls) {
  return {
    async understandText() {
      calls.external += 1;
      throw new Error("BOOT_OPENAI_FORBIDDEN");
    },
    async transcribeAudio() {
      calls.external += 1;
      throw new Error("BOOT_STT_FORBIDDEN");
    },
    geminiClient: {
      async generateStructured() {
        calls.external += 1;
        throw new Error("BOOT_GEMINI_FORBIDDEN");
      },
    },
    pdfRendererResolver() {
      return async () => {
        calls.external += 1;
        throw new Error("BOOT_PDF_RENDER_FORBIDDEN");
      };
    },
  };
}

test("OFF bootstrap does not inspect providers, Supabase or WhatsApp", () => {
  const env = {
    KADI_V1_ENABLED: "false",
    KADI_V1_WEBHOOK_ENABLED: "false",
    KADI_V1_ROLLOUT_MODE: "OFF",
  };
  const config = createKadiV1RuntimeConfig(env);
  const hostile = new Proxy({}, {
    get() {
      throw new Error("OFF_BOOT_MUST_NOT_INSPECT_DEPENDENCIES");
    },
  });
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: hostile,
    whatsappApi: hostile,
    providerAdapters: hostile,
  });
  assert.equal(bootstrap.readiness.state, "DISABLED");
  assert.equal(bootstrap.readiness.ready, true);
  assert.equal(bootstrap.readiness.active, false);
  assert.equal(bootstrap.readiness.boot_external_calls, 0);
});

test("active bootstrap builds the four real production ports with zero boot I/O", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv();
  const config = createKadiV1RuntimeConfig(env);
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });

  assert.equal(calls.external, 0);
  assert.equal(calls.bucket, "kadi-v1-private");
  assert.equal(bootstrap.readiness.ready, true);
  assert.equal(bootstrap.readiness.active, true);
  assert.equal(bootstrap.readiness.state, "READY");
  assert.deepEqual(bootstrap.readiness.missing_ports, []);
  assert.equal(typeof bootstrap.components.orchestrator.handle, "function");
  assert.equal(typeof bootstrap.components.flowReplyRuntime.handle, "function");
  assert.equal(typeof bootstrap.components.mediaResolver.resolveAudio, "function");
  assert.equal(typeof bootstrap.components.presenter.presentConversation, "function");
  assert.equal(bootstrap.readiness.boot_external_calls, 0);
});

test("conversational multimodal V1 is disabled by default and reports safe readiness diagnostics without leaking identifiers", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv({ KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: CANARY });
  const config = createKadiV1RuntimeConfig(env);
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });
  assert.equal(bootstrap.readiness.ready, true);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.enabled, false);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.wired_into_orchestrator, false);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.canary_owner_count, 0, "l'allowlist n'est même pas lue quand le flag est faux");
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.gemini_audio_enabled, false);
  assert.equal(JSON.stringify(bootstrap.readiness).includes(CANARY), false);
});

test("conversational multimodal V1 activé expose un état sûr et câble l'intégration, sans exiger Gemini Audio", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED: "true",
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: CANARY,
  });
  const config = createKadiV1RuntimeConfig(env);
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });
  assert.equal(bootstrap.readiness.ready, true, "Gemini Audio n'étant pas requis, le démarrage reste READY");
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.enabled, true);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.wired_into_orchestrator, true);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.canary_owner_count, 1);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.gemini_audio_enabled, false);
  assert.equal(JSON.stringify(bootstrap.readiness).includes(CANARY), false, "aucun identifiant WhatsApp complet dans les diagnostics");
});

test("un allowlist conversationnel malformé n'empêche pas le démarrage du webhook, seule la fonctionnalité reste inerte", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv({
    KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED: "true",
    KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS: "not-a-valid-owner-list",
  });
  const config = createKadiV1RuntimeConfig(env);
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config,
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });
  assert.equal(bootstrap.readiness.ready, true, "une allowlist malformée ne doit pas faire échouer tout le webhook V1");
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.canary_allowlist_valid, false);
  assert.equal(bootstrap.readiness.conversational_multimodal_v1.canary_owner_count, 0);
});

test("active bootstrap fails closed when the private bucket is not explicitly confirmed", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv({ KADI_V1_PRIVATE_BUCKET_CONFIRMED: "false" });
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config: createKadiV1RuntimeConfig(env),
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });
  assert.equal(calls.external, 0);
  assert.equal(bootstrap.readiness.ready, false);
  assert.equal(bootstrap.readiness.state, "BLOCKED");
  assert.equal(
    bootstrap.readiness.blocker,
    "KADI_V1_PRIVATE_BUCKET_CONFIRMATION_REQUIRED"
  );
});

test("bootstrap inspector uses the same real factory", () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv();
  const report = inspectKadiV1ProductionBootstrap({
    env,
    config: createKadiV1RuntimeConfig(env),
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
  });
  assert.equal(calls.external, 0);
  assert.equal(report.ready, true);
  assert.deepEqual(report.missing_capabilities, []);
  assert.equal(report.readiness.state, "READY");
});

test("generation lifecycle observer forwards only the closed-set safe fields (reason_code, duplicate) to the logger, stripping anything else", () => {
  const calls = [];
  const observer = createKadiV1GenerationLifecycleObserver({ log: (event, details) => calls.push([event, details]) });
  observer("delivery_retry_failed", { reason_code: "DELIVERY_DESTINATION_LOOKUP_FAILED", owner_wa_id: "22670000000", document_id: "document:secret", destination_hash: "abc123" });
  assert.deepEqual(calls, [["delivery_retry_failed", { reason_code: "DELIVERY_DESTINATION_LOOKUP_FAILED" }]]);
});

test("generation lifecycle observer passes duplicate:true/false through untouched", () => {
  const calls = [];
  const observer = createKadiV1GenerationLifecycleObserver({ log: (event, details) => calls.push([event, details]) });
  observer("delivery_retry_succeeded", { duplicate: true });
  assert.deepEqual(calls, [["delivery_retry_succeeded", { duplicate: true }]]);
});

test("generation lifecycle observer accepts an event with no details at all, and never throws even if the logger itself throws", () => {
  const observer = createKadiV1GenerationLifecycleObserver({ log: () => { throw new Error("logger down"); } });
  assert.doesNotThrow(() => observer("delivery_retry_started"));
});

test("production bootstrap wires a real observer into the generation lifecycle service — no longer the silent no-op default", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiV1ProductionBootstrap.js"), "utf8");
  assert.match(source, /createGenerationLifecycleService\(\{[\s\S]{0,400}observer:\s*createKadiV1GenerationLifecycleObserver\(logger\)/);
});

test("index mounts the production bootstrap instead of the incomplete composition", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /createKadiV1ProductionBootstrap\s*\(/);
  assert.match(source, /supabase,\s*\n\s*whatsappApi,/);
  assert.doesNotMatch(source, /createKadiV1ProductionComposition\s*\(\{\s*config:\s*KADI_V1_CONFIG,\s*logger:/);
  assert.match(source, /kadiV1ProductionBootstrap\.webhookHandler/);
});

function createConversationSupabase(calls) {
  const now = "2026-08-04T00:00:00.000Z";
  function builder(table) {
    const state = { table, filters: [] };
    return {
      select() { return this; },
      insert() { return this; },
      update() { return this; },
      eq(field, value) { state.filters.push([field, value]); return this; },
      in() { return this; },
      order() { return this; },
      limit() { return this; },
      async maybeSingle() {
        calls.db += 1;
        if (table === "business_profiles") {
          return {
            data: {
              wa_id: CANARY,
              phone_normalized: CANARY,
              onboarding_status: "COMPLETED",
              welcome_credits_granted: true,
              welcome_credits_eligibility: "GRANTED",
              voice_response_mode: "TEXT_ONLY",
              locale: "fr-BF",
              v1_created_at: now,
              v1_updated_at: now,
              created_at: now,
              updated_at: now,
            },
            error: null,
          };
        }
        if (table === "kadi_v1_documents") {
          return { data: null, error: null };
        }
        if (table === "kadi_v1_conversation_sessions") {
          return { data: null, error: null };
        }
        return { data: null, error: null };
      },
      async single() {
        calls.db += 1;
        return { data: null, error: null };
      },
    };
  }
  return {
    storage: {
      from() {
        return {
          async upload() { throw new Error("NOT_USED"); },
          async download() { throw new Error("NOT_USED"); },
          async remove() { throw new Error("NOT_USED"); },
        };
      },
    },
    from: builder,
    async rpc(name, parameters) {
      calls.db += 1;
      if (name === "kadi_v1_create_conversation_session") {
        return {
          data: {
            ok: true,
            duplicate: false,
            session: parameters.p_session,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

test("the real bootstrap intercepts an authorized canary before legacy", async () => {
  const calls = {
    db: 0,
    brain: 0,
    text: 0,
    flow: 0,
    legacy: 0,
  };
  const env = activeEnv();
  const whatsapp = {
    async getMediaInfo() { throw new Error("NOT_USED"); },
    async downloadMediaToBuffer() { throw new Error("NOT_USED"); },
    async uploadMediaBuffer() { throw new Error("NOT_USED"); },
    async sendDocument() { throw new Error("NOT_USED"); },
    async sendText(to, text) {
      calls.text += 1;
      assert.equal(to, CANARY);
      assert.equal(text, "Que souhaitez-vous faire ?");
      return { messages: [{ id: "wamid:text" }] };
    },
    async sendFlow(payload) {
      calls.flow += 1;
      assert.equal(payload.to, CANARY);
      assert.equal(payload.interactive.action.parameters.flow_action_payload.screen, "MENU");
      return { messages: [{ id: "wamid:flow" }] };
    },
    async sendButtons() { throw new Error("NOT_USED"); },
    async sendTypingIndicator() {},
  };
  const providerAdapters = {
    async understandText() {
      calls.brain += 1;
      return {
        kind: "unknown",
        documentType: null,
        items: [],
        confidence: 0.9,
      };
    },
    async transcribeAudio() { throw new Error("NOT_USED"); },
    geminiClient: {
      async generateStructured() { throw new Error("NOT_USED"); },
    },
    pdfRendererResolver() {
      return async () => { throw new Error("NOT_USED"); };
    },
  };
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config: createKadiV1RuntimeConfig(env),
    supabase: createConversationSupabase(calls),
    whatsappApi: whatsapp,
    providerAdapters,
    logger: { log() {}, warn() {} },
  });
  assert.equal(bootstrap.readiness.ready, true);

  const result = await bootstrap.webhookHandler({
    messages: [{
      id: "wamid:real-bootstrap-canary",
      from: CANARY,
      type: "text",
      text: { body: "Bonjour Kadi" },
    }],
  });

  assert.equal(result.handled, true);
  assert.equal(result.results[0].accepted, true);
  assert.equal(calls.brain, 1);
  assert.equal(calls.text, 1);
  assert.equal(calls.flow, 1);
  assert.equal(calls.legacy, 0);
});

test("the real bootstrap leaves a non-canary available to legacy", async () => {
  const calls = { external: 0, bucket: null };
  const env = activeEnv();
  const bootstrap = createKadiV1ProductionBootstrap({
    env,
    config: createKadiV1RuntimeConfig(env),
    supabase: createFakeSupabase(calls),
    whatsappApi: fakeWhatsApp(calls),
    providerAdapters: fakeProviders(calls),
    logger: { log() {}, warn() {} },
  });

  const result = await bootstrap.webhookHandler({
    messages: [{
      id: "wamid:real-bootstrap-non-canary",
      from: "22670000000",
      type: "text",
      text: { body: "Bonjour Kadi" },
    }],
  });

  assert.equal(result.handled, false);
  assert.equal(result.results[0].reason, "KADI_V1_OWNER_NOT_IN_ROLLOUT");
  assert.equal(calls.external, 0);
});
