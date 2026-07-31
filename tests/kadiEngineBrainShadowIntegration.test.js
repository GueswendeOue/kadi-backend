"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const universalDouble = new Proxy(function universalDouble() {
  return universalDouble;
}, {
  get(target, property) {
    if (property === "then") return undefined;
    return universalDouble;
  },
  apply() {
    return universalDouble;
  },
});

const originalLoad = Module._load;
const realEngineDependencies = new Set([
  "./kadiBrainRealShadow",
  "./kadiBrainConfig",
  "./kadiBrainFlowContext",
  "./kadiUtils",
  "./kadiGlobalNav",
]);
Module._load = function loadWithIsolatedEngineDependencies(
  request,
  parent,
  isMain
) {
  if (
    parent?.filename?.endsWith(`${path.sep}kadiEngine.js`) &&
    request.startsWith("./") &&
    !realEngineDependencies.has(request)
  ) return universalDouble;
  return originalLoad.call(this, request, parent, isMain);
};
let engineExports;
try {
  engineExports = require("../kadiEngine");
} finally {
  Module._load = originalLoad;
}

const {
  configureBrainRealShadowIntegration,
  buildBrainRealShadowFlowContext,
  prepareBrainRealShadowInput,
  projectBrainShadowResultForObservation,
  launchBrainRealShadowObservation,
} = engineExports;

const PUBLIC_RESULT = Object.freeze({
  shadowVersion: "kadi.brain-real-shadow.v1",
  status: "SUCCEEDED",
  sourceType: "text",
  messageIdHash: "abcdef0123456789",
  providerStatus: "SUCCEEDED",
  providerFailureKind: "NONE",
  parserValid: true,
  parserFailureCode: null,
  intent: "CREATE_INVOICE",
  confidenceBucket: "HIGH",
  actionable: true,
  missingFieldCount: 0,
  blockingAmbiguityCount: 0,
  safetyFlags: Object.freeze({
    containsSensitiveData: false,
    requiresHumanReview: false,
  }),
  latencyBucket: "LT_1S",
  execution: "NONE",
  timestamp: "2026-08-01T00:00:00.000Z",
});

const EXPECTED_OBSERVATION_KEYS = Object.freeze([
  "shadowVersion", "status", "sourceType", "messageIdHash",
  "providerStatus", "providerFailureKind", "parserValid", "parserFailureCode",
  "intent", "confidenceBucket", "actionable", "missingFieldCount",
  "blockingAmbiguityCount", "safetyFlags", "latencyBucket", "execution",
  "timestamp",
]);

function textMessage(overrides = {}) {
  return {
    id: "wamid.fictitious-shadow",
    type: "text",
    text: { body: "Créer une facture" },
    ...overrides,
  };
}

function flushDetached() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushLateDetached() {
  await new Promise((resolve) => setTimeout(resolve, 15));
  await flushDetached();
}

test.afterEach(() => {
  configureBrainRealShadowIntegration(null);
});

test("observation projection has exactly the canonical seventeen keys", () => {
  const projected = projectBrainShadowResultForObservation(PUBLIC_RESULT);
  assert.deepEqual(Object.keys(projected), EXPECTED_OBSERVATION_KEYS);
  assert.equal(Object.keys(projected).length, 17);
  assert.equal(projected.execution, "NONE");
  for (const key of Object.keys(projected)) {
    assert.equal(/^raw|session|prompt|stack|error|messageId$/u.test(key), false);
  }
});

test("projection accepts only representative plain objects", async () => {
  class ResultClass {}
  const customPrototype = Object.create({ inherited: "PRIVATE" });
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() { throw new Error("PRIVATE_PROXY"); },
  });
  const accepted = [
    { ...PUBLIC_RESULT },
    Object.assign(Object.create(null), PUBLIC_RESULT),
    Object.freeze({ ...PUBLIC_RESULT }),
    Object.seal({ ...PUBLIC_RESULT }),
  ];
  const rejected = [
    new Date(), new Error("PRIVATE_ERROR"), [], new Map(), new Set(),
    new ResultClass(), customPrototype, function result() {}, hostileProxy,
  ];
  for (const value of accepted) {
    const projected = projectBrainShadowResultForObservation(value);
    assert.deepEqual(Object.keys(projected), EXPECTED_OBSERVATION_KEYS);
  }
  for (const [index, value] of rejected.entries()) {
    assert.equal(projectBrainShadowResultForObservation(value), null, String(index));
    const observed = [];
    configureBrainRealShadowIntegration({
      mode: "shadow",
      runner: { run: () => value },
      onResult: (result) => observed.push(result),
    });
    assert.doesNotThrow(() => launchBrainRealShadowObservation({
      text: "Créer une facture",
      msg: textMessage({ id: `representative-${index}` }),
      session: { step: "idle" },
    }));
    await flushDetached();
    assert.equal(observed.length, 0);
  }
});

