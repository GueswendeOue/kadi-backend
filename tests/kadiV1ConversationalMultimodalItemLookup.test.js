"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveRemovalTarget } = require("../kadiV1ConversationalMultimodalItemLookup");

const ITEMS = [
  { item_id: "item-1", description: "Livraison express" },
  { item_id: "item-2", description: "Table en bois" },
  { item_id: "item-3", description: "Chaise" },
];

test("resolveRemovalTarget: unique substring match returns the item_id", () => {
  const result = resolveRemovalTarget({ hint: "livraison", items: ITEMS });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: exact match returns the item_id", () => {
  const result = resolveRemovalTarget({ hint: "chaise", items: ITEMS });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-3" });
});

test("resolveRemovalTarget: no match fails closed", () => {
  const result = resolveRemovalTarget({ hint: "parasol", items: ITEMS });
  assert.deepEqual(result, { status: "NO_MATCH" });
});

test("resolveRemovalTarget: ambiguous hint fails closed with candidates", () => {
  const ambiguousItems = [
    { item_id: "item-1", description: "Chaise en bois" },
    { item_id: "item-2", description: "Table en bois" },
  ];
  const result = resolveRemovalTarget({ hint: "bois", items: ambiguousItems });
  assert.equal(result.status, "AMBIGUOUS");
  assert.deepEqual(result.candidates.sort(), ["item-1", "item-2"]);
});

test("resolveRemovalTarget: empty hint fails closed", () => {
  assert.deepEqual(resolveRemovalTarget({ hint: "", items: ITEMS }), { status: "NO_MATCH" });
  assert.deepEqual(resolveRemovalTarget({ hint: null, items: ITEMS }), { status: "NO_MATCH" });
});

test("resolveRemovalTarget: no items on the document fails closed", () => {
  assert.deepEqual(resolveRemovalTarget({ hint: "livraison", items: [] }), { status: "NO_MATCH" });
  assert.deepEqual(resolveRemovalTarget({ hint: "livraison", items: null }), { status: "NO_MATCH" });
});

test("resolveRemovalTarget: accent-insensitive match", () => {
  const items = [{ item_id: "item-1", description: "Décharge partielle" }];
  const result = resolveRemovalTarget({ hint: "decharge", items });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: collapses doubled internal whitespace in the hint", () => {
  const items = [{ item_id: "item-1", description: "Table en bois" }];
  const result = resolveRemovalTarget({ hint: "table   en    bois", items });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: collapses doubled internal whitespace in the stored description", () => {
  const items = [{ item_id: "item-1", description: "Table   en   bois" }];
  const result = resolveRemovalTarget({ hint: "table en bois", items });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: tolerates leading/trailing whitespace in the hint", () => {
  const items = [{ item_id: "item-1", description: "Ciment" }];
  const result = resolveRemovalTarget({ hint: "   ciment   ", items });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: case and accent variants both match the same single item", () => {
  const items = [{ item_id: "item-1", description: "Câble électrique" }];
  assert.deepEqual(resolveRemovalTarget({ hint: "CÂBLE ÉLECTRIQUE", items }), { status: "MATCHED", item_id: "item-1" });
  assert.deepEqual(resolveRemovalTarget({ hint: "cable electrique", items }), { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: simple singular hint matches a plural single-word description (pre-existing, via substring)", () => {
  const items = [{ item_id: "item-1", description: "Tables" }];
  assert.deepEqual(resolveRemovalTarget({ hint: "table", items }), { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: simple plural hint now matches a singular single-word description", () => {
  const items = [{ item_id: "item-1", description: "Table" }];
  assert.deepEqual(resolveRemovalTarget({ hint: "tables", items }), { status: "MATCHED", item_id: "item-1" });
});

test("resolveRemovalTarget: plural tolerance is restricted to a single word — a multi-word plural hint is never folded", () => {
  // Deliberately narrow scope: folding only ever strips a trailing "s" off
  // a single whole word. A multi-word hint like "deux chaises" is left
  // untouched rather than naively stripped to "deux chaise", so this must
  // fail closed to NO_MATCH exactly as it did before plural tolerance was
  // added — many legitimate French words already end in "s" (bois, repas,
  // temps...), and multi-word grammatical folding is out of scope for a
  // minimal, deterministic fix.
  const items = [{ item_id: "item-1", description: "Deux chaise" }];
  const result = resolveRemovalTarget({ hint: "deux chaises", items });
  assert.deepEqual(result, { status: "NO_MATCH" });
});

test("resolveRemovalTarget: plural folding cannot turn two genuinely different items into a false unique match — stays AMBIGUOUS", () => {
  const items = [
    { item_id: "item-1", description: "Sac" },
    { item_id: "item-2", description: "Sacs de ciment" },
  ];
  const result = resolveRemovalTarget({ hint: "sacs", items });
  assert.equal(result.status, "AMBIGUOUS");
  assert.deepEqual(result.candidates.sort(), ["item-1", "item-2"]);
});

test("resolveRemovalTarget: plural folding never creates a false single match out of an unrelated longer word", () => {
  // A folded hint ("plat") must never be substring-matched against an
  // unrelated longer word ("plateau") — only a full single-word equality
  // is ever accepted for the folded form.
  const items = [{ item_id: "item-1", description: "Plateau de fruits" }];
  const result = resolveRemovalTarget({ hint: "plats", items });
  assert.deepEqual(result, { status: "NO_MATCH" });
});

test("resolveRemovalTarget: normalizes curly/typographic quotes to plain apostrophes", () => {
  const items = [{ item_id: "item-1", description: "Câble d'alimentation" }];
  const result = resolveRemovalTarget({ hint: "câble d’alimentation", items });
  assert.deepEqual(result, { status: "MATCHED", item_id: "item-1" });
});
