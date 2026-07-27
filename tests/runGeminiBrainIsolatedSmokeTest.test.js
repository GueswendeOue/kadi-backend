"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const providerContract = require("../kadiBrainProviderContract");
const intentContract = require("../kadiBrainIntentContract");
const smoke = require("../scripts/runGeminiBrainIsolatedSmokeTest");

function resolutionJson() {
  const resolution = intentContract.createEmptyIntentResolution();
  resolution.intent = "CREATE_INVOICE";
  resolution.confidence = 0.99;
  resolution.language = "fr";
  resolution.entities.documentType = "invoice";
  resolution.entities.clientName = "PERSON_1";
  resolution.entities.amount = 25000;
  resolution.entities.currency = "XOF";
  resolution.requestedAction = {
    type: "CREATE_INVOICE",
    target: "invoice",
  };
  return JSON.stringify(resolution);
}

function successfulProviderResponse() {
  const response = providerContract.createEmptyProviderResponse();
  response.provider = "GEMINI";
  response.model = smoke.KADI_GEMINI_SMOKE_MODEL;
  response.status = "SUCCEEDED";
  response.ok = true;
  response.content = resolutionJson();
  response.errorCode = "NONE";
  response.failureKind = "NONE";
  response.usage = { inputUnits: 12, outputUnits: 8, totalUnits: 20 };
  response.metadata = { providerRequestId: null, finishReason: "STOP" };
  return response;
}

function harness(overrides = {}) {
  let clientCreations = 0;
  let providerCreations = 0;
  let invocations = 0;
  const outputs = [];
  const options = {
    apiKey: ["OBVIOUSLY", "FAKE", "TEST", "VALUE"].join("_"),
    createRealClient() {
      clientCreations += 1;
      return Object.freeze({ generateContent: async () => null });
    },
    createProvider() {
      providerCreations += 1;
      return {
        async invoke() {
          invocations += 1;
          return successfulProviderResponse();
        },
      };
    },
    output(value) {
      outputs.push(value);
    },
    ...overrides,
  };
  return {
    options,
    counts: () => ({ clientCreations, providerCreations, invocations }),
    outputs,
  };
}

test("exports exact smoke constants and fresh dependencies", () => {
  assert.equal(smoke.KADI_GEMINI_SMOKE_VERSION, "kadi.gemini-isolated-smoke.v1");
  assert.equal(smoke.KADI_GEMINI_SMOKE_MODEL, "gemini-2.5-flash");
  assert.equal(
    smoke.KADI_GEMINI_SMOKE_MESSAGE,
    "Créer une facture de 25000 FCFA pour PERSON_1"
  );
  const first = smoke.createGeminiSmokeDependencies();
  const second = smoke.createGeminiSmokeDependencies();
  assert.notStrictEqual(first, second);
});

test("missing and empty keys fail before any client creation", async () => {
  for (const apiKey of [undefined, null, "", "   "]) {
    const setup = harness({ apiKey });
    const promise = smoke.runGeminiIsolatedSmokeTest(setup.options);
    assert.equal(promise instanceof Promise, true);
    assert.deepEqual(await promise, {
      exitCode: 1,
      code: "GEMINI_SMOKE_KEY_MISSING",
      publicResult: null,
    });
    assert.deepEqual(setup.counts(), {
      clientCreations: 0, providerCreations: 0, invocations: 0,
    });
  }
});

test("privacy passes before prompt and provider construction", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.publicResult.privacySafe, true);
  assert.deepEqual(setup.counts(), {
    clientCreations: 1, providerCreations: 1, invocations: 1,
  });
});

test("simulated privacy rejection prevents client and provider creation", async () => {
  const setup = harness({
    dependencies: {
      sanitizePrivacyInput() {
        return { allowed: false };
      },
      isPrivacySafeForProvider() {
        return false;
      },
    },
  });
  assert.equal(
    (await smoke.runGeminiIsolatedSmokeTest(setup.options)).code,
    "GEMINI_SMOKE_PRIVACY_REJECTED"
  );
  assert.deepEqual(setup.counts(), {
    clientCreations: 0, providerCreations: 0, invocations: 0,
  });
});

test("invalid prompt or provider request prevents all invocation", async () => {
  for (const dependencies of [
    { buildIntentResolutionMessages: () => ({ valid: false, messages: [] }) },
    { validateProviderRequest: () => ({ valid: false, errors: [] }) },
  ]) {
    const setup = harness({ dependencies });
    const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
    assert.equal(result.exitCode, 3);
    assert.equal(result.code, "GEMINI_SMOKE_REQUEST_INVALID");
    assert.deepEqual(setup.counts(), {
      clientCreations: 0, providerCreations: 0, invocations: 0,
    });
  }
});

