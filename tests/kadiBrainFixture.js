"use strict";

function validResult(request, intent = "create_document") {
  return {
    schemaVersion: "kadi.brain.v1", requestId: request.requestId, status: "understood",
    intent: { name: intent, confidence: 0.95, requiresConfirmation: false, risk: "low" },
    document: {
      operation: "create", documentId: null, documentType: "facture",
      clientName: "Awa", clientPhone: null, subject: null, notes: null,
      items: [{ lineRef: null, label: "Pagne", quantity: 5, unit: null, unitPrice: 3000, lineTotal: 15000 }],
      subtotal: 15000, grandTotal: 15000, amountPaid: null, paymentStatus: "unknown",
      paymentMethod: null, paymentDate: null, currency: "XOF",
    },
    historyTarget: null, patches: [], missingFields: [], ambiguities: [], warnings: [],
    evidence: [
      { field: "document.items[0].quantity", source: "user_explicit", valueText: "5", confidence: 0.99 },
      { field: "document.items[0].unitPrice", source: "user_explicit", valueText: "3000", confidence: 0.99 },
      { field: "document.items[0].lineTotal", source: "user_explicit", valueText: "15000", confidence: 0.99 },
      { field: "document.subtotal", source: "user_explicit", valueText: "15000", confidence: 0.99 },
      { field: "document.grandTotal", source: "user_explicit", valueText: "15000", confidence: 0.99 },
    ],
    diagnostics: { provider: "openai", model: "test", fallbackUsed: false },
  };
}

module.exports = { validResult };
