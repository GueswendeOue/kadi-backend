"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiMenus } = require("../kadiMenus");
const { makeKadiPriorityRouter } = require("../kadiPriorityRouter");
const { makeKadiCertifiedFlow } = require("../kadiCertified/kadiCertifiedFlow");

const FEC_PREPARATION_MESSAGE =
  "La facture électronique certifiée est en préparation. Pour le moment, Kadi génère des factures classiques.";

test("public documents menu does not expose FEC option", async () => {
  const lists = [];
  const menus = makeKadiMenus({
    sendButtons: async () => {},
    sendList: async (to, payload) => lists.push({ to, payload }),
    getOrCreateProfile: async () => ({}),
    STAMP_ONE_TIME_COST: 1,
  });

  await menus.sendDocsMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  assert.equal(rows.some((row) => row.id === "DOC_FEC"), false);
  assert.equal(
    rows.some((row) => String(row.title).toLowerCase().includes("fec")),
    false
  );
});

test("non-admin FEC text requests are blocked with preparation message", async () => {
  const calls = [];
  let started = false;
  const router = makeKadiPriorityRouter({
    norm: (text) => String(text || ""),
    logger: { error: () => {} },
    sendText: async (to, text) => calls.push({ to, text }),
    sendHomeMenu: async () => {},
    sendDocsMenu: async () => {},
    startProfileFlow: async () => {},
    replyBalance: async () => {},
    sendRechargePacksMenu: async () => {},
    sendStampMenu: async () => {},
    sendProfileMenu: async () => {},
    sendCreditsMenu: async () => {},
    ensureAdmin: () => false,
    startCertifiedInvoiceFlow: async () => {
      started = true;
    },
  });

  const handled = await router.handleUltraPriorityText(
    "22670000000",
    "facture certifiée"
  );

  assert.equal(handled, true);
  assert.equal(started, false);
  assert.deepEqual(calls, [
    {
      to: "22670000000",
      text: FEC_PREPARATION_MESSAGE,
    },
  ]);
});

test("certified flow is admin-only and uses internal test wording", async () => {
  const calls = [];
  const session = {};
  let profileLoaded = false;
  const flow = makeKadiCertifiedFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    sendDocument: async () => {},
    getOrCreateProfile: async () => {
      profileLoaded = true;
      return {
        business_name: "Kadi Test",
        ifu: "1234567A",
      };
    },
    createCertifiedInvoiceFromDraft: async () => ({}),
    money: (value) => String(value),
    ensureAdmin: ({ wa_id }) => wa_id === "226ADMIN",
  });

  await flow.startCertifiedInvoiceFlow("226USER");
  assert.equal(profileLoaded, false);
  assert.deepEqual(calls, [
    {
      kind: "text",
      to: "226USER",
      text: FEC_PREPARATION_MESSAGE,
    },
  ]);

  calls.length = 0;
  await flow.startCertifiedInvoiceFlow("226ADMIN");

  assert.equal(profileLoaded, true);
  assert.equal(calls[0].kind, "buttons");
  assert.match(calls[0].text, /Mode test FEC/);
  assert.match(calls[0].text, /Pré-FEC interne/);
  assert.doesNotMatch(calls[0].text, /Facture Électronique Certifiée/);
});
