"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  WELCOME_CREDIT_AMOUNT,
  WELCOME_LEDGER_TYPE,
  createInMemoryOnboardingRepository,
} = require("../kadiV1OnboardingRepository");
const { createSupabaseOnboardingRepository } = require("../kadiV1SupabaseOnboardingRepository");
const {
  WELCOME_ACTION,
  WELCOME_TEXT,
  createKadiV1OnboardingService,
  createWelcomeVoiceRequester,
} = require("../kadiV1WelcomeService");

const WA_ID = "22670000001";
const NOW = "2026-08-02T12:00:00.000Z";

function repository(options = {}) {
  return createInMemoryOnboardingRepository({ clock: () => NOW, ...options });
}

function service(repo, requestVoice = async () => ({ accepted: true })) {
  return createKadiV1OnboardingService({
    repository: repo,
    voiceRequester: createWelcomeVoiceRequester({ requestVoice }),
  });
}

test("creates a minimal profile with safe V1 defaults", async () => {
  const repo = repository();
  const result = await repo.createOrGetMinimalProfile({ waId: WA_ID });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.value, {
    wa_id: WA_ID,
    phone_normalized: null,
    onboarding_status: "IN_PROGRESS",
    welcome_credits_granted: false,
    welcome_credits_eligibility: "ELIGIBLE",
    voice_response_mode: "VOICE_WHEN_HELPFUL",
    locale: "fr-BF",
    created_at: NOW,
    updated_at: NOW,
  });
  const replay = await repo.createOrGetMinimalProfile({ waId: WA_ID, phoneNormalized: "22671111111" });
  assert.equal(replay.created, false);
  assert.equal(replay.value.phone_normalized, null);
  assert.equal(repo.inspect().profiles.length, 1);
});

