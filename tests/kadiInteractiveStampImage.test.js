"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiInteractiveFlow } = require("../kadiInteractiveFlow");

test("STAMP_UPLOAD_IMAGE puts session in stamp image upload step", async () => {
  const session = { step: "idle", itemDraft: { label: "x" } };
  const calls = [];

  const flow = makeKadiInteractiveFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async () => {},
    money: (value) => String(value),
    sendHomeMenu: async () => {},
    sendDocsMenu: async () => {},
    sendCreditsMenu: async () => {},
    sendProfileMenu: async () => {},
    sendFactureKindMenu: async () => {},
    sendFactureCatalogMenu: async () => {},
    sendPreviewMenu: async () => {},
    sendStampMenu: async () => {},
    sendStampMoreMenu: async () => {},
    sendStampPositionMenu: async () => {},
    sendStampPositionMenu2: async () => {},
    sendStampSizeMenu: async () => {},
    sendAlreadyGeneratedMenu: async () => {},
    sendPreGenerateStampMenu: async () => {},
    sendRechargePacksMenu: async () => {},
    sendRechargePaymentMethodMenu: async () => {},
    sendOrangeMoneyInstructions: async () => {},
    sendPispiInstructions: async () => {},
    makeDraftMeta: (meta) => meta,
    cloneDraftToNewDocType: (draft) => draft,
    buildPreviewMessage: () => "",
    computeBasePdfCost: () => 1,
    formatBaseCostLine: () => "",
    resetDraftSession: () => {},
    normalizeAndValidateDraft: (draft) => ({ ok: true, draft }),
    startDocFlow: async () => {},
    askItemLabel: async () => {},
    tryHandleNaturalMessage: async () => false,
    processOcrImageToDraft: async () => {},
    createAndSendPdf: async () => {},
    getOrCreateProfile: async () => ({}),
    updateProfile: async () => ({}),
    hasStampProfileReady: () => false,
    resetStampChoice: () => {},
    buildDechargeConfirmationMessage: () => "",
    buildDechargePreviewMessage: () => "",
    getRechargeOffers: () => [],
    getRechargeOfferById: () => null,
    createManualOrangeMoneyTopup: async () => ({}),
    approveTopup: async () => ({}),
    rejectTopup: async () => ({}),
    readTopup: async () => null,
    addCredits: async () => ({}),
    getDevisFollowupById: async () => null,
    markDevisFollowupConverted: async () => ({}),
    postponeDevisFollowup: async () => ({}),
    markDevisFollowupDone: async () => ({}),
    cancelDevisFollowup: async () => ({}),
    formatDateISO: () => "2026-05-03",
    sendDocument: async () => {},
    startProfileFlow: async () => {},
    replyBalance: async () => {},
    replyRechargeInfo: async () => {},
  });

  await flow.handleInteractiveReply("22670000000", "STAMP_UPLOAD_IMAGE");

  assert.equal(session.step, "stamp_image_upload");
  assert.equal(session.profileStep, null);
  assert.equal(session.itemDraft, null);
  assert.match(calls[0].text, /Envoyez maintenant une photo ou une image de votre tampon\/cachet/);
});
