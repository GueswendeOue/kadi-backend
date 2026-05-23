"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const axios = require("axios");
const {
  shouldSendTypingBeforeNaturalText,
  shouldSendTypingForInteractiveReply,
} = require("../kadiTypingPolicy");

function loadWhatsappApiWithEnv() {
  process.env.WHATSAPP_TOKEN = "test-token";
  process.env.PHONE_NUMBER_ID = "123456";
  process.env.WHATSAPP_API_VERSION = "v21.0";

  delete require.cache[require.resolve("../whatsappApi")];
  return require("../whatsappApi");
}

test("sendTypingIndicator sends WhatsApp read and typing payload", async () => {
  const originalPost = axios.post;
  const calls = [];

  axios.post = async (url, payload, options) => {
    calls.push({ url, payload, options });
    return { data: { success: true } };
  };

  try {
    const { sendTypingIndicator } = loadWhatsappApiWithEnv();
    const result = await sendTypingIndicator("wamid.123");

    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://graph.facebook.com/v21.0/123456/messages"
    );
    assert.deepEqual(calls[0].payload, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.123",
      typing_indicator: {
        type: "text",
      },
    });
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  } finally {
    axios.post = originalPost;
  }
});

test("sendTypingIndicator never throws when WhatsApp API fails", async () => {
  const originalPost = axios.post;

  axios.post = async () => {
    const err = new Error("Meta unavailable");
    err.response = {
      status: 500,
      data: { error: { message: "Meta unavailable", code: 2 } },
    };
    throw err;
  };

  try {
    const { sendTypingIndicator } = loadWhatsappApiWithEnv();
    const result = await sendTypingIndicator("wamid.fail");

    assert.equal(result.accepted, false);
    assert.match(result.error, /Meta unavailable/);
  } finally {
    axios.post = originalPost;
  }
});

test("typing policy skips simple commands and accepts long-running flows", () => {
  assert.equal(shouldSendTypingBeforeNaturalText("menu"), false);
  assert.equal(shouldSendTypingBeforeNaturalText("solde"), false);
  assert.equal(
    shouldSendTypingBeforeNaturalText("Devis pour Madi lampe 120 5 1500"),
    true
  );

  assert.equal(shouldSendTypingForInteractiveReply("OCR_DEVIS"), true);
  assert.equal(shouldSendTypingForInteractiveReply("DOC_CONFIRM"), true);
  assert.equal(shouldSendTypingForInteractiveReply("BACK_HOME"), false);
});
