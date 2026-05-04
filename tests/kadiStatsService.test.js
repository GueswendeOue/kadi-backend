"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiStatsService } = require("../kadiStatsService");

test("dashboard displays business conversion metrics instead of misleading Doc to paid rate", async () => {
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
      },
      monetization: {
        revenue30d: 4000,
        payingUsers: 3,
        creditsPurchased30d: 40,
        pdfByPayingUsers30d: 2,
        pdfAfterFirstTopup30d: 4,
        paidCreditPdfConsumed30dProxy: 3,
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
  assert.match(sent[0].text, /CA réel 30j\s+4.?000 FCFA/);
  assert.match(sent[0].text, /Payants 30j\s+3/);
  assert.match(sent[0].text, /Crédits achetés\s+40/);
  assert.match(sent[0].text, /PDF payants 30j\s+2/);
  assert.match(sent[0].text, /PDF après recharge\s+4/);
  assert.match(sent[0].text, /Crédits PDF payants\s+3/);
  assert.match(sent[0].text, /Actif→Payé\s+0%/);
  assert.match(sent[0].text, /Doc users→Payé\s+1%/);
  assert.doesNotMatch(sent[0].text, /Doc→Payé/);
});
