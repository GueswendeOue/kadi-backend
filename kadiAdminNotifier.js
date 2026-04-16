"use strict";

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function formatIsoShort(iso) {
  const raw = safeText(iso, "");
  if (!raw) return "-";

  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toISOString();
  } catch (_) {
    return raw;
  }
}

async function notifyAdminReengagement({
  sendText,
  adminWaId,
  type,
  stats = {},
  meta = {},
  details = null, // compat ancien code
}) {
  if (typeof sendText !== "function") return false;

  const to = String(adminWaId || "").trim();
  if (!to) return false;

  const targeted = toNum(stats.targeted, 0);
  const sent = toNum(stats.sent, 0);
  const template = toNum(stats.template, 0);
  const blocked = toNum(stats.blocked, 0);
  const failed = toNum(stats.failed, 0);

  const uniqueTouched = toNum(meta.uniqueTouched, 0);
  const excludedThisSegment = toNum(meta.excludedThisSegment, 0);
  const alreadyTargetedInCycle = toNum(meta.alreadyTargetedInCycle, 0);
  const cooldownDays = toNum(meta.cooldownDays, 0);
  const cycleKey = safeText(meta.cycleKey, "");
  const timestamp = formatIsoShort(meta.timestamp || new Date().toISOString());

  const lines = [
    "📊 *KADI AUTO RE-ENGAGEMENT*",
    "",
    `Type : ${safeText(type, "-")}`,
    `Ciblés : ${targeted}`,
    `Envoyés : ${sent}`,
    `Templates : ${template}`,
    `Bloqués (24h) : ${blocked}`,
    `Échecs : ${failed}`,
  ];

  if (uniqueTouched > 0) {
    lines.push(`Uniques touchés (cycle) : ${uniqueTouched}`);
  }

  if (cooldownDays > 0) {
    lines.push(`Cooldown : ${cooldownDays} jour(s)`);
  }

  if (excludedThisSegment > 0) {
    lines.push(`Exclus segment : ${excludedThisSegment}`);
  }

  if (alreadyTargetedInCycle > 0) {
    lines.push(`Déjà ciblés (cycle) : ${alreadyTargetedInCycle}`);
  }

  if (cycleKey) {
    lines.push(`Cycle : ${cycleKey}`);
  }

  if (details) {
    lines.push("", String(details));
  }

  lines.push("", `⏱ ${timestamp}`);

  try {
    await sendText(to, lines.join("\n"));
    return true;
  } catch (error) {
    console.error("[KADI/ADMIN/REENGAGEMENT]", error?.message || error);
    return false;
  }
}

async function notifyAdminReengagementCycleSummary({
  sendText,
  adminWaId,
  cycleKey,
  cooldownDays = 0,
  zeroStats = {},
  inactiveStats = {},
  targetedUnique = 0,
}) {
  if (typeof sendText !== "function") return false;

  const to = String(adminWaId || "").trim();
  if (!to) return false;

  const totalTargeted =
    toNum(zeroStats.targeted, 0) + toNum(inactiveStats.targeted, 0);

  const totalSent =
    toNum(zeroStats.sent, 0) + toNum(inactiveStats.sent, 0);

  const totalTemplate =
    toNum(zeroStats.template, 0) + toNum(inactiveStats.template, 0);

  const totalBlocked =
    toNum(zeroStats.blocked, 0) + toNum(inactiveStats.blocked, 0);

  const totalFailed =
    toNum(zeroStats.failed, 0) + toNum(inactiveStats.failed, 0);

  const msg =
    `📦 *KADI RE-ENGAGEMENT — RÉSUMÉ CYCLE*\n\n` +
    `Cycle : ${safeText(cycleKey, "-")}\n` +
    `Cooldown : ${toNum(cooldownDays, 0)} jour(s)\n` +
    `Uniques touchés : ${toNum(targetedUnique, 0)}\n\n` +
    `🔹 Zero docs\n` +
    `• Ciblés : ${toNum(zeroStats.targeted, 0)}\n` +
    `• Envoyés : ${toNum(zeroStats.sent, 0)}\n` +
    `• Templates : ${toNum(zeroStats.template, 0)}\n` +
    `• Bloqués : ${toNum(zeroStats.blocked, 0)}\n` +
    `• Échecs : ${toNum(zeroStats.failed, 0)}\n\n` +
    `🔹 Inactifs\n` +
    `• Ciblés : ${toNum(inactiveStats.targeted, 0)}\n` +
    `• Envoyés : ${toNum(inactiveStats.sent, 0)}\n` +
    `• Templates : ${toNum(inactiveStats.template, 0)}\n` +
    `• Bloqués : ${toNum(inactiveStats.blocked, 0)}\n` +
    `• Échecs : ${toNum(inactiveStats.failed, 0)}\n\n` +
    `🔸 Global\n` +
    `• Total ciblés : ${totalTargeted}\n` +
    `• Total envoyés : ${totalSent}\n` +
    `• Total templates : ${totalTemplate}\n` +
    `• Total bloqués : ${totalBlocked}\n` +
    `• Total échecs : ${totalFailed}\n\n` +
    `⏱ ${new Date().toISOString()}`;

  try {
    await sendText(to, msg);
    return true;
  } catch (error) {
    console.error("[KADI/ADMIN/REENGAGEMENT/SUMMARY]", error?.message || error);
    return false;
  }
}

module.exports = {
  notifyAdminReengagement,
  notifyAdminReengagementCycleSummary,
};