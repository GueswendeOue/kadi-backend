"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createKadiV1ProductionPresenter,
  loadFlowRegistry,
  buildV1FlowMessage,
} = require("../kadiV1ProductionPresenter");

const OWNER = "22670000000";
const FLOW_IDS = Object.freeze({
  ONBOARDING: "100001",
  MENU: "100002",
  DOCUMENT_TYPE: "100003",
  INVOICE_TYPE: "100017",
  RECEIPT_DETAILS: "100018",
  DOCUMENT_CLIENT: "100004",
  DOCUMENT_CONTENT: "100005",
  ARTICLE_FORM: "100016",
  DOCUMENT_OPTIONS: "100006",
  DOCUMENT_REVIEW: "100007",
  EDIT_CLIENT: "100008",
  EDIT_CONTENT: "100009",
  EDIT_OPTIONS: "100010",
  DOCUMENT_PREVIEW: "100011",
  GENERATION_CONFIRMATION: "100012",
  RECHARGE: "100013",
  HISTORY_SEARCH: "100014",
  DISCHARGE_DETAILS: "100015",
});

function config() {
  return {
    enabled: true,
    features: { voice: true },
    flowIds: FLOW_IDS,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const presenter = createKadiV1ProductionPresenter({
    config: config(),
    whatsappApi: {
      async sendTypingIndicator(messageId) {
        calls.push(["typing", messageId]);
      },
      async sendText(to, text) {
        calls.push(["text", { to, text }]);
      },
      async sendFlow(payload) {
        calls.push(["flow", payload]);
      },
      async sendButtons(to, body, buttons) {
        calls.push(["buttons", { to, body, buttons }]);
      },
    },
    sessionService: {
      async open(command) {
        calls.push(["session", command]);
        return {
          ok: true,
          value: {
            session_id: "kadi_session:presenter1",
          },
          duplicate: false,
        };
      },
    },
    ...overrides,
  });
  return { presenter, calls };
}

function issuerProfileReaderStub(profile) {
  return {
    async getIssuerProfileById({ issuerProfileId }) {
      return issuerProfileId === "issuer:1" ? { ok: true, value: profile } : { ok: false, error: "NOT_FOUND" };
    },
  };
}

test("all eighteen draft Flows expose one matching entry screen and session input, including the independent ARTICLE_FORM, INVOICE_TYPE and RECEIPT_DETAILS Flows", () => {
  const registry = loadFlowRegistry();
  assert.equal(Object.keys(registry).length, 18);
  assert.ok(Object.hasOwn(registry, "ARTICLE_FORM"));
  for (const [flowKey, contract] of Object.entries(registry)) {
    assert.equal(contract.entryScreen, flowKey);
    assert.ok(contract.dataKeys.includes("session_id"));
  }
  assert.ok(registry.ARTICLE_FORM.dataKeys.includes("unit_options"));
  assert.equal(registry.ARTICLE_FORM.dataKeys.includes("description"), false);
});

test("buildV1FlowMessage refuses a contract/flowKey mismatch", () => {
  const registry = loadFlowRegistry();
  assert.throws(() => buildV1FlowMessage({
    to: OWNER,
    flowKey: "DOCUMENT_CONTENT",
    flowId: FLOW_IDS.DOCUMENT_CONTENT,
    sessionId: "kadi_session:screen-guard",
    flowMode: "draft",
    contract: registry.ARTICLE_FORM,
    data: { session_id: "kadi_session:screen-guard" },
  }), /KADI_V1_PRESENTER_FLOW_KEY_INVALID/);
});

test("conversation sends canonical text before a server-bound Flow", async () => {
  const { presenter, calls } = harness();
  const result = await presenter.presentConversation({
    ownerWaId: OWNER,
    messageId: "wamid:conversation1",
    response: {
      handled: true,
      canonical_text: "Vérifiez les informations.",
      business_action: "DOCUMENT_READY",
      next_state: "READY_FOR_REVIEW",
      flow_request: {
        flow_key: "DOCUMENT_REVIEW",
        prefill: {
          document_id: "document:1",
          document_version: 4,
          document_type: "FACTURE",
        },
      },
      voice_request: null,
      events: [],
    },
  });

  assert.deepEqual(
    calls.map(([name]) => name),
    ["typing", "text", "session", "flow"]
  );
  assert.equal(result.text_sent, true);
  assert.equal(result.flow_sent, true);

  const session = calls.find(([name]) => name === "session")[1];
  assert.deepEqual(session.document, {
    document_id: "document:1",
    version: 4,
    document_type: "FACTURE",
    status: "READY_FOR_REVIEW",
  });
  assert.equal(session.expectedFlowKey, "DOCUMENT_REVIEW");

  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_REVIEW);
  assert.equal(parameters.flow_token, "kadi_session:presenter1");
  assert.equal(
    parameters.flow_action_payload.screen,
    "DOCUMENT_REVIEW"
  );
  assert.equal(
    parameters.flow_action_payload.data.session_id,
    "kadi_session:presenter1"
  );
  assert.equal(
    Object.hasOwn(
      parameters.flow_action_payload.data,
      "document_id"
    ),
    false
  );
  assert.equal(
    Object.hasOwn(
      parameters.flow_action_payload.data,
      "document_version"
    ),
    false
  );
});

