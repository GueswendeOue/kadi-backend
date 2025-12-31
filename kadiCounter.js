// kadiCounter.js
// ==========================================
// Compteurs persistants (DEV/FAC/RCU)
// Stockage simple dans un fichier JSON
// ==========================================

const fs = require("fs");
const path = require("path");

const COUNTER_FILE = path.join(__dirname, "kadi_counters.json");

function loadCounters() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) return {};
    const raw = fs.readFileSync(COUNTER_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("❌ loadCounters error:", e);
    return {};
  }
}

function saveCounters(counters) {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counters, null, 2), "utf8");
  } catch (e) {
    console.error("❌ saveCounters error:", e);
  }
}

function pad(n, size = 4) {
  const s = String(n);
  return s.length >= size ? s : "0".repeat(size - s.length) + s;
}

function prefixForMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "devis") return "DEV";
  if (m === "facture") return "FAC";
  if (m === "recu" || m === "reçu") return "RCU";
  return "DOC";
}

function nextDocNumber(mode) {
  const prefix = prefixForMode(mode);
  const counters = loadCounters();

  counters[prefix] = (counters[prefix] || 0) + 1;
  saveCounters(counters);

  return `${prefix}-${pad(counters[prefix])}`;
}

module.exports = { nextDocNumber, prefixForMode };