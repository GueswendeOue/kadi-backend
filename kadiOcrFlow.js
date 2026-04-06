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
    buildPreviewMessage,
    computeBasePdfCost,
    formatBaseCostLine,
    logger,

    // OCR low-level
    ocrImageToText,
    geminiIsEnabled,
    ocrLooksGood,
    geminiOcrImageBuffer,
    parseInvoiceTextWithGemini,

    // local parsing helpers
    parseNumberSmart,
    sanitizeOcrLabel,
    looksLikeRealItemLabel,
  } = deps;

  function guessDocTypeFromOcr(text) {
    const t = String(text || "").toLowerCase();

    if (t.includes("facture")) return "facture";
    if (t.includes("reçu") || t.includes("recu")) return "recu";
    if (t.includes("devis") || t.includes("proforma") || t.includes("pro forma")) return "devis";
    if (t.includes("décharge") || t.includes("decharge")) return "decharge";

    return null;
  }

  function extractTotalFromOcr(text) {
    const patterns = [
      /total\s*[:\-]?\s*([0-9\s.,]+)/i,
      /total\s*ttc\s*[:\-]?\s*([0-9\s.,]+)/i,
      /net\s*a\s*payer\s*[:\-]?\s*([0-9\s.,]+)/i,
      /montant\s+total\s*[:\-]?\s*([0-9\s.,]+)/i,
      /a\s+payer\s*[:\-]?\s*([0-9\s.,]+)/i,
      /grandTotal\s*[:\-]?\s*([0-9\s.,]+)/i,
      /TOTAL:\s*([0-9\s.,]+)/i,
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
    // Format attendu venant de kadiOcrEngine :
    // - Tom cim | qty:2 | pu:12500 | total:25000
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
    // Essaie de lire une ligne de type :
    // "ciment 1 sac 6000f 6000f"
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
      .replace(/\bboite\b|\bboute\b|\bbouteille\b|\bsac\b|\bl\b/gi, " ")
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

      if (!item) {
        item = parseLooseItemLine(line);
      }

      if (item) {
        items.push(item);
      }

      if (items.length >= LIMITS.maxItems) break;
    }

    const detected = extractTotalFromOcr(ocrText);
    const calc = computeFinance({ items }).gross;

    return {
      client,
      items,
      finance: {
        subtotal: calc,
        gross: detected ?? calc,
      },
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
        const baseText = await ocrImageToText(buffer);

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

    if (!s.lastDocDraft) {
      const guessed = guessDocTypeFromOcr(ocrText) || "devis";

      s.lastDocDraft = {
        type: guessed,
        factureKind: null,
        docNumber: null,
        date: formatDateISO(),
        client: null,
        items: [],
        finance: null,
        source: "ocr",
      };
    }

    if (!s.lastDocDraft.meta) {
      s.lastDocDraft.meta = makeDraftMeta();
    }

    s.step = "ocr_review";

    let parsed = null;

    // Si un parseur avancé existe encore, on peut l’essayer.
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
          finance: {
            subtotal: Number(gemParsed?.total || 0),
            gross: Number(gemParsed?.total || 0),
          },
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

        s.lastDocDraft.meta = makeDraftMeta({
          ...(s.lastDocDraft.meta || {}),
          usedGeminiParse: true,
        });

        logger?.info?.("ocr", "Advanced parsing ok", {
          from,
          client: parsed.client,
          itemsCount: parsed.items.length,
          total: parsed.finance?.gross || 0,
        });
      } catch (e) {
        logger?.warn?.("ocr", "Advanced parsing failed, fallback local parser", {
          from,
          message: e?.message,
        });

        s.lastDocDraft.meta = makeDraftMeta({
          ...(s.lastDocDraft.meta || {}),
          usedGeminiParse: false,
        });

        parsed = parseOcrToDraft(ocrText);
      }
    } else {
      s.lastDocDraft.meta = makeDraftMeta({
        ...(s.lastDocDraft.meta || {}),
        usedGeminiParse: false,
      });

      parsed = parseOcrToDraft(ocrText);
    }

    if (parsed.client) {
      s.lastDocDraft.client = parsed.client;
    }

    if (parsed.items?.length) {
      s.lastDocDraft.items = parsed.items.slice(0, LIMITS.maxItems);
    }

    s.lastDocDraft.finance = parsed.finance || computeFinance(s.lastDocDraft);

    logger?.info?.("ocr", "Draft ready for preview", {
      from,
      client: s.lastDocDraft.client,
      itemsCount: s.lastDocDraft.items.length,
      total: s.lastDocDraft.finance?.gross || 0,
    });

    const preview = buildPreviewMessage({ doc: s.lastDocDraft });
    await sendText(from, preview);

    const cost = computeBasePdfCost(s.lastDocDraft);
    await sendText(from, formatBaseCostLine(cost));

    return sendButtons(from, "✅ Valider ?", [
      { id: "DOC_CONFIRM", title: "📄 Générer PDF" },
      { id: "DOC_RESTART", title: "🔁 Recommencer" },
      { id: "BACK_HOME", title: "Menu" },
    ]);
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