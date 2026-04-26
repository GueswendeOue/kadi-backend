"use strict";

// ===============================
// Core / infra
// ===============================
const { supabase } = require("./supabaseClient");
const { getSession, clearCurrentFlowSession } = require("./kadiState");
const { withUserLock } = require("./kadiLocks");
const {
  extractMetaIdentity,
  resolveOwnerKey,
  syncMetaIdentity,
} = require("./kadiIdentity");
const {
  ensureWelcomeCredits,
  maybeSendOnboarding,
  tryHandleProfessionIntro,
  handleOnboardingReply,
  sendZeroDocReOnboarding,
  sendReactivationNudge,
} = require("./kadiOnboarding");

// ===============================
// Messaging / WhatsApp
// ===============================
const {
  sendText,
  sendButtons,
  sendList,
  getMediaInfo,
  downloadMediaToBuffer,
  uploadMediaBuffer,
  sendDocument,
} = require("./kadiMessaging");

// ===============================
// Utils / helpers
// ===============================
const {
  safe,
  norm,
  isValidWhatsAppId,
  formatDateISO,
  sleep,
  guessExtFromMime,
  resetAdminBroadcastState,
} = require("./kadiUtils");

const {
  money,
  ensureAdmin,
  parseNumberSmart,
} = require("./kadiCoreHelpers");

const { makeDraftHelpers } = require("./kadiDraftHelpers");
const { makeKadiMenus } = require("./kadiMenus");
const { makeKadiCreditsUi } = require("./kadiCreditsUi");
const { recordActivity } = require("./kadiActivityRepo");

// ===============================
// AI / parsing
// ===============================
const { handleIncomingAudioMessage } = require("./kadiAudio");
const { parseNaturalWithOpenAI } = require("./kadiOpenAI");
const { parseNaturalWhatsAppMessage } = require("./kadiNaturalParser");
const { buildIntent } = require("./kadiIntentEngine");
const { buildIntentMessage, getNextQuestion } = require("./kadiIntentUx");

// ===============================
// Product modules
// ===============================
const { makeKadiProfileFlow } = require("./kadiProfileFlow");
const { makeKadiStampFlow } = require("./kadiStampFlow");
const { makeKadiFollowups } = require("./kadiFollowups");
const { makeKadiOcrFlow } = require("./kadiOcrFlow");
const { makeKadiPdfFlow } = require("./kadiPdfFlow");
const { makeKadiProductFlow } = require("./kadiProductFlow");
const { makeKadiNaturalFlow } = require("./kadiNaturalFlow");
const { makeKadiImageFlow } = require("./kadiImageFlow");
const { makeKadiInteractiveFlow } = require("./kadiInteractiveFlow");
const { makeKadiCommandFlow } = require("./kadiCommandFlow");
const { makeKadiSmallTalk } = require("./kadiSmallTalk");
const { makeKadiIntentTextFix } = require("./kadiIntentTextFix");
const { makeKadiPriorityRouter } = require("./kadiPriorityRouter");
const { makeKadiStatsService } = require("./kadiStatsService");
const {
  makeKadiAdminBroadcastService,
} = require("./kadiAdminBroadcastService");
const {
  makeKadiReengagementService,
} = require("./kadiReengagementService");
const { makeKadiHistoryFlow } = require("./kadiHistoryFlow");

// ===============================
// Certified module (FEC)
// ===============================
const {
  createCertifiedInvoiceDraft,
  markCertifiedInvoiceCertified,
  attachCertifiedInvoicePdf,
  getCertifiedInvoiceById,
  listRecentCertifiedInvoices,
} = require("./kadiCertified/kadiCertifiedRepo");

const {
  buildCertifiedInvoicePdfBuffer,
} = require("./kadiCertified/kadiCertifiedPdf");

const {
  makeKadiCertifiedService,
} = require("./kadiCertified/kadiCertifiedService");

const {
  makeKadiCertifiedFlow,
} = require("./kadiCertified/kadiCertifiedFlow");

// ===============================
// Recharge / payments
// ===============================
const {
  getRechargeOffers,
  getRechargeOfferById,
} = require("./kadiRechargeConfig");

const {
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,
} = require("./kadiRechargeUi");

const {
  createManualOrangeMoneyTopup,
  markTopupProofTextReceived,
  markTopupProofImageReceived,
  approveTopup,
  rejectTopup,
  readTopup,
} = require("./kadiPayments");

