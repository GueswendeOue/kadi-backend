"use strict";

const {
  KADI_INTENT_SCHEMA_VERSION,
  normalizeIntentResolution,
  validateIntentResolution,
  isActionableIntentResolution,
} = require("./kadiBrainIntentContract");

const KADI_MODEL_RESPONSE_SCHEMA_VERSION = "kadi.model-response.v1";
const KADI_MAX_MODEL_RESPONSE_LENGTH = 32000;

const KADI_PARSE_ERROR_CODES = Object.freeze({
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  RESPONSE_NOT_STRING: "RESPONSE_NOT_STRING",
  RESPONSE_TOO_LONG: "RESPONSE_TOO_LONG",
  MARKDOWN_NOT_ALLOWED: "MARKDOWN_NOT_ALLOWED",
  SURROUNDING_TEXT_NOT_ALLOWED: "SURROUNDING_TEXT_NOT_ALLOWED",
  INVALID_JSON: "INVALID_JSON",
  ROOT_NOT_OBJECT: "ROOT_NOT_OBJECT",
  MULTIPLE_JSON_VALUES: "MULTIPLE_JSON_VALUES",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  INVALID_RESOLUTION: "INVALID_RESOLUTION",
  UNSAFE_VALUE: "UNSAFE_VALUE",
  INTERNAL_PARSE_FAILURE: "INTERNAL_PARSE_FAILURE",
});

const UNSAFE_PROPERTY_NAMES = new Set(["proto", "prototype", "constructor"]);

function createEmptyParseResult() {
  return {
    schemaVersion: KADI_MODEL_RESPONSE_SCHEMA_VERSION,
    ok: false,
    errorCode: null,
    errors: [],
    rawJson: null,
    parsedValue: null,
    resolution: null,
    validation: null,
    actionable: false,
  };
}

function createExtractionFailure(errorCode) {
  return {
    ok: false,
    errorCode,
    errors: [errorCode],
    rawJson: null,
    parsedValue: null,
  };
}

function findCompleteRootObjectEnd(value) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }

  return -1;
}

function looksLikeJsonValue(value) {
  return /^(?:\{|\[|"|-?\d|true\b|false\b|null\b)/.test(value);
}

function extractStrictJsonObject(rawResponse) {
  if (typeof rawResponse !== "string") {
    return createExtractionFailure(
      KADI_PARSE_ERROR_CODES.RESPONSE_NOT_STRING
    );
  }

  if (Array.from(rawResponse).length > KADI_MAX_MODEL_RESPONSE_LENGTH) {
    return createExtractionFailure(
      KADI_PARSE_ERROR_CODES.RESPONSE_TOO_LONG
    );
  }

  const rawJson = rawResponse.trim();
  if (rawJson.length === 0) {
    return createExtractionFailure(KADI_PARSE_ERROR_CODES.EMPTY_RESPONSE);
  }

  if (/```|~~~/.test(rawJson)) {
    return createExtractionFailure(
      KADI_PARSE_ERROR_CODES.MARKDOWN_NOT_ALLOWED
    );
  }

  if (rawJson[0] === "{") {
    const objectEnd = findCompleteRootObjectEnd(rawJson);
    if (objectEnd > 0 && objectEnd < rawJson.length) {
      const remainder = rawJson.slice(objectEnd).trim();
      return createExtractionFailure(
        looksLikeJsonValue(remainder)
          ? KADI_PARSE_ERROR_CODES.MULTIPLE_JSON_VALUES
          : KADI_PARSE_ERROR_CODES.SURROUNDING_TEXT_NOT_ALLOWED
      );
    }
  } else if (rawJson.includes("{") || rawJson.includes("}")) {
    return createExtractionFailure(
      KADI_PARSE_ERROR_CODES.SURROUNDING_TEXT_NOT_ALLOWED
    );
  }

  let parsedValue;
  try {
    parsedValue = JSON.parse(rawJson);
  } catch {
    return createExtractionFailure(KADI_PARSE_ERROR_CODES.INVALID_JSON);
  }

  if (
    parsedValue === null ||
    Array.isArray(parsedValue) ||
    typeof parsedValue !== "object"
  ) {
    return createExtractionFailure(KADI_PARSE_ERROR_CODES.ROOT_NOT_OBJECT);
  }

  return {
    ok: true,
    errorCode: null,
    errors: [],
    rawJson,
    parsedValue,
  };
}

function normalizeSecurityKey(key) {
  return String(key).trim().toLowerCase().replace(/[_\-\s]/g, "");
}

function containsUnsafeProperty(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(containsUnsafeProperty);
  }

  return Object.keys(value).some(
    (key) =>
      UNSAFE_PROPERTY_NAMES.has(normalizeSecurityKey(key)) ||
      containsUnsafeProperty(value[key])
  );
}

function cloneValidation(validation) {
  return {
    valid: validation.valid === true,
    errors: Array.isArray(validation.errors)
      ? validation.errors.map((error) =>
          error && typeof error === "object" && !Array.isArray(error)
            ? { path: error.path, code: error.code }
            : String(error)
        )
      : [],
  };
}

function createParseFailure(errorCode, validationErrors = []) {
  const errors =
    Array.isArray(validationErrors) && validationErrors.length > 0
      ? validationErrors.map((error) => ({
          path:
            error && typeof error === "object" && !Array.isArray(error)
              ? error.path
              : "$",
          code:
            error && typeof error === "object" && !Array.isArray(error)
              ? error.code
              : errorCode,
        }))
      : [{ path: "$", code: errorCode }];

  return {
    ...createEmptyParseResult(),
    errorCode,
    errors,
  };
}

function parseIntentResolutionResponse(rawResponse) {
  try {
    const extraction = extractStrictJsonObject(rawResponse);
    if (!extraction.ok) {
      return createParseFailure(extraction.errorCode);
    }

    if (containsUnsafeProperty(extraction.parsedValue)) {
      return createParseFailure(KADI_PARSE_ERROR_CODES.UNSAFE_VALUE);
    }

    if (
      extraction.parsedValue.schemaVersion !== KADI_INTENT_SCHEMA_VERSION
    ) {
      return createParseFailure(KADI_PARSE_ERROR_CODES.INVALID_SCHEMA);
    }

    const inputValidation = cloneValidation(
      validateIntentResolution(extraction.parsedValue)
    );
    if (!inputValidation.valid) {
      return createParseFailure(
        KADI_PARSE_ERROR_CODES.INVALID_RESOLUTION,
        inputValidation.errors
      );
    }

    const resolution = normalizeIntentResolution(extraction.parsedValue);
    const validation = cloneValidation(validateIntentResolution(resolution));
    if (!validation.valid) {
      return createParseFailure(
        KADI_PARSE_ERROR_CODES.INVALID_RESOLUTION,
        validation.errors
      );
    }

    return {
      schemaVersion: KADI_MODEL_RESPONSE_SCHEMA_VERSION,
      ok: true,
      errorCode: null,
      errors: [],
      rawJson: null,
      parsedValue: null,
      resolution,
      validation,
      actionable: isActionableIntentResolution(resolution),
    };
  } catch {
    return createParseFailure(
      KADI_PARSE_ERROR_CODES.INTERNAL_PARSE_FAILURE
    );
  }
}

module.exports = {
  KADI_MODEL_RESPONSE_SCHEMA_VERSION,
  KADI_MAX_MODEL_RESPONSE_LENGTH,
  KADI_PARSE_ERROR_CODES,
  createEmptyParseResult,
  extractStrictJsonObject,
  parseIntentResolutionResponse,
};
