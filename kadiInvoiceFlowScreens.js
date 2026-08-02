"use strict";

function itemAmount(item) {
  return (BigInt(item.quantity_millis) * BigInt(item.unit_price) + 500n) / 1000n;
}

function subtotalAmount(draft) {
  return draft.items.reduce((sum, item) => sum + itemAmount(item), 0n);
}

function formatFcfa(value) {
  return `${Number(value).toLocaleString("fr-FR")} FCFA`;
}

function itemsSummary(draft) {
  if (!draft.items.length) return "Rien pour le moment";
  return draft.items.map((item, index) =>
    `${index + 1}. ${item.description} — ${item.quantity} × ${Number(item.unit_price).toLocaleString("fr-FR")} FCFA`
  ).join("\n");
}

function baseData(draft, flowToken) {
  return { flow_token: flowToken, draft_id: draft.draft_id };
}

function articleEntryData(draft, flowToken, { returnToReview = false } = {}) {
  const itemNumber = draft.items.length + 1;
  return {
    ...baseData(draft, flowToken),
    item_number_text: `Produit ou service ${itemNumber}`,
    saved_item_count_text: draft.items.length === 1 ? "1 article enregistré" : `${draft.items.length} articles enregistrés`,
    saved_items_summary: itemsSummary(draft),
    saved_subtotal_text: formatFcfa(subtotalAmount(draft)),
    current_item_id: `${draft.draft_id}:item:${itemNumber}`,
    submission_id: `${draft.draft_id}:item:${itemNumber}`,
    return_to_review: returnToReview ? "true" : "false",
    article_form_init_values: { designation: "", quantity: "1", unit_price: "" },
  };
}

function optionsData(draft, flowToken) {
  return baseData(draft, flowToken);
}

function reviewData(draft, flowToken) {
  const client = draft.client || {};
  const clientSummary = [client.name, client.phone, client.address].filter(Boolean).join(" · ") || "Client non renseigné";
  const options = draft.options || {};
  const optionParts = [
    options.tax_status === "taxable" ? "Taxe applicable" : "Aucune taxe",
    options.discount_amount ? `Remise : ${formatFcfa(BigInt(options.discount_amount))}` : null,
    options.payment_terms || null,
  ].filter(Boolean);
  return {
    ...baseData(draft, flowToken),
    issuer_name: "Profil entreprise Kadi",
    client_summary: clientSummary,
    items_summary: itemsSummary(draft),
    total_text: formatFcfa(subtotalAmount(draft) - BigInt(options.discount_amount || 0)),
    options_summary: optionParts.join(" · ") || "Aucun détail supplémentaire",
  };
}

function editClientData(draft, flowToken) {
  const client = draft.client || {};
  return {
    ...baseData(draft, flowToken),
    client_form_init_values: {
      client_type: client.type || "individual",
      client_name: client.name || "",
      client_phone: client.phone || "",
      client_address: client.address || "",
      client_ifu: client.ifu || "",
      client_registry_number: client.registry_number || "",
      invoice_subject: client.invoice_subject || "",
    },
  };
}

function editItemsData(draft, flowToken) {
  return {
    ...baseData(draft, flowToken),
    items_summary: itemsSummary(draft),
    total_text: formatFcfa(subtotalAmount(draft)),
    editable_items: draft.items.map((item, index) => ({
      id: item.item_id || `${draft.draft_id}:item:${index + 1}`,
      title: `${index + 1}. ${item.description}`,
    })),
  };
}

function editOptionsData(draft, flowToken) {
  const options = draft.options || {};
  return {
    ...baseData(draft, flowToken),
    options_form_init_values: {
      tax_status: options.tax_status || "not_applicable",
      tax_rate: options.tax_rate_basis_points ? String(options.tax_rate_basis_points / 100) : "",
      discount_amount: String(options.discount_amount || 0),
      amount_paid: String(options.amount_paid || 0),
      due_date: options.due_date || "",
      payment_method: options.payment_method || "",
      payment_terms: options.payment_terms || "",
      invoice_note: options.note || "",
    },
  };
}

module.exports = {
  articleEntryData,
  editClientData,
  editItemsData,
  editOptionsData,
  formatFcfa,
  itemsSummary,
  optionsData,
  reviewData,
  subtotalAmount,
};
