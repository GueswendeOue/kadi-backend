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

  function recomputeMissing(intent) {
    const missing = [];

    if (!intent?.client) {
      missing.push("client");
    }

    const items = Array.isArray(intent?.items) ? intent.items : [];
    if (items.length === 0) {
      missing.push("items");
    }

    const itemsMissingPrice = items.filter((i) => i?.unitPrice == null);
    if (itemsMissingPrice.length > 0) {
      missing.push("price");
    }

    return missing;
  }

  function buildReviewButtons(intent) {
    const buttons = [{ id: "INTENT_FIX", title: "✏️ Corriger" }];

    if (!Array.isArray(intent?.missing) || intent.missing.length === 0) {
      buttons.unshift({ id: "INTENT_OK", title: "✅ Valider" });
    }

    return buttons;
  }

  async function sendIntentReview(from, intent) {
    const msgText = buildIntentMessage(intent);
    const buttons = buildReviewButtons(intent);

    await sendButtons(from, msgText, buttons);

    const nextQuestion = getNextQuestion(intent);
    if (nextQuestion) {
      await sendText(from, nextQuestion);
    }
  }

  async function handleIntentFixText(from, text) {
    const s = getSession(from);
    if (!s) return false;

    const raw = String(text || "").trim();
    if (!raw) return false;

    const intent = s.intent;
    if (!intent || typeof intent !== "object") return false;

    // ===============================
    // FIX PRICE
    // ===============================
    if (s.step === "intent_fix_price") {
      const price = parseNumberSmart(raw);

      if (price == null || price <= 0) {
        await sendText(
          from,
          "💰 Je n’ai pas compris le prix.\n\nExemple : 5000"
        );
        return true;
      }

      const items = Array.isArray(intent.items) ? intent.items : [];
      const labelHint = s.intentPendingItemLabel || null;

      let targetItem = null;

      if (labelHint) {
        targetItem = items.find(
          (i) =>
            String(i?.label || "").toLowerCase() ===
            String(labelHint).toLowerCase()
        );
      }

      if (!targetItem) {
        targetItem = items.find((i) => i?.unitPrice == null);
      }

      if (!targetItem) {
        await sendText(
          from,
          "⚠️ Je n’ai pas trouvé l’élément à mettre à jour.\nRenvoyez votre demande."
        );
        return true;
      }

      targetItem.unitPrice = price;

      intent.missing = recomputeMissing(intent);
      s.intent = intent;
      s.intentPendingItemLabel = null;

      if (intent.missing.length === 0) {
        s.step = "intent_review";
      } else if (intent.missing.includes("price")) {
        s.step = "intent_fix_price";
      } else if (intent.missing.includes("client")) {
        s.step = "intent_fix_client";
      } else if (intent.missing.includes("items")) {
        s.step = "intent_fix_items";
      } else {
        s.step = "intent_review";
      }

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FIX CLIENT
    // ===============================
    if (s.step === "intent_fix_client") {
      intent.client = raw;
      intent.missing = recomputeMissing(intent);
      s.intent = intent;

      if (intent.missing.length === 0) {
        s.step = "intent_review";
      } else if (intent.missing.includes("price")) {
        s.step = "intent_fix_price";
      } else if (intent.missing.includes("items")) {
        s.step = "intent_fix_items";
      } else {
        s.step = "intent_review";
      }

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FIX ITEMS
    // ===============================
    if (s.step === "intent_fix_items") {
      const rebuilt = buildIntent(raw);

      if (
        !rebuilt ||
        !Array.isArray(rebuilt.items) ||
        rebuilt.items.length === 0
      ) {
        await sendText(
          from,
          "📦 Je n’ai pas bien compris les éléments.\n\nExemple : 2 portes à 25000 et 2 fenêtres à 5000"
        );
        return true;
      }

      intent.items = rebuilt.items;
      if (!intent.client && rebuilt.client) {
        intent.client = rebuilt.client;
      }

      intent.missing = recomputeMissing(intent);
      s.intent = intent;

      if (intent.missing.length === 0) {
        s.step = "intent_review";
      } else if (intent.missing.includes("price")) {
        s.step = "intent_fix_price";
      } else if (intent.missing.includes("client")) {
        s.step = "intent_fix_client";
      } else {
        s.step = "intent_review";
      }

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FREE CORRECTION IN ONE SENTENCE
    // ===============================
    if (s.step === "intent_fix") {
      const rebuilt = buildIntent(raw);

      if (!rebuilt || typeof rebuilt !== "object") {
        await sendText(
          from,
          "✏️ Je n’ai pas bien compris la correction.\n\nExemple : Devis pour Moussa, 2 portes à 25000"
        );
        return true;
      }

      rebuilt.missing = recomputeMissing(rebuilt);

      s.intent = rebuilt;
      s.intentPendingItemLabel = null;

      if (rebuilt.missing.length === 0) {
        s.step = "intent_review";
      } else if (rebuilt.missing.includes("client")) {
        s.step = "intent_fix_client";
      } else if (rebuilt.missing.includes("price")) {
        s.step = "intent_fix_price";
      } else if (rebuilt.missing.includes("items")) {
        s.step = "intent_fix_items";
      } else {
        s.step = "intent_review";
      }

      await sendIntentReview(from, rebuilt);
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