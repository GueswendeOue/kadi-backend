// kadiCommands.js
// ==========================================
// Parse commandes WhatsApp
// ==========================================

const { cleanNumber } = require("./kadiEngine");

function parseCommand(textRaw = "") {
  const t = String(textRaw).trim();

  // annule/reset
  if (/^(annule|annuler|reset)$/i.test(t)) return { type: "cancel" };

  // liste
  if (/^(liste|voir|affiche)$/i.test(t)) return { type: "show_list" };

  // client: ...
  {
    const m = t.match(/^client\s*[:\-]\s*(.+)$/i);
    if (m) return { type: "set_client", value: m[1].trim() };
  }

  // date: YYYY-MM-DD
  {
    const m = t.match(/^date\s*[:\-]\s*(\d{4}-\d{2}-\d{2})$/i);
    if (m) return { type: "set_date", value: m[1] };
  }

  // total: 15000
  {
    const m = t.match(/^total\s*[:\-]\s*(.+)$/i);
    if (m) {
      const n = cleanNumber(m[1]);
      if (n != null) return { type: "set_total_override", value: n };
    }
  }

  // ajoute: ...
  {
    const m = t.match(/^ajoute\s*[:\-]\s*([\s\S]+)$/i);
    if (m) {
      const lines = m[1].split("\n").map(s => s.trim()).filter(Boolean);
      return { type: "add_lines", lines };
    }
  }

  // supprime 2
  {
    const m = t.match(/^supprime\s+(\d+)$/i);
    if (m) return { type: "delete_item", index: Number(m[1]) };
  }

  // corrige 3: ...
  {
    const m = t.match(/^corrige\s+(\d+)\s*[:\-]\s*(.+)$/i);
    if (m) return { type: "replace_item", index: Number(m[1]), line: m[2].trim() };
  }

  return null; // pas une commande
}

module.exports = { parseCommand };