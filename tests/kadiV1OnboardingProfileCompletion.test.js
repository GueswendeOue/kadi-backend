"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateActionPayload,
} = require("../kadiV1FlowReplyRuntime");
const {
  createKadiV1FlowCommandRuntime,
} = require("../kadiV1FlowCommandRuntime");
const {
  createKadiV1OnboardingRuntimeAdapter,
} = require("../kadiV1RuntimeAdapters");
const {
  createSupabaseOnboardingProfileCompleter,
  validateProfileData,
} = require("../kadiV1SupabaseOnboardingProfileCompleter");
const {
  createKadiV1ProductionPresenter,
  nextFlowForReply,
} = require("../kadiV1ProductionPresenter");

const OWNER = "22670626055";

function passiveCommandDependencies(onboardingRuntime) {
  const noop = async () => ({ ok: true, value: {} });
  return {
    onboardingRuntime,
    documentRuntime: {
      start: noop,
      setClient: noop,
      addContent: noop,
      updateContent: noop,
      removeContent: noop,
      setOptions: noop,
      verify: noop,
      beginEdit: noop,
      saveForLater: noop,
      saveDischargeDetails: noop,
      cancel: noop,
    },
    previewRuntime: { prepare: noop },
    generationRuntime: { confirm: noop },
    rechargeRuntime: {
      selectPack: noop,
      checkPayment: noop,
      cancel: noop,
    },
    historyRuntime: {
      search: noop,
      open: noop,
    },
    walletRuntime: {
      getBalance: async () => ({
        ok: true,
        value: { credits: 5 },
      }),
    },
  };
}

test("ONBOARDING Flow displays profile fields before completion", () => {
  const flowPath = path.join(
    __dirname,
    "..",
    "flows",
    "v1_draft",
    "kadi_onboarding_v1.json"
  );
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const screen = flow.screens.find((entry) => entry.id === "ONBOARDING");
  const form = screen.layout.children.find((entry) => entry.type === "Form");
  const owner = form.children.find((entry) => entry.name === "owner_name");
  const business = form.children.find((entry) => entry.name === "business_name");
  const footer = form.children.find((entry) => entry.type === "Footer");

  assert.equal(screen.terminal, true);
  assert.equal(owner.required, true);
  assert.equal(business.required, false);
  assert.equal(footer["on-click-action"].payload.action, "START");
  assert.deepEqual(
    Object.keys(footer["on-click-action"].payload.data).sort(),
    ["business_name", "owner_name"]
  );
});

test("ONBOARDING START accepts only approved profile fields", () => {
  assert.equal(
    validateActionPayload("ONBOARDING", "START", {
      owner_name: "Philippe",
      business_name: "Atelier Philippe",
    }).ok,
    true
  );

  assert.deepEqual(
    validateActionPayload("ONBOARDING", "START", {
      owner_name: "Philippe",
      credits: 999,
    }),
    {
      ok: false,
      error: "KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN",
    }
  );
});

test("profile validation requires a real owner name", () => {
  assert.deepEqual(
    validateProfileData({
      owner_name: " ",
      business_name: "",
    }),
    {
      ok: false,
      error: "KADI_V1_ONBOARDING_OWNER_NAME_REQUIRED",
    }
  );

  assert.deepEqual(
    validateProfileData({
      owner_name: "  Philippe   Ouedraogo ",
      business_name: " Kadi AI ",
    }).value,
    {
      owner_name: "Philippe Ouedraogo",
      business_name: "Kadi AI",
    }
  );
});

test("profile validation rejects non-string field values", () => {
  assert.deepEqual(
    validateProfileData({
      owner_name: 123,
      business_name: "Atelier",
    }),
    {
      ok: false,
      error: "KADI_V1_ONBOARDING_OWNER_NAME_REQUIRED",
    }
  );

  assert.deepEqual(
    validateProfileData({
      owner_name: "Philippe",
      business_name: { label: "Atelier" },
    }),
    {
      ok: false,
      error: "KADI_V1_ONBOARDING_BUSINESS_NAME_INVALID",
    }
  );
});

test("profile validation rejects overlong values instead of truncating them", () => {
  assert.deepEqual(
    validateProfileData({
      owner_name: "A".repeat(81),
      business_name: "",
    }),
    {
      ok: false,
      error: "KADI_V1_ONBOARDING_OWNER_NAME_INVALID",
    }
  );

  assert.deepEqual(
    validateProfileData({
      owner_name: "Philippe",
      business_name: "B".repeat(121),
    }),
    {
      ok: false,
      error: "KADI_V1_ONBOARDING_BUSINESS_NAME_INVALID",
    }
  );
});

