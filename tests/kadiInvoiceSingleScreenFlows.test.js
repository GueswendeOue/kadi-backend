"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { INVOICE_FLOW_TARGET_SCREENS } = require("../kadiInvoiceFlowSession");

const flowDir = path.join(__dirname, "..", "flows");
const source = JSON.parse(fs.readFileSync(path.join(flowDir, "kadi_facture_v1.json"), "utf8"));
const FILE_BY_SCREEN = Object.freeze({
  CLIENT: "kadi_facture_client.json",
  ARTICLE_ENTRY: "kadi_facture_article_entry.json",
  OPTIONS: "kadi_facture_options.json",
  REVIEW_INVOICE_DRAFT: "kadi_facture_review_invoice_draft.json",
  EDIT_CLIENT: "kadi_facture_edit_client.json",
  EDIT_ITEMS: "kadi_facture_edit_items.json",
  EDIT_OPTIONS: "kadi_facture_edit_options.json",
});

test("seven mono-screen Flow files preserve each source screen exactly", () => {
  assert.deepEqual(Object.keys(FILE_BY_SCREEN), INVOICE_FLOW_TARGET_SCREENS);
  for (const screenId of INVOICE_FLOW_TARGET_SCREENS) {
    const flow = JSON.parse(fs.readFileSync(path.join(flowDir, FILE_BY_SCREEN[screenId]), "utf8"));
    const sourceScreen = source.screens.find(({ id }) => id === screenId);
    assert.equal(flow.version, "7.3", screenId);
    assert.equal(flow.data_api_version, "3.0", screenId);
    assert.deepEqual(flow.routing_model, { [screenId]: [] }, screenId);
    assert.equal(flow.screens.length, 1, screenId);
    assert.deepEqual(flow.screens[0], sourceScreen, screenId);
    assert.equal(flow.screens[0].terminal, true, screenId);
    assert.equal(JSON.stringify(flow).includes("KADI_SESSION_ROOT"), false, screenId);
    assert.equal(JSON.stringify(flow).includes("SESSION_RECOVERY"), false, screenId);
  }
});

test("every mono-screen Flow remains INIT-compatible and completes locally", () => {
  for (const [screenId, file] of Object.entries(FILE_BY_SCREEN)) {
    const flow = JSON.parse(fs.readFileSync(path.join(flowDir, file), "utf8"));
    const screen = flow.screens[0];
    const footer = screen.layout.children.flatMap((component) => component.type === "Form" ? component.children : [component])
      .find((component) => component.type === "Footer");
    assert.ok(Object.hasOwn(screen, "data"), screenId);
    assert.equal(footer["on-click-action"].name, "complete", screenId);
    assert.equal(footer["on-click-action"].payload.flow_token, "${data.flow_token}", screenId);
    assert.equal(footer["on-click-action"].payload.draft_id, "${data.draft_id}", screenId);
  }
});
