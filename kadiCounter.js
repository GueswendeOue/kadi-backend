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

function nextDocNumber(mode, factureKind) {
  const year = new Date().getFullYear();
  const prefix = prefixForMode(mode, factureKind);
  const key = `${year}-${prefix}`;

  const counters = loadCounters();
  counters[key] = (counters[key] || 0) + 1;
  saveCounters(counters);

  return `${prefix}-${year}-${pad(counters[key])}`;
}

module.exports = { nextDocNumber, prefixForMode };