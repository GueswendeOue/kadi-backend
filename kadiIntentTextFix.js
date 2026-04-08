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

  function findTargetItemByHint(items, labelHint) {
    if (!Array.isArray(items) || items.length === 0) return null;
    if (!labelHint) return null;

    const normalizedHint = String(labelHint).trim().toLowerCase();

    return (
      items.find(
        (i) =>
          String(i?.label || "")
            .trim()
            .toLowerCase() === normalizedHint
      ) ||
      items.find((i) =>
        String(i?.label || "")
          .trim()
          .toLowerCase()
          .includes(normalizedHint)
      ) ||
      null
    );
  }

  function computeNextStep(intent) {
    if (!intent || !Array.isArray(intent.missing) || intent.missing.length === 0) {
      return "intent_review";
    }

    if (intent.missing.includes("client")) return "intent_fix_client";
    if (intent.missing.includes("price")) return "intent_fix_price";
    if (intent.missing.includes("items")) return "intent_fix_items";

    return "intent_review";
  }

  async function handleIntentFixText(from, text) {
    const s = getSession(from);

    console.log("[KADI/INTENT_FIX] incoming", {
      from,
      text,
      step: s?.step || null,
      hasIntent: !!s?.intent,
      intentPendingItemLabel: s?.intentPendingItemLabel || null,
      intent: s?.intent || null,
    });

    if (!s) return false;

    const raw = String(text || "").trim();
    if (!raw) return false;

    const intent = s.intent;
    if (!intent || typeof intent !== "object") {
      console.log("[KADI/INTENT_FIX] no_intent", { from, text, step: s?.step });
      return false;
    }

    // ===============================
    // FIX PRICE
    // ===============================
    if (s.step === "intent_fix_price") {
      const parsedPrice = parseNumberSmart(raw);

      console.log("[KADI/INTENT_FIX] branch=intent_fix_price", {
        raw,
        parsedPrice,
        labelHint: s.intentPendingItemLabel || null,
      });

      if (parsedPrice == null || parsedPrice <= 0) {
        await sendText(
          from,
          "💰 Je n’ai pas compris le prix.\n\nExemple : 5000"
        );
        return true;
      }

      const items = Array.isArray(intent.items) ? intent.items : [];
      const labelHint = s.intentPendingItemLabel || null;

      let targetItem = findTargetItemByHint(items, labelHint);

      if (!targetItem) {
        targetItem = items.find((i) => i?.unitPrice == null) || null;
      }

      if (!targetItem) {
        await sendText(
          from,
          "⚠️ Je n’ai pas retrouvé l’élément à compléter.\nTapez CORRIGER ou renvoyez la phrase complète."
        );
        return true;
      }

      targetItem.unitPrice = parsedPrice;

      intent.missing = recomputeMissing(intent);
      s.intent = intent;
      s.intentPendingItemLabel = null;
      s.step = computeNextStep(intent);

      console.log("[KADI/INTENT_FIX] price_applied", {
        updatedIntent: intent,
        nextStep: s.step,
      });

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FIX CLIENT
    // ===============================
    if (s.step === "intent_fix_client") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix_client", {
        raw,
      });

      intent.client = raw;
      intent.missing = recomputeMissing(intent);
      s.intent = intent;
      s.step = computeNextStep(intent);

      console.log("[KADI/INTENT_FIX] client_applied", {
        updatedIntent: intent,
        nextStep: s.step,
      });

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FIX ITEMS
    // ===============================
    if (s.step === "intent_fix_items") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix_items", {
        raw,
      });

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
      s.step = computeNextStep(intent);

      console.log("[KADI/INTENT_FIX] items_applied", {
        updatedIntent: intent,
        nextStep: s.step,
      });

      await sendIntentReview(from, intent);
      return true;
    }

    // ===============================
    // FREE CORRECTION IN ONE SENTENCE
    // ===============================
    if (s.step === "intent_fix") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix", {
        raw,
      });

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
      s.step = computeNextStep(rebuilt);

      console.log("[KADI/INTENT_FIX] rebuilt_intent_applied", {
        updatedIntent: rebuilt,
        nextStep: s.step,
      });

      await sendIntentReview(from, rebuilt);
      return true;
    }

    console.log("[KADI/INTENT_FIX] no_match", {
      from,
      text,
      step: s?.step || null,
    });

    return false;
  }

  return {
    handleIntentFixText,
  };
}

module.exports = {
  makeKadiIntentTextFix,
};