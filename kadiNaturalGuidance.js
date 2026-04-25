"use strict";

function normText(v = "") {
  return String(v || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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
      /\b(villa|maison|chantier|construction|btp|fondation|dalle|brique|briques|ciment|tole|toles|fer|gravier|sable|crepissage|enduit|carrelage|peinture|plomberie|maconnerie|macon|travaux)\b/i,
    ])
  ) {
    return "btp";
  }

  if (
    hasAny(t, [
      /\b(electricien|electricite|prise|prises|cable|cables|disjoncteur|disjoncteurs|ampoule|ampoules|installation electrique|compteur|interrupteur|interrupteurs|gaine|gaines)\b/i,
    ])
  ) {
    return "electricite";
  }

  if (
    hasAny(t, [
      /\b(mecanicien|mecanique|vidange|moteur|plaquette|plaquettes|embrayage|amortisseur|amortisseurs|courroie|pneu|pneus|piece|pieces|reparation voiture|reparation moto|garage|huile|filtre|filtres)\b/i,
    ])
  ) {
    return "mecanique";
  }

  if (
    hasAny(t, [
      /\b(menuiserie|menuisier|porte|portes|fenetre|fenetres|placard|placards|bois|alu|aluminium|table|tables|chaise|chaises|armoire|armoires|pose)\b/i,
    ])
  ) {
    return "menuiserie";
  }

  if (
    hasAny(t, [
      /\b(coiffure|coiffeuse|salon|tresse|tresses|meche|meches|shampoing|brushing|natte|nattes|perruque|perruques)\b/i,
    ])
  ) {
    return "coiffure";
  }

  if (
    hasAny(t, [
      /\b(couture|couturier|couturiere|pagne|pagnes|tenue|tenues|robe|robes|chemise|chemises|retouche|retouches|boubou|boubous)\b/i,
    ])
  ) {
    return "couture";
  }

  if (
    hasAny(t, [
      /\b(boutique|commerce|marchandise|marchandises|vente|acheter|achat|produit|produits|carton|cartons|sac|sacs|riz|huile|sucre|savon|pagne|pagnes)\b/i,
    ])
  ) {
    return "commerce";
  }

  if (
    hasAny(t, [
      /\b(restaurant|resto|repas|plat|plats|commande|boisson|boissons|poulet|riz|alloco|service traiteur|traiteur|livraison repas)\b/i,
    ])
  ) {
    return "restauration";
  }

  return "generic";
}

function detectDocType(rawText = "") {
  const t = normText(rawText);

  if (/\b(facture|facturer)\b/i.test(t)) return "facture";

  if (/\b(recu|recu de paiement|recu paiement|recu pour)\b/i.test(t)) {
    return "recu";
  }

  if (/\b(decharge|decharger)\b/i.test(t)) return "decharge";

  if (/\b(devis|estimation|proforma)\b/i.test(t)) return "devis";

  return null;
}