const { getPendingTopupByWaId } = require("./kadiPaymentsRepo");
const { notifyAdminTopupReview } = require("./kadiAdminNotifications");

// ===============================
// Existing repos / services
// ===============================
const {
  getOrCreateProfile,
  updateProfile,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
  saveProfileLogoFromBuffer,
} = require("./store");

const {
  getBalance,
  addCredits,
  consumeCredit,
  consumeFeature,
} = require("./kadiCreditsRepo");

const { getStats } = require("./kadiStatsRepo");

const {
  listRecentDocumentsByWaId,
  getLatestResendableDocumentByWaId,
  getDocumentById,
  getDocumentByIdForWaId,
  searchDocumentsByWaId,
} = require("./kadiHistoryRepo");

const { saveDocument } = require("./kadiRepo");
const { nextDocNumber } = require("./kadiCounterRepo");
const { buildPdfBuffer } = require("./kadiPdf");

const kadiStamp = require("./kadiStamp");
const kadiSignature = require("./kadiSignature");
const kadiBroadcast = require("./kadiBroadcast");

// OCR
const { kadiOcrEngine } = require("./kadiOcrEngine");

// Smart block
const {
  analyzeSmartBlock,
  parseItemsBlockSmart,
  extractBlockTotals,
  buildSmartMismatchMessage,
  sanitizeOcrLabel,
  looksLikeRealItemLabel,
} = require("./kadiSmartBlock");

// Décharge
const {
  detectDechargeType,
  initDechargeDraft,
  buildDechargePreviewMessage,
  buildDechargeConfirmationMessage,
  buildPostConfirmationMessage,
  buildDechargeText,
} = require("./kadiDecharge");

// ===============================
// Logger
// ===============================
const logger = {
  info: (context, message, meta = {}) =>
    console.log(`[KADI/INFO/${context}]`, message, meta),
  warn: (context, message, meta = {}) =>
    console.warn(`[KADI/WARN/${context}]`, message, meta),
  error: (context, error, meta = {}) =>
    console.error(`[KADI/ERROR/${context}]`, error?.message || error, {
      ...meta,
      stack: error?.stack,
    }),
};

// ===============================
// Config
// ===============================
const LIMITS = {
  maxClientNameLength: 80,
  maxItemLabelLength: 120,
  maxItems: 50,
  maxImageSize: 8 * 1024 * 1024,
  maxOcrRetries: 3,
};

const STAMP_ONE_TIME_COST = Number(process.env.STAMP_ONE_TIME_COST || 15);
const PDF_SIMPLE_CREDITS = Number(process.env.PDF_SIMPLE_CREDITS || 1);
const OCR_PDF_CREDITS = Number(process.env.OCR_PDF_CREDITS || 2);
const DECHARGE_CREDITS = Number(process.env.DECHARGE_CREDITS || 2);
const PACK_CREDITS = Number(process.env.PACK_CREDITS || 25);
const PACK_PRICE_FCFA = Number(process.env.PACK_PRICE_FCFA || 2000);

// ===============================
// Optional re-engagement deps
// ===============================
let getZeroDocUsersBySegment = null;
let getInactiveUsers = null;

try {
  ({ getZeroDocUsersBySegment, getInactiveUsers } = require("./kadiReengagementRepo"));
} catch (_) {}

// ===============================
// Local helpers
// ===============================
async function logLearningEvent(payload = {}) {
  try {
    logger.info("learning", "event", payload);
  } catch (_) {}
}

async function uploadCampaignImageBuffer({ buffer, mimeType, filename }) {
  const finalName = `${filename || `campaign-${Date.now()}`}.jpg`;

  const up = await uploadMediaBuffer({
    buffer,
    filename: finalName,
    mimeType: mimeType || "image/jpeg",
  });

  return {
    filePath: up?.id ? `whatsapp-media/${up.id}` : finalName,
    mediaId: up?.id || null,
  };
}

async function getSignedCampaignUrl(filePath) {
  return filePath;
}

async function broadcastToAllKnownUsers(from, text) {
  if (kadiBroadcast?.broadcastToAll) {
    return kadiBroadcast.broadcastToAll({
      adminWaId: from,
      message: text,
    });
  }

  await sendText(from, "⚠️ Module broadcast non disponible.");
}

