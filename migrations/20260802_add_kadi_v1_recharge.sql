create table if not exists public.kadi_v1_recharge_sessions (
  recharge_session_id text primary key,
  owner_wa_id text not null,
  pack_id text not null,
  pack_snapshot jsonb not null,
  status text not null check (status in (
    'CREATED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'CREDITED', 'RESUME_PENDING',
    'RESUMED', 'FAILED', 'EXPIRED', 'CANCELLED'
  )),
  provider text,
  provider_payment_id text,
  merchant_reference text not null unique,
  document_id text,
  create_idempotency_key text not null unique,
  credit_idempotency_key text unique,
  failure_code text,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  payment_requested_at timestamptz,
  payment_confirmed_at timestamptz,
  credited_at timestamptz,
  resumed_at timestamptz,
  expired_at timestamptz,
  cancelled_at timestamptz,
  constraint kadi_v1_recharge_pack_snapshot_check check (
    jsonb_typeof(pack_snapshot) = 'object' and
    pack_snapshot->>'pack_id' = pack_id and
    (pack_snapshot->>'amount')::integer > 0 and
    (pack_snapshot->>'credits')::integer > 0 and
    pack_snapshot->>'currency' ~ '^[A-Z]{3}$' and
    length(pack_snapshot->>'pricing_version') > 0
  ),
  constraint kadi_v1_recharge_document_fk foreign key (document_id)
    references public.kadi_v1_documents(document_id)
);

create unique index if not exists kadi_v1_recharge_provider_payment_uidx
  on public.kadi_v1_recharge_sessions (provider, provider_payment_id)
  where provider is not null and provider_payment_id is not null;

create table if not exists public.kadi_v1_payment_events (
  provider text not null,
  provider_event_id text not null,
  recharge_session_id text not null references public.kadi_v1_recharge_sessions(recharge_session_id),
  provider_payment_id text not null,
  merchant_reference text not null,
  amount integer not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null,
  verified boolean not null,
  occurred_at timestamptz not null,
  accepted boolean not null default true,
  event_fingerprint text not null check (event_fingerprint ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default clock_timestamp(),
  primary key (provider, provider_event_id)
);

create table if not exists public.kadi_v1_payment_provider_references (
  provider text not null,
  provider_payment_id text not null,
  recharge_session_id text not null unique references public.kadi_v1_recharge_sessions(recharge_session_id),
  merchant_reference text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  primary key (provider, provider_payment_id)
);

create table if not exists public.kadi_v1_recharge_resume_links (
  recharge_session_id text primary key references public.kadi_v1_recharge_sessions(recharge_session_id),
  document_id text not null,
  document_version integer not null check (document_version >= 1),
  quote_id text not null references public.kadi_v1_generation_quotes(quote_id),
  generation_confirmation_id text not null,
  missing_credits integer not null check (missing_credits > 0),
  generation_cost integer not null check (generation_cost > 0),
  pricing_version text not null,
  resume_status text not null check (resume_status in ('WAITING_FOR_CREDIT', 'PENDING', 'STARTED', 'FAILED', 'RESUMED')),
  generation_started boolean not null default false,
  last_error_code text,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  resumed_at timestamptz,
  constraint kadi_v1_recharge_resume_version_fk foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version)
);

create or replace function public.kadi_v1_create_recharge_session(
  p_session jsonb,
  p_resume_link jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_session public.kadi_v1_recharge_sessions%rowtype;
begin
  select * into v_session from public.kadi_v1_recharge_sessions
    where create_idempotency_key = p_session->>'create_idempotency_key';
  if found then return jsonb_build_object('ok', true, 'duplicate', true, 'session', to_jsonb(v_session)); end if;

  insert into public.kadi_v1_recharge_sessions (
    recharge_session_id, owner_wa_id, pack_id, pack_snapshot, status, provider,
    provider_payment_id, merchant_reference, document_id, create_idempotency_key,
    created_at, expires_at
  ) values (
    p_session->>'recharge_session_id', p_session->>'owner_wa_id', p_session->>'pack_id', p_session->'pack_snapshot',
    p_session->>'status', p_session->>'provider', p_session->>'provider_payment_id',
    p_session->>'merchant_reference', p_session->>'document_id', p_session->>'create_idempotency_key',
    (p_session->>'created_at')::timestamptz, (p_session->>'expires_at')::timestamptz
  ) returning * into v_session;

  if p_resume_link is not null then
    if p_resume_link->>'recharge_session_id' is distinct from v_session.recharge_session_id or
       p_resume_link->>'document_id' is distinct from v_session.document_id then
      raise exception 'KADI_V1_RECHARGE_RESUME_LINK_INVALID';
    end if;
    insert into public.kadi_v1_recharge_resume_links (
      recharge_session_id, document_id, document_version, quote_id, generation_confirmation_id,
      missing_credits, generation_cost, pricing_version, resume_status, generation_started, created_at
    ) values (
      p_resume_link->>'recharge_session_id', p_resume_link->>'document_id', (p_resume_link->>'document_version')::integer,
      p_resume_link->>'quote_id', p_resume_link->>'generation_confirmation_id', (p_resume_link->>'missing_credits')::integer,
      (p_resume_link->>'generation_cost')::integer, p_resume_link->>'pricing_version', p_resume_link->>'resume_status',
      coalesce((p_resume_link->>'generation_started')::boolean, false), (p_resume_link->>'created_at')::timestamptz
    );
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'session', to_jsonb(v_session));
end $$;

