-- Additive read indexes and idempotency records for Kadi V1 history/search.
create index if not exists kadi_v1_documents_owner_updated_stable_idx
  on public.kadi_v1_documents (owner_wa_id, updated_at desc, document_id desc);

create index if not exists kadi_v1_documents_owner_number_idx
  on public.kadi_v1_documents (owner_wa_id, document_number)
  where document_number is not null;

create index if not exists kadi_v1_documents_owner_issued_idx
  on public.kadi_v1_documents (owner_wa_id, issued_at desc)
  where issued_at is not null;

create index if not exists kadi_v1_final_files_document_version_idx
  on public.kadi_v1_final_files (document_id, document_version);

create table if not exists public.kadi_v1_history_duplicates (
  owner_wa_id text not null,
  idempotency_key text not null,
  source_document_id text not null references public.kadi_v1_documents(document_id),
  new_document_id text not null references public.kadi_v1_documents(document_id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (owner_wa_id, idempotency_key),
  constraint kadi_v1_history_duplicate_key_check check (
    idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'
  ),
  constraint kadi_v1_history_duplicate_distinct_check check (source_document_id <> new_document_id)
);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'kadi_v1_history_duplicates_immutable'
      and tgrelid = 'public.kadi_v1_history_duplicates'::regclass
  ) then
    create trigger kadi_v1_history_duplicates_immutable
      before update or delete on public.kadi_v1_history_duplicates
      for each row execute function public.kadi_v1_reject_immutable_mutation();
  end if;
end $$;

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
      select jsonb_build_object('status', da.status, 'attempt_count', da.attempt_count)
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

create or replace function public.kadi_v1_get_owned_document_history_bundle(
  p_owner_wa_id text,
  p_document_id text
) returns jsonb
language sql stable
set search_path = public
as $$
  select public.kadi_v1_owned_history_bundle(p_owner_wa_id, p_document_id);
$$;

create or replace function public.kadi_v1_search_owned_documents(
  p_owner_wa_id text,
  p_filters jsonb default '{}'::jsonb,
  p_cursor_updated_at timestamptz default null,
  p_cursor_document_id text default null,
  p_limit integer default 11,
  p_direction text default 'DESC'
) returns table(bundle jsonb)
language sql stable
set search_path = public
as $$
  select public.kadi_v1_owned_history_bundle(p_owner_wa_id, d.document_id)
  from public.kadi_v1_documents d
  join public.kadi_v1_document_versions v
    on v.document_id = d.document_id and v.version = d.active_version
  where d.owner_wa_id = p_owner_wa_id
    and p_direction in ('ASC', 'DESC')
    and p_limit between 1 and 51
    and (p_filters->>'document_type' is null or d.document_type = p_filters->>'document_type')
    and (p_filters->>'status' is null or d.status = p_filters->>'status')
    and (p_filters->>'document_number' is null or d.document_number = p_filters->>'document_number')
    and (p_filters->>'from' is null or coalesce(d.issued_at, d.updated_at) >= (p_filters->>'from')::timestamptz)
    and (p_filters->>'to' is null or coalesce(d.issued_at, d.updated_at) <= (p_filters->>'to')::timestamptz)
    and (p_filters->>'min_total' is null or (v.snapshot->>'total')::bigint >= (p_filters->>'min_total')::bigint)
    and (p_filters->>'max_total' is null or (v.snapshot->>'total')::bigint <= (p_filters->>'max_total')::bigint)
    and (p_filters->>'has_final_file' is null or exists (
      select 1 from public.kadi_v1_final_files ff where ff.document_id = d.document_id
    ) = (p_filters->>'has_final_file')::boolean)
    and (p_filters->>'counterparty' is null or position(
      lower(p_filters->>'counterparty') in lower(coalesce(
        v.snapshot#>>'{client,name}', v.snapshot#>>'{client,display_name}',
        v.snapshot#>>'{receipt,payer}', v.snapshot#>>'{discharge,receiver}', ''
      ))
    ) > 0)
    and (p_filters->>'text' is null or position(
      lower(p_filters->>'text') in lower(concat_ws(' ',
        v.snapshot#>>'{client,name}', v.snapshot#>>'{client,display_name}',
        v.snapshot#>>'{receipt,payer}', v.snapshot#>>'{discharge,receiver}',
        v.snapshot#>>'{discharge,reason}', v.snapshot->>'notes', v.snapshot->>'items'
      ))
    ) > 0)
    and (p_cursor_updated_at is null or (
      p_direction = 'DESC' and (d.updated_at, d.document_id) < (p_cursor_updated_at, p_cursor_document_id)
    ) or (
      p_direction = 'ASC' and (d.updated_at, d.document_id) > (p_cursor_updated_at, p_cursor_document_id)
    ))
  order by
    case when p_direction = 'DESC' then d.updated_at end desc,
    case when p_direction = 'DESC' then d.document_id end desc,
    case when p_direction = 'ASC' then d.updated_at end asc,
    case when p_direction = 'ASC' then d.document_id end asc
  limit p_limit;
