create table if not exists public.kadi_v1_documents (
  document_id text primary key,
  owner_wa_id text not null,
  document_type text not null,
  status text not null,
  active_version integer not null default 1,
  issuer_profile_id text,
  currency text not null default 'XOF',
  issued_at timestamptz,
  document_number text,
  legacy_source text,
  legacy_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint kadi_v1_documents_type_check check (
    document_type in ('FACTURE', 'DEVIS', 'RECU', 'DECHARGE')
  ),
  constraint kadi_v1_documents_status_check check (
    status in (
      'COLLECTING',
      'INCOMPLETE',
      'READY_FOR_REVIEW',
      'VERIFIED',
      'PREVIEW_READY',
      'COST_CALCULATED',
      'AWAITING_GENERATION_CONFIRMATION',
      'RECHARGE_REQUIRED',
      'GENERATION_IN_PROGRESS',
      'GENERATED',
      'DELIVERED',
      'RECOVERABLE_FAILURE',
      'CANCELLED'
    )
  ),
  constraint kadi_v1_documents_version_check check (active_version >= 1),
  constraint kadi_v1_documents_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint kadi_v1_documents_metadata_check check (jsonb_typeof(metadata) = 'object'),
  constraint kadi_v1_documents_legacy_pair_check check (
    (legacy_source is null and legacy_id is null) or
    (legacy_source is not null and legacy_id is not null)
  )
);

create index if not exists kadi_v1_documents_owner_updated_idx
  on public.kadi_v1_documents (owner_wa_id, updated_at desc);

create index if not exists kadi_v1_documents_owner_type_status_idx
  on public.kadi_v1_documents (owner_wa_id, document_type, status);

create index if not exists kadi_v1_documents_legacy_idx
  on public.kadi_v1_documents (legacy_source, legacy_id)
  where legacy_source is not null and legacy_id is not null;

create table if not exists public.kadi_v1_document_versions (
  document_id text not null references public.kadi_v1_documents(document_id),
  version integer not null,
  snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (document_id, version),
  constraint kadi_v1_document_versions_version_check check (version >= 1),
  constraint kadi_v1_document_versions_snapshot_check check (jsonb_typeof(snapshot) = 'object')
);

create table if not exists public.kadi_v1_document_items (
  document_id text not null,
  document_version integer not null,
  item_id text not null,
  position integer not null,
  item_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (document_id, document_version, item_id),
  constraint kadi_v1_document_items_version_fk
    foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version),
  constraint kadi_v1_document_items_position_check check (position >= 0),
  constraint kadi_v1_document_items_snapshot_check check (jsonb_typeof(item_snapshot) = 'object')
);

create unique index if not exists kadi_v1_document_items_position_uidx
  on public.kadi_v1_document_items (document_id, document_version, position);

