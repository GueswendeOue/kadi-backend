"use strict";

function validateDraft(draft) {
  if (!draft.items || draft.items.length === 0) {
    return {
      ok: false,
      message:
        "Je n’ai pas trouvé d’articles. Exemple : '2 sacs ciment à 7500'",
    };
  }

  for (const item of draft.items) {
    if (!item.unitPrice || item.unitPrice <= 0) {
      return {
        ok: false,
        message: `Prix manquant pour ${item.label}`,
      };
    }
  }

  return { ok: true };
}

module.exports = { validateDraft };