test("grants exactly five credits with the canonical ledger type and key", async () => {
  const repo = repository();
  await repo.createOrGetMinimalProfile({ waId: WA_ID });
  const result = await repo.grantWelcomeCreditsAtomically({
    waId: WA_ID,
    idempotencyKey: `welcome_credits:${WA_ID}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.delta, WELCOME_CREDIT_AMOUNT);
  assert.equal(result.value.ledger_type, WELCOME_LEDGER_TYPE);
  assert.equal(result.value.idempotency_key, `welcome_credits:${WA_ID}`);
  assert.equal(repo.inspect().balances[WA_ID], 5);
});

test("replayed and concurrent grants create one ledger entry", async () => {
  const repo = repository();
  await repo.createOrGetMinimalProfile({ waId: WA_ID });
  const command = { waId: WA_ID, idempotencyKey: `welcome_credits:${WA_ID}` };
  const results = await Promise.all(Array.from({ length: 12 }, () => repo.grantWelcomeCreditsAtomically(command)));
  assert.equal(results.filter((entry) => entry.granted_now).length, 1);
  assert.equal(repo.inspect().ledger.length, 1);
  assert.equal(repo.inspect().balances[WA_ID], 5);
});

test("atomic grant failure leaves marker, balance, ledger and event unchanged", async () => {
  const repo = repository({ grantFailpoint: async () => { throw new Error("synthetic"); } });
  await repo.createOrGetMinimalProfile({ waId: WA_ID });
  await assert.rejects(repo.grantWelcomeCreditsAtomically({
    waId: WA_ID,
    idempotencyKey: `welcome_credits:${WA_ID}`,
  }));
  const state = repo.inspect();
  assert.equal(state.profiles[0].welcome_credits_granted, false);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.balances[WA_ID], undefined);
  assert.equal(state.events.some((entry) => entry.event_type === "WELCOME_CREDITS_GRANTED"), false);
});

test("a zero balance never makes a previously granted user eligible again", async () => {
  const repo = repository({
    initialProfiles: [{
      wa_id: WA_ID,
      phone_normalized: null,
      onboarding_status: "COMPLETED",
      welcome_credits_granted: true,
      welcome_credits_eligibility: "GRANTED",
      voice_response_mode: "TEXT_ONLY",
      locale: "fr-BF",
      created_at: NOW,
      updated_at: NOW,
    }],
    initialBalances: { [WA_ID]: 0 },
  });
  const result = await repo.grantWelcomeCreditsAtomically({ waId: WA_ID, idempotencyKey: `welcome_credits:${WA_ID}` });
  assert.equal(result.ok, true);
  assert.equal(result.granted_now, false);
  assert.equal(repo.inspect().balances[WA_ID], 0);
  assert.equal(repo.inspect().ledger.length, 0);
});

test("historical users with ambiguous eligibility are rejected fail-closed", async () => {
  const repo = repository({ initialProfiles: [{ wa_id: WA_ID }] });
  const result = await repo.grantWelcomeCreditsAtomically({ waId: WA_ID, idempotencyKey: `welcome_credits:${WA_ID}` });
  assert.deepEqual(result, { ok: false, error: "WELCOME_CREDITS_ELIGIBILITY_UNKNOWN" });
  assert.equal(repo.inspect().ledger.length, 0);
});

test("canonical welcome text is exposed only after confirmed credit grant", async () => {
  const repo = repository();
  const result = await service(repo).onboardNewUser({ waId: WA_ID });
  assert.equal(result.ok, true);
  assert.equal(result.credits_granted_now, true);
  assert.equal(result.welcome.text, WELCOME_TEXT);
  assert.equal(result.welcome.action, WELCOME_ACTION);
  assert.equal(WELCOME_ACTION, "Commencer");
  assert.match(WELCOME_TEXT, /🎁 5 crédits viennent de vous être offerts/);
  assert.equal(repo.inspect().ledger.length, 1);
  assert.deepEqual(repo.inspect().events.map((entry) => entry.event_type), [
    "USER_PROFILE_CREATED",
    "WELCOME_CREDITS_GRANTED",
    "WELCOME_TEXT_READY",
    "WELCOME_VOICE_REQUESTED",
    "ONBOARDING_STARTED",
  ]);
});

test("credit failure produces no welcome text, voice request or onboarding start", async () => {
  let voiceCalls = 0;
  const repo = repository({ grantFailpoint: async () => { throw new Error("synthetic"); } });
  const result = await service(repo, async () => { voiceCalls += 1; }).onboardNewUser({ waId: WA_ID });
  assert.deepEqual(result, { ok: false, error: "WELCOME_CREDITS_GRANT_FAILED" });
  assert.equal(voiceCalls, 0);
  const eventTypes = repo.inspect().events.map((entry) => entry.event_type);
  assert.equal(eventTypes.includes("WELCOME_TEXT_READY"), false);
  assert.equal(eventTypes.includes("ONBOARDING_STARTED"), false);
});

test("voice request receives only validated canonical text and its own key", async () => {
  let request;
  const repo = repository();
  const result = await service(repo, async (input) => { request = input; return { accepted: true }; })
    .onboardNewUser({ waId: WA_ID });
  assert.equal(result.ok, true);
  assert.deepEqual(request, {
    waId: WA_ID,
    validatedText: WELCOME_TEXT,
    locale: "fr-BF",
    idempotencyKey: `welcome_voice:${WA_ID}:v1`,
  });
});

test("voice failure is non-blocking and never rolls back credits or onboarding", async () => {
  const repo = repository();
  const result = await service(repo, async () => { throw new Error("synthetic"); }).onboardNewUser({ waId: WA_ID });
  assert.equal(result.ok, true);
  assert.equal(result.welcome.voice.non_blocking, true);
  assert.equal(repo.inspect().balances[WA_ID], 5);
  assert.equal((await repo.getOnboardingState({ waId: WA_ID })).value.onboarding_status, "IN_PROGRESS");
  assert.equal(repo.inspect().events.some((entry) => entry.event_type === "WELCOME_VOICE_FAILED"), true);
});

test("voice retry reuses its voice key and never grants credits again", async () => {
  let calls = 0;
  const repo = repository();
  const onboarding = service(repo, async () => { calls += 1; if (calls === 1) throw new Error("synthetic"); return { accepted: true }; });
  await onboarding.onboardNewUser({ waId: WA_ID });
  const retried = await onboarding.retryWelcomeVoice({ waId: WA_ID });
  assert.equal(retried.ok, true);
  assert.equal(retried.retry, true);
  assert.equal(calls, 2);
  assert.equal(repo.inspect().ledger.length, 1);
  assert.equal(repo.inspect().balances[WA_ID], 5);
  assert.equal(repo.inspect().events.filter((entry) => entry.event_type === "WELCOME_VOICE_REQUESTED").length, 1);
});

test("re-onboarding, completion and resume never mutate the wallet", async () => {
  const repo = repository();
  const onboarding = service(repo);
  await onboarding.onboardNewUser({ waId: WA_ID });
  await onboarding.completeOnboarding({ waId: WA_ID });
  await onboarding.resumeOnboarding({ waId: WA_ID });
  await onboarding.startOnboarding({ waId: WA_ID });
  await repo.recordOnboardingEvent({
    waId: WA_ID,
    eventType: "USER_REACTIVATED",
    idempotencyKey: `user_reactivated:${WA_ID}:v1`,
  });
  const replay = await onboarding.onboardNewUser({ waId: WA_ID });
  assert.equal(replay.credits_granted_now, false);
  assert.equal(replay.welcome, null);
  assert.equal(repo.inspect().ledger.length, 1);
  assert.equal(repo.inspect().balances[WA_ID], 5);
});

test("Supabase adapter delegates welcome credits to one atomic RPC", async () => {
  const calls = [];
  const client = {
    rpc: async (name, parameters) => {
      calls.push({ name, parameters });
      return { data: { ok: true, granted_now: true, duplicate: false, balance: 5 }, error: null };
    },
    from: () => { throw new Error("not used"); },
  };
  const repo = createSupabaseOnboardingRepository({ client });
  const result = await repo.grantWelcomeCreditsAtomically({ waId: WA_ID, idempotencyKey: `welcome_credits:${WA_ID}` });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    name: "kadi_v1_grant_welcome_credits",
    parameters: { p_wa_id: WA_ID, p_idempotency_key: `welcome_credits:${WA_ID}` },
  });
});

test("migration is additive, preserves historical ambiguity and uses the existing atomic wallet primitive", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "20260802_add_kadi_v1_onboarding.sql"), "utf8");
  assert.match(sql, /add column if not exists welcome_credits_eligibility text/i);
  assert.match(sql, /welcome_credits_eligibility is distinct from 'ELIGIBLE'/i);
  assert.match(sql, /public\.kadi_add_credits_v2/i);
  assert.match(sql, /p_amount\s*=>\s*5/i);
  assert.match(sql, /p_reason\s*=>\s*'WELCOME_CREDITS'/i);
  assert.match(sql, /p_operation_key\s*=>\s*p_idempotency_key/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.doesNotMatch(sql, /update\s+public\.business_profiles\s+set\s+welcome_credits_eligibility\s*=\s*'ELIGIBLE'/i);
  assert.doesNotMatch(sql, /(?:drop|truncate|delete\s+from)\s+/i);
});

test("new V1 modules have no Meta, PDF, AI, TTS, payment or webhook dependency", () => {
  const files = [
    "kadiV1UserProfile.js",
    "kadiV1OnboardingRepository.js",
    "kadiV1SupabaseOnboardingRepository.js",
    "kadiV1WelcomeService.js",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /require\(["']\.\/(?:whatsapp|kadiWhatsApp|kadiFlow|pdf|openai|gemini|billing|payment|index)/i, file);
    assert.doesNotMatch(source, /\/webhook|\/data_exchange|flow_id|phone_number_id/i, file);
  }
});
