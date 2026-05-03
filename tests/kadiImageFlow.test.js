"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiImageFlow } = require("../kadiImageFlow");

function makeFlow({ session }) {
  const calls = [];
  let ocrCalls = 0;
  let logoCalls = 0;
  let rechargeCalls = 0;

  const flow = makeKadiImageFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async (to, text, buttons) =>
      calls.push({ kind: "buttons", to, text, buttons }),
    getMediaInfo: async () => ({
      url: "https://example.test/stamp",
      mime_type: "image/jpeg",
      file_size: 1234,
    }),
    downloadMediaToBuffer: async () => Buffer.from("fake-image"),
    LIMITS: { maxImageSize: 5_000_000 },
    guessExtFromMime: () => "jpg",
    handleLogoImage: async () => {
      logoCalls += 1;
      return false;
    },
    saveProfileStampImageFromBuffer: async (payload) => {
      calls.push({ kind: "saveStamp", payload });
      return {
        stamp_enabled: true,
        stamp_image_path: "22670000000/stamp.png",
      };
    },
    sendStampMenu: async (to) => calls.push({ kind: "stampMenu", to }),
    readTopup: async () => null,
    getPendingTopupByWaId: async () => {
      rechargeCalls += 1;
      return null;
    },
    markTopupProofImageReceived: async () => ({}),
    notifyAdminTopupReview: async () => {},
    processOcrImageToDraft: async () => {
      ocrCalls += 1;
      return true;
    },
    uploadCampaignImageBuffer: async () => ({ filePath: "campaign/test.jpg" }),
    getSignedCampaignUrl: async () => "https://example.test/campaign",
    ensureAdmin: () => false,
    resetAdminBroadcastState: () => {},
    kadiBroadcast: {},
  });

  return {
    flow,
    calls,
    getCounts: () => ({ ocrCalls, logoCalls, rechargeCalls }),
  };
}

test("stamp image upload step saves stamp and does not route image to OCR", async () => {
  const session = { step: "stamp_image_upload", profileStep: null };
  const { flow, calls, getCounts } = makeFlow({ session });

  const handled = await flow.handleIncomingImage("22670000000", {
    image: { id: "media-1" },
  });

  assert.equal(handled, true);
  assert.equal(session.step, null);

  const save = calls.find((call) => call.kind === "saveStamp");
  assert.ok(save);
  assert.equal(save.payload.waId, "22670000000");
  assert.equal(Buffer.isBuffer(save.payload.buffer), true);
  assert.equal(save.payload.mimeType, "image/jpeg");

  assert.match(
    calls.find((call) => call.kind === "text")?.text || "",
    /Mon tampon est prêt/
  );
  assert.deepEqual(getCounts(), {
    ocrCalls: 0,
    logoCalls: 0,
    rechargeCalls: 0,
  });
});
