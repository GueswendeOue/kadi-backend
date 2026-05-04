"use strict";

process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "test-token";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  handleIncomingAudioMessage,
  isInvalidTranscriptForBusiness,
} = require("../kadiAudio");

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

test("audio rejects internal transcription instructions before routing", async () => {
  const routedTexts = [];
  const { calls, session, deps } = makeBaseDeps({
    transcribeForKadiVoice: async () => ({
      text: "ne pas reformuler. ne pas résumer.",
      normalizedText: "ne pas reformuler. ne pas résumer.",
      displayText: "ne pas reformuler. ne pas résumer.",
      parseText: "ne pas reformuler. ne pas résumer.",
      detectedLanguages: ["fr"],
    }),
    handleTranscribedText: async (_from, text) => {
      routedTexts.push(text);
      return false;
    },
  });

  const handled = await handleIncomingAudioMessage(makeAudioMsg(), {}, deps);

  assert.equal(handled, true);
  assert.deepEqual(routedTexts, []);
  assert.equal(calls.filter((call) => call.kind === "buttons").length, 0);
  assert.equal(session.intent, null);
  assert.equal(session.intentRawText, null);
  assert.match(
    calls.at(-1)?.text || "",
    /Je n’ai pas bien compris le vocal\. Réessayez avec le client/
  );
});

test("audio rejects empty transcript cleanly", async () => {
  const { calls, session, deps } = makeBaseDeps({
    transcribeForKadiVoice: async () => ({
      text: "",
      normalizedText: "",
      displayText: "",
      parseText: "",
      detectedLanguages: [],
    }),
  });

  const handled = await handleIncomingAudioMessage(makeAudioMsg(), {}, deps);

  assert.equal(handled, true);
  assert.equal(calls.filter((call) => call.kind === "buttons").length, 0);
  assert.equal(session.intent, null);
  assert.match(
    calls.at(-1)?.text || "",
    /Je n’ai pas bien compris le vocal\. Réessayez avec le client/
  );
});

test("business transcript validation accepts real document requests", () => {
  assert.equal(
    isInvalidTranscriptForBusiness("devis pour Moussa 2 portes à 25000"),
    false
  );
  assert.equal(
    isInvalidTranscriptForBusiness("facture pour Awa réparation téléphone 15000"),
    false
  );
  assert.equal(
    isInvalidTranscriptForBusiness("reçu pour Ibrahim 20000 réparation moto"),
    false
  );
  assert.equal(
    isInvalidTranscriptForBusiness("décharge pour Ali 35000 avance travaux"),
    false
  );
});

test("audio fallback never creates an item from internal transcription instructions", async () => {
  const { calls, session, deps } = makeBaseDeps({
    transcribeForKadiVoice: async () => ({
      text: "ne pas reformuler. ne pas résumer.",
      normalizedText: "ne pas reformuler. ne pas résumer.",
      displayText: "ne pas reformuler. ne pas résumer.",
      parseText: "ne pas reformuler. ne pas résumer.",
      detectedLanguages: ["fr"],
    }),
    handleTranscribedText: async () => false,
  });

  const handled = await handleIncomingAudioMessage(makeAudioMsg(), {}, deps);

  assert.equal(handled, true);
  assert.equal(calls.filter((call) => call.kind === "buttons").length, 0);
  assert.equal(session.intent, null);
  assert.equal(
    session.intent?.items?.some((item) =>
      String(item?.label || "").toLowerCase().includes("ne pas reformuler")
    ),
    undefined
  );
});
