// kadiLearningLogger.js
"use strict";

const supabaseModule = require("./supabaseClient");

// 🔥 compatible avec les 2 types d’export
const supabase = supabaseModule.supabase || supabaseModule;

async function logLearningEvent({
  waId,
  rawText,
  parseSuccess = false,
  failureReason = null,
  itemsCount = 0,
}) {
  try {
    await supabase.from("kadi_message_learning_logs").insert([
      {
        wa_id: waId,
        raw_text: String(rawText || "").slice(0, 3000),
        parse_success: !!parseSuccess,
        failure_reason: failureReason,
        items_count: Number(itemsCount || 0),
      },
    ]);
  } catch (err) {
    console.error("[KADI LEARNING ERROR]", err?.message || err);
  }
}

module.exports = {
  logLearningEvent,
};