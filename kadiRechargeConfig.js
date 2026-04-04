"use strict";

function getRechargeOffers() {
  return {
    PACK_1000: {
      id: "PACK_1000",
      label: "1000F = 10 crédits",
      amountFcfa: 1000,
      credits: 10,
      includesStamp: false,
    },
    PACK_2000: {
      id: "PACK_2000",
      label: "2000F = 25 crédits",
      amountFcfa: 2000,
      credits: 25,
      includesStamp: false,
    },
    PACK_5000: {
      id: "PACK_5000",
      label: "5000F = 50 crédits + Tampon",
      amountFcfa: 5000,
      credits: 50,
      includesStamp: true,
    },
  };
}

function getRechargeOfferById(id) {
  return getRechargeOffers()[id] || null;
}

module.exports = {
  getRechargeOffers,
  getRechargeOfferById,
};