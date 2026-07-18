"use strict";

const LEGACY_REPLY_ID_ALIASES = new Map([
  ["STAMP_MODIFY", "PROFILE_STAMP"],
  ["HISTORY_RESEND_PDF", "HISTORY_RESEND_SELECTED"],
]);

const LEGACY_REPLY_TITLE_IDS = new Map([
  ["avec tampon", "PRESTAMP_ADD_ONCE"],
  ["sans tampon", "PRESTAMP_SKIP"],
  ["modifier", "PROFILE_STAMP"],
  ["renvoyer pdf", "HISTORY_RESEND_SELECTED"],
  ["retour docs", "HISTORY_BACK"],
  ["fermer", "HISTORY_CLOSE"],
]);

function normalizeReplyTitle(value = "") {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getInteractiveReplyDetails(msg) {
  const rawReplyId = String(
    msg?.interactive?.button_reply?.id ||
      msg?.interactive?.list_reply?.id ||
      msg?.button?.payload ||
      ""
  ).trim();
  const replyTitle = String(
    msg?.interactive?.button_reply?.title ||
      msg?.interactive?.list_reply?.title ||
      msg?.button?.text ||
      ""
  ).trim();

  if (rawReplyId) {
    const aliasedId = LEGACY_REPLY_ID_ALIASES.get(rawReplyId) || rawReplyId;
    const titleMappedId = LEGACY_REPLY_TITLE_IDS.get(
      normalizeReplyTitle(aliasedId)
    );
    return {
      rawReplyId,
      replyId: titleMappedId || aliasedId,
      replyTitle,
    };
  }

  return {
    rawReplyId: null,
    replyId:
      LEGACY_REPLY_TITLE_IDS.get(normalizeReplyTitle(replyTitle)) || null,
    replyTitle,
  };
}

module.exports = {
  getInteractiveReplyDetails,
  normalizeReplyTitle,
};
