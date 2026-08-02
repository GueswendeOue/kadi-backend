"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvoiceCartService } = require("../kadiInvoiceCartService");
const { createInMemoryInvoiceDraftRepository } = require("../kadiInvoiceDraftRepository");

const token = "synthetic-flow-token";
const owner = "internal-owner-ref";
const item = (index) => ({ description: `Article ${index}`, quantity: 1, unit: "piece", unit_price: 100 });

test("cart adds 1, 7 and 25 items without truncation and can finish", async () => {
  for (const count of [1, 7, 25]) {
    const cart = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository() });
    const created = await cart.createDraft({ ownerRef: owner, flowToken: token, client: { type: "individual", name: "Client" } });
    let latest = created.value;
    for (let index = 0; index < count; index += 1) {
      const added = await cart.addItem({ draftId: latest.draft_id, ownerRef: owner, flowToken: token, actionKey: `item-${index}`, item: item(index) });
      assert.equal(added.ok, true);
      latest = added.value;
    }
    assert.equal(latest.items.length, count);
    assert.equal((await cart.finishItems({ draftId: latest.draft_id, ownerRef: owner, flowToken: token, actionKey: "finish" })).value.status, "collecting_options");
  }
});

test("cart refuses finishing without any article", async () => {
  const cart = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository() });
  const created = await cart.createDraft({ ownerRef: owner, flowToken: token, client: { type: "individual", name: "Client" } });
  const result = await cart.finishItems({ draftId: created.value.draft_id, ownerRef: owner, flowToken: token, actionKey: "finish-empty" });
  assert.equal(result.error, "ITEMS_REQUIRED");
});

test("retry is idempotent, ownership and expiry are fail-closed", async () => {
  let clock = Date.parse("2026-07-31T00:00:00Z");
  const cart = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository(), now: () => clock, ttlMs: 1000 });
  const created = await cart.createDraft({ ownerRef: owner, flowToken: token });
  const repeatedInit = await cart.createDraft({ ownerRef: owner, flowToken: token });
  assert.equal(repeatedInit.duplicate, true);
  assert.equal(repeatedInit.value.draft_id, created.value.draft_id);
  const args = { draftId: created.value.draft_id, ownerRef: owner, flowToken: token, actionKey: "same-action", client: { type: "individual", name: "Awa" } };
  const first = await cart.setClient(args);
  const duplicate = await cart.setClient(args);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.value.version, first.value.version);
  assert.equal((await cart.loadOwned(created.value.draft_id, "other", token)).error, "DRAFT_ACCESS_DENIED");
  clock += 1001;
  assert.equal((await cart.loadOwned(created.value.draft_id, owner, token)).error, "DRAFT_EXPIRED");
});

test("technical item limit is configurable and never truncates", async () => {
  const cart = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository(), maxItems: 2 });
  const created = await cart.createDraft({ ownerRef: owner, flowToken: token });
  const common = { draftId: created.value.draft_id, ownerRef: owner, flowToken: token };
  assert.equal((await cart.setClient({ ...common, actionKey: "client", client: { type: "individual", name: "Client" } })).ok, true);
  assert.equal((await cart.addItem({ ...common, actionKey: "1", item: item(1) })).ok, true);
  assert.equal((await cart.addItem({ ...common, actionKey: "2", item: item(2) })).ok, true);
  assert.equal((await cart.addItem({ ...common, actionKey: "3", item: item(3) })).error, "ITEM_LIMIT_REACHED");
});

test("correction updates one server-stable item id without appending or trusting an index", async () => {
  const cart = createInvoiceCartService({ repository: createInMemoryInvoiceDraftRepository() });
  const created = await cart.createDraft({ ownerRef: owner, flowToken: token, client: { type: "individual", name: "Client" } });
  const common = { draftId: created.value.draft_id, ownerRef: owner, flowToken: token };
  const first = await cart.addItem({ ...common, actionKey: "add-1", itemId: `${created.value.draft_id}:item:1`, item: item(1) });
  const second = await cart.addItem({ ...common, actionKey: "add-2", itemId: `${created.value.draft_id}:item:2`, item: item(2) });
  const targetId = second.value.items[1].item_id;
  const corrected = await cart.updateCorrectionItem({ ...common, actionKey: "correct-2", itemId: targetId, quantity: "3", unitPrice: "250" });
  const retry = await cart.updateCorrectionItem({ ...common, actionKey: "correct-2", itemId: targetId, quantity: "3", unitPrice: "250" });
  assert.equal(corrected.value.items.length, 2);
  assert.equal(corrected.value.items[0].quantity, first.value.items[0].quantity);
  assert.equal(corrected.value.items[1].item_id, targetId);
  assert.equal(corrected.value.items[1].quantity, 3);
  assert.equal(corrected.value.items[1].unit_price, 250);
  assert.equal(retry.duplicate, true);
  assert.equal((await cart.updateCorrectionItem({ ...common, actionKey: "foreign", itemId: "foreign:item", quantity: "1", unitPrice: "1" })).error, "ITEM_NOT_FOUND");
});
