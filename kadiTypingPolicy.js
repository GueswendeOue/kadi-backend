"use strict";

function normalizeCommandText(text = "") {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isSimpleLocalCommand(text = "") {
  return [
    "menu",
    "accueil",
    "home",
    "retour",
    "stop",
    "solde",
    "credit",
    "credits",
    "recharge",
    "recharger",
    "acheter",
    "support",
    "aide",
    "tampon",
    "cachet",
    "historique",
  ].includes(normalizeCommandText(text));
}

function shouldSendTypingBeforeNaturalText(text = "") {
  const raw = String(text || "").trim();
  if (raw.length < 3) return false;
  return !isSimpleLocalCommand(raw);
}

function shouldSendTypingForInteractiveReply(replyId = "") {
  return [
    "OCR_DEVIS",
    "OCR_FACTURE",
    "OCR_RECU",
    "DOC_CONFIRM",
    "PRESTAMP_SKIP",
    "PRESTAMP_ADD_ONCE",
  ].includes(String(replyId || "").trim());
}

module.exports = {
  isSimpleLocalCommand,
  shouldSendTypingBeforeNaturalText,
  shouldSendTypingForInteractiveReply,
};
