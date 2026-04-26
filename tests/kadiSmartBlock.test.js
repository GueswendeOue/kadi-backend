"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  analyzeSmartBlock,
  parseItemsBlockSmart,
  extractBlockTotals,
  buildSmartMismatchMessage,
} = require("../kadiSmartBlock");

test("parses simple item lines and extracts the grand total", () => {
  const input = [
    "2 portes à 25000",
    "Main d'oeuvre 50000",
    "Total 100000",
  ].join("\n");

  const parsed = parseItemsBlockSmart(input);
  const totals = extractBlockTotals(input);

  assert.deepEqual(parsed.ignored, ["Total 100000"]);
  assert.equal(parsed.items.length, 2);
  assert.match(parsed.items[0].label, /porte/i);
  assert.equal(parsed.items[0].qty, 1);
  assert.equal(parsed.items[0].unitPrice, 25000);
  assert.match(parsed.items[1].label, /main d'oeuvre/i);
  assert.equal(parsed.items[1].qty, 1);
  assert.equal(parsed.items[1].unitPrice, 50000);
  assert.equal(totals.grandTotal, 100000);
});

test("reports no severe mismatch when computed total matches extracted total", () => {
  const items = [
    { label: "portes", qty: 2, unitPrice: 25000 },
    { label: "main d'oeuvre", qty: 1, unitPrice: 50000 },
  ];

  const computedTotal = items.reduce(
    (sum, item) => sum + item.qty * item.unitPrice,
    0
  );

  const analysis = analyzeSmartBlock({
    items,
    computedTotal,
    grandTotal: 100000,
  });
  const warning = buildSmartMismatchMessage(analysis);

  assert.equal(["general", "material", "service", "mixed"].includes(analysis.businessType), true);
  assert.equal(["unknown", "missing_labor", "missing_material", "mixed"].includes(analysis.hint), true);
  assert.equal(analysis.gapInfo.severity, "none");
  assert.equal(warning.warning, false);
});

test("flags a meaningful missing amount", () => {
  const analysis = analyzeSmartBlock({
    items: [{ label: "ciment", qty: 1, unitPrice: 5000 }],
    computedTotal: 5000,
    grandTotal: 10000,
  });
  const warning = buildSmartMismatchMessage(analysis);

  assert.equal(analysis.gapInfo.gap, 5000);
  assert.equal(analysis.gapInfo.severity, "high");
  assert.equal(warning.warning, true);
  assert.match(warning.text, /Écart détecté/);
});
