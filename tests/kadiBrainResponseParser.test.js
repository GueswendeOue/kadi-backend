"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  KADI_MODEL_RESPONSE_SCHEMA_VERSION,
  KADI_MAX_MODEL_RESPONSE_LENGTH,
  KADI_PARSE_ERROR_CODES,
  createEmptyParseResult,
  extractStrictJsonObject,
  parseIntentResolutionResponse,
} = require("../kadiBrainResponseParser");
const {
  KADI_INTENT_SCHEMA_VERSION,
  createEmptyIntentResolution,
} = require("../kadiBrainIntentContract");

function createValidResolution(overrides = {}) {
  const resolution = createEmptyIntentResolution();
  resolution.intent = "CREATE_INVOICE";
  resolution.confidence = 0.95;
  resolution.entities.documentType = "invoice";
  resolution.entities.clientName = "Awa Boutique";
  resolution.entities.items = [
    {
      description: "Chemise",
      quantity: 10,
      unitPrice: 7500,
      unit: null,
      total: null,
    },
  ];
  return {
    ...resolution,
    ...overrides,
  };
}

function parseJson(value) {
  return parseIntentResolutionResponse(JSON.stringify(value));
}

test("exports protected parser constants with the expected versions", () => {
  assert.equal(
    KADI_MODEL_RESPONSE_SCHEMA_VERSION,
    "kadi.model-response.v1"
  );
  assert.equal(KADI_MAX_MODEL_RESPONSE_LENGTH, 32000);
  assert.equal(Object.isFrozen(KADI_PARSE_ERROR_CODES), true);
  assert.deepEqual(Object.values(KADI_PARSE_ERROR_CODES), [
    "EMPTY_RESPONSE",
    "RESPONSE_NOT_STRING",
    "RESPONSE_TOO_LONG",
    "MARKDOWN_NOT_ALLOWED",
    "SURROUNDING_TEXT_NOT_ALLOWED",
    "INVALID_JSON",
    "ROOT_NOT_OBJECT",
    "MULTIPLE_JSON_VALUES",
    "INVALID_SCHEMA",
    "INVALID_RESOLUTION",
    "UNSAFE_VALUE",
    "INTERNAL_PARSE_FAILURE",
  ]);
});

test("createEmptyParseResult returns complete independent structures", () => {
  const first = createEmptyParseResult();
  const second = createEmptyParseResult();

  assert.deepEqual(first, {
    schemaVersion: "kadi.model-response.v1",
    ok: false,
    errorCode: null,
    errors: [],
    rawJson: null,
    parsedValue: null,
    resolution: null,
    validation: null,
    actionable: false,
  });
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.errors, second.errors);
  first.errors.push("changed");
  assert.deepEqual(second.errors, []);
});

test("extractStrictJsonObject accepts only one exact JSON object", () => {
  const extracted = extractStrictJsonObject(' \n {"value":1} \t');

  assert.equal(extracted.ok, true);
  assert.equal(extracted.rawJson, '{"value":1}');
  assert.deepEqual(extracted.parsedValue, { value: 1 });
});

test("rejects non-string, empty, and oversized responses by Unicode points", () => {
  for (const value of [null, undefined, 12, {}, []]) {
    assert.equal(
      extractStrictJsonObject(value).errorCode,
      KADI_PARSE_ERROR_CODES.RESPONSE_NOT_STRING
    );
  }

  assert.equal(
    extractStrictJsonObject(" \n\t ").errorCode,
    KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE
  );

  const exactLength = `"${"😀".repeat(
    KADI_MAX_MODEL_RESPONSE_LENGTH - 2
  )}"`;
  assert.equal(
    Array.from(exactLength).length,
    KADI_MAX_MODEL_RESPONSE_LENGTH
  );
  assert.equal(
    extractStrictJsonObject(exactLength).errorCode,
    KADI_PARSE_ERROR_CODES.ROOT_NOT_OBJECT
  );

  const tooLong = `${exactLength}😀`;
  const result = extractStrictJsonObject(tooLong);
  assert.equal(result.errorCode, KADI_PARSE_ERROR_CODES.RESPONSE_TOO_LONG);
  assert.equal(result.rawJson, null);
});

test("rejects Markdown wrappers", () => {
  for (const raw of [
    '```json\n{"value":1}\n```',
    '~~~json\n{"value":1}\n~~~',
  ]) {
    assert.equal(
      extractStrictJsonObject(raw).errorCode,
      KADI_PARSE_ERROR_CODES.MARKDOWN_NOT_ALLOWED
    );
  }
});

test("rejects text before or after a JSON object", () => {
  assert.equal(
    extractStrictJsonObject('Voici: {"value":1}').errorCode,
    KADI_PARSE_ERROR_CODES.SURROUNDING_TEXT_NOT_ALLOWED
  );
  assert.equal(
    extractStrictJsonObject('{"value":1} terminé').errorCode,
    KADI_PARSE_ERROR_CODES.SURROUNDING_TEXT_NOT_ALLOWED
  );
});

test("rejects multiple JSON values", () => {
  for (const raw of [
    '{"first":1} {"second":2}',
    '{"first":1} true',
    '{"first":1} [2]',
  ]) {
    assert.equal(
      extractStrictJsonObject(raw).errorCode,
      KADI_PARSE_ERROR_CODES.MULTIPLE_JSON_VALUES
    );
  }
});

