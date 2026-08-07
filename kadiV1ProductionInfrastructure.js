"use strict";

const crypto = require("node:crypto");
const { canonicalFinalFilename } = require("./kadiV1FinalFilename");

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const PRIVATE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{2,62}$/;
const STORAGE_PREFIX = "kadi-v1-private:";

// A real production incident (fiche R, KADI_ENGINEERING_MEMORY.md) traced
// two independent delivery failures — one on the founder's own CANARY
// document, one on a freshly-generated document minutes after this fix was
// deployed — both to a single-shot Supabase read of the destination owner
// failing or returning no row, with the whole delivery attempt then failing
// closed before ever contacting Meta. Bounded, retried only for this one
// read; never applied to the Meta send itself, and never used to override a
// genuine mismatch once the destination has actually been resolved.
const DESTINATION_LOOKUP_MAX_ATTEMPTS = 3;
const DESTINATION_LOOKUP_RETRY_DELAY_MS = 75;
// Errors shaped like a permission/schema problem are not transient — no
// number of retries will make them succeed, so retrying them only delays an
// inevitable, honestly-classified failure. Everything else defaults to
// retryable: an unrecognized error is far more likely to be a transient
// network/timeout condition than a new permanent failure mode.
const PERMANENT_LOOKUP_ERROR_CODES = new Set([
  "42501", // insufficient_privilege
  "42P01", // undefined_table
  "PGRST301", // JWT/auth
  "PGRST202", // schema cache / function or column not found
]);

function isTransientLookupError(error) {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : null;
  return !(code && PERMANENT_LOOKUP_ERROR_CODES.has(code));
}

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "missing"), "utf8")
    .digest("hex");
}

function safeSegment(value) {
  return digest(value).slice(0, 40);
}

function assertSupabaseClient(client) {
  if (
    !client ||
    typeof client.from !== "function" ||
    typeof client.rpc !== "function" ||
    !client.storage ||
    typeof client.storage.from !== "function"
  ) {
    throw new TypeError("KADI_V1_SUPABASE_CLIENT_REQUIRED");
  }
  return client;
}

function parseStorageRef(storageRef, expectedBucket) {
  if (
    typeof storageRef !== "string" ||
    !storageRef.startsWith(STORAGE_PREFIX)
  ) {
    return null;
  }
  const encoded = storageRef.slice(STORAGE_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator < 1) return null;
  const bucket = encoded.slice(0, separator);
  const path = encoded.slice(separator + 1);
  if (bucket !== expectedBucket || !path || path.includes("..")) return null;
  return { bucket, path };
}

function bufferFromDownload(data) {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data && typeof data.arrayBuffer === "function") {
    return data.arrayBuffer().then((value) => Buffer.from(value));
  }
  return null;
}

