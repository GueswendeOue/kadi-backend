"use strict";

const crypto = require("node:crypto");
const { PDFDocument } = require("pdf-lib");
const { assertV1PreviewRepository } = require("./kadiV1PreviewRepository");

const PDF_MIME_TYPE = "application/pdf";
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

function ok(value, extra = {}) {
  return { ok: true, value, ...extra };
}

function fail(error) {
  return { ok: false, error };
}

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function validOwner(value) {
  return typeof value === "string" && /^\d{8,20}$/.test(value);
}

function defaultIdFactory(kind, key) {
  return `${kind}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function createInMemoryPrivateTemporaryStorage() {
  const files = new Map();
  return Object.freeze({
    async putPrivate({ renderId, buffer, mimeType }) {
      if (!validId(renderId) || !Buffer.isBuffer(buffer) || buffer.length === 0 || mimeType !== PDF_MIME_TYPE) {
        return fail("TEMPORARY_STORAGE_INPUT_INVALID");
      }
      const storageRef = `private-temp:${renderId}`;
      files.set(storageRef, { buffer: Buffer.from(buffer), mime_type: mimeType });
      return ok({ storage_ref: storageRef, storage_zone: "TEMPORARY_PRIVATE", publicly_accessible: false });
    },
    async readPrivate(storageRef) {
      const value = files.get(storageRef);
      return value ? ok({ buffer: Buffer.from(value.buffer), mime_type: value.mime_type }) : fail("TEMPORARY_FILE_NOT_FOUND");
    },
    async deletePrivate(storageRef) {
      files.delete(storageRef);
      return ok(true);
    },
    async isPrivate(storageRef) {
      return ok(typeof storageRef === "string" && storageRef.startsWith("private-temp:") && files.has(storageRef));
    },
  });
}

function assertPrivateStorage(storage) {
  for (const method of ["putPrivate", "readPrivate", "deletePrivate", "isPrivate"]) {
    if (typeof storage?.[method] !== "function") throw new TypeError(`TEMPORARY_STORAGE_METHOD_REQUIRED:${method}`);
  }
  return storage;
}

function createPdfLibPageCountInspector({ clock = () => new Date().toISOString() } = {}) {
  if (typeof clock !== "function") throw new TypeError("PAGE_INSPECTOR_CLOCK_INVALID");
  return Object.freeze({
    async inspect({ buffer, mimeType, renderId, documentVersion }) {
      if (mimeType !== PDF_MIME_TYPE) return fail("TEMPORARY_RENDER_MIME_INVALID");
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return fail("TEMPORARY_RENDER_EMPTY");
      try {
        const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
        const pageCount = pdf.getPageCount();
        if (!Number.isSafeInteger(pageCount) || pageCount < 1) return fail("PAGE_COUNT_INVALID");
        const inspectedAt = clock();
        if (typeof inspectedAt !== "string" || !Number.isFinite(Date.parse(inspectedAt))) return fail("PAGE_INSPECTION_CLOCK_INVALID");
        return ok(Object.freeze({
          page_count: pageCount,
          inspected_at: new Date(inspectedAt).toISOString(),
          render_id: renderId,
          document_version: documentVersion,
          inspection_method: "PDF_LIB_PAGE_TREE",
          validation_status: "VALID",
        }));
      } catch {
        return fail("TEMPORARY_RENDER_CORRUPT");
      }
    },
  });
}

function previewToDocData(preview) {
  const data = preview.structured_preview;
  if (["FACTURE", "DEVIS"].includes(data.document_type)) {
    return {
      type: data.document_type,
      docNumber: data.document_number || "BROUILLON",
      date: data.issued_at || "—",
      client: data.client?.name || "—",
      clientPhone: data.client?.phone || null,
      items: data.items.map((item) => ({
        label: item.description,
        qty: item.quantity_millis / 1000,
        unitPrice: item.unit_price,
        amount: item.line_total,
      })),
      total: data.total,
    };
  }
  if (data.document_type === "RECU") {
    return {
      type: "RECU",
      docNumber: data.document_number || "BROUILLON",
      date: data.issued_at || "—",
      client: data.payer || "—",
      subject: data.reason,
      items: [],
      total: data.total,
    };
  }
  return {
    type: "DECHARGE",
    docNumber: data.document_number || "BROUILLON",
    date: data.issued_at || "—",
    client: data.beneficiary || "—",
    subject: data.content?.description || null,
    object_label: data.content?.type === "MONEY" ? null : data.content?.description,
    amount_received: data.content?.type === "MONEY" ? data.content.amount : 0,
    discharge_purpose: data.reason,
    dechargeType: data.content?.type === "MONEY" ? "argent" : "objet",
  };
}

function createExistingPdfTemporaryRenderer({ rendererResolver = null } = {}) {
  const resolve = rendererResolver || require("./pdf/kadiPdfRouter").resolveRenderer;
  return Object.freeze({
    async render({ preview }) {
      try {
        const docData = previewToDocData(preview);
        const renderer = resolve(docData);
        const buffer = await renderer({ docData, businessProfile: null, logoBuffer: null, qr: null, kadiE164: "" });
        return Buffer.isBuffer(buffer) && buffer.length > 0
          ? ok({ buffer, mime_type: PDF_MIME_TYPE, renderer: "KADI_EXISTING_PDF_RENDERER" })
          : fail("TEMPORARY_RENDER_OUTPUT_INVALID");
      } catch {
        return fail("TEMPORARY_RENDER_FAILED");
      }
    },
  });
}

function createTemporaryRenderService({
  previewRepository,
  storage,
  renderer,
  pageCountInspector = createPdfLibPageCountInspector(),
  clock = () => new Date().toISOString(),
  idFactory = defaultIdFactory,
  lifetimeSeconds = 3600,
} = {}) {
  const artifacts = assertV1PreviewRepository(previewRepository);
  const privateStorage = assertPrivateStorage(storage);
  if (typeof renderer?.render !== "function" || typeof pageCountInspector?.inspect !== "function") {
    throw new TypeError("TEMPORARY_RENDER_DEPENDENCY_INVALID");
  }
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 60) throw new TypeError("TEMPORARY_RENDER_LIFETIME_INVALID");

  async function createTemporaryRender(command) {
    if (!validOwner(command?.ownerWaId) || !validId(command?.previewId) || !validKey(command?.idempotencyKey)) {
      return fail("TEMPORARY_RENDER_COMMAND_INVALID");
    }
    const replay = await artifacts.findRenderByIdempotencyKey(command.idempotencyKey);
    if (!replay.ok) return replay;
    if (replay.value) return ok(replay.value, { duplicate: true });
    const preview = await artifacts.getPreview({ previewId: command.previewId });
    if (!preview.ok || preview.value.status !== "ACTIVE") return fail("PREVIEW_NOT_ACTIVE");
    if (preview.value.owner_wa_id !== command.ownerWaId) return fail("PREVIEW_NOT_ACTIVE");
    if (preview.value.document_version !== command.documentVersion || preview.value.document_id !== command.documentId) {
      return fail("TEMPORARY_RENDER_VERSION_MISMATCH");
    }
    const rendered = await renderer.render({ preview: preview.value });
    if (!rendered.ok) return rendered;
    if (rendered.value.mime_type !== PDF_MIME_TYPE || !Buffer.isBuffer(rendered.value.buffer) || rendered.value.buffer.length === 0) {
      return fail("TEMPORARY_RENDER_OUTPUT_INVALID");
    }
    const renderId = idFactory("render", command.idempotencyKey);
    if (!validId(renderId)) return fail("TEMPORARY_RENDER_ID_INVALID");
    const createdAt = clock();
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return fail("TEMPORARY_RENDER_CLOCK_INVALID");
    const stored = await privateStorage.putPrivate({ renderId, buffer: rendered.value.buffer, mimeType: PDF_MIME_TYPE });
    if (!stored.ok || stored.value.publicly_accessible !== false || stored.value.storage_zone !== "TEMPORARY_PRIVATE") {
      return fail("TEMPORARY_STORAGE_NOT_PRIVATE");
    }
    const record = Object.freeze({
      render_id: renderId,
      preview_id: preview.value.preview_id,
      document_id: preview.value.document_id,
      owner_wa_id: command.ownerWaId,
      document_version: preview.value.document_version,
      status: "CREATED",
      storage_ref: stored.value.storage_ref,
      storage_zone: "TEMPORARY_PRIVATE",
      mime_type: PDF_MIME_TYPE,
      byte_size: rendered.value.buffer.length,
      renderer: rendered.value.renderer || "INJECTED_RENDERER",
      page_count: null,
      inspected_at: null,
      inspection_method: null,
      validation_status: null,
      created_at: new Date(createdMs).toISOString(),
      expires_at: new Date(createdMs + lifetimeSeconds * 1000).toISOString(),
    });
    const persisted = await artifacts.createTemporaryRender({ render: record, idempotencyKey: command.idempotencyKey });
    if (!persisted.ok) await privateStorage.deletePrivate(stored.value.storage_ref);
    return persisted;
  }

  async function inspectTemporaryRender({ renderId, ownerWaId }) {
    if (!validOwner(ownerWaId)) return fail("DOCUMENT_OWNER_INVALID");
    const render = await artifacts.getTemporaryRender({ renderId });
    if (!render.ok) return render;
    if (render.value.owner_wa_id !== ownerWaId) return fail("TEMPORARY_RENDER_NOT_FOUND");
    if (render.value.status === "INSPECTED") return ok(render.value, { duplicate: true });
    if (render.value.status !== "CREATED") return fail("TEMPORARY_RENDER_NOT_INSPECTABLE");
    const preview = await artifacts.getPreview({ previewId: render.value.preview_id });
    if (!preview.ok || preview.value.status !== "ACTIVE" || preview.value.document_version !== render.value.document_version) {
      return fail("TEMPORARY_RENDER_VERSION_MISMATCH");
    }
    const privateCheck = await privateStorage.isPrivate(render.value.storage_ref);
    if (!privateCheck.ok || privateCheck.value !== true) return fail("TEMPORARY_STORAGE_NOT_PRIVATE");
    const file = await privateStorage.readPrivate(render.value.storage_ref);
    if (!file.ok) return file;
    const inspection = await pageCountInspector.inspect({
      buffer: file.value.buffer,
      mimeType: file.value.mime_type,
      renderId,
      documentVersion: render.value.document_version,
    });
    if (!inspection.ok) return inspection;
    if (!Number.isSafeInteger(inspection.value?.page_count) || inspection.value.page_count < 1) {
      return fail("PAGE_COUNT_INVALID");
    }
    if (inspection.value.render_id !== renderId || inspection.value.document_version !== render.value.document_version) {
      return fail("PAGE_INSPECTION_VERSION_MISMATCH");
    }
    if (inspection.value.validation_status !== "VALID") return fail("PAGE_INSPECTION_NOT_VALIDATED");
    return artifacts.updateTemporaryRender({
      renderId,
      expectedStatus: "CREATED",
      changes: { status: "INSPECTED", ...inspection.value },
    });
  }

  async function inspectRecordForMutation(renderId, ownerWaId, allowedStatuses) {
    if (!validOwner(ownerWaId)) return fail("DOCUMENT_OWNER_INVALID");
    const render = await artifacts.getTemporaryRender({ renderId });
    if (!render.ok) return render;
    if (render.value.owner_wa_id !== ownerWaId) return fail("TEMPORARY_RENDER_NOT_FOUND");
    if (!allowedStatuses.includes(render.value.status)) return fail("TEMPORARY_RENDER_STATUS_CONFLICT");
    return render;
  }

  async function invalidateTemporaryRender({ renderId, ownerWaId }) {
    const render = await inspectRecordForMutation(renderId, ownerWaId, ["CREATED", "INSPECTED"]);
    if (!render.ok) return render;
    await privateStorage.deletePrivate(render.value.storage_ref);
    return artifacts.updateTemporaryRender({ renderId, expectedStatus: render.value.status, changes: { status: "INVALIDATED" } });
  }

  async function expireTemporaryRender({ renderId, ownerWaId }) {
    const render = await inspectRecordForMutation(renderId, ownerWaId, ["CREATED", "INSPECTED"]);
    if (!render.ok) return render;
    const nowMs = Date.parse(clock());
    const expiresMs = Date.parse(render.value.expires_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) return fail("TEMPORARY_RENDER_TIME_INVALID");
    if (nowMs < expiresMs) return fail("TEMPORARY_RENDER_NOT_EXPIRED");
    await privateStorage.deletePrivate(render.value.storage_ref);
    return artifacts.updateTemporaryRender({ renderId, expectedStatus: render.value.status, changes: { status: "EXPIRED" } });
  }

  return Object.freeze({ createTemporaryRender, expireTemporaryRender, inspectTemporaryRender, invalidateTemporaryRender });
}

module.exports = {
  PDF_MIME_TYPE,
  createExistingPdfTemporaryRenderer,
  createInMemoryPrivateTemporaryStorage,
  createPdfLibPageCountInspector,
  createTemporaryRenderService,
  previewToDocData,
};