test("counter projection keeps only integers in the inclusive range 0..100", () => {
  const values = [undefined, null, -1, 0, 1, 99, 100, 101, 1.5,
    NaN, Infinity, "2", {}, []];
  for (const value of values) {
    const projected = projectBrainShadowResultForObservation({
      ...PUBLIC_RESULT,
      missingFieldCount: value,
      blockingAmbiguityCount: value,
    });
    const expected = Number.isInteger(value) && value >= 0 && value <= 100
      ? value
      : 0;
    assert.equal(projected.missingFieldCount, expected);
    assert.equal(projected.blockingAmbiguityCount, expected);
  }
});

test("only exact shadow mode prepares an observation", () => {
  const base = {
    text: "Créer une facture",
    msg: textMessage(),
    session: { step: "idle" },
  };
  for (const mode of [
    undefined, null, "off", "candidate", "active_allowlist", "active",
    "invalid",
  ]) {
    assert.equal(
      prepareBrainRealShadowInput({ ...base, mode }),
      null,
      String(mode)
    );
  }
  for (const mode of ["shadow", "SHADOW", " shadow "]) {
    assert.equal(
      prepareBrainRealShadowInput({ ...base, mode })?.sourceType,
      "text"
    );
  }
});

test("text and transcribed voice produce the exact bounded runner input", () => {
  const session = {
    step: "doc_client",
    mode: "facture",
    lastDocDraft: {
      type: "facture",
      clientName: "PRIVATE_CLIENT",
      items: [{ price: 25000 }],
      phone: "PRIVATE_PHONE",
    },
    waId: "PRIVATE_WA_ID",
  };
  const text = prepareBrainRealShadowInput({
    text: "Créer une facture",
    msg: textMessage(),
    session,
    mode: "shadow",
  });
  const voice = prepareBrainRealShadowInput({
    text: "Créer une facture",
    msg: textMessage({
      audioTranscript: {
        raw: "PRIVATE_RAW_TRANSCRIPT",
        mediaId: "PRIVATE_MEDIA_ID",
        detectedLanguages: ["fr"],
      },
    }),
    session,
    mode: "shadow",
  });
  for (const value of [text, voice]) {
    assert.deepEqual(Object.keys(value), [
      "messageId", "sourceType", "userMessage", "flowContext",
    ]);
    assert.equal(value.messageId, "wamid.fictitious-shadow");
    assert.equal(value.userMessage, "Créer une facture");
    assert.deepEqual(Object.keys(value.flowContext), [
      "stepCategory", "activeFlow", "activeDocumentType", "hasActiveDraft",
      "expectedFieldNames", "messageType",
    ]);
    const serialized = JSON.stringify(value.flowContext);
    for (const sentinel of [
      "PRIVATE_CLIENT", "PRIVATE_PHONE", "PRIVATE_WA_ID",
      "PRIVATE_RAW_TRANSCRIPT", "PRIVATE_MEDIA_ID", "25000",
    ]) assert.equal(serialized.includes(sentinel), false);
  }
  assert.equal(text.sourceType, "text");
  assert.equal(voice.sourceType, "voice");
  assert.equal(voice.flowContext.messageType, "voice");
});

test("flow context uses only bounded categorical values and field names", () => {
  const cases = [
    [{ step: "idle" }, ["NONE", "NONE", null, false, []]],
    [
      { step: "doc_client", mode: "devis", lastDocDraft: {} },
      ["DOCUMENT_COLLECTION", "QUOTE", "quote", true, ["clientName"]],
    ],
    [
      { step: "item_price", mode: "facture", lastDocDraft: {} },
      ["DOCUMENT_COLLECTION", "INVOICE", "invoice", true, ["itemPrice"]],
    ],
    [
      { step: "history_search" },
      ["OTHER", "HISTORY", null, false, []],
    ],
    [
      { step: "profile" },
      ["ONBOARDING", "PROFILE", null, false, []],
    ],
  ];
  for (const [session, expected] of cases) {
    const value = buildBrainRealShadowFlowContext(session, "text");
    assert.deepEqual([
      value.stepCategory,
      value.activeFlow,
      value.activeDocumentType,
      value.hasActiveDraft,
      value.expectedFieldNames,
    ], expected);
    assert.equal(value.messageType, "text");
  }
});