test("duplicate Flow reply produces no duplicate outward message", async () => {
  const { presenter, calls } = harness();
  const result = await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:duplicate",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: true,
      result: { item_id: "item:1" },
    },
  });
  assert.equal(result.duplicate, true);
  assert.deepEqual(calls, []);
});

test("DOCUMENT_PREVIEW preview_summary contains the resolved issuer, the client and the content with its total", async () => {
  const { presenter, calls } = harness({
    issuerProfileReader: issuerProfileReaderStub({ business_name: "Kadi Boutique", owner_name: "Awa Traoré" }),
  });
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:verify",
    result: {
      handled: true,
      action: "VERIFY",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 6,
        document_type: "FACTURE",
        status: "VERIFIED",
        issuer_profile_id: "issuer:1",
        client: { name: "Client Test" },
        items: [{ item_id: "item:1", description: "Ordinateur", quantity_millis: 1000, unit: "unité", unit_price: 250000, line_total: 250000 }],
        subtotal: 250000, taxes: 0, discount: 0, total: 250000,
        receipt: null,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_PREVIEW);
  const summary = parameters.flow_action_payload.data.preview_summary;
  assert.match(summary, /^Parfait, votre facture est presque prête\. Vérifiez les informations avant de la générer\./);
  assert.match(summary, /Émetteur : Kadi Boutique — Awa Traoré/);
  assert.match(summary, /Client : Client Test/);
  assert.match(summary, /Ordinateur/);
  assert.match(summary, /Total : 250\s000 FCFA/);
});

test("DOCUMENT_PREVIEW intro text matches the exact canonical wording for each document type", async () => {
  const expected = {
    FACTURE: "Parfait, votre facture est presque prête. Vérifiez les informations avant de la générer.",
    DEVIS: "Parfait, votre devis est presque prêt. Vérifiez les informations avant de le générer.",
    RECU: "Parfait, votre reçu est presque prêt. Vérifiez les informations avant de le générer.",
    DECHARGE: "Parfait, votre décharge est presque prête. Vérifiez les informations avant de la générer.",
  };
  for (const [documentType, intro] of Object.entries(expected)) {
    const { presenter, calls } = harness();
    await presenter.presentFlowReply({
      ownerWaId: OWNER,
      messageId: `wamid:verify-${documentType}`,
      result: {
        handled: true,
        action: "VERIFY",
        duplicate: false,
        result: {
          document_id: `document:${documentType}`, version: 1, document_type: documentType, status: "VERIFIED",
          items: [], client: null, receipt: null, discharge: null,
        },
      },
    });
    const payload = calls.find(([name]) => name === "flow")[1];
    const summary = payload.interactive.action.parameters.flow_action_payload.data.preview_summary;
    assert.ok(summary.startsWith(intro), `${documentType}: ${summary}`);
  }
});

