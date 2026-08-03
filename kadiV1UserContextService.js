"use strict";

const ACTIVE_DOCUMENT_STATES = Object.freeze([
  "COLLECTING",
  "INCOMPLETE",
  "READY_FOR_REVIEW",
  "VERIFIED",
  "PREVIEW_READY",
  "COST_CALCULATED",
  "AWAITING_GENERATION_CONFIRMATION",
  "RECHARGE_REQUIRED",
  "GENERATION_IN_PROGRESS",
  "GENERATED",
  "RECOVERABLE_FAILURE",
]);

const OWNER_PATTERN = /^\d{8,20}$/;

function ok(value) {
  return { ok: true, value };
}

function fail(error) {
  return { ok: false, error };
}

function assertMethod(target, method, name) {
  if (
    !target ||
    typeof target !== "object" ||
    typeof target[method] !== "function"
  ) {
    throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  }
  return target;
}

function createKadiV1UserContextService({
  client,
  onboardingRepository,
  documentRepository,
} = {}) {
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.from !== "function"
  ) {
    throw new TypeError("KADI_V1_USER_CONTEXT_SUPABASE_CLIENT_REQUIRED");
  }

  const profiles = assertMethod(
    onboardingRepository,
    "getOnboardingState",
    "KADI_V1_USER_CONTEXT_ONBOARDING_REPOSITORY"
  );

  const documents = assertMethod(
    documentRepository,
    "getDocumentById",
    "KADI_V1_USER_CONTEXT_DOCUMENT_REPOSITORY"
  );

  async function findActiveDocument(ownerWaId) {
    const { data, error } = await client
      .from("kadi_v1_documents")
      .select(
        "document_id,status,active_version,updated_at,created_at"
      )
      .eq("owner_wa_id", ownerWaId)
      .in("status", ACTIVE_DOCUMENT_STATES)
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return fail("KADI_V1_USER_CONTEXT_ACTIVE_DOCUMENT_LOOKUP_FAILED");
    }

    if (!data) return ok(null);

    const loaded = await documents.getDocumentById({
      documentId: data.document_id,
      ownerWaId,
    });

    if (!loaded?.ok) {
      return fail("KADI_V1_USER_CONTEXT_ACTIVE_DOCUMENT_LOAD_FAILED");
    }

    if (
      !loaded.value ||
      loaded.value.document_id !== data.document_id ||
      loaded.value.version !== data.active_version ||
      loaded.value.status !== data.status
    ) {
      return fail("KADI_V1_USER_CONTEXT_ACTIVE_DOCUMENT_MISMATCH");
    }

    return ok(loaded.value);
  }

  async function getContext({ ownerWaId } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) {
      return fail("KADI_V1_USER_CONTEXT_OWNER_INVALID");
    }

    const profile = await profiles.getOnboardingState({
      waId: ownerWaId,
    });

    if (!profile?.ok) {
      if (profile?.error === "V1_PROFILE_NOT_FOUND") {
        return ok(
          Object.freeze({
            profile: null,
            is_new: true,
            active_document: null,
          })
        );
      }

      return fail("KADI_V1_USER_CONTEXT_PROFILE_LOAD_FAILED");
    }

    const active = await findActiveDocument(ownerWaId);
    if (!active.ok) return active;

    return ok(
      Object.freeze({
        profile: profile.value,
        is_new: false,
        active_document: active.value,
      })
    );
  }

  return Object.freeze({
    getContext,
  });
}

module.exports = {
  ACTIVE_DOCUMENT_STATES,
  createKadiV1UserContextService,
};
