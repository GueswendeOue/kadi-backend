// kadiSignature.js
"use strict";

function safe(v) {
  return String(v || "").trim();
}

function isLikelySignatureCommand(text) {
  const t = safe(text).toLowerCase();
  return t === "signature" || t === "sign" || t.includes("ma signature");
}

module.exports = { isLikelySignatureCommand, safe };