"use strict";

const express = require("express");

const FLOW_ENDPOINT_PATH = process.env.KADI_INVOICE_FLOW_ENDPOINT_PATH || "/data_exchange";

function envEnabled(value) {
  return String(value || "false").trim().toLowerCase() === "true";
}

function createInvoiceFlowHttpHandler({ endpoint, enabled = false, production = process.env.NODE_ENV === "production" } = {}) {
  if (!endpoint || typeof endpoint.handleEncryptedRaw !== "function") {
    throw new TypeError("FLOW_ENDPOINT_REQUIRED");
  }

  const bodyParser = express.text({ type: ["text/plain", "application/json"], limit: "96kb" });
  return [bodyParser, async (req, res, next) => {
    if (!enabled) return res.status(404).json({ ok: false, error: "FLOW_ENDPOINT_DISABLED" });
    if (req.method !== "POST") return res.sendStatus(405);
    if (typeof req.body !== "string") return res.status(400).json({ ok: false, error: "FLOW_BODY_INVALID" });

    const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
    try {
      const result = await endpoint.handleEncryptedRaw(req.body, {
        production,
        https: req.secure || forwardedProto === "https",
      });
      if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error });
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