function createSupabasePrivateArtifactStorage({
  client,
  bucket,
  privateBucketConfirmed = false,
} = {}) {
  const supabase = assertSupabaseClient(client);
  const bucketName = String(bucket || "").trim().toLowerCase();
  if (!PRIVATE_BUCKET_PATTERN.test(bucketName)) {
    throw new TypeError("KADI_V1_PRIVATE_BUCKET_INVALID");
  }
  if (privateBucketConfirmed !== true) {
    throw new TypeError("KADI_V1_PRIVATE_BUCKET_CONFIRMATION_REQUIRED");
  }
  const storage = supabase.storage.from(bucketName);
  if (
    !storage ||
    typeof storage.upload !== "function" ||
    typeof storage.download !== "function" ||
    typeof storage.remove !== "function"
  ) {
    throw new TypeError("KADI_V1_PRIVATE_STORAGE_API_REQUIRED");
  }

  const refFor = (path) => `${STORAGE_PREFIX}${bucketName}:${path}`;

  async function upload(path, buffer, mimeType, { upsert = false } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return fail("KADI_V1_PRIVATE_STORAGE_BUFFER_INVALID");
    }
    const result = await storage.upload(path, buffer, {
      contentType: mimeType || "application/octet-stream",
      upsert,
    });
    if (result?.error) return fail("KADI_V1_PRIVATE_STORAGE_UPLOAD_FAILED");
    return ok({
      storage_ref: refFor(path),
      publicly_accessible: false,
    });
  }

  async function download(storageRef, notFoundCode) {
    const parsed = parseStorageRef(storageRef, bucketName);
    if (!parsed) return fail("KADI_V1_PRIVATE_STORAGE_REFERENCE_INVALID");
    const result = await storage.download(parsed.path);
    if (result?.error || result?.data == null) return fail(notFoundCode);
    const maybeBuffer = bufferFromDownload(result.data);
    const buffer = maybeBuffer && typeof maybeBuffer.then === "function"
      ? await maybeBuffer
      : maybeBuffer;
    return Buffer.isBuffer(buffer) && buffer.length > 0
      ? ok(buffer)
      : fail(notFoundCode);
  }

  async function remove(storageRef) {
    const parsed = parseStorageRef(storageRef, bucketName);
    if (!parsed) return fail("KADI_V1_PRIVATE_STORAGE_REFERENCE_INVALID");
    const result = await storage.remove([parsed.path]);
    return result?.error
      ? fail("KADI_V1_PRIVATE_STORAGE_DELETE_FAILED")
      : ok(true);
  }

  async function putPrivate({ renderId, buffer, mimeType }) {
    if (!ID_PATTERN.test(renderId || "")) {
      return fail("TEMPORARY_RENDER_ID_INVALID");
    }
    const path = `temporary/renders/${safeSegment(renderId)}.pdf`;
    const stored = await upload(path, buffer, mimeType, { upsert: false });
    return stored.ok
      ? ok({
          ...stored.value,
          storage_zone: "TEMPORARY_PRIVATE",
        })
      : stored;
  }

  async function readPrivate(storageRef) {
    const loaded = await download(
      storageRef,
      "TEMPORARY_RENDER_BYTES_NOT_FOUND"
    );
    return loaded.ok
      ? ok({ buffer: loaded.value, mime_type: "application/pdf" })
      : loaded;
  }

  async function deletePrivate(storageRef) {
    return remove(storageRef);
  }

  async function isPrivate(storageRef) {
    return ok(Boolean(parseStorageRef(storageRef, bucketName)));
  }

  async function putStaging({ generationAttemptId, buffer, mimeType }) {
    if (!ID_PATTERN.test(generationAttemptId || "")) {
      return fail("FINAL_STAGING_INPUT_INVALID");
    }
    const path = `staging/generation/${safeSegment(generationAttemptId)}.pdf`;
    return upload(path, buffer, mimeType, { upsert: false });
  }

  async function readStaging(storageRef) {
    return download(storageRef, "FINAL_STAGING_NOT_FOUND");
  }

  async function deleteStaging(storageRef) {
    return remove(storageRef);
  }

  async function promote({ stagingRef, finalFileId }) {
    if (!ID_PATTERN.test(finalFileId || "")) {
      return fail("FINAL_FILE_ID_INVALID");
    }
    const staged = await readStaging(stagingRef);
    if (!staged.ok) return staged;
    const path = `final/documents/${safeSegment(finalFileId)}.pdf`;
    const stored = await upload(
      path,
      staged.value,
      "application/pdf",
      { upsert: false }
    );
    if (!stored.ok) return stored;
    const removed = await deleteStaging(stagingRef);
    if (!removed.ok) {
      return fail("FINAL_STAGING_DELETE_FAILED");
    }
    return stored;
  }

  async function readFinal(storageRef) {
    return download(storageRef, "FINAL_FILE_BYTES_NOT_FOUND");
  }

  return Object.freeze({
    putPrivate,
    readPrivate,
    deletePrivate,
    isPrivate,
    putStaging,
    readStaging,
    deleteStaging,
    promote,
    readFinal,
    readiness: Object.freeze({
      ready: true,
      bucket: bucketName,
      operator_confirmed_private: true,
      boot_external_calls: 0,
    }),
  });
}

function normalizeIssuerProfileRow(row) {
  const ownerName = typeof row?.owner_name === "string" ? row.owner_name.trim() : "";
  const businessName = typeof row?.business_name === "string" ? row.business_name.trim() : "";
  if (!ownerName && !businessName) return null;
  const optionalText = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return Object.freeze({
    business_name: businessName || ownerName,
    owner_name: ownerName || null,
    address: optionalText(row?.address),
    phone: optionalText(row?.phone),
    email: optionalText(row?.email),
    // Logo metadata only — never a signed URL or byte content. Consumed
    // exclusively by createKadiV1IssuerLogoLoader, which is the single
    // place that turns logo_path into bytes.
    logo_path: optionalText(row?.logo_path),
    no_logo: row?.no_logo === true,
  });
}

