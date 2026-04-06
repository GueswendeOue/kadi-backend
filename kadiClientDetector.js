"use strict";

const NAMES = [
  "moussa","adama","aminata","fatima","issa",
  "ibrahim","ousmane","karim","abdou","salif"
];

function detectClient(text = "") {
  const t = text.toLowerCase();

  for (const name of NAMES) {
    if (t.includes(name)) {
      return capitalize(name);
    }
  }

  return null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { detectClient };