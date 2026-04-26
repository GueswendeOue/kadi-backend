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