$$;

create or replace function public.kadi_v1_remember_history_duplicate(
  p_owner_wa_id text,
  p_idempotency_key text,
  p_source_document_id text,
  p_new_document_id text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare v_row public.kadi_v1_history_duplicates%rowtype;
begin
  if not exists (
    select 1 from public.kadi_v1_documents
    where owner_wa_id = p_owner_wa_id and document_id = p_source_document_id
  ) or not exists (
    select 1 from public.kadi_v1_documents
    where owner_wa_id = p_owner_wa_id and document_id = p_new_document_id
  ) then
    raise exception 'KADI_V1_NOT_FOUND';
  end if;
  insert into public.kadi_v1_history_duplicates (
    owner_wa_id, idempotency_key, source_document_id, new_document_id
  ) values (
    p_owner_wa_id, p_idempotency_key, p_source_document_id, p_new_document_id
  ) on conflict (owner_wa_id, idempotency_key) do nothing;
  select * into v_row from public.kadi_v1_history_duplicates
  where owner_wa_id = p_owner_wa_id and idempotency_key = p_idempotency_key;
  if v_row.source_document_id <> p_source_document_id or v_row.new_document_id <> p_new_document_id then
    raise exception 'KADI_V1_HISTORY_IDEMPOTENCY_CONFLICT';
  end if;
  return jsonb_build_object(
    'source_document_id', v_row.source_document_id,
    'new_document_id', v_row.new_document_id
  );
end;
$$;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_owned_history_bundle(text, text) from public;
revoke all on function public.kadi_v1_owned_history_bundle(text, text) from anon;
revoke all on function public.kadi_v1_owned_history_bundle(text, text) from authenticated;
grant execute on function public.kadi_v1_owned_history_bundle(text, text) to service_role;
revoke all on function public.kadi_v1_get_owned_document_history_bundle(text, text) from public;
revoke all on function public.kadi_v1_get_owned_document_history_bundle(text, text) from anon;
revoke all on function public.kadi_v1_get_owned_document_history_bundle(text, text) from authenticated;
grant execute on function public.kadi_v1_get_owned_document_history_bundle(text, text) to service_role;
revoke all on function public.kadi_v1_search_owned_documents(text, jsonb, timestamptz, text, integer, text) from public;
revoke all on function public.kadi_v1_search_owned_documents(text, jsonb, timestamptz, text, integer, text) from anon;
revoke all on function public.kadi_v1_search_owned_documents(text, jsonb, timestamptz, text, integer, text) from authenticated;
grant execute on function public.kadi_v1_search_owned_documents(text, jsonb, timestamptz, text, integer, text) to service_role;
revoke all on function public.kadi_v1_remember_history_duplicate(text, text, text, text) from public;
revoke all on function public.kadi_v1_remember_history_duplicate(text, text, text, text) from anon;
revoke all on function public.kadi_v1_remember_history_duplicate(text, text, text, text) from authenticated;
grant execute on function public.kadi_v1_remember_history_duplicate(text, text, text, text) to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