test("rejects invalid JSON, arrays, and primitive roots", () => {
  assert.equal(
    extractStrictJsonObject('{"broken":}').errorCode,
    KADI_PARSE_ERROR_CODES.INVALID_JSON
  );

  for (const raw of ["[]", "null", "true", "42", '"text"']) {
    assert.equal(
      extractStrictJsonObject(raw).errorCode,
      KADI_PARSE_ERROR_CODES.ROOT_NOT_OBJECT
    );
  }
});

test("parses and validates a canonical actionable resolution", () => {
  const input = createValidResolution();
  const result = parseJson(input);

  assert.equal(result.ok, true);
  assert.equal(result.errorCode, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.validation.valid, true);
  assert.equal(result.actionable, true);
  assert.deepEqual(result.resolution, input);
  assert.notStrictEqual(result.parsedValue, input);
  assert.notStrictEqual(result.resolution, result.parsedValue);
  assert.notStrictEqual(
    result.resolution.entities.items[0],
    result.parsedValue.entities.items[0]
  );
});

test("rejects an unexpected intent schema version", () => {
  const input = createValidResolution({
    schemaVersion: "kadi.intent.v2",
  });
  const result = parseJson(input);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, KADI_PARSE_ERROR_CODES.INVALID_SCHEMA);
  assert.equal(result.resolution, null);
  assert.equal(result.actionable, false);
});

test("rejects a structurally invalid intent resolution", () => {
  const input = createValidResolution({ confidence: "high" });
  const result = parseJson(input);

  assert.equal(result.ok, false);
  assert.equal(
    result.errorCode,
    KADI_PARSE_ERROR_CODES.INVALID_RESOLUTION
  );
  assert.equal(result.validation.valid, false);
  assert.ok(result.errors.length > 0);
  assert.equal(result.resolution, null);
});

test("returns a valid but non-actionable canonical resolution", () => {
  const input = createEmptyIntentResolution();
  input.intent = "UNKNOWN";
  input.confidence = 1;
  const result = parseJson(input);

  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true);
  assert.equal(result.actionable, false);
  assert.equal(result.resolution.intent, "UNKNOWN");
});

test("removes diagnostic and unknown properties without retaining references", () => {
  const input = createValidResolution();
  input.debug = { trace: "hidden" };
  input.reasoning = "hidden";
  input.entities.chainOfThought = ["hidden"];
  input.entities.systemPrompt = "hidden";
  input.entities.items[0].toolCalls = [{ name: "hidden" }];
  input.unknownRoot = "discarded";
  input.entities.unknownEntity = "discarded";

  const result = parseJson(input);

  assert.equal(result.ok, true);
  assert.equal("debug" in result.parsedValue, false);
  assert.equal("reasoning" in result.parsedValue, false);
  assert.equal("chainOfThought" in result.parsedValue.entities, false);
  assert.equal("systemPrompt" in result.parsedValue.entities, false);
  assert.equal(
    "toolCalls" in result.parsedValue.entities.items[0],
    false
  );
  assert.doesNotMatch(
    result.rawJson,
    /debug|reasoning|chainOfThought|systemPrompt|toolCalls/
  );
  assert.equal("unknownRoot" in result.resolution, false);
  assert.equal("unknownEntity" in result.resolution.entities, false);
});

test("blocks prototype-pollution property names at every depth", () => {
  const unsafePayloads = [
    '{"schemaVersion":"kadi.intent.v1","__proto__":{"polluted":true}}',
    '{"schemaVersion":"kadi.intent.v1","prototype":{"polluted":true}}',
    '{"schemaVersion":"kadi.intent.v1","entities":{"constructor":{}}}',
  ];

  for (const raw of unsafePayloads) {
    const result = parseIntentResolutionResponse(raw);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, KADI_PARSE_ERROR_CODES.UNSAFE_VALUE);
    assert.equal(result.parsedValue, null);
    assert.equal(result.resolution, null);
  }
  assert.equal({}.polluted, undefined);
});

test("produces deterministic results and never shares mutable output", () => {
  const raw = JSON.stringify(createValidResolution());
  const first = parseIntentResolutionResponse(raw);
  const second = parseIntentResolutionResponse(raw);

  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.errors, second.errors);
  assert.notStrictEqual(first.parsedValue, second.parsedValue);
  assert.notStrictEqual(first.resolution, second.resolution);
  assert.notStrictEqual(first.validation, second.validation);
  assert.notStrictEqual(first.validation.errors, second.validation.errors);

  first.resolution.entities.clientName = "Changed";
  first.validation.errors.push("changed");
  assert.equal(second.resolution.entities.clientName, "Awa Boutique");
  assert.deepEqual(second.validation.errors, []);
});

test("uses only the canonical contract and contains no external side effects", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainResponseParser.js"),
    "utf8"
  );
  const imports = Array.from(
    source.matchAll(/require\((["'])(.*?)\1\)/g),
    (match) => match[2]
  );

  assert.deepEqual(imports, ["./kadiBrainIntentContract"]);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|axios|supabase|process\.env|Date\.now|Math\.random|randomUUID|child_process|eval)\b/i
  );
  assert.doesNotMatch(source, /\bopenai\b/i);
});

test("the expected intent schema version is accepted unchanged", () => {
  const result = parseJson(createValidResolution());

  assert.equal(
    result.parsedValue.schemaVersion,
    KADI_INTENT_SCHEMA_VERSION
  );
  assert.equal(result.resolution.schemaVersion, KADI_INTENT_SCHEMA_VERSION);
});