function isIntentFixStep(step) {
  return (
    step === "intent_fix_price" ||
    step === "intent_fix_client" ||
    step === "intent_fix_items" ||
    step === "intent_fix"
  );
}

function getInteractiveReplyId(msg) {
  return (
    msg?.interactive?.button_reply?.id ||
    msg?.interactive?.list_reply?.id ||
    null
  );
}

function isHardGlobalInterrupt(text = "") {
  const t = norm(text).toLowerCase().trim();

  return (
    t === "menu" ||
    t === "accueil" ||
    t === "home" ||
    t === "retour" ||
    t === "annuler" ||
    t === "annule" ||
    t === "stop"
  );
}

function isHistoryStep(step = "") {
  return String(step || "").startsWith("history");
}

function isStructuredCaptureStep(step = "") {
  const s = String(step || "");

  return (
    s === "doc_client" ||
    s === "doc_subject_input" ||
    s === "client_phone_input" ||
    s === "item_label" ||
    s === "item_price" ||
    s === "item_qty" ||
    s === "receipt_format" ||
    s === "facture_kind" ||
    s === "stamp_title" ||
    s === "recharge_proof" ||
    s === "pispi_pending" ||
    s === "doc_review" ||
    s === "doc_after_item_choice" ||
    s === "doc_subject_choice" ||
    s === "doc_client_phone_choice" ||
    s === "doc_already_generated" ||
    s === "doc_edit_text_waiting" ||
    s === "missing_client_pdf" ||
    s === "smartblock_warning" ||
    s === "awaiting_ocr_image" ||
    s === "decharge_client" ||
    s === "decharge_motif" ||
    s === "decharge_amount" ||
    s === "profile" ||
    s === "profile_logo_upload" ||
    s.startsWith("intent_fix") ||
    s.startsWith("certified_invoice_")
  );
}

function looksLikeProfessionIntroText(text = "") {
  const t = norm(text).toLowerCase().trim();
  if (!t) return false;

  const introPatterns = [
    /^je suis\s+/,
    /^j suis\s+/,
    /^je fais\s+/,
    /^nous faisons\s+/,
    /^mon metier c est\s+/,
    /^mon métier c est\s+/,
    /^mon metier est\s+/,
    /^mon métier est\s+/,
    /^je travaille comme\s+/,
  ];

  if (introPatterns.some((re) => re.test(t))) return true;

  const shortProfessionOnly = [
    "soudeur",
    "macon",
    "maçon",
    "btp",
    "chantier",
    "plombier",
    "electricien",
    "électricien",
    "menuisier",
    "boutique",
    "commerce",
    "vendeur",
    "restaurant",
    "restauration",
    "maquis",
    "mecanicien",
    "mécanicien",
    "coiffeur",
    "coiffeuse",
    "couturier",
    "couturiere",
    "couturière",
    "services",
  ];

  if (shortProfessionOnly.includes(t)) return true;

  return false;
}

async function handleRechargeProofText(from, text) {
  const s = getSession(from);
  const proofText = String(text || "").trim();

  if (!proofText) return false;
  if (s?.step !== "recharge_proof") return false;

  let topup = null;

  try {
    if (s?.pendingTopupId) {
      topup = await readTopup(s.pendingTopupId);
    }

    if (!topup && typeof getPendingTopupByWaId === "function") {
      topup = await getPendingTopupByWaId(from);
    }

    if (!topup?.id) {
      await sendText(
        from,
        "⚠️ Je n’ai pas retrouvé votre demande de recharge en attente.\n\nTapez RECHARGE pour recommencer."
      );
      return true;
    }

    const updated = await markTopupProofTextReceived(topup.id, proofText);

    s.pendingTopupId = updated?.id || topup.id;
    s.pendingTopupReference = updated?.reference || topup.reference || null;
    s.step = null;

    await notifyAdminTopupReview(from, updated, "text");

    await sendText(
      from,
      "✅ Preuve reçue.\n\nVotre paiement est maintenant en attente de validation.\nVous recevrez vos crédits dès confirmation."
    );

    if (s?.lastDocDraft) {
      await sendButtons(
        from,
        "Après validation, vous pourrez reprendre directement votre document 👇",
        [
          { id: "DOC_FINISH", title: "📄 Aperçu" },
          { id: "BACK_HOME", title: "🏠 Menu" },
        ]
      );
    } else {
      await sendButtons(from, "Que voulez-vous faire maintenant ?", [
        { id: "HOME_DOCS", title: "📄 Créer doc" },
        { id: "BACK_HOME", title: "🏠 Menu" },
      ]);
    }

    return true;
  } catch (e) {
    logger.error("recharge_proof_text", e, { from });

    await sendText(
      from,
      "⚠️ Je n’ai pas pu enregistrer votre preuve pour le moment.\nRéessayez dans quelques instants."
    );
    return true;
  }
}

