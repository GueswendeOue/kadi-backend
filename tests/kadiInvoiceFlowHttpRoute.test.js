"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { FLOW_ENDPOINT_PATH, mountInvoiceFlowRoute } = require("../kadiInvoiceFlowHttpRoute");

function request(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const req = http.request({ hostname: address.address, port: address.port, path: FLOW_ENDPOINT_PATH, method: "POST", headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(body) } }, (res) => {
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
  mountInvoiceFlowRoute(app, { endpoint: { handleEncryptedRaw: async () => ({ ok: true, value: "ignored" }) } });
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
    endpoint: { handleEncryptedRaw: async (raw, context) => { received = { raw, context }; return { ok: true, status: 200, content_type: "text/plain", value: "encrypted-response" }; } },
  });
  const result = await request(app, '{"encrypted_aes_key":"x"}');
  assert.equal(result.status, 200);
  assert.equal(result.data, "encrypted-response");
  assert.equal(received.raw, '{"encrypted_aes_key":"x"}');
  assert.equal(received.context.production, false);
});