test("non-text types and structurally invalid messages are excluded", () => {
  const cases = [
    { msg: null },
    { msg: textMessage({ id: "" }) },
    { msg: textMessage({ type: "image" }) },
    { msg: textMessage({ type: "document" }) },
    { msg: textMessage({ type: "interactive" }) },
    { msg: textMessage({ type: "button" }) },
    { msg: textMessage({ type: "status" }) },
    { msg: textMessage({ type: "system" }) },
    { msg: textMessage(), text: "" },
    { msg: textMessage(), text: " " },
    { msg: textMessage(), text: "x".repeat(12001) },
  ];
  for (const value of cases) {
    assert.equal(prepareBrainRealShadowInput({
      text: value.text ?? "Créer une facture",
      msg: value.msg,
      session: { step: "idle" },
      mode: "shadow",
    }), null);
  }
});

test("admin, support, menu, payment and deterministic confirmations are excluded", () => {
  const cases = [
    ["/stats", { step: "idle" }],
    ["support", { step: "idle" }],
    ["agent humain", { step: "idle" }],
    ["MENU", { step: "idle" }],
    ["preuve envoyée", { step: "recharge_proof" }],
    ["paiement", { step: "pispi_pending" }],
    ["oui", { step: "doc_review" }],
    ["continuer", { step: "doc_after_item_choice" }],
    ["texte", { step: "idle", adminPendingAction: "broadcast" }],
  ];
  for (const [text, session] of cases) {
    assert.equal(prepareBrainRealShadowInput({
      text,
      msg: textMessage(),
      session,
      mode: "shadow",
    }), null);
  }
  for (const text of [
    "Créer une facture", "Faire un devis", "Créer un reçu",
    "Créer une décharge", "Rechercher mon document", "Bonjour",
    "Corriger le client",
  ]) {
    assert.notEqual(prepareBrainRealShadowInput({
      text,
      msg: textMessage(),
      session: { step: "doc_client", mode: "facture" },
      mode: "shadow",
    }), null);
  }
});

test("ineligible engine observations make zero runner calls", () => {
  let calls = 0;
  const runner = { run: () => { calls += 1; return PUBLIC_RESULT; } };
  for (const mode of [
    undefined, "off", "candidate", "active_allowlist", "active", "invalid",
  ]) {
    configureBrainRealShadowIntegration({ mode, runner });
    assert.equal(launchBrainRealShadowObservation({
      text: "Créer une facture",
      msg: textMessage(),
      session: { step: "idle" },
    }), false);
  }
  configureBrainRealShadowIntegration({ mode: "shadow", runner });
  for (const [text, msg, session] of [
    ["Créer une facture", textMessage({ type: "image" }), { step: "idle" }],
    ["Créer une facture", textMessage({ type: "document" }), { step: "idle" }],
    ["Créer une facture", textMessage({ type: "interactive" }), { step: "idle" }],
    ["/stats", textMessage(), { step: "idle" }],
    ["support", textMessage(), { step: "idle" }],
    ["MENU", textMessage(), { step: "idle" }],
    ["preuve", textMessage(), { step: "recharge_proof" }],
  ]) {
    assert.equal(
      launchBrainRealShadowObservation({ text, msg, session }),
      false
    );
  }
  assert.equal(calls, 0);
});

test("eligible text and voice each launch exactly once", () => {
  const inputs = [];
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: {
      run(value) {
        inputs.push(structuredClone(value));
        return PUBLIC_RESULT;
      },
    },
  });
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage({ id: "text-id" }),
    session: { step: "idle" },
  }), true);
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage({
      id: "voice-id",
      audioTranscript: { raw: "PRIVATE_RAW", mediaId: "PRIVATE_MEDIA" },
    }),
    session: { step: "doc_client", mode: "facture" },
  }), true);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((value) => value.sourceType), ["text", "voice"]);
  assert.deepEqual(inputs.map((value) => value.messageId), [
    "text-id", "voice-id",
  ]);
  assert.equal(JSON.stringify(inputs).includes("PRIVATE_RAW"), false);
  assert.equal(JSON.stringify(inputs).includes("PRIVATE_MEDIA"), false);
});

