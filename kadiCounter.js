"use strict";

const fs = require("fs");
const path = require("path");

const COUNTER_FILE = path.join(__dirname, "kadi_counters.json");

function loadCounters() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) return {};
    return JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function saveCounters(counters) {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counters, null, 2), "utf8");
  } catch {}
}

function pad(n, size = 4) {
  const s = String(n);
  return s.length >= size ? s : "0".repeat(size - s.length) + s;
}

function prefixForMode(mode, factureKind) {
  const m = String(mode || "").toLowerCase();
  if (m === "devis") return "DEV";
  if (m === "recu" || m === "reçu") return "RCU";
  if (m === "facture") return factureKind === "proforma" ? "PRO" : "FAC";
  return "DOC";
}

/**
 * Mois en lettres (FR) — sans accents pour éviter les soucis d'encodage dans certains systèmes
 * Si tu veux absolument "FÉV" / "AOÛ", dis-moi et je te fais la version accentuée.
 */
function monthCodeFR(monthIndex1to12) {
  const arr = ["JAN", "FEV", "MAR", "AVR", "MAI", "JUN", "JUL", "AOU", "SEP", "OCT", "NOV", "DEC"];
  return arr[(monthIndex1to12 - 1) % 12] || "UNK";
}

function nextDocNumber(mode, factureKind) {
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth() + 1; // 1..12
  const monthCode = monthCodeFR(monthIndex); // JAN/FEV/...

  const prefix = prefixForMode(mode, factureKind);

  // ✅ clé mensuelle => le compteur repart à 0 chaque mois
  const key = `${year}-${monthCode}-${prefix}`;

  const counters = loadCounters();
  counters[key] = (counters[key] || 0) + 1;
  saveCounters(counters);

  // Format: FAC-2026-JAN-0001
  return `${prefix}-${year}-${monthCode}-${pad(counters[key])}`;
}

module.exports = { nextDocNumber, prefixForMode };