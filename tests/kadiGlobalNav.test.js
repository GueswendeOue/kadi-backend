"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isGlobalMenuText } = require("../kadiGlobalNav");

test("global menu words are recognized across business states", () => {
  const states = [
    null,
    "intent_fix_price",
    "item_price",
    "recharge_proof",
    "stamp_title",
    "stamp_image_upload",
    "awaiting_ocr_image",
    "certified_invoice_client",
    "doc_edit_text_waiting",
  ];

  for (const step of states) {
    for (const text of ["menu", "MENU", "Menu", "accueil", "home", "retour", "stop"]) {
      assert.equal(isGlobalMenuText(text), true, `${step || "normal"}:${text}`);
    }
  }
});

test("global menu matcher does not catch normal business text", () => {
  for (const text of [
    "devis pour Moussa",
    "recharge 1000",
    "prix 5000",
    "tampon entreprise",
  ]) {
    assert.equal(isGlobalMenuText(text), false, text);
  }
});
