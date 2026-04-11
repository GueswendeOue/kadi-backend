"use strict";

function normText(v = "") {
  return String(v || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text = "", patterns = []) {
  return patterns.some((p) => p.test(text));
}

function detectBusinessContext(rawText = "") {
  const t = normText(rawText);

  if (
    hasAny(t, [
      /\b(villa|maison|chantier|construction|btp|fondation|dalle|brique|briques|ciment|tole|toles|tôle|tôles|fer|gravier|sable)\b/i,
    ])
  ) {
    return "btp";
  }

  if (
    hasAny(t, [
      /\b(electricien|electricite|électricité|prise|prises|cable|cables|câble|câbles|disjoncteur|disjoncteurs|ampoule|ampoules|installation electrique|installation électrique)\b/i,
    ])
  ) {
    return "electricite";
  }

  if (
    hasAny(t, [
      /\b(mecanicien|mécanicien|mecanique|mécanique|vidange|moteur|plaquette|plaquettes|embrayage|amortisseur|amortisseurs|courroie|pneu|pneus|piece|pieces|pièce|pièces|reparation voiture|réparation voiture|reparation moto|réparation moto)\b/i,
    ])
  ) {
    return "mecanique";
  }

  if (
    hasAny(t, [
      /\b(menuiserie|menuisier|porte|portes|fenetre|fenetres|fenêtre|fenêtres|placard|placards|bois|alu|aluminium)\b/i,
    ])
  ) {
    return "menuiserie";
  }

  if (
    hasAny(t, [
      /\b(coiffure|coiffeuse|salon|tresse|tresses|meche|mèche|mèches|shampoing|brushing|natte|nattes)\b/i,
    ])
  ) {
    return "coiffure";
  }

  if (
    hasAny(t, [
      /\b(couture|couturier|couturiere|couturière|pagne|pagnes|tenue|tenues|robe|robes|chemise|chemises)\b/i,
    ])
  ) {
    return "couture";
  }

  return "generic";
}

function detectVagueRequest(rawText = "") {
  const t = normText(rawText);

  if (!t) {
    return {
      isVague: false,
      reason: null,
      context: "generic",
    };
  }

  const hasPrice = /\b\d[\d\s.,]*(?:k|m|mille)?\b/i.test(t);
  const hasDocumentWord =
    /\b(devis|facture|recu|reçu|decharge|décharge)\b/i.test(t);

  const hasActionWord =
    /\b(je veux|fais|faire|calcule|calculer|combien|donne-moi|donne moi|preparer|préparer|estimer|estimation)\b/i.test(
      t
    );

  const hasProjectLikeWords = hasAny(t, [
  /\b(villa|maison|chantier|construction|projet|installation|reparation|réparation|travaux|btp)\b/i,
  /\bnombre de\b/i,
  /\bquantite de\b/i,
  /\bquantité de\b/i,
  /\bcombien de\b/i,
  /\bdevis d[' ]une?\b/i,
  /\bdevis pour une?\b/i,
]);

  const looksLikeClearLineItems =
    /(?:\d+\s*\w+.*\b[aà]\s*\d+)|(?:\bmain d[' ]oeuvre\b.*\b\d+)/i.test(t);

  if (hasProjectLikeWords && !hasPrice && !looksLikeClearLineItems) {
    return {
      isVague: true,
      reason: "project_estimation_without_items",
      context: detectBusinessContext(t),
    };
  }

  if (
    hasDocumentWord &&
    hasActionWord &&
    !hasPrice &&
    !looksLikeClearLineItems
  ) {
    return {
      isVague: true,
      reason: "document_request_without_items",
      context: detectBusinessContext(t),
    };
  }

  return {
    isVague: false,
    reason: null,
    context: detectBusinessContext(t),
  };
}

function buildSmartGuidanceMessage(rawText = "") {
  const { context } = detectVagueRequest(rawText);

  const intro =
    "Je peux préparer le document, mais j’ai besoin des éléments à mettre dedans.\n\n" +
    "Envoyez :\n" +
    "• les éléments ou services\n" +
    "• les quantités\n" +
    "• les prix\n\n";

  const examplesByContext = {
    btp:
      "Exemple :\n" +
      "1000 briques à 125\n" +
      "20 sacs de ciment à 5000\n" +
      "15 tôles à 9000\n" +
      "Main d’œuvre à 150000",
    electricite:
      "Exemple :\n" +
      "10 prises à 2500\n" +
      "2 rouleaux de câble à 15000\n" +
      "1 disjoncteur à 12000\n" +
      "Main d’œuvre à 50000",
    mecanique:
      "Exemple :\n" +
      "Vidange à 15000\n" +
      "2 plaquettes à 12000\n" +
      "Main d’œuvre à 10000",
    menuiserie:
      "Exemple :\n" +
      "2 portes à 85000\n" +
      "3 fenêtres à 45000\n" +
      "Pose à 60000",
    coiffure:
      "Exemple :\n" +
      "Tresses à 10000\n" +
      "Mèches à 15000\n" +
      "Main d’œuvre à 5000",
    couture:
      "Exemple :\n" +
      "2 pagnes à 6000\n" +
      "Couture 3 tenues à 15000\n" +
      "Retouche à 3000",
    generic:
      "Exemple :\n" +
      "2 portes à 25000\n" +
      "Main d’œuvre à 50000",
  };

  const outro =
    "\n\n💡 Astuce : vous pouvez aussi envoyer un vocal avec les éléments et les prix.";

  return (
    intro +
    (examplesByContext[context] || examplesByContext.generic) +
    outro
  );
}

function isGreetingToKadi(rawText = "") {
  const t = normText(rawText);

  if (!t) return false;

  const exactGreetings = [
    "kadi",
    "salut kadi",
    "bonjour kadi",
    "bonsoir kadi",
    "cc kadi",
    "coucou kadi",
    "hey kadi",
    "hello kadi",
  ];

  if (exactGreetings.includes(t)) return true;

  if (
    /\b(devis|facture|recu|reçu|decharge|décharge|pour|client)\b/i.test(t)
  ) {
    return false;
  }

  return false;
}

module.exports = {
  detectBusinessContext,
  detectVagueRequest,
  buildSmartGuidanceMessage,
  isGreetingToKadi,
};