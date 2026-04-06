"use strict";

function autoFixDraft(draft) {
  if (!draft.items) return draft;

  draft.items = draft.items.map((item) => {
    let qty = Number(item.qty) || 1;
    let price = Number(item.unitPrice) || 0;

    // 🔥 Cas terrain critique :
    // "2 portes 50000" → total → corriger en 25000
    if (qty > 1 && price > 100000) {
      price = Math.round(price / qty);
    }

    // 🔥 prix absurdement bas
    if (price < 100) {
      price = price * 1000;
    }

    return {
      label: clean(item.label),
      qty,
      unitPrice: price,
    };
  });

  draft.total = draft.items.reduce(
    (sum, i) => sum + i.qty * i.unitPrice,
    0
  );

  return draft;
}

function clean(t) {
  return String(t || "").trim() || "article";
}

module.exports = { autoFixDraft };