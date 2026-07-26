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
  resolution.requestedAction = {
    type: "create_document",
    target: "invoice",
  };
  return {
    ...resolution,
    ...overrides,
  };
}

function parseJson(value) {
  return parseIntentResolutionResponse(JSON.stringify(value));
}

function makeExactLengthObject(length, unicode = false) {
  const prefix = '{"value":"';
  const suffix = '"}';
  const fillLength =
    length - Array.from(prefix).length - Array.from(suffix).length;
  const fill = unicode
    ? `😀${"a".repeat(fillLength - 1)}`
    : "a".repeat(fillLength);
  const result = `${prefix}${fill}${suffix}`;
  assert.equal(Array.from(result).length, length);
  return result;
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const result = {};
  for (const key of Object.keys(value).reverse()) {
    result[key] = reverseObjectKeys(value[key]);
  }
  return result;
}

function injectRootProperty(value, key, propertyValue) {
  const raw = JSON.stringify(value);
  return `{${JSON.stringify(key)}:${JSON.stringify(propertyValue)},${raw.slice(
    1
  )}`;
}

function assertPublicFailure(result, errorCode) {
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, errorCode);
  assert.equal(result.rawJson, null);
  assert.equal(result.parsedValue, null);
  assert.equal(result.resolution, null);
  assert.equal(result.validation, null);
  assert.equal(result.actionable, false);
  assert.ok(result.errors.length > 0);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error), ["path", "code"]);
    assert.equal(typeof error.path, "string");
    assert.equal(typeof error.code, "string");
  }
}

test("scenarios 1-5: exports immutable constants and fresh empty results", () => {
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

  const originalCode = KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE;
  assert.throws(() => {
    KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE = "changed";
  }, TypeError);
  assert.equal(KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE, originalCode);
});

test("scenarios 6-13: rejects every non-string and empty response", () => {
  for (const value of [null, undefined, 12, true, {}, []]) {
    assertPublicFailure(
      parseIntentResolutionResponse(value),
      KADI_PARSE_ERROR_CODES.RESPONSE_NOT_STRING
    );
  }
  for (const value of ["", " \n\t "]) {
    assertPublicFailure(
      parseIntentResolutionResponse(value),
      KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE
    );
  }
});

test("scenarios 14-16: extracts exact JSON objects with surrounding whitespace", () => {
  for (const raw of ['{"value":1}', ' \t {"value":1} ', '\n{"value":1}\r\n']) {
    const result = extractStrictJsonObject(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.parsedValue, { value: 1 });
  }
});

test("scenarios 17-21 and 83: rejects Markdown and surrounding text", () => {
  for (const raw of [
    '```json\n{"value":1}\n```',
    "```",
    '~~~json\n{"value":1}\n~~~',
  ]) {
    assertPublicFailure(
      parseIntentResolutionResponse(raw),
      KADI_PARSE_ERROR_CODES.MARKDOWN_NOT_ALLOWED
    );
  }
  for (const raw of [
    'avant {"value":1}',
    '{"value":1} après',
    'avant {"value":1} après',
    'JSON:{"value":1}',
    '# titre\n{"value":1}',
    '- item {"value":1}',
    '> citation {"value":1}',
  ]) {
    assertPublicFailure(
      parseIntentResolutionResponse(raw),
      KADI_PARSE_ERROR_CODES.SURROUNDING_TEXT_NOT_ALLOWED
    );
  }
});

test("scenarios 22-30: distinguishes roots and malformed JSON", () => {
  for (const raw of ["[]", "null", '"text"', "42", "true"]) {
    assertPublicFailure(
      parseIntentResolutionResponse(raw),
      KADI_PARSE_ERROR_CODES.ROOT_NOT_OBJECT
    );
  }
  for (const raw of [
    '{"broken":}',
    '{"trailing":true,}',
    "{'pseudo':'json'}",
    '{"incomplete":true',
  ]) {
    assertPublicFailure(
      parseIntentResolutionResponse(raw),
      KADI_PARSE_ERROR_CODES.INVALID_JSON
    );
  }
});

test("scenarios 31-32: rejects every form of multiple JSON values", () => {
  for (const raw of [
    "{} {}",
    "{}\nnull",
    '{"a":1}{"b":2}',
    '{"a":1}\n{"b":2}',
  ]) {
    assertPublicFailure(
      parseIntentResolutionResponse(raw),
      KADI_PARSE_ERROR_CODES.MULTIPLE_JSON_VALUES
    );
  }
});

