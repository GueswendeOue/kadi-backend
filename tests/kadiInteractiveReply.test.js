"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getInteractiveReplyDetails } = require("../kadiInteractiveReply");

function interactive(id, title) {
  return { interactive: { button_reply: { id, title } } };
}

test("current IDs are the primary routing source", () => {
  const cases = [
    ["PRESTAMP_ADD_ONCE", "Avec tampon"],
    ["PRESTAMP_SKIP", "Sans tampon"],
    ["PROFILE_STAMP", "Modifier"],
    ["HISTORY_RESEND_SELECTED", "Renvoyer PDF"],
    ["HISTORY_BACK", "Retour docs"],
    ["HISTORY_CLOSE", "Fermer"],
  ];
  for (const [id, title] of cases) {
    assert.equal(getInteractiveReplyDetails(interactive(id, title)).replyId, id);
  }
});

test("legacy button replies map through an explicit compatibility list", () => {
  const cases = [
    ["Avec tampon", "PRESTAMP_ADD_ONCE"],
    ["Sans tampon", "PRESTAMP_SKIP"],
    ["Modifier", "PROFILE_STAMP"],
    ["Renvoyer PDF", "HISTORY_RESEND_SELECTED"],
    ["Retour docs", "HISTORY_BACK"],
    ["Fermer", "HISTORY_CLOSE"],
    ["STAMP_MODIFY", "PROFILE_STAMP"],
    ["HISTORY_RESEND_PDF", "HISTORY_RESEND_SELECTED"],
  ];
  for (const [payload, expected] of cases) {
    const msg = { type: "button", button: { payload, text: payload } };
    assert.equal(getInteractiveReplyDetails(msg).replyId, expected, payload);
  }
});

test("limited title fallback handles an old title but rejects unknown replies", () => {
  assert.equal(
    getInteractiveReplyDetails({ button: { text: "🟦 Avec tampon" } }).replyId,
    "PRESTAMP_ADD_ONCE"
  );
  assert.equal(
    getInteractiveReplyDetails({ button: { text: "Option inconnue" } }).replyId,
    null
  );
});
