"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiStatsService } = require("../kadiStatsService");

test("dashboard displays simplified monetization metrics with precise small rates", async () => {
  const sent = [];
  const service = makeKadiStatsService({
    sendText: async (to, text) => sent.push({ to, text }),
    getStats: async () => ({
      growth: {
        totalUsers: 2405,
        active30: 1004,
        active7: 108,
        active30Rate: 42,
        active7Rate: 4,
      },
      usage: {
        docsTotal: 660,
        docs30d: 162,
        docs7d: 16,
        docsPerActive30User: 0.16,
        usersWithDocs: 660,
      },
      monetization: {
        revenue30d: 4000,
        payingUsers: 2,
        paymentsReceived30d: 3,
        creditsPurchased30d: 40,
        pdfAfterFirstTopup30d: 4,
        creditsUsedAfterFirstTopup30d: 3,
        usersWithWallet: 10,
        usersZeroCredits: 1,
        usersLowCredits: 2,
      },
      funnel: {
        signupToActive30Rate: 42,
        activeToCreatedRate: 20,
        activeToPaidRate: 0,
        docUsersToPaidRate: 1,
        generatedToPaidRate: 0,
      },
      retention: {
        retention7Approx: 11,
      },
      alerts: [],
      insights: [],
    }),
  });

  const handled = await service.handleStatsCommand("22679999999", "/stats");

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CA clients 30j\s+4.?000 FCFA/);
  assert.match(sent[0].text, /Clients payants\s+2/);
  assert.match(sent[0].text, /Paiements reçus\s+3/);
  assert.match(sent[0].text, /Crédits vendus\s+40/);
  assert.match(sent[0].text, /Docs après paiement\s+4/);
  assert.match(sent[0].text, /Crédits utilisés\s+3/);
  assert.match(sent[0].text, /Actif→Client payant\s+0,2%/);
  assert.match(sent[0].text, /Créateur→Client\s+0,3%/);
  assert.doesNotMatch(sent[0].text, /Doc→Payé/);
  assert.doesNotMatch(sent[0].text, /Wallets suivis/);
  assert.doesNotMatch(sent[0].text, /0 crédit réel/);
  assert.doesNotMatch(sent[0].text, /Crédits faibles/);
  assert.doesNotMatch(sent[0].text, /Source soldes/);
  assert.doesNotMatch(sent[0].text, /PDF payants/);
  assert.doesNotMatch(sent[0].text, /Crédits PDF payants/);
});
