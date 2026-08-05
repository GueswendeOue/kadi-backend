-- Kadi V1: allow INVOICE_TYPE as a conversation session expected_flow_key.
-- P8.A2 inserts a mandatory INVOICE_TYPE step between DOCUMENT_TYPE and
-- DOCUMENT_CLIENT for FACTURE documents (facture définitive vs proforma);
-- only the database CHECK constraint is updated here, forward-only.

alter table public.kadi_v1_conversation_sessions
  drop constraint if exists kadi_v1_conversation_sessions_expected_flow_key_check;

alter table public.kadi_v1_conversation_sessions
  add constraint kadi_v1_conversation_sessions_expected_flow_key_check
  check (
    expected_flow_key in (
      'ONBOARDING', 'MENU', 'DOCUMENT_TYPE', 'INVOICE_TYPE', 'DOCUMENT_CLIENT',
      'DOCUMENT_CONTENT', 'ARTICLE_FORM', 'DOCUMENT_OPTIONS', 'DOCUMENT_REVIEW',
      'EDIT_CLIENT', 'EDIT_CONTENT', 'EDIT_OPTIONS',
      'DOCUMENT_PREVIEW', 'GENERATION_CONFIRMATION', 'RECHARGE',
      'HISTORY_SEARCH', 'DISCHARGE_DETAILS'
    )
  );
