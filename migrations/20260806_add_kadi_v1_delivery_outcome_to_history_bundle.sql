-- fix/kadi-v1-delivery-retry-and-final-filenames-r0 (final-review follow-up)
-- — kadi_v1_owned_history_bundle's 'delivery' object only ever exposed
-- status/attempt_count, so kadiV1HistoryService.js had no way to tell a
-- plain confirmed delivery failure apart from an outcome-unknown one (the
-- new state introduced to safely recover a stale IN_PROGRESS claim without
-- ever risking an uncontrolled duplicate WhatsApp send). Both reuse the
-- existing RECOVERABLE_FAILURE status value at the database layer; only
-- last_error_code distinguishes them ('DELIVERY_OUTCOME_UNKNOWN' vs any
-- other code).
--
-- Forward-only fix: expose last_error_code alongside status/attempt_count.
-- This is server-role-only data (see the existing
-- KADI_V1_SERVICE_ROLE_ONLY grants below, unchanged by this migration since
-- the function signature does not change), used only for internal
-- classification — never shown to the end user as raw text.

create or replace function public.kadi_v1_owned_history_bundle(
  p_owner_wa_id text,
  p_document_id text
) returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'classification', 'V1_NATIVE',
    'owner_wa_id', d.owner_wa_id,
    'document', to_jsonb(d),
    'current_snapshot', v.snapshot,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'version', dv.version,
        'created_at', dv.created_at
      ) order by dv.version)
      from public.kadi_v1_document_versions dv
      where dv.document_id = d.document_id
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type', de.event_type,
        'from_state', de.from_state,
        'to_state', de.to_state,
        'document_version', de.document_version,
        'occurred_at', de.occurred_at
      ) order by de.event_id)
      from public.kadi_v1_document_events de
      where de.document_id = d.document_id
    ), '[]'::jsonb),
    'preview', (
      select to_jsonb(dp) - 'owner_wa_id' - 'idempotency_key'
      from public.kadi_v1_document_previews dp
      where dp.document_id = d.document_id and dp.status = 'ACTIVE'
      order by dp.created_at desc limit 1
    ),
    'generation_quote', (
      select to_jsonb(gq) - 'owner_wa_id' - 'idempotency_key'
      from public.kadi_v1_generation_quotes gq
      where gq.document_id = d.document_id and gq.status = 'ACTIVE'
      order by gq.created_at desc limit 1
    ),
    'final_file', (
      select to_jsonb(ff) - 'storage_ref' - 'checksum'
      from public.kadi_v1_final_files ff
      where ff.document_id = d.document_id
      order by ff.generated_at desc limit 1
    ),
    'delivery', (
      select jsonb_build_object('status', da.status, 'attempt_count', da.attempt_count, 'last_error_code', da.last_error_code)
      from public.kadi_v1_delivery_attempts da
      join public.kadi_v1_final_files ff on ff.final_file_id = da.final_file_id
      where ff.document_id = d.document_id
      order by da.created_at desc limit 1
    ),
    'recharge_resume', (
      select jsonb_build_object('resume_status', rr.resume_status)
      from public.kadi_v1_recharge_resume_links rr
      where rr.document_id = d.document_id
      order by rr.created_at desc limit 1
    )
  )
  from public.kadi_v1_documents d
  join public.kadi_v1_document_versions v
    on v.document_id = d.document_id and v.version = d.active_version
  where d.owner_wa_id = p_owner_wa_id
    and d.document_id = p_document_id;
$$;
