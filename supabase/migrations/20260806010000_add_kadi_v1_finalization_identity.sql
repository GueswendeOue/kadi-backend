-- fix/kadi-v1-pdf-final-state-and-tax-rate-r0 — the delivered "final" PDF
-- was rendered from the document's preview snapshot, which is always
-- captured before issued_at/document_number exist (both were, until now,
-- assigned only inside kadi_v1_persist_generated_transition at the moment a
-- document reaches GENERATED, i.e. strictly after the renderer already ran).
-- That ordering is why finalized documents could still show "BROUILLON",
-- an empty date and no real number despite being delivered as final.
--
-- Forward-only fix: issued_at/document_number are now assigned as soon as a
-- document enters GENERATION_IN_PROGRESS (kadi_v1_persist_transition, called
-- from the START_GENERATION domain transition), before the caller renders
-- the delivered PDF, so the renderer can be fed the real finalized identity
-- instead of a stale pre-finalization placeholder. issued_at still comes
-- exclusively from this function's own clock_timestamp() — never from the
-- caller-supplied snapshot — preserving the existing "server-only, no
-- caller override" guarantee, just moved one transition earlier. Once
-- assigned, both fields are carried forward unchanged on every later
-- transition (idempotent — a replayed transition never reassigns them).
--
-- document_number did not previously exist anywhere in this function; it is
-- new, generated deterministically and only by this function, never trusted
-- from the caller.
--
-- This file does not touch kadi_v1_persist_generated_transition's own body;
-- it already delegates to kadi_v1_persist_transition for these fields and
-- continues to work unchanged (issued_at/document_number are simply already
-- set by the time a document reaches GENERATED).

create or replace function public.kadi_v1_generate_document_number(
  p_document_type text,
  p_document_id text,
  p_issued_at timestamptz
)
returns text
language sql
immutable
as $$
  select
    (case p_document_type
      when 'FACTURE' then 'FA'
      when 'DEVIS' then 'DV'
      when 'RECU' then 'RC'
      when 'DECHARGE' then 'DC'
      else 'DOC'
    end)
    || '-' || to_char(p_issued_at at time zone 'UTC', 'YYYYMMDDHH24MISS')
    || '-' || upper(lpad(right(regexp_replace(p_document_id, '[^A-Za-z0-9]', '', 'g'), 8), 8, '0'));
$$;