test("detached success cannot alter session or execute actionable output", async () => {
  const calls = [];
  const observed = [];
  const session = Object.freeze({
    step: "doc_client",
    mode: "facture",
    lastDocDraft: Object.freeze({ type: "facture" }),
  });
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: {
      run(input) {
        calls.push(structuredClone(input));
        return Promise.resolve(PUBLIC_RESULT);
      },
    },
    onResult(result) {
      observed.push(result);
    },
  });
  const before = JSON.stringify(session);
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage(),
    session,
  }), true);
  assert.equal(calls.length, 1);
  assert.equal(observed.length, 0);
  await flushDetached();
  assert.equal(observed.length, 1);
  assert.notStrictEqual(observed[0], PUBLIC_RESULT);
  assert.deepEqual(observed[0], PUBLIC_RESULT);
  assert.equal(observed[0].actionable, true);
  assert.equal(observed[0].execution, "NONE");
  assert.equal(JSON.stringify(session), before);
});

test("all bounded runner statuses leave the integration non-executing", async () => {
  const statuses = [
    "SKIPPED", "SKIPPED_DUPLICATE", "INPUT_INVALID", "CONFIG_UNAVAILABLE",
    "PRIVACY_BLOCKED", "PROVIDER_FAILED", "PARSE_FAILED", "SUCCEEDED",
    "INTERNAL_FAILED", "TIMEOUT",
  ];
  for (const status of statuses) {
    const observed = [];
    configureBrainRealShadowIntegration({
      mode: "shadow",
      runner: {
        run: () => Promise.resolve({
          ...PUBLIC_RESULT,
          status,
          actionable: false,
          execution: "NONE",
        }),
      },
      onResult: (result) => observed.push(result),
    });
    assert.equal(launchBrainRealShadowObservation({
      text: "Créer une facture",
      msg: textMessage({ id: `status-${status}` }),
      session: { step: "idle" },
    }), true);
    await flushDetached();
    assert.equal(observed.length, 1);
    assert.equal(observed[0].status, status);
    assert.equal(observed[0].execution, "NONE");
  }
});

