"use strict";

const { nextDocNumber: nextDocNumberDb } = require("./kadiCounterRepo");

/**
 * Compat: ton engine faisait nextDocNumber(mode, factureKind)
 * Maintenant ça doit utiliser la DB.
 */
async function nextDocNumber(mode, factureKind, { waId, dateISO }) {
  if (!waId) throw new Error("nextDocNumber: waId manquant");
  return nextDocNumberDb({ waId, mode, factureKind, dateISO });
}

module.exports = { nextDocNumber };