alter table public.kadi_v1_documents
  add column if not exists generated_file jsonb;

create table if not exists public.kadi_v1_wallet_reservations (
  reservation_id text primary key,
  owner_wa_id text not null,
  quote_id text not null references public.kadi_v1_generation_quotes(quote_id),
  amount integer not null check (amount > 0),
  status text not null check (status in ('RESERVED', 'CAPTURED', 'RELEASED', 'EXPIRED')),
  reserve_idempotency_key text not null unique,
  capture_idempotency_key text unique,
  release_idempotency_key text unique,
  reserved_at timestamptz not null default clock_timestamp(),
  captured_at timestamptz,
  released_at timestamptz,
  revision integer not null default 1 check (revision >= 1)
);

create unique index if not exists kadi_v1_wallet_reservations_active_quote_uidx
  on public.kadi_v1_wallet_reservations (quote_id)
  where status in ('RESERVED', 'CAPTURED');

create table if not exists public.kadi_v1_generation_attempts (
  generation_attempt_id text primary key,
  document_id text not null,
  document_version integer not null,
  owner_wa_id text not null,
  quote_id text not null references public.kadi_v1_generation_quotes(quote_id),
  reservation_id text not null references public.kadi_v1_wallet_reservations(reservation_id),
  confirmation_key text not null unique,
  status text not null check (status in ('STARTED', 'PDF_VALIDATED', 'CAPTURED', 'PROMOTED', 'RECOVERABLE_FAILURE', 'CANCELLED')),
  staging_ref text,
  checksum text check (checksum is null or checksum ~ '^[a-f0-9]{64}$'),
  page_count integer check (page_count is null or page_count > 0),
  byte_size bigint check (byte_size is null or byte_size > 0),
  last_error_code text,
  final_file_id text,
  revision integer not null default 1 check (revision >= 1),
  started_at timestamptz not null default clock_timestamp(),
  validated_at timestamptz,
  captured_at timestamptz,
  promoted_at timestamptz,
  constraint kadi_v1_generation_attempt_version_fk foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version),
  constraint kadi_v1_generation_staging_private_check check (staging_ref is null or staging_ref !~* '^https?://')
);

create unique index if not exists kadi_v1_generation_attempts_quote_uidx
  on public.kadi_v1_generation_attempts (quote_id);

create table if not exists public.kadi_v1_final_files (
  final_file_id text primary key,
  document_id text not null,
  document_version integer not null,
  generation_attempt_id text not null unique references public.kadi_v1_generation_attempts(generation_attempt_id),
  storage_ref text not null check (storage_ref !~* '^https?://'),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  page_count integer not null check (page_count > 0),
  mime_type text not null check (mime_type = 'application/pdf'),
  generated_at timestamptz not null default clock_timestamp(),
  immutable boolean not null default true check (immutable is true),
  constraint kadi_v1_final_file_version_fk foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version)
);

create table if not exists public.kadi_v1_delivery_attempts (
  delivery_attempt_id text primary key,
  final_file_id text not null references public.kadi_v1_final_files(final_file_id),
  destination_ref text not null,
  status text not null check (status in ('PENDING', 'DELIVERED', 'RECOVERABLE_FAILURE')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  provider_reference text,
  idempotency_key text not null unique,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default clock_timestamp(),
  last_attempt_at timestamptz,
  delivered_at timestamptz
);

create or replace function public.kadi_v1_persist_generated_transition(
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
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if p_to_state <> 'GENERATED' or jsonb_typeof(p_new_snapshot->'generated_file') <> 'object' then
    raise exception 'KADI_V1_GENERATED_FILE_REQUIRED';
  end if;
  if (p_new_snapshot->'generated_file'->>'document_id') <> p_document_id or
     (p_new_snapshot->'generated_file'->>'document_version')::integer <> p_expected_version or
     coalesce((p_new_snapshot->'generated_file'->>'immutable')::boolean, false) is not true then
    raise exception 'KADI_V1_GENERATED_FILE_INVALID';
  end if;
  select public.kadi_v1_persist_transition(
    p_document_id, p_owner_wa_id, p_expected_version, p_new_snapshot, p_items,
    p_event_type, p_from_state, p_to_state, p_idempotency_key, p_event_metadata
  ) into v_result;
  update public.kadi_v1_documents
    set generated_file = p_new_snapshot->'generated_file'
    where document_id = p_document_id and owner_wa_id = p_owner_wa_id;
  return v_result;
end $$;

create or replace function public.kadi_v1_reserve_generation_credits(
  p_reservation_id text, p_owner_wa_id text, p_quote_id text, p_amount integer, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_profile jsonb;
  v_profile_id text;
  v_balance integer;
  v_held integer;
  v_row public.kadi_v1_wallet_reservations%rowtype;
begin
  if p_amount < 1 then raise exception 'KADI_V1_RESERVATION_AMOUNT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_wallet:' || p_owner_wa_id, 0));
  select * into v_row from public.kadi_v1_wallet_reservations where reserve_idempotency_key = p_idempotency_key;
  if found then return to_jsonb(v_row) || jsonb_build_object('duplicate', true); end if;
  select public.kadi_resolve_profile_v2(p_owner_wa_id, null, null, null, null) into v_profile;
  v_profile_id := v_profile->>'profile_id';
  select balance into v_balance from public.kadi_wallets where profile_id::text = v_profile_id for update;
  select coalesce(sum(amount), 0) into v_held from public.kadi_v1_wallet_reservations
    where owner_wa_id = p_owner_wa_id and status = 'RESERVED';
  if coalesce(v_balance, 0) - v_held < p_amount then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_CREDITS');
  end if;
  insert into public.kadi_v1_wallet_reservations (
    reservation_id, owner_wa_id, quote_id, amount, status, reserve_idempotency_key
  ) values (p_reservation_id, p_owner_wa_id, p_quote_id, p_amount, 'RESERVED', p_idempotency_key)
  returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'duplicate', false);