create table if not exists public.kadi_v1_document_events (
  event_id bigint generated always as identity primary key,
  document_id text not null references public.kadi_v1_documents(document_id),
  document_version integer not null,
  event_type text not null,
  from_state text,
  to_state text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint kadi_v1_document_events_version_check check (document_version >= 1),
  constraint kadi_v1_document_events_type_check check (event_type ~ '^[A-Z][A-Z0-9_]{1,99}$'),
  constraint kadi_v1_document_events_from_state_check check (
    from_state is null or from_state in (
      'COLLECTING', 'INCOMPLETE', 'READY_FOR_REVIEW', 'VERIFIED',
      'PREVIEW_READY', 'COST_CALCULATED', 'AWAITING_GENERATION_CONFIRMATION',
      'RECHARGE_REQUIRED', 'GENERATION_IN_PROGRESS', 'GENERATED', 'DELIVERED',
      'RECOVERABLE_FAILURE', 'CANCELLED'
    )
  ),
  constraint kadi_v1_document_events_to_state_check check (
    to_state is null or to_state in (
      'COLLECTING', 'INCOMPLETE', 'READY_FOR_REVIEW', 'VERIFIED',
      'PREVIEW_READY', 'COST_CALCULATED', 'AWAITING_GENERATION_CONFIRMATION',
      'RECHARGE_REQUIRED', 'GENERATION_IN_PROGRESS', 'GENERATED', 'DELIVERED',
      'RECOVERABLE_FAILURE', 'CANCELLED'
    )
  ),
  constraint kadi_v1_document_events_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists kadi_v1_document_events_idempotency_uidx
  on public.kadi_v1_document_events (idempotency_key)
  where idempotency_key is not null;

create index if not exists kadi_v1_document_events_document_idx
  on public.kadi_v1_document_events (document_id, event_id);

create table if not exists public.kadi_v1_idempotency_records (
  idempotency_key text primary key,
  operation_type text not null,
  document_id text not null references public.kadi_v1_documents(document_id),
  document_version integer not null,
  event_id bigint references public.kadi_v1_document_events(event_id),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint kadi_v1_idempotency_key_check check (
    length(idempotency_key) between 1 and 200 and
    idempotency_key ~ '^[A-Za-z0-9:_.-]+$'
  ),
  constraint kadi_v1_idempotency_operation_check check (
    operation_type in ('create', 'persist_transition', 'append_event')
  ),
  constraint kadi_v1_idempotency_version_check check (document_version >= 1),
  constraint kadi_v1_idempotency_result_check check (jsonb_typeof(result) = 'object')
);

create or replace function public.kadi_v1_reject_immutable_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'KADI_V1_IMMUTABLE_RECORD';
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'kadi_v1_document_versions_immutable'
      and tgrelid = 'public.kadi_v1_document_versions'::regclass
  ) then
    create trigger kadi_v1_document_versions_immutable
      before update or delete on public.kadi_v1_document_versions
      for each row execute function public.kadi_v1_reject_immutable_mutation();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'kadi_v1_document_items_immutable'
      and tgrelid = 'public.kadi_v1_document_items'::regclass
  ) then
    create trigger kadi_v1_document_items_immutable
      before update or delete on public.kadi_v1_document_items
      for each row execute function public.kadi_v1_reject_immutable_mutation();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'kadi_v1_document_events_immutable'
      and tgrelid = 'public.kadi_v1_document_events'::regclass
  ) then
    create trigger kadi_v1_document_events_immutable
      before update or delete on public.kadi_v1_document_events
      for each row execute function public.kadi_v1_reject_immutable_mutation();
  end if;
end $$;

