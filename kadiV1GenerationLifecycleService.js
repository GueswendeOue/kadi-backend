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
    ["DELIVERY_SERVICE", deliveryService, ["createDeliveryAttempt", "deliver", "retryDelivery"]],
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
      return failed.ok ? fail("DELIVERY_RECOVERABLE_FAILURE") : failed;
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
    const generated = await finalGenerationService.generatePrivate({ generationAttemptId: attemptId, preview, expectedPageCount: quote.page_count });
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
    const document = await documents.getDocumentById({ documentId: attempt.document_id, ownerWaId });
    if (!document.ok || document.value.status !== "RECOVERABLE_FAILURE") return fail("GENERATION_NOT_RESUMABLE");
    const resumed = await persistEvent(document.value, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume`, "GENERATION_RESUMED", ownerWaId);
    if (!resumed.ok) return resumed;
    const reservation = await store.getReservation({ reservationId: attempt.reservation_id });
    if (attempt.status === "PDF_VALIDATED" && reservation.ok && reservation.value.status === "CAPTURED") {
      const marked = await finalGenerationService.markCaptured({ generationAttemptId: attempt.generation_attempt_id, reservationId: attempt.reservation_id });
      if (!marked.ok) return marked;
      attempt.status = "CAPTURED";
    }
    if (["CAPTURED", "PROMOTED"].includes(attempt.status)) {
      const quote = await artifacts.getGenerationQuote({ quoteId });
      return completeAfterCapture({ document: resumed.value, ownerWaId, quote: quote.value, attemptId: attempt.generation_attempt_id, reservationId: attempt.reservation_id, key: idempotencyKey });
    }
    return fail("GENERATION_RECONFIRMATION_REQUIRED");
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

  async function retryDelivery({ quoteId, ownerWaId, deliveryAttemptId, idempotencyKey }) {
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    let document = await documents.getDocumentById({ documentId: found.value.document_id, ownerWaId });
    if (!document.ok) return document;
    if (document.value.status === "RECOVERABLE_FAILURE") {
      document = await persistEvent(document.value, DOCUMENT_EVENTS.RESUME, {}, `${idempotencyKey}:resume-delivery`, "DELIVERY_RESUMED", ownerWaId);
      if (!document.ok) return document;
    }
    const delivered = await deliveryService.retryDelivery({ deliveryAttemptId });
    if (!delivered.ok) return delivered;
    const marked = await persistEvent(document.value, DOCUMENT_EVENTS.MARK_DELIVERED, { delivery_attempt_id: deliveryAttemptId }, `${idempotencyKey}:delivered`, "DOCUMENT_DELIVERED", ownerWaId);
    return marked.ok ? ok({ document: marked.value, delivery: delivered.value }) : marked;
  }

  async function getGenerationStatus({ quoteId, ownerWaId }) {
    const found = await store.findByQuoteId({ quoteId });
    if (!found.ok || !found.value || found.value.owner_wa_id !== ownerWaId) return fail("GENERATION_ATTEMPT_NOT_FOUND");
    const reservation = await store.getReservation({ reservationId: found.value.reservation_id });
    const finalFile = found.value.final_file_id ? await store.getFinalFile({ finalFileId: found.value.final_file_id }) : ok(null);
    return ok({ generation_attempt: found.value, reservation: reservation.ok ? reservation.value : null, final_file: finalFile.ok ? finalFile.value : null });
  }

  return Object.freeze({ confirmGeneration, resumeGeneration, cancelGeneration, retryDelivery, getGenerationStatus });
}

module.exports = { createGenerationLifecycleService };