create or replace function public.kadi_v1_get_wallet_balance(p_owner_wa_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_profile jsonb; v_balance integer;
begin
  select public.kadi_resolve_profile_v2(p_owner_wa_id, null, null, null, null) into v_profile;
  select balance into v_balance from public.kadi_wallets where profile_id::text = v_profile->>'profile_id';
  return jsonb_build_object('balance', coalesce(v_balance, 0));
end $$;

create or replace function public.kadi_v1_confirm_recharge_credit(
  p_recharge_session_id text,
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_merchant_reference text,
  p_amount integer,
  p_currency text,
  p_status text,
  p_verified boolean,
  p_occurred_at timestamptz,
  p_event_fingerprint text,
  p_credit_idempotency_key text,
  p_credited_at timestamptz,
  p_allow_late boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.kadi_v1_recharge_sessions%rowtype;
  v_event public.kadi_v1_payment_events%rowtype;
  v_credit jsonb;
  v_expected_key text;
  v_reference_session text;
begin
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_recharge:' || p_recharge_session_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_payment_event:' || p_provider || ':' || p_provider_event_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_payment:' || p_provider || ':' || p_provider_payment_id, 0));
  select * into v_session from public.kadi_v1_recharge_sessions where recharge_session_id = p_recharge_session_id for update;
  if not found then raise exception 'KADI_V1_RECHARGE_SESSION_NOT_FOUND'; end if;

  select * into v_event from public.kadi_v1_payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if v_event.event_fingerprint <> p_event_fingerprint or v_event.recharge_session_id <> p_recharge_session_id then
      raise exception 'PAYMENT_EVENT_REPLAY_CONFLICT';
    end if;
    if v_event.accepted is not true then raise exception 'PAYMENT_EVENT_PREVIOUSLY_REJECTED'; end if;
    if v_session.status in ('CREDITED', 'RESUME_PENDING', 'RESUMED') then
      return jsonb_build_object('ok', true, 'duplicate', true, 'session', to_jsonb(v_session));
    end if;
  end if;

  if v_session.status <> 'PAYMENT_PENDING' then raise exception 'RECHARGE_SESSION_NOT_CREDITABLE'; end if;
  if p_verified is not true or p_status <> 'CONFIRMED' or
     v_session.provider is distinct from p_provider or v_session.provider_payment_id is distinct from p_provider_payment_id or
     v_session.merchant_reference is distinct from p_merchant_reference or
     (v_session.pack_snapshot->>'amount')::integer <> p_amount or
     v_session.pack_snapshot->>'currency' <> p_currency then
    raise exception 'PAYMENT_EVENT_MISMATCH';
  end if;
  if p_credited_at >= v_session.expires_at and not (p_allow_late is true and p_occurred_at < v_session.expires_at) then
    raise exception 'PAYMENT_EVENT_LATE';
  end if;
  select recharge_session_id into v_reference_session from public.kadi_v1_payment_provider_references
    where provider = p_provider and provider_payment_id = p_provider_payment_id;
  if found and v_reference_session <> p_recharge_session_id then raise exception 'PAYMENT_PROVIDER_REFERENCE_CONFLICT'; end if;
  v_expected_key := 'recharge_credit:' || p_provider || ':' || p_provider_payment_id;
  if p_credit_idempotency_key <> v_expected_key then raise exception 'RECHARGE_CREDIT_KEY_INVALID'; end if;

  insert into public.kadi_v1_payment_events (
    provider, provider_event_id, recharge_session_id, provider_payment_id, merchant_reference,
    amount, currency, status, verified, occurred_at, accepted, event_fingerprint
  ) values (
    p_provider, p_provider_event_id, p_recharge_session_id, p_provider_payment_id, p_merchant_reference,
    p_amount, p_currency, p_status, p_verified, p_occurred_at, true, p_event_fingerprint
  ) on conflict (provider, provider_event_id) do nothing;

  insert into public.kadi_v1_payment_provider_references (provider, provider_payment_id, recharge_session_id, merchant_reference)
  values (p_provider, p_provider_payment_id, p_recharge_session_id, p_merchant_reference)
  on conflict (provider, provider_payment_id) do nothing;

  select public.kadi_add_credits_v2(
    p_wa_id => v_session.owner_wa_id,
    p_bsuid => null,
    p_username => null,
    p_parent_bsuid => null,
    p_profile_name => null,
    p_amount => (v_session.pack_snapshot->>'credits')::integer,
    p_reason => 'RECHARGE',
    p_operation_key => p_credit_idempotency_key,
    p_meta => jsonb_build_object(
      'ledger_type', 'RECHARGE', 'source', 'kadi_v1_recharge',
      'recharge_session_id', p_recharge_session_id, 'pack_id', v_session.pack_id,
      'provider', p_provider, 'provider_payment_id', p_provider_payment_id
    )
  ) into v_credit;
  if coalesce((v_credit->>'ok')::boolean, false) is not true then raise exception 'KADI_V1_RECHARGE_CREDIT_FAILED'; end if;

  update public.kadi_v1_recharge_sessions
    set status = case when document_id is null then 'CREDITED' else 'RESUME_PENDING' end,
        payment_confirmed_at = p_occurred_at,
        credited_at = p_credited_at,
        credit_idempotency_key = p_credit_idempotency_key,
        revision = revision + 1
    where recharge_session_id = p_recharge_session_id
    returning * into v_session;
  return jsonb_build_object('ok', true, 'duplicate', false, 'balance', v_credit->'balance', 'session', to_jsonb(v_session));
end $$;

alter table public.kadi_v1_recharge_sessions enable row level security;
alter table public.kadi_v1_payment_events enable row level security;
alter table public.kadi_v1_payment_provider_references enable row level security;
alter table public.kadi_v1_recharge_resume_links enable row level security;