function createKadiV1IssuerResolver({ client } = {}) {
  const supabase = assertSupabaseClient(client);
  return Object.freeze({
    async getIssuerProfileId({ ownerWaId } = {}) {
      if (!OWNER_PATTERN.test(ownerWaId || "")) {
        return fail("KADI_V1_ISSUER_OWNER_INVALID");
      }
      const result = await supabase
        .from("business_profiles")
        .select("id")
        .eq("wa_id", ownerWaId)
        .maybeSingle();
      const id = result?.data?.id;
      return result?.error || !ID_PATTERN.test(String(id || ""))
        ? fail("KADI_V1_ISSUER_NOT_CONFIGURED")
        : ok({ issuerProfileId: String(id) });
    },
    // Resolves the human-facing identity (owner_name / business_name and
    // optional contact fields) for a persisted issuer_profile_id, in the
    // exact shape pdf/kadiPdfLayoutCommon.js:drawBusinessHeader expects
    // (business_name/address/phone/email). No renderer ever queries
    // Supabase itself: this is the single place that does.
    async getIssuerProfileById({ issuerProfileId } = {}) {
      if (!ID_PATTERN.test(issuerProfileId || "")) {
        return fail("KADI_V1_ISSUER_PROFILE_ID_INVALID");
      }
      const result = await supabase
        .from("business_profiles")
        .select("*")
        .eq("id", issuerProfileId)
        .maybeSingle();
      if (result?.error) return fail("KADI_V1_ISSUER_PROFILE_LOOKUP_FAILED");
      const normalized = normalizeIssuerProfileRow(result?.data);
      return normalized ? ok(normalized) : fail("KADI_V1_ISSUER_PROFILE_NOT_FOUND");
    },
  });
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_OBJECT_PATH_PATTERN = /^[A-Za-z0-9._/-]{1,300}$/;
// Closed allowlist only: business_profiles.logo_path was historically
// written by two different legacy modules (store.js -> "logos",
// supabaseStorage.js -> "kadi-logos"), so existing rows may point into
// either bucket with an identical bare-path shape. The loader must never
// search outside this fixed list.
const APPROVED_LOGO_BUCKETS = Object.freeze(["logos", "kadi-logos"]);
const LOGO_BUCKET_PREFIX_PATTERN = /^([a-z0-9][a-z0-9._-]{2,62}):(.+)$/;

function detectLogoImageType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  return null;
}

