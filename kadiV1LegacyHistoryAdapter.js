"use strict";

const LEGACY_CLASSIFICATIONS = Object.freeze(["V1_NATIVE", "LEGACY_READ_ONLY", "LEGACY_UNKNOWN"]);

function createLegacyHistoryAdapter({ listOwnedLegacyDocuments, getOwnedLegacyDocument }) {
  if (typeof listOwnedLegacyDocuments !== "function" || typeof getOwnedLegacyDocument !== "function") {
    throw new TypeError("LEGACY_HISTORY_SOURCE_REQUIRED");
  }
  return Object.freeze({
    async list({ ownerWaId, ...query }) {
      const rows = await listOwnedLegacyDocuments({ ownerWaId, ...query });
      return rows.map((row) => ({ ...structuredClone(row), classification: row.classification === "LEGACY_READ_ONLY" ? "LEGACY_READ_ONLY" : "LEGACY_UNKNOWN" }));
    },
    async get({ ownerWaId, documentId }) {
      const row = await getOwnedLegacyDocument({ ownerWaId, documentId });
      if (!row) return null;
      return { ...structuredClone(row), classification: row.classification === "LEGACY_READ_ONLY" ? "LEGACY_READ_ONLY" : "LEGACY_UNKNOWN" };
    },
  });
}

module.exports = { LEGACY_CLASSIFICATIONS, createLegacyHistoryAdapter };