test("canonical request is minimized, valid, and invokes the provider once", async () => {
  let captured;
  const setup = harness({
    createProvider() {
      return {
        async invoke(input) {
          captured = input;
          return successfulProviderResponse();
        },
      };
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.exitCode, 0);
  assert.equal(providerContract.validateProviderRequest(captured.providerRequest).valid, true);
  assert.equal(captured.providerRequest.provider, "GEMINI");
  assert.equal(captured.providerRequest.model, "gemini-2.5-flash");
  assert.equal(captured.providerRequest.generation.temperature, 0);
  assert.deepEqual(captured.providerRequest.responseFormat, { type: "json_object" });
  assert.equal(Object.hasOwn(captured, "restorationMap"), false);
  assert.equal(Object.hasOwn(captured.providerRequest, "apiKey"), false);
});

test("provider failure is minimized and is never retried", async () => {
  let calls = 0;
  const setup = harness({
    createProvider() {
      return {
        async invoke() {
          calls += 1;
          const response = successfulProviderResponse();
          response.status = "FAILED";
          response.ok = false;
          response.content = null;
          response.errorCode = "PROVIDER_UNAVAILABLE";
          response.failureKind = "PROVIDER";
          response.recoverable = true;
          response.metadata.finishReason = "ERROR";
          return response;
        },
      };
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    exitCode: 4,
    code: "GEMINI_SMOKE_PROVIDER_FAILED",
    publicResult: null,
  });
});

test("invalid provider response is rejected before parsing", async () => {
  const setup = harness({
    createProvider: () => ({ invoke: async () => ({ raw: "PRIVATE" }) }),
  });
  assert.deepEqual(await smoke.runGeminiIsolatedSmokeTest(setup.options), {
    exitCode: 5,
    code: "GEMINI_SMOKE_RESPONSE_INVALID",
    publicResult: null,
  });
});

test("parser success reports CREATE_INVOICE but execution remains NONE", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.equal(result.publicResult.parserValid, true);
  assert.equal(result.publicResult.intent, "CREATE_INVOICE");
  assert.equal(result.publicResult.actionable, false);
  assert.equal(result.publicResult.execution, "NONE");
});

test("parser failure is minimized with exit code six", async () => {
  const setup = harness({
    dependencies: {
      parseIntentResolutionResponse: () => ({
        ok: false, validation: null, resolution: null,
      }),
    },
  });
  assert.deepEqual(await smoke.runGeminiIsolatedSmokeTest(setup.options), {
    exitCode: 6,
    code: "GEMINI_SMOKE_PARSE_FAILED",
    publicResult: null,
  });
});

test("public success output is exact, minimized, and contains no private pipeline data", async () => {
  const setup = harness();
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.deepEqual(result.publicResult, {
    smokeVersion: "kadi.gemini-isolated-smoke.v1",
    model: "gemini-2.5-flash",
    privacySafe: true,
    providerRequestValid: true,
    providerStatus: "SUCCEEDED",
    providerResponseValid: true,
    parserValid: true,
    intent: "CREATE_INVOICE",
    actionable: false,
    execution: "NONE",
    usage: { inputUnits: 12, outputUnits: 8, totalUnits: 20 },
  });
  const serialized = JSON.stringify(result.publicResult);
  for (const forbidden of [
    smoke.KADI_GEMINI_SMOKE_MESSAGE, "PERSON_1", "system", "prompt",
    "restorationMap", "sanitizedInput", "providerRequestId",
    setup.options.apiKey,
  ]) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(setup.outputs, [result.publicResult]);
});

test("usage accepts only the already canonical provider usage", async () => {
  const setup = harness({
    createProvider: () => ({
      invoke: async () => {
        const response = successfulProviderResponse();
        response.usage = { inputUnits: null, outputUnits: null, totalUnits: null };
        return response;
      },
    }),
  });
  assert.deepEqual(
    (await smoke.runGeminiIsolatedSmokeTest(setup.options)).publicResult.usage,
    { inputUnits: null, outputUnits: null, totalUnits: null }
  );
});

test("same frozen inputs produce deterministic independent results without mutation", async () => {
  const options = harness().options;
  Object.freeze(options);
  const before = JSON.stringify(options);
  const first = await smoke.runGeminiIsolatedSmokeTest(options);
  const second = await smoke.runGeminiIsolatedSmokeTest(options);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.publicResult, second.publicResult);
  assert.notStrictEqual(first.publicResult.usage, second.publicResult.usage);
  assert.equal(JSON.stringify(options), before);
});

test("internal exceptions expose only the public code and never the fake key", async () => {
  const setup = harness({
    createRealClient() {
      throw new Error(setup.options.apiKey);
    },
  });
  const result = await smoke.runGeminiIsolatedSmokeTest(setup.options);
  assert.deepEqual(result, {
    exitCode: 7,
    code: "GEMINI_SMOKE_INTERNAL_FAILURE",
    publicResult: null,
  });
  assert.equal(JSON.stringify(result).includes(setup.options.apiKey), false);
});

test("source remains isolated, storage-free, network-free, and execution-free", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "runGeminiBrainIsolatedSmokeTest.js"),
    "utf8"
  );
  for (const forbidden of [
    "Supabase", "createClient(", 'require("fs")', "writeFile", "appendFile",
    "readFile", "Redis", "database", "webhook", "sendMessage", "WhatsApp",
    "createInvoice", "createQuote", "createReceipt", "debitCredit",
    "executeIntent", "dispatch", "axios", "fetch(", 'require("http")',
    'require("https")', "retry", "backoff", "setInterval", "child_process",
    "eval(", "new Function", "Date.now", "Math.random", "UUID",
    "dotenv", "GOOGLE_API_KEY", "console.dir", "console.table", "logger",
    "telemetry", "analytics",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(
    (source.match(/process\.env\.GEMINI_API_KEY/g) || []).length,
    1
  );
  assert.equal(
    source.replace("process.env.GEMINI_API_KEY", "").includes("process.env"),
    false
  );
  assert.equal(source.includes("if (require.main === module)"), true);
  assert.equal(source.includes("execution: \"NONE\""), true);
});

test("tests use only an obviously fictitious injected key and never construct the real SDK", () => {
  const source = fs.readFileSync(__filename, "utf8");
  const googleKeyPrefix = ["AI", "za"].join("");
  const sdkPackage = ["@google", "genai"].join("/");
  assert.equal(source.includes(googleKeyPrefix), false);
  assert.equal(source.includes(sdkPackage), false);
});
