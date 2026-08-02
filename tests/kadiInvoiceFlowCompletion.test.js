"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createInvoiceFlowCompletionHandler } = require("../kadiInvoiceFlowCompletion");
const { createInvoiceCartService } = require("../kadiInvoiceCartService");
const { createInMemoryInvoiceDraftRepository } = require("../kadiInvoiceDraftRepository");
const { createInMemoryInvoiceFlowSessionRepository, createInvoiceFlowSessionService } = require("../kadiInvoiceFlowSession");

async function orchestrationFixture() {
  const nowValue = 1735689600000;
  const draftRepository = createInMemoryInvoiceDraftRepository();
  const cartService = createInvoiceCartService({ repository: draftRepository, now: () => nowValue });
  const flowSessionService = createInvoiceFlowSessionService({ repository: createInMemoryInvoiceFlowSessionRepository(), draftRepository, now: () => nowValue });
  const draft = await cartService.createDraft({ ownerRef: "owner-a", flowToken: "initial-seed" });
  const session = await flowSessionService.createInvoiceFlowSession({ ownerRef: "owner-a", draftId: draft.value.draft_id, expiresAt: new Date(nowValue + 60_000).toISOString() });
  const sentFlows = [];
  const sentTexts = [];
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService,
    cartService,
    flowId: "1972040430119125",
    ttlMinutes: 30,
    sendFlow: async (payload) => { sentFlows.push(payload); return { accepted: true, messageId: `sent-${sentFlows.length}` }; },
    sendText: async (to, text) => { sentTexts.push({ to, text }); },
    logger: { log: () => {} },
    now: () => nowValue,
  });
  const reply = (id, response) => handler({
    from: "22670000000",
    message: { id, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(response) } } },
  });
  return { cartService, draftRepository, draftId: draft.value.draft_id, handler, reply, sentFlows, sentTexts, session: session.value };
}

test("engine runs nfm_reply completion before every legacy interactive or conversational route", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "kadiEngine.js"), "utf8");
  const completionCall = source.indexOf("options.invoiceFlowCompletion({ from, message: msg, value, identity })");
  const stopPipeline = source.indexOf("if (completionResult?.handled === true) return;", completionCall);
  const legacyInteractive = source.indexOf("await handleInteractiveMessage(from, msg);", completionCall);
  const conversational = source.indexOf("await handleTextMessage(from, text, msg);", completionCall);
  assert.ok(completionCall >= 0);
  assert.ok(stopPipeline > completionCall);
  assert.ok(legacyInteractive > stopPipeline);
  assert.ok(conversational > stopPipeline);
});

test("realistic Flow completion is handled before fallback without sending a second user message", async () => {
  const sent = [];
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) },
    sendText: async (to, text) => sent.push({ to, text }),
    logger: { log: () => {} },
  });
  const message = {
    context: { from: "22670000000", id: "wamid-launch" },
    from: "22670000000",
    id: "wamid-flow-complete",
    timestamp: "1785628800",
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: JSON.stringify({ flow_token: "opaque-flow-token", draft_id: "draft-1", status: "draft_saved" }),
      },
    },
  };
  const first = await handler({ from: "22670000000", message });
  const second = await handler({ from: "22670000000", message });
  assert.equal(first.handled, true);
  assert.equal(second.handled, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 0);
});

test("already-parsed response_json and common property aliases are accepted", async () => {
  const handler = createInvoiceFlowCompletionHandler({
    flowSessionService: { resolveInvoiceFlowSession: async (token) => ({ ok: token === "opaque-flow-token", value: { draftId: "draft-1" } }) },
    logger: { log: () => {} },
  });
  const result = await handler({
    from: "22670000000",
    message: { id: "parsed", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: { flowToken: "opaque-flow-token", draftId: "draft-1", status: "draft_saved" } } } },
  });
  assert.equal(result.handled, true);
  assert.equal(result.outcome, "handled");
});

