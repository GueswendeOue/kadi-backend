"use strict";

function makeKadiHistoryFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    sendDocument,

    listRecentDocumentsByWaId,
    getLatestResendableDocumentByWaId,

    sendRecentCertifiedInvoices = null,
    sendHomeMenu = null,

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

  function formatDate(value) {
    const raw = safeText(value, "");
    if (!raw) return "-";

    try {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return raw;
      return d.toLocaleDateString("fr-FR");
    } catch (_) {
      return raw;
    }
  }

  function buildDocLabel(row = {}) {
    const type = safeText(row?.doc_type).toLowerCase();
    const kind = safeText(row?.facture_kind).toLowerCase();

    if (type === "facture") {
      if (kind === "proforma") return "Facture proforma";
      return "Facture";
    }

    if (type === "devis") return "Devis";
    if (type === "recu") return "Reçu";
    if (type === "decharge") return "Décharge";

    return safeText(row?.doc_label, "Document");
  }

  function isHistoryStep(step = "") {
    return String(step || "").startsWith("history_");
  }

  function resetHistorySession(session) {
    if (!session) return;
    session.historyRows = null;
    if (isHistoryStep(session.step)) session.step = null;
  }

  async function sendHistoryHome(from) {
    const s = getSession(from);
    if (s) s.step = "history_home";

    const buttons = [
      { id: "HISTORY_KADI", title: "Docs KADI" },
      { id: "HISTORY_FEC", title: "FEC" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ];

    await sendButtons(
      from,
      "📚 *Historique*\n\nChoisissez ce que vous voulez consulter.",
      buttons
    );
    return true;
  }

  function buildKadiHistoryMessage(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return "📭 Vous n’avez pas encore de documents KADI.";
    }

    return (
      `📚 *Historique — Documents KADI*\n\n` +
      list
        .map((row, idx) => {
          const label = buildDocLabel(row);
          const client = safeText(row?.client, "-");
          const total = formatMoney(row?.total);
          const docNumber = safeText(row?.doc_number, "-");
          const created = formatDate(row?.created_at || row?.date);

          return (
            `${idx + 1}. ${label}\n` +
            `   N°: ${docNumber}\n` +
            `   Client: ${client}\n` +
            `   Total: ${total}\n` +
            `   Date: ${created}`
          );
        })
        .join("\n\n")
    );
  }

  async function sendKadiHistory(from) {
    if (typeof listRecentDocumentsByWaId !== "function") {
      await sendText(from, "⚠️ Historique KADI indisponible pour le moment.");
      return true;
    }

    const s = getSession(from);
    const rows = await listRecentDocumentsByWaId(from, 5);

    if (s) {
      s.historyRows = rows;
      s.step = "history_kadi";
    }

    await sendText(from, buildKadiHistoryMessage(rows));

    const lastResendable =
      typeof getLatestResendableDocumentByWaId === "function"
        ? await getLatestResendableDocumentByWaId(from, 20)
        : null;

    if (lastResendable?.pdf_media_id) {
      await sendButtons(
        from,
        "Que voulez-vous faire ?",
        [
          { id: "HISTORY_RESEND_LAST", title: "Renvoyer PDF" },
          { id: "HISTORY_FEC", title: "Voir FEC" },
          { id: "HISTORY_CLOSE", title: "Fermer" },
        ]
      );
    } else {
      await sendButtons(
        from,
        "Que voulez-vous faire ?",
        [
          { id: "HISTORY_REFRESH", title: "Actualiser" },
          { id: "HISTORY_FEC", title: "Voir FEC" },
          { id: "HISTORY_CLOSE", title: "Fermer" },
        ]
      );
    }

    return true;
  }

  async function sendFecHistory(from) {
    if (typeof sendRecentCertifiedInvoices === "function") {
      return sendRecentCertifiedInvoices(from);
    }

    await sendText(from, "📚 L’historique FEC arrive bientôt.");
    return true;
  }

  async function resendLastKadiPdf(from) {
    if (typeof getLatestResendableDocumentByWaId !== "function") {
      await sendText(from, "⚠️ Renvoi PDF indisponible pour le moment.");
      return true;
    }

    const latest = await getLatestResendableDocumentByWaId(from, 20);

    if (!latest?.pdf_media_id) {
      await sendText(
        from,
        "📭 Je n’ai pas trouvé de PDF récent à renvoyer."
      );
      return true;
    }

    await sendDocument({
      to: from,
      mediaId: latest.pdf_media_id,
      filename:
        safeText(latest.pdf_filename) ||
        `${safeText(latest.doc_number, "document")}.pdf`,
      caption:
        safeText(latest.pdf_caption) ||
        `📩 Voici à nouveau votre document.\nN°: ${safeText(
          latest.doc_number,
          "-"
        )}`,
    });

    await sendButtons(
      from,
      "✅ PDF renvoyé.",
      [
        { id: "HISTORY_KADI", title: "Docs KADI" },
        { id: "HISTORY_FEC", title: "Voir FEC" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]
    );

    return true;
  }

  async function closeHistory(from) {
    const s = getSession(from);
    resetHistorySession(s);

    await sendText(from, "✅ Historique fermé.");
    if (typeof sendHomeMenu === "function") {
      await sendHomeMenu(from);
    }
    return true;
  }

  async function handleHistoryInteractiveReply(from, replyId) {
    const s = getSession(from);

    if (replyId === "HOME_HISTORY") {
      return sendHistoryHome(from);
    }

    if (replyId === "HISTORY_KADI") {
      return sendKadiHistory(from);
    }

    if (replyId === "HISTORY_FEC") {
      return sendFecHistory(from);
    }

    if (replyId === "HISTORY_RESEND_LAST") {
      return resendLastKadiPdf(from);
    }

    if (replyId === "HISTORY_REFRESH") {
      return sendKadiHistory(from);
    }

    if (replyId === "HISTORY_CLOSE") {
      return closeHistory(from);
    }

    if (s && isHistoryStep(s.step)) {
      return false;
    }

    return false;
  }

  async function handleHistoryText(from, text) {
    const t = safeText(text).toLowerCase();
    if (!t) return false;

    if (
      t === "historique" ||
      t === "history" ||
      t === "mes documents" ||
      t === "mes docs"
    ) {
      return sendHistoryHome(from);
    }

    if (
      t === "historique fec" ||
      t === "mes fec" ||
      t === "fecs"
    ) {
      return sendFecHistory(from);
    }

    if (
      t === "historique kadi" ||
      t === "docs kadi" ||
      t === "documents kadi"
    ) {
      return sendKadiHistory(from);
    }

    if (
      t === "renvoyer pdf" ||
      t === "renvoie pdf" ||
      t === "dernier pdf" ||
      t === "dernier document"
    ) {
      return resendLastKadiPdf(from);
    }

    return false;
  }

  return {
    isHistoryStep,
    resetHistorySession,
    sendHistoryHome,
    sendKadiHistory,
    sendFecHistory,
    resendLastKadiPdf,
    handleHistoryInteractiveReply,
    handleHistoryText,
  };
}

module.exports = {
  makeKadiHistoryFlow,
};