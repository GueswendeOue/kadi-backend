"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiStampFlow } = require("../kadiStampFlow");

test("pre-generation stamp menu shows explicit with/without stamp costs", async () => {
  const sent = [];
  const flow = makeKadiStampFlow({
    getSession: () => ({}),
    sendText: async () => {},
    sendButtons: async (to, text, buttons) => {
      sent.push({ to, text, buttons });
    },
    getOrCreateProfile: async () => ({}),
    updateProfile: async () => ({}),
  });

  await flow.sendPreGenerateStampMenu("22670000000", { baseCost: 1 });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /avec tampon.*2 crédits/i);
  assert.match(sent[0].text, /sans tampon.*1 crédit/i);
  assert.match(sent[0].text, /\+1 crédit/);
  assert.deepEqual(
    sent[0].buttons.map((button) => button.id),
    ["PRESTAMP_ADD_ONCE", "PRESTAMP_SKIP", "PROFILE_STAMP"]
  );
  assert.deepEqual(
    sent[0].buttons.map((button) => button.title),
    ["Avec tampon", "Sans tampon", "Modifier"]
  );
});