test("scenarios 33-36: enforces Unicode point limits without truncation", () => {
  const exactAscii = makeExactLengthObject(KADI_MAX_MODEL_RESPONSE_LENGTH);
  const exactUnicode = makeExactLengthObject(
    KADI_MAX_MODEL_RESPONSE_LENGTH,
    true
  );
  for (const raw of [exactAscii, exactUnicode]) {
    const result = extractStrictJsonObject(raw);
    assert.equal(result.ok, true);
    assert.equal(Array.from(result.rawJson).length, KADI_MAX_MODEL_RESPONSE_LENGTH);
    assert.equal(result.parsedValue.value.includes("😀"), raw.includes("😀"));
  }

  const tooLong = `${exactUnicode}😀`;
  const result = parseIntentResolutionResponse(tooLong);
  assertPublicFailure(
    result,
    KADI_PARSE_ERROR_CODES.RESPONSE_TOO_LONG
  );
  assert.equal(JSON.stringify(result).includes("😀"), false);
});

test("scenarios 37-39: requires the exact intent schema version", () => {
  const variants = [
    ["missing", undefined],
    ["null", null],
    ["number", 1],
    ["wrong", "kadi.intent.v2"],
    ["spaces", " kadi.intent.v1 "],
    ["case", "KADI.INTENT.V1"],
  ];
  for (const [kind, schemaVersion] of variants) {
    const value = createValidResolution();
    if (kind === "missing") {
      delete value.schemaVersion;
    } else {
      value.schemaVersion = schemaVersion;
    }
    assertPublicFailure(
      parseJson(value),
      KADI_PARSE_ERROR_CODES.INVALID_SCHEMA
    );
  }
});

test("scenarios 40-41 and 77: accepts actionable canonical resolutions", () => {
  const credits = createEmptyIntentResolution();
  credits.intent = "CHECK_CREDITS";
  credits.confidence = 0.9;

  for (const value of [credits, createValidResolution()]) {
    const result = parseJson(value);
    assert.equal(result.ok, true);
    assert.equal(result.actionable, true);
    assert.equal(result.validation.valid, true);
    assert.equal(result.rawJson, null);
    assert.equal(result.parsedValue, null);
    assert.deepEqual(result.resolution, value);
  }
});

test("scenarios 42-46: preserves valid but non-actionable resolutions", () => {
  const variants = [];
  for (const intent of ["UNKNOWN", "GREETING"]) {
    const value = createEmptyIntentResolution();
    value.intent = intent;
    value.confidence = 0.9;
    variants.push(value);
  }
  const lowConfidence = createValidResolution();
  lowConfidence.confidence = 0.2;
  variants.push(lowConfidence);
  const humanReview = createValidResolution();
  humanReview.safety.requiresHumanReview = true;
  variants.push(humanReview);
  const missing = createValidResolution();
  missing.missingFields = ["clientName"];
  variants.push(missing);

  for (const value of variants) {
    const result = parseJson(value);
    assert.equal(result.ok, true);
    assert.equal(result.actionable, false);
    assert.equal(result.rawJson, null);
    assert.equal(result.parsedValue, null);
  }
});

test("scenarios 47-53 and 85: rejects malformed canonical structures without throwing", () => {
  const variants = [];
  const unknownIntent = createValidResolution();
  unknownIntent.intent = "DO_ANYTHING";
  variants.push(unknownIntent);
  for (const entities of [null, []]) {
    variants.push(createValidResolution({ entities }));
  }
  const invalidItems = createValidResolution();
  invalidItems.entities.items = "items";
  variants.push(invalidItems);
  for (const [key, value] of [
    ["ambiguities", "ambiguities"],
    ["missingFields", "missingFields"],
    ["conversation", null],
    ["safety", null],
    ["requestedAction", 12],
    ["confidence", "high"],
  ]) {
    variants.push(createValidResolution({ [key]: value }));
  }

  for (const value of variants) {
    assert.doesNotThrow(() => parseJson(value));
    assertPublicFailure(
      parseJson(value),
      KADI_PARSE_ERROR_CODES.INVALID_RESOLUTION
    );
  }
});