create or replace function public.kadi_v1_persist_transition(
  p_document_id text,
  p_owner_wa_id text,
  p_expected_version integer,
  p_new_snapshot jsonb,
  p_items jsonb,
  p_event_type text,
  p_from_state text,
  p_to_state text,
  p_idempotency_key text,
  p_event_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.kadi_v1_documents%rowtype;
  v_existing_operation text;
  v_existing_document_id text;
  v_new_version integer;
  v_event_id bigint;
  v_issued_at timestamptz;
  v_document_number text;
  v_result jsonb;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9:_.-]{1,200}$' then
    raise exception 'KADI_V1_IDEMPOTENCY_KEY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  select operation_type, document_id, result
  into v_existing_operation, v_existing_document_id, v_result
  from public.kadi_v1_idempotency_records
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing_operation <> 'persist_transition' or v_existing_document_id <> p_document_id then
      raise exception 'KADI_V1_IDEMPOTENCY_CONFLICT';
    end if;
    return v_result || jsonb_build_object('duplicate', true);
  end if;

  if jsonb_typeof(p_new_snapshot) <> 'object' or coalesce(jsonb_typeof(p_items), 'null') <> 'array' then
    raise exception 'KADI_V1_SNAPSHOT_INVALID';
  end if;

  select * into v_document
  from public.kadi_v1_documents
  where document_id = p_document_id
  for update;

  if not found or v_document.owner_wa_id <> p_owner_wa_id then
    raise exception 'KADI_V1_NOT_FOUND';
  end if;
  if v_document.active_version <> p_expected_version then
    raise exception 'KADI_V1_VERSION_CONFLICT';
  end if;
  if v_document.status <> p_from_state then
    raise exception 'KADI_V1_STATE_CONFLICT';
  end if;
  if p_new_snapshot->>'document_id' <> p_document_id or p_new_snapshot->>'document_type' <> v_document.document_type then
    raise exception 'KADI_V1_SNAPSHOT_IDENTITY_CONFLICT';
  end if;
  if p_new_snapshot->>'status' <> p_to_state then
    raise exception 'KADI_V1_SNAPSHOT_STATE_CONFLICT';
  end if;

  v_new_version := (p_new_snapshot->>'version')::integer;
  if v_new_version not in (p_expected_version, p_expected_version + 1) then
    raise exception 'KADI_V1_VERSION_SEQUENCE_INVALID';
  end if;

  if v_document.issued_at is null and p_to_state = 'GENERATION_IN_PROGRESS' then
    v_issued_at := clock_timestamp();
    v_document_number := public.kadi_v1_generate_document_number(v_document.document_type, p_document_id, v_issued_at);
  else
    v_issued_at := v_document.issued_at;
    v_document_number := v_document.document_number;
    if nullif(p_new_snapshot->>'issued_at', '') is not null and
       (p_new_snapshot->>'issued_at')::timestamptz is distinct from v_document.issued_at then
      raise exception 'KADI_V1_SERVER_FIELD_FORBIDDEN';
    end if;
    if nullif(p_new_snapshot->>'document_number', '') is not null and
       (p_new_snapshot->>'document_number') is distinct from v_document.document_number then
      raise exception 'KADI_V1_SERVER_FIELD_FORBIDDEN';
    end if;
  end if;

  if v_new_version = p_expected_version + 1 then
    insert into public.kadi_v1_document_versions (document_id, version, snapshot)
    values (p_document_id, v_new_version, p_new_snapshot);

    insert into public.kadi_v1_document_items (
      document_id, document_version, item_id, position, item_snapshot
    )
    select
      p_document_id,
      v_new_version,
      item->>'item_id',
      ordinality::integer - 1,
      item
    from jsonb_array_elements(p_items) with ordinality as entries(item, ordinality);
  end if;

  update public.kadi_v1_documents
  set
    status = p_to_state,
    active_version = v_new_version,
    issuer_profile_id = nullif(p_new_snapshot->>'issuer_profile_id', ''),
    currency = p_new_snapshot->>'currency',
    issued_at = v_issued_at,
    document_number = v_document_number,
    preview = case when jsonb_typeof(p_new_snapshot->'preview') = 'object' then p_new_snapshot->'preview' else null end,
    generation_quote = case when jsonb_typeof(p_new_snapshot->'generation_quote') = 'object' then p_new_snapshot->'generation_quote' else null end,
    generation_cost = nullif(p_new_snapshot->>'generation_cost', '')::integer,
    recoverable_failure = case when jsonb_typeof(p_new_snapshot->'recoverable_failure') = 'object' then p_new_snapshot->'recoverable_failure' else null end,
    cancelled_at = nullif(p_new_snapshot->>'cancelled_at', '')::timestamptz,
    updated_at = clock_timestamp()
  where document_id = p_document_id;

  insert into public.kadi_v1_document_events (
    document_id, document_version, event_type, from_state, to_state,
    idempotency_key, metadata
  ) values (
    p_document_id, v_new_version, p_event_type, p_from_state, p_to_state,
    p_idempotency_key, coalesce(p_event_metadata, '{}'::jsonb)
  ) returning event_id into v_event_id;

  v_result := jsonb_build_object(
    'document_id', p_document_id,
    'version', v_new_version,
    'status', p_to_state,
    'event_id', v_event_id,
    'issued_at', v_issued_at,
    'document_number', v_document_number,
    'duplicate', false
  );

  insert into public.kadi_v1_idempotency_records (
    idempotency_key, operation_type, document_id, document_version, event_id, result
  ) values (
    p_idempotency_key, 'persist_transition', p_document_id,
    v_new_version, v_event_id, v_result
  );

  return v_result;
end;
$$;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_generate_document_number(text, text, timestamptz) from public;
revoke all on function public.kadi_v1_generate_document_number(text, text, timestamptz) from anon;
revoke all on function public.kadi_v1_generate_document_number(text, text, timestamptz) from authenticated;
grant execute on function public.kadi_v1_generate_document_number(text, text, timestamptz) to service_role;

revoke all on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from public;
revoke all on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from anon;
revoke all on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from authenticated;
grant execute on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