// Server-side only. Turns a business_profiles.logo_path into image bytes
// for the compact (TICKET_80) receipt renderer. Never exposes the storage
// path, a signed URL or the service-role key to the caller; every failure
// path (missing logo, unreadable file, unsupported type, oversized file)
// resolves to "no logo" rather than throwing, so a bad logo never blocks
// PDF generation.
function createKadiV1IssuerLogoLoader({ client, buckets = APPROVED_LOGO_BUCKETS, logger = null } = {}) {
  const supabase = assertSupabaseClient(client);
  const requested = Array.isArray(buckets) && buckets.length > 0 ? buckets : APPROVED_LOGO_BUCKETS;
  const normalizedBuckets = requested.map((value) => String(value || "").trim().toLowerCase());
  for (const bucketName of normalizedBuckets) {
    if (!PRIVATE_BUCKET_PATTERN.test(bucketName) || !APPROVED_LOGO_BUCKETS.includes(bucketName)) {
      throw new TypeError("KADI_V1_LOGO_BUCKET_INVALID");
    }
  }
  const storagesByBucket = new Map(normalizedBuckets.map((bucketName) => [bucketName, supabase.storage.from(bucketName)]));
  for (const storage of storagesByBucket.values()) {
    if (!storage || typeof storage.download !== "function") {
      throw new TypeError("KADI_V1_LOGO_STORAGE_API_REQUIRED");
    }
  }

  function safeLog(code) {
    try {
      logger?.log?.("KADI_V1_LOGO_LOADER", Object.freeze({
        event: "LOGO_LOAD_SKIPPED",
        code: typeof code === "string" ? code.slice(0, 80) : "UNKNOWN",
      }));
    } catch {
      // Logo loading is never allowed to fail the render because of a
      // logging problem.
    }
  }

  // Resolves which bucket(s) to try for a given logo_path, without ever
  // stepping outside the approved allowlist:
  // - "<bucket>:<object path>" is honored only if <bucket> is allowlisted;
  // - a bare object path (the only shape either legacy uploader has ever
  //   written) is tried against every allowlisted bucket, in the given
  //   order, since the path alone cannot say which bucket it lives in.
  function resolveCandidates(logoPath) {
    const prefixMatch = LOGO_BUCKET_PREFIX_PATTERN.exec(logoPath);
    if (prefixMatch) {
      const bucketName = prefixMatch[1].toLowerCase();
      const objectPath = prefixMatch[2];
      if (!storagesByBucket.has(bucketName) || !LOGO_OBJECT_PATH_PATTERN.test(objectPath) || objectPath.includes("..")) {
        return [];
      }
      return [{ bucketName, objectPath }];
    }
    if (!LOGO_OBJECT_PATH_PATTERN.test(logoPath) || logoPath.includes("..")) return [];
    return normalizedBuckets.map((bucketName) => ({ bucketName, objectPath: logoPath }));
  }

  return Object.freeze({
    async getLogoBuffer({ issuerProfile } = {}) {
      if (!issuerProfile || issuerProfile.no_logo === true) return ok(null);
      const logoPath = issuerProfile.logo_path;
      if (typeof logoPath !== "string" || !logoPath) return ok(null);
      const candidates = resolveCandidates(logoPath);
      if (candidates.length === 0) return ok(null);

      for (const candidate of candidates) {
        const storage = storagesByBucket.get(candidate.bucketName);
        let downloaded;
        try {
          downloaded = await storage.download(candidate.objectPath);
        } catch {
          safeLog("KADI_V1_LOGO_DOWNLOAD_EXCEPTION");
          continue;
        }
        if (downloaded?.error || downloaded?.data == null) {
          safeLog("KADI_V1_LOGO_DOWNLOAD_FAILED");
          continue;
        }
        // Bytes were actually found at this candidate: this is the
        // authoritative source for this logo_path. A validation failure
        // from here on is terminal (no logo), not a reason to keep
        // guessing at other buckets.
        let buffer;
        try {
          const maybeBuffer = bufferFromDownload(downloaded.data);
          buffer = maybeBuffer && typeof maybeBuffer.then === "function" ? await maybeBuffer : maybeBuffer;
        } catch {
          safeLog("KADI_V1_LOGO_DECODE_FAILED");
          return ok(null);
        }
        if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > LOGO_MAX_BYTES) {
          safeLog("KADI_V1_LOGO_SIZE_INVALID");
          return ok(null);
        }
        if (!detectLogoImageType(buffer)) {
          safeLog("KADI_V1_LOGO_TYPE_UNSUPPORTED");
          return ok(null);
        }
        return ok(buffer);
      }
      return ok(null);
    },
  });
}

function createKadiV1BalanceReader({ rechargeRepository } = {}) {
  if (typeof rechargeRepository?.getBalance !== "function") {
    throw new TypeError("KADI_V1_RECHARGE_REPOSITORY_REQUIRED");
  }
  return Object.freeze({
    async getBalance({ ownerWaId } = {}) {
      if (!OWNER_PATTERN.test(ownerWaId || "")) {
        return fail("KADI_V1_BALANCE_OWNER_INVALID");
      }
      const result = await rechargeRepository.getBalance({ ownerWaId });
      const credits = Number(result?.value);
      return result?.ok === true && Number.isSafeInteger(credits) && credits >= 0
        ? ok({ credits })
        : fail(result?.error || "KADI_V1_BALANCE_INVALID");
    },
  });
}

function normalizeLegacyTopupStatus(status) {
  return ({
    pending: "PENDING",
    pending_review: "PENDING",
    approved: "CONFIRMED",
    rejected: "FAILED",
    cancelled: "CANCELLED",
    expired: "EXPIRED",
  })[String(status || "").trim().toLowerCase()] || "PENDING";
}