// ===============================
// Draft helpers
// ===============================
const {
  makeDraftMeta,
  computeFinance,
  makeItem,
  normalizeAndValidateDraft,
  getDocTitle,
  computeBasePdfCost,
  formatBaseCostLine,
  validateDraft,
  buildPreviewMessage,
  cloneDraftToNewDocType,
  resetDraftSession,
} = makeDraftHelpers({
  money,
  PDF_SIMPLE_CREDITS,
  OCR_PDF_CREDITS,
  DECHARGE_CREDITS,
  LIMITS,
  formatDateISO,
  safe,
});

// ===============================
// Menus
// ===============================
const {
  sendHomeMenu,
  sendDocsMenu,
  sendFactureCatalogMenu,
  sendFactureKindMenu,
  sendCreditsMenu,
  sendProfileMenu,
  sendAfterProductMenu,
  sendPreviewMenu,
  sendReceiptFormatMenu,
  sendStampMenu,
  sendStampMoreMenu,
  sendStampPositionMenu,
  sendStampPositionMenu2,
  sendStampSizeMenu,
} = makeKadiMenus({
  sendButtons,
  sendList,
  getOrCreateProfile,
  STAMP_ONE_TIME_COST,
});

const { replyBalance, replyRechargeInfo } = makeKadiCreditsUi({
  sendText,
  sendButtons,
  getBalance,
  sendRechargePacksMenu,
});

// ===============================
// Profile flow
// ===============================
const {
  startProfileFlow,
  handleProfileText,
  handleProfileReply,
} = makeKadiProfileFlow({
  getSession,
  sendText,
  sendButtons,
  updateProfile,
  sendHomeMenu,
});

// ===============================
// Stamp flow
// ===============================
const {
  hasStampProfileReady,
  resetStampChoice,
  sendPreGenerateStampMenu: _sendPreGenerateStampMenuFromStampFlow,
  sendStampMenu: _sendStampMenuFromStampFlow,
  sendStampMoreMenu: _sendStampMoreMenuFromStampFlow,
  sendStampPositionMenu: _sendStampPositionMenuFromStampFlow,
  sendStampPositionMenu2: _sendStampPositionMenu2FromStampFlow,
  sendStampSizeMenu: _sendStampSizeMenuFromStampFlow,
  handleStampFlow,
} = makeKadiStampFlow({
  getSession,
  sendText,
  sendButtons,
  getOrCreateProfile,
  updateProfile,
  STAMP_ONE_TIME_COST,
});

// ===============================
// Followups
// ===============================
const {
  createDevisFollowup,
  postponeDevisFollowup,
  markDevisFollowupConverted,
  markDevisFollowupDone,
  cancelDevisFollowup,
  processDevisFollowups,
  getDevisFollowupById,
} = makeKadiFollowups({
  supabase,
  sendButtons,
});

// ===============================
// OCR flow
// ===============================
const { processOcrImageToDraft } = makeKadiOcrFlow({
  getSession,
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  LIMITS,
  formatDateISO,
  sleep,
  makeDraftMeta,
  makeItem,
  computeFinance,
  normalizeAndValidateDraft,
  buildPreviewMessage,
  computeBasePdfCost,
  formatBaseCostLine,
  logger,
  safe,
  sendPreviewMenu,
  ocrImageToText: kadiOcrEngine,
  parseInvoiceTextWithGemini: null,
  parseNumberSmart,
  sanitizeOcrLabel,
  looksLikeRealItemLabel,
});

// ===============================
// Product flow
// ===============================
const {
  startDocFlow,
  askItemLabel,
  handleProductFlowText,
} = makeKadiProductFlow({
  getSession,
  sendText,
  sendButtons,
  LIMITS,
  formatDateISO,
  makeDraftMeta,
  initDechargeDraft,
  detectDechargeType,
  buildDechargePreviewMessage,
  buildDechargeConfirmationMessage,
  computeFinance,
  makeItem,
  parseNumberSmart,
  buildPreviewMessage,
  computeBasePdfCost,
  formatBaseCostLine,
  sendPreviewMenu,
  sendAfterProductMenu,
  sendReceiptFormatMenu,
  money,
  safe,
  isValidWhatsAppId,
  normalizeAndValidateDraft,
});

