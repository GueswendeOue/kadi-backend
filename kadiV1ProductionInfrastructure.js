"use strict";

const crypto = require("node:crypto");

const OWNER_PATTERN = /^\d{8,20}$/;
const ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const PRIVATE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{2,62}$/;
const STORAGE_PREFIX = "kadi-v1-private:";

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

  return Object.freeze({
    async deliverDocument({
      finalFile,
      destinationRef,
      deliveryAttemptId,
    } = {}) {
      if (!ID_PATTERN.test(finalFile?.document_id || "")) {
        return fail("DELIVERY_DOCUMENT_INVALID");
      }
      const document = await supabase
        .from("kadi_v1_documents")
        .select("owner_wa_id,document_type")
        .eq("document_id", finalFile.document_id)
        .maybeSingle();
      const ownerWaId = document?.data?.owner_wa_id;
      const expectedDestination = OWNER_PATTERN.test(ownerWaId || "")
        ? `owner:${digest(ownerWaId).slice(0, 12)}`
        : null;
      if (
        document?.error ||
        !expectedDestination ||
        expectedDestination !== destinationRef
      ) {
        return fail("DELIVERY_DESTINATION_MISMATCH");
      }
      const bytes = await storage.readFinal(finalFile.storage_ref);
      if (!bytes.ok) return bytes;
      const uploaded = await whatsappApi.uploadMediaBuffer({
        buffer: bytes.value,
        mimeType: "application/pdf",
        filename: `${String(document.data.document_type || "document").toLowerCase()}.pdf`,
      });
      const mediaId = uploaded?.id || uploaded?.media_id;
      if (!mediaId) return fail("DELIVERY_MEDIA_UPLOAD_FAILED");
      const sent = await whatsappApi.sendDocument({
        to: ownerWaId,
        mediaId,
        filename: `${String(document.data.document_type || "document").toLowerCase()}.pdf`,
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
  createKadiV1BalanceReader,
  createKadiV1IssuerResolver,
  createKadiV1RechargeRuntime,
  createKadiV1WhatsAppDeliveryProvider,
  createManualOrangeMoneyPaymentProvider,
  createSupabasePrivateArtifactStorage,
  parseStorageRef,
};
