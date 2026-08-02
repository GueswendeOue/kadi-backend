"use strict";

const {
  WELCOME_CREDIT_AMOUNT,
  assertOnboardingRepository,
} = require("./kadiV1OnboardingRepository");
const { normalizeWaId } = require("./kadiV1UserProfile");

const WELCOME_TEXT = "Bienvenue chez Kadi 👋\n\nJe vous aide à préparer vos factures, devis, reçus et décharges directement sur WhatsApp.\n\nVous pouvez m’écrire, m’envoyer un vocal ou une photo.\n\n🎁 5 crédits viennent de vous être offerts pour commencer.";
const WELCOME_ACTION = "Commencer";

function fail(error) {
  return { ok: false, error };
}

function createWelcomeVoiceRequester({ requestVoice } = {}) {
  const requester = typeof requestVoice === "function"
    ? requestVoice
    : async () => ({ accepted: false, reason: "VOICE_PROVIDER_UNAVAILABLE" });
  return Object.freeze({
    request: ({ waId }) => requester({
      waId,
      validatedText: WELCOME_TEXT,
      locale: "fr-BF",
      idempotencyKey: `welcome_voice:${waId}:v1`,
    }),
  });
}

function createKadiV1OnboardingService({ repository, voiceRequester = createWelcomeVoiceRequester() }) {
  const storage = assertOnboardingRepository(repository);
  if (!voiceRequester || typeof voiceRequester.request !== "function") {
    throw new TypeError("WELCOME_VOICE_REQUESTER_REQUIRED");
  }

  const createOrGetMinimalProfile = (input) => storage.createOrGetMinimalProfile(input);
  const startOnboarding = (input) => storage.startOnboarding(input);
  const resumeOnboarding = (input) => storage.resumeOnboarding(input);
  const completeOnboarding = (input) => storage.completeOnboarding(input);
  const getOnboardingState = (input) => storage.getOnboardingState(input);

  async function requestWelcomeVoice(waId, { retry = false } = {}) {
    const requested = await storage.recordOnboardingEvent({
      waId,
      eventType: "WELCOME_VOICE_REQUESTED",
      idempotencyKey: `welcome_voice:${waId}:v1`,
      status: "REQUESTED",
    });
    if (!requested.ok) return { ok: false, error: requested.error, non_blocking: true };
    try {
      const result = await voiceRequester.request({ waId });
      return { ok: true, accepted: result?.accepted === true, duplicate: requested.duplicate, retry };
    } catch {
      await storage.recordOnboardingEvent({
        waId,
        eventType: "WELCOME_VOICE_FAILED",
        idempotencyKey: `welcome_voice_failure:${waId}:v1`,
        status: "FAILED",
      });
      return { ok: false, error: "WELCOME_VOICE_REQUEST_FAILED", non_blocking: true, retry };
    }
  }

  async function onboardNewUser({ waId, phoneNormalized = null }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    const profile = await createOrGetMinimalProfile({ waId: normalized, phoneNormalized });
    if (!profile.ok) return profile;
    let credits;
    try {
      credits = await storage.grantWelcomeCreditsAtomically({
        waId: normalized,
        idempotencyKey: `welcome_credits:${normalized}`,
      });
    } catch {
      return fail("WELCOME_CREDITS_GRANT_FAILED");
    }
    if (!credits.ok) return fail(credits.error);
    if (!credits.granted_now) {
      const started = await startOnboarding({ waId: normalized });
      if (!started.ok) return fail(started.error);
      return {
        ok: true,
        profile: started.value,
        welcome: null,
        credits_granted_now: false,
        duplicate: true,
      };
    }
    const textReady = await storage.recordOnboardingEvent({
      waId: normalized,
      eventType: "WELCOME_TEXT_READY",
      idempotencyKey: `welcome_text:${normalized}:v1`,
    });
    if (!textReady.ok) return fail(textReady.error);
    const voice = await requestWelcomeVoice(normalized);
    const started = await startOnboarding({ waId: normalized });
    if (!started.ok) return fail(started.error);
    return {
      ok: true,
      profile: started.value,
      credits_granted_now: true,
      credits: WELCOME_CREDIT_AMOUNT,
      welcome: Object.freeze({ text: WELCOME_TEXT, action: WELCOME_ACTION, voice }),
    };
  }

  async function retryWelcomeVoice({ waId }) {
    const normalized = normalizeWaId(waId);
    if (!normalized) return fail("V1_PROFILE_WA_ID_INVALID");
    const state = await getOnboardingState({ waId: normalized });
    if (!state.ok || !state.value.welcome_credits_granted) {
      return fail("WELCOME_VOICE_NOT_ELIGIBLE");
    }
    return requestWelcomeVoice(normalized, { retry: true });
  }

  return Object.freeze({
    completeOnboarding,
    createOrGetMinimalProfile,
    getOnboardingState,
    onboardNewUser,
    resumeOnboarding,
    retryWelcomeVoice,
    startOnboarding,
  });
}

module.exports = {
  WELCOME_ACTION,
  WELCOME_TEXT,
  createKadiV1OnboardingService,
  createWelcomeVoiceRequester,
};
