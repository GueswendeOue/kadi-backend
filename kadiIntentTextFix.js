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

  function normalizeText(value = "") {
    return String(value || "").trim();
  }

  function normalizeCompare(value = "") {
    return normalizeText(value).toLowerCase();
  }

  function sanitizeClientName(value = "") {
    return normalizeText(value).slice(0, 120);
  }

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

  function sanitizeIntent(intent) {
    const items = Array.isArray(intent?.items) ? intent.items : [];

    return {
      ...intent,
      client: intent?.client ? sanitizeClientName(intent.client) : null,
      items: items
        .map((item) => {
          const label = normalizeText(item?.label || "Produit").slice(0, 200);
          const qty = Number(item?.qty || 1);
          const unitPrice =
            item?.unitPrice == null ? null : Number(item.unitPrice);

          return {
            label: label || "Produit",
            qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
            unitPrice:
              unitPrice == null || !Number.isFinite(unitPrice) || unitPrice < 0
                ? null
                : unitPrice,
          };
        })
        .filter((item) => !!item.label),
    };
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

    const normalizedHint = normalizeCompare(labelHint);
    if (!normalizedHint) return null;

    return (
      items.find((i) => normalizeCompare(i?.label || "") === normalizedHint) ||
      items.find((i) =>
        normalizeCompare(i?.label || "").includes(normalizedHint)
      ) ||
      null
    );
  }

  function computeNextStep(intent) {
    if (
      !intent ||
      !Array.isArray(intent.missing) ||
      intent.missing.length === 0
    ) {
      return "intent_review";
    }

    if (intent.missing.includes("client")) return "intent_fix_client";
    if (intent.missing.includes("price")) return "intent_fix_price";
    if (intent.missing.includes("items")) return "intent_fix_items";

    return "intent_review";
  }

  function updateIntentAndStep(session, intent) {
    const cleaned = sanitizeIntent(intent);
    cleaned.missing = recomputeMissing(cleaned);

    session.intent = cleaned;
    session.step = computeNextStep(cleaned);

    return cleaned;
  }

  async function handleIntentFixText(from, text) {
    const s = getSession(from);
    if (!s) return false;

    const raw = normalizeText(text);
    if (!raw) return false;

    const intent = s.intent;
    if (!intent || typeof intent !== "object") {
      return false;
    }

    // ===============================
    // FIX PRICE
    // ===============================
    if (s.step === "intent_fix_price") {
      const parsedPrice = parseNumberSmart(raw);

      console.log("[KADI/INTENT_FIX] branch=intent_fix_price", {
        from,
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
          "⚠️ Je n’ai pas retrouvé l’élément à compléter.\nRenvoyez la phrase complète."
        );
        return true;
      }

      targetItem.unitPrice = parsedPrice;
      s.intentPendingItemLabel = null;

      const cleaned = updateIntentAndStep(s, intent);

      console.log("[KADI/INTENT_FIX] price_applied", {
        from,
        nextStep: s.step,
        intent: cleaned,
      });

      await sendIntentReview(from, cleaned);
      return true;
    }

    // ===============================
    // FIX CLIENT
    // ===============================
    if (s.step === "intent_fix_client") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix_client", {
        from,
        raw,
      });

      intent.client = sanitizeClientName(raw);

      const cleaned = updateIntentAndStep(s, intent);

      console.log("[KADI/INTENT_FIX] client_applied", {
        from,
        nextStep: s.step,
        intent: cleaned,
      });

      await sendIntentReview(from, cleaned);
      return true;
    }

    // ===============================
    // FIX ITEMS
    // ===============================
    if (s.step === "intent_fix_items") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix_items", {
        from,
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

      const cleaned = updateIntentAndStep(s, intent);

      console.log("[KADI/INTENT_FIX] items_applied", {
        from,
        nextStep: s.step,
        intent: cleaned,
      });

      await sendIntentReview(from, cleaned);
      return true;
    }

    // ===============================
    // FREE CORRECTION IN ONE SENTENCE
    // ===============================
    if (s.step === "intent_fix") {
      console.log("[KADI/INTENT_FIX] branch=intent_fix", {
        from,
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

      s.intentPendingItemLabel = null;

      const cleaned = updateIntentAndStep(s, rebuilt);

      console.log("[KADI/INTENT_FIX] rebuilt_intent_applied", {
        from,
        nextStep: s.step,
        intent: cleaned,
      });

      await sendIntentReview(from, cleaned);
      return true;
    }

    console.log("[KADI/INTENT_FIX] no_match", {
      from,
      step: s?.step || null,
      raw,
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