test("DOCUMENT_PREVIEW without a resolvable issuer profile still opens, omitting the issuer line", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:verify-no-issuer",
    result: {
      handled: true,
      action: "VERIFY",
      duplicate: false,
      result: {
        document_id: "document:1", version: 1, document_type: "FACTURE", status: "VERIFIED",
        issuer_profile_id: "issuer:missing", client: { name: "Client" }, items: [], receipt: null,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.preview_summary;
  assert.doesNotMatch(summary, /Émetteur :/);
  assert.match(summary, /Client : Client/);
});

test("each DOCUMENT_PREVIEW action opens its documented next screen", async () => {
  const cases = [
    { action: "EDIT_CLIENT", flowId: FLOW_IDS.EDIT_CLIENT, screen: "EDIT_CLIENT" },
    { action: "EDIT_CONTENT", flowId: FLOW_IDS.EDIT_CONTENT, screen: "EDIT_CONTENT" },
    { action: "EDIT_OPTIONS", flowId: FLOW_IDS.EDIT_OPTIONS, screen: "EDIT_OPTIONS" },
  ];
  for (const testCase of cases) {
    const { presenter, calls } = harness();
    await presenter.presentFlowReply({
      ownerWaId: OWNER,
      messageId: `wamid:${testCase.action}`,
      result: {
        handled: true,
        action: testCase.action,
        duplicate: false,
        result: {
          document_id: "document:1", version: 2, document_type: "FACTURE", status: "COLLECTING", items: [], client: null,
        },
      },
    });
    const payload = calls.find(([name]) => name === "flow")[1];
    const parameters = payload.interactive.action.parameters;
    assert.equal(parameters.flow_id, testCase.flowId, testCase.action);
    assert.equal(parameters.flow_action_payload.screen, testCase.screen, testCase.action);
  }
});

test("SAVE_FOR_LATER and CANCEL from DOCUMENT_PREVIEW send only the canonical text, no new Flow", async () => {
  for (const action of ["SAVE_FOR_LATER", "CANCEL"]) {
    const { presenter, calls } = harness();
    const result = await presenter.presentFlowReply({
      ownerWaId: OWNER,
      messageId: `wamid:${action}`,
      result: {
        handled: true,
        action,
        duplicate: false,
        result: {
          document_id: "document:1", version: 2, document_type: "FACTURE", status: "COLLECTING", items: [], client: null,
        },
      },
    });
    assert.equal(result.flow_sent, false, action);
    assert.equal(calls.some(([name]) => name === "flow"), false, action);
  }
});

test("preview result opens generation confirmation with the authoritative quote id", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:preview",
    result: {
      handled: true,
      action: "PREPARE_PDF",
      duplicate: false,
      result: {
        quote: { quote_id: "quote:1" },
        document: {
          document_id: "document:1",
          version: 5,
          document_type: "FACTURE",
          status: "AWAITING_GENERATION_CONFIRMATION",
        },
      },
    },
  });

  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(
    parameters.flow_action_payload.screen,
    "GENERATION_CONFIRMATION"
  );
  assert.equal(
    parameters.flow_action_payload.data.quote_id,
    "quote:1"
  );
});

test("START_ADD_CONTENT opens the independent ARTICLE_FORM Flow, never DOCUMENT_CONTENT's own id, with an empty form", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:start-add",
    result: {
      handled: true,
      action: "START_ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 2,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.ARTICLE_FORM);
  assert.notEqual(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
  assert.equal(parameters.flow_action_payload.screen, "ARTICLE_FORM");
  const session = calls.find(([name]) => name === "session")[1];
  assert.equal(session.expectedFlowKey, "ARTICLE_FORM");
  assert.equal(session.document.document_id, "document:1", "ARTICLE_FORM session must carry the current document/document_id");
  assert.ok(Array.isArray(parameters.flow_action_payload.data.unit_options));
  assert.equal(Object.hasOwn(parameters.flow_action_payload.data, "description"), false, "ARTICLE_FORM must never carry a stale prefill");
  assert.equal(Object.hasOwn(parameters.flow_action_payload.data, "quantity"), false, "ARTICLE_FORM must never carry a stale prefill");
});

test("choosing FACTURE opens INVOICE_TYPE, never DOCUMENT_CLIENT directly", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:select-facture",
    result: {
      handled: true,
      action: "SELECT_DOCUMENT_TYPE",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 1,
        document_type: "FACTURE",
        status: "COLLECTING",
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.INVOICE_TYPE);
  assert.notEqual(parameters.flow_id, FLOW_IDS.DOCUMENT_CLIENT);
  assert.equal(parameters.flow_action_payload.screen, "INVOICE_TYPE");
});

test("choosing DEVIS still opens DOCUMENT_CLIENT directly, never INVOICE_TYPE", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:select-DEVIS",
    result: {
      handled: true,
      action: "SELECT_DOCUMENT_TYPE",
      duplicate: false,
      result: { document_id: "document:1", version: 1, document_type: "DEVIS", status: "COLLECTING" },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_CLIENT);
  assert.equal(parameters.flow_action_payload.screen, "DOCUMENT_CLIENT");
});