// ===============================
// Natural flow
// ===============================
const {
  tryHandleNaturalMessage,
  tryHandleDechargeConfirmation,
  handleSmartItemsBlockText,
} = makeKadiNaturalFlow({
  getSession,
  sendText,
  sendButtons,
  money,
  LIMITS,
  formatDateISO,
  makeDraftMeta,
  makeItem,
  computeFinance,
  computeBasePdfCost,
  formatBaseCostLine,
  buildPreviewMessage,
  sendPreviewMenu,
  askItemLabel,
  parseNaturalWhatsAppMessage,
  parseNaturalWithOpenAI,
  analyzeSmartBlock,
  logLearningEvent,
  detectDechargeType,
  buildDechargePreviewMessage,
  initDechargeDraft,
  buildPostConfirmationMessage,
  parseItemsBlockSmart,
  extractBlockTotals,
  buildSmartMismatchMessage,
  safe,
  getOrCreateProfile,
  resetStampChoice,
});

// ===============================
// PDF flow
// ===============================
const {
  createAndSendPdf,
  sendAlreadyGeneratedMenu,
} = makeKadiPdfFlow({
  getSession,
  sendText,
  sendButtons,
  sendDocument,
  uploadMediaBuffer,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
  getOrCreateProfile,
  saveDocument,
  nextDocNumber,
  createDevisFollowup,
  consumeCredit,
  addCredits,
  buildPdfBuffer,
  kadiStamp,
  kadiSignature,
  safe,
  formatDateISO,
  money,
  makeDraftMeta,
  computeFinance,
  computeBasePdfCost,
  getDocTitle,
  validateDraft,
  normalizeAndValidateDraft,
  resetStampChoice,
  buildDechargeText,
});

// ===============================
// Certified service (FEC)
// ===============================
const {
  createCertifiedInvoiceFromDraft,
  rebuildCertifiedInvoicePdf,
} = makeKadiCertifiedService({
  getOrCreateProfile,
  getSignedLogoUrl,
  downloadSignedUrlToBuffer,
  uploadMediaBuffer,
  createCertifiedInvoiceDraft,
  markCertifiedInvoiceCertified,
  attachCertifiedInvoicePdf,
  getCertifiedInvoiceById,
  buildCertifiedInvoicePdfBuffer,
});

