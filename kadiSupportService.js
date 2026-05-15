"use strict";

const DEFAULT_SUPPORT_ADMIN_WA_ID = "22670626055";

function safeText(value = "", maxLen = null) {
  let out = String(value || "").trim();
  if (Number.isFinite(maxLen) && maxLen > 0) out = out.slice(0, maxLen);
  return out;
}

function normalizeWaId(value = "") {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 8) digits = `226${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function normalizeForIntent(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getSupportPrincipalWaId() {
  return (
    normalizeWaId(process.env.KADI_ADMIN_WA) ||
    normalizeWaId(process.env.ADMIN_WA_ID) ||
    DEFAULT_SUPPORT_ADMIN_WA_ID
  );
}

function looksLikeSupportIntent(text = "") {
  const t = normalizeForIntent(text);
  if (!t) return false;

  if (
    [
      "support",
      "assistance",
      "aide support",
      "support kadi",
      "service client",
      "sav",
    ].includes(t)
  ) {
    return true;
  }

  if (/\b(parler|causer|discuter|echanger|contacter)\b/.test(t)) {
    if (/\b(quelqu un|quelqu'un|humain|personne|agent|support|admin)\b/.test(t)) {
      return true;
    }
  }

  if (/\b(bug|erreur|bloque|bloquee|plantage|probleme|souci|panne)\b/.test(t)) {
    if (
      /\b(kadi|application|appli|facture|devis|recu|document|ocr|photo|paiement|recharge|credit|credits)\b/.test(
        t
      )
    ) {
      return true;
    }
  }

  if (/\b(probleme|souci|erreur|bug|bloque|bloquee)\b/.test(t)) {
    if (/\b(paiement|recharge|orange money|om|pispi|credit|credits)\b/.test(t)) {
      return true;
    }
  }

  return false;
}

function isSupportInteractiveReply(replyId = "") {
  return String(replyId || "").trim().toUpperCase() === "HOME_SUPPORT";
}

function supportOpeningMessage() {
  return (
    "D’accord, je vous mets en relation avec le support Kadi.\n" +
    "Expliquez votre problème ici : paiement, recharge, bug, document, tampon, etc."
  );
}

function buildAgentAlert({ waId, reason, message, isNew }) {
  const lines = [];
  lines.push(isNew ? "🆘 Nouvelle demande support Kadi" : "💬 Message support Kadi");
  lines.push(`Client : +${waId}`);
  if (reason) lines.push(`Raison : ${reason}`);
  if (message) lines.push(`Message : ${safeText(message, 700)}`);
  lines.push("");
  lines.push(`Répondre : /support_reply ${waId} votre message`);
  lines.push(`Clôturer : /support_close ${waId}`);
  return lines.join("\n");
}

function buildMessageLabelFromMsg(msg = {}) {
  if (msg.type === "image") return "[image reçue]";
  if (msg.type === "audio") return "[vocal reçu]";
  if (msg.type === "interactive") return "[réponse interactive]";
  if (msg.type === "document") return "[document reçu]";
  return `[${safeText(msg.type, 40) || "message"} reçu]`;
}

function makeKadiSupportService(deps = {}) {
  const {
    sendText,
    supportRepo,
    principalWaId = getSupportPrincipalWaId(),
    logger = console,
  } = deps;

  if (typeof sendText !== "function") {
    throw new Error("sendText manquant pour le support");
  }

  function getPrincipalAgent() {
    return {
      wa_id: normalizeWaId(principalWaId) || DEFAULT_SUPPORT_ADMIN_WA_ID,
      name: "Admin principal",
      role: "admin",
      is_active: true,
      priority: 0,
    };
  }

  async function ensurePrincipalAgent() {
    if (typeof supportRepo?.addSupportAgent !== "function") return null;
    try {
      return await supportRepo.addSupportAgent({
        waId: getPrincipalAgent().wa_id,
        name: "Admin principal",
        role: "admin",
        priority: 0,
      });
    } catch (err) {
      logger?.warn?.("[KADI/SUPPORT] principal agent upsert failed", err?.message || err);
      return null;
    }
  }

  async function listAgentsForAlert() {
    await ensurePrincipalAgent();

    let agents = [];
    try {
      if (typeof supportRepo?.listActiveSupportAgents === "function") {
        agents = await supportRepo.listActiveSupportAgents();
      }
    } catch (err) {
      logger?.warn?.("[KADI/SUPPORT] active agents lookup failed", err?.message || err);
    }

    const clean = (Array.isArray(agents) ? agents : [])
      .filter((agent) => normalizeWaId(agent?.wa_id))
      .map((agent) => ({ ...agent, wa_id: normalizeWaId(agent.wa_id) }));

    if (!clean.length) return [getPrincipalAgent()];
    return clean;
  }

  async function notifyAgents({ waId, reason, message, isNew }) {
    const agents = await listAgentsForAlert();
    const text = buildAgentAlert({ waId, reason, message, isNew });
    const sentTo = [];

    for (const agent of agents) {
      const to = normalizeWaId(agent?.wa_id);
      if (!to || sentTo.includes(to)) continue;
      try {
        await sendText(to, text);
        sentTo.push(to);
      } catch (err) {
        logger?.warn?.("[KADI/SUPPORT] agent notification failed", {
          to,
          error: err?.message || String(err),
        });
      }
    }

    return sentTo;
  }

  async function startSupportSession(waId, { reason = "support", message = "" } = {}) {
    const id = normalizeWaId(waId);
    if (!id) return false;

    const result = await supportRepo.openSupportSession({
      waId: id,
      reason,
      lastUserMessage: message,
    });

    if (result?.created) {
      await sendText(id, supportOpeningMessage());
    }

    await notifyAgents({
      waId: id,
      reason,
      message,
      isNew: result?.created !== false,
    });

    return true;
  }

  async function handleSupportText(from, text) {
    const id = normalizeWaId(from);
    if (!id) return false;

    let open = null;
    try {
      open = await supportRepo.getOpenSupportSession(id);
    } catch (err) {
      logger?.warn?.("[KADI/SUPPORT] open session lookup failed", err?.message || err);
      if (!looksLikeSupportIntent(text)) return false;
      throw err;
    }

    if (open?.id) {
      const message = safeText(text, 1000);
      await supportRepo.updateOpenSupportSessionMessage(id, message);
      await notifyAgents({
        waId: id,
        reason: open.reason || "support",
        message,
        isNew: false,
      });
      return true;
    }

    if (!looksLikeSupportIntent(text)) return false;

    return startSupportSession(id, {
      reason: "demande_support",
      message: safeText(text, 1000),
    });
  }

  async function handleSupportIncomingMessage(from, msg = {}) {
    const id = normalizeWaId(from);
    if (!id) return false;

    const replyId =
      msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || "";

    if (isSupportInteractiveReply(replyId)) {
      return startSupportSession(id, {
        reason: "bouton_support",
        message: "Support & assistance",
      });
    }

    let open = null;
    try {
      open = await supportRepo.getOpenSupportSession(id);
    } catch (err) {
      logger?.warn?.("[KADI/SUPPORT] open session lookup failed", err?.message || err);
      return false;
    }
    if (!open?.id) return false;

    const message =
      msg?.type === "text" ? safeText(msg?.text?.body, 1000) : buildMessageLabelFromMsg(msg);

    await supportRepo.updateOpenSupportSessionMessage(id, message);
    await notifyAgents({
      waId: id,
      reason: open.reason || "support",
      message,
      isNew: false,
    });

    return true;
  }

  async function listOpenSessionsText() {
    const rows = await supportRepo.listOpenSupportSessions(50);
    if (!rows.length) return "✅ Aucune demande support ouverte.";

    return (
      "🆘 Demandes support ouvertes\n\n" +
      rows
        .map((row, idx) => {
          const msg = safeText(row.last_user_message, 80) || "-";
          const opened = safeText(row.opened_at || row.created_at, 19) || "-";
          return `${idx + 1}. +${row.wa_id} • ${opened}\n${msg}`;
        })
        .join("\n\n")
    );
  }

  async function statusText(waId) {
    const id = normalizeWaId(waId);
    if (!id) return "❌ Numéro invalide.";

    const row = await supportRepo.getSupportSessionStatus(id);
    if (!row?.id) return `ℹ️ Aucune session support trouvée pour +${id}.`;

    const lines = [
      `🆘 Support +${id}`,
      `Statut : ${row.status || "-"}`,
      `Raison : ${row.reason || "-"}`,
      `Dernier message : ${row.last_user_message || "-"}`,
      `Ouverte : ${row.opened_at || row.created_at || "-"}`,
    ];

    if (row.closed_at) lines.push(`Fermée : ${row.closed_at}`);
    if (row.closed_by) lines.push(`Fermée par : ${row.closed_by}`);
    return lines.join("\n");
  }

  async function agentsText() {
    const rows = await listAgentsForAlert();
    if (!rows.length) return "⚠️ Aucun agent support actif.";

    return (
      "👥 Agents support actifs\n\n" +
      rows
        .map(
          (agent, idx) =>
            `${idx + 1}. +${agent.wa_id} • ${agent.name || "-"} • ${
              agent.role || "support"
            }`
        )
        .join("\n")
    );
  }

  async function replyToClient({ agentWaId, clientWaId, message }) {
    const client = normalizeWaId(clientWaId);
    const cleanMessage = safeText(message, 4000);
    if (!client) return { ok: false, error: "Numéro client invalide." };
    if (!cleanMessage) return { ok: false, error: "Message vide." };

    const open = await supportRepo.getOpenSupportSession(client);
    if (!open?.id) return { ok: false, error: "Aucune session support ouverte pour ce client." };

    await sendText(client, cleanMessage);
    return { ok: true, clientWaId: client, agentWaId };
  }

  async function closeSession({ agentWaId, clientWaId }) {
    const client = normalizeWaId(clientWaId);
    if (!client) return { ok: false, error: "Numéro client invalide." };

    const closed = await supportRepo.closeSupportSession(client, agentWaId);
    if (!closed?.id) return { ok: false, error: "Aucune session support ouverte pour ce client." };

    await sendText(
      client,
      "✅ La session support est fermée. Kadi reprend automatiquement.\n\nTapez MENU pour continuer."
    );

    return { ok: true, clientWaId: client };
  }

  async function addAgent({ waId, name }) {
    const id = normalizeWaId(waId);
    return supportRepo.addSupportAgent({
      waId: id,
      name,
      role: id === getPrincipalAgent().wa_id ? "admin" : "support",
      priority: id === getPrincipalAgent().wa_id ? 0 : 100,
    });
  }

  async function disableAgent(waId) {
    return supportRepo.disableSupportAgent(normalizeWaId(waId));
  }

  return {
    getSupportPrincipalWaId: () => getPrincipalAgent().wa_id,
    looksLikeSupportIntent,
    isSupportInteractiveReply,
    supportOpeningMessage,
    handleSupportText,
    handleSupportIncomingMessage,
    startSupportSession,
    listOpenSessionsText,
    statusText,
    agentsText,
    replyToClient,
    closeSession,
    addAgent,
    disableAgent,
  };
}

module.exports = {
  DEFAULT_SUPPORT_ADMIN_WA_ID,
  getSupportPrincipalWaId,
  looksLikeSupportIntent,
  isSupportInteractiveReply,
  supportOpeningMessage,
  makeKadiSupportService,
};