test("runner throws and early or late rejections are fully absorbed", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    for (const [index, run] of [
      () => { throw new Error("PRIVATE_SYNC"); },
      () => Promise.reject(new Error("PRIVATE_REJECT")),
      () => new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("PRIVATE_LATE")), 5);
      }),
    ].entries()) {
      configureBrainRealShadowIntegration({
        mode: "shadow",
        runner: { run },
      });
      launchBrainRealShadowObservation({
        text: "Créer une facture",
        msg: textMessage({ id: `failure-${index}` }),
        session: { step: "idle" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("hostile thenables cannot throw into legacy or create multiple observations", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const cases = [
      { get then() { throw new Error("PRIVATE_THEN_GETTER"); } },
      { then() { throw new Error("PRIVATE_THEN_METHOD"); } },
      { then(resolve) { resolve(PUBLIC_RESULT); resolve(PUBLIC_RESULT); } },
      { then(resolve, reject) { resolve(PUBLIC_RESULT); reject(new Error("late")); } },
      { then(resolve, reject) { reject(new Error("first")); resolve(PUBLIC_RESULT); } },
      { then(resolve) { setTimeout(() => resolve(PUBLIC_RESULT), 5); } },
      { then(resolve) { resolve({ ...PUBLIC_RESULT, rawMessage: "PRIVATE_RAW" }); } },
    ];
    for (const [index, thenable] of cases.entries()) {
      const observed = [];
      configureBrainRealShadowIntegration({
        mode: "shadow",
        runner: { run: () => thenable },
        onResult: (value) => observed.push(value),
      });
      assert.doesNotThrow(() => launchBrainRealShadowObservation({
        text: "Créer une facture",
        msg: textMessage({ id: `thenable-${index}` }),
        session: { step: "idle" },
      }));
      await flushLateDetached();
      assert.ok(observed.length <= 1);
      assert.equal(JSON.stringify(observed).includes("PRIVATE_RAW"), false);
    }
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("multiple asynchronous thenable callbacks still produce one hook maximum", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    for (const [index, thenable] of [
      {
        then(resolve, reject) {
          setTimeout(() => resolve(PUBLIC_RESULT), 0);
          setTimeout(() => resolve({ ...PUBLIC_RESULT, rawMessage: "PRIVATE_LATE" }), 1);
          setTimeout(() => reject(new Error("PRIVATE_LATE_REJECT")), 2);
        },
      },
      {
        then(resolve, reject) {
          reject(new Error("PRIVATE_FIRST_REJECT"));
          setTimeout(() => resolve(PUBLIC_RESULT), 1);
          setTimeout(() => reject(new Error("PRIVATE_SECOND_REJECT")), 2);
        },
      },
    ].entries()) {
      const observed = [];
      configureBrainRealShadowIntegration({
        mode: "shadow",
        runner: { run: () => thenable },
        onResult: (result) => observed.push(result),
      });
      assert.doesNotThrow(() => launchBrainRealShadowObservation({
        text: "Créer une facture",
        msg: textMessage({ id: `async-thenable-${index}` }),
        session: { step: "idle" },
      }));
      await flushLateDetached();
      assert.ok(observed.length <= 1);
      assert.equal(JSON.stringify(observed).includes("PRIVATE_LATE"), false);
    }
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("malicious runner values never cross the canonical hook boundary", async () => {
  const maliciousObject = {
    ...PUBLIC_RESULT,
    messageId: "PRIVATE_MESSAGE_ID",
    userMessage: "PRIVATE_USER_MESSAGE",
    flowContext: { raw: "PRIVATE_FLOW" },
    session: { token: "PRIVATE_SESSION" },
    prompt: "PRIVATE_PROMPT",
    providerResponse: "PRIVATE_PROVIDER",
    stack: "PRIVATE_STACK",
    error: new Error("PRIVATE_ERROR"),
    unknown: "PRIVATE_UNKNOWN",
    execution: "EXECUTE",
  };
  Object.defineProperty(maliciousObject, "hostile", {
    enumerable: true,
    get() { throw new Error("PRIVATE_GETTER"); },
  });
  const cyclic = { ...PUBLIC_RESULT };
  cyclic.self = cyclic;
  const hostileProxy = new Proxy({}, {
    getPrototypeOf() { throw new Error("PRIVATE_PROXY"); },
  });
  const cases = [
    maliciousObject, cyclic, hostileProxy, [], "string", null, undefined,
  ];
  for (const [index, runnerValue] of cases.entries()) {
    const observed = [];
    configureBrainRealShadowIntegration({
      mode: "shadow",
      runner: { run: () => runnerValue },
      onResult: (value) => observed.push(value),
    });
    assert.doesNotThrow(() => launchBrainRealShadowObservation({
      text: "Créer une facture pour PRIVATE_CLIENT",
      msg: textMessage({ id: `PRIVATE_INPUT_ID_${index}` }),
      session: { token: "PRIVATE_INPUT_SESSION" },
    }));
    await flushDetached();
    assert.ok(observed.length <= 1);
    const serialized = JSON.stringify(observed);
    for (const sentinel of [
      "PRIVATE_MESSAGE_ID", "PRIVATE_USER_MESSAGE", "PRIVATE_FLOW",
      "PRIVATE_SESSION", "PRIVATE_PROMPT", "PRIVATE_PROVIDER",
      "PRIVATE_STACK", "PRIVATE_ERROR", "PRIVATE_UNKNOWN", "PRIVATE_CLIENT",
      "PRIVATE_INPUT_ID", "PRIVATE_INPUT_SESSION",
    ]) assert.equal(serialized.includes(sentinel), false);
    if (observed.length) {
      assert.deepEqual(Object.keys(observed[0]), Object.keys(PUBLIC_RESULT));
      assert.equal(observed[0].execution, "NONE");
    }
  }
});

test("projection normalizes invalid enums, hash and counts without arbitrary reads", () => {
  const value = projectBrainShadowResultForObservation({
    shadowVersion: "PRIVATE_VERSION",
    status: "PRIVATE_STATUS",
    sourceType: "PRIVATE_SOURCE",
    messageIdHash: "PRIVATE_RAW_ID",
    providerStatus: "PRIVATE_PROVIDER",
    providerFailureKind: "PRIVATE_FAILURE",
    parserValid: "yes",
    parserFailureCode: "PRIVATE_PARSE",
    intent: "private intent",
    confidenceBucket: "PRIVATE_CONFIDENCE",
    actionable: "yes",
    missingFieldCount: 100000,
    blockingAmbiguityCount: -1,
    safetyFlags: { containsSensitiveData: true, extra: "PRIVATE_SAFETY" },
    latencyBucket: "PRIVATE_LATENCY",
    execution: "EXECUTE",
    timestamp: "PRIVATE_TIMESTAMP",
  });
  assert.deepEqual(value, {
    shadowVersion: "kadi.brain-real-shadow.v1",
    status: "INTERNAL_FAILED",
    sourceType: null,
    messageIdHash: null,
    providerStatus: null,
    providerFailureKind: "NONE",
    parserValid: false,
    parserFailureCode: null,
    intent: null,
    confidenceBucket: "NONE",
    actionable: false,
    missingFieldCount: 0,
    blockingAmbiguityCount: 0,
    safetyFlags: { containsSensitiveData: true, requiresHumanReview: false },
    latencyBucket: "NONE",
    execution: "NONE",
    timestamp: null,
  });
});

test("hook receives a distinct deeply frozen result that cannot be enriched", async () => {
  const source = { ...PUBLIC_RESULT, safetyFlags: { ...PUBLIC_RESULT.safetyFlags } };
  let retained;
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: { run: () => source },
    onResult(result) {
      retained = result;
      assert.throws(() => { result.status = "INJECTED"; }, TypeError);
      assert.throws(() => { result.rawMessage = "secret"; }, TypeError);
      assert.throws(() => { result.safetyFlags.foo = true; }, TypeError);
      assert.throws(() => { result.safetyFlags = {}; }, TypeError);
      assert.throws(() => { delete result.execution; }, TypeError);
    },
  });
  launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage(),
    session: Object.freeze({ step: "idle" }),
  });
  await flushDetached();
  assert.notStrictEqual(retained, source);
  assert.notStrictEqual(retained.safetyFlags, source.safetyFlags);
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Object.isFrozen(retained.safetyFlags), true);
  assert.equal(retained.execution, "NONE");
});

test("hostile hooks are absorbed and invoked at most once", async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const hooks = [
      () => { throw new Error("PRIVATE_HOOK_THROW"); },
      () => Promise.reject(new Error("PRIVATE_HOOK_REJECT")),
      () => new Promise((resolve) => setTimeout(resolve, 5)),
      () => ({ get then() { throw new Error("PRIVATE_HOOK_THENABLE"); } }),
    ];
    for (const [index, hook] of hooks.entries()) {
      let calls = 0;
      configureBrainRealShadowIntegration({
        mode: "shadow",
        runner: { run: () => PUBLIC_RESULT },
        onResult(value) { calls += 1; return hook(value); },
      });
      assert.doesNotThrow(() => launchBrainRealShadowObservation({
        text: "Créer une facture",
        msg: textMessage({ id: `hook-${index}` }),
        session: Object.freeze({ step: "idle" }),
      }));
      await flushLateDetached();
      assert.equal(calls, 1);
    }
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("constructor failure is latched until a new integration instance", () => {
  let constructions = 0;
  const factory = () => {
    constructions += 1;
    throw new Error("PRIVATE_CONSTRUCTOR");
  };
  configureBrainRealShadowIntegration({ mode: "shadow", runnerFactory: factory });
  for (const id of ["first", "second"]) {
    assert.equal(launchBrainRealShadowObservation({
      text: "Créer une facture",
      msg: textMessage({ id }),
      session: { step: "idle" },
    }), false);
  }
  assert.equal(constructions, 1);
  configureBrainRealShadowIntegration({ mode: "shadow", runnerFactory: factory });
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage({ id: "new-instance" }),
    session: { step: "idle" },
  }), false);
  assert.equal(constructions, 2);
});

