"use strict";

const crypto = require("crypto");

function isNonEmptyToken(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function secureTokenEquals(configuredToken, receivedToken) {
  if (!isNonEmptyToken(configuredToken) || !isNonEmptyToken(receivedToken)) {
    return false;
  }

  try {
    const configuredBuffer = Buffer.from(configuredToken, "utf8");
    const receivedBuffer = Buffer.from(receivedToken, "utf8");

    if (configuredBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(configuredBuffer, receivedBuffer);
  } catch (_) {
    return false;
  }
}

function getOwnDataValue(source, name) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function evaluateWebhookVerification(input) {
  const mode = getOwnDataValue(input, "mode");
  const receivedToken = getOwnDataValue(input, "receivedToken");
  const challenge = getOwnDataValue(input, "challenge");
  const configuredToken = getOwnDataValue(input, "configuredToken");

  if (mode !== "subscribe") {
    return Object.freeze({ accepted: false });
  }

  if (typeof challenge !== "string" || challenge.trim().length === 0) {
    return Object.freeze({ accepted: false });
  }

  if (!secureTokenEquals(configuredToken, receivedToken)) {
    return Object.freeze({ accepted: false });
  }

  return Object.freeze({ accepted: true, challenge });
}

module.exports = {
  isNonEmptyToken,
  secureTokenEquals,
  evaluateWebhookVerification,
};