create or replace function public.kadi_v1_create_document(
  p_document jsonb,
  p_owner_wa_id text,
  p_snapshot jsonb,
  p_items jsonb,
  p_event_type text,
  p_idempotency_key text,
  p_legacy_source text default null,
  p_legacy_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document_id text := p_document->>'document_id';
  v_existing_operation text;
  v_existing_document_id text;
  v_event_id bigint;
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
    if v_existing_operation <> 'create' or v_existing_document_id <> v_document_id then
      raise exception 'KADI_V1_IDEMPOTENCY_CONFLICT';
    end if;
    return v_result || jsonb_build_object('duplicate', true);
  end if;

  if jsonb_typeof(p_document) <> 'object' or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'KADI_V1_DOCUMENT_INVALID';
  end if;
  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' then
    raise exception 'KADI_V1_ITEMS_INVALID';
  end if;
  if p_document->>'status' <> 'COLLECTING' or (p_document->>'version')::integer <> 1 then
    raise exception 'KADI_V1_INITIAL_STATE_INVALID';
  end if;
  if nullif(p_document->>'issued_at', '') is not null or nullif(p_document->>'document_number', '') is not null then
    raise exception 'KADI_V1_SERVER_FIELD_FORBIDDEN';
  end if;

  insert into public.kadi_v1_documents (
    document_id, owner_wa_id, document_type, status, active_version,
    issuer_profile_id, currency, issued_at, document_number,
    legacy_source, legacy_id, metadata
  ) values (
    v_document_id,
    p_owner_wa_id,
    p_document->>'document_type',
    'COLLECTING',
    1,
    nullif(p_document->>'issuer_profile_id', ''),
    p_document->>'currency',
    null,
    null,
    p_legacy_source,
    p_legacy_id,
    coalesce(p_metadata, '{}'::jsonb)
  );

  insert into public.kadi_v1_document_versions (document_id, version, snapshot)
  values (v_document_id, 1, p_snapshot);

  insert into public.kadi_v1_document_items (
    document_id, document_version, item_id, position, item_snapshot
  )
  select
    v_document_id,
    1,
    item->>'item_id',
    ordinality::integer - 1,
    item
  from jsonb_array_elements(p_items) with ordinality as entries(item, ordinality);

  insert into public.kadi_v1_document_events (
    document_id, document_version, event_type, from_state, to_state,
    idempotency_key, metadata
  ) values (
    v_document_id, 1, p_event_type, null, 'COLLECTING',
    p_idempotency_key, '{}'::jsonb
  ) returning event_id into v_event_id;

  v_result := jsonb_build_object(
    'document_id', v_document_id,
    'version', 1,
    'status', 'COLLECTING',
    'event_id', v_event_id,
    'duplicate', false
  );

  insert into public.kadi_v1_idempotency_records (
    idempotency_key, operation_type, document_id, document_version, event_id, result
  ) values (
    p_idempotency_key, 'create', v_document_id, 1, v_event_id, v_result
  );

  return v_result;
end;
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

create or replace function public.kadi_v1_append_domain_event(
  p_document_id text,
  p_owner_wa_id text,
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
  v_event_id bigint;
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
    if v_existing_operation <> 'append_event' or v_existing_document_id <> p_document_id then
      raise exception 'KADI_V1_IDEMPOTENCY_CONFLICT';
    end if;
    return v_result || jsonb_build_object('duplicate', true);
  end if;

  select * into v_document
  from public.kadi_v1_documents
  where document_id = p_document_id
  for update;

  if not found or v_document.owner_wa_id <> p_owner_wa_id then
    raise exception 'KADI_V1_NOT_FOUND';
  end if;
  if p_from_state <> v_document.status or p_to_state <> v_document.status then
    raise exception 'KADI_V1_STATE_CONFLICT';
  end if;

  insert into public.kadi_v1_document_events (
    document_id, document_version, event_type, from_state, to_state,
    idempotency_key, metadata
  ) values (
    p_document_id, v_document.active_version, p_event_type,
    p_from_state, p_to_state, p_idempotency_key,
    coalesce(p_event_metadata, '{}'::jsonb)
  ) returning event_id into v_event_id;

  v_result := jsonb_build_object(
    'document_id', p_document_id,
    'version', v_document.active_version,
    'status', v_document.status,
    'event_id', v_event_id,
    'duplicate', false
  );

  insert into public.kadi_v1_idempotency_records (
    idempotency_key, operation_type, document_id, document_version, event_id, result
  ) values (
    p_idempotency_key, 'append_event', p_document_id,
    v_document.active_version, v_event_id, v_result
  );

  return v_result;
end;
$$;

alter table public.kadi_v1_documents enable row level security;
alter table public.kadi_v1_document_versions enable row level security;
alter table public.kadi_v1_document_items enable row level security;
alter table public.kadi_v1_document_events enable row level security;
alter table public.kadi_v1_idempotency_records enable row level security;

revoke all on function public.kadi_v1_create_document(jsonb, text, jsonb, jsonb, text, text, text, text, jsonb) from public;
revoke all on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from public;
revoke all on function public.kadi_v1_append_domain_event(text, text, text, text, text, text, jsonb) from public;

grant execute on function public.kadi_v1_create_document(jsonb, text, jsonb, jsonb, text, text, text, text, jsonb) to service_role;
grant execute on function public.kadi_v1_persist_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) to service_role;
grant execute on function public.kadi_v1_append_domain_event(text, text, text, text, text, text, jsonb) to service_role;