test("same-turn admissible messages construct one synchronous runner singleton", () => {
  let constructions = 0;
  const calls = [];
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runnerFactory() {
      constructions += 1;
      return { run(input) { calls.push(input.messageId); return PUBLIC_RESULT; } };
    },
  });
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture", msg: textMessage({ id: "same-turn-a" }),
    session: { step: "idle" },
  }), true);
  assert.equal(launchBrainRealShadowObservation({
    text: "Créer une facture", msg: textMessage({ id: "same-turn-b" }),
    session: { step: "idle" },
  }), true);
  assert.equal(constructions, 1);
  assert.deepEqual(calls, ["same-turn-a", "same-turn-b"]);
});

test("mode matrix keeps the engine closed except canonical shadow", () => {
  const previousMode = process.env.KADI_BRAIN_MODE;
  const previousLegacy = process.env.KADI_BRAIN_SHADOW_ENABLED;
  const cases = [
    [undefined, undefined, false], [undefined, "true", true],
    ["off", undefined, false], ["shadow", undefined, true],
    ["SHADOW", undefined, true], [" shadow ", undefined, true],
    ["candidate", "true", false], ["active_allowlist", "true", false],
    ["active", "true", false], ["invalid", "true", false],
    [undefined, "false", false],
  ];
  try {
    for (const [mode, legacy, expected] of cases) {
      if (mode === undefined) delete process.env.KADI_BRAIN_MODE;
      else process.env.KADI_BRAIN_MODE = mode;
      if (legacy === undefined) delete process.env.KADI_BRAIN_SHADOW_ENABLED;
      else process.env.KADI_BRAIN_SHADOW_ENABLED = legacy;
      let calls = 0;
      configureBrainRealShadowIntegration({
        runner: { run: () => { calls += 1; return PUBLIC_RESULT; } },
      });
      assert.equal(launchBrainRealShadowObservation({
        text: "Créer une facture", msg: textMessage({ id: `mode-${String(mode)}-${legacy}` }),
        session: { step: "idle" },
      }), expected);
      assert.equal(calls, expected ? 1 : 0);
    }
  } finally {
    if (previousMode === undefined) delete process.env.KADI_BRAIN_MODE;
    else process.env.KADI_BRAIN_MODE = previousMode;
    if (previousLegacy === undefined) delete process.env.KADI_BRAIN_SHADOW_ENABLED;
    else process.env.KADI_BRAIN_SHADOW_ENABLED = previousLegacy;
  }
});

