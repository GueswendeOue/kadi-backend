"use strict";

async function notifyAdminReengagement({
  sendText,
  adminWaId,
  type,
  stats,
  details = null,
}) {
  if (typeof sendText !== "function") return false;

  const to = String(adminWaId || "").trim();
  if (!to) return false;

  const s = stats || {};
  const lines = [
    "📊 *KADI AUTO RE-ENGAGEMENT*",
    "",
    `Type : ${type || "-"}`,
    `Ciblés : ${Number(s.targeted || 0)}`,
    `Envoyés : ${Number(s.sent || 0)}`,
    `Templates : ${Number(s.template || 0)}`,
    `Bloqués (24h) : ${Number(s.blocked || 0)}`,
    `Échecs : ${Number(s.failed || 0)}`,
  ];

  if (details) {
    lines.push("", String(details));
  }

  lines.push("", `⏱ ${new Date().toISOString()}`);

  try {
    await sendText(to, lines.join("\n"));
    return true;
  } catch (error) {
    console.error("[KADI/ADMIN/REENGAGEMENT]", error?.message || error);
    return false;
  }
}

module.exports = {
  notifyAdminReengagement,
};