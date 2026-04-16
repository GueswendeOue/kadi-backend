"use strict";

function makeKadiCertifiedFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    sendDocument,

    getOrCreateProfile,

    createCertifiedInvoiceFromDraft,
    listRecentCertifiedInvoices = null,
    rebuildCertifiedInvoicePdf = null,

    money,
  } = deps;

  function safeText(v, def = "") {
    const s = String(v ?? "").trim();
    return s || def;
  }

  function toNum(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function formatMoney(v) {
    try {
      if (typeof money === "function") return `${money(v)} F`;
    } catch (_) {}
    return `${Math.round(toNum(v, 0)).toLocaleString("fr-FR")} F`;
  }

  function formatVatPercent(v) {
    const pct = toNum(v, 0) * 100;
    return Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(2)));
  }

  function normalizePhone(v = "") {
    const digits = String(v || "").replace(/\D/g, "");
    return digits || null;
  }

  function isCertifiedStep(step = "") {
    return String(step || "").startsWith("certified_invoice_");
  }

  function resetCertifiedDraftSession(session) {
    if (!session) return;
    session.certifiedInvoiceDraft = null;
    session.certifiedInvoicePendingItem = null;
    session.certifiedInvoiceLastList = null;
    session.isGeneratingCertifiedInvoice = false;
    if (isCertifiedStep(session.step)) session.step = null;
  }

  function buildEmptyCertifiedDraft() {
    return {
      type: "facture_electronique_certifiee",
      compliance_mode: "certified",
      compliance_status: "draft",
      currency: "XOF",
      vat_rate: 0.18,
      buyer: {
        name: null,
        phone: null,
        ifu: null,
        address: null,
      },
      items: [],
      total_ht: 0,
      vat_amount: 0,
      total_ttc: 0,
    };
  }

  function recomputeDraftTotals(draft) {
    if (!draft || typeof draft !== "object") return draft;

    const items = Array.isArray(draft.items) ? draft.items : [];
    const vatRate = toNum(draft.vat_rate, 0);

    const normalizedItems = items
      .map((it) => {
        const quantity = toNum(it?.quantity ?? it?.qty, 0);
        const unitPrice = toNum(it?.unit_price ?? it?.unitPrice, 0);
        const lineTotalHt = Number((quantity * unitPrice).toFixed(2));

        return {
          designation: safeText(it?.designation ?? it?.label, "Article"),
          quantity: Number(quantity.toFixed(3)),
          unit_price: Number(unitPrice.toFixed(2)),
          line_total_ht: lineTotalHt,
        };
      })
      .filter((it) => it.designation && it.quantity > 0);

    const totalHt = Number(
      normalizedItems
        .reduce((sum, it) => sum + toNum(it.line_total_ht, 0), 0)
        .toFixed(2)
    );
    const vatAmount = Number((totalHt * vatRate).toFixed(2));
    const totalTtc = Number((totalHt + vatAmount).toFixed(2));

    draft.items = normalizedItems;
    draft.total_ht = totalHt;
    draft.vat_amount = vatAmount;
    draft.total_ttc = totalTtc;

    return draft;
  }

  function buildSellerPreview(profile = {}) {
    return {
      name: safeText(profile?.business_name, "-"),
      ifu: safeText(profile?.ifu || profile?.business_ifu, "-"),
      phone: safeText(profile?.phone, "-"),
      address: safeText(profile?.address, ""),
    };
  }

  function buildItemsPreview(items = []) {
    const rows = Array.isArray(items) ? items : [];
    if (!rows.length) return "Aucune ligne pour le moment.";

    return rows
      .map((it, idx) => {
        const designation = safeText(it?.designation ?? it?.label, "Article");
        const quantity = toNum(it?.quantity ?? it?.qty, 0);
        const unitPrice = toNum(it?.unit_price ?? it?.unitPrice, 0);
        const lineTotal = toNum(
          it?.line_total_ht ?? quantity * unitPrice,
          0
        );

        return `${idx + 1}. ${designation}\n   ${quantity} × ${formatMoney(unitPrice)} = ${formatMoney(lineTotal)}`;
      })
      .join("\n");
  }

  function buildCertifiedPreview({ draft, profile }) {
    const seller = buildSellerPreview(profile);

    return (
      `🧾 *FACTURE ÉLECTRONIQUE CERTIFIÉE*\n\n` +
      `🏢 *ÉMETTEUR*\n` +
      `${seller.name}\n` +
      `IFU: ${seller.ifu}\n` +
      `Tel: ${seller.phone}\n` +
      `${seller.address ? `${seller.address}\n` : ""}\n` +
      `👤 *CLIENT*\n` +
      `${safeText(draft?.buyer?.name, "-")}\n` +
      `${draft?.buyer?.phone ? `Tel: ${draft.buyer.phone}\n` : ""}` +
      `${draft?.buyer?.ifu ? `IFU: ${draft.buyer.ifu}\n` : ""}` +
      `${draft?.buyer?.address ? `${draft.buyer.address}\n` : ""}\n` +
      `📦 *LIGNES*\n` +
      `${buildItemsPreview(draft?.items)}\n\n` +
      `💰 *TOTAUX*\n` +
      `HT: ${formatMoney(draft?.total_ht)}\n` +
      `TVA (${formatVatPercent(draft?.vat_rate)}%): ${formatMoney(draft?.vat_amount)}\n` +
      `TTC: ${formatMoney(draft?.total_ttc)}`
    );
  }

  async function ensureCertifiedProfileReady(from) {
    const profile = await getOrCreateProfile(from);
    const sellerName = safeText(profile?.business_name);
    const sellerIfu = safeText(profile?.ifu || profile?.business_ifu);

    if (!sellerName || !sellerIfu) {
      await sendText(
        from,
        "⚠️ Pour créer une *FEC*, votre profil entreprise doit être complet.\n\n" +
          "Champs obligatoires :\n" +
          "• Nom entreprise\n" +
          "• IFU\n\n" +
          "Complétez votre profil puis revenez."
      );
      return null;
    }

    return profile;
  }

  async function sendCertifiedHomeMenu(from) {
    await sendButtons(
      from,
      "🧾 *FEC — Facture Électronique Certifiée*\n\nChoisissez une option :",
      [
        { id: "CERT_INV_NEW", title: "Nouvelle" },
        { id: "CERT_INV_LIST", title: "Historique" },
        { id: "CERT_INV_CANCEL", title: "Annuler" },
      ]
    );
    return true;
  }

  async function startCertifiedInvoiceFlow(from) {
    const s = getSession(from);
    if (!s) return false;

    const profile = await ensureCertifiedProfileReady(from);
    if (!profile) return true;

    resetCertifiedDraftSession(s);
    s.certifiedInvoiceDraft = buildEmptyCertifiedDraft();
    s.step = "certified_invoice_home";

    return sendCertifiedHomeMenu(from);
  }

  async function startCertifiedInvoiceCreation(from) {
    const s = getSession(from);
    if (!s) return false;

    const profile = await ensureCertifiedProfileReady(from);
    if (!profile) return true;

    s.certifiedInvoiceDraft = buildEmptyCertifiedDraft();
    s.certifiedInvoicePendingItem = null;
    s.step = "certified_invoice_buyer_name";

    await sendText(
      from,
      "🧾 *Nouvelle FEC*\n\n👤 Quel est le nom du client ?"
    );
    return true;
  }

  async function sendCertifiedPreview(from) {
    const s = getSession(from);
    const draft = s?.certifiedInvoiceDraft;

    if (!draft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de FEC en cours.\nTapez MENU pour recommencer."
      );
      return true;
    }

    recomputeDraftTotals(draft);
    const profile = await getOrCreateProfile(from);

    await sendText(
      from,
      buildCertifiedPreview({
        draft,
        profile,
      })
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "CERT_INV_ADD_ITEM", title: "Ajouter ligne" },
      { id: "CERT_INV_SET_VAT", title: "TVA" },
      { id: "CERT_INV_CONFIRM", title: "Générer" },
    ]);

    await sendButtons(from, "Autres actions", [
      { id: "CERT_INV_EDIT_CLIENT", title: "Client" },
      { id: "CERT_INV_CANCEL", title: "Annuler" },
      { id: "BACK_HOME", title: "Menu" },
    ]);

    s.step = "certified_invoice_review";
    return true;
  }

  async function sendRecentCertifiedInvoices(from) {
    if (typeof listRecentCertifiedInvoices !== "function") {
      await sendText(
        from,
        "📚 L’historique des FEC arrive bientôt."
      );
      return true;
    }

    const rows = await listRecentCertifiedInvoices(from, 5);

    if (!rows.length) {
      await sendText(
        from,
        "📭 Vous n’avez pas encore de FEC."
      );
      return true;
    }

    const msg =
      `📚 *Vos dernières FEC*\n\n` +
      rows
        .map((row, idx) => {
          return (
            `${idx + 1}. ${safeText(row.invoice_number, "-")}\n` +
            `   Client: ${safeText(row.buyer_name, "-")}\n` +
            `   Total: ${formatMoney(row.total_ttc)}\n` +
            `   Statut: ${safeText(row.status, "-")}`
          );
        })
        .join("\n\n");

    await sendText(from, msg);

    await sendButtons(
      from,
      "Pour l’instant, vous pouvez seulement consulter cette liste.",
      [
        { id: "CERT_INV_NEW", title: "Nouvelle" },
        { id: "CERT_INV_CANCEL", title: "Fermer" },
        { id: "BACK_HOME", title: "Menu" },
      ]
    );

    return true;
  }

  async function confirmCertifiedGeneration(from) {
    const s = getSession(from);
    const draft = s?.certifiedInvoiceDraft;

    if (!draft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de FEC en cours.\nTapez MENU pour recommencer."
      );
      return true;
    }

    recomputeDraftTotals(draft);

    if (!safeText(draft?.buyer?.name)) {
      s.step = "certified_invoice_buyer_name";
      await sendText(from, "⚠️ Nom du client manquant.\nQuel est le nom du client ?");
      return true;
    }

    if (!Array.isArray(draft.items) || !draft.items.length) {
      s.step = "certified_invoice_item_label";
      await sendText(from, "⚠️ Ajoutez au moins une ligne.\nQuelle est la désignation ?");
      return true;
    }

    await sendButtons(
      from,
      `⚠️ *Confirmation finale*\n\n` +
        `Client : ${safeText(draft?.buyer?.name, "-")}\n` +
        `Total TTC : ${formatMoney(draft?.total_ttc)}\n\n` +
        `Cette *FEC* sera enregistrée dans le système sécurisé.`,
      [
        { id: "CERT_INV_FINAL_OK", title: "Confirmer" },
        { id: "CERT_INV_REVIEW", title: "Retour" },
        { id: "CERT_INV_CANCEL", title: "Annuler" },
      ]
    );

    s.step = "certified_invoice_final_confirm";
    return true;
  }

  async function generateCertifiedInvoice(from) {
    const s = getSession(from);
    const draft = s?.certifiedInvoiceDraft;

    if (!draft) {
      await sendText(
        from,
        "📄 Je ne vois pas encore de FEC en cours.\nTapez MENU pour recommencer."
      );
      return true;
    }

    if (s.isGeneratingCertifiedInvoice === true) {
      await sendText(from, "⏳ Génération en cours...");
      return true;
    }

    s.isGeneratingCertifiedInvoice = true;

    try {
      await sendText(
        from,
        "⏳ Génération sécurisée de la FEC..."
      );

      const result = await createCertifiedInvoiceFromDraft({
        waId: from,
        draft,
        sourceChannel: "whatsapp",
        verificationBaseUrl: "https://kadi.app",
      });

      await sendDocument({
        to: from,
        mediaId: result.mediaId,
        filename: result.filename,
        caption:
          `✅ FEC générée\n` +
          `N°: ${safeText(result?.invoice?.invoice_number, "-")}\n` +
          `Réf: ${safeText(result?.invoice?.compliance_reference, "-")}\n` +
          `Total TTC: ${formatMoney(result?.invoice?.total_ttc)}`,
      });

      resetCertifiedDraftSession(s);

      await sendButtons(
        from,
        "✅ Votre FEC a été générée avec succès.",
        [
          { id: "CERT_INV_NEW", title: "Nouvelle" },
          { id: "CERT_INV_LIST", title: "Historique" },
          { id: "BACK_HOME", title: "Menu" },
        ]
      );

      return true;
    } catch (e) {
      console.error("[KADI/CERTIFIED_FLOW] generate error:", e?.message || e);

      await sendText(
        from,
        "❌ Impossible de générer la FEC pour le moment."
      );
      return true;
    } finally {
      s.isGeneratingCertifiedInvoice = false;
    }
  }

  async function resendLatestCertifiedPdf(from) {
    if (typeof listRecentCertifiedInvoices !== "function") {
      await sendText(from, "⚠️ Renvoi FEC indisponible pour le moment.");
      return true;
    }

    const rows = await listRecentCertifiedInvoices(from, 1);
    const latest = Array.isArray(rows) ? rows[0] : null;

    if (!latest?.id) {
      await sendText(from, "📭 Aucune FEC trouvée.");
      return true;
    }

    if (!latest?.pdf_media_id && typeof rebuildCertifiedInvoicePdf === "function") {
      try {
        const rebuilt = await rebuildCertifiedInvoicePdf({
          invoiceId: latest.id,
          verificationBaseUrl: "https://kadi.app",
        });

        await sendDocument({
          to: from,
          mediaId: rebuilt.mediaId,
          filename: rebuilt.filename,
          caption: `📩 Voici à nouveau votre FEC.\nN°: ${safeText(rebuilt?.invoice?.invoice_number, "-")}`,
        });
        return true;
      } catch (e) {
        console.error("[KADI/CERTIFIED_FLOW] rebuild error:", e?.message || e);
      }
    }

    if (!latest?.pdf_media_id) {
      await sendText(from, "⚠️ PDF FEC introuvable pour le moment.");
      return true;
    }

    await sendDocument({
      to: from,
      mediaId: latest.pdf_media_id,
      filename: safeText(latest.pdf_filename, `${safeText(latest.invoice_number, "fec")}.pdf`),
      caption: `📩 Voici à nouveau votre FEC.\nN°: ${safeText(latest.invoice_number, "-")}`,
    });

    return true;
  }

  async function handleCertifiedInvoiceInteractiveReply(from, replyId) {
    const s = getSession(from);
    if (!s) return false;

    if (replyId === "DOC_FEC" || replyId === "DOC_FACTURE_CERTIFIEE") {
      return startCertifiedInvoiceFlow(from);
    }

    if (replyId === "CERT_INV_NEW") {
      return startCertifiedInvoiceCreation(from);
    }

    if (replyId === "CERT_INV_LIST") {
      return sendRecentCertifiedInvoices(from);
    }

    if (replyId === "CERT_INV_CANCEL") {
      resetCertifiedDraftSession(s);
      await sendText(from, "✅ Flow FEC fermé.");
      return true;
    }

    if (replyId === "CERT_INV_RESEND_LAST") {
      return resendLatestCertifiedPdf(from);
    }

    if (!s.certifiedInvoiceDraft) return false;

    const draft = s.certifiedInvoiceDraft;

    if (replyId === "CERT_INV_ADD_BUYER_PHONE") {
      s.step = "certified_invoice_buyer_phone";
      await sendText(from, "📱 Entrez le numéro du client.");
      return true;
    }

    if (replyId === "CERT_INV_SKIP_BUYER_PHONE") {
      draft.buyer.phone = null;
      s.step = "certified_invoice_item_label";
      await sendText(from, "📦 Quelle est la désignation de la première ligne ?");
      return true;
    }

    if (replyId === "CERT_INV_ADD_ITEM") {
      s.step = "certified_invoice_item_label";
      await sendText(from, "📦 Quelle est la désignation de la ligne ?");
      return true;
    }

    if (replyId === "CERT_INV_SET_VAT") {
      s.step = "certified_invoice_vat_rate";
      await sendText(
        from,
        "💰 Quel taux de TVA appliquer ?\n\nExemple : 0.18 pour 18% ou 0 pour aucune TVA."
      );
      return true;
    }

    if (replyId === "CERT_INV_EDIT_CLIENT") {
      s.step = "certified_invoice_buyer_name";
      await sendText(from, "👤 Quel est le nom du client ?");
      return true;
    }

    if (replyId === "CERT_INV_REVIEW") {
      return sendCertifiedPreview(from);
    }

    if (replyId === "CERT_INV_CONFIRM") {
      return confirmCertifiedGeneration(from);
    }

    if (replyId === "CERT_INV_FINAL_OK") {
      return generateCertifiedInvoice(from);
    }

    return false;
  }

  async function handleCertifiedInvoiceText(from, text) {
    const s = getSession(from);
    if (!s?.certifiedInvoiceDraft) return false;

    const draft = s.certifiedInvoiceDraft;
    const t = safeText(text);
    if (!t) return false;

    if (s.step === "certified_invoice_buyer_name") {
      draft.buyer.name = t.slice(0, 120);
      s.step = "certified_invoice_buyer_phone_choice";

      await sendButtons(
        from,
        "📱 Voulez-vous ajouter le numéro du client ?",
        [
          { id: "CERT_INV_ADD_BUYER_PHONE", title: "Ajouter" },
          { id: "CERT_INV_SKIP_BUYER_PHONE", title: "Ignorer" },
          { id: "CERT_INV_CANCEL", title: "Annuler" },
        ]
      );
      return true;
    }

    if (s.step === "certified_invoice_buyer_phone") {
      draft.buyer.phone = normalizePhone(t);
      s.step = "certified_invoice_item_label";
      await sendText(from, "📦 Quelle est la désignation de la première ligne ?");
      return true;
    }

    if (s.step === "certified_invoice_item_label") {
      s.certifiedInvoicePendingItem = {
        designation: t.slice(0, 180),
      };
      s.step = "certified_invoice_item_quantity";
      await sendText(from, "🔢 Quelle quantité ?");
      return true;
    }

    if (s.step === "certified_invoice_item_quantity") {
      const quantity = toNum(t, NaN);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        await sendText(from, "⚠️ Quantité invalide. Entrez un nombre supérieur à 0.");
        return true;
      }

      s.certifiedInvoicePendingItem = {
        ...(s.certifiedInvoicePendingItem || {}),
        quantity,
      };

      s.step = "certified_invoice_item_unit_price";
      await sendText(from, "💰 Quel est le prix unitaire ?");
      return true;
    }

    if (s.step === "certified_invoice_item_unit_price") {
      const unitPrice = toNum(t, NaN);

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        await sendText(from, "⚠️ Prix invalide. Entrez un montant valide.");
        return true;
      }

      const pending = s.certifiedInvoicePendingItem || {};

      draft.items.push({
        designation: safeText(pending.designation, "Article"),
        quantity: toNum(pending.quantity, 1),
        unit_price: Number(unitPrice.toFixed(2)),
      });

      s.certifiedInvoicePendingItem = null;
      recomputeDraftTotals(draft);

      await sendButtons(
        from,
        "✅ Ligne ajoutée. Que voulez-vous faire ?",
        [
          { id: "CERT_INV_ADD_ITEM", title: "Ajouter" },
          { id: "CERT_INV_SET_VAT", title: "TVA" },
          { id: "CERT_INV_CONFIRM", title: "Générer" },
        ]
      );

      s.step = "certified_invoice_review";
      return true;
    }

    if (s.step === "certified_invoice_vat_rate") {
      const vatRate = toNum(t, NaN);

      if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) {
        await sendText(
          from,
          "⚠️ Taux invalide.\nExemple : 0.18 pour 18% ou 0 pour aucune TVA."
        );
        return true;
      }

      draft.vat_rate = Number(vatRate.toFixed(4));
      recomputeDraftTotals(draft);
      return sendCertifiedPreview(from);
    }

    return false;
  }

 return {
    isCertifiedStep,
    resetCertifiedDraftSession,
    startCertifiedInvoiceFlow,
    startCertifiedInvoiceCreation,
    sendCertifiedPreview,
    sendRecentCertifiedInvoices,
    handleCertifiedInvoiceInteractiveReply,
    handleCertifiedInvoiceText,
  };
}

module.exports = {
  makeKadiCertifiedFlow,
};