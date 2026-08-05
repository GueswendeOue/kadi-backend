"use strict";

const path = require("node:path");

const KADI_V1_DRAFT_FLOW_CATALOG = Object.freeze({
  ONBOARDING: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_onboarding_v1.json"),
    environment_variable: "KADI_V1_FLOW_ONBOARDING_ID",
    card: Object.freeze({ header: "Bienvenue chez Kadi", body: "Votre assistante administrative sur WhatsApp.", cta: "Commencer" }),
  }),
  MENU: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_menu_v1.json"),
    environment_variable: "KADI_V1_FLOW_MENU_ID",
    card: Object.freeze({ header: "Kadi à votre service", body: "Préparez ou retrouvez simplement vos documents.", cta: "Ouvrir" }),
  }),
  DOCUMENT_TYPE: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_type_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_TYPE_ID",
    card: Object.freeze({ header: "Préparer un document", body: "Facture, devis, reçu ou décharge.", cta: "Choisir" }),
  }),
  DOCUMENT_CLIENT: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_client_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_CLIENT_ID",
    card: Object.freeze({ header: "Informations du client", body: "Ajoutez les informations utiles du client.", cta: "Continuer" }),
  }),
  DOCUMENT_CONTENT: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_content_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_CONTENT_ID",
    card: Object.freeze({ header: "Produits ou services", body: "L’article est enregistré. Que voulez-vous faire ?", cta: "Continuer" }),
  }),
  ARTICLE_FORM: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_article_form_v1.json"),
    environment_variable: "KADI_V1_FLOW_ARTICLE_FORM_ID",
    card: Object.freeze({ header: "Nouvel article", body: "Ajoutez le produit ou le service, la quantité et le prix.", cta: "Ajouter" }),
  }),
  DOCUMENT_OPTIONS: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_options_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_OPTIONS_ID",
    card: Object.freeze({ header: "Options du document", body: "Ajoutez seulement les précisions nécessaires.", cta: "Continuer" }),
  }),
  DOCUMENT_REVIEW: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_review_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_REVIEW_ID",
    card: Object.freeze({ header: "Vérifiez les informations", body: "Corrigez un élément ou confirmez que tout est bon.", cta: "Vérifier" }),
  }),
  EDIT_CLIENT: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_edit_client_v1.json"),
    environment_variable: "KADI_V1_FLOW_EDIT_CLIENT_ID",
    card: Object.freeze({ header: "Modifier le client", body: "Mettez à jour les informations à conserver.", cta: "Modifier" }),
  }),
  EDIT_CONTENT: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_edit_content_v1.json"),
    environment_variable: "KADI_V1_FLOW_EDIT_CONTENT_ID",
    card: Object.freeze({ header: "Modifier les articles", body: "Ajoutez, corrigez ou supprimez un article.", cta: "Modifier" }),
  }),
  EDIT_OPTIONS: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_edit_options_v1.json"),
    environment_variable: "KADI_V1_FLOW_EDIT_OPTIONS_ID",
    card: Object.freeze({ header: "Modifier les options", body: "Mettez à jour les précisions du document.", cta: "Modifier" }),
  }),
  DOCUMENT_PREVIEW: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_document_preview_v1.json"),
    environment_variable: "KADI_V1_FLOW_DOCUMENT_PREVIEW_ID",
    card: Object.freeze({ header: "Aperçu du document", body: "Consultez les informations avant de préparer le PDF.", cta: "Voir l’aperçu" }),
  }),
  GENERATION_CONFIRMATION: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_generation_confirmation_v1.json"),
    environment_variable: "KADI_V1_FLOW_GENERATION_CONFIRMATION_ID",
    card: Object.freeze({ header: "Coût du PDF", body: "Consultez le nombre de pages, le coût et votre solde.", cta: "Continuer" }),
  }),
  RECHARGE: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_recharge_v1.json"),
    environment_variable: "KADI_V1_FLOW_RECHARGE_ID",
    card: Object.freeze({ header: "Recharger mes crédits", body: "Choisissez un pack ou vérifiez un paiement.", cta: "Recharger" }),
  }),
  HISTORY_SEARCH: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_history_search_v1.json"),
    environment_variable: "KADI_V1_FLOW_HISTORY_SEARCH_ID",
    card: Object.freeze({ header: "Retrouver un document", body: "Recherchez par client, type ou période.", cta: "Rechercher" }),
  }),
  DISCHARGE_DETAILS: Object.freeze({
    file: path.join("flows", "v1_draft", "kadi_discharge_details_v1.json"),
    environment_variable: "KADI_V1_FLOW_DISCHARGE_DETAILS_ID",
    card: Object.freeze({ header: "Préparer une décharge", body: "Indiquez qui remet, qui reçoit et ce qui est remis.", cta: "Continuer" }),
  }),
});

module.exports = { KADI_V1_DRAFT_FLOW_CATALOG };
