"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const { FLOW_ENDPOINT_PATH, mountInvoiceFlowRoute } = require("../kadiInvoiceFlowHttpRoute");

function request(app, body, appSecret = "synthetic-app-secret") {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const signature = crypto.createHmac("sha256", appSecret).update(body).digest("hex");
      const req = http.request({ hostname: address.address, port: address.port, path: FLOW_ENDPOINT_PATH, method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}`, "content-length": Buffer.byteLength(body) } }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => { server.close(); resolve({ status: res.statusCode, data }); });
      });
      req.on("error", (error) => { server.close(); reject(error); });
      req.end(body);
    });
    server.on("error", reject);
  });
}

test("invoice Flow HTTP route is disabled by default", async () => {
  const app = express();
  mountInvoiceFlowRoute(app, { endpoint: { handleEncrypted: async () => ({ ok: true, value: "ignored" }) } });
  const result = await request(app, "{}");
  assert.equal(result.status, 404);
  assert.match(result.data, /FLOW_ENDPOINT_DISABLED/);
});

test("invoice Flow HTTP route forwards the raw encrypted envelope when enabled", async () => {
  const app = express();
  let received = null;
  mountInvoiceFlowRoute(app, {
    enabled: true,
    production: false,
    appSecret: "synthetic-app-secret",
    endpoint: { handleEncrypted: async (raw, context) => { received = { raw, context }; return { ok: true, status: 200, content_type: "text/plain", value: "encrypted-response" }; } },
  });
  const body = '{"encrypted_aes_key":"x","encrypted_flow_data":"y","initial_vector":"z"}';
  const result = await request(app, body);
  assert.equal(result.status, 200);
  assert.equal(result.data, "encrypted-response");
  assert.deepEqual(received.raw, { encrypted_aes_key: "x", encrypted_flow_data: "y", initial_vector: "z" });
  assert.equal(received.context.production, false);
});

test("invoice Flow route rejects invalid signatures before endpoint processing", async () => {
  const app = express();
  let called = false;
  mountInvoiceFlowRoute(app, { enabled: true, appSecret: "synthetic-app-secret", endpoint: { handleEncrypted: async () => { called = true; return { ok: true, value: "nope" }; } } });
  const result = await request(app, '{"encrypted_aes_key":"x","encrypted_flow_data":"y","initial_vector":"z"}', "wrong-secret");
  assert.equal(result.status, 432);
  assert.equal(called, false);
});
