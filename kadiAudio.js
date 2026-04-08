"use strict";

const OpenAI = require("openai");
const { buildIntent } = require("./kadiIntentEngine");
const { buildIntentMessage, getNextQuestion } = require("./kadiIntentUx");
const { normalizeBusinessInput } = require("./kadiLanguageNormalizer");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1";

if (!WHATSAPP_TOKEN) {
  throw new Error("WHATSAPP_TOKEN manquant");
}

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY manquant");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// ======================================================
// TEXT HELPERS
// ======================================================
function normalizeTranscript(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function prepareTranscriptVariants(text = "", options = {}) {
  const rawTranscriptText = String(text || "").trim();
  const normalizedTranscriptText = normalizeTranscript(rawTranscriptText);

  const normalized = normalizeBusinessInput(normalizedTranscriptText, {
    localeHint: options.localeHint || "fr-BF",
    languages: options.languages || ["fr", "moore"],
  });

  return {
    rawTranscriptText,
    displayText: normalized.displayText,
    parseText: normalized.parseText,
    localeHint: normalized.localeHint,
    detectedLanguages: normalized.detectedLanguages,
  };
}

function looksUsableIntent(intent) {
  if (!intent || typeof intent !== "object") return false;

  const hasClient = !!intent.client;
  const hasItems =
    Array.isArray(intent.items) && intent.items.some((i) => i?.label);

  return hasClient || hasItems;
}

function guessAudioFilename(mimeType = "") {
  const t = String(mimeType || "").toLowerCase();

  if (t.includes("ogg")) return "audio.ogg";
  if (t.includes("mpeg") || t.includes("mp3")) return "audio.mp3";
  if (t.includes("wav")) return "audio.wav";
  if (t.includes("webm")) return "audio.webm";
  if (t.includes("mp4") || t.includes("m4a")) return "audio.m4a";

  return "audio.ogg";
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ======================================================
// WHATSAPP MEDIA
// ======================================================
async function getWhatsAppMediaUrl(mediaId) {
  if (!mediaId) throw new Error("mediaId manquant");

  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${encodeURIComponent(
    mediaId
  )}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  });

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(
      `WhatsApp media URL lookup failed (${res.status}): ${body || res.statusText}`
    );
  }

  const data = await res.json();

  if (!data?.url) {
    throw new Error("URL média WhatsApp introuvable");
  }

  return {
    url: data.url,
    mimeType: data.mime_type || null,
  };
}