test("successful constructor is a singleton and runner owns id handling", async () => {
  let constructions = 0;
  const ids = [];
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runnerFactory() {
      constructions += 1;
      return { run(input) { ids.push(input.messageId); return PUBLIC_RESULT; } };
    },
  });
  for (const id of ["identique", "identique", "unicode-🔒", "x".repeat(300)]) {
    assert.equal(launchBrainRealShadowObservation({
      text: "Même texte",
      msg: textMessage({ id }),
      session: { step: "idle" },
    }), true);
  }
  await flushDetached();
  assert.equal(constructions, 1);
  assert.deepEqual(ids, ["identique", "identique", "unicode-🔒", "x".repeat(300)]);
});

test("sensitive session and draft values never reach flow context or hook", async () => {
  const sensitive = {
    clientName: "PRIVATE_CLIENT", phone: "PRIVATE_PHONE",
    email: "PRIVATE_EMAIL", address: "PRIVATE_ADDRESS", IFU: "PRIVATE_IFU",
    RCCM: "PRIVATE_RCCM", waId: "PRIVATE_WA", BSUID: "PRIVATE_BSUID",
    OCR: "PRIVATE_OCR", paymentProof: "PRIVATE_PROOF", recharge: "PRIVATE_RECHARGE",
    token: "PRIVATE_TOKEN", key: "PRIVATE_KEY", history: "PRIVATE_HISTORY",
    restorationMap: "PRIVATE_RESTORE", montant: 99991, prix: 99992,
    articles: [{ label: "PRIVATE_ARTICLE" }],
  };
  const session = Object.freeze({
    step: "doc_client", mode: "facture", ...sensitive,
    lastDocDraft: Object.freeze({ type: "facture", ...sensitive }),
  });
  let input;
  let hookValue;
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: { run(value) { input = value; return PUBLIC_RESULT; } },
    onResult(value) { hookValue = value; },
  });
  launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage(),
    session,
  });
  await flushDetached();
  const serialized = JSON.stringify({ flowContext: input.flowContext, hookValue });
  for (const marker of Object.values(sensitive).flatMap((value) =>
    typeof value === "string" ? [value] : []
  )) assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("99991"), false);
  assert.equal(serialized.includes("99992"), false);
  assert.equal(serialized.includes("PRIVATE_ARTICLE"), false);
});

test("voice projection keeps only business text and bounded context", async () => {
  const frozenSession = Object.freeze({
    step: "doc_client",
    mode: "facture",
    clientName: "PRIVATE_CLIENT",
    lastDocDraft: Object.freeze({
      type: "facture", phone: "PRIVATE_PHONE", amount: 99999,
    }),
  });
  let input;
  let observed;
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: { run(value) { input = value; return PUBLIC_RESULT; } },
    onResult(value) { observed = value; },
  });
  launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage({
      id: "voice-🔒-original",
      audioTranscript: {
        raw: "PRIVATE_RAW_TRANSCRIPT",
        mediaId: "PRIVATE_MEDIA_ID",
        buffer: "PRIVATE_BUFFER",
        url: "PRIVATE_URL",
        detectedLanguages: ["fr"],
      },
    }),
    session: frozenSession,
  });
  await flushDetached();
  assert.equal(input.sourceType, "voice");
  assert.equal(input.userMessage, "Créer une facture");
  assert.equal(input.messageId, "voice-🔒-original");
  assert.deepEqual(Object.keys(input.flowContext), [
    "stepCategory", "activeFlow", "activeDocumentType", "hasActiveDraft",
    "expectedFieldNames", "messageType",
  ]);
  const serialized = JSON.stringify({ input, observed });
  for (const marker of [
    "PRIVATE_RAW_TRANSCRIPT", "PRIVATE_MEDIA_ID", "PRIVATE_BUFFER",
    "PRIVATE_URL", "PRIVATE_CLIENT", "PRIVATE_PHONE", "99999",
  ]) assert.equal(serialized.includes(marker), false);
});

