-- Kadi V1: allow RECEIPT_DETAILS as a conversation session expected_flow_key.
-- The RECU journey now has its own independent, mono-screen Meta Flow
-- (RECEIPT_DETAILS) instead of reusing DOCUMENT_CLIENT/ARTICLE_FORM/
-- DOCUMENT_CONTENT, which collected the wrong fields (name/phone/email
-- instead of payer/beneficiary/amount/reason/receipt_format) and allowed
-- line items that RECU forbids. Only the database CHECK constraint is
-- updated here, forward-only.

alter table public.kadi_v1_conversation_sessions
  drop constraint if exists kadi_v1_conversation_sessions_expected_flow_key_check;

alter table public.kadi_v1_conversation_sessions
  add constraint kadi_v1_conversation_sessions_expected_flow_key_check
  check (
    expected_flow_key in (
      'ONBOARDING', 'MENU', 'DOCUMENT_TYPE', 'INVOICE_TYPE', 'RECEIPT_DETAILS', 'DOCUMENT_CLIENT',
      'DOCUMENT_CONTENT', 'ARTICLE_FORM', 'DOCUMENT_OPTIONS', 'DOCUMENT_REVIEW',
      'EDIT_CLIENT', 'EDIT_CONTENT', 'EDIT_OPTIONS',
      'DOCUMENT_PREVIEW', 'GENERATION_CONFIRMATION', 'RECHARGE',
      'HISTORY_SEARCH', 'DISCHARGE_DETAILS'
    )
  );
