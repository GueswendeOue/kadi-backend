"use strict";

const supabaseModule = require("./supabaseClient");
const supabase = supabaseModule.supabase || supabaseModule;

async function logLearningEvent({
  waId,
  rawText,

  // qualité parsing
  parseSuccess = false,
  failureReason = null,
  itemsCount = 0,

  // 🧠 NOUVEAU
  normalizedText = null,
  intent = null,
  confidence = null,

  // 📍 CONTEXTE
  step = null,
  source = "text", // text | audio | ocr

  // 🔍 TYPE D’ERREUR
  type = "unknown", // fallback | voice_misunderstood | price_parse_fail | etc

  meta = {},
}) {
  try {
    await supabase.from("kadi_message_learning_logs").insert([
      {
        wa_id: waId,
        raw_text: String(rawText || "").slice(0, 3000),

        parse_success: !!parseSuccess,
        failure_reason: failureReason,
        items_count: Number(itemsCount || 0),

        // 🔥 NEW
        normalized_text: normalizedText,
        intent_json: intent || null,
        confidence: confidence != null ? Number(confidence) : null,

        step,
        source,
        type,

        meta: meta || {},
      },
    ]);
  } catch (err) {
    console.error("[KADI LEARNING ERROR]", err?.message || err);
  }
}

module.exports = {
  logLearningEvent,
};