test("choosing RECU opens the dedicated RECEIPT_DETAILS Flow, never DOCUMENT_CLIENT or ARTICLE_FORM", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:select-RECU",
    result: {
      handled: true,
      action: "SELECT_DOCUMENT_TYPE",
      duplicate: false,
      result: { document_id: "document:1", version: 1, document_type: "RECU", status: "COLLECTING" },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.RECEIPT_DETAILS);
  assert.notEqual(parameters.flow_id, FLOW_IDS.DOCUMENT_CLIENT);
  assert.notEqual(parameters.flow_id, FLOW_IDS.ARTICLE_FORM);
  assert.equal(parameters.flow_action_payload.screen, "RECEIPT_DETAILS");
});

test("SAVE_INVOICE_TYPE opens DOCUMENT_CLIENT next, for both FINAL and PROFORMA", async () => {
  for (const invoiceKind of ["FINAL", "PROFORMA"]) {
    const { presenter, calls } = harness();
    await presenter.presentFlowReply({
      ownerWaId: OWNER,
      messageId: `wamid:save-invoice-type-${invoiceKind}`,
      result: {
        handled: true,
        action: "SAVE_INVOICE_TYPE",
        duplicate: false,
        result: {
          document_id: "document:1",
          version: 2,
          document_type: "FACTURE",
          status: "COLLECTING",
          options: { invoice_kind: invoiceKind },
        },
      },
    });
    const payload = calls.find(([name]) => name === "flow")[1];
    const parameters = payload.interactive.action.parameters;
    assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_CLIENT);
    assert.equal(parameters.flow_action_payload.screen, "DOCUMENT_CLIENT");
  }
});

test("DOCUMENT_PREVIEW intro names the precise invoice kind once it is set", async () => {
  for (const [invoiceKind, expectedIntro] of [
    ["FINAL", "Parfait, votre facture définitive est presque prête. Vérifiez les informations avant de la générer."],
    ["PROFORMA", "Parfait, votre facture proforma est presque prête. Vérifiez les informations avant de la générer."],
  ]) {
    const { presenter, calls } = harness();
    await presenter.presentFlowReply({
      ownerWaId: OWNER,
      messageId: `wamid:verify-kind-${invoiceKind}`,
      result: {
        handled: true,
        action: "VERIFY",
        duplicate: false,
        result: {
          document_id: "document:1", version: 1, document_type: "FACTURE", status: "VERIFIED",
          items: [], client: null, receipt: null, options: { invoice_kind: invoiceKind },
        },
      },
    });
    const payload = calls.find(([name]) => name === "flow")[1];
    const summary = payload.interactive.action.parameters.flow_action_payload.data.preview_summary;
    assert.ok(summary.startsWith(expectedIntro), summary);
  }
});

test("FINISH_CONTENT opens DOCUMENT_OPTIONS directly and never reopens DOCUMENT_CONTENT or ARTICLE_FORM", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:finish-content",
    result: {
      handled: true,
      action: "FINISH_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 4,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_OPTIONS);
  assert.equal(parameters.flow_action_payload.screen, "DOCUMENT_OPTIONS");
  assert.notEqual(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
});

test("FINISH_CONTENT opening DOCUMENT_OPTIONS carries a real items summary, not the generic placeholder", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:finish-content-summary",
    result: {
      handled: true,
      action: "FINISH_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 4,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.current_summary;
  assert.notEqual(summary, "Aucune option particulière.");
  assert.ok(summary.includes("Ciment"), summary);
});

test("a successful ADD_CONTENT reopens the DOCUMENT_CONTENT decision screen", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:add-content",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 3,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [{ item_id: "item:1", description: "Ciment", quantity: 2, unit_price: 5000 }],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
  assert.equal(parameters.flow_action_payload.screen, "DOCUMENT_CONTENT");
});

