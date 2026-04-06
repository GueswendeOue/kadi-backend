"use strict";

// fallback ultra intelligent si GPT rate partiellement

function extractItemsFromText(text = "") {
  const t = text.toLowerCase();

  // split intelligent (+ , et)
  const parts = t.split(/\+|,| et /);

  const items = [];

  for (const p of parts) {
    const match = p.match(/(\d+)\s*(.+?)\s*(\d+)/);

    if (match) {
      items.push({
        label: match[2].trim(),
        qty: Number(match[1]),
        unitPrice: Number(match[3]),
      });
    }
  }

  return items;
}

module.exports = { extractItemsFromText };