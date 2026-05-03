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

test("stamp readiness does not require function title", async () => {
  const flow = makeKadiStampFlow({
    getSession: () => ({}),
    sendText: async () => {},
    sendButtons: async () => {},
    getOrCreateProfile: async () => ({}),
    updateProfile: async () => ({}),
  });

  assert.equal(
    flow.hasStampProfileReady({
      stamp_enabled: true,
      business_name: "Kadi Services",
      stamp_title: null,
    }),
    true
  );

  assert.equal(
    flow.hasStampProfileReady({
      stamp_enabled: true,
      owner_name: "Awa",
      stamp_title: "",
    }),
    true
  );

  assert.equal(
    flow.hasStampProfileReady({
      stamp_enabled: false,
      business_name: "Kadi Services",
    }),
    false
  );
});

test("stamp menu uses ready wording and marks function as optional", async () => {
  const sent = [];
  const flow = makeKadiStampFlow({
    getSession: () => ({}),
    sendText: async () => {},
    sendButtons: async (to, text, buttons) => {
      sent.push({ to, text, buttons });
    },
    getOrCreateProfile: async () => ({
      stamp_enabled: true,
      business_name: "Kadi Services",
      stamp_title: null,
    }),
    updateProfile: async () => ({}),
  });

  await flow.sendStampMenu("22670000000");

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Tampon prêt/);
  assert.match(sent[0].text, /Fonction : \*facultative\*/);
  assert.doesNotMatch(sent[0].text, /Statut : \*(ON|OFF)/i);
  assert.doesNotMatch(sent[0].text, /activé|désactivé/i);
  assert.match(sent[0].text, /Avec tampon = coût du PDF \+ \*1 crédit\*/);
  assert.match(sent[0].text, /photo de votre vrai tampon sera ajouté prochainement/);
});