test("recognized but invalid Flow completion is swallowed before legacy MENU and OpenAI routing", async () => {
  const handler = createInvoiceFlowCompletionHandler({ flowSessionService: { resolveInvoiceFlowSession: async () => ({ ok: true, value: { draftId: "draft-1" } }) }, logger: { log: () => {} } });
  const result = await handler({ from: "22670000000", message: { id: "bad", type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } } });
  assert.equal(result.handled, true);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "FLOW_TOKEN_MISSING");
});

test("three short article sessions build fresh Article 2 and 3 payloads without duplicates", async () => {
  const f = await orchestrationFixture();
  const client = await f.reply("client-1", { outcome: "client_saved", flow_token: f.session.flow_token, draft_id: f.draftId, client_type: "individual", client_name: "Ben" });
  assert.equal(client.next_screen, "ARTICLE_ENTRY");
  const article1Data = f.sentFlows.at(-1).interactive.action.parameters.flow_action_payload.data;
  assert.equal(article1Data.item_number_text, "Produit ou service 1");

  const first = await f.reply("article-1", { outcome: "add_another_item", flow_token: client.next_flow_token, draft_id: f.draftId, current_item_id: article1Data.current_item_id, submission_id: article1Data.submission_id, designation: "Ordinateur", quantity: "1", unit: "unit", unit_price: "150000", return_to_review: "false" });
  assert.equal(first.next_screen, "ARTICLE_ENTRY");
  assert.deepEqual({ outcome: first.outcome, draft_id: first.draft_id, next_item_number: first.next_item_number, submission_id: first.submission_id }, {
    outcome: "add_another_item", draft_id: f.draftId, next_item_number: "2", submission_id: article1Data.submission_id,
  });
  assert.notEqual(first.next_flow_token, client.next_flow_token);
  const article2Data = f.sentFlows.at(-1).interactive.action.parameters.flow_action_payload.data;
  assert.equal(article2Data.item_number_text, "Produit ou service 2");
  assert.deepEqual(article2Data.article_form_init_values, { designation: "", quantity: "1", unit_price: "" });
  assert.equal(Object.hasOwn(article2Data.article_form_init_values, "unit"), false);
  assert.equal(Object.hasOwn(article2Data.article_form_init_values, "article_decision"), false);
  assert.equal(article2Data.saved_item_count_text, "1 article enregistré");
  assert.match(article2Data.saved_items_summary, /Ordinateur/);
  assert.equal(article2Data.saved_subtotal_text.replace(/\s/g, " "), "150 000 FCFA");
  const flowCountAfterFirst = f.sentFlows.length;
  assert.equal((await f.reply("article-1", { outcome: "add_another_item", flow_token: client.next_flow_token, draft_id: f.draftId, current_item_id: article1Data.current_item_id, submission_id: article1Data.submission_id, designation: "Ordinateur", quantity: "1", unit: "unit", unit_price: "150000", return_to_review: "false" })).duplicate, true);
  assert.equal(f.sentFlows.length, flowCountAfterFirst);
  const staleReplay = await f.reply("article-1-new-message-id", { outcome: "add_another_item", flow_token: client.next_flow_token, draft_id: f.draftId, current_item_id: article1Data.current_item_id, submission_id: article1Data.submission_id, designation: "Ordinateur", quantity: "1", unit: "unit", unit_price: "150000", return_to_review: "false" });
  assert.equal(staleReplay.duplicate, true);
  assert.equal(staleReplay.reason, "DUPLICATE_MESSAGE");
  assert.equal(f.sentFlows.length, flowCountAfterFirst);

  const second = await f.reply("article-2", { outcome: "add_another_item", flow_token: first.next_flow_token, draft_id: f.draftId, current_item_id: article2Data.current_item_id, submission_id: article2Data.submission_id, designation: "Souris", quantity: "2", unit: "unit", unit_price: "5000", return_to_review: "false" });
  assert.equal(second.next_screen, "ARTICLE_ENTRY");
  assert.equal(second.next_item_number, "3");
  assert.equal(new Set([client.next_flow_token, first.next_flow_token, second.next_flow_token]).size, 3);
  const article3Data = f.sentFlows.at(-1).interactive.action.parameters.flow_action_payload.data;
  assert.equal(article3Data.item_number_text, "Produit ou service 3");
  assert.deepEqual(article3Data.article_form_init_values, { designation: "", quantity: "1", unit_price: "" });
  assert.equal(new Set([article1Data.submission_id, article2Data.submission_id, article3Data.submission_id]).size, 3);
  assert.equal(article1Data.current_item_id, article1Data.submission_id);
  assert.equal(article2Data.current_item_id, article2Data.submission_id);
  assert.equal(article3Data.current_item_id, article3Data.submission_id);
  assert.equal(article3Data.saved_item_count_text, "2 articles enregistrés");
  assert.match(article3Data.saved_items_summary, /Ordinateur/);
  assert.match(article3Data.saved_items_summary, /Souris/);
  assert.equal(article3Data.saved_subtotal_text.replace(/\s/g, " "), "160 000 FCFA");

  const wrongDraft = await f.reply("article-3-wrong-draft", { outcome: "items_finished", flow_token: second.next_flow_token, draft_id: "another-draft", current_item_id: article3Data.current_item_id, submission_id: article3Data.submission_id, designation: "Clavier", quantity: "1", unit: "unit", unit_price: "20000", return_to_review: "false" });
  assert.equal(wrongDraft.accepted, false);
  assert.equal(wrongDraft.reason, "FLOW_SESSION_INVALID");

  const third = await f.reply("article-3", { outcome: "items_finished", flow_token: second.next_flow_token, draft_id: f.draftId, current_item_id: article3Data.current_item_id, submission_id: article3Data.submission_id, designation: "Clavier", quantity: "1", unit: "unit", unit_price: "20000", return_to_review: "false" });
  assert.equal(third.next_screen, "OPTIONS");
  assert.equal(third.item_count, "3");
  assert.equal(third.subtotal_text.replace(/\s/g, " "), "180 000 FCFA");
  const latestToken = third.next_flow_token;
  const loaded = await f.cartService.loadOwned(f.draftId, "owner-a", latestToken);
  assert.equal(loaded.value.items.length, 3);
  assert.deepEqual(loaded.value.items.map(({ description }) => description), ["Ordinateur", "Souris", "Clavier"]);
  assert.equal(loaded.value.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price), 0), 180000);
  assert.deepEqual(loaded.value.items.map(({ item_id }) => item_id), [article1Data.current_item_id, article2Data.current_item_id, article3Data.current_item_id]);
  assert.equal(f.sentTexts.filter(({ text }) => /J’ai ajouté Ordinateur/.test(text)).length, 1);
  assert.equal(f.sentTexts.some(({ text }) => /MENU|OpenAI|payload|nouvelle session|Flow|écran/i.test(text)), false);
});