function createManualOrangeMoneyPaymentProvider({
  client,
  clock = () => new Date().toISOString(),
} = {}) {
  const supabase = assertSupabaseClient(client);
  const name = "MANUAL_ORANGE_MONEY";

  async function findSession(merchantReference) {
    const result = await supabase
      .from("kadi_v1_recharge_sessions")
      .select("owner_wa_id,pack_snapshot")
      .eq("merchant_reference", merchantReference)
      .maybeSingle();
    return result?.error || !result?.data
      ? fail("PAYMENT_SESSION_NOT_FOUND")
      : ok(result.data);
  }

  async function readTopup(reference) {
    const result = await supabase
      .from("kadi_topups")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();
    return result?.error || !result?.data
      ? fail("PAYMENT_STATUS_NOT_FOUND")
      : ok(result.data);
  }

  function paymentResult({ topup, merchantReference }) {
    const amount = Number(topup.amount_fcfa);
    return {
      provider: name,
      provider_payment_id: String(topup.reference),
      provider_event_id: `event:${safeSegment(
        `${topup.reference}:${topup.status}:${topup.updated_at || topup.created_at}`
      )}`,
      merchant_reference: merchantReference,
      amount,
      currency: "XOF",
      status: normalizeLegacyTopupStatus(topup.status),
      verified: true,
      occurred_at: new Date(
        topup.approved_at || topup.updated_at || topup.created_at || clock()
      ).toISOString(),
      metadata: {
        channel: "manual_orange_money",
      },
    };
  }

  return Object.freeze({
    name,
    async createPaymentRequest(request = {}) {
      if (
        !ID_PATTERN.test(request.merchant_reference || "") ||
        !Number.isSafeInteger(request.amount) ||
        request.amount < 1 ||
        request.currency !== "XOF"
      ) {
        return fail("PAYMENT_REQUEST_INVALID");
      }
      const session = await findSession(request.merchant_reference);
      if (!session.ok) return session;
      const existing = await readTopup(request.merchant_reference);
      if (existing.ok) {
        return ok(paymentResult({
          topup: existing.value,
          merchantReference: request.merchant_reference,
        }));
      }
      const credits = Number(session.value.pack_snapshot?.credits);
      const inserted = await supabase
        .from("kadi_topups")
        .insert({
          wa_id: session.value.owner_wa_id,
          reference: request.merchant_reference,
          amount_fcfa: request.amount,
          credits,
          payment_method: "orange_money",
          includes_stamp: false,
          status: "pending",
          proof_text: null,
          proof_image_url: null,
        })
        .select("*")
        .single();
      return inserted?.error || !inserted?.data
        ? fail("PAYMENT_REQUEST_CREATE_FAILED")
        : ok(paymentResult({
            topup: inserted.data,
            merchantReference: request.merchant_reference,
          }));
    },
    async verifyPaymentEvent(rawEvent) {
      const reference = rawEvent?.provider_payment_id || rawEvent?.reference;
      if (!ID_PATTERN.test(reference || "")) {
        return fail("PAYMENT_EVENT_INVALID");
      }
      const topup = await readTopup(reference);
      return topup.ok
        ? ok(paymentResult({
            topup: topup.value,
            merchantReference:
              rawEvent?.merchant_reference || reference,
          }))
        : topup;
    },
    async getPaymentStatus({ providerPaymentId, merchantReference } = {}) {
      const reference = providerPaymentId || merchantReference;
      if (!ID_PATTERN.test(reference || "")) {
        return fail("PAYMENT_STATUS_REFERENCE_INVALID");
      }
      const topup = await readTopup(reference);
      return topup.ok
        ? ok(paymentResult({
            topup: topup.value,
            merchantReference: merchantReference || reference,
          }))
        : topup;
    },
  });
}

