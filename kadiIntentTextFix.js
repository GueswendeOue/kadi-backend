"use strict";

function makeKadiIntentTextFix(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    buildIntent,
    buildIntentMessage,
    getNextQuestion,
    parseNumberSmart,
  } = deps;

  function buildReviewButtons(intent) {
    const buttons = [{ id: "INTENT_FIX", title: "✏️ Corriger" }];

    if (!Array.isArray(intent?.missing) || intent.missing.length === 0) {
      buttons.unshift({ id: "INTENT_OK", title: "🚀 Générer" });
    }

    return buttons;
  }

  async function sendIntentReview(from, intent) {
    const msgText = buildIntentMessage(intent);
    const buttons = buildReviewButtons(intent);

    await sendButtons(from, msgText, buttons);

    const nextQuestion = getNextQuestion(intent);
    return nextQuestion || null;
  }

  async function handleIntentFixText(from, text) {
    const s = getSession(from);
    const intent = s.intent || null;
    const t = String(text || "").trim();

    if (!intent || !s.step) return false;

    // ===============================
    // FIX CLIENT
    // ===============================
    if (s.step === "intent_fix_client") {
      if (!t) {
        await sendText(from, "👤 Écrivez simplement le nom du client.");
        return true;
      }

      intent.client = t;
      intent.missing = (intent.missing || []).filter((x) => x !== "client");

      s.intent = intent;
      s.step = "intent_review";

      const nextQuestion = await sendIntentReview(from, intent);
      if (nextQuestion) {
        if (intent.missing.includes("price")) {
          const nextItem = (intent.items || []).find((i) => i?.unitPrice == null);
          s.intentPendingItemLabel = nextItem?.label || null;
          s.step = "intent_fix_price";
        }
        await sendText(from, nextQuestion);
      }

      return true;
    }

    // ===============================
    // FIX PRICE
    // ===============================
    if (s.step === "intent_fix_price") {
      const price = parseNumberSmart(t);

      if (price == null) {
        await sendText(from, "💰 Je n’ai pas compris le prix.\nExemple : 5000");
        return true;
      }

      const itemLabel = s.intentPendingItemLabel || null;
      const items = Array.isArray(intent.items) ? intent.items : [];

      const targetItem =
        items.find((i) => i?.label === itemLabel && i?.unitPrice == null) ||
        items.find((i) => i?.unitPrice == null);

      if (!targetItem) {
        await sendText(from, "⚠️ Je n’ai pas retrouvé l’élément à corriger.");
        s.step = "intent_review";
        return true;
      }

      targetItem.unitPrice = price;

      intent.missing = (intent.missing || []).filter((x) => x !== "price");

      if (items.some((i) => i?.unitPrice == null)) {
        intent.missing.push("price");
      }

      s.intent = intent;
      s.intentPendingItemLabel = null;
      s.step = "intent_review";

      const nextQuestion = await sendIntentReview(from, intent);
      if (nextQuestion) {
        if (intent.missing.includes("price")) {
          const nextItem = (intent.items || []).find((i) => i?.unitPrice == null);
          s.intentPendingItemLabel = nextItem?.label || null;
          s.step = "intent_fix_price";
        }
        await sendText(from, nextQuestion);
      }

      return true;
    }

    // ===============================
    // FIX FULL SENTENCE / ITEMS
    // ===============================
    if (s.step === "intent_fix" || s.step === "intent_fix_items") {
      const rebuiltIntent = buildIntent(t);

      s.intent = rebuiltIntent;
      s.intentPendingItemLabel = null;
      s.step = "intent_review";

      const nextQuestion = await sendIntentReview(from, rebuiltIntent);
      if (nextQuestion) {
        if (rebuiltIntent.missing.includes("price")) {
          const nextItem = (rebuiltIntent.items || []).find((i) => i?.unitPrice == null);
          s.intentPendingItemLabel = nextItem?.label || null;
          s.step = "intent_fix_price";
        } else if (rebuiltIntent.missing.includes("client")) {
          s.step = "intent_fix_client";
        }
        await sendText(from, nextQuestion);
      }

      return true;
    }

    return false;
  }

  return {
    handleIntentFixText,
  };
}

module.exports = {
  makeKadiIntentTextFix,
};