test("scenarios 54-65 and 71-74: no unknown field, identity, secret, or raw value leaks", () => {
  const properties = [
    "unknownProperty",
    "debug",
    "chainOfThought",
    "reasoning",
    "internalReasoning",
    "prompt",
    "systemPrompt",
    "toolCalls",
    "tools",
    "messages",
    "role",
    "wa_id",
    "waId",
    "bsuid",
    "phoneNumberId",
    "senderPhone",
    "recipientPhone",
    "apiKey",
    "accessToken",
    "serviceRoleKey",
    "password",
    "otp",
    "pin",
  ];

  properties.forEach((property, index) => {
    const sentinel = `SENTINEL_${index}_${property}`;
    const value = createValidResolution();
    value[property] = sentinel;
    const result = parseJson(value);
    const serialized = JSON.stringify(result);
    assert.equal(result.rawJson, null);
    assert.equal(result.parsedValue, null);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes(property), false);
    assert.equal(serialized.includes("SyntaxError"), false);
    assert.equal(serialized.includes(" at "), false);
  });
});

test("scenarios 66-70: blocks canonical dangerous keys recursively", () => {
  const keys = [
    "__proto__",
    "__PROTO__",
    "__proto_",
    "constructor",
    "Constructor",
    "CONSTRUCTOR",
    "prototype",
    "Prototype",
    "PROTO_TYPE",
    "proto-type",
    "proto type",
  ];
  const base = createValidResolution();

  for (const key of keys) {
    const roots = [
      injectRootProperty(base, key, { polluted: true }),
      JSON.stringify({
        ...base,
        entities: {
          ...base.entities,
          nested: JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`),
        },
      }),
      JSON.stringify({
        ...base,
        ambiguities: [
          {
            field: "client",
            options: [],
            message: null,
            blocking: false,
            nested: JSON.parse(
              `{${JSON.stringify(key)}:{"polluted":true}}`
            ),
          },
        ],
      }),
      JSON.stringify({
        ...base,
        requestedAction: {
          ...base.requestedAction,
          nested: [
            JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`),
          ],
        },
      }),
    ];

    for (const raw of roots) {
      assertPublicFailure(
        parseIntentResolutionResponse(raw),
        KADI_PARSE_ERROR_CODES.UNSAFE_VALUE
      );
      assert.equal({}.polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      assert.equal(JSON.stringify(parseIntentResolutionResponse(raw)).includes("polluted"), false);
    }
  }
});

test("scenarios 71-73: success and failure outputs retain no source payload", () => {
  const success = parseJson(createValidResolution());
  assert.equal(success.rawJson, null);
  assert.equal(success.parsedValue, null);

  const sentinel = "RAW_RESPONSE_SENTINEL";
  for (const raw of [
    `{"schemaVersion":"wrong","secret":"${sentinel}"}`,
    `{"schemaVersion":"kadi.intent.v1","wa_id":"${sentinel}"}`,
    `{"broken":"${sentinel}",}`,
  ]) {
    const result = parseIntentResolutionResponse(raw);
    assert.equal(result.rawJson, null);
    assert.equal(result.parsedValue, null);
    assert.equal(result.resolution, null);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
});

test("scenarios 75 and 84: output is byte-deterministic without heuristic correction", () => {
  const value = createValidResolution();
  value.entities.description = "Équipement à Ouagadougou 😀";
  value.missingFields = [];
  value.ambiguities = [
    {
      field: "paymentMethod",
      options: ["cash", "mobile_money"],
      message: "Choisir",
      blocking: false,
    },
  ];
  const reversed = reverseObjectKeys(value);
  assert.notEqual(JSON.stringify(value), JSON.stringify(reversed));

  const first = parseIntentResolutionResponse(JSON.stringify(value));
  const second = parseIntentResolutionResponse(JSON.stringify(value));
  const reordered = parseIntentResolutionResponse(JSON.stringify(reversed));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first), JSON.stringify(reordered));

  const invalid = createValidResolution({ confidence: "0.95" });
  assertPublicFailure(
    parseJson(invalid),
    KADI_PARSE_ERROR_CODES.INVALID_RESOLUTION
  );
});

