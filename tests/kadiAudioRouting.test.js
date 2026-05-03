"use strict";

process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "test-token";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const { handleIncomingAudioMessage } = require("../kadiAudio");

function makeAudioMsg() {
  return {
    type: "audio",
    from: "22670000000",
    audio: { id: "media-1" },
  };
}

function makeBaseDeps(overrides = {}) {
  const calls = [];
  const session = {};

  return {
    calls,
    session,
    deps: {
      sendText: async (to, text) => calls.push({ kind: "text", to, text }),
      sendButtons: async (to, text, buttons) =>
        calls.push({ kind: "buttons", to, text, buttons }),
      getSession: () => session,
      getWhatsAppMediaUrl: async () => ({
        url: "https://example.test/audio.ogg",
        mimeType: "audio/ogg",
        fileSize: 123,
      }),
      downloadWhatsAppMedia: async () => ({
        buffer: Buffer.from("audio"),
        mimeType: "audio/ogg",
      }),
      transcribeForKadiVoice: async () => ({
        text: "Devis pour Moussa, 2 portes à 25000",
        normalizedText: "Devis pour Moussa, 2 portes à 25000",
        displayText: "Devis pour Moussa, 2 portes à 25000",
        parseText: "devis pour moussa, 2 portes a 25000",
        detectedLanguages: ["fr"],
      }),
      ...overrides,
    },
  };
}

test("audio routes transcribed text to natural text handler and skips intent fallback when handled", async () => {
  const handledTexts = [];
  const { calls, session, deps } = makeBaseDeps({
    handleTranscribedText: async (from, text, textMsg) => {
      handledTexts.push({ from, text, type: textMsg.type });
      return true;
    },
  });

  const handled = await handleIncomingAudioMessage(makeAudioMsg(), {}, deps);

  assert.equal(handled, true);
  assert.deepEqual(handledTexts, [
    {
      from: "22670000000",
      text: "devis pour moussa, 2 portes a 25000",
      type: "text",
    },
  ]);
  assert.equal(calls.filter((call) => call.kind === "buttons").length, 0);
  assert.equal(session.intent, undefined);
});

test("audio keeps legacy intent fallback when transcribed text handler returns false", async () => {
  const { calls, session, deps } = makeBaseDeps({
    handleTranscribedText: async () => false,
  });

  const handled = await handleIncomingAudioMessage(makeAudioMsg(), {}, deps);

  assert.equal(handled, true);
  assert.equal(calls.filter((call) => call.kind === "buttons").length, 1);
  assert.equal(session.intent?.docType, "devis");
  assert.equal(session.intent?.client, "moussa");
  assert.equal(session.step, "intent_review");
});