test("a second ADD_CONTENT keeps the previously saved article in the decision screen's summary", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:add-content-second",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 4,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [
          { item_id: "item:1", description: "Ordinateur", quantity_millis: 1000, unit: "unité", unit_price: 250000, line_total: 250000 },
          { item_id: "item:2", description: "Souris", quantity_millis: 1000, unit: "unité", unit_price: 5000, line_total: 5000 },
        ],
        subtotal: 255000, taxes: 0, discount: 0, total: 255000, client: null, receipt: null,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.items_summary;
  assert.match(summary, /Ordinateur/, "the article added first must still be listed");
  assert.match(summary, /Souris/, "the newly added article must also be listed");
  assert.match(summary, /Total : 255\s000 FCFA/);
});

test("items_summary reflects the real saved items: description, quantity, unit, price, line total and document total", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:items-summary",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 3,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [
          { item_id: "item:1", description: "Ordinateur", quantity_millis: 1000, unit: "unité", unit_price: 250000, line_total: 250000 },
        ],
        subtotal: 250000,
        taxes: 0,
        discount: 0,
        total: 250000,
        client: null,
        receipt: null,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.items_summary;
  assert.match(summary, /Articles enregistrés/);
  assert.match(summary, /Ordinateur/);
  assert.match(summary, /1 unité/);
  assert.match(summary, /250\s000 FCFA/);
  assert.match(summary, /=\s*250\s000 FCFA/);
  assert.match(summary, /Total : 250\s000 FCFA/);
  assert.doesNotMatch(summary, /Aucun article enregistré/);
});

test("items_summary caps the list at 10 items and reports the remaining count", async () => {
  const { presenter, calls } = harness();
  const items = Array.from({ length: 12 }, (_, index) => ({
    item_id: `item:${index + 1}`,
    description: `Article ${index + 1}`,
    quantity_millis: 1000,
    unit: "unité",
    unit_price: 1000,
    line_total: 1000,
  }));
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:items-summary-cap",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:1", version: 13, document_type: "FACTURE", status: "COLLECTING",
        items, subtotal: 12000, taxes: 0, discount: 0, total: 12000, client: null, receipt: null,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.items_summary;
  assert.match(summary, /Article 10/);
  assert.doesNotMatch(summary, /Article 11/);
  assert.match(summary, /… et 2 autres/);
});

test("RECU gets its own items_summary shape instead of a forced item list", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:receipt-summary",
    result: {
      handled: true,
      action: "ADD_CONTENT",
      duplicate: false,
      result: {
        document_id: "document:2", version: 1, document_type: "RECU", status: "COLLECTING",
        items: [], client: null,
        receipt: { payer: "Moussa", beneficiary: "Boutique Awa", amount: 15000, reason: "Achat tissu", payment_method: null, reference: null },
        subtotal: 15000, taxes: 0, discount: 0, total: 15000,
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const summary = payload.interactive.action.parameters.flow_action_payload.data.items_summary;
  assert.match(summary, /Payeur : Moussa/);
  assert.match(summary, /Bénéficiaire : Boutique Awa/);
  assert.match(summary, /Montant : 15\s000 FCFA/);
  assert.doesNotMatch(summary, /Articles enregistrés/);
});

test("SAVE_CLIENT always opens the independent ARTICLE_FORM Flow, never DOCUMENT_CONTENT", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid:save-client",
    result: {
      handled: true,
      action: "SAVE_CLIENT",
      duplicate: false,
      result: {
        document_id: "document:1",
        version: 2,
        document_type: "FACTURE",
        status: "COLLECTING",
        items: [],
      },
    },
  });
  const payload = calls.find(([name]) => name === "flow")[1];
  const parameters = payload.interactive.action.parameters;
  assert.equal(parameters.flow_id, FLOW_IDS.ARTICLE_FORM);
  assert.notEqual(parameters.flow_id, FLOW_IDS.DOCUMENT_CONTENT);
  assert.equal(parameters.flow_action_payload.screen, "ARTICLE_FORM");
});

test("recoverable error sends only canonical user text and never exposes the reason", async () => {
  const { presenter, calls } = harness();
  await presenter.presentRecoverableError({
    ownerWaId: OWNER,
    messageId: "wamid:error",
    canonicalText: "Réessayez dans un instant.",
    reason: "PRIVATE_PROVIDER_FAILURE",
  });
  const serialized = JSON.stringify(calls);
  assert.match(serialized, /Réessayez dans un instant/);
  assert.doesNotMatch(serialized, /PRIVATE_PROVIDER_FAILURE/);
});

