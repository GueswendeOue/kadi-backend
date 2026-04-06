"use strict";

/**
 * KADI Moore lexicon
 * Ciblé business / devis / facture / reçu / chantier / commerce.
 * Objectif: normaliser le mooré terrain vers un texte plus compréhensible
 * par l'intent engine, pas traduire toute la langue.
 */

const MOORE_NUMBER_MAP = {
  // unités
  "yembre": 1,
  "yende": 1,
  "yiiga": 1,
  "ye": 1,
  "a": 1,

  "yiibu": 2,
  "yibu": 2,
  "ibo": 2,
  "bii": 2,

  "taabo": 3,
  "tãabo": 3,

  "naasi": 4,
  "naase": 4,
  "naassé": 4,

  "nu": 5,

  "yobgo": 6,
  "yoobgo": 6,

  "yopoe": 7,
  "yopoee": 7,

  "nii": 8,

  "wae": 9,
  "waée": 9,

  "piiga": 10,

  // grands nombres fréquents
  "toukouli": 1000,
  "tus": 1000,
};

const MOORE_DOC_WORDS = {
  "yaabre": "recu",
  "reçu": "recu",
  "recu": "recu",

  "faktuur": "facture",
  "facture": "facture",

  "devi": "devis",
  "devis": "devis",

  "decharge": "decharge",
  "décharge": "decharge",
};

const MOORE_CLIENT_WORDS = {
  "raadenga": "client",
  "radenga": "client",
  "client": "client",
};

const MOORE_ACTION_WORDS = {
  "maane": "faire",
  "maané": "faire",
  "yao": "payer",
  "gome": "parler",
  "barka": "merci",
};

const MOORE_PRICE_WORDS = {
  "toogo": "prix",
  "a ye ligdi": "prix unitaire",
  "bil-tik ligdi": "prix unitaire",
  "ligdi": "argent",
  "barse": "negocier",
  "booge": "reduire prix",
};

const MOORE_PRODUCT_WORDS = {
  "sommeta": "ciment",
  "tuuru tando": "ciment",
  "tuuru tãdo": "ciment",

  "peem-leega": "fenetre",
  "peem-lêêga": "fenetre",
  "peem leega": "fenetre",

  // Variantes terrain utiles
  "wilga": "porte",
  "wila": "porte",
};

const FRENCH_VARIANTS = {
  "fenetre": "fenetre",
  "fenêtres": "fenetre",
  "fenêtres.": "fenetre",
  "portes": "porte",
  "porte": "porte",
  "fenetre.": "fenetre",
  "fenetre,": "fenetre",

  "ciments": "ciment",
  "sacs": "sac",
  "sac": "sac",

  "mille": "mille",
  "milles": "mille",
  "mil": "mille",

  "fcfa": "fcfa",
  "f": "f",
};

const PRODUCT_SYNONYMS = {
  porte: ["porte", "portes", "wilga", "wila"],
  fenetre: ["fenetre", "fenêtres", "fenetre", "peem-leega", "peem-lêêga"],
  ciment: ["ciment", "sommeta", "tuuru tando", "tuuru tãdo"],
  sac: ["sac", "sacs"],
};

const BUSINESS_HINTS = {
  greetings: [
    "neiboro",
    "nei beogo",
    "bonjour",
    "salut",
    "bonsoir",
  ],
  docs: ["devis", "facture", "recu", "decharge"],
  money: ["prix", "payer", "argent", "fcfa", "f", "mille", "k"],
};

module.exports = {
  MOORE_NUMBER_MAP,
  MOORE_DOC_WORDS,
  MOORE_CLIENT_WORDS,
  MOORE_ACTION_WORDS,
  MOORE_PRICE_WORDS,
  MOORE_PRODUCT_WORDS,
  FRENCH_VARIANTS,
  PRODUCT_SYNONYMS,
  BUSINESS_HINTS,
};