"use strict";

const RECHARGE_OFFERS = {
  PACK_1000: {
    id: "PACK_1000",
    label: "1000F = 10 crédits",
    amountFcfa: 1000,
    credits: 10,
    includesStamp: false,
    isActive: true,
    sortOrder: 1,
  },

  PACK_2000: {
    id: "PACK_2000",
    label: "2000F = 25 crédits",
    amountFcfa: 2000,
    credits: 25,
    includesStamp: false,
    isActive: true,
    sortOrder: 2,
    isRecommended: true,
  },

  PACK_5000: {
    id: "PACK_5000",
    label: "5000F = 70 crédits",
    amountFcfa: 5000,
    credits: 70,
    includesStamp: false,
    isActive: true,
    sortOrder: 3,
  },
};

function cloneOffer(offer) {
  if (!offer || typeof offer !== "object") return null;
  return { ...offer };
}

function getRechargeOffers() {
  const entries = Object.entries(RECHARGE_OFFERS)
    .filter(([, offer]) => offer?.isActive !== false)
    .sort((a, b) => {
      const aOrder = Number(a[1]?.sortOrder || 999);
      const bOrder = Number(b[1]?.sortOrder || 999);
      return aOrder - bOrder;
    });

  const result = {};
  for (const [key, offer] of entries) {
    result[key] = cloneOffer(offer);
  }

  return result;
}

function getRechargeOfferById(id) {
  const key = String(id || "").trim();
  if (!key) return null;

  const offer = RECHARGE_OFFERS[key];
  if (!offer || offer.isActive === false) return null;

  return cloneOffer(offer);
}

module.exports = {
  getRechargeOffers,
  getRechargeOfferById,
};