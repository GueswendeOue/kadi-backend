"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiCommandFlow } = require("../kadiCommandFlow");

function makeFlow(overrides = {}) {
  const calls = [];
  const flow = makeKadiCommandFlow({
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    startProfileFlow: async () => {
      calls.push({ kind: "profile" });
      return true;
    },
    sendHomeMenu: async () => true,
    sendCreditsMenu: async () => true,
    sendRechargePacksMenu: async () => true,
    sendDocsMenu: async () => true,
    ensureAdmin: () => false,
    norm: (text) => String(text || "").trim().toLowerCase(),
    ...overrides,
  });

  return { calls, flow };
}

test("stamp text intent guides user to Profil/Tampon with clear costs", async () => {
  const { calls, flow } = makeFlow();

  const handled = await flow.handleUserCommand(
    "22670000000",
    "je veux ajouter mon tampon"
  );

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "buttons");
  assert.match(calls[0].text, /Profil → Tampon/);
  assert.match(calls[0].text, /Avec tampon.*2 crédits/s);
  assert.match(calls[0].text, /Sans tampon.*1 crédit/s);
  assert.match(calls[0].text, /Envoyer mon tampon/);
  assert.match(calls[0].text, /tampon\/cachet/);
  assert.deepEqual(
    calls[0].buttons.map((button) => button.id),
    ["PROFILE_STAMP", "HOME_DOCS", "BACK_HOME"]
  );
});

test("plain profile command still starts profile flow", async () => {
  const { calls, flow } = makeFlow();

  const handled = await flow.handleUserCommand("22670000000", "profil");

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ kind: "profile" }]);
});

test("admin reengage segment command routes to segment handler", async () => {
  const { calls, flow } = makeFlow({
    ensureAdmin: () => true,
    handleReengageSegmentCommand: async (from, raw) => {
      calls.push({ kind: "reengage_segment", from, raw });
      return true;
    },
  });

  const handled = await flow.handleAdmin(
    { wa_id: "22679999999" },
    "/reengage_segment recent_active_zero_doc 20"
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    {
      kind: "reengage_segment",
      from: "22679999999",
      raw: "/reengage_segment recent_active_zero_doc 20",
    },
  ]);
});

test("admin test credit command adds wallet credits without real payment metadata", async () => {
  const addCalls = [];
  const { calls, flow } = makeFlow({
    ensureAdmin: () => true,
    addCredits: async (...args) => {
      addCalls.push(args);
      return { ok: true, balance: 20 };
    },
  });

  const handled = await flow.handleAdmin(
    { wa_id: "22679999999" },
    "/test_credit 22671630608 20 test_tampon"
  );

  assert.equal(handled, true);
  assert.equal(addCalls.length, 1);
  assert.deepEqual(addCalls[0][0], { waId: "22671630608" });
  assert.equal(addCalls[0][1], 20);
  assert.equal(addCalls[0][2], "admin_test_credit");
  assert.equal(addCalls[0][3], "admin_test_credit:22671630608:20:test_tampon");
  assert.deepEqual(addCalls[0][4], {
    source: "admin_test_command",
    isTestCredit: true,
    excludeFromRevenue: true,
    amountFcfa: 0,
    revenueFcfa: 0,
    credits: 20,
    adminWaId: "22679999999",
    waId: "22671630608",
    note: "test_tampon",
    date: new Date().toISOString().slice(0, 10),
  });
  assert.deepEqual(calls, [
    {
      kind: "text",
      to: "22679999999",
      text: "✅ 20 crédits test ajoutés à 22671630608. Aucun paiement réel enregistré.",
    },
  ]);
});

test("test credit command is admin only", async () => {
  let addCalled = false;
  const { calls, flow } = makeFlow({
    ensureAdmin: () => false,
    addCredits: async () => {
      addCalled = true;
    },
  });

  const handled = await flow.handleCommand(
    "22679999999",
    "/test_credit 22671630608 20 test_tampon",
    { wa_id: "22679999999" }
  );

  assert.equal(handled, false);
  assert.equal(addCalled, false);
  assert.deepEqual(calls, []);
});

test("support reply command is restricted to support admin and sends client message", async () => {
  const replies = [];
  const { calls, flow } = makeFlow({
    ensureAdmin: ({ wa_id }) => wa_id === "22670626055",
    supportPrincipalWaId: "22670626055",
    supportCommandHandlers: {
      replyToClient: async (payload) => {
        replies.push(payload);
        return { ok: true };
      },
    },
  });

  const handled = await flow.handleCommand(
    "22670626055",
    "/support_reply 22670000000 Bonjour, on regarde.",
    { wa_id: "22670626055" }
  );

  assert.equal(handled, true);
  assert.deepEqual(replies, [
    {
      agentWaId: "22670626055",
      clientWaId: "22670000000",
      message: "Bonjour, on regarde.",
    },
  ]);
  assert.deepEqual(calls, [
    {
      kind: "text",
      to: "22670626055",
      text: "✅ Réponse envoyée à +22670000000.",
    },
  ]);
});

test("support commands are not available to non-admin users", async () => {
  let called = false;
  const { calls, flow } = makeFlow({
    ensureAdmin: () => false,
    supportPrincipalWaId: "22670626055",
    supportCommandHandlers: {
      listOpenSessionsText: async () => {
        called = true;
        return "nope";
      },
    },
  });

  const handled = await flow.handleCommand("22670000000", "/support_list", {
    wa_id: "22670000000",
  });

  assert.equal(handled, false);
  assert.equal(called, false);
  assert.deepEqual(calls, []);
});

test("principal support admin can add and disable agents", async () => {
  const actions = [];
  const { calls, flow } = makeFlow({
    ensureAdmin: () => false,
    supportPrincipalWaId: "22670626055",
    supportCommandHandlers: {
      addAgent: async (payload) => actions.push({ type: "add", ...payload }),
      disableAgent: async (waId) => actions.push({ type: "disable", waId }),
    },
  });

  assert.equal(
    await flow.handleCommand(
      "22670626055",
      "/support_agent_add 70620000 Awa Support",
      { wa_id: "22670626055" }
    ),
    true
  );

  assert.equal(
    await flow.handleCommand(
      "22670626055",
      "/support_agent_disable 22670620000",
      { wa_id: "22670626055" }
    ),
    true
  );

  assert.deepEqual(actions, [
    { type: "add", waId: "22670620000", name: "Awa Support" },
    { type: "disable", waId: "22670620000" },
  ]);
  assert.match(calls[0].text, /Agent support ajouté/);
  assert.match(calls[1].text, /Agent support désactivé/);
});

test("existing admin credit command still uses manual paid topup reason", async () => {
  const addCalls = [];
  const { flow } = makeFlow({
    ensureAdmin: () => true,
    addCredits: async (...args) => {
      addCalls.push(args);
      return { ok: true, balance: 10 };
    },
  });

  const handled = await flow.handleAdmin(
    { wa_id: "22679999999" },
    "/credit 22671630608 10 1000 OM12345"
  );

  assert.equal(handled, true);
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0][2], "manual_om_topup");
  assert.equal(addCalls[0][4].source, "admin_command");
  assert.equal(addCalls[0][4].amountFcfa, 1000);
  assert.equal(addCalls[0][4].paymentMethod, "orange_money_manual");
});