// ===============================
// Image flow
// ===============================
const { handleIncomingImage } = makeKadiImageFlow({
  getSession,
  sendText,
  sendButtons,
  getMediaInfo,
  downloadMediaToBuffer,
  LIMITS,
  guessExtFromMime,
  handleLogoImage: async (from, msg) => {
    const s = getSession(from);

    const isLegacyLogoStep = s.step === "profile" && s.profileStep === "logo";
    const isNewLogoStep = s.step === "profile_logo_upload";

    if (!isLegacyLogoStep && !isNewLogoStep) return false;

    const mediaId = msg?.image?.id;
    if (!mediaId) return false;

    try {
      const info = await getMediaInfo(mediaId);
      const mimeType = info?.mime_type || "image/jpeg";
      const ext = guessExtFromMime(mimeType) || "jpg";
      const buffer = await downloadMediaToBuffer(info.url);

      await saveProfileLogoFromBuffer({
        waId: from,
        buffer,
        mimeType,
        fileName: `logo-${Date.now()}.${ext}`,
      });

      s.step = null;
      s.profileStep = null;

      await sendText(
        from,
        "✅ Logo enregistré.\n📄 Vos documents afficheront maintenant votre logo."
      );

      if (s.lastDocDraft) {
        await sendButtons(from, "📄 On reprend votre document 👇", [
          { id: "DOC_CONFIRM", title: "📤 Envoyer PDF" },
          { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
        ]);
        return true;
      }

      await sendHomeMenu(from);
      return true;
    } catch (err) {
      logger.error("logo_upload", err, { from });

      await sendText(
        from,
        "❌ Je n’ai pas pu enregistrer le logo.\nRéessayez avec une image plus nette."
      );
      return true;
    }
  },
  readTopup,
  getPendingTopupByWaId,
  markTopupProofImageReceived,
  notifyAdminTopupReview,
  processOcrImageToDraft,
  uploadCampaignImageBuffer,
  getSignedCampaignUrl,
  ensureAdmin,
  resetAdminBroadcastState,
  kadiBroadcast,
});

// ===============================
// Certified flow (FEC)
// ===============================
const {
  startCertifiedInvoiceFlow,
  sendRecentCertifiedInvoices,
  handleCertifiedInvoiceInteractiveReply,
  handleCertifiedInvoiceText,
} = makeKadiCertifiedFlow({
  getSession,
  sendText,
  sendButtons,
  sendDocument,
  getOrCreateProfile,
  createCertifiedInvoiceFromDraft,
  listRecentCertifiedInvoices,
  rebuildCertifiedInvoicePdf,
  money,
});

// ===============================
// History flow
// ===============================
const {
  sendHistoryHome,
  handleHistoryInteractiveReply,
  handleHistoryText,
} = makeKadiHistoryFlow({
  getSession,
  sendText,
  sendButtons,
  sendList,
  sendDocument,
  listRecentDocumentsByWaId,
  getLatestResendableDocumentByWaId,
  getDocumentById,
  getDocumentByIdForWaId,
  searchDocumentsByWaId,
  sendRecentCertifiedInvoices,
  sendHomeMenu,
  money,
});

// ===============================
// Interactive flow
// ===============================
const { handleInteractiveReply } = makeKadiInteractiveFlow({
  getSession,
  sendText,
  sendButtons,
  money,

  sendHomeMenu,
  sendDocsMenu,
  sendCreditsMenu,
  sendProfileMenu,
  sendFactureKindMenu,
  sendFactureCatalogMenu,
  sendPreviewMenu,
  sendStampMenu: _sendStampMenuFromStampFlow,
  sendStampMoreMenu: _sendStampMoreMenuFromStampFlow,
  sendStampPositionMenu: _sendStampPositionMenuFromStampFlow,
  sendStampPositionMenu2: _sendStampPositionMenu2FromStampFlow,
  sendStampSizeMenu: _sendStampSizeMenuFromStampFlow,
  sendAlreadyGeneratedMenu,
  sendPreGenerateStampMenu: _sendPreGenerateStampMenuFromStampFlow,
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,
  sendHistoryHome,

  makeDraftMeta,
  cloneDraftToNewDocType,
  buildPreviewMessage,
  computeBasePdfCost,
  formatBaseCostLine,
  resetDraftSession,
  normalizeAndValidateDraft,

  startDocFlow,
  askItemLabel,
  tryHandleNaturalMessage,

  processOcrImageToDraft,
  createAndSendPdf,

  getOrCreateProfile,
  updateProfile,
  hasStampProfileReady,
  resetStampChoice,

  buildDechargeConfirmationMessage,
  buildDechargePreviewMessage,

  getRechargeOffers,
  getRechargeOfferById,
  createManualOrangeMoneyTopup,
  approveTopup,
  rejectTopup,
  readTopup,
  addCredits,
  clearCurrentFlowSession,

  getDevisFollowupById,
  markDevisFollowupConverted,
  postponeDevisFollowup,
  markDevisFollowupDone,
  cancelDevisFollowup,

  formatDateISO,
  sendDocument,
  startProfileFlow,
  replyBalance,
  replyRechargeInfo,
});

// ===============================
// Stats service
// ===============================
const { handleStatsCommand } = makeKadiStatsService({
  sendText,
  getStats,
  packCredits: PACK_CREDITS,
  packPriceFcfa: PACK_PRICE_FCFA,
  money,
});

// ===============================
// Admin services
// ===============================
const { handleBroadcastCommand } = makeKadiAdminBroadcastService({
  sendText,
  broadcastToAllKnownUsers,
});

const { sendTemplate } = require("./whatsappApi");

const {
  handleReengageZeroDocsCommand,
  handleReengageInactiveCommand,
} = makeKadiReengagementService({
  sendText,
  sendTemplateMessage: sendTemplate,
  getZeroDocUsersBySegment,
  getInactiveUsers,
  sendZeroDocReOnboarding,
  sendReactivationNudge,
});

// ===============================
// Command flow
// ===============================
const { handleCommand } = makeKadiCommandFlow({
  sendText,
  sendButtons,

  // user actions
  startProfileFlow,
  sendHomeMenu,
  sendCreditsMenu,
  sendRechargePacksMenu,
  sendDocsMenu,

  // admin / services
  ensureAdmin,
  handleStatsCommand,
  handleBroadcastCommand,
  handleReengageZeroDocsCommand,
  handleReengageInactiveCommand,

  // credits
  addCredits,

  // helpers
  norm,
});

// ===============================
// Small talk
// ===============================
const { handleSmallTalk } = makeKadiSmallTalk({
  sendButtons,
  norm,
});

// ===============================
// Intent fix text flow
// ===============================
const { handleIntentFixText } = makeKadiIntentTextFix({
  getSession,
  sendText,
  sendButtons,
  buildIntent,
  buildIntentMessage,
  getNextQuestion,
  parseNumberSmart,
});

// ===============================
// Priority router
// ===============================
const { handleUltraPriorityText } = makeKadiPriorityRouter({
  norm,
  logger,
  sendText,
  sendHomeMenu,
  sendDocsMenu,
  startProfileFlow,
  replyBalance,
  sendRechargePacksMenu,
  sendStampMenu,
  sendProfileMenu,
  sendCreditsMenu,
  sendAlreadyGeneratedMenu,
  startCertifiedInvoiceFlow,
  sendRecentCertifiedInvoices,
  sendHistoryHome,
});

// ===============================
// Message handlers
// ===============================
async function handleTextMessage(from, text, msg) {
  const normalizedText = norm(text).toLowerCase().trim();
  console.log("[KADI/TEXT] raw:", text, "| norm:", normalizedText);

  if (isHardGlobalInterrupt(text)) {
    clearCurrentFlowSession(getSession(from));
    await sendHomeMenu(from);
    return true;
  }

  // 1) Commandes explicites d'abord
  if (await handleCommand(from, text, { wa_id: from })) return true;

  const s = getSession(from);
  const inHistoryFlow = isHistoryStep(s?.step);
  const inStructuredFlow = isStructuredCaptureStep(s?.step);
  const wantsGlobalInterrupt = isHardGlobalInterrupt(text);

  logger.info("engine", "text routing", {
    from,
    step: s?.step || null,
    inHistoryFlow,
    inStructuredFlow,
    wantsGlobalInterrupt,
    hasIntent: !!s?.intent,
  });

  // 2) Historique actif
  if (inHistoryFlow && !wantsGlobalInterrupt) {
    if (await handleHistoryText(from, text)) return true;

    await sendText(
      from,
      "⚠️ Je suis encore dans votre historique.\nRépondez à l’action demandée ou tapez MENU."
    );
    return true;
  }

  // 3) Flow structuré actif
  if (inStructuredFlow && !wantsGlobalInterrupt) {
    if (s?.step === "recharge_proof") {
      const handledRechargeProof = await handleRechargeProofText(from, text);
      if (handledRechargeProof) return true;
    }

    if (isIntentFixStep(s?.step)) {
      const handledIntentFix = await handleIntentFixText(from, text);
      if (handledIntentFix) return true;

      await sendText(
        from,
        "⚠️ Je complète encore votre document.\nRépondez à la question demandée ou tapez MENU."
      );
      return true;
    }

    if (await handleCertifiedInvoiceText(from, text)) return true;
    if (await tryHandleDechargeConfirmation(from, text)) return true;
    if (await handleProfileText(from, text, msg)) return true;
    if (await handleStampFlow(from, text)) return true;
    if (await handleProductFlowText(from, text)) return true;

    await sendText(
      from,
      "⚠️ Je suis encore en train de compléter votre document.\nRépondez à la question demandée ou tapez MENU."
    );
    return true;
  }

  // 4) Historique libre
  if (await handleHistoryText(from, text)) return true;

  // 5) Entrée directe FEC
  if (
    normalizedText.includes("facture electronique certifiee") ||
    normalizedText.includes("facture électronique certifiée") ||
    normalizedText.includes("facture certifiee") ||
    normalizedText.includes("facture certifiée") ||
    normalizedText === "fec"
  ) {
    return startCertifiedInvoiceFlow(from);
  }

  // 6) Intentions prioritaires
  if (await handleUltraPriorityText(from, text)) return true;

  // 7) Small talk
  if (await handleSmallTalk(from, text)) return true;

  // 8) Intro métier stricte
  if (looksLikeProfessionIntroText(text)) {
    const handledProfessionIntro = await tryHandleProfessionIntro(from, text);
    if (handledProfessionIntro) return true;
  }

  // 9) Correction guidée d’intent
  if (isIntentFixStep(s?.step)) {
    const handledIntentFix = await handleIntentFixText(from, text);
    if (handledIntentFix) return true;

    await sendText(
      from,
      "⚠️ Je complète encore votre document.\nRépondez à la question demandée ou tapez MENU."
    );
    return true;
  }

  // 10) Flow FEC si session ouverte
  if (await handleCertifiedInvoiceText(from, text)) return true;

  // 11) Flows structurés
  if (await tryHandleDechargeConfirmation(from, text)) return true;
  if (await handleProfileText(from, text, msg)) return true;
  if (await handleStampFlow(from, text)) return true;
  if (await handleProductFlowText(from, text)) return true;

  // 12) Compréhension naturelle
  if (await tryHandleNaturalMessage(from, text)) return true;
  if (await handleSmartItemsBlockText(from, text)) return true;

  // 13) Onboarding seulement si rien d’autre n’a répondu
  const sentOnboarding = await maybeSendOnboarding(from);
  if (sentOnboarding) return true;

  // 14) Fallback
  await sendText(
    from,
    "🤔 Je n’ai pas bien compris.\n\n" +
      "💡 Exemple :\n" +
      "Devis pour Moussa, 2 portes à 25000\n\n" +
      "Ou tapez MENU"
  );
  return true;
}

async function handleInteractiveMessage(from, msg) {
  const replyId = getInteractiveReplyId(msg);

  if (!replyId) {
    await sendText(
      from,
      "⚠️ Je n’ai pas pu ouvrir cette option.\nTapez MENU pour continuer."
    );
    return true;
  }

  const handledOnboarding = await handleOnboardingReply(from, replyId);
  if (handledOnboarding) return true;

  const handledProfileReply = await handleProfileReply(from, replyId);
  if (handledProfileReply) return true;

  const handledHistoryReply = await handleHistoryInteractiveReply(from, replyId);
  if (handledHistoryReply) return true;

  if (
    replyId === "DOC_FEC" ||
    replyId === "DOC_FACTURE_ELECTRONIQUE_CERTIFIE"
  ) {
    await startCertifiedInvoiceFlow(from);
    return true;
  }

  const handledCertifiedReply = await handleCertifiedInvoiceInteractiveReply(
    from,
    replyId
  );
  if (handledCertifiedReply) return true;

  await handleInteractiveReply(from, replyId);
  return true;
}

// ===============================
// Main routing
// ===============================
async function handleIncomingMessage(value) {
  const messages = value?.messages || [];
  if (!messages.length) return;

  for (const msg of messages) {
    const from = msg?.from;
    if (!from) continue;

    await safeRecordActivity(from);

    await withUserLock(from, async () => {
      try {
        const identity = extractMetaIdentity(value);
        await syncMetaIdentity(identity);
        resolveOwnerKey(identity);

        await ensureWelcomeCredits(from);

        if (msg.type === "audio") {
          await handleIncomingAudioMessage(msg, value, {
            sendText,
            sendButtons,
            getSession,
          });
          return;
        }

        if (msg.type === "image") {
          await handleIncomingImage(from, msg);
          return;
        }

        if (msg.type === "interactive") {
          await handleInteractiveMessage(from, msg);
          return;
        }

        if (msg.type === "text") {
          const text = msg?.text?.body || "";
          await handleTextMessage(from, text, msg);
          return;
        }

        await sendText(
          from,
          "⚠️ Je ne peux pas traiter ce type de message pour le moment.\nTapez MENU pour continuer."
        );
      } catch (err) {
        logger.error("handle_incoming_message", err, {
          from,
          msgType: msg?.type,
        });

        await sendText(
          from,
          "⚠️ Une petite erreur s’est produite.\nTapez MENU pour reprendre."
        );
      }
    });
  }
}

async function handleIncomingStatuses(statuses = []) {
  for (const st of statuses) {
    console.log("[KADI STATUS]", st.status, st.id || st.message_id || "");
  }
}

async function safeRecordActivity(waId) {
  try {
    await recordActivity(waId);
  } catch (e) {
    console.warn("[KADI ACTIVITY] record failed:", e?.message || e);
  }
}

module.exports = {
  handleIncomingMessage,
  handleIncomingStatuses,
  processDevisFollowups,
};
