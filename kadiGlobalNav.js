"use strict";

const GLOBAL_MENU_TEXTS = new Set([
  "menu",
  "accueil",
  "home",
  "retour",
  "stop",
  "annuler",
  "annule",
]);

function normalizeGlobalNavText(value = "") {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isGlobalMenuText(value = "") {
  return GLOBAL_MENU_TEXTS.has(normalizeGlobalNavText(value));
}

module.exports = {
  GLOBAL_MENU_TEXTS,
  isGlobalMenuText,
  normalizeGlobalNavText,
};
