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
      if (!/\d/.test(line)) continue;
      if (/date/i.test(line)) continue;
      if (/total/i.test(line)) continue;
      if (/montant/i.test(line)) continue;
      if (/client/i.test(line)) continue;
      if (/nom/i.test(line)) continue;

      const label = sanitizeOcrLabel(line);
      if (!looksLikeRealItemLabel(label)) continue;

      const nums = line.match(/\d+(?:[.,]\d+)?/g) || [];
      if (!nums.length) continue;

      const candidates = nums
        .map((x) => parseNumberSmart(x))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (!candidates.length) continue;

      const pu = candidates[candidates.length - 1] || 0;
      if (!Number.isFinite(pu) || pu <= 0) continue;

      items.push(makeItem(label, 1, pu));
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
        let baseText = "";

        try {
          baseText = await ocrImageToText(buffer);

          logger?.info?.("ocr", "Base OCR result", {
            attempt,
            length: String(baseText || "").trim().length,
            preview: String(baseText || "").slice(0, 200),
          });
        } catch (e) {
          lastErr = e;
          baseText = "";

          logger?.warn?.("ocr", "Base OCR failed", {
            attempt,
            message: e?.message,
          });
        }

        if (baseText && String(baseText).trim().length >= 3) {
          if (geminiIsEnabled() && !ocrLooksGood(baseText)) {
            try {
              const gText = await geminiOcrImageBuffer(buffer, mimeType);

              if (gText && String(gText).trim().length >= 3) {
                logger?.info?.("ocr", "Gemini OCR improved result", {
                  attempt,
                  length: String(gText || "").trim().length,
                  preview: String(gText || "").slice(0, 200),
                });

                return gText;
              }
            } catch (ge) {
              logger?.warn?.("ocr", "Gemini OCR fallback failed", {
                attempt,
                message: ge?.message,
              });
            }
          }

          return baseText;
        }

        if (geminiIsEnabled()) {
          try {
            const gText = await geminiOcrImageBuffer(buffer, mimeType);

            if (gText && String(gText).trim().length >= 3) {
              logger?.info?.("ocr", "Gemini OCR accepted", {
                attempt,
                length: String(gText || "").trim().length,
                preview: String(gText || "").slice(0, 200),
              });

              return gText;
            }
          } catch (ge) {
            logger?.warn?.("ocr", "Gemini OCR direct failed", {
              attempt,
              message: ge?.message,
            });
          }
        }

        throw lastErr || new Error("OCR_EMPTY");
      } catch (e) {
        lastErr = e;

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
        preview: String(ocrText || "").slice(0, 300),
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
        throw new Error("Gemini returned no items");
      }

      const noisyItems = parsed.items.filter(
        (it) => !looksLikeRealItemLabel(it?.label || "")
      );

      if (noisyItems.length > 0) {
        throw new Error("Gemini returned noisy items");
      }

      if (parsed.items.length > 10) {
        throw new Error("Gemini returned too many items");
      }

      s.lastDocDraft.meta = makeDraftMeta({
        ...(s.lastDocDraft.meta || {}),
        usedGeminiParse: true,
      });

      logger?.info?.("ocr", "Gemini parsing ok", {
        from,
        client: parsed.client,
        itemsCount: parsed.items.length,
        total: parsed.finance?.gross || 0,
      });
    } catch (e) {
      logger?.warn?.("ocr", "Gemini parsing failed, fallback local parser", {
        from,
        message: e?.message,
      });

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