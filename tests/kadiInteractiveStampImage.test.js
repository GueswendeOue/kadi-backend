"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiInteractiveFlow } = require("../kadiInteractiveFlow");

function makeFlow({
  session,
  profile = {},
  updateProfile = async () => {},
  hasStampProfileReady = () => false,
  createAndSendPdf = async () => {},
  sendPreGenerateStampMenu = async () => {},
  demoVideoUrl = "",
} = {}) {
  const calls = [];

  const flow = makeKadiInteractiveFlow({
    getSession: () => session,
    sendText: async (to, text) => calls.push({ kind: "text", to, text }),
    sendButtons: async () => {},
    money: (value) => String(value),
    sendHomeMenu: async () => {},
    sendSupportMenu: async (to) => calls.push({ kind: "support_menu", to }),
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
    sendPreGenerateStampMenu,
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
    createAndSendPdf,
    getOrCreateProfile: async () => profile,
    updateProfile,
    hasStampProfileReady,
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
    demoVideoUrl,
  });

  return { flow, calls };
}

test("STAMP_UPLOAD_IMAGE puts session in stamp image upload step", async () => {
  const session = { step: "idle", itemDraft: { label: "x" } };
  const { flow, calls } = makeFlow({ session });

  await flow.handleInteractiveReply("22670000000", "STAMP_UPLOAD_IMAGE");

  assert.equal(session.step, "stamp_image_upload");
  assert.equal(session.profileStep, null);
  assert.equal(session.itemDraft, null);
  assert.match(calls[0].text, /Envoyez maintenant une photo ou une image de votre tampon\/cachet/);
});

test("HOME_SUPPORT opens support submenu instead of a support session", async () => {
  const session = { step: "idle" };
  const { flow, calls } = makeFlow({ session });

  await flow.handleInteractiveReply("22670000000", "HOME_SUPPORT");

  assert.deepEqual(calls, [{ kind: "support_menu", to: "22670000000" }]);
});

test("SUPPORT_DEMO_VIDEO sends demo link text", async () => {
  const session = { step: "idle" };
  const { flow, calls } = makeFlow({
    session,
    demoVideoUrl: "https://example.com/kadi-demo",
  });

  await flow.handleInteractiveReply("22670000000", "SUPPORT_DEMO_VIDEO");

  assert.equal(calls[0].kind, "text");
  assert.match(calls[0].text, /Vidéo de démonstration Kadi/);
  assert.match(calls[0].text, /https:\/\/example\.com\/kadi-demo/);
  assert.match(calls[0].text, /Parler à l’équipe Kadi/);
});

test("SUPPORT_DEMO_VIDEO sends fallback when link is missing", async () => {
  const session = { step: "idle" };
  const { flow, calls } = makeFlow({ session, demoVideoUrl: "" });

  await flow.handleInteractiveReply("22670000000", "SUPPORT_DEMO_VIDEO");

  assert.equal(calls[0].kind, "text");
  assert.match(calls[0].text, /sera bientôt disponible/);
  assert.match(calls[0].text, /Parler à l’équipe Kadi/);
});

test("STAMP_USE_KADI selects generated source without deleting uploaded image", async () => {
  const session = { step: "idle" };
  const patches = [];
  const { flow } = makeFlow({
    session,
    profile: {
      stamp_enabled: true,
      stamp_image_path: "22670000000/stamp.png",
      stamp_source: "uploaded",
    },
    updateProfile: async (waId, patch) => patches.push({ waId, patch }),
  });

  await flow.handleInteractiveReply("22670000000", "STAMP_USE_KADI");

  assert.deepEqual(patches, [
    {
      waId: "22670000000",
      patch: {
        stamp_enabled: true,
        stamp_source: "generated",
      },
    },
  ]);
});

test("STAMP_USE_UPLOADED selects uploaded source when image exists", async () => {
  const session = { step: "idle" };
  const patches = [];
  const { flow } = makeFlow({
    session,
    profile: {
      stamp_enabled: true,
      stamp_image_path: "22670000000/stamp.png",
      stamp_source: "generated",
    },
    updateProfile: async (waId, patch) => patches.push({ waId, patch }),
  });

  await flow.handleInteractiveReply("22670000000", "STAMP_USE_UPLOADED");

  assert.deepEqual(patches, [
    {
      waId: "22670000000",
      patch: {
        stamp_enabled: true,
        stamp_source: "uploaded",
      },
    },
  ]);
});

test("DOC_CONFIRM opens one-time stamp choice when stamp profile is ready", async () => {
  const session = {
    step: "doc_review",
    lastDocDraft: {
      type: "facture",
      client: "Awa",
      items: [{ label: "Pagne", qty: 5, unitPrice: 3000 }],
      finance: { gross: 15000 },
    },
  };
  const menus = [];
  const { flow } = makeFlow({
    session,
    profile: {
      stamp_enabled: true,
      business_name: "Kadi Services",
    },
    hasStampProfileReady: () => true,
    sendPreGenerateStampMenu: async (to, opts) => menus.push({ to, opts }),
  });

  await flow.handleInteractiveReply("22670000000", "DOC_CONFIRM");

  assert.deepEqual(menus, [
    {
      to: "22670000000",
      opts: {
        baseCost: 1,
      },
    },
  ]);
});

test("PRESTAMP_ADD_ONCE sets one-time stamp flags before creating PDF", async () => {
  const session = {
    step: "doc_review",
    lastDocDraft: {
      type: "facture",
      client: "Awa",
      items: [{ label: "Pagne", qty: 5, unitPrice: 3000 }],
      finance: { gross: 15000 },
    },
  };
  const createCalls = [];
  const { flow } = makeFlow({
    session,
    profile: {
      stamp_enabled: true,
      business_name: "Kadi Services",
    },
    hasStampProfileReady: () => true,
    createAndSendPdf: async () => {
      createCalls.push({
        addStampForNextDoc: session.addStampForNextDoc,
        stampMode: session.stampMode,
      });
    },
  });

  await flow.handleInteractiveReply("22670000000", "PRESTAMP_ADD_ONCE");

  assert.deepEqual(createCalls, [
    {
      addStampForNextDoc: true,
      stampMode: "one_time",
    },
  ]);
});
