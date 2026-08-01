"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { parseEncryptedEnvelopeJson, verifyFlowRequestSignature } = require("./kadiFlowCrypto");

const FLOW_ENDPOINT_PATH = process.env.KADI_INVOICE_FLOW_ENDPOINT_PATH || "/data_exchange";

function envEnabled(value) {
  return String(value || "false").trim().toLowerCase() === "true";
}

function flowRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

function flowLog(requestId, fields) {
  console.log("KADI_FLOW_REQUEST", { request_id: requestId, ...fields });
}

function createInvoiceFlowHttpHandler({ endpoint, enabled = false, production = process.env.NODE_ENV === "production", appSecret = process.env.APP_SECRET, logger = flowLog } = {}) {
  if (!endpoint || (typeof endpoint.handleEncrypted !== "function" && typeof endpoint.handleEncryptedRaw !== "function")) {
    throw new TypeError("FLOW_ENDPOINT_REQUIRED");
  }

  const bodyParser = express.json({
    type: "application/json",
    limit: "96kb",
    verify: (req, res, buffer, encoding) => {
      req.rawBody = buffer?.toString(encoding || "utf8") || "";
    },
  });
  const parseBody = (req, res, next) => bodyParser(req, res, (error) => {
    if (!error) return next();
    const requestId = req.flowRequestId || flowRequestId();
    logger(requestId, { stage: "failed", status_code: 400, error_code: "FLOW_BODY_INVALID" });
    return res.status(error.type === "entity.too.large" ? 413 : 400).json({ ok: false, error: error.type === "entity.too.large" ? "FLOW_REQUEST_TOO_LARGE" : "FLOW_BODY_INVALID" });
  });
  return [(req, res, next) => {
    req.flowRequestId = flowRequestId();
    logger(req.flowRequestId, {
      stage: "received",
      status_code: 0,
      method: req.method,
      path: req.path,
      content_type: String(req.get("content-type") || "").split(";")[0] || "missing",
      content_length: Number(req.get("content-length")) || 0,
      signature_present: Boolean(req.get("x-hub-signature-256")),
    });
    next();
  }, parseBody, async (req, res, next) => {
    const requestId = req.flowRequestId;
    if (!enabled) return res.status(404).json({ ok: false, error: "FLOW_ENDPOINT_DISABLED" });
    if (req.method !== "POST") return res.sendStatus(405);
    if (!req.body || Array.isArray(req.body) || Object.getPrototypeOf(req.body) !== Object.prototype || typeof req.rawBody !== "string") {
      logger(requestId, { stage: "failed", status_code: 400, error_code: "FLOW_BODY_INVALID" });
      return res.status(400).json({ ok: false, error: "FLOW_BODY_INVALID" });
    }
    const signatureValid = verifyFlowRequestSignature(req.rawBody, req.get("x-hub-signature-256"), appSecret);
    if (!signatureValid) {
      logger(requestId, { stage: "failed", status_code: 432, error_code: "FLOW_SIGNATURE_INVALID" });
      return res.sendStatus(432);
    }
    logger(requestId, { stage: "signature_valid", status_code: 0 });

    const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
    try {
      const envelope = parseEncryptedEnvelopeJson(req.rawBody);
      if (!envelope.ok) {
        logger(requestId, { stage: "failed", status_code: 400, error_code: envelope.error });
        return res.status(400).json({ ok: false, error: envelope.error });
      }
      logger(requestId, { stage: "envelope_valid", status_code: 0 });
      const result = await endpoint.handleEncrypted(envelope.value, {
        production,
        https: req.secure || forwardedProto === "https",
        requestId,
        logger,
        cryptoLogger: (id, fields) => console.log("KADI_FLOW_CRYPTO", { request_id: id, ...fields }),
      });
      if (!result.ok) {
        logger(requestId, { stage: "failed", status_code: result.status || 400, error_code: result.error || "FLOW_REQUEST_FAILED" });
        return res.status(result.status || 400).json({ ok: false, error: result.error });
      }
      logger(requestId, { stage: "response_sent", status_code: result.status || 200 });
      res.status(result.status || 200).type(result.content_type || "text/plain").send(result.value);
    } catch (error) {
      next(error);
    }
  }];
}

function mountInvoiceFlowRoute(app, options) {
  if (!app || typeof app.post !== "function") throw new TypeError("EXPRESS_APP_REQUIRED");
  const path = options?.path || FLOW_ENDPOINT_PATH;
  const handlers = createInvoiceFlowHttpHandler(options);
  app.post(path, handlers);
  return path;
}

module.exports = { FLOW_ENDPOINT_PATH, createInvoiceFlowHttpHandler, envEnabled, mountInvoiceFlowRoute };
