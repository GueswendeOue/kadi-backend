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
  assert.match(calls[0].text, /photo de tampon n’est pas encore disponible/);
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
