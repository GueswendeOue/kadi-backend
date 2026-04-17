"use strict";

require("dotenv").config();

const { supabase } = require("../supabaseClient");
const { getBalance, consumeCredit } = require("../kadiCreditsRepo");

const TARGET_TABLE = "kadi_beta_credit_cleanup_targets";
const DEFAULT_TARGET_BALANCE = Number(process.env.BETA_CLEANUP_TARGET_BALANCE || 10);
const DEFAULT_BATCH_SIZE = Number(process.env.BETA_CLEANUP_BATCH_SIZE || 100);
const EXECUTION_START_HOUR_UTC = Number(
  process.env.BETA_CLEANUP_START_HOUR_UTC || 8
);
const EXECUTION_END_HOUR_UTC = Number(
  process.env.BETA_CLEANUP_END_HOUR_UTC || 19
);

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function safeText(v, def = "") {
  const s = String(v ?? "").trim();
  return s || def;
}

function isReasonableExecutionHour(date = new Date()) {
  const h = date.getUTCHours();
  return h >= EXECUTION_START_HOUR_UTC && h <= EXECUTION_END_HOUR_UTC;
}

async function fetchPendingRows(batchKey = null, limit = DEFAULT_BATCH_SIZE) {
  let q = supabase
    .from(TARGET_TABLE)
    .select("*")
    .eq("execution_status", "pending")
    .lte("execute_after", new Date().toISOString())
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
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from(TARGET_TABLE)
    .update({
      execution_status: "processing",
      execution_note: "processing_started",
      executed_at: now,
      last_error: null,
    })
    .eq("id", id)
    .eq("execution_status", "pending")
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return !!data?.id;
}

async function processRow(row) {
  const rowId = row?.id;
  const waId = safeText(row?.wa_id);
  const batchKey = safeText(row?.batch_key);
  const segment = safeText(row?.segment, "unknown");
  const targetBalance = toInt(row?.target_balance, DEFAULT_TARGET_BALANCE);
  const snapshotCreditsToRemove = toInt(row?.snapshot_credits_to_remove, 0);

  if (!rowId) {
    return { ok: false, reason: "missing_row_id" };
  }

  const claimed = await claimRow(rowId);
  if (!claimed) {
    return { ok: false, skipped: true, reason: "already_claimed" };
  }

  if (!waId) {
    await markRow(rowId, {
      execution_status: "failed",
      execution_note: "missing_wa_id",
      last_error: "missing_wa_id",
      executed_at: new Date().toISOString(),
    });
    return { ok: false, reason: "missing_wa_id" };
  }

  if (snapshotCreditsToRemove <= 0) {
    await markRow(rowId, {
      execution_status: "skipped",
      execution_note: "nothing_to_remove_from_snapshot",
      processed_balance_before: null,
      processed_balance_after: null,
      consumed_amount: 0,
      last_error: null,
      executed_at: new Date().toISOString(),
    });

    return {
      ok: true,
      skipped: true,
      reason: "nothing_to_remove_from_snapshot",
    };
  }

  const balRes = await getBalance(waId);
  const currentBalance = toInt(balRes?.balance, 0);
  const currentExcess = Math.max(currentBalance - targetBalance, 0);

  // On ne retire jamais :
  // 1) plus que le trop-perçu figé au snapshot
  // 2) plus que l’excès actuel au-dessus du seuil
  const amountToRemove = Math.min(snapshotCreditsToRemove, currentExcess);

  if (amountToRemove <= 0) {
    await markRow(rowId, {
      execution_status: "skipped",
      execution_note: "current_balance_already_at_or_below_safe_threshold",
      processed_balance_before: currentBalance,
      processed_balance_after: currentBalance,
      consumed_amount: 0,
      last_error: null,
      executed_at: new Date().toISOString(),
    });

    return {
      ok: true,
      skipped: true,
      reason: "already_safe",
      currentBalance,
    };
  }

  const opKey = `beta_cleanup:${batchKey}:${waId}`;

  const consumeRes = await consumeCredit(
    waId,
    amountToRemove,
    "beta_cleanup_to_10",
    opKey,
    {
      batchKey,
      cleanupType: segment,
      targetBalance,
      snapshotCreditsToRemove,
      currentBalanceBefore: currentBalance,
    }
  );

  const balanceAfter = toInt(
    consumeRes?.balance,
    Math.max(currentBalance - amountToRemove, 0)
  );

  await markRow(rowId, {
    execution_status: "executed",
    execution_note: "cleanup_applied",
    processed_balance_before: currentBalance,
    processed_balance_after: balanceAfter,
    consumed_amount: amountToRemove,
    last_error: null,
    executed_at: new Date().toISOString(),
  });

  return {
    ok: true,
    executed: true,
    waId,
    amountToRemove,
    currentBalance,
    balanceAfter,
  };
}

async function main() {
  const now = new Date();
  const batchKey = safeText(process.env.BETA_CLEANUP_BATCH_KEY, "");
  const limit = DEFAULT_BATCH_SIZE;

  if (!isReasonableExecutionHour(now)) {
    console.log("[BETA_CLEANUP] skipped: outside allowed UTC hours", {
      now: now.toISOString(),
      startHourUtc: EXECUTION_START_HOUR_UTC,
      endHourUtc: EXECUTION_END_HOUR_UTC,
    });
    return;
  }

  console.log("[BETA_CLEANUP] start", {
    batchKey: batchKey || "(all due batches)",
    limit,
    targetBalance: DEFAULT_TARGET_BALANCE,
    now: now.toISOString(),
  });

  const rows = await fetchPendingRows(batchKey || null, limit);

  if (!rows.length) {
    console.log("[BETA_CLEANUP] no pending rows");
    return;
  }

  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let removedTotal = 0;

  for (const row of rows) {
    try {
      const res = await processRow(row);

      if (res?.executed) {
        executed += 1;
        removedTotal += toInt(res.amountToRemove, 0);
      } else if (res?.skipped) {
        skipped += 1;
      } else if (!res?.ok) {
        failed += 1;
      }
    } catch (error) {
      failed += 1;

      console.error("[BETA_CLEANUP] row failed", {
        id: row?.id,
        waId: row?.wa_id,
        error: error?.message || error,
      });

      try {
        await markRow(row.id, {
          execution_status: "failed",
          execution_note: "runtime_error",
          last_error: safeText(error?.message || error, "unknown_error"),
          executed_at: new Date().toISOString(),
        });
      } catch (markErr) {
        console.error("[BETA_CLEANUP] failed to mark row error", {
          id: row?.id,
          error: markErr?.message || markErr,
        });
      }
    }
  }

  console.log("[BETA_CLEANUP] done", {
    fetched: rows.length,
    executed,
    skipped,
    failed,
    removedTotal,
  });
}

main().catch((error) => {
  console.error("[BETA_CLEANUP] fatal", error?.message || error);
  process.exit(1);
});