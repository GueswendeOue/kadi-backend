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
    label: "5000F = 50 crédits + Tampon",
    amountFcfa: 5000,
    credits: 50,
    includesStamp: true,
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

function getRechargeOfferByAmount(amountFcfa) {
  const amount = Number(amountFcfa || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const offer = Object.values(RECHARGE_OFFERS).find(
    (item) => item?.isActive !== false && Number(item.amountFcfa) === amount
  );

  return cloneOffer(offer);
}

function getRecommendedRechargeOffer() {
  const offer = Object.values(RECHARGE_OFFERS).find(
    (item) => item?.isActive !== false && item?.isRecommended === true
  );

  if (offer) return cloneOffer(offer);

  const firstActive = Object.values(RECHARGE_OFFERS)
    .filter((item) => item?.isActive !== false)
    .sort((a, b) => Number(a?.sortOrder || 999) - Number(b?.sortOrder || 999))[0];

  return cloneOffer(firstActive);
}

module.exports = {
  getRechargeOffers,
  getRechargeOfferById,
  getRechargeOfferByAmount,
  getRecommendedRechargeOffer,
};