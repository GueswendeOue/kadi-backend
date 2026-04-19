"use strict";

const {
  detectVagueRequest,
  buildSmartGuidanceMessage,
} = require("./kadiNaturalGuidance");

function makeKadiProductFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    LIMITS,
    formatDateISO,
    makeDraftMeta,
    computeFinance,
    makeItem,
    parseNumberSmart,
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    sendPreviewMenu,
    sendAfterProductMenu,
    sendReceiptFormatMenu,
    detectDechargeType,
    buildDechargePreviewMessage,
    initDechargeDraft,
    money,
    safe,
    normalizeAndValidateDraft,
  } = deps;

  function clonePlainDraft(draft) {
    if (!draft || typeof draft !== "object") return null;

    return {
      ...draft,
      items: Array.isArray(draft.items)
        ? draft.items.map((it) => ({ ...it }))
        : [],
      finance: draft.finance ? { ...draft.finance } : null,
      meta: draft.meta ? { ...draft.meta } : null,
      confirmation: draft.confirmation ? { ...draft.confirmation } : null,
    };
  }

  function validateDraftForUi(draft) {
    if (typeof normalizeAndValidateDraft !== "function") {
      return {
        ok: true,
        draft: clonePlainDraft(draft),
        issues: [],
      };
    }

    return normalizeAndValidateDraft(clonePlainDraft(draft));
  }

  function resetItemCaptureState(session) {
    if (!session) return;
    session.itemDraft = null;
  }

  function sanitizeClientName(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxClientNameLength);
  }

  function sanitizeItemLabel(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxItemLabelLength);
  }

  function sanitizeSubject(value = "") {
    return String(value || "").trim().slice(0, LIMITS.maxItemLabelLength);
  }

  function sanitizePhone(value = "") {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
  }

  function isSkipValue(value = "") {
    const t = String(value || "").trim().toLowerCase();
    return t === "0";
  }

  function isCancelValue(value = "") {
    const t = String(value || "").trim().toLowerCase();
    return (
      t === "annuler" ||
      t === "cancel" ||
      t === "retour" ||
      t === "stop" ||
      t === "abandonner"
    );
  }

  function getEditableDraftDocTypeLine(draft = null) {
    const type = String(draft?.type || "").toLowerCase();
    const kind = String(draft?.factureKind || "").toLowerCase();

    if (type === "facture") {
      return kind === "proforma" ? "FACTURE_PROFORMA" : "FACTURE_DEFINITIVE";
    }
    if (type === "devis") return "DEVIS";
    if (type === "recu") return "RECU";
    if (type === "decharge") return "DECHARGE";
    return "DOCUMENT";
  }

  function buildEditableDraftText(draft = null) {
    const lines = [];
    const items = Array.isArray(draft?.items) ? draft.items : [];

    lines.push(`TYPE: ${getEditableDraftDocTypeLine(draft)}`);
    lines.push(`DATE: ${String(draft?.date || "").trim() || formatDateISO()}`);
    lines.push(`CLIENT: ${String(draft?.client || "").trim()}`);
    lines.push(`CLIENT_PHONE: ${String(draft?.clientPhone || "").trim()}`);
    lines.push(`OBJET: ${String(draft?.subject || "").trim()}`);

    if (String(draft?.motif || "").trim()) {
      lines.push(`MOTIF: ${String(draft.motif).trim()}`);
    }

    items.forEach((item, index) => {
      const label = String(item?.label || "").trim();
      const qty = Number(item?.qty || 0);
      const unitPrice = Number(item?.unitPrice || 0);

      lines.push(
        `LIGNE ${index + 1}: ${label} | ${qty} | ${Math.round(unitPrice)}`
      );
    });

    if (items.length === 0) {
      lines.push("LIGNE 1:  | 1 | 0");
    }

    return lines.join("\n");
  }

  function normalizeStructuredDocType(value = "", fallbackDraft = null) {
    const raw = String(value || "").trim().toUpperCase();

    if (raw.includes("FACTURE") && raw.includes("PROFORMA")) {
      return { type: "facture", factureKind: "proforma" };
    }

    if (raw.includes("FACTURE")) {
      return { type: "facture", factureKind: "definitive" };
    }

    if (raw.includes("DEVIS")) {
      return { type: "devis", factureKind: null };
    }

    if (raw.includes("RECU") || raw.includes("REÇU")) {
      return { type: "recu", factureKind: null };
    }

    if (raw.includes("DECHARGE") || raw.includes("DÉCHARGE")) {
      return { type: "decharge", factureKind: null };
    }

    return {
      type: fallbackDraft?.type || "devis",
      factureKind:
        fallbackDraft?.type === "facture"
          ? fallbackDraft?.factureKind || "definitive"
          : null,
    };
  }

  function formatStructuredEditIssues(issues = []) {
    const uniq = [...new Set(issues)];

    const labels = uniq.map((issue) => {
      switch (issue) {
        case "type_invalid":
          return "TYPE invalide";
        case "client_required":
          return "CLIENT requis";
        case "line_required":
          return "au moins une LIGNE valide est requise";
        case "line_format_invalid":
          return "format des LIGNES invalide";
        case "line_label_required":
          return "désignation manquante";
        case "line_qty_invalid":
          return "quantité invalide";
        case "line_unit_price_invalid":
          return "prix unitaire invalide";
        default:
          return issue;
      }
    });

    return labels.join(", ");
  }

  function parseStructuredEditText(rawText, baseDraft) {
    const sourceDraft = clonePlainDraft(baseDraft) || {
      type: "devis",
      factureKind: null,
      date: formatDateISO(),
      client: null,
      clientPhone: null,
      subject: null,
      motif: null,
      items: [],
      finance: null,
      meta: makeDraftMeta(),
    };

    const draft = {
      ...sourceDraft,
      items: Array.isArray(sourceDraft.items)
        ? sourceDraft.items.map((it) => ({ ...it }))
        : [],
      finance: sourceDraft.finance ? { ...sourceDraft.finance } : null,
      meta: sourceDraft.meta ? { ...sourceDraft.meta } : makeDraftMeta(),
      savedDocumentId: null,
      savedPdfMediaId: null,
      savedPdfFilename: null,
      savedPdfCaption: null,
      requestId: null,
      status: "draft",
    };

    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean);

    const issues = [];
    const parsedItems = [];
    let lineSeen = false;

    for (const line of lines) {
      const typeMatch = line.match(/^TYPE\s*:\s*(.+)$/i);
      if (typeMatch) {
        const normalized = normalizeStructuredDocType(typeMatch[1], draft);
        draft.type = normalized.type;
        draft.factureKind = normalized.factureKind;
        continue;
      }

      const dateMatch = line.match(/^DATE\s*:\s*(.*)$/i);
      if (dateMatch) {
        const value = String(dateMatch[1] || "").trim();
        draft.date = value || draft.date || formatDateISO();
        continue;
      }

      const clientMatch = line.match(/^CLIENT\s*:\s*(.*)$/i);
      if (clientMatch) {
        const value = sanitizeClientName(clientMatch[1] || "");
        draft.client = value || null;
        continue;
      }

      const phoneMatch = line.match(/^CLIENT_PHONE\s*:\s*(.*)$/i);
      if (phoneMatch) {
        const value = sanitizePhone(phoneMatch[1] || "");
        draft.clientPhone = value || null;
        continue;
      }

      const subjectMatch = line.match(/^OBJET\s*:\s*(.*)$/i);
      if (subjectMatch) {
        const value = sanitizeSubject(subjectMatch[1] || "");
        draft.subject = value || null;
        continue;
      }

      const motifMatch = line.match(/^MOTIF\s*:\s*(.*)$/i);
      if (motifMatch) {
        const value = sanitizeItemLabel(motifMatch[1] || "");
        draft.motif = value || null;
        continue;
      }

      const itemMatch = line.match(/^LIGNE\s+\d+\s*:\s*(.+)$/i);
      if (itemMatch) {
        lineSeen = true;

        const payload = String(itemMatch[1] || "").trim();
        const parts = payload.split("|").map((part) => String(part || "").trim());

        if (parts.length !== 3) {
          issues.push("line_format_invalid");
          continue;
        }

        const label = sanitizeItemLabel(parts[0] || "");
        const qty = parseNumberSmart(parts[1] || "");
        const unitPrice = parseNumberSmart(parts[2] || "");

        if (!label) issues.push("line_label_required");
        if (qty == null || qty <= 0) issues.push("line_qty_invalid");
        if (unitPrice == null || unitPrice < 0)
          issues.push("line_unit_price_invalid");

        if (label && qty != null && qty > 0 && unitPrice != null && unitPrice >= 0) {
          parsedItems.push(makeItem(label, Number(qty), Number(unitPrice)));
        }

        continue;
      }
    }

    if (draft.type === "facture" && !draft.factureKind) {
      draft.factureKind = "definitive";
    }

    if (!safe(draft.client)) {
      issues.push("client_required");
    }

    if (!lineSeen || parsedItems.length === 0) {
      issues.push("line_required");
    }

    draft.items = parsedItems;
    draft.finance = computeFinance(draft);

    if (draft.type === "decharge") {
      const motif = sanitizeItemLabel(draft.motif || draft.subject || "");
      draft.motif = motif || draft.motif || null;
      draft.dechargeType = detectDechargeType(draft.motif || "");
    }

    return {
      ok: issues.length === 0,
      draft,
      issues: [...new Set(issues)],
    };
  }

  async function sendBlockedDraft(from, issues = []) {
    await sendText(
      from,
      "⚠️ Je préfère bloquer ce document pour éviter une erreur de calcul.\n\n" +
        (issues.length ? `Détail: ${issues.join(", ")}` : "")
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "DOC_ADD_MORE", title: "➕ Ajouter ligne" },
      { id: "DOC_RESTART", title: "🔁 Recommencer" },
      { id: "DOC_CANCEL", title: "🏠 Menu" },
    ]);
  }

  async function sendSafePreview(from, draft) {
    const checked = validateDraftForUi(draft);

    if (!checked.ok) {
      const s = getSession(from);
      s.lastDocDraft = checked.draft;
      await sendBlockedDraft(from, checked.issues);
      return true;
    }

    const s = getSession(from);
    s.lastDocDraft = checked.draft;

    const finalDraft = s.lastDocDraft;

    const preview =
      finalDraft.type === "decharge"
        ? buildDechargePreviewMessage({ doc: finalDraft, money })
        : buildPreviewMessage({ doc: finalDraft });

    await sendText(from, preview);

    const cost = computeBasePdfCost(finalDraft);
    await sendText(from, formatBaseCostLine(cost));

    await sendPreviewMenu(from, finalDraft);
    return true;
  }

  async function continueAfterSubjectInput(from, s) {
    const target = s.subjectReturnTarget || "ask_item";
    s.subjectReturnTarget = null;

    if (target === "after_product_menu") {
      s.step = "doc_after_item_choice";
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    s.clientPhoneReturnTarget = target;
    s.step = "client_phone_input";
    await sendText(
      from,
      "📱 Numéro du client ?\nExemple : 70000000\n\nTapez 0 pour ignorer."
    );
    return true;
  }

  async function continueAfterClientPhoneInput(from, s) {
    const target = s.clientPhoneReturnTarget || "ask_item";
    s.clientPhoneReturnTarget = null;

    if (target === "after_product_menu") {
      s.step = "doc_after_item_choice";
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    if (target === "finish_preview") {
      s.step = "doc_review";
      return sendSafePreview(from, s.lastDocDraft);
    }

    await askItemLabel(from);
    return true;
  }

  async function startDocFlow(from, mode, factureKind = null) {
    const s = getSession(from);
    const type = String(mode || "").toLowerCase();

    resetItemCaptureState(s);
    s.subjectReturnTarget = null;
    s.clientPhoneReturnTarget = null;

    if (type === "decharge") {
      s.lastDocDraft = initDechargeDraft({
        dateISO: formatDateISO(),
        makeDraftMeta,
      });

      s.step = "decharge_client";
      await sendText(from, "📄 Décharge\n\n👤 Nom de la personne ?");
      return true;
    }

    s.lastDocDraft = {
      type,
      factureKind,
      date: formatDateISO(),
      client: null,
      clientPhone: null,
      subject: null,
      items: [],
      finance: null,
      meta: makeDraftMeta(),
    };

    if (type === "recu") {
      s.step = "receipt_format";
      await sendReceiptFormatMenu(from);
      return true;
    }

    s.step = "doc_client";
    await sendText(from, "👤 Nom du client ?");
    return true;
  }

  async function askItemLabel(from) {
    const s = getSession(from);

    if (!s?.lastDocDraft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de document en cours.\nTapez MENU pour commencer."
      );
      return true;
    }

    resetItemCaptureState(s);
    s.step = "item_label";

    await sendText(
      from,
      `🧾 Produit ${(s.lastDocDraft.items.length || 0) + 1}\nNom ?`
    );

    return true;
  }

  async function handleStructuredEditText(from, rawText) {
    const s = getSession(from);
    const currentDraft = s?.lastDocDraft;

    if (!currentDraft) {
      await sendText(
        from,
        "📄 Je n’ai pas retrouvé le document à corriger.\nTapez MENU pour recommencer."
      );
      return true;
    }

    const parsed = parseStructuredEditText(rawText, currentDraft);

    if (!parsed.ok) {
      await sendText(
        from,
        "⚠️ Je n’ai pas pu appliquer votre correction.\n\n" +
          `Détail : ${formatStructuredEditIssues(parsed.issues)}`
      );

      await sendText(
        from,
        "Merci de corriger le bloc puis de le renvoyer exactement dans ce format :"
      );

      await sendText(from, buildEditableDraftText(currentDraft));
      s.step = "doc_edit_text_waiting";
      return true;
    }

    const checked = validateDraftForUi(parsed.draft);
    s.lastDocDraft = checked.draft;

    if (!checked.ok) {
      await sendText(
        from,
        "⚠️ La correction a été lue, mais le document reste incohérent.\n\n" +
          `Détail : ${formatStructuredEditIssues(checked.issues || [])}`
      );

      await sendText(from, buildEditableDraftText(s.lastDocDraft));
      s.step = "doc_edit_text_waiting";
      return true;
    }

    resetItemCaptureState(s);
    s.subjectReturnTarget = null;
    s.clientPhoneReturnTarget = null;
    s.step = "doc_review";

    await sendText(from, "✅ Correction appliquée.");
    return sendSafePreview(from, s.lastDocDraft);
  }

  async function handleProductFlowText(from, text) {
    const s = getSession(from);
    if (!s?.lastDocDraft) return false;

    const t = String(text || "").trim();
    if (!t) return false;

    // ===== STRUCTURED TEXT EDIT =====
    if (s.step === "doc_edit_text_waiting") {
      return handleStructuredEditText(from, text);
    }

    // ===== CLIENT =====
    if (s.step === "doc_client") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom client invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
      await askItemLabel(from);
      return true;
    }

    // ===== SUBJECT INPUT =====
    if (s.step === "doc_subject_input") {
      resetItemCaptureState(s);

      if (isSkipValue(t)) {
        s.lastDocDraft.subject = null;
      } else if (isCancelValue(t)) {
        return continueAfterSubjectInput(from, s);
      } else {
        const subject = sanitizeSubject(t);

        if (!subject) {
          await sendText(
            from,
            "❌ Objet invalide.\nExemple : Réparation voiture"
          );
          return true;
        }

        s.lastDocDraft.subject = subject;
      }

      return continueAfterSubjectInput(from, s);
    }

    // ===== CLIENT PHONE INPUT =====
    if (s.step === "client_phone_input") {
      resetItemCaptureState(s);

      if (isCancelValue(t)) {
        return continueAfterClientPhoneInput(from, s);
      }

      if (isSkipValue(t)) {
        s.lastDocDraft.clientPhone = null;
        return continueAfterClientPhoneInput(from, s);
      }

      const phone = sanitizePhone(t);

      if (!phone || phone.length < 8) {
        await sendText(from, "❌ Numéro invalide.\nExemple : 70000000");
        return true;
      }

      s.lastDocDraft.clientPhone = phone;
      return continueAfterClientPhoneInput(from, s);
    }

    // ===== ITEM LABEL =====
    if (s.step === "item_label") {
      if (isCancelValue(t) || isSkipValue(t)) {
        resetItemCaptureState(s);

        if (
          Array.isArray(s.lastDocDraft.items) &&
          s.lastDocDraft.items.length > 0
        ) {
          s.step = "doc_after_item_choice";
          await sendAfterProductMenu(from, s.lastDocDraft);
          return true;
        }

        await sendText(
          from,
          "⚠️ Entrez un nom de ligne.\nExemple : Loyer du mois de mai"
        );
        return true;
      }

      const label = sanitizeItemLabel(t);

      if (!label) {
        await sendText(from, "❌ Nom du produit invalide.");
        return true;
      }

      s.itemDraft = { label, qty: 1 };
      s.step = "item_qty";

      await sendText(from, `🔢 Quantité pour *${label}* ?\nExemple : 1`);
      return true;
    }

    // ===== ITEM QTY =====
    if (s.step === "item_qty") {
      if (isCancelValue(t) || isSkipValue(t)) {
        resetItemCaptureState(s);

        if (
          Array.isArray(s.lastDocDraft.items) &&
          s.lastDocDraft.items.length > 0
        ) {
          s.step = "doc_after_item_choice";
          await sendAfterProductMenu(from, s.lastDocDraft);
          return true;
        }

        await askItemLabel(from);
        return true;
      }

      const qty = parseNumberSmart(t);

      if (qty == null || qty <= 0) {
        await sendText(from, "❌ Quantité invalide.\nExemple : 1");
        return true;
      }

      s.itemDraft = {
        ...(s.itemDraft || {}),
        label: sanitizeItemLabel(s.itemDraft?.label || "Produit"),
        qty,
      };

      s.step = "item_price";
      await sendText(
        from,
        `💰 Prix unitaire pour *${s.itemDraft.label}* ?`
      );
      return true;
    }

    // ===== ITEM PRICE =====
    if (s.step === "item_price") {
      if (isCancelValue(t) || isSkipValue(t)) {
        resetItemCaptureState(s);

        if (
          Array.isArray(s.lastDocDraft.items) &&
          s.lastDocDraft.items.length > 0
        ) {
          s.step = "doc_after_item_choice";
          await sendAfterProductMenu(from, s.lastDocDraft);
          return true;
        }

        await askItemLabel(from);
        return true;
      }

      const n = parseNumberSmart(t);

      if (n == null || n <= 0) {
        const vagueCheck = detectVagueRequest(t);

        if (vagueCheck.isVague) {
          await sendText(
            from,
            "⚠️ On était en train d’ajouter un prix.\n\n" +
              buildSmartGuidanceMessage(t)
          );
          return true;
        }

        if (t.length > 12) {
          await sendButtons(
            from,
            "⚠️ J’attends un prix ici.\n\nQue voulez-vous faire ?",
            [
              { id: "DOC_ADD_MORE", title: "➕ Ajouter ligne" },
              { id: "DOC_RESTART", title: "🔁 Recommencer" },
              { id: "DOC_CANCEL", title: "🏠 Menu" },
            ]
          );
          return true;
        }

        await sendText(from, "❌ Prix invalide.\nExemple : 5000");
        return true;
      }

      const label = sanitizeItemLabel(s.itemDraft?.label || "Produit");
      const qty = Number(s.itemDraft?.qty || 1);
      const item = makeItem(label, qty, n);

      s.lastDocDraft.items.push(item);

      const checked = validateDraftForUi(s.lastDocDraft);

      if (!checked.ok) {
        s.lastDocDraft = checked.draft;
        resetItemCaptureState(s);
        await sendBlockedDraft(from, checked.issues);
        return true;
      }

      s.lastDocDraft = checked.draft;
      resetItemCaptureState(s);
      s.step = "doc_after_item_choice";

      await sendText(
        from,
        `✅ Produit ajouté\nQté: ${qty} • PU: ${Math.round(n).toLocaleString("fr-FR")} F`
      );
      await sendAfterProductMenu(from, s.lastDocDraft);
      return true;
    }

    // ===== DECHARGE =====
    if (s.step === "decharge_client") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
      s.step = "decharge_motif";
      await sendText(from, "📝 Motif ?");
      return true;
    }

    if (s.step === "decharge_motif") {
      const motif = sanitizeItemLabel(t);

      if (!motif) {
        await sendText(from, "❌ Motif invalide.");
        return true;
      }

      s.lastDocDraft.motif = motif;
      s.lastDocDraft.dechargeType = detectDechargeType(t);

      s.step = "decharge_amount";
      await sendText(from, "💰 Montant ?");
      return true;
    }

    if (s.step === "decharge_amount") {
      const n = parseNumberSmart(t);

      if (n == null || n < 0) {
        await sendText(from, "❌ Montant invalide");
        return true;
      }

      s.lastDocDraft.items = [
        makeItem(s.lastDocDraft.motif || "Décharge", 1, n),
      ];

      s.lastDocDraft.finance = computeFinance(s.lastDocDraft);
      s.step = "doc_review";

      return sendSafePreview(from, s.lastDocDraft);
    }

    // ===== CLIENT MANQUANT =====
    if (s.step === "missing_client_pdf") {
      const client = sanitizeClientName(t);

      if (!client) {
        await sendText(from, "❌ Nom client invalide.");
        return true;
      }

      s.lastDocDraft.client = client;
      s.step = "doc_review";

      return sendSafePreview(from, s.lastDocDraft);
    }

    return false;
  }

  return {
    startDocFlow,
    askItemLabel,
    handleProductFlowText,
  };
}

module.exports = {
  makeKadiProductFlow,
};