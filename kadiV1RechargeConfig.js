"use strict";

const PACK_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function normalizePack(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("RECHARGE_PACK_INVALID");
  const allowed = new Set(["pack_id", "amount", "currency", "credits", "pricing_version", "active"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("RECHARGE_PACK_FIELD_UNKNOWN");
  if (typeof input.pack_id !== "string" || !PACK_ID_PATTERN.test(input.pack_id)) throw new TypeError("RECHARGE_PACK_ID_INVALID");
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) throw new TypeError("RECHARGE_PACK_AMOUNT_INVALID");
  if (typeof input.currency !== "string" || !CURRENCY_PATTERN.test(input.currency)) throw new TypeError("RECHARGE_PACK_CURRENCY_INVALID");
  if (!Number.isSafeInteger(input.credits) || input.credits < 1) throw new TypeError("RECHARGE_PACK_CREDITS_INVALID");
  if (typeof input.pricing_version !== "string" || !VERSION_PATTERN.test(input.pricing_version)) throw new TypeError("RECHARGE_PACK_VERSION_INVALID");
  if (typeof input.active !== "boolean") throw new TypeError("RECHARGE_PACK_ACTIVE_INVALID");
  return Object.freeze(clone(input));
}

function createRechargePackCatalog({ packs = [] } = {}) {
  if (!Array.isArray(packs)) throw new TypeError("RECHARGE_PACKS_INVALID");
  const byId = new Map();
  for (const input of packs) {
    const pack = normalizePack(input);
    if (byId.has(pack.pack_id)) throw new TypeError("RECHARGE_PACK_DUPLICATE");
    byId.set(pack.pack_id, pack);
  }
  return Object.freeze({
    getPack(packId) {
      const pack = byId.get(packId);
      return pack ? { ok: true, value: clone(pack) } : { ok: false, error: "RECHARGE_PACK_NOT_FOUND" };
    },
    listActivePacks() {
      return [...byId.values()].filter((pack) => pack.active).map(clone);
    },
  });
}

module.exports = { createRechargePackCatalog, normalizePack };