test("review corrections open fresh sessions and preserve unrelated draft data", async () => {
  const f = await orchestrationFixture();
  const client = await f.reply("c1", { outcome: "client_saved", flow_token: f.session.flow_token, draft_id: f.draftId, client_type: "individual", client_name: "Ben" });
  const articleData = f.sentFlows.at(-1).interactive.action.parameters.flow_action_payload.data;
  const finished = await f.reply("a1", { outcome: "items_finished", flow_token: client.next_flow_token, draft_id: f.draftId, current_item_id: articleData.current_item_id, submission_id: articleData.submission_id, designation: "Service", quantity: "1", unit: "unit", unit_price: "1000", return_to_review: "false" });
  const options = await f.reply("o1", { outcome: "options_saved", flow_token: finished.next_flow_token, draft_id: f.draftId, tax_status: "not_applicable", discount_amount: "0", amount_paid: "0", payment_terms: "Comptant" });
  assert.equal(options.next_screen, "REVIEW_INVOICE_DRAFT");

  const editClient = await f.reply("r-client", { outcome: "modify_client", flow_token: options.next_flow_token, draft_id: f.draftId });
  assert.equal(editClient.next_screen, "EDIT_CLIENT");
  const correctedClient = await f.reply("edit-client", { outcome: "client_corrected", flow_token: editClient.next_flow_token, draft_id: f.draftId, client_type: "individual", client_name: "Benjamin" });
  assert.equal(correctedClient.next_screen, "REVIEW_INVOICE_DRAFT");
  let loaded = await f.cartService.loadOwned(f.draftId, "owner-a", correctedClient.next_flow_token);
  assert.equal(loaded.value.client.name, "Benjamin");
  assert.equal(loaded.value.items.length, 1);
  assert.equal(loaded.value.options.payment_terms, "Comptant");

  const editItems = await f.reply("r-items", { outcome: "modify_items", flow_token: correctedClient.next_flow_token, draft_id: f.draftId });
  assert.equal(editItems.next_screen, "EDIT_ITEMS");
  const editableItems = f.sentFlows.at(-1).interactive.action.parameters.flow_action_payload.data.editable_items;
  assert.equal(editableItems.length, 1);
  const itemsCorrected = await f.reply("edit-items", { outcome: "item_corrected", flow_token: editItems.next_flow_token, draft_id: f.draftId, edit_item_id: editableItems[0].id, edit_quantity: "2", edit_unit_price: "1500" });
  assert.equal(itemsCorrected.next_screen, "REVIEW_INVOICE_DRAFT");
  loaded = await f.cartService.loadOwned(f.draftId, "owner-a", itemsCorrected.next_flow_token);
  assert.equal(loaded.value.client.name, "Benjamin");
  assert.equal(loaded.value.options.payment_terms, "Comptant");
  assert.equal(loaded.value.items.length, 1);
  assert.equal(loaded.value.items[0].quantity, 2);
  assert.equal(loaded.value.items[0].unit_price, 1500);
  assert.equal(loaded.value.items[0].item_id, editableItems[0].id);

  const editOptions = await f.reply("r-options", { outcome: "modify_options", flow_token: itemsCorrected.next_flow_token, draft_id: f.draftId });
  assert.equal(editOptions.next_screen, "EDIT_OPTIONS");
  const optionsCorrected = await f.reply("edit-options", { outcome: "options_corrected", flow_token: editOptions.next_flow_token, draft_id: f.draftId, tax_status: "not_applicable", discount_amount: "0", amount_paid: "0", payment_terms: "Sous 7 jours" });
  assert.equal(optionsCorrected.next_screen, "REVIEW_INVOICE_DRAFT");
  loaded = await f.cartService.loadOwned(f.draftId, "owner-a", optionsCorrected.next_flow_token);
  assert.equal(loaded.value.client.name, "Benjamin");
  assert.equal(loaded.value.items.length, 1);
  assert.equal(loaded.value.options.payment_terms, "Sous 7 jours");

  const flowCountBeforeFinalization = f.sentFlows.length;
  const finalized = await f.reply("finalize", { outcome: "finalize_draft", flow_token: optionsCorrected.next_flow_token, draft_id: f.draftId });
  const retry = await f.reply("finalize", { outcome: "finalize_draft", flow_token: optionsCorrected.next_flow_token, draft_id: f.draftId });
  assert.equal(finalized.handled, true);
  assert.equal(finalized.next_screen, null);
  assert.equal(retry.duplicate, true);
  assert.equal(f.sentFlows.length, flowCountBeforeFinalization);
  assert.equal(f.sentTexts.filter(({ text }) => text === "Votre brouillon est bien enregistré. Aucun crédit n’a été débité.").length, 1);
  const stored = await f.draftRepository.get(f.draftId);
  assert.equal(stored.status, "confirmed");
  assert.match(stored.options.finalization.issued_at_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(stored.options.finalization.issued_at_source, "server");
});
