"use strict";

require("dotenv").config();

const { supabase } = require("../supabaseClient");
const { sendTemplate } = require("../whatsappApi");

const TARGET_TABLE = "kadi_beta_credit_cleanup_targets";
const DEFAULT_BATCH_SIZE = Number(process.env.BETA_NOTIFY_BATCH_SIZE || 100);
const EXECUTION_START_HOUR_UTC = Number(
  process.env.BETA_NOTIFY_START_HOUR_UTC || 8
);
const EXECUTION_END_HOUR_UTC = Number(
  process.env.BETA_NOTIFY_END_HOUR_UTC || 19
);

const TEMPLATE_NAME =
  process.env.BETA_CLEANUP_NOTICE_TEMPLATE || "kadi_beta_cleanup_notice_v1";
const TEMPLATE_LANGUAGE =
  process.env.BETA_CLEANUP_NOTICE_LANGUAGE || "fr";

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isReasonableExecutionHour(date = new Date()) {
  const h = date.getUTCHours();
  return h >= EXECUTION_START_HOUR_UTC && h <= EXECUTION_END_HOUR_UTC;
}

async function fetchPendingRows(batchKey = null, limit = DEFAULT_BATCH_SIZE) {
  let q = supabase
    .from(TARGET_TABLE)
    .select("*")
    .in("notification_status", ["pending", "failed"])
    .order("id", { ascending: true })
    .limit(limit);

  if (batchKey) {
    q = q.eq("batch_key", batchKey);
  }

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function markRow(id, patch = {}) {
  const { error } = await supabase
    .from(TARGET_TABLE)
    .update(patch)
    .eq("id", id);

  if (error) throw error;
}

async function claimRow(id) {
  const { data, error } = await supabase
    .from(TARGET_TABLE)
    .update({
      notification_status: "processing",
      notification_last_error: null,
    })
    .eq("id", id)
    .in("notification_status", ["pending", "failed"])
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data?.id;
}

async function processRow(row) {
  const rowId = row?.id;
  const waId = safeText(row?.wa_id);
  const ownerName = safeText(row?.owner_name, "Client");

  if (!rowId) {
    return { ok: false, reason: "missing_row_id" };
  }

  const claimed = await claimRow(rowId);
  if (!claimed) {
    return { ok: false, skipped: true, reason: "already_claimed" };
  }

  if (!waId) {
    await markRow(rowId, {
      notification_status: "failed",
      notification_last_error: "missing_wa_id",
      notification_attempts: toInt(row?.notification_attempts, 0) + 1,
    });
    return { ok: false, reason: "missing_wa_id" };
  }

  await sendTemplate({
    to: waId,
    name: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    components: [
      {
        type: "body",
        parameters: [
          {
            type: "text",
            text: ownerName,
          },
        ],
      },
    ],
  });

  const now = new Date().toISOString();

  await markRow(rowId, {
    notification_status: "sent",
    notification_sent_at: now,
    notified_at: now,
    notification_last_error: null,
    notification_attempts: toInt(row?.notification_attempts, 0) + 1,
  });

  return {
    ok: true,
    sent: true,
    waId,
  };
}

async function main() {
  const now = new Date();
  const batchKey = safeText(process.env.BETA_CLEANUP_BATCH_KEY, "");
  const limit = DEFAULT_BATCH_SIZE;

  if (!isReasonableExecutionHour(now)) {
    console.log("[BETA_NOTIFY] skipped: outside allowed UTC hours", {
      now: now.toISOString(),
      startHourUtc: EXECUTION_START_HOUR_UTC,
      endHourUtc: EXECUTION_END_HOUR_UTC,
    });
    return;
  }

  console.log("[BETA_NOTIFY] start", {
    batchKey: batchKey || "(all pending rows)",
    limit,
    templateName: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    now: now.toISOString(),
  });

  const rows = await fetchPendingRows(batchKey || null, limit);

  if (!rows.length) {
    console.log("[BETA_NOTIFY] no pending rows");
    return;
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const res = await processRow(row);

      if (res?.sent) {
        sent += 1;
      } else if (res?.skipped) {
        skipped += 1;
      } else if (!res?.ok) {
        failed += 1;
      }
    } catch (error) {
      failed += 1;

      console.error("[BETA_NOTIFY] row failed", {
        id: row?.id,
        waId: row?.wa_id,
        error: error?.message || error,
      });

      try {
        await markRow(row.id, {
          notification_status: "failed",
          notification_last_error: safeText(
            error?.message || error,
            "unknown_error"
          ),
          notification_attempts: toInt(row?.notification_attempts, 0) + 1,
        });
      } catch (markErr) {
        console.error("[BETA_NOTIFY] failed to mark row error", {
          id: row?.id,
          error: markErr?.message || markErr,
        });
      }
    }
  }

  console.log("[BETA_NOTIFY] done", {
    fetched: rows.length,
    sent,
    skipped,
    failed,
  });
}

main().catch((error) => {
  console.error("[BETA_NOTIFY] fatal", error?.message || error);
  process.exit(1);
});