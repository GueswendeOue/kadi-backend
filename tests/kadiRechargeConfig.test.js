"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getRechargeOffers,
  getRechargeOfferById,
} = require("../kadiRechargeConfig");

test("returns active recharge offers in the expected order", () => {
  const offers = getRechargeOffers();
  const ids = Object.keys(offers);

  assert.deepEqual(ids, ["PACK_1000", "PACK_2000", "PACK_5000"]);
  assert.equal(offers.PACK_1000.amountFcfa, 1000);
  assert.equal(offers.PACK_1000.credits, 10);
  assert.equal(offers.PACK_2000.amountFcfa, 2000);
  assert.equal(offers.PACK_2000.credits, 25);
  assert.equal(offers.PACK_2000.isRecommended, true);
  assert.equal(offers.PACK_5000.amountFcfa, 5000);
  assert.equal(offers.PACK_5000.credits, 70);
});

test("looks up a single active offer and returns a defensive copy", () => {
  const offer = getRechargeOfferById("PACK_2000");

  assert.equal(offer.id, "PACK_2000");
  assert.equal(offer.amountFcfa, 2000);
  assert.equal(offer.credits, 25);

  offer.credits = 999;

  assert.equal(getRechargeOfferById("PACK_2000").credits, 25);
});

test("returns null for unknown or empty recharge offer ids", () => {
  assert.equal(getRechargeOfferById(""), null);
  assert.equal(getRechargeOfferById("UNKNOWN"), null);
});