async function downloadWhatsAppMedia(url) {
  if (!url) throw new Error("url média manquante");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  });

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(
      `WhatsApp media download failed (${res.status}): ${body || res.statusText}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return {
    buffer,
    mimeType: res.headers.get("content-type") || "audio/ogg",
  };
}

// ======================================================
// TRANSCRIPTION
// ======================================================
async function transcribeAudioBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("buffer audio invalide");
  }

  const mimeType = options.mimeType || "audio/ogg";
  const filename = options.filename || guessAudioFilename(mimeType);
  const file = new File([buffer], filename, { type: mimeType });

  const result = await openai.audio.transcriptions.create({
    file,
    model: OPENAI_TRANSCRIPTION_MODEL,
    language: options.language || "fr",
    prompt:
      options.prompt ||
      [
        "Transcrire le message vocal WhatsApp le plus fidèlement possible.",
        "Conserver les mots exacts, les noms, les montants, les produits et les quantités.",
        "Ne pas reformuler. Ne pas inventer. Ne pas résumer.",
        "Le message peut contenir du français avec quelques mots en mooré.",
      ].join(" "),
    temperature: 0,
  });

  const variants = prepareTranscriptVariants(result?.text || "", {
    localeHint: options.localeHint || "fr-BF",
    languages: options.languages || ["fr", "moore"],
  });

  return {
    text: variants.rawTranscriptText,
    displayText: variants.displayText,
    parseText: variants.parseText,
    localeHint: variants.localeHint,
    detectedLanguages: variants.detectedLanguages,
    raw: result,
  };
}

// ======================================================
// MAIN AUDIO HANDLER
// ======================================================
async function handleIncomingAudioMessage(msg, value, deps) {
  const { sendText, sendButtons, getSession } = deps || {};

  if (msg?.type !== "audio") return false;

  if (typeof sendText !== "function") {
    throw new Error("sendText manquant dans deps");
  }

  if (typeof sendButtons !== "function") {
    throw new Error("sendButtons manquant dans deps");
  }

  if (typeof getSession !== "function") {
    throw new Error("getSession manquant dans deps");
  }

  const from = msg?.from;
  const mediaId = msg?.audio?.id;

  if (!from || !mediaId) {
    if (from) {
      await sendText(
        from,
        "⚠️ Je n’ai pas pu lire ce vocal.\nRenvoyez-le ou écrivez votre demande."
      );
    }
    return true;
  }

  await sendText(from, "🎤 Analyse du vocal en cours...");

  try {
    const mediaMeta = await getWhatsAppMediaUrl(mediaId);
    const media = await downloadWhatsAppMedia(mediaMeta.url);

    const transcript = await transcribeAudioBuffer(media.buffer, {
      mimeType: media.mimeType || mediaMeta.mimeType || "audio/ogg",
      language: "fr",
    });

    const rawTranscriptText = String(transcript?.text || "").trim();
    const normalizedTranscriptText = normalizeTranscript(rawTranscriptText);
    const businessText = normalizeMooreBusinessText(normalizedTranscriptText);

    console.log("[KADI/AUDIO] raw transcript:", rawTranscriptText);
    console.log("[KADI/AUDIO] normalized transcript:", normalizedTranscriptText);
    console.log("[KADI/AUDIO] business transcript:", businessText);

    if (!rawTranscriptText) {
      await sendText(
        from,
        "🎤 Je n’ai pas bien compris le vocal.\n\nExemple :\n“Fais un devis pour 2 sacs de ciment à 5000 pour Adama.”"
      );
      return true;
    }

    const intent = buildIntent(businessText);

    console.log("[KADI/AUDIO] built intent:", intent);

    const s = getSession(from);
    s.audioTranscriptRaw = rawTranscriptText;
    s.audioTranscriptNormalized = normalizedTranscriptText;
    s.audioTranscriptBusiness = businessText;
    s.intent = intent;
    s.intentRawText = businessText;
    s.intentPendingItemLabel = null;
    s.step = "intent_review";

    if (Array.isArray(intent?.missing) && intent.missing.length > 0) {
      if (intent.missing.includes("client")) {
        s.step = "intent_fix_client";
      } else if (intent.missing.includes("price")) {
        s.step = "intent_fix_price";

        const missingItem = Array.isArray(intent.items)
          ? intent.items.find((i) => i?.unitPrice == null)
          : null;

        s.intentPendingItemLabel = missingItem?.label || null;
      } else if (intent.missing.includes("items")) {
        s.step = "intent_fix_items";
      }
    }

    console.log("[KADI/AUDIO] session step after intent build:", {
      from,
      step: s.step,
      intentPendingItemLabel: s.intentPendingItemLabel || null,
      missing: intent?.missing || [],
    });

    if (!looksUsableIntent(intent)) {
      s.intent = null;
      s.intentRawText = null;
      s.intentPendingItemLabel = null;
      s.step = null;

      await sendText(
        from,
        `🎤 J’ai transcrit :\n"${rawTranscriptText}"\n\n` +
          `Je n’ai pas encore assez d’informations pour préparer le document.\n\n` +
          `Exemple :\n"Devis pour Moussa, 2 portes à 25000"`
      );
      return true;
    }

    const msgText = buildIntentMessage(intent);
    const buttons = [{ id: "INTENT_FIX", title: "✏️ Corriger" }];

    if (!Array.isArray(intent?.missing) || intent.missing.length === 0) {
      buttons.unshift({ id: "INTENT_OK", title: "✅ Valider" });
    }

    await sendButtons(from, msgText, buttons);

    const nextQuestion = getNextQuestion(intent);
    if (nextQuestion) {
      await sendText(from, nextQuestion);
    }

    return true;
  } catch (error) {
    console.error("[KADI/AUDIO] error:", error);

    await sendText(
      from,
      "⚠️ Je n’ai pas pu traiter votre vocal.\nVous pouvez renvoyer le vocal ou écrire le message directement."
    );
    return true;
  }
}

module.exports = {
  normalizeTranscript,
  prepareTranscriptVariants,
  getWhatsAppMediaUrl,
  downloadWhatsAppMedia,
  transcribeAudioBuffer,
  handleIncomingAudioMessage,
};