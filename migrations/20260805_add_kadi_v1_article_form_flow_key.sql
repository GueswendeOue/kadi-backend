-- Kadi V1: allow ARTICLE_FORM as a conversation session expected_flow_key.
-- ARTICLE_FORM was split into its own Meta Flow (Node.js FLOW_KEYS already
-- includes it); only the database CHECK constraint was missing it, causing
-- every SAVE_CLIENT/START_ADD_CONTENT session open to fail with
-- check_violation (23514) before any Meta call was ever attempted.

alter table public.kadi_v1_conversation_sessions
  drop constraint if exists kadi_v1_conversation_sessions_expected_flow_key_check;

alter table public.kadi_v1_conversation_sessions
  add constraint kadi_v1_conversation_sessions_expected_flow_key_check
  check (
    expected_flow_key in (
      'ONBOARDING', 'MENU', 'DOCUMENT_TYPE', 'DOCUMENT_CLIENT',
      'DOCUMENT_CONTENT', 'ARTICLE_FORM', 'DOCUMENT_OPTIONS', 'DOCUMENT_REVIEW',
      'EDIT_CLIENT', 'EDIT_CONTENT', 'EDIT_OPTIONS',
      'DOCUMENT_PREVIEW', 'GENERATION_CONFIRMATION', 'RECHARGE',
      'HISTORY_SEARCH', 'DISCHARGE_DETAILS'
    )
  );
