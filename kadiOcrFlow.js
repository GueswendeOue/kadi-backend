"use strict";

function makeKadiOcrFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    getMediaInfo,
    downloadMediaToBuffer,
    LIMITS,
    formatDateISO,
    sleep,
    makeDraftMeta,
    makeItem,
    computeFinance,
    normalizeAndValidateDraft,
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    logger,
    safe,

    // preview unified
    sendPreviewMenu = null,

    // OCR low-level
    ocrImageToText,
    parseInvoiceTextWithGemini,

    // local parsing helpers
    parseNumberSmart,
    sanitizeOcrLabel,
    looksLikeRealItemLabel,
  } = deps;

  function guessDocMetaFromOcr(text) {
    const t = String(text || "").toLowerCase();

    if (t.includes("proforma") || t.includes("pro forma")) {
      return { type: "facture", factureKind: "proforma" };
    }

    if (t.includes("facture")) {
      return { type: "facture", factureKind: "definitive" };
    }

    if (t.includes("reçu") || t.includes("recu")) {
      return { type: "recu", factureKind: null };
    }

    if (t.includes("devis")) {
      return { type: "devis", factureKind: null };
    }

    if (t.includes("décharge") || t.includes("decharge")) {
      return { type: "decharge", factureKind: null };
    }

    return { type: "devis", factureKind: null };
  }

  function guessDocTypeFromOcr(text) {
    return guessDocMetaFromOcr(text).type;
  }

  function extractTotalFromOcr(text) {
    const patterns = [
      /total\s*ttc\s*[:\-]?\s*([0-9\s.,]+)/i,
      /net\s*a\s*payer\s*[:\-]?\s*([0-9\s.,]+)/i,
      /montant\s+total\s*[:\-]?\s*([0-9\s.,]+)/i,
      /a\s+payer\s*[:\-]?\s*([0-9\s.,]+)/i,
      /grand\s*total\s*[:\-]?\s*([0-9\s.,]+)/i,
      /total\s*[:\-]?\s*([0-9\s.,]+)/i,
    ];

    for (const p of patterns) {
      const m = String(text || "").match(p);
      if (m) {
        const n = parseNumberSmart(m[1]);
        if (n != null) return n;
      }
    }

    return null;
  }

  function isNoiseLine(line) {
    const t = String(line || "").toLowerCase().trim();
    if (!t) return true;

    return (
      t.startsWith("type:") ||
      t.startsWith("facture_kind:") ||
      t.startsWith("client:") ||
      t.startsWith("doc_number:") ||
      t.startsWith("items:") ||
      t.startsWith("material_total:") ||
      t.startsWith("labor_total:") ||
      t.startsWith("total:") ||
      t.includes("facture n") ||
      t.includes("facture no") ||
      t.includes("facture n°") ||
      t.includes("doc_number")
    );
  }

  function parseNormalizedItemLine(line) {
    const m = String(line || "").match(
      /^\-\s*(.+?)\s*\|\s*qty:(\d+)\s*(?:\|\s*pu:(\d+))?\s*(?:\|\s*total:(\d+))?\s*$/i
    );

    if (!m) return null;

    const label = sanitizeOcrLabel(m[1] || "");
    if (!looksLikeRealItemLabel(label)) return null;

    const qty = Number(m[2] || 1);
    let pu = m[3] ? Number(m[3]) : null;
    const total = m[4] ? Number(m[4]) : null;

    if ((!pu || pu <= 0) && qty > 0 && total > 0) {
      pu = Math.round(total / qty);
    }

    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (!Number.isFinite(pu) || pu <= 0) return null;

    return makeItem(label, qty, pu);
  }

  function parseLooseItemLine(line) {
    const raw = String(line || "").trim();
    if (!raw) return null;
    if (isNoiseLine(raw)) return null;
    if (!/\d/.test(raw)) return null;

    const nums = raw.match(/\d[\d\s.,]*/g) || [];
    const values = nums
      .map((x) => parseNumberSmart(x))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (!values.length) return null;

    let qty = 1;
    let pu = null;

    if (values.length >= 3) {
      qty = values[0];
      pu = values[1];
    } else if (values.length === 2) {
      qty = values[0] <= 20 ? values[0] : 1;
      pu = values[1];
    } else if (values.length === 1) {
      pu = values[0];
    }

    let label = raw
      .replace(/\d[\d\s.,]*/g, " ")
      .replace(/\bfcfa\b|\bf\b/gi, " ")
      .replace(
        /\bboite\b|\bboute\b|\bbouteille\b|\bsac\b|\bl\b|\bkg\b/gi,
        " "
      )
      .replace(/\s+/g, " ")
      .trim();

    label = sanitizeOcrLabel(label);

    if (!looksLikeRealItemLabel(label)) return null;
    if (!Number.isFinite(pu) || pu <= 0) return null;
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;

    return makeItem(label, qty, pu);
  }

  function parseOcrToDraft(ocrText) {
    const lines = String(ocrText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let client = null;

    for (const line of lines) {
      const m =
        line.match(/^client\s*[:\-]\s*(.+)$/i) ||
        line.match(/^nom\s*[:\-]\s*(.+)$/i);

      if (m) {
        client = (m[1] || "").trim().slice(0, LIMITS.maxClientNameLength);
        break;
      }
    }

    const items = [];

    for (const line of lines) {
      if (isNoiseLine(line)) continue;

      let item = parseNormalizedItemLine(line);
      if (!item) item = parseLooseItemLine(line);

      if (item) items.push(item);
      if (items.length >= LIMITS.maxItems) break;
    }

    const detectedTotal = extractTotalFromOcr(ocrText);

    return {
      client,
      items,
      detectedTotal,
    };
  }

  function makeFreshOcrBaseDraft({ existingDraft, guessedMeta }) {
    const current =
      existingDraft &&
      typeof existingDraft === "object" &&
      existingDraft.source === "ocr"
        ? existingDraft
        : null;

    const type = current?.type || guessedMeta?.type || "devis";
    const factureKind =
      type === "facture"
        ? current?.factureKind || guessedMeta?.factureKind || "definitive"
        : null;

    return {
      type,
      factureKind,
      docNumber: null,
      date: formatDateISO(),
      client: null,
      clientPhone: null,
      subject: null,
      motif: null,
      items: [],
      finance: null,
      source: "ocr",
      meta: makeDraftMeta({
        ...(current?.meta || {}),
      }),
    };
  }

  function buildDraftFromParsed(baseDraft, parsed) {
    const draft = {
      ...baseDraft,
      client: parsed?.client || baseDraft?.client || null,
      items: Array.isArray(parsed?.items)
        ? parsed.items.slice(0, LIMITS.maxItems)
        : [],
    };

    draft.finance = computeFinance(draft);
    return draft;
  }

  function runDraftValidation(draft) {
    if (typeof normalizeAndValidateDraft !== "function") {
      return {
        ok: true,
        draft: {
          ...draft,
          items: Array.isArray(draft?.items)
            ? draft.items.map((it) => ({ ...it }))
            : [],
        },
        issues: [],
      };
    }

    return normalizeAndValidateDraft({
      ...draft,
      items: Array.isArray(draft?.items)
        ? draft.items.map((it) => ({ ...it }))
        : [],
    });
  }

  function needsManualReview(draft, parsed = {}) {
    const checked = runDraftValidation(draft);
    const issues = Array.isArray(checked?.issues) ? checked.issues : [];
    const detectedTotal = Number(parsed?.detectedTotal || 0);
    const computedTotal = Number(
      checked?.draft?.finance?.gross ?? checked?.draft?.finance?.total ?? 0
    );

    if (!checked.ok) {
      return {
        needsReview: true,
        reason: `validation_failed:${issues.join(",")}`,
        checked,
      };
    }

    if (detectedTotal > 0 && computedTotal > 0) {
      const gap = Math.abs(detectedTotal - computedTotal);
      const ratio = computedTotal > 0 ? gap / computedTotal : 0;

      if (gap > 500 && ratio >= 0.12) {
        return {
          needsReview: true,
          reason: "ocr_total_gap_high",
          checked,
        };
      }
    }

    if (
      Array.isArray(checked?.draft?.items) &&
      checked.draft.items.length > 0 &&
      computedTotal <= 0
    ) {
      return {
        needsReview: true,
        reason: "computed_total_zero",
        checked,
      };
    }

    return {
      needsReview: false,
      reason: null,
      checked,
    };
  }

  async function robustOcr(
    buffer,
    mimeType = "image/jpeg",
    maxRetries = LIMITS.maxOcrRetries
  ) {
    let lastErr = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const baseText = await ocrImageToText(buffer, { mimeType });

        logger?.info?.("ocr", "Base OCR result", {
          attempt,
          length: String(baseText || "").trim().length,
          preview: String(baseText || "").slice(0, 300),
        });

        if (baseText && String(baseText).trim().length >= 3) {
          return baseText;
        }

        throw new Error("OCR_EMPTY");
      } catch (e) {
        lastErr = e;

        logger?.warn?.("ocr", "Base OCR failed", {
          attempt,
          message: e?.message,
        });

        if (attempt === maxRetries) break;
        await sleep(Math.pow(2, attempt) * 800);
      }
    }

    throw lastErr || new Error("OCR_FAILED");
  }

  async function sendUnifiedPreview(from, draft) {
    const preview = buildPreviewMessage({ doc: draft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(draft);
    await sendText(from, formatBaseCostLine(cost));

    if (typeof sendPreviewMenu === "function") {
      return sendPreviewMenu(from, draft);
    }

    return sendButtons(from, "✅ Valider ?", [
      { id: "DOC_CONFIRM", title: "📄 Générer PDF" },
      { id: "DOC_RESTART", title: "🔁 Recommencer" },
      { id: "BACK_HOME", title: "Menu" },
    ]);
  }

  async function processOcrImageToDraft(from, mediaId) {
    const s = getSession(from);

    const info = await getMediaInfo(mediaId);
    if (info?.file_size && info.file_size > LIMITS.maxImageSize) {
      await sendText(from, "❌ Image trop grande. Envoyez une photo plus légère.");
      return;
    }

    const mime = info?.mime_type || "image/jpeg";
    const buf = await downloadMediaToBuffer(info.url);

    await sendText(from, "🔎 Lecture intelligente de la photo…");

    let ocrText = "";

    try {
      ocrText = await robustOcr(buf, mime);

      logger?.info?.("ocr", "OCR text extracted", {
        from,
        length: String(ocrText || "").trim().length,
        preview: String(ocrText || "").slice(0, 500),
      });
    } catch (e) {
      logger?.error?.("ocr", e, { from, step: "robustOcr" });
      await sendText(
        from,
        "❌ Impossible de lire la photo. Essayez une photo plus nette (bonne lumière, sans flou)."
      );
      return;
    }

    if (!ocrText || ocrText.trim().length < 3) {
      await sendText(
        from,
        "❌ Lecture trop faible. Essayez une photo plus nette (bonne lumière, sans flou)."
      );
      return;
    }

    const guessedMeta = guessDocMetaFromOcr(ocrText);
    s.lastDocDraft = makeFreshOcrBaseDraft({
      existingDraft: s.lastDocDraft,
      guessedMeta,
    });

    let parsed = null;
    let usedGeminiParse = false;

    if (typeof parseInvoiceTextWithGemini === "function") {
      try {
        const gemParsed = await parseInvoiceTextWithGemini(ocrText);

        parsed = {
          client: gemParsed?.client || null,
          items: Array.isArray(gemParsed?.items)
            ? gemParsed.items.map((it) =>
                makeItem(
                  it?.label || "Produit",
                  Number(it?.qty || 1),
                  Number(it?.unitPrice ?? it?.amount ?? 0)
                )
              )
            : [],
          detectedTotal: Number(gemParsed?.total || 0) || null,
        };

        if (!parsed.items.length) {
          throw new Error("Advanced parser returned no items");
        }

        const noisyItems = parsed.items.filter(
          (it) => !looksLikeRealItemLabel(it?.label || "")
        );

        if (noisyItems.length > 0) {
          throw new Error("Advanced parser returned noisy items");
        }

        usedGeminiParse = true;

        logger?.info?.("ocr", "Advanced parsing ok", {
          from,
          client: parsed.client,
          itemsCount: parsed.items.length,
          total: parsed.detectedTotal || 0,
        });
      } catch (e) {
        logger?.warn?.("ocr", "Advanced parsing failed, fallback local parser", {
          from,
          message: e?.message,
        });

        usedGeminiParse = false;
        parsed = parseOcrToDraft(ocrText);
      }
    } else {
      usedGeminiParse = false;
      parsed = parseOcrToDraft(ocrText);
    }

    s.lastDocDraft.meta = makeDraftMeta({
      ...(s.lastDocDraft.meta || {}),
      usedGeminiParse,
      ocrDetectedTotal: Number(parsed?.detectedTotal || 0) || null,
      ocrDocTypeGuess: guessedMeta?.type || null,
      ocrFactureKindGuess: guessedMeta?.factureKind || null,
    });

    const candidateDraft = buildDraftFromParsed(s.lastDocDraft, parsed);
    const review = needsManualReview(candidateDraft, parsed);

    if (review?.checked?.draft) {
      s.lastDocDraft = review.checked.draft;
    } else {
      s.lastDocDraft = candidateDraft;
    }

    logger?.info?.("ocr", "Draft ready after normalization", {
      from,
      client: s.lastDocDraft.client,
      itemsCount: s.lastDocDraft.items.length,
      total: s.lastDocDraft.finance?.gross || 0,
      needsReview: review.needsReview,
      reason: review.reason,
    });

    if (
      !Array.isArray(s.lastDocDraft.items) ||
      s.lastDocDraft.items.length === 0
    ) {
      await sendText(
        from,
        "⚠️ J’ai lu la photo, mais je n’ai pas extrait de lignes fiables.\n\nEnvoyez une image plus nette ou saisissez le document en texte."
      );
      return;
    }

    if (!safe(s.lastDocDraft.client)) {
      s.step = "missing_client_pdf";
      await sendText(
        from,
        `✅ ${s.lastDocDraft.items.length} ligne(s) détectée(s).\n👤 Maintenant, tapez le nom du client :`
      );
      return;
    }

    s.step = "doc_review";

    if (review.needsReview) {
      await sendText(
        from,
        "⚠️ J’ai lu la photo, mais je préfère une vérification avant génération.\n\nVous pouvez corriger, ajouter une ligne ou générer si tout vous semble bon."
      );
    }

    return sendUnifiedPreview(from, s.lastDocDraft);
  }

  return {
    guessDocTypeFromOcr,
    extractTotalFromOcr,
    parseOcrToDraft,
    robustOcr,
    processOcrImageToDraft,
  };
}

module.exports = {
  makeKadiOcrFlow,
};