test("a delayed runner never blocks legacy continuation", async () => {
  let release;
  let settled = false;
  let observations = 0;
  const delayed = new Promise((resolve) => { release = resolve; });
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: { run: () => delayed },
    onResult: () => { observations += 1; },
  });
  const launched = launchBrainRealShadowObservation({
    text: "Créer une facture",
    msg: textMessage(),
    session: { step: "idle" },
  });
  Promise.resolve(delayed).then(() => { settled = true; });
  assert.equal(launched, true);
  assert.equal(settled, false);
  assert.equal(observations, 0);
  release(PUBLIC_RESULT);
  await flushDetached();
  assert.equal(settled, true);
  assert.equal(observations, 1);
});

test("the observability hook receives only the bounded runner result", async () => {
  let hookValue;
  configureBrainRealShadowIntegration({
    mode: "shadow",
    runner: { run: () => Promise.resolve(PUBLIC_RESULT) },
    onResult: (result) => { hookValue = result; },
  });
  launchBrainRealShadowObservation({
    text: "Créer une facture pour PRIVATE_CLIENT",
    msg: textMessage({ id: "PRIVATE_MESSAGE_ID" }),
    session: {
      step: "doc_client",
      waId: "PRIVATE_WA_ID",
      lastDocDraft: { clientName: "PRIVATE_CLIENT" },
    },
  });
  await flushDetached();
  const serialized = JSON.stringify(hookValue);
  for (const sentinel of [
    "PRIVATE_CLIENT", "PRIVATE_MESSAGE_ID", "PRIVATE_WA_ID",
  ]) assert.equal(serialized.includes(sentinel), false);
  assert.deepEqual(hookValue, PUBLIC_RESULT);
});

test("runner-owned deduplication keeps one Provider effect per instance", async () => {
  let providerEffects = 0;
  const seen = new Set();
  const runner = {
    run({ messageId }) {
      if (seen.has(messageId)) {
        return Promise.resolve({
          ...PUBLIC_RESULT,
          status: "SKIPPED_DUPLICATE",
        });
      }
      seen.add(messageId);
      providerEffects += 1;
      return Promise.resolve(PUBLIC_RESULT);
    },
  };
  configureBrainRealShadowIntegration({ mode: "shadow", runner });
  for (let index = 0; index < 2; index += 1) {
    launchBrainRealShadowObservation({
      text: "Créer une facture",
      msg: textMessage(),
      session: { step: "idle" },
    });
  }
  await flushDetached();
  assert.equal(providerEffects, 1);
});

test("engine source has one detached Gemini shadow and no historical double call", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiEngine.js"),
    "utf8"
  );
  const handlerStart = source.indexOf("async function handleTextMessage");
  const handlerEnd = source.indexOf("async function handleInteractiveMessage");
  const handler = source.slice(handlerStart, handlerEnd);
  const launchIndex = handler.indexOf("launchBrainRealShadowObservation");
  assert.ok(handler.indexOf("handleAdminCommand") < launchIndex);
  assert.ok(handler.indexOf("safeHandleSupportText") < launchIndex);
  assert.ok(handler.indexOf("isHardGlobalInterrupt") < launchIndex);
  assert.ok(handler.indexOf("handleCommand") < launchIndex);
  assert.equal(
    (handler.match(/launchBrainRealShadowObservation\(/gu) || []).length,
    1
  );
  assert.doesNotMatch(handler, /await\s+launchBrainRealShadowObservation/gu);
  assert.doesNotMatch(handler, /brainShadow\.observeText/gu);
  assert.doesNotMatch(handler, /result\.(?:intent|actionable|providerStatus)/gu);
  assert.doesNotMatch(source, /console\.(?:log|warn|error).*brainRealShadow/giu);
});