end $$;

create or replace function public.kadi_v1_capture_generation_reservation(
  p_reservation_id text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.kadi_v1_wallet_reservations%rowtype;
  v_credit_result jsonb;
begin
  select * into v_row from public.kadi_v1_wallet_reservations where reservation_id = p_reservation_id for update;
  if not found then raise exception 'KADI_V1_RESERVATION_NOT_FOUND'; end if;
  if v_row.status = 'CAPTURED' and v_row.capture_idempotency_key = p_idempotency_key then
    return to_jsonb(v_row) || jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if v_row.status <> 'RESERVED' then raise exception 'KADI_V1_RESERVATION_NOT_CAPTURABLE'; end if;
  select public.kadi_consume_credits_v2(
    v_row.owner_wa_id, null, null, null, null, v_row.amount, 'V1_DOCUMENT_GENERATION', p_idempotency_key,
    jsonb_build_object('reservation_id', v_row.reservation_id, 'quote_id', v_row.quote_id)
  ) into v_credit_result;
  if coalesce((v_credit_result->>'ok')::boolean, false) is not true then raise exception 'KADI_V1_CAPTURE_FAILED'; end if;
  update public.kadi_v1_wallet_reservations set status = 'CAPTURED', capture_idempotency_key = p_idempotency_key,
    captured_at = clock_timestamp(), revision = revision + 1 where reservation_id = p_reservation_id returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'duplicate', false);
end $$;

create or replace function public.kadi_v1_release_generation_reservation(
  p_reservation_id text, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.kadi_v1_wallet_reservations%rowtype;
begin
  select * into v_row from public.kadi_v1_wallet_reservations where reservation_id = p_reservation_id for update;
  if not found then raise exception 'KADI_V1_RESERVATION_NOT_FOUND'; end if;
  if v_row.status = 'RELEASED' and v_row.release_idempotency_key = p_idempotency_key then
    return to_jsonb(v_row) || jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if v_row.status <> 'RESERVED' then raise exception 'KADI_V1_RESERVATION_NOT_RELEASABLE'; end if;
  update public.kadi_v1_wallet_reservations set status = 'RELEASED', release_idempotency_key = p_idempotency_key,
    released_at = clock_timestamp(), revision = revision + 1 where reservation_id = p_reservation_id returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('ok', true, 'duplicate', false);
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'kadi_v1_final_files_immutable') then
    create trigger kadi_v1_final_files_immutable before update or delete on public.kadi_v1_final_files
      for each row execute function public.kadi_v1_reject_immutable_mutation();
  end if;
end $$;

alter table public.kadi_v1_wallet_reservations enable row level security;
alter table public.kadi_v1_generation_attempts enable row level security;
alter table public.kadi_v1_final_files enable row level security;
alter table public.kadi_v1_delivery_attempts enable row level security;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_persist_generated_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from public;
revoke all on function public.kadi_v1_persist_generated_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from anon;
revoke all on function public.kadi_v1_persist_generated_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) from authenticated;
grant execute on function public.kadi_v1_persist_generated_transition(text, text, integer, jsonb, jsonb, text, text, text, text, jsonb) to service_role;
revoke all on function public.kadi_v1_reserve_generation_credits(text, text, text, integer, text) from public;
revoke all on function public.kadi_v1_reserve_generation_credits(text, text, text, integer, text) from anon;
revoke all on function public.kadi_v1_reserve_generation_credits(text, text, text, integer, text) from authenticated;
grant execute on function public.kadi_v1_reserve_generation_credits(text, text, text, integer, text) to service_role;
revoke all on function public.kadi_v1_capture_generation_reservation(text, text) from public;
revoke all on function public.kadi_v1_capture_generation_reservation(text, text) from anon;
revoke all on function public.kadi_v1_capture_generation_reservation(text, text) from authenticated;
grant execute on function public.kadi_v1_capture_generation_reservation(text, text) to service_role;
revoke all on function public.kadi_v1_release_generation_reservation(text, text) from public;
revoke all on function public.kadi_v1_release_generation_reservation(text, text) from anon;
revoke all on function public.kadi_v1_release_generation_reservation(text, text) from authenticated;
grant execute on function public.kadi_v1_release_generation_reservation(text, text) to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