function detectVagueRequest(rawText = "") {
  const t = normText(rawText);

  if (!t) {
    return {
      isVague: false,
      reason: null,
      context: "generic",
      docType: null,
    };
  }

  const hasPrice = /\b\d[\d\s.,]*(?:k|m|mil|mille|million|millions)?\b/i.test(t);

  const hasDocumentWord =
    /\b(devis|facture|recu|decharge|proforma|estimation)\b/i.test(t);

  const hasActionWord =
    /\b(je veux|j'aimerais|jaimerais|fais|faire|calcule|calculer|combien|donne-moi|donne moi|preparer|prepare|estimer|estimation|creer|cree|creation|besoin de|aide moi|aidez moi)\b/i.test(
      t
    );

  const hasProjectLikeWords = hasAny(t, [
    /\b(villa|maison|chantier|construction|projet|installation|reparation|travaux|btp|nombre de|quantite de|combien de)\b/i,
    /\bdevis d[' ]?une?\b/i,
    /\bdevis pour une?\b/i,
    /\bfacture pour une?\b/i,
  ]);

  const looksLikeClearLineItems =
    /(?:\d+\s*\w+.*\b(a|à)\s*\d+)|(?:\bmain d[' ]?oeuvre\b.*\b\d+)/i.test(t);

  const docType = detectDocType(t);
  const context = detectBusinessContext(t);

  if (hasProjectLikeWords && !hasPrice && !looksLikeClearLineItems) {
    return {
      isVague: true,
      reason: "project_estimation_without_items",
      context,
      docType,
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
      context,
      docType,
    };
  }

  if (
    hasDocumentWord &&
    t.split(" ").length <= 4 &&
    !hasPrice &&
    !looksLikeClearLineItems
  ) {
    return {
      isVague: true,
      reason: "short_document_request",
      context,
      docType,
    };
  }

  return {
    isVague: false,
    reason: null,
    context,
    docType,
  };
}

function getDocLabel(docType = null) {
  if (docType === "facture") return "facture";
  if (docType === "recu") return "reçu";
  if (docType === "decharge") return "décharge";
  if (docType === "devis") return "devis";
  return "document";
}

function getClientNameForContext(context = "generic") {
  if (context === "commerce") return "Awa";
  if (context === "restauration") return "Adama";
  if (context === "coiffure") return "Awa";
  if (context === "couture") return "Awa";
  return "Moussa";
}

function buildStructuredExample(context = "generic") {
  const examplesByContext = {
    btp:
      "Client : Moussa\n" +
      "1000 briques à 125\n" +
      "20 sacs de ciment à 5000\n" +
      "Main d’œuvre à 150000",

    electricite:
      "Client : Moussa\n" +
      "10 prises à 2500\n" +
      "2 rouleaux de câble à 15000\n" +
      "Main d’œuvre à 50000",

    mecanique:
      "Client : Moussa\n" +
      "Vidange à 15000\n" +
      "Filtre à huile à 5000\n" +
      "Main d’œuvre à 10000",

    menuiserie:
      "Client : Moussa\n" +
      "2 portes à 85000\n" +
      "3 fenêtres à 45000\n" +
      "Pose à 60000",

    coiffure:
      "Client : Awa\n" +
      "Tresses à 10000\n" +
      "Mèches à 15000\n" +
      "Main d’œuvre à 5000",

    couture:
      "Client : Awa\n" +
      "2 pagnes à 6000\n" +
      "Couture 3 tenues à 15000\n" +
      "Retouche à 3000",

    commerce:
      "Client : Awa\n" +
      "5 sacs de riz à 25000\n" +
      "2 cartons de savon à 18000\n" +
      "Livraison à 5000",

    restauration:
      "Client : Adama\n" +
      "10 plats de riz à 1500\n" +
      "10 boissons à 500\n" +
      "Livraison à 2000",

    generic:
      "Client : Moussa\n" +
      "2 portes à 25000\n" +
      "Main d’œuvre à 50000",
  };

  return examplesByContext[context] || examplesByContext.generic;
}

function buildOneLineExample(context = "generic", docType = null) {
  const docLabel = getDocLabel(docType);
  const client = getClientNameForContext(context);

  const examplesByContext = {
    btp: `${docLabel} pour ${client}, 1000 briques à 125, 20 sacs de ciment à 5000, main d’œuvre 150000`,
    electricite: `${docLabel} pour ${client}, 10 prises à 2500, 2 rouleaux de câble à 15000, main d’œuvre 50000`,
    mecanique: `${docLabel} pour ${client}, vidange 15000, filtre à huile 5000, main d’œuvre 10000`,
    menuiserie: `${docLabel} pour ${client}, 2 portes à 85000, 3 fenêtres à 45000, pose 60000`,
    coiffure: `${docLabel} pour ${client}, tresses 10000, mèches 15000, main d’œuvre 5000`,
    couture: `${docLabel} pour ${client}, 2 pagnes à 6000, couture 3 tenues à 15000`,
    commerce: `${docLabel} pour ${client}, 5 sacs de riz à 25000, livraison 5000`,
    restauration: `${docLabel} pour ${client}, 10 plats de riz à 1500, 10 boissons à 500, livraison 2000`,
    generic: `${docLabel} pour ${client}, 2 portes à 25000, main d’œuvre 50000`,
  };

  return examplesByContext[context] || examplesByContext.generic;
}

function buildSmartGuidanceMessage(rawText = "") {
  const vague = detectVagueRequest(rawText);
  const context = vague.context || detectBusinessContext(rawText);
  const docType = vague.docType || detectDocType(rawText);
  const docLabel = getDocLabel(docType);

  const structuredExample = buildStructuredExample(context);
  const oneLineExample = buildOneLineExample(context, docType);

  return (
    `Oui, je peux préparer le ${docLabel}.\n\n` +
    "Pour que KADI le fasse correctement, envoyez les informations comme ceci :\n\n" +
    `${structuredExample}\n\n` +
    "Ou en une seule phrase :\n" +
    `"${oneLineExample}"\n\n` +
    "💡 Vous pouvez aussi envoyer un vocal avec le client, les éléments et les prix."
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
    "allo kadi",
  ];

  if (exactGreetings.includes(t)) return true;

  if (
    /\b(devis|facture|recu|decharge|pour|client|prix|montant|payer|recharge)\b/i.test(
      t
    )
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