test("delivery-failure-with-retry offers exactly one button and the exact required French copy, with no technical term exposed", async () => {
  const { presenter, calls } = harness();
  await presenter.presentDeliveryFailureWithRetry({
    ownerWaId: OWNER,
    messageId: "wamid:delivery-failed",
    documentId: "document:8a2445480a88eb66f64301faa0eac605",
  });
  const buttonsCall = calls.find(([name]) => name === "buttons");
  assert.ok(buttonsCall, "must send an interactive buttons message");
  const [, { to, body, buttons }] = buttonsCall;
  assert.equal(to, OWNER);
  assert.equal(body, "Votre PDF est prêt, mais son envoi n’a pas abouti.\nAppuyez sur « Réenvoyer le PDF ».\nAucun crédit supplémentaire ne sera débité.");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].title, "Réenvoyer le PDF");
  assert.equal(buttons[0].id, "RETRY_DELIVERY:document:8a2445480a88eb66f64301faa0eac605");
  const serialized = JSON.stringify(calls);
  for (const forbidden of ["DELIVERY_RECOVERABLE_FAILURE", "destination", "flow_token", "document_id", "RECOVERABLE_FAILURE"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden), `must never expose "${forbidden}" verbatim as a technical field name`);
  }
});

test("delivery retry outcome messages match exactly what the mission specifies, per outcome", async () => {
  const { presenter, calls } = harness();
  await presenter.presentDeliveryRetryOutcome({ ownerWaId: OWNER, messageId: "wamid:1", outcome: "SUCCEEDED" });
  await presenter.presentDeliveryRetryOutcome({ ownerWaId: OWNER, messageId: "wamid:2", outcome: "FAILED_PERSISTENT" });
  await presenter.presentDeliveryRetryOutcome({ ownerWaId: OWNER, messageId: "wamid:3", outcome: "REJECTED" });
  const texts = calls.filter(([name]) => name === "text").map(([, value]) => value.text);
  assert.equal(texts[0], "Votre document a bien été renvoyé.");
  assert.equal(texts[1], "Le PDF est toujours disponible.\nL’envoi n’a pas abouti et aucun crédit supplémentaire n’a été débité.\nVous pourrez réessayer.");
  assert.match(texts[2], /Réessayez/);
  assert.doesNotMatch(texts[2], /DELIVERY_RETRY_NOT_ELIGIBLE|documentId|GENERATION_ATTEMPT/);
});

test("outcome-unknown offer sends two distinct buttons (resend / cancel) with the exact required French copy, no technical term exposed", async () => {
  const { presenter, calls } = harness();
  await presenter.presentDeliveryOutcomeUnknownWithRetry({
    ownerWaId: OWNER, messageId: "wamid:unknown", documentId: "document:8a2445480a88eb66f64301faa0eac605",
  });
  const [, { to, body, buttons }] = calls.find(([name]) => name === "buttons");
  assert.equal(to, OWNER);
  assert.equal(body, "Nous ne sommes pas certains que votre document ait été envoyé la dernière fois.\nSouhaitez-vous le renvoyer ?\nAucun crédit supplémentaire ne sera débité.");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].id, "RESEND_UNKNOWN_DELIVERY:document:8a2445480a88eb66f64301faa0eac605");
  assert.equal(buttons[0].title, "Renvoyer le PDF");
  assert.equal(buttons[1].id, "CANCEL_UNKNOWN_DELIVERY:document:8a2445480a88eb66f64301faa0eac605");
  assert.equal(buttons[1].title, "Annuler");
  const serialized = JSON.stringify(calls);
  for (const forbidden of ["DELIVERY_OUTCOME_UNKNOWN", "flow_token", "RECOVERABLE_FAILURE"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("cancelling an outcome-unknown resend sends a neutral acknowledgment and nothing else", async () => {
  const { presenter, calls } = harness();
  await presenter.presentDeliveryRetryCancelled({ ownerWaId: OWNER, messageId: "wamid:cancel", documentId: "document:1" });
  const [, { text }] = calls.find(([name]) => name === "text");
  assert.equal(text, "D’accord, je ne renvoie rien pour le moment. Vous pourrez le faire plus tard depuis l’historique.");
});

test("a still-fresh in-progress delivery offers a single check-status button, not a resend offer", async () => {
  const { presenter, calls } = harness();
  await presenter.presentDeliveryInProgress({ ownerWaId: OWNER, messageId: "wamid:progress", documentId: "document:1" });
  const [, { body, buttons }] = calls.find(([name]) => name === "buttons");
  assert.equal(body, "L’envoi de votre document est toujours en cours.");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].id, "RETRY_DELIVERY:document:1");
});

