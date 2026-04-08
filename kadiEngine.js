"use strict";

// ===============================
// Core / infra
// ===============================
const { supabase } = require("./supabaseClient");
const { getSession } = require("./kadiState");
const { withUserLock } = require("./kadiLocks");
const {
  extractMetaIdentity,
  resolveOwnerKey,
  syncMetaIdentity,
} = require("./kadiIdentity");
const {
  ensureWelcomeCredits,
  maybeSendOnboarding,
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

// ===============================
// Existing business modules
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
} = require("./store");

const {
  getBalance,
  addCredits,
  consumeCredit,
  consumeFeature,
} = require("./kadiCreditsRepo");

const { getStats } = require("./kadiStatsRepo");

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
let sendZeroDocReOnboarding = null;
let sendReactivationNudge = null;

try {
  ({ getZeroDocUsersBySegment, getInactiveUsers } = require("./kadiReengagementRepo"));
} catch (_) {}

try {
  ({ sendZeroDocReOnboarding, sendReactivationNudge } = require("./kadiReengagementMessaging"));
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

// ===============================
// Draft helpers
// ===============================
const {
  makeDraftMeta,
  computeFinance,
  makeItem,
  normalizeItem,
  normalizeAndValidateDraft,
  getDraftValidationIssues,
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
  sendPreGenerateStampMenu,
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
  buildPreviewMessage,
  computeBasePdfCost,
  formatBaseCostLine,
  logger,
  ocrImageToText: kadiOcrEngine,
  geminiIsEnabled: () => false,
  ocrLooksGood: () => true,
  geminiOcrImageBuffer: null,
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
  parseNaturalWhatsAppMessage,
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
  updateProfile,
  sendStampMenu: _sendStampMenuFromStampFlow,
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
  resetStampChoice,
  buildDechargeText,
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
    if (s.step !== "profile_logo_upload") return false;

    const mediaId = msg?.image?.id;
    if (!mediaId) return false;

    await updateProfile(from, {
      logo_media_id: mediaId,
      no_logo: false,
    });

    s.step = null;

    await sendText(
      from,
      "✅ Logo enregistré.\n📄 Vos documents seront maintenant plus professionnels."
    );

    if (s.lastDocDraft) {
      await sendButtons(from, "📄 On reprend votre document 👇", [
        { id: "DOC_CONFIRM", title: "📤 Envoyer le PDF" },
        { id: "DOC_ADD_MORE", title: "✏️ Modifier" },
      ]);
      return true;
    }

    await sendHomeMenu(from);
    return true;
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
  sendPreGenerateStampMenu,
  sendRechargePacksMenu,
  sendRechargePaymentMethodMenu,
  sendOrangeMoneyInstructions,
  sendPispiInstructions,

  makeDraftMeta,
  cloneDraftToNewDocType,
  buildPreviewMessage,
  computeBasePdfCost,
  formatBaseCostLine,
  resetDraftSession,

  startDocFlow,
  askItemLabel,
  tryHandleNaturalMessage,
  handleSmartItemsBlockText,

  processOcrImageToDraft,
  createAndSendPdf,

  getOrCreateProfile,
  updateProfile,
  hasStampProfileReady,
  resetStampChoice,
  consumeFeature,
  STAMP_ONE_TIME_COST,

  buildDechargeConfirmationMessage,
  buildDechargePreviewMessage,

  getRechargeOffers,
  getRechargeOfferById,
  createManualOrangeMoneyTopup,
  approveTopup,
  rejectTopup,
  readTopup,
  addCredits,

  getDevisFollowupById,
  markDevisFollowupConverted,
  postponeDevisFollowup,

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

const {
  handleReengageZeroDocsCommand,
  handleReengageInactiveCommand,
} = makeKadiReengagementService({
  sendText,
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

  startProfileFlow,
  sendHomeMenu,
  sendCreditsMenu,
  sendRechargePacksMenu,
  sendDocsMenu,

  ensureAdmin,
  handleStatsCommand,
  handleBroadcastCommand,
  handleReengageZeroDocsCommand,
  handleReengageInactiveCommand,

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
});

// ===============================
// Main routing
// ===============================
async function handleIncomingMessage(value) {
  const messages = value?.messages || [];
  if (!messages.length) return;

  for (const msg of messages) {
    const from = msg?.from;
    if (!from) continue;

    await withUserLock(from, async () => {
      try {
        const identity = extractMetaIdentity(value);
        await syncMetaIdentity(identity);
        resolveOwnerKey(identity);

        await ensureWelcomeCredits(from);

        if (msg.type !== "text") {
          await maybeSendOnboarding(from);
        }

        if (msg.type === "audio") {
          return handleIncomingAudioMessage(msg, value, {
            sendText,
            sendButtons,
            getSession,
          });
        }

        if (msg.type === "image") {
          return handleIncomingImage(from, msg);
        }

        if (msg.type === "interactive") {
          const replyId =
            msg?.interactive?.button_reply?.id ||
            msg?.interactive?.list_reply?.id;

          if (replyId) {
            const handledProfileReply = await handleProfileReply(from, replyId);
            if (handledProfileReply) return;

            return handleInteractiveReply(from, replyId);
          }

          return sendText(
            from,
            "⚠️ Je n’ai pas pu ouvrir cette option.\nTapez MENU pour continuer."
          );
        }

        if (msg.type === "text") {
          const text = msg?.text?.body || "";
          const t = norm(text).toLowerCase();

          console.log("[KADI/TEXT] raw:", text, "| norm:", t);

          if (await handleUltraPriorityText(from, text)) return;
          if (await handleSmallTalk(from, text)) return;

          await maybeSendOnboarding(from);

          if (await handleCommand(from, text, { wa_id: from })) return;

          const s = getSession(from);

          console.log("[KADI/ENGINE] checking intent-fix gate", {
            from,
            step: s?.step || null,
            hasIntent: !!s?.intent,
          });

          if (
            s?.step === "intent_fix_price" ||
            s?.step === "intent_fix_client" ||
            s?.step === "intent_fix_items" ||
            s?.step === "intent_fix"
          ) {
            const handledIntentFix = await handleIntentFixText(from, text);
            if (handledIntentFix) return;

            await sendText(
              from,
              "⚠️ Je complète encore votre document.\nRépondez à la question demandée ou tapez MENU."
            );
            return;
          }

          if (await tryHandleDechargeConfirmation(from, text)) return;
          if (await handleProfileText(from, text, msg)) return;
          if (await handleStampFlow(from, text)) return;

          if (await tryHandleNaturalMessage(from, text)) return;
          if (await handleSmartItemsBlockText(from, text)) return;
          if (await handleProductFlowText(from, text)) return;

          return sendText(
            from,
            "🤔 Je n’ai pas bien compris.\n\n" +
              "💡 Exemple :\n" +
              "Devis pour Moussa, 2 portes à 25000\n\n" +
              "Ou tapez MENU"
          );
        }

        return sendText(
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

module.exports = {
  handleIncomingMessage,
  handleIncomingStatuses,
  processDevisFollowups,
};