test("START sends profile data to the onboarding runtime", async () => {
  const calls = [];
  const runtime = createKadiV1FlowCommandRuntime(
    passiveCommandDependencies({
      continueOnboarding: async (payload) => {
        calls.push(payload);
        return {
          ok: true,
          value: { next_flow_key: "MENU" },
        };
      },
    })
  );

  const result = await runtime.execute({
    ownerWaId: OWNER,
    flowKey: "ONBOARDING",
    action: "START",
    data: {
      owner_name: "Philippe",
      business_name: "Atelier Philippe",
    },
    idempotencyKey: "flow_command:profile:1",
    documentContext: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    ownerWaId: OWNER,
    idempotencyKey: "flow_command:profile:1",
    profileData: {
      owner_name: "Philippe",
      business_name: "Atelier Philippe",
    },
  }]);
});

test("Supabase completer uses one atomic RPC and routes to MENU", async () => {
  const calls = [];
  const client = {
    rpc: async (name, parameters) => {
      calls.push({ name, parameters });
      return {
        data: {
          ok: true,
          duplicate: false,
          profile: {
            wa_id: OWNER,
            owner_name: "Philippe",
            business_name: "Atelier Philippe",
            onboarding_status: "COMPLETED",
          },
        },
        error: null,
      };
    },
  };

  const completer = createSupabaseOnboardingProfileCompleter({ client });
  const result = await completer.complete({
    ownerWaId: OWNER,
    profileData: {
      owner_name: " Philippe ",
      business_name: " Atelier Philippe ",
    },
    idempotencyKey: "flow_command:profile:1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.next_flow_key, "MENU");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "kadi_v1_complete_onboarding_profile");
  assert.equal(calls[0].parameters.p_owner_name, "Philippe");
  assert.equal(calls[0].parameters.p_business_name, "Atelier Philippe");
  assert.match(
    calls[0].parameters.p_idempotency_key,
    /^onboarding_profile:[a-f0-9]{40}$/
  );
});

test("runtime adapter does not call the old immediate completion path", async () => {
  let oldCompletionCalls = 0;
  const profileCalls = [];

  const adapter = createKadiV1OnboardingRuntimeAdapter({
    onboardingService: {
      onboardNewUser: async () => ({ ok: true }),
      getOnboardingState: async () => ({
        ok: true,
        value: { welcome_credits_granted: true },
      }),
      completeOnboarding: async () => {
        oldCompletionCalls += 1;
        return { ok: true, value: {} };
      },
    },
    profileCompleter: {
      complete: async (payload) => {
        profileCalls.push(payload);
        return {
          ok: true,
          value: {
            profile: {
              owner_name: "Philippe",
              onboarding_status: "COMPLETED",
            },
            next_flow_key: "MENU",
          },
        };
      },
    },
  });

  const result = await adapter.continueOnboarding({
    ownerWaId: OWNER,
    profileData: { owner_name: "Philippe" },
    idempotencyKey: "flow_command:profile:1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.next_flow_key, "MENU");
  assert.equal(oldCompletionCalls, 0);
  assert.equal(profileCalls.length, 1);
});

test("START transition opens MENU after the saved profile", async () => {
  assert.equal(
    nextFlowForReply("START", { next_flow_key: "MENU" }),
    "MENU"
  );

  const texts = [];
  const flows = [];
  const presenter = createKadiV1ProductionPresenter({
    config: {
      enabled: true,
      flowIds: {
        MENU: "1234567890",
      },
    },
    whatsappApi: {
      sendText: async (to, text) => {
        texts.push({ to, text });
      },
      sendFlow: async (payload) => {
        flows.push(payload);
      },
    },
    sessionService: {
      open: async () => ({
        ok: true,
        value: {
          session_id: "session:profile:menu",
        },
      }),
    },
    flowMode: "draft",
  });

  const presented = await presenter.presentFlowReply({
    ownerWaId: OWNER,
    messageId: "wamid.profile.1",
    result: {
      handled: true,
      action: "START",
      duplicate: false,
      result: {
        next_flow_key: "MENU",
      },
    },
  });

  assert.equal(presented.text_sent, true);
  assert.equal(presented.flow_sent, true);
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /profil est enregistré/i);
  assert.match(texts[0].text, /voulez-vous préparer/i);
  assert.equal(flows.length, 1);
});