test("scenario 76: successful calls share no mutable references", () => {
  const value = createValidResolution();
  value.missingFields = ["clientPhone"];
  value.ambiguities = [
    {
      field: "paymentMethod",
      options: ["cash"],
      message: null,
      blocking: false,
    },
  ];
  const first = parseJson(value);
  const second = parseJson(value);

  for (const [left, right] of [
    [first.errors, second.errors],
    [first.resolution, second.resolution],
    [first.validation, second.validation],
    [first.validation.errors, second.validation.errors],
    [first.resolution.ambiguities, second.resolution.ambiguities],
    [first.resolution.missingFields, second.resolution.missingFields],
    [first.resolution.entities, second.resolution.entities],
    [first.resolution.entities.items, second.resolution.entities.items],
    [first.resolution.requestedAction, second.resolution.requestedAction],
    [first.resolution.conversation, second.resolution.conversation],
    [first.resolution.safety, second.resolution.safety],
  ]) {
    assert.notStrictEqual(left, right);
  }

  first.errors.push({ path: "$", code: "changed" });
  first.resolution.entities.items[0].description = "changed";
  first.resolution.ambiguities[0].options.push("changed");
  assert.deepEqual(second.errors, []);
  assert.equal(second.resolution.entities.items[0].description, "Chemise");
  assert.deepEqual(second.resolution.ambiguities[0].options, ["cash"]);
});

test("scenarios 77 and 100: failures are never actionable and no intention executes", () => {
  for (const raw of ["", "{}", '{"schemaVersion":"wrong"}']) {
    const result = parseIntentResolutionResponse(raw);
    assert.equal(result.actionable, false);
    assert.equal(result.resolution, null);
  }
  const requested = createValidResolution();
  requested.requestedAction = {
    type: "execute_now",
    target: "invoice",
  };
  const result = parseJson(requested);
  assert.equal(result.ok, true);
  assert.deepEqual(result.resolution.requestedAction, requested.requestedAction);
  assert.equal("executed" in result, false);
});

test("scenarios 78-82 and 86-100: source has no execution or external surface", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "kadiBrainResponseParser.js"),
    "utf8"
  );
  const imports = Array.from(
    source.matchAll(/require\((["'])(.*?)\1\)/g),
    (match) => match[2]
  );
  assert.deepEqual(imports, ["./kadiBrainIntentContract"]);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /require\((?!["'])/);

  const forbiddenPatterns = [
    /\bopenai\b/i,
    /@openai/i,
    /\bfetch\s*\(/,
    /\baxios\b/i,
    /require\(["'](?:http|https|net|tls|fs|vm|child_process)["']\)/,
    /\bsupabase\b/i,
    /process\.env/,
    /\breadFile\b/,
    /\bwriteFile\b/,
    /\bappendFile\b/,
    /\bcreateWriteStream\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bFunction\s*\(/,
    /\bexec\s*\(/,
    /\bspawn\s*\(/,
    /Date\.now/,
    /Math\.random/,
    /\brandomUUID\b/,
    /crypto\.randomUUID/,
    /\bhandler(?:s)?\s*=/i,
    /\bdispatch\b/i,
    /\bsendText\b/,
    /\bsendMessage\b/,
    /\bwebhook\b/i,
    /\bgemini\b/i,
    /\bprovider\b/i,
    /\btoolCalls?\b/,
  ];
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(source, pattern);
  }
});

test("all public error codes remain deterministic and ordinary failures stay specific", () => {
  const cases = [
    [null, "RESPONSE_NOT_STRING"],
    ["", "EMPTY_RESPONSE"],
    ["```", "MARKDOWN_NOT_ALLOWED"],
    ["text{}", "SURROUNDING_TEXT_NOT_ALLOWED"],
    ["{bad}", "INVALID_JSON"],
    ["[]", "ROOT_NOT_OBJECT"],
    ["{} {}", "MULTIPLE_JSON_VALUES"],
    [JSON.stringify({ schemaVersion: "wrong" }), "INVALID_SCHEMA"],
    [JSON.stringify({ schemaVersion: KADI_INTENT_SCHEMA_VERSION }), "INVALID_RESOLUTION"],
    [
      '{"schemaVersion":"kadi.intent.v1","__PROTO__":{"x":1}}',
      "UNSAFE_VALUE",
    ],
  ];
  for (const [raw, code] of cases) {
    const first = parseIntentResolutionResponse(raw);
    const second = parseIntentResolutionResponse(raw);
    assert.equal(first.errorCode, code);
    assert.notEqual(first.errorCode, "INTERNAL_PARSE_FAILURE");
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  }
});
