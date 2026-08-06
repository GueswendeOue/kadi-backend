"use strict";

const crypto = require("node:crypto");
const { DOCUMENT_EVENTS, createDocumentDomain } = require("./kadiV1DocumentDomain");
const { assertV1DocumentRepository } = require("./kadiV1DocumentRepository");
const { assertV1PreviewRepository } = require("./kadiV1PreviewRepository");
const { assertGenerationLifecycleRepository } = require("./kadiV1GenerationLifecycleRepository");

const ok = (value, extra = {}) => ({ ok: true, value, ...extra });
const fail = (error) => ({ ok: false, error });
const valid = (value) => typeof value === "string" && /^[A-Za-z0-9:_.-]{1,200}$/.test(value);

function createGenerationLifecycleService({
  documentRepository, previewRepository, generationRepository, quoteService,
  walletReservationService, finalGenerationService, deliveryService,
  domain = createDocumentDomain(), clock = () => new Date().toISOString(), idFactory, observer = () => {},
} = {}) {
  const documents = assertV1DocumentRepository(documentRepository);
  const artifacts = assertV1PreviewRepository(previewRepository);
  const store = assertGenerationLifecycleRepository(generationRepository);
  for (const [name, dependency, methods] of [
    ["QUOTE_SERVICE", quoteService, ["validateGenerationQuote"]],
    ["WALLET_RESERVATION_SERVICE", walletReservationService, ["reserveCredits", "captureReservation", "releaseReservation", "getReservation"]],
    ["FINAL_GENERATION_SERVICE", finalGenerationService, ["generatePrivate", "discardPrivate", "markCaptured", "promoteFinal"]],
    ["DELIVERY_SERVICE", deliveryService, ["createDeliveryAttempt", "deliver", "retryDelivery", "reconcileStaleClaim"]],
  ]) for (const method of methods) if (typeof dependency?.[method] !== "function") throw new TypeError(`${name}_METHOD_REQUIRED:${method}`);
  const makeId = idFactory || ((kind, key) => `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`);
  if (typeof observer !== "function") throw new TypeError("GENERATION_OBSERVER_INVALID");
  const emit = (event, details = {}) => {
    try { observer(Object.freeze({ event, ...details })); } catch { /* observability never changes business outcome */ }
  };
  const confirmationQueues = new Map();

  async function serializeConfirmation(quoteId, operation) {
    const prior = confirmationQueues.get(quoteId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    confirmationQueues.set(quoteId, current);
    await prior;
    try { return await operation(); } finally {
      release();
      if (confirmationQueues.get(quoteId) === current) confirmationQueues.delete(quoteId);
    }
  }

  async function persistEvent(document, event, payload, key, eventType, ownerWaId) {
    const transitioned = domain.transitionDocument(document, event, payload);
    if (!transitioned.ok) return transitioned;
    return documents.persistTransition({ document: transitioned.value, ownerWaId, expectedVersion: document.version, fromState: document.status, eventType, idempotencyKey: key });
  }

  async function recordFailure(document, ownerWaId, code, key) {
    return persistEvent(document, DOCUMENT_EVENTS.RECORD_RECOVERABLE_FAILURE, { code }, key, "GENERATION_RECOVERABLE_FAILURE", ownerWaId);
  }

  async function validateConfirmation(command) {
    if (!valid(command?.documentId) || !valid(command?.ownerWaId) || !valid(command?.quoteId) || !valid(command?.idempotencyKey) ||
        !Number.isSafeInteger(command?.documentVersion) || command.documentVersion < 1 ||
        Object.hasOwn(command, "amount") || Object.hasOwn(command, "totalCredits") || Object.hasOwn(command, "total_credits")) {
      return fail("GENERATION_CONFIRMATION_INVALID");
    }
    const document = await documents.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!document.ok) return document;
    if (document.value.version !== command.documentVersion) return fail("DOCUMENT_VERSION_CONFLICT");
    if (document.value.status !== "AWAITING_GENERATION_CONFIRMATION") return fail("GENERATION_CONFIRMATION_STATE_INVALID");
    const quote = await quoteService.validateGenerationQuote({ quoteId: command.quoteId, ownerWaId: command.ownerWaId });
    if (!quote.ok) return quote;
    if (quote.value.document_id !== command.documentId || quote.value.document_version !== command.documentVersion || quote.value.status !== "ACTIVE") {
      return fail("GENERATION_QUOTE_MISMATCH");
    }
    const preview = await artifacts.getPreview({ previewId: quote.value.preview_id });
    const render = await artifacts.getTemporaryRender({ renderId: quote.value.temporary_render_id });
    if (!preview.ok || preview.value.status !== "ACTIVE" || !render.ok || render.value.status !== "INSPECTED" ||
        preview.value.document_id !== command.documentId || preview.value.document_version !== command.documentVersion ||
        render.value.preview_id !== preview.value.preview_id || render.value.page_count !== quote.value.page_count) {
      return fail("GENERATION_ARTIFACT_MISMATCH");
    }
    return ok({ document: document.value, quote: quote.value, preview: preview.value, render: render.value });
  }

  async function releaseAndFail({ document, ownerWaId, reservationId, attemptId, code, key }) {
    if (reservationId) {
      await walletReservationService.releaseReservation({ reservationId, idempotencyKey: `${key}:release` });
      emit("credits_released", { reason_code: code });
    }
    if (attemptId) {
      const attempt = await store.getGenerationAttempt({ generationAttemptId: attemptId });
      if (attempt.ok && ["STARTED", "PDF_VALIDATED"].includes(attempt.value.status)) {
        await store.updateGenerationAttempt({ generationAttemptId: attemptId, expectedStatus: attempt.value.status, changes: { status: "RECOVERABLE_FAILURE", last_error_code: code } });
      }
      await finalGenerationService.discardPrivate({ generationAttemptId: attemptId });
    }
    const failed = await recordFailure(document, ownerWaId, code, `${key}:failure`);
    return failed.ok ? fail(code) : failed;
  }

  async function deliverFinal({ document, ownerWaId, finalFile, key }) {
    const created = await deliveryService.createDeliveryAttempt({ finalFileId: finalFile.final_file_id, ownerRef: ownerWaId, idempotencyKey: `${key}:delivery` });
    if (!created.ok) return created;
    emit("delivery_started");
    const delivered = await deliveryService.deliver({ deliveryAttemptId: created.value.delivery_attempt_id });
    if (!delivered.ok) {
      emit("delivery_failed", { reason_code: "DELIVERY_FAILED" });
      const failed = await recordFailure(document, ownerWaId, "DELIVERY_FAILED", `${key}:delivery-failure`);
      // documentId travels with the failure so the presentation layer can
      // offer a real, reachable retry action for exactly this document —
      // never trusted back from the client, only ever read forward from
      // here to the presenter.
      return failed.ok ? { ok: false, error: "DELIVERY_RECOVERABLE_FAILURE", documentId: document.document_id } : failed;
    }
    emit("delivery_succeeded");
    const marked = await persistEvent(document, DOCUMENT_EVENTS.MARK_DELIVERED, { delivery_attempt_id: created.value.delivery_attempt_id }, `${key}:delivered`, "DOCUMENT_DELIVERED", ownerWaId);
    return marked.ok ? ok({ document: marked.value, final_file: finalFile, delivery: delivered.value }) : marked;
  }

  async function completeAfterCapture({ document, ownerWaId, quote, attemptId, reservationId, key }) {
    const markedCapture = await finalGenerationService.markCaptured({ generationAttemptId: attemptId, reservationId });
    if (!markedCapture.ok) {
      const failed = await recordFailure(document, ownerWaId, "CAPTURE_RECORDED_BUT_ATTEMPT_UPDATE_FAILED", `${key}:capture-state-failure`);
      return failed.ok ? fail("CAPTURE_STATE_RECOVERABLE_FAILURE") : failed;
    }
    emit("credits_captured");
    await artifacts.setGenerationQuoteStatus({ quoteId: quote.quote_id, status: "CONSUMED" });
    const promoted = await finalGenerationService.promoteFinal({ generationAttemptId: attemptId, documentId: document.document_id, documentVersion: document.version, idempotencyKey: `${key}:promote` });
    if (!promoted.ok) {
      const failed = await recordFailure(document, ownerWaId, "FINAL_PROMOTION_FAILED_AFTER_CAPTURE", `${key}:promotion-failure`);
      return failed.ok ? fail("FINAL_PROMOTION_RECOVERABLE_FAILURE") : failed;
    }
    emit("final_file_promoted");
    const generated = await persistEvent(document, DOCUMENT_EVENTS.MARK_GENERATED, { generated_file: promoted.value }, `${key}:generated`, "DOCUMENT_GENERATED", ownerWaId);
    if (!generated.ok) return generated;
    return deliverFinal({ document: generated.value, ownerWaId, finalFile: promoted.value, key });
  }

  async function runConfirmation(command) {
    emit("generation_confirmation_received");
    const duplicate = await store.findByQuoteId({ quoteId: command?.quoteId });
    if (duplicate.ok && duplicate.value) {
      if (duplicate.value.confirmation_key !== command.idempotencyKey || duplicate.value.document_id !== command.documentId || duplicate.value.document_version !== command.documentVersion) {
        return fail("GENERATION_CONFIRMATION_CONFLICT");
      }
      return getGenerationStatus({ quoteId: command.quoteId, ownerWaId: command.ownerWaId });
    }
    const checked = await validateConfirmation(command);
    if (!checked.ok) return checked;
    const { document, quote, preview } = checked.value;
    const reservation = await walletReservationService.reserveCredits({ ownerWaId: command.ownerWaId, quoteId: quote.quote_id, amount: quote.total_credits, idempotencyKey: `${command.idempotencyKey}:reserve` });
    if (!reservation.ok && reservation.error === "INSUFFICIENT_CREDITS") {
      const recharge = await persistEvent(document, DOCUMENT_EVENTS.REQUIRE_RECHARGE, {}, `${command.idempotencyKey}:recharge`, "GENERATION_RECHARGE_REQUIRED", command.ownerWaId);
      return recharge.ok ? fail("INSUFFICIENT_CREDITS") : recharge;
    }
    if (!reservation.ok) return reservation;
    emit("credits_reserved");
    const started = await persistEvent(document, DOCUMENT_EVENTS.START_GENERATION, {}, `${command.idempotencyKey}:start`, "GENERATION_STARTED", command.ownerWaId);
    if (!started.ok) {
      await walletReservationService.releaseReservation({ reservationId: reservation.value.reservation_id, idempotencyKey: `${command.idempotencyKey}:start-release` });
      return started;
    }
    emit("generation_started");
    const attemptId = makeId("generation", command.idempotencyKey);
    const attempt = await store.createGenerationAttempt({
      attempt: { generation_attempt_id: attemptId, document_id: command.documentId, owner_wa_id: command.ownerWaId, document_version: command.documentVersion, quote_id: quote.quote_id, reservation_id: reservation.value.reservation_id, confirmation_key: command.idempotencyKey, status: "STARTED", started_at: new Date(clock()).toISOString() },
      idempotencyKey: `${command.idempotencyKey}:attempt`,
    });
    if (!attempt.ok) return releaseAndFail({ document: started.value, ownerWaId: command.ownerWaId, reservationId: reservation.value.reservation_id, code: "GENERATION_ATTEMPT_FAILED", key: command.idempotencyKey });
    // The stored preview was captured before finalization (issued_at/
    // document_number were still null then). START_GENERATION just assigned
    // the real, server-generated identity on `started.value` — the renderer
    // must receive that finalized identity, never the stale placeholder,
    // or the delivered PDF would show "BROUILLON"/"—" despite being final.
    const finalizedPreview = {
      ...preview,
      structured_preview: {
        ...preview.structured_preview,
        issued_at: started.value.issued_at,
        document_number: started.value.document_number,
        invoice_kind: started.value.options?.invoice_kind ?? preview.structured_preview.invoice_kind ?? null,
      },
    };
    const generated = await finalGenerationService.generatePrivate({ generationAttemptId: attemptId, preview: finalizedPreview, expectedPageCount: quote.page_count });
    if (!generated.ok) return releaseAndFail({ document: started.value, ownerWaId: command.ownerWaId, reservationId: reservation.value.reservation_id, attemptId, code: generated.error, key: command.idempotencyKey });
    emit("final_pdf_validated");
    const captured = await walletReservationService.captureReservation({ reservationId: reservation.value.reservation_id, idempotencyKey: `${command.idempotencyKey}:capture` });
    if (!captured.ok) return releaseAndFail({ document: started.value, ownerWaId: command.ownerWaId, reservationId: reservation.value.reservation_id, attemptId, code: captured.error, key: command.idempotencyKey });
    return completeAfterCapture({ document: started.value, ownerWaId: command.ownerWaId, quote, attemptId, reservationId: reservation.value.reservation_id, key: command.idempotencyKey });
  }

  async function confirmGeneration(command) {
    if (!valid(command?.quoteId)) return fail("GENERATION_CONFIRMATION_INVALID");
    return serializeConfirmation(command.quoteId, () => runConfirmation(command));
  }

  async function resumeGeneration({ quoteId, ownerWaId, idempotencyKey }) {
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    const attempt = found.value;
    // Eligibility is decided entirely from already-persisted state, before
    // any mutation. resumeGeneration only continues a generation that
    // already passed render validation and reservation capture (attempt
    // CAPTURED/PROMOTED, or PDF_VALIDATED with an actually-captured
    // reservation) — never a render/private-storage failure (attempt
    // RECOVERABLE_FAILURE belongs to retryFailedGeneration instead) nor
    // any other unrelated attempt state (STARTED, CANCELLED). Silently
    // absorbing an ineligible attempt here would call RESUME anyway,
    // moving the document to GENERATION_IN_PROGRESS and clearing
    // recoverable_failure, then dead-ending with no route back to either
    // recovery path — that ordering bug is exactly what this guard
    // prevents.
    let eligible = ["CAPTURED", "PROMOTED"].includes(attempt.status);
    if (!eligible && attempt.status === "PDF_VALIDATED") {
      const reservation = await store.getReservation({ reservationId: attempt.reservation_id });
      eligible = reservation.ok && reservation.value.status === "CAPTURED";
    }
    if (!eligible) return fail("GENERATION_RECONFIRMATION_REQUIRED");
    const document = await documents.getDocumentById({ documentId: attempt.document_id, ownerWaId });
    if (!document.ok || document.value.status !== "RECOVERABLE_FAILURE") return fail("GENERATION_NOT_RESUMABLE");
    const resumed = await persistEvent(document.value, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume`, "GENERATION_RESUMED", ownerWaId);
    if (!resumed.ok) return resumed;
    const quote = await artifacts.getGenerationQuote({ quoteId });
    // completeAfterCapture calls markCaptured itself, which is idempotent
    // (returns duplicate:true if already CAPTURED/PROMOTED) — no separate
    // capture step needed here.
    return completeAfterCapture({ document: resumed.value, ownerWaId, quote: quote.value, attemptId: attempt.generation_attempt_id, reservationId: attempt.reservation_id, key: idempotencyKey });
  }

  // Recovery for a failure at the render/private-storage stage, strictly
  // before capture — the one gap resumeGeneration does not cover (it only
  // resumes an attempt already PDF_VALIDATED/CAPTURED/PROMOTED).
  // releaseAndFail explicitly moves the generation_attempt row itself to
  // status "RECOVERABLE_FAILURE" on exactly this kind of failure (never
  // "STARTED" forever, as one might assume from generatePrivate alone) —
  // that status is this function's sole eligibility signal. It reuses that
  // exact same row and its existing generation_attempt_id instead of
  // creating a new one — kadi_v1_generation_attempts has a unique index on
  // quote_id, so a second row for the same quote could never be created
  // anyway. Only reservation_id/started_at/status are updated on it, via
  // the same updateGenerationAttempt used elsewhere; nothing about the
  // attempt's identity changes. issued_at/document_number are never
  // regenerated: RESUME does not touch them, and this function never calls
  // START_GENERATION again — reuse is structural, not merely asserted.
  async function runRetryFailedGeneration({ quoteId, ownerWaId, documentVersion, idempotencyKey }) {
    emit("generation_retry_received");
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    const attempt = found.value;
    // Any status other than RECOVERABLE_FAILURE means this attempt never
    // failed at the render/private-storage stage in the first place, or
    // this exact retry (or a later one) already progressed past it — never
    // re-render, re-capture, re-promote or re-deliver in that case,
    // regardless of whether it succeeded, is mid-flight, or was cancelled.
    if (attempt.status !== "RECOVERABLE_FAILURE") return fail("GENERATION_RETRY_NOT_ELIGIBLE");
    const document = await documents.getDocumentById({ documentId: attempt.document_id, ownerWaId });
    if (!document.ok) return document;
    if (document.value.status !== "RECOVERABLE_FAILURE") return fail("GENERATION_RETRY_NOT_ELIGIBLE");
    // Do not rely on document.status/attempt.status alone: a document can
    // reach RECOVERABLE_FAILURE from stages that have nothing to do with
    // rendering (e.g. a failure recorded while still COLLECTING). Only a
    // recorded failure whose resume_state was GENERATION_IN_PROGRESS was
    // actually recorded at the render/private-storage stage this function
    // recovers — anything else must never enter the render-retry path.
    if (document.value.recoverable_failure?.resume_state !== "GENERATION_IN_PROGRESS") {
      return fail("GENERATION_RETRY_NOT_ELIGIBLE");
    }
    if (!Number.isSafeInteger(documentVersion) || document.value.version !== documentVersion) {
      return fail("DOCUMENT_VERSION_CONFLICT");
    }
    // A complete pair or nothing at all — never one without the other. A
    // partial identity means something upstream is already structurally
    // broken; a retry must not paper over that by generating one half.
    if (
      typeof document.value.issued_at !== "string" || !document.value.issued_at ||
      typeof document.value.document_number !== "string" || !document.value.document_number
    ) {
      return fail("GENERATION_RETRY_NOT_ELIGIBLE");
    }
    const quote = await artifacts.getGenerationQuote({ quoteId });
    if (!quote.ok || quote.value.status !== "ACTIVE" || quote.value.document_id !== attempt.document_id) {
      return fail("GENERATION_RETRY_NOT_ELIGIBLE");
    }
    const preview = await artifacts.getPreview({ previewId: quote.value.preview_id });
    if (!preview.ok) return fail("GENERATION_RETRY_NOT_ELIGIBLE");

    const resumed = await persistEvent(document.value, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume`, "GENERATION_RETRY_RESUMED", ownerWaId);
    if (!resumed.ok) return resumed;
    emit("generation_retry_resumed");

    const reservation = await walletReservationService.reserveCredits({ ownerWaId, quoteId: quote.value.quote_id, amount: quote.value.total_credits, idempotencyKey: `${idempotencyKey}:reserve` });
    if (!reservation.ok && reservation.error === "INSUFFICIENT_CREDITS") {
      const recharge = await persistEvent(resumed.value, DOCUMENT_EVENTS.REQUIRE_RECHARGE, {}, `${idempotencyKey}:recharge`, "GENERATION_RECHARGE_REQUIRED", ownerWaId);
      return recharge.ok ? fail("INSUFFICIENT_CREDITS") : recharge;
    }
    if (!reservation.ok) return reservation;
    emit("credits_reserved");

    const reattached = await store.updateGenerationAttempt({
      generationAttemptId: attempt.generation_attempt_id,
      expectedStatus: "RECOVERABLE_FAILURE",
      // confirmation_key must move to this retry's idempotencyKey too — not
      // just status/reservation_id — otherwise a later replay of this exact
      // retry (e.g. a duplicate webhook, or a normal confirmGeneration call
      // once the document is no longer RECOVERABLE_FAILURE and
      // confirmOrRetryGeneration falls back to the normal path) would find
      // the attempt's confirmation_key still pointing at the *original*
      // failed confirmation's idempotencyKey, mismatch, and be rejected as
      // GENERATION_CONFIRMATION_CONFLICT instead of recognized as the
      // benign duplicate it actually is.
      changes: {
        status: "STARTED", reservation_id: reservation.value.reservation_id,
        started_at: new Date(clock()).toISOString(), confirmation_key: idempotencyKey,
      },
    });
    if (!reattached.ok) {
      await walletReservationService.releaseReservation({ reservationId: reservation.value.reservation_id, idempotencyKey: `${idempotencyKey}:retry-release` });
      return reattached;
    }
    emit("generation_retry_started");

    const finalizedPreview = {
      ...preview.value,
      structured_preview: {
        ...preview.value.structured_preview,
        issued_at: resumed.value.issued_at,
        document_number: resumed.value.document_number,
        invoice_kind: resumed.value.options?.invoice_kind ?? preview.value.structured_preview.invoice_kind ?? null,
      },
    };
    const generated = await finalGenerationService.generatePrivate({ generationAttemptId: attempt.generation_attempt_id, preview: finalizedPreview, expectedPageCount: quote.value.page_count });
    if (!generated.ok) {
      return releaseAndFail({ document: resumed.value, ownerWaId, reservationId: reservation.value.reservation_id, attemptId: attempt.generation_attempt_id, code: generated.error, key: idempotencyKey });
    }
    emit("final_pdf_validated");
    const captured = await walletReservationService.captureReservation({ reservationId: reservation.value.reservation_id, idempotencyKey: `${idempotencyKey}:capture` });
    if (!captured.ok) {
      return releaseAndFail({ document: resumed.value, ownerWaId, reservationId: reservation.value.reservation_id, attemptId: attempt.generation_attempt_id, code: captured.error, key: idempotencyKey });
    }
    return completeAfterCapture({ document: resumed.value, ownerWaId, quote: quote.value, attemptId: attempt.generation_attempt_id, reservationId: reservation.value.reservation_id, key: idempotencyKey });
  }

  async function retryFailedGeneration(command) {
    if (!valid(command?.quoteId)) return fail("GENERATION_RETRY_INVALID");
    return serializeConfirmation(command.quoteId, () => runRetryFailedGeneration(command));
  }

  // Single production entrypoint for the existing "confirm final generation"
  // action — decides between the normal path and the pre-capture render
  // retry path from persisted state alone, so the same WhatsApp action/Flow
  // command already used for confirmation transparently also drives
  // recovery, with no new Meta Flow, no new action name, and no client
  // input trusted for the decision itself. This is routing only: it
  // performs no mutation and duplicates no lifecycle logic — each delegate
  // (confirmGeneration/retryFailedGeneration) independently re-validates
  // the document/attempt state it needs from repositories before mutating
  // anything, so a stale read here can never cause an unsafe mutation, only
  // route to a delegate that then fails closed on its own.
  async function confirmOrRetryGeneration(command) {
    if (!valid(command?.documentId) || !valid(command?.ownerWaId)) return fail("GENERATION_CONFIRMATION_INVALID");
    const document = await documents.getDocumentById({ documentId: command.documentId, ownerWaId: command.ownerWaId });
    if (!document.ok) return document;
    if (
      document.value.status === "RECOVERABLE_FAILURE" &&
      document.value.recoverable_failure?.resume_state === "GENERATION_IN_PROGRESS"
    ) {
      return retryFailedGeneration(command);
    }
    return confirmGeneration(command);
  }

  async function cancelGeneration({ quoteId, ownerWaId, idempotencyKey }) {
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    const reservation = await walletReservationService.getReservation({ reservationId: found.value.reservation_id, ownerWaId });
    if (!reservation.ok || reservation.value.status !== "RESERVED") return fail("GENERATION_CANCELLATION_FORBIDDEN");
    await walletReservationService.releaseReservation({ reservationId: reservation.value.reservation_id, idempotencyKey: `${idempotencyKey}:release` });
    emit("credits_released", { reason_code: "GENERATION_CANCELLED" });
    await store.updateGenerationAttempt({ generationAttemptId: found.value.generation_attempt_id, expectedStatus: found.value.status, changes: { status: "CANCELLED", cancelled_at: new Date(clock()).toISOString() } });
    const document = await documents.getDocumentById({ documentId: found.value.document_id, ownerWaId });
    return persistEvent(document.value, DOCUMENT_EVENTS.CANCEL, {}, `${idempotencyKey}:cancel`, "GENERATION_CANCELLED", ownerWaId);
  }

  // Every value this function acts on is resolved fresh from persisted
  // state — the caller supplies only documentId/ownerWaId/idempotencyKey
  // (ownerWaId always from the authenticated webhook sender, never from a
  // button payload). No quoteId, deliveryAttemptId, finalFileId,
  // destination or credit amount is ever accepted from the caller; all are
  // looked up here. See docs/KADI_ENGINEERING_MEMORY.md fiche P/Q for the
  // confirmed incident (captured credit + promoted PDF + no reachable
  // retry) this closes.
  async function runRetryDelivery({ documentId, ownerWaId, idempotencyKey, confirmed = false }) {
    emit("delivery_retry_requested");
    function rejected(code) {
      emit("delivery_retry_rejected", { reason_code: code });
      return fail(code);
    }
    // Shared by the ordinary "already delivered" replay and by a stale
    // IN_PROGRESS claim that reconciliation discovers the provider actually
    // did confirm — never calls the provider again, only persists the state
    // a successful delivery already implies. Must heal from BOTH states a
    // document can genuinely be in when the delivery attempt itself already
    // reads DELIVERED: RECOVERABLE_FAILURE (a prior recorded failure, needs
    // RESUME before MARK_DELIVERED applies) and GENERATED (the delivery
    // attempt's very first send crashed or lost its acknowledgment before
    // deliverFinal ever got to record a failure — MARK_DELIVERED applies to
    // GENERATED directly, no RESUME needed, exactly like deliverFinal's own
    // normal success path). Leaving GENERATED unhealed here would strand
    // document.status permanently even though the delivery attempt itself
    // is genuinely, correctly DELIVERED — confirmed by independent review.
    async function finishAlreadyDelivered(workingDoc, deliveryValue) {
      if (workingDoc.status === "RECOVERABLE_FAILURE") {
        const resumed = await persistEvent(workingDoc, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume-delivery`, "DELIVERY_RESUMED", ownerWaId);
        if (!resumed.ok) return resumed;
        const marked = await persistEvent(resumed.value, DOCUMENT_EVENTS.MARK_DELIVERED, { delivery_attempt_id: deliveryValue.delivery_attempt_id }, `${idempotencyKey}:delivered`, "DOCUMENT_DELIVERED", ownerWaId);
        if (marked.ok) emit("delivery_retry_succeeded", { duplicate: true });
        return marked.ok ? ok({ document: marked.value, delivery: deliveryValue }, { duplicate: true }) : marked;
      }
      if (workingDoc.status === "GENERATED") {
        const marked = await persistEvent(workingDoc, DOCUMENT_EVENTS.MARK_DELIVERED, { delivery_attempt_id: deliveryValue.delivery_attempt_id }, `${idempotencyKey}:delivered`, "DOCUMENT_DELIVERED", ownerWaId);
        if (marked.ok) emit("delivery_retry_succeeded", { duplicate: true });
        return marked.ok ? ok({ document: marked.value, delivery: deliveryValue }, { duplicate: true }) : marked;
      }
      emit("delivery_retry_succeeded", { duplicate: true });
      return ok({ document: workingDoc, delivery: deliveryValue }, { duplicate: true });
    }

    const document = await documents.getDocumentById({ documentId, ownerWaId });
    if (!document.ok) return rejected(document.error || "DELIVERY_RETRY_NOT_ELIGIBLE");
    let doc = document.value;
    if (typeof doc.issued_at !== "string" || !doc.issued_at || typeof doc.document_number !== "string" || !doc.document_number) {
      return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    }
    const quoteId = doc.generation_quote?.quote_id;
    if (!valid(quoteId)) return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId || found.value.document_id !== documentId) {
      return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    }
    const attempt = found.value;
    if (attempt.status !== "PROMOTED") return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    const reservation = await store.getReservation({ reservationId: attempt.reservation_id });
    if (!reservation.ok || reservation.value.status !== "CAPTURED") return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    const finalFile = await store.getFinalFile({ finalFileId: attempt.final_file_id });
    if (!finalFile.ok || finalFile.value.document_id !== documentId || finalFile.value.document_version !== doc.version) {
      return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    }
    const deliveryFound = await store.findDeliveryAttemptByFinalFileId({ finalFileId: finalFile.value.final_file_id });
    if (!deliveryFound.ok || !deliveryFound.value) return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    let delivery = deliveryFound.value;

    // Already-delivered is checked independently of the document's current
    // status: a replayed webhook can arrive after MARK_DELIVERED already
    // persisted (document.status === "DELIVERED"), and this must still be
    // a safe, inert, idempotent success — not an eligibility rejection.
    if (delivery.status === "DELIVERED") return finishAlreadyDelivered(doc, delivery);

    // A claim still shown as IN_PROGRESS is resolved here — on access
    // through a retry request — via a bounded, database-timestamp-backed
    // staleness check (never an in-memory timeout). A genuinely fresh claim
    // is left completely untouched: it may still be in flight, so this
    // rejects the same way it always has. Only once it is provably stale
    // does this reconcile it, and even then never straight to a confirmed
    // outcome without real provider evidence (see kadiV1DeliveryService.js
    // reconcileStaleClaim and docs/KADI_ENGINEERING_MEMORY.md fiche R).
    if (delivery.status === "IN_PROGRESS") {
      const reconciled = await deliveryService.reconcileStaleClaim({ deliveryAttemptId: delivery.delivery_attempt_id });
      if (!reconciled.ok) return rejected(reconciled.error || "DELIVERY_RETRY_NOT_ELIGIBLE");
      if (reconciled.reconciled !== true) return rejected("DELIVERY_ALREADY_IN_PROGRESS");
      delivery = reconciled.value;
      emit("delivery_stale_claim_reconciled", { reason_code: reconciled.outcome || "UNKNOWN" });
      if (reconciled.outcome === "CONFIRMED_SUCCESS") return finishAlreadyDelivered(doc, delivery);
      // OUTCOME_UNKNOWN: the delivery attempt row now reflects it; make
      // sure the document itself corroborates a recoverable failure at
      // this exact stage too, so the eligibility check below (identical to
      // the ordinary confirmed-failure path) can pass.
      if (doc.status !== "RECOVERABLE_FAILURE") {
        const failed = await recordFailure(doc, ownerWaId, "DELIVERY_FAILED", `${idempotencyKey}:delivery-stale-failure`);
        if (!failed.ok) return failed;
        const refetched = await documents.getDocumentById({ documentId, ownerWaId });
        if (!refetched.ok) return refetched;
        doc = refetched.value;
      }
    }

    // Not yet delivered — a genuine retry additionally requires the
    // document to corroborate an in-progress delivery failure recorded at
    // exactly this stage. Checked here, after resolving the generation
    // attempt/reservation/final-file chain above, so a document that never
    // reached this stage (wrong status, unrelated failure, or any
    // structural mismatch already caught above) is rejected the same way
    // regardless of which check happens to catch it first.
    if (
      doc.status !== "RECOVERABLE_FAILURE" ||
      doc.recoverable_failure?.code !== "DELIVERY_FAILED" ||
      doc.recoverable_failure?.resume_state !== "GENERATED"
    ) {
      return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");
    }
    if (delivery.status !== "RECOVERABLE_FAILURE") return rejected("DELIVERY_RETRY_NOT_ELIGIBLE");

    // An outcome-unknown delivery attempt must never be resent on the same
    // press that discovered it — the caller (webhook/presenter) must obtain
    // an explicit second, distinct user confirmation first. Confirmed is
    // never accepted from an untrusted client field for the ordinary
    // confirmed-failure case; it only ever matters for this branch, and
    // even then only gates whether the provider is called again — every
    // other eligibility check above still applies unconditionally.
    if (delivery.last_error_code === "DELIVERY_OUTCOME_UNKNOWN" && confirmed !== true) {
      emit("delivery_retry_confirmation_required");
      return { ok: false, error: "DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED", documentId };
    }

    emit("delivery_retry_started");
    const resumed = await persistEvent(doc, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume-delivery`, "DELIVERY_RESUMED", ownerWaId);
    if (!resumed.ok) return resumed;
    const delivered = await deliveryService.retryDelivery({ deliveryAttemptId: delivery.delivery_attempt_id });
    if (!delivered.ok) {
      emit("delivery_retry_failed", { reason_code: delivered.error });
      if (delivered.error === "DELIVERY_FINALIZE_UNRESOLVED") {
        // The provider call happened (or the finalize write for a prior
        // failure never landed) but the finalize write itself exhausted
        // its retries — the attempt is left IN_PROGRESS by design. Do not
        // record a confirmed DELIVERY_FAILED here: the document keeps
        // corroborating a delivery-stage failure (harmless — the next
        // retry request re-resolves the true state from delivery.status
        // itself, which the IN_PROGRESS branch above already handles).
        return { ok: false, error: "DELIVERY_OUTCOME_UNKNOWN", documentId };
      }
      const failed = await recordFailure(resumed.value, ownerWaId, "DELIVERY_FAILED", `${idempotencyKey}:delivery-retry-failure`);
      return failed.ok ? { ok: false, error: "DELIVERY_RECOVERABLE_FAILURE", documentId } : failed;
    }
    const marked = await persistEvent(resumed.value, DOCUMENT_EVENTS.MARK_DELIVERED, { delivery_attempt_id: delivery.delivery_attempt_id }, `${idempotencyKey}:delivered`, "DOCUMENT_DELIVERED", ownerWaId);
    if (!marked.ok) return marked;
    emit("delivery_retry_succeeded", { duplicate: false });
    return ok({ document: marked.value, delivery: delivered.value });
  }

  async function retryDelivery(command) {
    if (!valid(command?.documentId) || !valid(command?.ownerWaId)) return fail("DELIVERY_RETRY_INVALID");
    return serializeConfirmation(`delivery:${command.documentId}`, () => runRetryDelivery(command));
  }

  async function getGenerationStatus({ quoteId, ownerWaId }) {
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    const reservation = await store.getReservation({ reservationId: found.value.reservation_id });
    const finalFile = found.value.final_file_id ? await store.getFinalFile({ finalFileId: found.value.final_file_id }) : ok(null);
    return ok({ generation_attempt: found.value, reservation: reservation.ok ? reservation.value : null, final_file: finalFile.ok ? finalFile.value : null });
  }

  return Object.freeze({ confirmGeneration, resumeGeneration, retryFailedGeneration, confirmOrRetryGeneration, cancelGeneration, retryDelivery, getGenerationStatus });
}

module.exports = { createGenerationLifecycleService };
