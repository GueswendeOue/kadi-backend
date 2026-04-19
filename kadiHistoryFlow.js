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
    getDocumentByIdForWaId = null,
    searchDocumentsByWaId = null,

    sendRecentCertifiedInvoices = null,
    sendHomeMenu = null,

    money,
  } = deps;

  const KNOWN_WA_COUNTRY_CODES = [
    "971",
    "351",
    "243",
    "242",
    "237",
    "235",
    "234",
    "229",
    "228",
    "227",
    "226",
    "225",
    "223",
    "221",
    "216",
    "213",
    "212",
    "90",
    "49",
    "44",
    "41",
    "39",
    "34",
    "33",
    "32",
    "31",
    "20",
    "1",
  ];

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

  function clip(value = "", max = 72) {
    return String(value || "").trim().slice(0, max);
  }

  function sanitizePhone(value = "") {
    const digits = String(value || "").replace(/\D/g, "");
    return digits || null;
  }

  function extractCountryCodeFromWaId(waId = "") {
    const digits = String(waId || "").replace(/\D/g, "");

    for (const code of KNOWN_WA_COUNTRY_CODES) {
      if (digits.startsWith(code)) return code;
    }

    return null;
  }

  function normalizeClientWaId(value = "", senderWaId = "") {
    let digits = String(value || "").replace(/\D/g, "");
    if (!digits) return null;

    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    }

    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }

    const senderCode = extractCountryCodeFromWaId(senderWaId);
    if (senderCode && digits.length === 8) {
      return `${senderCode}${digits}`;
    }

    return null;
  }

  function formatDisplayWaId(waId = "") {
    const digits = String(waId || "").replace(/\D/g, "");
    return digits ? `+${digits}` : "-";
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

  function extractClientPhoneFromRow(row = {}) {
    return (
      safeText(row?.client_phone, null) ||
      safeText(row?.clientPhone, null) ||
      safeText(row?.raw?.clientPhone, null) ||
      safeText(row?.raw?.client_phone, null) ||
      null
    );
  }

  function buildClientDocumentCaption(row = {}) {
    const docLabel = buildDocLabel(row);
    const docNumber = safeText(row?.doc_number, "");
    const client = safeText(row?.client, "");

    let text = `📄 ${docLabel}`;
    if (docNumber) text += ` ${docNumber}`;
    if (client) text += `\n👤 Client : ${client}`;

    return text;
  }

  function canSendRowToClient(from, row = {}) {
    const clientPhone = extractClientPhoneFromRow(row);
    return !!normalizeClientWaId(clientPhone || "", from);
  }

  function isHistoryStep(step = "") {
    return String(step || "").startsWith("history_");
  }

  function resetHistorySession(session) {
    if (!session) return;

    session.historyRows = null;
    session.historySelectedDocId = null;
    session.historySelectedDoc = null;
    session.historySearchQuery = null;
    session.historyView = null;

    if (isHistoryStep(session.step)) {
      session.step = null;
    }
  }

  function rememberHistoryRows(session, rows = [], options = {}) {
    if (!session) return;

    session.historyRows = Array.isArray(rows) ? rows.slice(0, 10) : [];
    session.historyView = safeText(options.view, session.historyView || "kadi");
    session.historySearchQuery =
      safeText(options.searchQuery, session.historySearchQuery || null) || null;
  }

  function findHistoryRowInSession(session, docId) {
    if (!session || !Array.isArray(session.historyRows)) return null;

    return (
      session.historyRows.find(
        (row) => safeText(row?.id) === safeText(docId)
      ) || null
    );
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
    const clientPhone = extractClientPhoneFromRow(row);

    return (
      `📄 *${label}*\n\n` +
      `N° : ${docNumber}\n` +
      `Client : ${client}\n` +
      `Total : ${total}\n` +
      `Date : ${created}\n` +
      `PDF : ${hasPdf ? "Disponible" : "Indisponible"}\n` +
      `Numéro client : ${clientPhone ? clientPhone : "Non renseigné"}`
    );
  }

  function buildRowsTextMessage(title, rows = []) {
    const list = Array.isArray(rows) ? rows : [];

    if (!list.length) {
      return `📭 Aucun document trouvé pour ${title.toLowerCase()}.`;
    }

    return (
      `📚 *${title}*\n\n` +
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

  function buildHistoryListSections(title, rows = []) {
    const safeRows = (Array.isArray(rows) ? rows : []).slice(0, 10);

    return [
      {
        title: clip(title, 24),
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

    if (typeof sendList === "function") {
      await sendList(from, {
        header: "Historique",
        body: "Choisissez ce que vous voulez consulter.",
        footer: "PDF existants renvoyés sans nouveau coût",
        buttonText: "Ouvrir",
        sections: [
          {
            title: "KADI",
            rows: [
              {
                id: "HISTORY_LATEST_PDF",
                title: "Dernier PDF",
                description: "Renvoyer le dernier PDF disponible",
              },
              {
                id: "HISTORY_KADI",
                title: "Docs récents",
                description: "Voir vos documents KADI récents",
              },
              {
                id: "HISTORY_SEARCH",
                title: "Rechercher",
                description: "Chercher par client, numéro ou mot-clé",
              },
            ],
          },
          {
            title: "Autres",
            rows: [
              {
                id: "HISTORY_FEC",
                title: "Voir FEC",
                description: "Consulter les factures certifiées",
              },
              {
                id: "HISTORY_CLOSE",
                title: "Fermer",
                description: "Quitter l’historique",
              },
            ],
          },
        ],
      });

      return true;
    }

    await sendButtons(from, "📚 *Historique*\n\nChoisissez une action.", [
      { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
      { id: "HISTORY_KADI", title: "Docs récents" },
      { id: "HISTORY_SEARCH", title: "Rechercher" },
    ]);

    await sendText(
      from,
      "💡 Tapez *FEC* pour voir l’historique FEC.\nTapez *FERMER* pour quitter."
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
      rememberHistoryRows(s, rows, { view: "kadi", searchQuery: null });
      s.historySelectedDocId = null;
      s.historySelectedDoc = null;
      s.step = "history_kadi_list";
    }

    if (!rows.length) {
      await sendText(from, "📭 Vous n’avez pas encore de documents KADI.");
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_SEARCH", title: "Rechercher" },
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
        sections: buildHistoryListSections("Docs récents", rows),
      });

      await sendButtons(from, "Actions rapides :", [
        { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
        { id: "HISTORY_SEARCH", title: "Rechercher" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);

      return true;
    }

    await sendText(
      from,
      buildRowsTextMessage("Historique — Documents KADI", rows) +
        `\n\nRépondez avec un numéro (1 à ${rows.length}) pour ouvrir un document.`
    );

    await sendButtons(from, "Actions rapides :", [
      { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
      { id: "HISTORY_SEARCH", title: "Rechercher" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function sendSearchPrompt(from) {
    const s = getSession(from);
    if (s) {
      s.step = "history_search_waiting";
      s.historySelectedDocId = null;
      s.historySelectedDoc = null;
    }

    await sendText(
      from,
      "🔎 Tapez un nom client, un numéro de document ou un mot-clé.\n\nExemples :\n• Moussa\n• FAC-2026-0042\n• réparation"
    );

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "HISTORY_KADI", title: "Docs récents" },
      { id: "HISTORY_FEC", title: "Voir FEC" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function sendSearchResults(from, query) {
    if (typeof searchDocumentsByWaId !== "function") {
      await sendText(from, "⚠️ Recherche historique indisponible pour le moment.");
      return true;
    }

    const safeQuery = safeText(query);
    if (!safeQuery) {
      await sendText(from, "⚠️ Tapez un mot-clé pour lancer la recherche.");
      return true;
    }

    const s = getSession(from);
    const rows = await searchDocumentsByWaId(from, safeQuery, 10, 150);

    if (s) {
      rememberHistoryRows(s, rows, {
        view: "search",
        searchQuery: safeQuery,
      });
      s.historySelectedDocId = null;
      s.historySelectedDoc = null;
      s.step = "history_search_results";
    }

    if (!rows.length) {
      await sendText(from, `📭 Aucun document trouvé pour : *${safeQuery}*`);

      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_SEARCH", title: "Nouvelle rech." },
        { id: "HISTORY_KADI", title: "Docs récents" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);

      return true;
    }

    if (typeof sendList === "function") {
      await sendList(from, {
        header: "Résultats",
        body: `Résultats pour : ${clip(safeQuery, 60)}`,
        footer: "Choisissez un document",
        buttonText: "Ouvrir",
        sections: buildHistoryListSections("Résultats", rows),
      });

      await sendButtons(from, "Actions rapides :", [
        { id: "HISTORY_SEARCH", title: "Nouvelle rech." },
        { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);

      return true;
    }

    await sendText(
      from,
      buildRowsTextMessage(`Résultats — ${safeQuery}`, rows) +
        `\n\nRépondez avec un numéro (1 à ${rows.length}) pour ouvrir un document.`
    );

    await sendButtons(from, "Actions rapides :", [
      { id: "HISTORY_SEARCH", title: "Nouvelle rech." },
      { id: "HISTORY_LATEST_PDF", title: "Dernier PDF" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function loadHistoryDocumentForUser(from, session, docId) {
    if (typeof getDocumentByIdForWaId === "function") {
      try {
        const row = await getDocumentByIdForWaId(from, docId);
        if (row) return row;
      } catch (_) {}
    }

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

  function getBackButtonTitle(session) {
    return session?.historyView === "search" ? "Retour rés." : "Retour docs";
  }

  async function sendSelectedDocumentActions(from, row, session) {
    const hasPdf = !!row?.pdf_media_id;
    const canSendClient = hasPdf && canSendRowToClient(from, row);

    if (hasPdf && canSendClient) {
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_RESEND_SELECTED", title: "Renvoyer PDF" },
        { id: "HISTORY_SEND_SELECTED_CLIENT", title: "Envoyer client" },
        { id: "HISTORY_BACK", title: getBackButtonTitle(session) },
      ]);
      return true;
    }

    if (hasPdf) {
      await sendButtons(from, "Que voulez-vous faire ?", [
        { id: "HISTORY_RESEND_SELECTED", title: "Renvoyer PDF" },
        { id: "HISTORY_BACK", title: getBackButtonTitle(session) },
        { id: "HISTORY_CLOSE", title: "Fermer" },
      ]);
      return true;
    }

    await sendButtons(from, "Que voulez-vous faire ?", [
      { id: "HISTORY_BACK", title: getBackButtonTitle(session) },
      { id: "HISTORY_SEARCH", title: "Rechercher" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);
    return true;
  }

  async function openHistoryDocument(from, docId) {
    const s = getSession(from);
    const row = await loadHistoryDocumentForUser(from, s, docId);

    if (!row) {
      await sendText(
        from,
        "⚠️ Je n’ai pas retrouvé ce document dans votre historique."
      );

      if (s?.historyView === "search" && s?.historySearchQuery) {
        return sendSearchResults(from, s.historySearchQuery);
      }

      return sendKadiHistory(from);
    }

    if (s) {
      s.historySelectedDocId = safeText(row.id, null);
      s.historySelectedDoc = row;
      s.step = "history_doc_selected";
    }

    await sendText(from, buildDocSummary(row));
    return sendSelectedDocumentActions(from, row, s);
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

  async function sendDocumentToClient(from, row) {
    if (!row?.pdf_media_id) {
      await sendText(
        from,
        "📭 Ce document n’a pas de PDF renvoyable pour le moment."
      );
      return true;
    }

    const rawPhone = extractClientPhoneFromRow(row);
    const clientWaId = normalizeClientWaId(rawPhone || "", from);

    if (!clientWaId) {
      await sendText(
        from,
        "⚠️ Le numéro du client est manquant ou invalide sur ce document."
      );
      return true;
    }

    const caption = buildClientDocumentCaption(row);

    await sendDocument({
      to: clientWaId,
      mediaId: row.pdf_media_id,
      filename:
        safeText(row.pdf_filename) ||
        `${safeText(row.doc_number, "document")}.pdf`,
      caption,
    });

    await sendText(
      from,
      `✅ Document envoyé au client.\n📱 Numéro : ${formatDisplayWaId(
        clientWaId
      )}`
    );

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
      { id: "HISTORY_SEARCH", title: "Rechercher" },
      { id: "HISTORY_CLOSE", title: "Fermer" },
    ]);

    return true;
  }

  async function resendSelectedKadiPdf(from) {
    const s = getSession(from);
    const docId = safeText(s?.historySelectedDocId, null);

    if (!docId) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé le document sélectionné.");

      if (s?.historyView === "search" && s?.historySearchQuery) {
        return sendSearchResults(from, s.historySearchQuery);
      }

      return sendKadiHistory(from);
    }

    const row =
      s?.historySelectedDoc ||
      (await loadHistoryDocumentForUser(from, s, docId));

    if (!row) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé ce document.");

      if (s?.historyView === "search" && s?.historySearchQuery) {
        return sendSearchResults(from, s.historySearchQuery);
      }

      return sendKadiHistory(from);
    }

    await sendDocumentRow(from, row, "✅ PDF renvoyé.");
    return sendSelectedDocumentActions(from, row, s);
  }

  async function sendSelectedKadiPdfToClient(from) {
    const s = getSession(from);
    const docId = safeText(s?.historySelectedDocId, null);

    if (!docId) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé le document sélectionné.");

      if (s?.historyView === "search" && s?.historySearchQuery) {
        return sendSearchResults(from, s.historySearchQuery);
      }

      return sendKadiHistory(from);
    }

    const row =
      s?.historySelectedDoc ||
      (await loadHistoryDocumentForUser(from, s, docId));

    if (!row) {
      await sendText(from, "⚠️ Je n’ai pas retrouvé ce document.");

      if (s?.historyView === "search" && s?.historySearchQuery) {
        return sendSearchResults(from, s.historySearchQuery);
      }

      return sendKadiHistory(from);
    }

    await sendDocumentToClient(from, row);
    return sendSelectedDocumentActions(from, row, s);
  }

  async function goBackInHistory(from) {
    const s = getSession(from);

    if (s?.historyView === "search" && safeText(s?.historySearchQuery)) {
      return sendSearchResults(from, s.historySearchQuery);
    }

    return sendKadiHistory(from);
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

    if (
      replyId === "HISTORY_LATEST_PDF" ||
      replyId === "HISTORY_RESEND_LAST"
    ) {
      return resendLastKadiPdf(from);
    }

    if (replyId === "HISTORY_KADI") {
      return sendKadiHistory(from);
    }

    if (replyId === "HISTORY_FEC") {
      return sendFecHistory(from);
    }

    if (replyId === "HISTORY_SEARCH") {
      return sendSearchPrompt(from);
    }

    if (replyId === "HISTORY_RESEND_SELECTED") {
      return resendSelectedKadiPdf(from);
    }

    if (replyId === "HISTORY_SEND_SELECTED_CLIENT") {
      return sendSelectedKadiPdfToClient(from);
    }

    if (replyId === "HISTORY_BACK" || replyId === "HISTORY_BACK_LIST") {
      return goBackInHistory(from);
    }

    if (replyId === "HISTORY_REFRESH") {
      return s?.historyView === "search" && s?.historySearchQuery
        ? sendSearchResults(from, s.historySearchQuery)
        : sendKadiHistory(from);
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
    const raw = safeText(text);
    const t = raw.toLowerCase();

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
      t === "fecs" ||
      t === "fec"
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

    if (
      t === "rechercher" ||
      t === "recherche" ||
      t === "chercher" ||
      t === "chercher document"
    ) {
      return sendSearchPrompt(from);
    }

    if (t.startsWith("rechercher ") || t.startsWith("chercher ")) {
      const query = raw.replace(/^(rechercher|chercher)\s+/i, "").trim();
      if (query) return sendSearchResults(from, query);
    }

    if (s?.step === "history_search_waiting") {
      if (t === "fermer" || t === "quitter" || t === "close") {
        return closeHistory(from);
      }

      if (t === "retour" || t === "back") {
        return sendHistoryHome(from);
      }

      if (raw.length < 2) {
        await sendText(
          from,
          "⚠️ Tapez au moins 2 caractères pour la recherche."
        );
        return true;
      }

      return sendSearchResults(from, raw);
    }

    if (s && isHistoryStep(s.step)) {
      if (t === "fermer" || t === "quitter" || t === "close") {
        return closeHistory(from);
      }

      if (t === "retour" || t === "back") {
        if (s.step === "history_doc_selected") {
          return goBackInHistory(from);
        }

        if (s.step === "history_search_results") {
          return sendSearchPrompt(from);
        }

        return sendHistoryHome(from);
      }

      if (
        s.step === "history_doc_selected" &&
        (t === "envoyer client" ||
          t === "envoyer au client" ||
          t === "client")
      ) {
        return sendSelectedKadiPdfToClient(from);
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