alter table public.kadi_v1_documents
  add column if not exists preview jsonb,
  add column if not exists generation_quote jsonb,
  add column if not exists generation_cost integer,
  add column if not exists recoverable_failure jsonb,
  add column if not exists cancelled_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kadi_v1_documents_generation_cost_check'
      and conrelid = 'public.kadi_v1_documents'::regclass
  ) then
    alter table public.kadi_v1_documents
      add constraint kadi_v1_documents_generation_cost_check
      check (generation_cost is null or generation_cost >= 0);
  end if;
end $$;

create table if not exists public.kadi_v1_document_previews (
  preview_id text primary key,
  document_id text not null,
  document_version integer not null,
  preview_version integer not null default 1,
  owner_wa_id text not null,
  status text not null default 'ACTIVE',
  structured_preview jsonb not null,
  idempotency_key text not null unique,
  revision integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  invalidated_at timestamptz,
  constraint kadi_v1_previews_document_version_fk
    foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version),
  constraint kadi_v1_previews_status_check check (status in ('ACTIVE', 'INVALIDATED')),
  constraint kadi_v1_previews_version_check check (document_version >= 1 and preview_version >= 1),
  constraint kadi_v1_previews_revision_check check (revision >= 1),
  constraint kadi_v1_previews_snapshot_check check (jsonb_typeof(structured_preview) = 'object'),
  constraint kadi_v1_previews_idempotency_check check (
    idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'
  )
);

create unique index if not exists kadi_v1_previews_active_version_uidx
  on public.kadi_v1_document_previews (document_id, document_version)
  where status = 'ACTIVE';

create table if not exists public.kadi_v1_temporary_renders (
  render_id text primary key,
  preview_id text not null references public.kadi_v1_document_previews(preview_id),
  document_id text not null,
  document_version integer not null,
  owner_wa_id text not null,
  status text not null default 'CREATED',
  storage_ref text not null,
  storage_zone text not null,
  mime_type text not null,
  byte_size bigint not null,
  renderer text not null,
  page_count integer,
  inspected_at timestamptz,
  inspection_method text,
  validation_status text,
  idempotency_key text not null unique,
  revision integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint kadi_v1_temporary_renders_document_version_fk
    foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version),
  constraint kadi_v1_temporary_renders_status_check check (
    status in ('CREATED', 'INSPECTED', 'INVALIDATED', 'EXPIRED', 'DELETED')
  ),
  constraint kadi_v1_temporary_renders_private_check check (
    storage_zone = 'TEMPORARY_PRIVATE' and storage_ref !~* '^https?://'
  ),
  constraint kadi_v1_temporary_renders_mime_check check (mime_type = 'application/pdf'),
  constraint kadi_v1_temporary_renders_size_check check (byte_size > 0),
  constraint kadi_v1_temporary_renders_page_check check (page_count is null or page_count >= 1),
  constraint kadi_v1_temporary_renders_revision_check check (revision >= 1),
  constraint kadi_v1_temporary_renders_idempotency_check check (
    idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'
  )
);

create index if not exists kadi_v1_temporary_renders_expiry_idx
  on public.kadi_v1_temporary_renders (expires_at)
  where status in ('CREATED', 'INSPECTED');

create table if not exists public.kadi_v1_generation_quotes (
  quote_id text primary key,
  document_id text not null,
  document_version integer not null,
  preview_id text not null references public.kadi_v1_document_previews(preview_id),
  temporary_render_id text not null references public.kadi_v1_temporary_renders(render_id),
  owner_wa_id text not null,
  page_count integer not null,
  pricing_version text not null,
  base_cost integer not null,
  page_cost integer not null,
  additional_costs jsonb not null default '[]'::jsonb,
  total_credits integer not null,
  explanation text not null,
  status text not null default 'ACTIVE',
  idempotency_key text not null unique,
  revision integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint kadi_v1_generation_quotes_document_version_fk
    foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version),
  constraint kadi_v1_generation_quotes_status_check check (
    status in ('ACTIVE', 'EXPIRED', 'INVALIDATED', 'CONSUMED')
  ),
  constraint kadi_v1_generation_quotes_page_check check (page_count >= 1),
  constraint kadi_v1_generation_quotes_cost_check check (
    base_cost >= 0 and page_cost >= 0 and total_credits >= 1
  ),
  constraint kadi_v1_generation_quotes_additional_check check (jsonb_typeof(additional_costs) = 'array'),
  constraint kadi_v1_generation_quotes_revision_check check (revision >= 1),
  constraint kadi_v1_generation_quotes_idempotency_check check (
    idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'
  )
);

create unique index if not exists kadi_v1_generation_quotes_active_version_uidx
  on public.kadi_v1_generation_quotes (document_id, document_version)
  where status = 'ACTIVE';

create index if not exists kadi_v1_generation_quotes_expiry_idx
  on public.kadi_v1_generation_quotes (expires_at)
  where status = 'ACTIVE';

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

  if p_to_state = 'GENERATED' then
    v_issued_at := coalesce(v_document.issued_at, clock_timestamp());
  else
    v_issued_at := v_document.issued_at;
    if nullif(p_new_snapshot->>'issued_at', '') is not null and
       (p_new_snapshot->>'issued_at')::timestamptz is distinct from v_document.issued_at then
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

alter table public.kadi_v1_document_previews enable row level security;
alter table public.kadi_v1_temporary_renders enable row level security;
alter table public.kadi_v1_generation_quotes enable row level security;
