"use strict";

const OpenAI = require("openai");
const { buildIntent } = require("./kadiIntentEngine");
const { buildIntentMessage, getNextQuestion } = require("./kadiIntentUx");
const { normalizeMooreBusinessText } = require("./kadiMooreNormalizer");
console.log("[KADI/AUDIO] raw transcript:", transcript.text);
console.log("[KADI/AUDIO] normalized transcript:", text);

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

function normalizeTranscript(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

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
      "Transcrire clairement un message vocal WhatsApp en français pour création de devis, facture, reçu ou décharge. Conserver noms, montants, produits et quantités. Ne pas inventer.",
  });

  return {
    text: normalizeTranscript(result?.text || ""),
    raw: result,
  };
}

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
        "❌ Message vocal invalide. Essayez de renvoyer le vocal ou d’écrire votre demande."
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

    const text = normalizeMooreBusinessText(
  normalizeTranscript(transcript.text)
);

    if (!text) {
      await sendText(
        from,
        "🎤 Je n’ai pas bien compris le vocal.\n\nExemple :\n“Fais un devis pour 2 sacs de ciment à 5000 pour Adama.”"
      );
      return true;
    }

    const s = getSession(from);
    const intent = buildIntent(text);

    s.intent = intent;
    s.intentRawText = text;
    s.step = "intent_review";

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
      "❌ Je n’ai pas pu traiter votre vocal.\n\nVous pouvez envoyer le même message en texte."
    );
    return true;
  }
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

module.exports = {
  normalizeTranscript,
  getWhatsAppMediaUrl,
  downloadWhatsAppMedia,
  transcribeAudioBuffer,
  handleIncomingAudioMessage,
};