function createKadiV1RechargeRuntime({
  rechargeService,
  rechargeRepository,
  paymentProvider,
  client,
  orangeMoneyNumber,
  orangeMoneyName,
} = {}) {
  const supabase = assertSupabaseClient(client);
  const omNumber = String(orangeMoneyNumber || "").replace(/[^0-9]/g, "");
  const omName = String(orangeMoneyName || "").trim();
  if (!OWNER_PATTERN.test(omNumber) || !omName || omName.length > 120) {
    throw new TypeError("KADI_V1_ORANGE_MONEY_CONFIG_REQUIRED");
  }
  for (const method of [
    "createRechargeSession",
    "initiatePayment",
    "confirmPaymentEvent",
    "cancelRechargeSession",
  ]) {
    if (typeof rechargeService?.[method] !== "function") {
      throw new TypeError(`KADI_V1_RECHARGE_SERVICE_METHOD_REQUIRED:${method}`);
    }
  }
  if (typeof rechargeRepository?.getRechargeSession !== "function") {
    throw new TypeError("KADI_V1_RECHARGE_REPOSITORY_REQUIRED");
  }
  if (typeof paymentProvider?.getPaymentStatus !== "function") {
    throw new TypeError("KADI_V1_PAYMENT_PROVIDER_REQUIRED");
  }

  async function selectPack({ ownerWaId, packId, idempotencyKey } = {}) {
    const created = await rechargeService.createRechargeSession({
      ownerWaId,
      packId,
      idempotencyKey,
    });
    if (!created?.ok) return created;
    const initiated = await rechargeService.initiatePayment({
      rechargeSessionId: created.value.recharge_session_id,
      ownerWaId,
    });
    if (!initiated?.ok) return initiated;
    return ok({
      recharge_session_id: initiated.value.recharge_session_id,
      payment_reference: initiated.value.provider_payment_id,
      merchant_reference: initiated.value.merchant_reference,
      status: initiated.value.status,
      pack: initiated.value.pack_snapshot,
      payment_instructions: {
        method: "ORANGE_MONEY",
        number: omNumber,
        name: omName,
        amount: initiated.value.pack_snapshot.amount,
        credits: initiated.value.pack_snapshot.credits,
        reference: initiated.value.provider_payment_id,
      },
      next_flow_key: "RECHARGE",
    }, { duplicate: created.duplicate === true || initiated.duplicate === true });
  }

  async function checkPayment({
    ownerWaId,
    paymentReference,
  } = {}) {
    const session = await rechargeRepository.getRechargeSession({
      rechargeSessionId: paymentReference,
    });
    const resolved = session?.ok
      ? session
      : await (async () => {
          const result = await paymentProvider.getPaymentStatus({
            providerPaymentId: paymentReference,
            merchantReference: paymentReference,
          });
          if (!result?.ok) return result;
          return rechargeRepository.getRechargeSession({
            rechargeSessionId: result.value.merchant_reference,
          });
        })();
    if (!resolved?.ok || resolved.value.owner_wa_id !== ownerWaId) {
      return fail("RECHARGE_SESSION_NOT_FOUND");
    }
    const status = await paymentProvider.getPaymentStatus({
      providerPaymentId: resolved.value.provider_payment_id,
      merchantReference: resolved.value.merchant_reference,
    });
    if (!status?.ok) return status;
    if (status.value.status !== "CONFIRMED") {
      return ok({
        recharge_session_id: resolved.value.recharge_session_id,
        payment_reference: resolved.value.provider_payment_id,
        status: status.value.status,
        credited: false,
        next_flow_key: "RECHARGE",
      });
    }
    const confirmed = await rechargeService.confirmPaymentEvent({
      rechargeSessionId: resolved.value.recharge_session_id,
      rawEvent: status.value,
    });
    return confirmed?.ok
      ? ok({
          recharge_session_id: confirmed.value.recharge_session_id,
          status: confirmed.value.status,
          credited: true,
          balance: confirmed.balance ?? null,
          next_flow_key: "MENU",
        }, { duplicate: confirmed.duplicate === true })
      : confirmed;
  }

  async function cancel({ ownerWaId } = {}) {
    if (!OWNER_PATTERN.test(ownerWaId || "")) {
      return fail("RECHARGE_CANCEL_OWNER_INVALID");
    }
    const lookup = await supabase
      .from("kadi_v1_recharge_sessions")
      .select("recharge_session_id")
      .eq("owner_wa_id", ownerWaId)
      .in("status", ["CREATED", "PAYMENT_PENDING"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rechargeSessionId = lookup?.data?.recharge_session_id;
    if (lookup?.error || !ID_PATTERN.test(rechargeSessionId || "")) {
      return fail("RECHARGE_SESSION_NOT_FOUND");
    }
    const result = await rechargeService.cancelRechargeSession({
      rechargeSessionId,
      ownerWaId,
    });
    return result?.ok
      ? result
      : fail(result?.error || "RECHARGE_CANCEL_FAILED");
  }

  return Object.freeze({ selectPack, checkPayment, cancel });
}

function createKadiV1WhatsAppDeliveryProvider({
  client,
  storage,
  whatsappApi,
  destinationLookupMaxAttempts = DESTINATION_LOOKUP_MAX_ATTEMPTS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const supabase = assertSupabaseClient(client);
  if (typeof storage?.readFinal !== "function") {
    throw new TypeError("KADI_V1_FINAL_STORAGE_REQUIRED");
  }
  for (const method of ["uploadMediaBuffer", "sendDocument"]) {
    if (typeof whatsappApi?.[method] !== "function") {
      throw new TypeError(`KADI_V1_WHATSAPP_API_METHOD_REQUIRED:${method}`);
    }
  }

  // Bounded retry around the destination-owner read only — never around the
  // Meta send itself, and never used to second-guess a genuine mismatch
  // once one has actually been observed. A permanent-shaped error (see
  // isTransientLookupError) exits immediately rather than exhausting the
  // full budget on a read that cannot possibly succeed.
  async function lookupDestinationOwner(documentId) {
    let result = null;
    for (let attempt = 0; attempt < destinationLookupMaxAttempts; attempt += 1) {
      result = await supabase
        .from("kadi_v1_documents")
        .select("owner_wa_id,document_type,options,document_number")
        .eq("document_id", documentId)
        .maybeSingle();
      if (!result?.error && result?.data) return ok(result.data);
      if (result?.error && !isTransientLookupError(result.error)) break;
      if (attempt < destinationLookupMaxAttempts - 1) await sleep(DESTINATION_LOOKUP_RETRY_DELAY_MS);
    }
    return fail("DELIVERY_DESTINATION_LOOKUP_FAILED");
  }

  return Object.freeze({
    async deliverDocument({
      finalFile,
      destinationRef,
      deliveryAttemptId,
    } = {}) {
      if (!ID_PATTERN.test(finalFile?.document_id || "")) {
        return fail("DELIVERY_DOCUMENT_INVALID");
      }
      // A failed or empty lookup means the destination could not be
      // verified at all — it must never be reported as a confirmed
      // mismatch (a real production incident traced this exact ambiguity:
      // a transient lookup failure and a genuine mismatch shared one error
      // code, making the two indistinguishable after the fact). Both still
      // fail closed; only the recorded reason differs.
      const document = await lookupDestinationOwner(finalFile.document_id);
      if (!document.ok) return document;
      const ownerWaId = document.value.owner_wa_id;
      const expectedDestination = OWNER_PATTERN.test(ownerWaId || "")
        ? `owner:${digest(ownerWaId).slice(0, 12)}`
        : null;
      // Not a lookup failure: the row was read successfully but the owner
      // field itself is absent/malformed — still fails closed, but this is
      // a data-integrity signal, never worth retrying (retrying the exact
      // same successful read would return the exact same row).
      if (!expectedDestination) return fail("DELIVERY_DESTINATION_LOOKUP_FAILED");
      if (expectedDestination !== destinationRef) return fail("DELIVERY_DESTINATION_MISMATCH");
      const deliveryFilename = canonicalFinalFilename({
        document_type: document.value.document_type,
        invoice_kind: document.value.options?.invoice_kind ?? null,
        document_number: document.value.document_number,
      });
      if (!deliveryFilename) return fail("DELIVERY_FILENAME_UNRESOLVED");
      const bytes = await storage.readFinal(finalFile.storage_ref);
      if (!bytes.ok) return bytes;
      const uploaded = await whatsappApi.uploadMediaBuffer({
        buffer: bytes.value,
        mimeType: "application/pdf",
        filename: deliveryFilename,
      });
      const mediaId = uploaded?.id || uploaded?.media_id;
      if (!mediaId) return fail("DELIVERY_MEDIA_UPLOAD_FAILED");
      const sent = await whatsappApi.sendDocument({
        to: ownerWaId,
        mediaId,
        filename: deliveryFilename,
        caption: "Votre document Kadi est prêt.",
      });
      const reference = sent?.messages?.[0]?.id || sent?.id || deliveryAttemptId;
      return ok({ reference: String(reference) });
    },
    async getDeliveryStatus() {
      return ok({ status: "UNKNOWN" });
    },
  });
}

module.exports = {
  STORAGE_PREFIX,
  APPROVED_LOGO_BUCKETS,
  DESTINATION_LOOKUP_MAX_ATTEMPTS,
  DESTINATION_LOOKUP_RETRY_DELAY_MS,
  createKadiV1BalanceReader,
  createKadiV1IssuerLogoLoader,
  createKadiV1IssuerResolver,
  createKadiV1RechargeRuntime,
  createKadiV1WhatsAppDeliveryProvider,
  createManualOrangeMoneyPaymentProvider,
  createSupabasePrivateArtifactStorage,
  parseStorageRef,
};