test("opening a document from history whose delivery needs attention offers the retry action instead of the generic 'document is open' text — confirmed failure", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER, messageId: "wamid:open",
    result: {
      handled: true, action: "OPEN_DOCUMENT", duplicate: false,
      result: {
        summary: { document_id: "document:stuck", actions: ["VIEW", "DOWNLOAD", "RETRY_DELIVERY"] },
        delivery: { status: "RECOVERABLE_FAILURE", outcome: "CONFIRMED_FAILURE" },
      },
    },
  });
  const [, { buttons }] = calls.find(([name]) => name === "buttons");
  assert.equal(buttons[0].id, "RETRY_DELIVERY:document:stuck");
  assert.equal(calls.some(([name]) => name === "text"), false, "must not also send the generic OPEN_DOCUMENT text");
});

test("opening a document from history classified as outcome-unknown offers the two-button confirmation instead of an immediate resend", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER, messageId: "wamid:open-unknown",
    result: {
      handled: true, action: "OPEN_DOCUMENT", duplicate: false,
      result: {
        summary: { document_id: "document:stuck", actions: ["VIEW", "DOWNLOAD", "RETRY_DELIVERY"] },
        delivery: { status: "RECOVERABLE_FAILURE", outcome: "OUTCOME_UNKNOWN" },
      },
    },
  });
  const [, { buttons }] = calls.find(([name]) => name === "buttons");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].id, "RESEND_UNKNOWN_DELIVERY:document:stuck");
});

test("opening a document with no delivery issue keeps the ordinary generic OPEN_DOCUMENT presentation", async () => {
  const { presenter, calls } = harness();
  await presenter.presentFlowReply({
    ownerWaId: OWNER, messageId: "wamid:open-normal",
    result: {
      handled: true, action: "OPEN_DOCUMENT", duplicate: false,
      result: { summary: { document_id: "document:ok", actions: ["VIEW", "DOWNLOAD"] }, delivery: { status: "DELIVERED", outcome: null } },
    },
  });
  assert.equal(calls.some(([name]) => name === "buttons"), false);
  const [, { text }] = calls.find(([name]) => name === "text");
  assert.equal(text, "Le document est ouvert.");
});

test("voice failure is non-blocking after the mandatory text", async () => {
  const { presenter, calls } = harness({
    voiceResponseEngine: {
      async generate() {
        throw Object.assign(new Error("private"), {
          code: "VOICE_PROVIDER_FAILED",
        });
      },
    },
    voiceDelivery: {
      async sendGeneratedVoice() {
        calls.push(["voice"]);
      },
    },
    logger: { log() {} },
  });

  const result = await presenter.presentConversation({
    ownerWaId: OWNER,
    messageId: "wamid:voice",
    response: {
      handled: true,
      canonical_text: "Votre document est prêt.",
      business_action: "DOCUMENT_READY",
      next_state: null,
      flow_request: null,
      voice_request: {
        mode: "TEXT_AND_VOICE",
        reason: "POLICY",
      },
      events: [],
    },
  });

  assert.equal(result.text_sent, true);
  assert.equal(result.voice_sent, false);
  assert.equal(calls.filter(([name]) => name === "text").length, 1);
  assert.equal(calls.filter(([name]) => name === "voice").length, 0);
});

test("production presenter construction performs no Supabase or WhatsApp I/O", () => {
  let externalCalls = 0;
  const presenter = createKadiV1ProductionPresenter({
    config: config(),
    supabase: {
      from() {
        externalCalls += 1;
        throw new Error("BOOT_QUERY_FORBIDDEN");
      },
      rpc() {
        externalCalls += 1;
        throw new Error("BOOT_RPC_FORBIDDEN");
      },
    },
    whatsappApi: {
      async sendText() {
        externalCalls += 1;
      },
      async sendFlow() {
        externalCalls += 1;
      },
      async sendButtons() {
        externalCalls += 1;
      },
    },
  });
  assert.equal(externalCalls, 0);
  assert.equal(presenter.readiness.ready, true);
  assert.equal(presenter.readiness.boot_external_calls, 0);
});
