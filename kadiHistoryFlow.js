"use strict";

function makeKadiHistoryFlow(deps) {
  const {
    getSession,
    sendText,
    sendButtons,
    sendList = null,
    sendDocument,

    listRecentDocumentsByWaId,
    getLatestResendableDocumentByWaId,
    getDocumentById = null,

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
    session.historySelectedDocId = null;
    session.historySelectedDoc = null;
    if (isHistoryStep(session.step)) session.step = null;
  }

  function rememberHistoryRows(session, rows = []) {
    if (!session) return;
    session.historyRows = Array.isArray(rows) ? rows.slice(0, 10) : [];
  }

  function findHistoryRowInSession(session, docId) {
    if (!session || !Array.isArray(session.historyRows)) return null;
    return (
      session.historyRows.find((row) => safeText(row?.id) === safeText(docId)) ||
      null
    );
  }

  function clip(value = "", max = 72) {
    return String(value || "").trim().slice(0, max);
  }

  function buildListRowDescription(row = {}) {
    const docNumber = safeText(row?.doc_number, "-");
    const client = safeText(row?.client, "-");
    const date = formatDate(row?.created_at || row?.date);

    return clip(`N° ${docNumber} • ${client} • ${date}`, 72);
  }

  function buildDocSummary(row = {}) {
    const label = buildDocLabel(row);
    const client = safeText(row?.client, "-");
    const total = formatMoney(row?.total);
    const docNumber = safeText(row?.doc_number, "-");
    const created = formatDate(row?.created_at || row?.date);
    const hasPdf = !!row?.pdf_media_id;

    return (
      `📄 *${label}*\n\n` +
      `N° : ${docNumber}\n` +
      `Client : ${client}\n` +
      `Total : ${total}\n` +
      `Date : ${created}\n` +
      `PDF : ${hasPdf ? "Disponible" : "Indisponible"}`
    );
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

  function buildHistoryListSections(rows = []) {
    const safeRows = (Array.isArray(rows) ? rows : []).slice(0, 10);

    return [
      {
        title: "Documents récents",
        rows: safeRows.map((row) => ({
          id: `HISTORY_OPEN_${safeText(row?.id, "unknown")}`,
          title: clip(buildDocLabel(row), 24),
          description: buildListRowDescription(row),
        })),
      },
    ];
  }

  async function sendHistoryHome(from) {
    const s = getSession(from);
    if (s) {
      s.step = "history_home";
      s.historySelectedDocId = null;
      s.historySelectedDoc = null;
    }

    await sendButtons(
      from,
      "📚 *Historique*\n\nChoisissez ce que vous voulez consulter.",
      [
        { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
        { id: "HISTORY_KADI", title: "Docs récents" },
        { id: "HISTORY_FEC", title: "Voir FEC" },
      ]
    );

    return true;
  }

  async function sendKadiHistory(from) {
    if (typeof listRecentDocumentsByWaId !== "function") {
      await sendText(from, "⚠️ Historique KADI indisponible pour le moment.");
      return true;
    }

    const s = getSession(from);
    const rows = await listRecentDocumentsByWaId(from, 10);

    if (s) {
      rememberHistoryRows(s, rows);
      s.historySelectedDocId = null;
      s.historySelectedDoc = null;
      s.step = "history_kadi_list";
    }

    if (!rows.length) {
      await sendText(from, "📭 Vous n’avez pas encore de documents KADI.");
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_FEC", title: "Voir FEC" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);
      return true;
    }

    if (typeof sendList === "function") {
      await sendList(from, {
        header: "Historique KADI",
        body: "Choisissez un document récent à consulter.",
        footer: "Renvoi du PDF existant gratuit",
        buttonText: "Ouvrir",
        sections: buildHistoryListSections(rows),
      });

      await sendButtons(from, "Actions rapides :", [
        { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
        { id: "HISTORY_FEC", title: "Voir FEC" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);

      return true;
    }

    await sendText(
      from,
      buildKadiHistoryMessage(rows) +
        `\n\nRépondez avec un numéro (1 à ${rows.length}) pour ouvrir un document.`
    );

    await sendButtons(from, "Actions rapides :", [
      { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
      { id: "HISTORY_FEC", title: "Voir FEC" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function loadHistoryDocument(session, docId) {
    const fromSession = findHistoryRowInSession(session, docId);
    if (fromSession) return fromSession;

    if (typeof getDocumentById === "function") {
      try {
        return await getDocumentById(docId);
      } catch (_) {
        return null;
      }
    }

    return null;
  }

  async function openHistoryDocument(from, docId) {
    const s = getSession(from);
    const row = await loadHistoryDocument(s, docId);

    if (!row) {
      await sendText(
        from,
        "⚠️ Je n’ai pas retrouvé ce document dans votre historique récent."
      );
      return sendKadiHistory(from);
    }

    if (s) {
      s.historySelectedDocId = safeText(row.id, null);
      s.historySelectedDoc = row;
      s.step = "history_doc_selected";
    }

    await sendText(from, buildDocSummary(row));

    if (row?.pdf_media_id) {
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_RESEND_SELECTED", title: "Renvoyer PDF" },
        { id: "HISTORY_BACK_LIST", title: "Retour docs" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);
    } else {
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_BACK_LIST", title: "Retour docs" },
        { id: "HISTORY_FEC", title: "Voir FEC" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);
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

  async function sendDocumentRow(from, row, successText = "✅ PDF renvoyé.") {
    if (!row?.pdf_media_id) {
      await sendText(
        from,
        "📭 Ce document n’a pas de PDF renvoyable pour le moment."
      );
      return true;
    }

    await sendDocument({
      to: from,
      mediaId: row.pdf_media_id,
      filename:
        safeText(row.pdf_filename) ||
        `${safeText(row.doc_number, "document")}.pdf`,
      caption:
        safeText(row.pdf_caption) ||
        `📩 Voici à nouveau votre document.\nN°: ${safeText(
          row.doc_number,
          "-"
        )}`,
    });

    await sendText(from, successText);
    return true;
  }

  async function resendLastKadiPdf(from) {
    if (typeof getLatestResendableDocumentByWaId !== "function") {
      await sendText(from, "⚠️ Renvoi PDF indisponible pour le moment.");
      return true;
    }

    const latest = await getLatestResendableDocumentByWaId(from, 20);

    if (!latest?.pdf_media_id) {
      await sendText(from, "📭 Je n’ai pas trouvé de PDF récent à renvoyer.");
      return true;
    }

    await sendDocumentRow(from, latest, "✅ Dernier PDF renvoyé.");

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "HISTORY_KADI", title: "Docs récents" },
      { id: "HISTORY_FEC", title: "Voir FEC" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function resendSelectedKadiPdf(from) {
    const s = getSession(from);
    const docId = safeText(s?.historySelectedDocId, null);

    if (!docId) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé le document sélectionné.");
      return sendKadiHistory(from);
    }

    const row =
      s?.historySelectedDoc || (await loadHistoryDocument(s, docId));

    if (!row) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé ce document.");
      return sendKadiHistory(from);
    }

    await sendDocumentRow(from, row, "✅ PDF renvoyé.");

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "HISTORY_BACK_LIST", title: "Retour docs" },
      { id: "HISTORY_FEC", title: "Voir FEC" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

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

    if (replyId === "HISTORY_LATEST_PDF") {
      return resendLastKadiPdf(from);
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

    if (replyId === "HISTORY_RESEND_SELECTED") {
      return resendSelectedKadiPdf(from);
    }

    if (replyId === "HISTORY_BACK_LIST") {
      return sendKadiHistory(from);
    }

    if (replyId === "HISTORY_REFRESH") {
      return sendKadiHistory(from);
    }

    if (replyId === "HISTORY_CLOSE") {
      return closeHistory(from);
    }

    const openMatch = String(replyId || "").match(/^HISTORY_OPEN_(.+)$/);
    if (openMatch) {
      return openHistoryDocument(from, openMatch[1]);
    }

    if (s && isHistoryStep(s.step)) {
      return false;
    }

    return false;
  }

  async function handleHistoryText(from, text) {
    const s = getSession(from);
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

    if (t === "historique fec" || t === "mes fec" || t === "fecs") {
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

    if (s && isHistoryStep(s.step)) {
      if (t === "fermer" || t === "quitter" || t === "close") {
        return closeHistory(from);
      }

      if (t === "retour" || t === "back") {
        if (s.step === "history_doc_selected") {
          return sendKadiHistory(from);
        }
        return sendHistoryHome(from);
      }

      const idx = Number(t);
      if (
        Number.isInteger(idx) &&
        idx >= 1 &&
        Array.isArray(s.historyRows) &&
        idx <= s.historyRows.length
      ) {
        const row = s.historyRows[idx - 1];
        if (!row?.id) {
          await sendText(
            from,
            "⚠️ Je n’ai pas retrouvé ce document dans la liste."
          );
          return true;
        }

        return openHistoryDocument(from, row.id);
      }
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