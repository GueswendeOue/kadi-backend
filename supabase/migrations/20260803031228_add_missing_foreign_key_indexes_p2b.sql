-- P2B: add covering indexes for foreign keys.

create index if not exists kadi_invoice_flow_sessions_draft_id_idx
  on public.kadi_invoice_flow_sessions (draft_id);

create index if not exists kadi_v1_delivery_attempts_final_file_id_idx
  on public.kadi_v1_delivery_attempts (final_file_id);

create index if not exists kadi_v1_generation_attempts_document_version_idx
  on public.kadi_v1_generation_attempts (document_id, document_version);

create index if not exists kadi_v1_generation_attempts_reservation_id_idx
  on public.kadi_v1_generation_attempts (reservation_id);

create index if not exists kadi_v1_generation_quotes_preview_id_idx
  on public.kadi_v1_generation_quotes (preview_id);

create index if not exists kadi_v1_generation_quotes_temporary_render_id_idx
  on public.kadi_v1_generation_quotes (temporary_render_id);

create index if not exists kadi_v1_history_duplicates_new_document_id_idx
  on public.kadi_v1_history_duplicates (new_document_id);

create index if not exists kadi_v1_history_duplicates_source_document_id_idx
  on public.kadi_v1_history_duplicates (source_document_id);

create index if not exists kadi_v1_idempotency_records_document_id_idx
  on public.kadi_v1_idempotency_records (document_id);

create index if not exists kadi_v1_idempotency_records_event_id_idx
  on public.kadi_v1_idempotency_records (event_id);

create index if not exists kadi_v1_payment_events_recharge_session_id_idx
  on public.kadi_v1_payment_events (recharge_session_id);

create index if not exists kadi_v1_recharge_resume_links_quote_id_idx
  on public.kadi_v1_recharge_resume_links (quote_id);

create index if not exists kadi_v1_recharge_resume_links_document_version_idx
  on public.kadi_v1_recharge_resume_links (document_id, document_version);

create index if not exists kadi_v1_recharge_sessions_document_id_idx
  on public.kadi_v1_recharge_sessions (document_id);

create index if not exists kadi_v1_temporary_renders_document_version_idx
  on public.kadi_v1_temporary_renders (document_id, document_version);

create index if not exists kadi_v1_temporary_renders_preview_id_idx
  on public.kadi_v1_temporary_renders (preview_id);
