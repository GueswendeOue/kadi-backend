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
  assert.doesNotMatch(parsed.items[0].label, /\b2\b/);
  assert.equal(parsed.items[0].qty, 2);
  assert.equal(parsed.items[0].unitPrice, 25000);
  assert.match(parsed.items[1].label, /main d'oeuvre/i);
  assert.equal(parsed.items[1].qty, 1);
  assert.equal(parsed.items[1].unitPrice, 50000);
  assert.equal(totals.grandTotal, 100000);
});

test("detects leading quantities in common field item lines", () => {
  const parsed = parseItemsBlockSmart(
    [
      "5 sacs de ciment à 5000",
      "10 prises à 2500",
      "main d’œuvre à 50000",
      "pose 60000",
      "tube PVC 20 à 5000",
    ].join("\n")
  );

  assert.equal(parsed.items.length, 5);

  assert.equal(parsed.items[0].qty, 5);
  assert.match(parsed.items[0].label, /ciment/i);
  assert.equal(parsed.items[0].unitPrice, 5000);

  assert.equal(parsed.items[1].qty, 10);
  assert.match(parsed.items[1].label, /prise/i);
  assert.equal(parsed.items[1].unitPrice, 2500);

  assert.equal(parsed.items[2].qty, 1);
  assert.match(parsed.items[2].label, /main d’œuvre/i);
  assert.equal(parsed.items[2].unitPrice, 50000);

  assert.equal(parsed.items[3].qty, 1);
  assert.match(parsed.items[3].label, /pose/i);
  assert.equal(parsed.items[3].unitPrice, 60000);

  assert.equal(parsed.items[4].qty, 1);
  assert.match(parsed.items[4].label, /tube pvc 20/i);
  assert.equal(parsed.items[4].unitPrice, 5000);
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
