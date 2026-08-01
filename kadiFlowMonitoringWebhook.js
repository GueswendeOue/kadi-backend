"use strict";

const FLOW_MONITORING_EVENTS = new Set([
  "FLOW_STATUS_CHANGE",
  "CLIENT_ERROR_RATE",
  "ENDPOINT_ERROR_RATE",
  "ENDPOINT_LATENCY",
  "ENDPOINT_AVAILABILITY",
  "FLOW_VERSION_EXPIRY_WARNING",
]);

function ownValue(record, key) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function safeScalar(value) {
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function monitoringValue(value, key) {
  for (const source of [value, ownValue(value, "message"), ownValue(value, "data")]) {
    const candidate = safeScalar(ownValue(source, key));
    if (candidate !== null) return candidate;
  }
  return null;
}

function handleFlowMonitoringChange({ entry, change, logger = console } = {}) {
  if (ownValue(change, "field") !== "flows") return { handled: false };

  const value = ownValue(change, "value");
  const event = monitoringValue(value, "event");
  const record = {
    waba_ref: safeScalar(ownValue(entry, "id")) || monitoringValue(value, "waba_id"),
    flow_ref: monitoringValue(value, "flow_id"),
    event,
    alert_state: monitoringValue(value, "alert_state"),
    new_status: monitoringValue(value, "new_status"),
    threshold: monitoringValue(value, "threshold"),
    error_type: monitoringValue(value, "error_type"),
    handled: true,
  };

  logger?.log?.("KADI_FLOW_MONITORING_WEBHOOK", record);
  return { handled: true, known_event: FLOW_MONITORING_EVENTS.has(event) };
}

function dispatchWhatsAppWebhook(body, {
  handleIncomingStatuses,
  handleIncomingMessage,
  invoiceFlowTrigger = null,
  invoiceFlowCompletion = null,
  extractStatusesFromWebhookValue = () => [],
  monitoringHandler = handleFlowMonitoringChange,
  logger = console,
} = {}) {
  if (ownValue(body, "object") !== "whatsapp_business_account") return { handled: false };

  for (const entry of ownValue(body, "entry") || []) {
    for (const change of ownValue(entry, "changes") || []) {
      if (ownValue(change, "field") === "flows") {
        monitoringHandler({ entry, change, logger });
        continue;
      }

      const value = ownValue(change, "value");
      if (!value) continue;
      const statuses = extractStatusesFromWebhookValue(value);
      if (statuses.length && typeof handleIncomingStatuses === "function") {
        Promise.resolve(handleIncomingStatuses(statuses)).catch((error) => {
          logger?.error?.("handleIncomingStatuses", error);
        });
      }

      if (Array.isArray(ownValue(value, "messages")) && value.messages.length && typeof handleIncomingMessage === "function") {
        Promise.resolve(handleIncomingMessage(value, { invoiceFlowTrigger, invoiceFlowCompletion })).catch((error) => {
          logger?.error?.("handleIncomingMessage", error);
        });
      }
    }
  }
  return { handled: true };
}

function createWhatsAppWebhookReceiver(dependencies = {}) {
  return function receiveWhatsAppWebhook(req, res) {
    res.status(200).send("EVENT_RECEIVED");
    try {
      dispatchWhatsAppWebhook(req.body, dependencies);
    } catch (error) {
      dependencies.logger?.error?.("webhook_fatal", error);
    }
  };
}

module.exports = {
  FLOW_MONITORING_EVENTS,
  createWhatsAppWebhookReceiver,
  dispatchWhatsAppWebhook,
  handleFlowMonitoringChange,
};
